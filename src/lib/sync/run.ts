/**
 * One sync run, start to finish.
 *
 * Airtable stays the system of record. This reads it and writes the mirror;
 * nothing is ever written back, and nothing is ever deleted — the role cannot
 * (migration 007), and a row that stops appearing is marked inactive by
 * sweep_missing_from_airtable(), which refuses unless the pass that would
 * justify it actually finished.
 *
 * PHASE ONE IS SIX TABLES AND DOES NOT SWEEP. A partial pass genuinely cannot
 * say what is missing from the eight tables it never read, so `scope` is
 * recorded as 'phase1' and the sweep's guard turns it away. That is a property
 * of this phase rather than an oversight: until phase two makes it a full
 * pass, nothing marks vanished rows.
 */
import type { Db } from './db.ts';
import { inTransaction } from './db.ts';
import { RateLimiter, readTable, type AirtableRecord } from './airtable.ts';
import { LOAD_ORDER, spec, TABLES, type TableKey } from './tables.ts';
import { buildUpsert, planRow, type Issue, type RowPlan } from './plan.ts';

/** Upserts per transaction. Small enough to stay well inside the 60 s idle limit. */
const BATCH = 200;

/** Stop before Netlify's 15 minutes so the run can still be closed honestly. */
export const RUN_BUDGET_MS = 13 * 60_000;

export interface SyncOptions {
  apiKey: string;
  baseId: string;
  dryRun: boolean;
  /** Read at most this many records per table. For a quick look, not for a real run. */
  sampleSize?: number;
  log?: (line: string) => void;
}

export interface TableResult {
  table: TableKey;
  readFromAirtable: number;
  inserted: number;
  /**
   * An upsert that matched. It does NOT mean anything actually differed —
   * distinguishing a real change from an identical rewrite would need the old
   * row read back and compared, which is a second query per record for a
   * number nobody acts on. `unchanged` stays 0 for the same reason; it is in
   * sync_run_tables for a later version that wants to earn it.
   */
  updated: number;
  unchanged: number;
  wouldInsertExisting: number;
  unresolvedParents: number;
  anomalies: number;
  blocked: number;
}

const DRY = '(dry-run)';

export async function runSync(db: Db, opts: SyncOptions): Promise<{ runId: string; tables: TableResult[] }> {
  const log = opts.log ?? (() => {});
  const started = Date.now();
  const limiter = new RateLimiter();

  const runId = await openRun(db, opts.dryRun);
  log(`run ${runId} opened${opts.dryRun ? ' as a dry run' : ''}`);

  /** airtable_record_id → mirror uuid, per table, for resolving links. */
  const keys = new Map<TableKey, Map<string, string>>();
  const results: TableResult[] = [];

  try {
    for (const key of LOAD_ORDER) {
      if (Date.now() - started > RUN_BUDGET_MS) {
        throw new Error(`out of time before ${key}; ${Math.round((Date.now() - started) / 1000)}s elapsed`);
      }
      const result = await syncTable(db, runId, key, keys, limiter, opts, log);
      results.push(result);
      await recordTable(db, runId, result);
    }

    if (!opts.dryRun) await deriveGrossSf(db, runId, log);

    await closeRun(db, runId, 'succeeded', summarise(results));
    log(`run ${runId} succeeded`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await closeRun(db, runId, 'failed', message.slice(0, 2000)).catch(() => {});
    log(`run ${runId} FAILED: ${message}`);
    throw err;
  }

  return { runId, tables: results };
}

async function syncTable(
  db: Db,
  runId: string,
  key: TableKey,
  keys: Map<TableKey, Map<string, string>>,
  limiter: RateLimiter,
  opts: SyncOptions,
  log: (s: string) => void
): Promise<TableResult> {
  const t = spec(key);
  const records = await readTable(t.airtable, {
    apiKey: opts.apiKey,
    baseId: opts.baseId,
    limiter,
    maxRecords: opts.sampleSize,
  });
  log(`${key}: read ${records.length} from ${t.airtable}`);

  const result: TableResult = {
    table: key,
    readFromAirtable: records.length,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    wouldInsertExisting: 0,
    unresolvedParents: 0,
    anomalies: 0,
    blocked: 0,
  };

  const issues: { recordId: string; issue: Issue }[] = [];
  const plans: RowPlan[] = [];

  for (const record of records) {
    // A record with no id cannot be matched, so an upsert would INSERT it —
    // every run. This is the nullable-key trap that the unique index does not
    // catch, and it is counted rather than assumed away.
    if (!record.id || !/^rec[A-Za-z0-9]{14}$/.test(record.id)) {
      result.wouldInsertExisting++;
      issues.push({
        recordId: record.id ?? '(none)',
        issue: {
          kind: 'coercion_failed',
          field: 'id',
          airtableValue: record.id ?? null,
          detail: 'record has no usable Airtable id; it would insert a duplicate on every run and was skipped',
        },
      });
      continue;
    }

    const plan = planRow(t, record);
    for (const issue of plan.issues) issues.push({ recordId: record.id, issue });

    for (const link of plan.pendingLinks) {
      const parent = keys.get(link.linkTo as TableKey);
      const uuid = parent?.get(link.recordId);
      if (uuid) {
        plan.values[plan.columns.indexOf(link.column)] = uuid;
      } else {
        result.unresolvedParents++;
        issues.push({
          recordId: record.id,
          issue: {
            kind: 'unresolved_link',
            field: link.column,
            airtableValue: link.recordId,
            detail:
              `${link.recordId} is not in ${link.linkTo}. The row loaded with ${link.column} null — ` +
              `usually a record filtered out of the view the sync reads, or deleted in Airtable.`,
          },
        });
      }
    }
    plans.push(plan);
  }

  if (opts.dryRun) {
    const existing = await existingKeys(db, key, plans.map((p) => p.airtableRecordId));
    for (const p of plans) {
      if (existing.has(p.airtableRecordId)) result.updated++;
      else result.inserted++;
    }
    // Nothing is written, so later tables have no real uuids to resolve
    // against. Map every id to a sentinel so that "unresolved" keeps meaning
    // "this parent is missing from Airtable too" rather than "nothing is
    // loaded yet", which on an empty mirror would be every link.
    keys.set(key, new Map(plans.map((p) => [p.airtableRecordId, `${DRY}-${p.airtableRecordId}`])));
    log(`${key}: ${DRY} would insert ${result.inserted}, update ${result.updated}`);
  } else {
    const sql = buildUpsert(t);
    for (let i = 0; i < plans.length; i += BATCH) {
      const slice = plans.slice(i, i + BATCH);
      await inTransaction(db, async () => {
        for (const p of slice) {
          const res = await db.query(sql, p.values);
          if (!res.rowCount) {
            // The DO UPDATE's WHERE excluded it, or a policy did. Either way
            // the row was not written and nothing errored, which is precisely
            // the failure mode worth counting.
            result.blocked++;
            issues.push({
              recordId: p.airtableRecordId,
              issue: {
                kind: 'coercion_failed',
                field: '(row)',
                airtableValue: p.airtableRecordId,
                detail:
                  'upsert affected 0 rows — a matching row exists that this sync does not own ' +
                  `(${t.restrictUpdateTo ?? 'no restriction'}), or a policy refused it`,
              },
            });
          } else if (res.rows[0]?.inserted) {
            result.inserted++;
          } else {
            result.updated++;
          }
        }
      });
    }
    keys.set(key, await existingKeyMap(db, key, plans.map((p) => p.airtableRecordId)));
    log(`${key}: inserted ${result.inserted}, updated ${result.updated}, blocked ${result.blocked}`);
  }

  result.anomalies = issues.length;
  await recordAnomalies(db, runId, key, issues);
  return result;
}

/**
 * gross_sf, after the deliverables are in.
 *
 * The project's whole-project area comes from its most recent deliverable's
 * building area. Airtable has one for about 16% of tasks, so most projects
 * will get nothing here and the reader's frame is the real source.
 *
 * WRITTEN ONLY WHERE IT IS NULL. If a value is already there it was put there
 * by the reader, from a document, with evidence — and overwriting it on every
 * sync would undo that work silently, on a schedule. A disagreement is a
 * question for a person, not a write.
 */
async function deriveGrossSf(db: Db, runId: string, log: (s: string) => void): Promise<void> {
  const latest = `
    select distinct on (d.project_id) d.project_id, d.building_sf
      from deliverables d
     where d.project_id is not null and d.building_sf is not null
       and d.source = 'airtable'
     order by d.project_id,
              coalesce(d.due_date, d.issue_date, d.airtable_created_at::date) desc nulls last`;

  const filled = await db.query(
    `with latest as (${latest})
     update projects p set gross_sf = l.building_sf, synced_at = now()
       from latest l
      where p.id = l.project_id and p.gross_sf is null
      returning p.id`
  );

  const disagreed = await db.query(
    `with latest as (${latest})
     select p.airtable_record_id, p.gross_sf, l.building_sf
       from projects p join latest l on l.project_id = p.id
      where p.gross_sf is not null and p.gross_sf <> l.building_sf`
  );

  for (const row of disagreed.rows) {
    await db.query(
      `insert into sync_anomalies (run_id, table_name, airtable_record_id, kind,
                                   field_name, airtable_value, postgres_value, detail)
       values ($1,'projects',$2,'value_disagreement','gross_sf',$3,$4,$5)`,
      [
        runId,
        row.airtable_record_id,
        String(row.building_sf),
        String(row.gross_sf),
        'the latest deliverable\'s building_sf disagrees with the gross_sf already on the project. ' +
          'Postgres was left alone: the existing value came from a document with evidence behind it. ' +
          'Worth a gross_area question in reader_questions.',
      ]
    );
  }

  log(`gross_sf: filled ${filled.rowCount ?? 0}, ${disagreed.rowCount ?? 0} disagreements left alone`);
}

async function existingKeys(db: Db, table: TableKey, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const res = await db.query(
    `select airtable_record_id from ${table} where airtable_record_id = any($1::text[])`,
    [ids]
  );
  return new Set(res.rows.map((r) => String(r.airtable_record_id)));
}

async function existingKeyMap(db: Db, table: TableKey, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const res = await db.query(
    `select airtable_record_id, id from ${table} where airtable_record_id = any($1::text[])`,
    [ids]
  );
  return new Map(res.rows.map((r) => [String(r.airtable_record_id), String(r.id)]));
}

async function openRun(db: Db, dryRun: boolean): Promise<string> {
  const res = await db.query(
    `insert into sync_runs (scope, dry_run, notes) values ('phase1', $1, $2) returning id`,
    [
      dryRun,
      `phase one: ${LOAD_ORDER.join(', ')}. Partial scope, so the sweep will refuse this run — ` +
        'nothing marks vanished rows until phase two makes it a full pass.',
    ]
  );
  return String(res.rows[0].id);
}

async function closeRun(db: Db, runId: string, outcome: 'succeeded' | 'failed', line: string): Promise<void> {
  await db.query(
    `update sync_runs set finished_at = now(), outcome = $2::sync_run_outcome,
            notes = coalesce(notes,'') || $3
      where id = $1 and finished_at is null`,
    [runId, outcome, `\n${new Date().toISOString()} ${line}`]
  );
}

async function recordTable(db: Db, runId: string, r: TableResult): Promise<void> {
  await db.query(
    `insert into sync_run_tables
       (run_id, table_name, read_from_airtable, inserted, updated, unchanged,
        would_insert_existing, unresolved_parents, anomalies)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (run_id, table_name) do update set
       read_from_airtable = excluded.read_from_airtable,
       inserted = excluded.inserted, updated = excluded.updated,
       unchanged = excluded.unchanged,
       would_insert_existing = excluded.would_insert_existing,
       unresolved_parents = excluded.unresolved_parents,
       anomalies = excluded.anomalies`,
    [runId, r.table, r.readFromAirtable, r.inserted, r.updated, r.unchanged,
     r.wouldInsertExisting, r.unresolvedParents, r.anomalies]
  );
}

async function recordAnomalies(
  db: Db,
  runId: string,
  table: TableKey,
  issues: { recordId: string; issue: Issue }[]
): Promise<void> {
  for (let i = 0; i < issues.length; i += BATCH) {
    const slice = issues.slice(i, i + BATCH);
    await inTransaction(db, async () => {
      for (const { recordId, issue } of slice) {
        await db.query(
          `insert into sync_anomalies (run_id, table_name, airtable_record_id, kind,
                                       field_name, airtable_value, detail)
           values ($1,$2,$3,$4::sync_anomaly_kind,$5,$6,$7)`,
          [runId, table, recordId, issue.kind, issue.field, issue.airtableValue, issue.detail]
        );
      }
    });
  }
}

function summarise(results: TableResult[]): string {
  const total = (pick: (r: TableResult) => number) => results.reduce((a, r) => a + pick(r), 0);
  return (
    `read ${total((r) => r.readFromAirtable)}, inserted ${total((r) => r.inserted)}, ` +
    `updated ${total((r) => r.updated)}, blocked ${total((r) => r.blocked)}, ` +
    `unresolved links ${total((r) => r.unresolvedParents)}, anomalies ${total((r) => r.anomalies)}`
  );
}

export const PHASE_ONE_TABLES = TABLES.filter((t) => (LOAD_ORDER as readonly string[]).includes(t.key));
