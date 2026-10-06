/**
 * Turning an HTTP body into sync options.
 *
 * WHY THIS IS NOT IN THE NETLIFY FUNCTION, WHERE IT OBVIOUSLY BELONGS.
 *
 * It was. Parsing four fields inline looked too small to extract, and the
 * result was an outage that no test could have caught:
 *
 *   const tables = Array.isArray(body.tables) ? … : undefined;   // outer
 *   try {
 *     const { runId, tables } = await withDb(url, (db) =>        // shadows it
 *       runSync(db, { …, tables, … }));                          // binds to the shadow
 *
 * runSync returns `{ runId, tables }`, so the destructuring declares a second
 * `tables` in the try block. The arrow function is inside that block, so its
 * `tables` resolved to the binding being initialised by the await it was part
 * of — a temporal dead zone. Every request died with "Cannot access 'tables2'
 * before initialization" before the run row was opened, and because a
 * background function answers 202 before any of this executes, the caller saw
 * success. The only visible symptom was a run that never appeared.
 *
 * The handler body cannot be tested: it reads `Netlify.env`, which does not
 * exist in the test runner. So anything that lives there is unverified by
 * construction, and the import smoke test only proves the module loads. The
 * fix is to leave almost nothing there. This function is pure, exported, and
 * tested; the handler reads env, checks the secret, and calls it.
 */
import type { TableKey } from './tables.ts';

export interface ParsedRequest {
  dryRun: boolean;
  sampleSize?: number;
  showRecords?: string[];
  showLimit?: number;
  tables?: TableKey[];
  /** Set by the trigger route, which opened the run row to return its id. */
  runId?: string;
  /** Write only the join tables, leaving their parents untouched. */
  joinsOnly?: boolean;
  /** Log per-page wire size and record-size spread. */
  measure?: boolean;
  /** Size one Airtable table by name, writing nothing and mapping nothing. */
  measureOnly?: string;
}

/** Non-empty strings only, or undefined. Shared by showRecords and tables. */
function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  return out.length ? out : undefined;
}

/** A positive whole number, or undefined. */
function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export function parseSyncRequest(body: unknown): ParsedRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    // Strictly `true`. A body of {"dryRun":"false"} must not be truthy, and
    // the direction of that mistake is a real write someone expected to be
    // a rehearsal.
    dryRun: b.dryRun === true,
    sampleSize: positiveInt(b.sampleSize),
    // An empty string would match every record and turn a sample into a dump
    // of the whole base, so empties are dropped here rather than downstream.
    showRecords: stringList(b.showRecords),
    showLimit: positiveInt(b.showLimit),
    // NOT validated against LOAD_ORDER here. runSync throws on an unknown
    // name, which closes the run as failed with the reason in it. Filtering
    // a misspelling out instead would sync fewer tables than were asked for
    // and report success.
    tables: stringList(b.tables) as TableKey[] | undefined,
    // Only ever sent by the trigger route, never by a person. A caller who
    // supplies one is adopting a row they are claiming to have opened; the
    // background function is behind the same secret, so this is no wider a
    // trust than the rest of the body.
    runId: typeof b.runId === 'string' && b.runId.trim() !== '' ? b.runId.trim() : undefined,
    // Strictly true, like dryRun. The costly direction of a mistake here is
    // a run that silently writes no parents when a full load was wanted.
    joinsOnly: b.joinsOnly === true,
    measure: b.measure === true,
    // A table NAME, not a key: the point is to size a table before it has a
    // field map, so it cannot be validated against LOAD_ORDER. An unknown
    // name fails at Airtable with a 404 naming the table, which is a clear
    // enough error for a measurement.
    measureOnly:
      typeof b.measureOnly === 'string' && b.measureOnly.trim() !== ''
        ? b.measureOnly.trim()
        : undefined,
  };
}
