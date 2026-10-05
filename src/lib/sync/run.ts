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
import { LOAD_ORDER, spec, TABLES, type JoinSpec, type TableKey, type TableSpec } from './tables.ts';
import { buildJoinUpsert, buildUpsert, planJoins, planRow, type Issue, type RowPlan } from './plan.ts';

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
  /**
   * Airtable record ids, or any text to match against a record's field
   * values. Every match has its planned row rendered in full — see
   * renderPlan below for why counts are not enough.
   */
  showRecords?: string[];
  /** Cap per table, so a loose match cannot turn a run into a dump. */
  showLimit?: number;
  log?: (line: string) => void;
}

/** Default cap for showRecords. Enough to check a few, too few to flood. */
const SHOW_LIMIT = 5;

export interface TableResult {
  /** A mirror table, or a join table — both are reported in sync_run_tables. */
  table: string;
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
  /** Rendered rows from showRecords, appended to sync_runs.notes at the end. */
  const samples: string[] = [];

  try {
    for (const key of LOAD_ORDER) {
      if (Date.now() - started > RUN_BUDGET_MS) {
        throw new Error(`out of time before ${key}; ${Math.round((Date.now() - started) / 1000)}s elapsed`);
      }
      const produced = await syncTable(db, runId, key, keys, limiter, opts, log, samples);
      for (const result of produced) {
        results.push(result);
        await recordTable(db, runId, result);
      }
    }

    if (!opts.dryRun) await deriveGrossSf(db, runId, log);

    await closeRun(
      db,
      runId,
      'succeeded',
      summarise(results) + (samples.length ? `\n\nSAMPLED ROWS\n${samples.join('\n\n')}` : '')
    );
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
  log: (s: string) => void,
  samples: string[] = []
): Promise<TableResult[]> {
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

  // After link resolution, so a rendered row shows the uuid a link became
  // rather than the Airtable id it started as. On a dry run that uuid is the
  // sentinel, which is itself worth seeing.
  if (opts.showRecords?.length) {
    const byId = new Map(records.filter((r) => r.id).map((r) => [r.id, r]));
    // AN ID NAMED EXPLICITLY MUST NOT BE CROWDED OUT BY A TEXT MATCH. The
    // first version took plans in Airtable order and stopped at the cap, so
    // asking for one specific record and one loose phrase could return five
    // of the phrase and not the record — the one thing that was asked for by
    // name. Exact ids are rendered first, and they do not count against the
    // cap, because naming five ids is asking for five rows.
    const wanted = new Set(opts.showRecords);
    const exact = plans.filter((p) => wanted.has(p.airtableRecordId));
    const fuzzy = plans.filter((p) => !wanted.has(p.airtableRecordId));
    let shown = 0;
    for (const plan of [...exact, ...fuzzy]) {
      const isExact = wanted.has(plan.airtableRecordId);
      if (!isExact && shown >= (opts.showLimit ?? SHOW_LIMIT)) break;
      const record = byId.get(plan.airtableRecordId);
      if (!record || !(isExact || matchesAny(record, opts.showRecords, t))) continue;
      if (!isExact) shown++;
      const rendered = renderPlan(t, plan, record);
      samples.push(rendered);
      for (const line of rendered.split('\n')) log(line);
    }
    if (shown || exact.length) {
      log(`${key}: rendered ${exact.length} by id and ${shown} by text match`);
    }
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

  // Join tables come after the parent, because a join row needs the parent's
  // uuid and that only exists once the parent has been written (or, in a dry
  // run, once the sentinel map is in place).
  const produced: TableResult[] = [result];
  for (const join of t.joins ?? []) {
    produced.push(await syncJoin(db, runId, t, join, records, keys, opts, log));
  }
  return produced;
}

/**
 * One multi-valued Airtable link, written as rows in a join table.
 *
 * Reported in sync_run_tables under the join table's own name, so the dry run
 * says "deliverable_project_managers: 412 rows" rather than hiding them
 * inside the deliverables count.
 *
 * Links are added and never removed — see the comment on JoinSpec. A link
 * deleted in Airtable leaves its row here, because the sync holds no DELETE
 * and these tables have no is_active. That is an open question, not an
 * oversight, and it is not quietly answered here.
 */
async function syncJoin(
  db: Db,
  runId: string,
  parent: TableSpec,
  join: JoinSpec,
  records: AirtableRecord[],
  keys: Map<TableKey, Map<string, string>>,
  opts: SyncOptions,
  log: (s: string) => void
): Promise<TableResult> {
  const result: TableResult = {
    table: join.table,
    readFromAirtable: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    wouldInsertExisting: 0,
    unresolvedParents: 0,
    anomalies: 0,
    blocked: 0,
  };

  const parentKeys = keys.get(parent.key);
  const childKeys = keys.get(join.linkTo);
  const issues: { recordId: string; issue: Issue }[] = [];
  const pairs: [string, string][] = [];

  for (const record of records) {
    for (const planned of planJoins(parent, record)) {
      if (planned.join.table !== join.table) continue;
      result.readFromAirtable += planned.childRecordIds.length;

      const parentUuid = parentKeys?.get(planned.parentRecordId);
      // The parent itself did not load — already counted and reported against
      // the parent table, so it is not reported twice here.
      if (!parentUuid) continue;

      for (const childId of planned.childRecordIds) {
        const childUuid = childKeys?.get(childId);
        if (!childUuid) {
          result.unresolvedParents++;
          issues.push({
            recordId: planned.parentRecordId,
            issue: {
              kind: 'unresolved_link',
              field: join.childColumn,
              airtableValue: childId,
              detail:
                `${childId} is not in ${join.linkTo}, so the link from ` +
                `${planned.parentRecordId} was not recorded in ${join.table}.`,
            },
          });
          continue;
        }
        pairs.push([parentUuid, childUuid]);
      }
    }
  }

  if (opts.dryRun) {
    result.inserted = pairs.length;
    log(`${join.table}: ${DRY} would write ${pairs.length} links, ${result.unresolvedParents} unresolved`);
  } else {
    const sql = buildJoinUpsert(join);
    for (let i = 0; i < pairs.length; i += BATCH) {
      const slice = pairs.slice(i, i + BATCH);
      await inTransaction(db, async () => {
        for (const [parentUuid, childUuid] of slice) {
          const res = await db.query(sql, [parentUuid, childUuid]);
          if (!res.rowCount) result.blocked++;
          else if (res.rows[0]?.inserted) result.inserted++;
          else result.updated++;
        }
      });
    }
    log(`${join.table}: ${result.inserted} new links, ${result.updated} re-stamped, ${result.blocked} blocked`);
  }

  result.anomalies = issues.length;
  await recordAnomalies(db, runId, join.table, issues);
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
        would_insert_existing, unresolved_parents, anomalies, blocked)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (run_id, table_name) do update set
       read_from_airtable = excluded.read_from_airtable,
       inserted = excluded.inserted, updated = excluded.updated,
       unchanged = excluded.unchanged,
       would_insert_existing = excluded.would_insert_existing,
       unresolved_parents = excluded.unresolved_parents,
       anomalies = excluded.anomalies,
       blocked = excluded.blocked`,
    [runId, r.table, r.readFromAirtable, r.inserted, r.updated, r.unchanged,
     r.wouldInsertExisting, r.unresolvedParents, r.anomalies, r.blocked]
  );
}

async function recordAnomalies(
  db: Db,
  runId: string,
  table: string,
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

/**
 * What one record would become, column by column.
 *
 * COUNTS SAY A RUN HAPPENED; VALUES SAY IT READ CORRECTLY. Every number this
 * file produces is blind to the error that matters most — a field mapped to
 * the wrong column, a multiple select landing as one value, a date shifted by
 * a timezone, an Airtable field renamed so a column quietly stops filling.
 * All of those are structurally perfect and read 0 anomalies. The only way to
 * see them is to look at a row for a project somebody knows.
 *
 * Rendered after link resolution, so a link shows the uuid it became. Nulls
 * are counted rather than listed: on deliverables that is 46 of 63 columns on
 * a typical task, and printing them buries the 17 that matter.
 *
 * Pure, and called only when showRecords names something, so an ordinary run
 * pays nothing for it.
 */
export function renderPlan(t: TableSpec, plan: RowPlan, record: AirtableRecord): string {
  const out: string[] = [`${t.key}  ${plan.airtableRecordId}`];
  const links = new Map(plan.pendingLinks.map((l) => [l.column, l]));
  let nulls = 0;

  for (let i = 0; i < plan.columns.length; i++) {
    const value = plan.values[i];
    if (value === null || value === undefined) {
      // A LINK THAT DID NOT RESOLVE IS NULL, and a null is invisible above.
      // Said plainly: the one outcome worth seeing would look exactly like a
      // field nobody filled in. It is named here instead.
      const link = links.get(plan.columns[i]);
      if (link) {
        out.push(`  ${plan.columns[i]} = UNRESOLVED (${link.recordId} not found in ${link.linkTo})`);
        continue;
      }
      nulls++;
      continue;
    }
    const shown = Array.isArray(value)
      ? `[${value.map((v) => JSON.stringify(v)).join(', ')}]  (${value.length})`
      : JSON.stringify(value);
    out.push(`  ${plan.columns[i]} = ${truncate(shown)}`);
  }
  out.push(`  (${nulls} of ${plan.columns.length} columns null)`);

  for (const planned of planJoins(t, record)) {
    out.push(`  JOIN ${planned.join.table} -> ${planned.join.linkTo}: ${planned.childRecordIds.join(', ')}`);
  }

  if (plan.issues.length === 0) out.push('  no anomalies');
  for (const issue of plan.issues) out.push(`  ANOMALY [${issue.kind}] ${issue.detail}`);

  return out.join('\n');
}

/**
 * Long values are cut, because the point is whether a column is right rather
 * than reading its contents. project_description runs to a thousand
 * characters on a real project; five of those would be most of
 * sync_runs.notes, and the columns worth checking would scroll past.
 */
const MAX_VALUE = 160;

function truncate(value: string): string {
  return value.length <= MAX_VALUE ? value : `${value.slice(0, MAX_VALUE)}… (${value.length} chars)`;
}

/**
 * Any text appearing in the fields THIS TABLE ACTUALLY MAPS.
 *
 * Searching the whole raw record looked more helpful and was much worse.
 * Airtable returns every field including lookups and rollups the map
 * ignores, and a person's record carries the name of every project they
 * have touched. Asking for "Oregon Zoo" that way returned two staff, three
 * contacts at firms that had worked on it, and five Metro on-call tasks —
 * not one of which has the phrase in a column the mirror stores.
 *
 * Restricting the haystack to mapped fields means a match is a match on
 * something the mirror will hold, which is the only kind worth inspecting.
 * An exact id bypasses this entirely and is handled by the caller.
 */
function matchesAny(record: AirtableRecord, terms: readonly string[], t: TableSpec): boolean {
  const mapped: unknown[] = [];
  for (const f of t.fields) if (record.fields?.[f.from] !== undefined) mapped.push(record.fields[f.from]);
  for (const j of t.joins ?? []) if (record.fields?.[j.from] !== undefined) mapped.push(record.fields[j.from]);
  const haystack = JSON.stringify(mapped).toLowerCase();
  return terms.some((term) => term.length > 0 && haystack.includes(term.toLowerCase()));
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
