/**
 * Starting a sync, and SAYING WHETHER IT STARTED.
 *
 * WHY THIS EXISTS AT ALL.
 *
 * The sync runs in a background function, and a Netlify background function
 * cannot answer. The platform returns 202 before the handler executes and
 * discards whatever it returns, so a request with a wrong secret, a missing
 * environment variable or a crash on line one is indistinguishable from a
 * run that worked. That is not a theory: a shadowed variable killed every
 * request for an hour, each one answered 202, and the only way to notice was
 * to query sync_runs and find nothing there.
 *
 * This route runs in the SSR function, which CAN answer. It does the three
 * things that must be reportable, then hands off:
 *
 *   401  the secret is wrong                  — one second to diagnose
 *   500  an environment variable is unset     — says which
 *   502  the database refused the run row     — says so, nothing started
 *   202  { runId }                            — a row exists; go look at it
 *
 * The hand-off POST is deliberately NOT awaited to completion — the point of
 * the background function is the fifteen-minute budget, and waiting for it
 * here would hit the SSR timeout instead. So there is one failure this
 * cannot report: the hand-off itself failing after the row is opened.
 *
 * THAT FAILURE IS SAFE BY CONSTRUCTION RATHER THAN BY CARE. It leaves a row
 * with finished_at null, which is visible in one query, and
 * sweep_missing_from_airtable() already refuses to act on a run that never
 * finished. An unfinished row is the correct description of what happened.
 *
 * NOT BEHIND THE SESSION GUARD, deliberately: see MACHINE_PATHS in
 * src/middleware.ts. This is called by a scheduler or by hand with a shared
 * secret, never by a browser with a session, so it authenticates itself and
 * must keep doing so.
 */
import type { APIRoute } from 'astro';
import { parseSyncRequest } from '../../../lib/sync/request.ts';
import { selectedTables } from '../../../lib/sync/run.ts';
import { withDb } from '../../../lib/sync/db.ts';

export const prerender = false;

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Constant-time compare, so the secret cannot be guessed a character at a time. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const env = (name: string): string | undefined =>
  (typeof process !== 'undefined' ? process.env?.[name] : undefined) || undefined;

export const POST: APIRoute = async ({ request, url }) => {
  const dbUrl = env('AIRTABLE_SYNC_DATABASE_URL');
  const secret = env('SYNC_TRIGGER_SECRET');

  const missing = Object.entries({ AIRTABLE_SYNC_DATABASE_URL: dbUrl, SYNC_TRIGGER_SECRET: secret })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    // Named, because "it isn't configured" without saying which variable is
    // the same dead end this route was written to remove.
    return json(500, { error: 'not configured', unset: missing });
  }

  if (!timingSafeEqual(request.headers.get('x-sync-secret') ?? '', secret!)) {
    return json(401, { error: 'bad or missing x-sync-secret' });
  }

  const body = await request.json().catch(() => ({}));
  const opts = parseSyncRequest(body);

  // Validated HERE as well as in runSync, because this is the half that can
  // tell the caller. A misspelled table name becomes a 400 they can read
  // rather than a failed run they have to go and find.
  let tables;
  try {
    tables = selectedTables(opts.tables);
  } catch (err) {
    return json(400, { error: err instanceof Error ? err.message : String(err) });
  }

  let runId: string;
  try {
    runId = await withDb(dbUrl!, async (db) => {
      const whole = tables.length === 6;
      const res = await db.query(
        // Never 'full': sweep_missing_from_airtable() refuses any scope that
        // is not exactly that, and phase one reads six of fourteen tables.
        `insert into sync_runs (scope, dry_run, notes) values ($1, $2, $3) returning id`,
        [
          whole ? 'phase1' : `phase1:${tables.join('+')}`,
          opts.dryRun,
          `${opts.dryRun ? 'dry run' : 'run'} opened by /api/sync/trigger over ${tables.join(', ')}. ` +
            'Partial scope, so the sweep will refuse this run.',
        ]
      );
      return String(res.rows[0].id);
    });
  } catch (err) {
    return json(502, {
      error: 'could not open a run row; nothing was started',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // Fire and do not await. The background function owns the long work and
  // the fifteen-minute budget; waiting here would hit the SSR timeout and
  // report a failure for a run that is proceeding normally.
  const target = new URL('/.netlify/functions/airtable-sync-background', url.origin);
  void fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sync-secret': secret! },
    body: JSON.stringify({ ...opts, runId }),
  }).catch((err) => {
    // Logged, not returned: by now the caller has their run id and the row
    // is the record. A row left running is the honest description.
    console.error(`[sync] hand-off to the background function failed for run ${runId}:`, err);
  });

  return json(202, {
    runId,
    dryRun: opts.dryRun,
    tables,
    check: `select outcome, finished_at from sync_runs where id = '${runId}'`,
  });
};

/** Anything but POST, so a browser visit gets an answer rather than a blank. */
export const ALL: APIRoute = () => json(405, { error: 'POST only' });
