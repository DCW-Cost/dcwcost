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
import {
  buildBatchJoinUpsert,
  buildBatchUpsert,
  buildJoinUpsert,
  buildUpsert,
  columnsFor,
  maxRowsPerStatement,
  planJoins,
  planRow,
  type Issue,
  type RowPlan,
} from './plan.ts';

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
 *   WRITE RATE: 164 rows/sec. Measured 6 October 2026 on the batched
 *   path — 16,603 rows across projects, deliverables and their four join
 *   tables, in 101 seconds, every table reconciling with 0 blocked and 0
 *   unresolved. That is the number to size future work against.
 *
 *   THE PREVIOUS FIGURE WAS 16.3 rows/sec, and the tenfold gap is real
 *   rather than a typo. It was one round trip per row, measured the same
 *   morning on the same tables: 10,942 rows in 671 seconds. Batched
 *   inserts replaced it, and both numbers are kept so nobody reads the
 *   jump as an error and quietly "corrects" it back.
 *
 *   What that buys: Time Tracking's 29,119 records go from 28 minutes,
 *   which does not fit, to about three, which does. Phase two's eight
 *   tables together are roughly four minutes of writing.
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

  if (opts.measureOnly) {
    const runId = opts.runId ?? (await openMeasureRun(db, opts.measureOnly));
    log(`run ${runId} measuring ${opts.measureOnly}; nothing will be written`);
    try {
      const summary = await measureAirtableTable(opts, limiter, log);
      await closeRun(db, runId, 'succeeded', summary);
      log(`run ${runId} succeeded`);
      return { runId, tables: [] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await closeRun(db, runId, 'failed', message.slice(0, 2000)).catch(() => {});
      log(`run ${runId} FAILED: ${message}`);
      throw err;
    }
  }

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

  // DERIVED FROM THE COLUMN COUNT, not assumed. Postgres accepts 65,535
  // bind parameters per statement and a batch spends rows x columns of
  // them, so a wide table has a lower ceiling: deliverables' 61 columns cap
  // it at 1,092 rows where contacts' 13 allow 5,041.
  //
  // LOGGED, not merely computed. A future table wide enough to drop the
  // batch to 40 rows would make a run six times slower with nothing on
  // screen to explain why.
  const batchRows = Math.min(BATCH, maxRowsPerStatement(t));
  if (!opts.dryRun && !opts.joinsOnly) {
    log(`${key}: writing in batches of ${batchRows} (${columnsFor(t).length} columns)`);
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

  const JOIN_BATCH_ROWS = Math.min(BATCH, Math.floor(65535 / 2));

  // Loaded before the first page and emptied as links are seen, so what
  // remains at the end is what Airtable no longer has. Bounded by the join
  // table's size — 3,501 pairs of short strings for the largest here.
  //
  // SKIPPED ENTIRELY UNDER sampleSize, because reading 100 of 5,558 records
  // leaves almost every link unseen and would report thousands of false
  // disappearances. A misleading number here is worse than none: it is the
  // number a design decision has been waiting on.
  const staleLinks = new Map<string, Set<string>>();
  if (!opts.sampleSize) {
    for (const join of joins) {
      staleLinks.set(join.table, await existingLinkPairs(db, t, join));
    }
  }

  // Totalled across pages, because the per-page line alone cannot answer
  // the question the measurement exists for: whether memory tracks RECORDS
  // or BYTES. Per-page averages on deliverables range 41-66 KB, so a table
  // of narrower rows -- time_entries is person, date, hours, task -- would
  // extrapolate completely differently under the two answers.
  let bytesRead = 0;

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
    onMeasure: (m) => {
      bytesRead += m.bytes;
      log(
        `${key}: PAGE ${m.records} records, ${m.bytes} bytes on the wire ` +
          `(${Math.round(m.bytes / Math.max(m.records, 1))} avg/record); ` +
          `per record min ${m.perRecordMin}, median ${m.perRecordMedian}, max ${m.perRecordMax}` +
          (m.largestRecordId ? ` (largest: ${m.largestRecordId})` : '')
      );
    },
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
      // ONE STATEMENT PER PAGE, not one per row.
      //
      // Deduped by key first, because `ON CONFLICT DO UPDATE` refuses when
      // the same key appears twice in one statement — "cannot affect row a
      // second time". That cannot happen one row at a time, so it is a new
      // failure mode and it is recorded rather than quietly collapsed: a
      // duplicate means Airtable returned one or our paging overlapped, and
      // which of those it is matters.
      const byKey = new Map<string, RowPlan>();
      for (const p of writable) {
        const seen = byKey.get(p.airtableRecordId);
        if (seen) {
          issues.push({
            recordId: p.airtableRecordId,
            issue: {
              kind: 'coercion_failed',
              field: 'airtable_record_id',
              airtableValue: p.airtableRecordId,
              detail:
                'the same Airtable record id appeared twice while reading this table, so the ' +
                'second copy was dropped before writing. One statement cannot upsert the same ' +
                'key twice. Either Airtable returned the record twice or a page boundary ' +
                'overlapped — both are worth knowing about.',
            },
          });
          continue;
        }
        byKey.set(p.airtableRecordId, p);
      }
      const unique = [...byKey.values()];

      for (let i = 0; i < unique.length; i += batchRows) {
        const slice = unique.slice(i, i + batchRows);
        const sql = buildBatchUpsert(t, slice.length);
        const params = slice.flatMap((p) => p.values);

        let returned;
        try {
          returned = await inTransaction(db, () => db.query(sql, params));
        } catch (err) {
          // The transaction is already rolled back. Find every bad row,
          // writing nothing, so the failure names records rather than a
          // constraint. Previously a throw identified one row because each
          // was sent separately; this finds them all on purpose.
          const bad = await findOffendingRows(
            db,
            buildUpsert(t),
            slice.map((p) => ({ recordId: p.airtableRecordId, values: p.values }))
          );
          const named = bad.length
            ? bad.map((b) => `${b.recordId}: ${b.message}`).join('; ')
            : 'no single row reproduced it, so the batch itself is at fault';
          throw new Error(
            `${key}: a batch of ${slice.length} rows failed. ${bad.length} offending row(s) — ${named}`
          );
        }

        // RETURNING ORDER IS UNSPECIFIED, so rows are matched by key and
        // never by position. A row the DO UPDATE's WHERE or a policy
        // excluded simply does not come back, which makes `blocked` the set
        // difference — and names the records, where counting rowCount could
        // only say how many.
        const wrote = new Set<string>();
        for (const row of returned.rows ?? []) {
          const recordId = String(row.airtable_record_id);
          wrote.add(recordId);
          if (row.inserted) result.inserted++;
          else result.updated++;
          if (row.id) parentKeys.set(recordId, String(row.id));
        }
        for (const p of slice) {
          if (wrote.has(p.airtableRecordId)) continue;
          result.blocked++;
          issues.push({
            recordId: p.airtableRecordId,
            issue: {
              kind: 'coercion_failed',
              field: '(row)',
              airtableValue: p.airtableRecordId,
              detail:
                'upsert returned no row — a matching row exists that this sync does not own ' +
                `(${t.restrictUpdateTo ?? 'no restriction'}), or a policy refused it`,
            },
          });
        }
      }
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
            // Marked seen by AIRTABLE ids, before resolution, so a link
            // whose child is missing from the mirror still counts as
            // present in Airtable — it is unresolved, not disappeared,
            // and those are different findings.
            staleLinks.get(join.table)?.delete(`${planned.parentRecordId}|${childId}`);

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
        // Deduped for the same reason as the parents: one statement cannot
        // upsert the same (parent, child) twice. A repeat here is benign —
        // the link is recorded once either way — so it is dropped without
        // an anomaly, unlike a duplicate parent key, which says something
        // about the source.
        const seenPairs = new Set<string>();
        const uniquePairs = pairs.filter(([a, b]) => {
          const k = `${a}|${b}`;
          if (seenPairs.has(k)) return false;
          seenPairs.add(k);
          return true;
        });

        for (let i = 0; i < uniquePairs.length; i += JOIN_BATCH_ROWS) {
          const slice = uniquePairs.slice(i, i + JOIN_BATCH_ROWS);
          const sql = buildBatchJoinUpsert(join, slice.length);
          const params = slice.flat();
          try {
            const res = await inTransaction(db, () => db.query(sql, params));
            const returnedCount = (res.rows ?? []).length;
            for (const row of res.rows ?? []) {
              if (row.inserted) jr.inserted++;
              else jr.updated++;
            }
            jr.blocked += slice.length - returnedCount;
          } catch (err) {
            const bad = await findOffendingRows(
              db,
              buildJoinUpsert(join),
              slice.map(([a, b]) => ({ recordId: `${a} -> ${b}`, values: [a, b] }))
            );
            const named = bad.length
              ? bad.map((x) => `${x.recordId}: ${x.message}`).join('; ')
              : 'no single pair reproduced it';
            throw new Error(
              `${join.table}: a batch of ${slice.length} links failed. ${bad.length} offending — ${named}`
            );
          }
        }
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
  if (opts.measure) {
    log(
      `${key}: TOTAL ${total} records, ${bytesRead} bytes on the wire ` +
        `(${(bytesRead / 1024 / 1024).toFixed(1)} MB, ` +
        `${Math.round(bytesRead / Math.max(total, 1))} avg/record)`
    );
  }
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

    // THE PARKED QUESTION, AS A NUMBER. A link removed in Airtable has
    // nowhere to be recorded: these tables have no is_active and the sync
    // never deletes. Whether that matters depends on how often it happens,
    // which nobody has known — so this counts rather than argues.
    const left = staleLinks.get(join.table);
    if (!opts.sampleSize && left) {
      const examples = [...left].slice(0, 5).join(', ');
      log(
        `${join.table}: ${left.size} mirror link(s) not present in Airtable` +
          (left.size ? ` — e.g. ${examples}` : '')
      );
    } else if (opts.sampleSize) {
      log(`${join.table}: stale-link count skipped, sampleSize would make it meaningless`);
    }
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

/** Rows that could not be written, with the error each one produced. */
export interface RowFailure {
  index: number;
  recordId: string;
  message: string;
}

/**
 * Replay a failed batch one row at a time, writing nothing.
 *
 * Savepoints rather than separate transactions: a row that succeeds here
 * must not commit, or diagnosing a failure would write a partial batch as
 * a side effect of looking at it.
 */
export async function findOffendingRows(
  db: Db,
  sql: string,
  rows: Array<{ recordId: string; values: unknown[] }>
): Promise<RowFailure[]> {
  const failures: RowFailure[] = [];
  await db.query('begin');
  try {
    for (let i = 0; i < rows.length; i++) {
      await db.query('savepoint probe');
      try {
        await db.query(sql, rows[i].values);
        await db.query('release savepoint probe');
      } catch (err) {
        await db.query('rollback to savepoint probe').catch(() => {});
        failures.push({
          index: i,
          recordId: rows[i].recordId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    // Always. Nothing found here is kept — this is diagnosis, not a retry.
    await db.query('rollback').catch(() => {});
  }
  return failures;
}

/**
 * Links the mirror holds, keyed the way Airtable names them.
 *
 * WHY AIRTABLE IDS AND NOT UUIDS. The obvious comparison is uuid pairs,
 * and it does not work on a dry run: nothing is written, so the parent
 * uuids are sentinels and match nothing in the mirror. Joining out to the
 * two parent tables costs one query and makes the count mean the same
 * thing whether or not the run writes.
 *
 * This exists to answer a question that was parked twice for want of a
 * number: how often does a link disappear from Airtable? Every option for
 * handling it is unattractive in a different way, and which unattractive
 * thing is worth doing depends entirely on whether the answer is 2 or 200.
 */
async function existingLinkPairs(
  db: Db,
  parent: TableSpec,
  join: JoinSpec
): Promise<Set<string>> {
  const res = await db.query(
    `select p.airtable_record_id as parent_key, c.airtable_record_id as child_key
       from ${join.table} j
       join ${parent.key} p on p.id = j.${join.parentColumn}
       join ${join.linkTo} c on c.id = j.${join.childColumn}
      where p.airtable_record_id is not null and c.airtable_record_id is not null`
  );
  return new Set(res.rows.map((r) => `${r.parent_key}|${r.child_key}`));
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
 * Read one Airtable table and report what it costs, writing nothing.
 *
 * Reports a DISTRIBUTION rather than an average. Deliverables average
 * 54 KB a record with a 402 KB tail, and the mean alone is what made an
 * earlier generalisation from a single page wrong. Three more numbers cost
 * nothing to print and are the difference between knowing the shape and
 * assuming it.
 */
async function measureAirtableTable(
  opts: SyncOptions,
  limiter: RateLimiter,
  log: (s: string) => void
): Promise<string> {
  let bytes = 0;
  let pages = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  let largestId: string | null = null;
  const medians: number[] = [];

  const records = await streamTable(
    opts.measureOnly!,
    {
      apiKey: opts.apiKey,
      baseId: opts.baseId,
      limiter,
      maxRecords: opts.sampleSize,
      measure: true,
      onMeasure: (m) => {
        bytes += m.bytes;
        pages++;
        if (m.perRecordMin < min) min = m.perRecordMin;
        if (m.perRecordMax > max) {
          max = m.perRecordMax;
          largestId = m.largestRecordId;
        }
        medians.push(m.perRecordMedian);
        log(
          `${opts.measureOnly}: PAGE ${m.records} records, ${m.bytes} bytes ` +
            `(${Math.round(m.bytes / Math.max(m.records, 1))} avg/record); ` +
            `min ${m.perRecordMin}, median ${m.perRecordMedian}, max ${m.perRecordMax}` +
            (m.largestRecordId ? ` (largest: ${m.largestRecordId})` : '')
        );
      },
    },
    // Nothing is kept and nothing is written. The page is measured as it
    // arrives and then dropped, which is also what makes this safe to point
    // at a table of any size.
    () => {}
  );

  const avg = Math.round(bytes / Math.max(records, 1));
  const medianOfMedians = medians.length
    ? [...medians].sort((a, b) => a - b)[Math.floor(medians.length / 2)]
    : 0;

  // 1,100 MB of wire data is roughly where 210 + 0.74 x MB reaches the
  // 1,024 MB function limit. Stated as a projection, not a verdict.
  const PROJECTED_CEILING_MB = 1100;
  const fitsAt = Math.floor((PROJECTED_CEILING_MB * 1024 * 1024) / Math.max(avg, 1));

  const summary =
    `measured ${opts.measureOnly}: ${records} records over ${pages} page(s), ` +
    `${bytes} bytes (${(bytes / 1024 / 1024).toFixed(1)} MB). ` +
    `Per record: min ${min === Number.POSITIVE_INFINITY ? 0 : min}, ` +
    `median ~${medianOfMedians}, max ${max}, avg ${avg}` +
    (largestId ? ` (largest ${largestId})` : '') +
    `. At this average a full table of about ${fitsAt.toLocaleString('en-US')} records ` +
    'would reach the measured memory ceiling.';

  log(summary);
  return summary;
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

/** Never 'full': the sweep refuses anything else, and this read nothing at all. */
async function openMeasureRun(db: Db, table: string): Promise<string> {
  const res = await db.query(
    `insert into sync_runs (scope, dry_run, notes) values ($1, true, $2) returning id`,
    [`measure:${table}`.slice(0, 60), `sizing ${table} only; no mapping, no writes`]
  );
  return String(res.rows[0].id);
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
