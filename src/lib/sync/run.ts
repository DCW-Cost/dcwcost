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
import { RateLimiter, streamTable, type AirtableRecord } from './airtable.ts';
import { KNOWN_SKIPS, LOAD_ORDER, spec, TABLES, type JoinSpec, type TableKey, type TableSpec } from './tables.ts';
import { buildJoinUpsert, buildUpsert, columnsFor, planJoins, planRow, type Issue, type RowPlan } from './plan.ts';

/** Upserts per transaction. Small enough to stay well inside the 60 s idle limit. */
const BATCH = 200;

/**
 * Stop before Netlify's limit so the run can still be closed honestly.
 *
 * MEASURED, 5 October 2026, loading projects + deliverables for real:
 *
 *   the function is killed at 15 minutes. The run row's clock starts a few
 *   seconds earlier, when the trigger opens it, so a row showing ~15:15 is a
 *   function that got its full fifteen.
 *
 *   write rate is about 20 rows/sec on narrow tables (contacts, 12 columns)
 *   and about 17 on deliverables (60 columns). 16,592 rows took ~15 minutes
 *   and did not finish. That is the number to size phase two's 14 tables
 *   against — not a guess, and not the dry-run rate, which only counts rows
 *   and is an order of magnitude faster.
 *
 * THE BUDGET ONLY WORKS IF IT IS CHECKED. On that run it never fired,
 * because it was checked between tables in LOAD_ORDER and nowhere else, and
 * the run died inside deliverables' join tables — 3,400 of 3,494 rows into
 * deliverable_project_managers, with the run row left saying `running`
 * because closeRun never got to run. It is now checked before each join
 * table as well, so the run ends by its own clock and closes itself.
 */
export const RUN_BUDGET_MS = 13 * 60_000;

export interface SyncOptions {
  apiKey: string;
  baseId: string;
  dryRun: boolean;
  /** Read at most this many records per table. For a quick look, not for a real run. */
  sampleSize?: number;
  /**
   * Sync only these tables. Omitted means all of LOAD_ORDER.
   *
   * For a first real run, which is the case this exists for: people and
   * subconsultants are 27 rows and no other table links to them, so the
   * write path can be proven end to end before deliverables arrives with
   * 5,557 rows and the only column-scoped upsert in the sync.
   *
   * ORDER IS IGNORED. The list is intersected with LOAD_ORDER, so parents
   * are still written before children whatever order they are named in —
   * passing ['deliverables','projects'] does not invert the dependency.
   *
   * A table that is NOT selected still has its key map loaded from the
   * mirror, so links into it resolve against rows a previous run wrote.
   * Without that, syncing deliverables alone would report every project
   * link unresolved and be entirely wrong about why.
   */
  tables?: readonly TableKey[];
  /**
   * A run row opened by the caller, adopted instead of opening a new one.
   *
   * The synchronous trigger at /api/sync/trigger opens the row so it can
   * return the id in its response — which is the whole point of it existing.
   * Without this, the background function would open a second row and the id
   * the caller was given would stay empty forever.
   */
  runId?: string;
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
  /**
   * Records the database could not have accepted, left out on purpose.
   *
   * A NOT NULL violation RAISES rather than writing nothing, so it aborts
   * the whole 200-row batch and fails the run — it is not a `blocked` row.
   * One abandoned record in Airtable would otherwise stop a load of 18,803.
   */
  skipped: number;
}

const DRY = '(dry-run)';

export async function runSync(db: Db, opts: SyncOptions): Promise<{ runId: string; tables: TableResult[] }> {
  const log = opts.log ?? (() => {});
  const started = Date.now();
  const limiter = new RateLimiter();

  const selected = selectedTables(opts.tables);
  const skipped = LOAD_ORDER.filter((k) => !selected.includes(k));

  const runId = opts.runId ?? (await openRun(db, opts.dryRun, selected));
  log(
    `run ${runId} ${opts.runId ? 'adopted' : 'opened'}${opts.dryRun ? ' as a dry run' : ''} ` +
      `over ${selected.join(', ')}`
  );

  /** airtable_record_id → mirror uuid, per table, for resolving links. */
  const keys = new Map<TableKey, Map<string, string>>();
  const results: TableResult[] = [];
  /** Rendered rows from showRecords, appended to sync_runs.notes at the end. */
  const samples: string[] = [];

  // A skipped table is not absent, it is already loaded. Reading its keys
  // from the mirror is what keeps "unresolved" meaning "this parent is not
  // in Airtable either" rather than "this table was not in the scope".
  for (const key of skipped) {
    // NO dryRun EXIT HERE. There used to be one, on the reasoning that a
    // dry run should not touch the database — but it already does, to tell
    // an insert from an update, and skipping this made every partial-scope
    // dry run a lie. {"dryRun":true,"tables":["deliverables"]} reported 100
    // of 100 records unresolved and skipped, because `projects` was out of
    // scope so no project link could resolve and project_id was null on
    // every row. The opposite of what the same scope does for real.
    const loaded = await loadKeyMap(db, key);
    keys.set(key, loaded);
    if (loaded.size) log(`${key}: not in scope; ${loaded.size} existing keys loaded for link resolution`);
  }

  try {
    for (const key of selected) {
      if (Date.now() - started > RUN_BUDGET_MS) {
        throw new Error(`out of time before ${key}; ${Math.round((Date.now() - started) / 1000)}s elapsed`);
      }
      const produced = await syncTable(db, runId, key, keys, limiter, opts, log, samples, started);
      for (const result of produced) {
        results.push(result);
        await recordTable(db, runId, result);
      }
    }

    // gross_sf reads deliverables and writes projects, so it means nothing
    // unless both were in scope.
    const bothInScope = selected.includes('deliverables') && selected.includes('projects');
    if (!opts.dryRun && bothInScope) await deriveGrossSf(db, runId, log);
    else if (!opts.dryRun) log('gross_sf: skipped, needs both projects and deliverables in scope');

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

/**
 * One table, a page at a time.
 *
 * NOTHING HERE OUTLIVES THE PAGE IT CAME FROM, and that is the whole point.
 * The previous version read every record into an array, planned every row,
 * wrote them, and only then built the join tables from the same array. For
 * deliverables that is 5,557 records at ~60 KB each — 334 MB of raw JSON —
 * and a run was measured at 821 MB of a 1,024 MB limit. Time Tracking is
 * 29,119 records, so the table was not a slow load, it was an unloadable one.
 *
 * The array was not held because anything needed it. It was held because
 * `buildUpsert` returned `(xmax = 0) as inserted` and not `id`, so the uuid
 * of a row just written was unknown and had to be recovered afterwards by
 * querying the whole id list. Returning one more column is what lets a join
 * row be written beside its parent, on the same page, and the page be
 * discarded.
 *
 * What survives a page, and must:
 *
 *   parentKeys   airtable_record_id → uuid, for tables synced later. Strings;
 *                about 350 KB for deliverables and under a megabyte for
 *                anything in phase two.
 *   counters     the TableResult for the parent and one per join table.
 *
 * That is all. Records, plans and join pairs are page-scoped.
 */
async function syncTable(
  db: Db,
  runId: string,
  key: TableKey,
  keys: Map<TableKey, Map<string, string>>,
  limiter: RateLimiter,
  opts: SyncOptions,
  log: (s: string) => void,
  samples: string[] = [],
  startedAt: number = Date.now()
): Promise<TableResult[]> {
  const t = spec(key);

  const result: TableResult = {
    table: key,
    readFromAirtable: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    wouldInsertExisting: 0,
    unresolvedParents: 0,
    anomalies: 0,
    blocked: 0,
    skipped: 0,
  };

  // ONCE PER TABLE, BEFORE THE FIRST PAGE, and deliberately not per page.
  // This check exists to fail before anything is written rather than 200
  // rows in; running it per page would either repeat the query for every
  // page or report the same fatal error fifty-six times.
  const required = await requiredColumns(db, key);
  const unmapped = required.filter((c) => !columnsFor(t).includes(c));
  if (unmapped.length) {
    throw new Error(
      `${key}: the database requires ${unmapped.join(', ')} but the field map never writes ` +
        'them; every insert would fail. Map them, give them a default, or make them nullable.'
    );
  }

  // Accumulates across pages and is published immediately, because later
  // tables resolve their links against it. Strings only.
  const parentKeys = new Map<string, string>();
  keys.set(key, parentKeys);

  if (opts.joinsOnly) {
    // The parent is not written, so its uuids come from the mirror — which
    // is exactly what the upsert would otherwise have supplied.
    for (const [recordId, uuid] of await loadKeyMap(db, key)) parentKeys.set(recordId, uuid);
    log(`${key}: joinsOnly — parent not written, ${parentKeys.size} existing keys loaded`);
  }

  const joins = t.joins ?? [];
  const joinResults = new Map<string, TableResult>(
    joins.map((j) => [
      j.table,
      {
        table: j.table,
        readFromAirtable: 0,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        wouldInsertExisting: 0,
        unresolvedParents: 0,
        anomalies: 0,
        blocked: 0,
        skipped: 0,
      },
    ])
  );

  const upsertSql = buildUpsert(t);
  const joinSql = new Map(joins.map((j) => [j.table, buildJoinUpsert(j)]));

  /** showRecords state, carried across pages so the cap means what it says. */
  let shownFuzzy = 0;
  let shownExact = 0;
  const wanted = new Set(opts.showRecords ?? []);

  const total = await streamTable(t.airtable, {
    apiKey: opts.apiKey,
    baseId: opts.baseId,
    limiter,
    maxRecords: opts.sampleSize,
    measure: opts.measure,
    onMeasure: (m) =>
      log(
        `${key}: PAGE ${m.records} records, ${m.bytes} bytes on the wire ` +
          `(${Math.round(m.bytes / Math.max(m.records, 1))} avg/record); ` +
          `per record min ${m.perRecordMin}, median ${m.perRecordMedian}, max ${m.perRecordMax}` +
          (m.largestRecordId ? ` (largest: ${m.largestRecordId})` : '')
      ),
  }, async (page) => {
    // The budget is consulted per page as well as per table and per join.
    // A table is now many writes spread over many pages, and the point of
    // the budget is that the run ends on its own clock and closes itself.
    if (Date.now() - startedAt > RUN_BUDGET_MS) {
      throw new Error(
        `out of time during ${key}; ${Math.round((Date.now() - startedAt) / 1000)}s elapsed ` +
          `after ${result.readFromAirtable} records. Re-run the same scope: rows already ` +
          'written are upserts and will be updated, not duplicated.'
      );
    }

    result.readFromAirtable += page.length;

    const issues: { recordId: string; issue: Issue }[] = [];
    const plans: RowPlan[] = [];

    for (const record of page) {
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
            detail:
              'record has no usable Airtable id; it would insert a duplicate on every run and was skipped',
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

    // SKIP WHAT THE DATABASE WOULD REFUSE, rather than letting it abort a
    // batch. A NOT NULL violation raises and rolls back the whole
    // transaction, so one abandoned record in Airtable stops the load —
    // which is what it did to client_companies after 200 rows had committed.
    //
    // Still after link resolution, because an unresolved link is how
    // deliverables.project_id becomes null, and that is the case worth
    // catching rather than a mapping that was never populated.
    const writable: RowPlan[] = [];
    for (const plan of plans) {
      const missing = required.filter((c) => {
        const at = plan.columns.indexOf(c);
        return at >= 0 && (plan.values[at] === null || plan.values[at] === undefined);
      });
      if (missing.length === 0) {
        writable.push(plan);
        continue;
      }
      result.skipped++;
      const known = KNOWN_SKIPS[plan.airtableRecordId];
      issues.push({
        recordId: plan.airtableRecordId,
        issue: {
          kind: 'coercion_failed',
          field: missing.join(', '),
          airtableValue: null,
          detail:
            `skipped: ${missing.join(', ')} would be null and the database requires a value. ` +
            'The record was NOT written, because a NOT NULL violation aborts the whole batch ' +
            'rather than failing one row.' +
            (known ? ` ${known}` : ''),
        },
      });
    }

    // Rendered per page, which changes one thing: ids named explicitly are no
    // longer guaranteed to appear FIRST, because a record on page fifty is
    // not known until page fifty. They are still guaranteed to APPEAR —
    // exact matches never count against the cap — and that was the property
    // worth keeping.
    if (opts.showRecords?.length) {
      const byId = new Map(page.filter((r) => r.id).map((r) => [r.id, r]));
      for (const plan of writable) {
        const isExact = wanted.has(plan.airtableRecordId);
        if (!isExact && shownFuzzy >= (opts.showLimit ?? SHOW_LIMIT)) continue;
        const record = byId.get(plan.airtableRecordId);
        if (!record || !(isExact || matchesAny(record, opts.showRecords, t))) continue;
        if (isExact) shownExact++;
        else shownFuzzy++;
        const rendered = renderPlan(t, plan, record);
        samples.push(rendered);
        for (const line of rendered.split('\n')) log(line);
      }
    }

    // ---- write the parents for this page, learning their uuids as we go ----
    if (opts.joinsOnly) {
      // Nothing to write; parentKeys was filled from the mirror above.
    } else if (opts.dryRun) {
      const existing = await existingKeys(db, key, writable.map((p) => p.airtableRecordId));
      for (const p of writable) {
        if (existing.has(p.airtableRecordId)) result.updated++;
        else result.inserted++;
        // A sentinel, so "unresolved" keeps meaning "this parent is missing
        // from Airtable too" rather than "nothing is loaded yet".
        parentKeys.set(p.airtableRecordId, `${DRY}-${p.airtableRecordId}`);
      }
    } else {
      // One transaction per page. A failure rolls back 100 rows rather than
      // 200, which is strictly better for recovery, and at ~20 rows/sec the
      // commit count is nowhere near the bottleneck.
      await inTransaction(db, async () => {
        for (const p of writable) {
          const res = await db.query(upsertSql, p.values);
          if (!res.rowCount) {
            // The DO UPDATE's WHERE excluded it, or a policy did. Either way
            // the row was not written and nothing errored, which is precisely
            // the failure mode worth counting. No id comes back, so no join
            // row is written for it either — the same outcome as before.
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
            continue;
          }
          const row = res.rows[0] ?? {};
          if (row.inserted) result.inserted++;
          else result.updated++;
          if (row.id) parentKeys.set(p.airtableRecordId, String(row.id));
        }
      });
    }

    // ---- join rows for this page, now that their parents have uuids ----
    for (const join of joins) {
      const jr = joinResults.get(join.table)!;
      const childKeys = keys.get(join.linkTo);
      const pairs: [string, string][] = [];
      // Its OWN issues, recorded against the join table. Folding these into
      // the parent's list would file "this contact is not in contacts" under
      // `projects`, where nobody looking at the join table would find it.
      const joinIssues: { recordId: string; issue: Issue }[] = [];

      for (const record of page) {
        for (const planned of planJoins(t, record)) {
          if (planned.join.table !== join.table) continue;
          jr.readFromAirtable += planned.childRecordIds.length;

          const parentUuid = parentKeys.get(planned.parentRecordId);
          // The parent did not load — already counted against the parent
          // table, so it is not reported twice here.
          if (!parentUuid) continue;

          for (const childId of planned.childRecordIds) {
            const childUuid = childKeys?.get(childId);
            if (!childUuid) {
              jr.unresolvedParents++;
              joinIssues.push({
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
        jr.inserted += pairs.length;
      } else if (pairs.length) {
        await inTransaction(db, async () => {
          for (const [parentUuid, childUuid] of pairs) {
            const res = await db.query(joinSql.get(join.table)!, [parentUuid, childUuid]);
            if (!res.rowCount) jr.blocked++;
            else if (res.rows[0]?.inserted) jr.inserted++;
            else jr.updated++;
          }
        });
      }

      if (joinIssues.length) {
        jr.anomalies += joinIssues.length;
        await recordAnomalies(db, runId, join.table, joinIssues);
      }
    }

    // RECORDED PER PAGE, not once at the end. A run killed mid-table used to
    // record no anomalies at all for that table, which is how the findings
    // from one dry run were lost entirely. Per page they are partial for a
    // killed run, which is a different thing from absent.
    if (issues.length) {
      result.anomalies += issues.length;
      await recordAnomalies(db, runId, key, issues);
    }
  });

  log(`${key}: read ${total} from ${t.airtable}`);
  if (result.skipped) {
    log(`${key}: skipped ${result.skipped} record(s) the database would have refused`);
  }
  if (opts.showRecords?.length && (shownExact || shownFuzzy)) {
    log(`${key}: rendered ${shownExact} by id and ${shownFuzzy} by text match`);
  }
  if (opts.joinsOnly) {
    // nothing written for the parent
  } else if (opts.dryRun) {
    log(`${key}: ${DRY} would insert ${result.inserted}, update ${result.updated}`);
  } else {
    log(`${key}: inserted ${result.inserted}, updated ${result.updated}, blocked ${result.blocked}`);
  }
  for (const join of joins) {
    const jr = joinResults.get(join.table)!;
    log(
      opts.dryRun
        ? `${join.table}: ${DRY} would write ${jr.inserted} links, ${jr.unresolvedParents} unresolved`
        : `${join.table}: ${jr.inserted} new links, ${jr.updated} re-stamped, ${jr.blocked} blocked`
    );
  }

  // On a joinsOnly run the parent was not written, so reporting a row of
  // zeros for it would read as "0 inserted" rather than "not attempted".
  const produced: TableResult[] = opts.joinsOnly ? [] : [result];
  for (const join of joins) produced.push(joinResults.get(join.table)!);
  return produced;
}

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

/**
 * Columns the database will refuse to accept as null.
 *
 * Read from information_schema rather than declared in the field map, so it
 * cannot drift from the schema. A migration that adds a NOT NULL column is
 * reflected on the next run without anyone remembering to update a list —
 * which is the failure this project has hit six times in other forms.
 *
 * Columns WITH a default are excluded: Postgres fills those, and naming them
 * would skip records over a value the database was always going to supply.
 */
async function requiredColumns(db: Db, table: TableKey): Promise<string[]> {
  const res = await db.query(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = $1
        and is_nullable = 'NO' and column_default is null`,
    [table]
  );
  return res.rows.map((r) => String(r.column_name));
}

/**
 * The tables to sync, always in LOAD_ORDER.
 *
 * Intersecting rather than using the caller's order is the whole safety of
 * this option: a child written before its parent would resolve no links, and
 * the list arrives from an HTTP body where nothing guarantees sensible order.
 */
export function selectedTables(requested?: readonly TableKey[]): TableKey[] {
  if (!requested?.length) return [...LOAD_ORDER];
  const unknown = requested.filter((k) => !LOAD_ORDER.includes(k));
  if (unknown.length) {
    throw new Error(`unknown table(s): ${unknown.join(', ')}. Known: ${LOAD_ORDER.join(', ')}`);
  }
  return LOAD_ORDER.filter((k) => requested.includes(k));
}

/** Every airtable_record_id → uuid already in a mirror table. */
async function loadKeyMap(db: Db, table: TableKey): Promise<Map<string, string>> {
  const res = await db.query(
    `select airtable_record_id, id from ${table} where airtable_record_id is not null`
  );
  return new Map(res.rows.map((r) => [String(r.airtable_record_id), String(r.id)]));
}

async function openRun(db: Db, dryRun: boolean, selected: readonly TableKey[]): Promise<string> {
  const whole = selected.length === LOAD_ORDER.length;
  const res = await db.query(
    // NEVER 'full'. sweep_missing_from_airtable() refuses any scope that is
    // not exactly 'full', and phase one reads six of fourteen tables, so it
    // genuinely cannot say what is missing. A narrower scope must not read
    // as a wider one, which is why the table list goes in verbatim.
    `insert into sync_runs (scope, dry_run, notes) values ($1, $2, $3) returning id`,
    [
      whole ? 'phase1' : `phase1:${selected.join('+')}`,
      dryRun,
      `${whole ? 'phase one' : 'partial'}: ${selected.join(', ')}. Partial scope, so the sweep will ` +
        'refuse this run — nothing marks vanished rows until phase two makes it a full pass.',
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
        would_insert_existing, unresolved_parents, anomalies, blocked, skipped)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (run_id, table_name) do update set
       read_from_airtable = excluded.read_from_airtable,
       inserted = excluded.inserted, updated = excluded.updated,
       unchanged = excluded.unchanged,
       would_insert_existing = excluded.would_insert_existing,
       unresolved_parents = excluded.unresolved_parents,
       anomalies = excluded.anomalies,
       blocked = excluded.blocked,
       skipped = excluded.skipped`,
    [runId, r.table, r.readFromAirtable, r.inserted, r.updated, r.unchanged,
     r.wouldInsertExisting, r.unresolvedParents, r.anomalies, r.blocked, r.skipped]
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
    `skipped ${total((r) => r.skipped)}, ` +
    `unresolved links ${total((r) => r.unresolvedParents)}, anomalies ${total((r) => r.anomalies)}`
  );
}

export const PHASE_ONE_TABLES = TABLES.filter((t) => (LOAD_ORDER as readonly string[]).includes(t.key));
