/**
 * The Airtable → Postgres mirror, phase one.
 *
 * A BACKGROUND function (the -background suffix): Netlify answers 202 at once
 * and gives this up to 15 minutes. Phase one is about 9,630 records and 100
 * Airtable requests — roughly twenty seconds of paging plus the writes.
 *
 * NOT a scheduled function, and that is not a preference. Scheduled functions
 * on Netlify get 30 seconds, which this cannot fit in. When there is a reason
 * to run it unattended, the shape is a scheduled function that POSTs to this
 * one — the same pair the reader already uses.
 *
 * Connects as airtable_sync via AIRTABLE_SYNC_DATABASE_URL. Never the
 * service-role key: that key holds DELETE on every table and ignores every
 * policy, and this sync is built so that deleting a row is impossible rather
 * than merely unintended.
 *
 * POST body, all optional:
 *   { "dryRun": true }          report what would be written, write nothing
 *   { "sampleSize": 50 }        read at most n records per table
 *   { "showRecords": ["Oregon Zoo", "recW3IXu..."] }
 *                               render those records' planned rows in full,
 *                               into the log AND into sync_runs.notes, so the
 *                               values can be read back without the logs
 *   { "showLimit": 5 }          cap per table (default 5)
 */
import type { Context } from '@netlify/functions';
import { withDb } from '../../src/lib/sync/db.ts';
import { runSync } from '../../src/lib/sync/run.ts';

export default async (req: Request, _context: Context) => {
  const dbUrl = Netlify.env.get('AIRTABLE_SYNC_DATABASE_URL');
  const apiKey = Netlify.env.get('AIRTABLE_API_KEY');
  const baseId = Netlify.env.get('AIRTABLE_BASE_ID');
  const secret = Netlify.env.get('SYNC_TRIGGER_SECRET');

  const missing = Object.entries({
    AIRTABLE_SYNC_DATABASE_URL: dbUrl,
    AIRTABLE_API_KEY: apiKey,
    AIRTABLE_BASE_ID: baseId,
    SYNC_TRIGGER_SECRET: secret,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length) {
    // Fails CLOSED, including on a missing secret. A background function sits
    // at a public URL, and "it isn't scheduled yet" is not a reason for that
    // URL to start a sync for anyone who finds it. Unset the variable and
    // nothing runs; that is the safe direction for the mistake to fall.
    console.error(`[sync] not configured in this context: ${missing.join(', ')} unset`);
    return;
  }

  if (req.method !== 'POST') return;

  if (!timingSafeEqual(req.headers.get('x-sync-secret') ?? '', secret!)) {
    console.warn('[sync] rejected: bad or missing x-sync-secret');
    return;
  }

  const body = (await req.json().catch(() => ({}))) as {
    dryRun?: unknown;
    sampleSize?: unknown;
    showRecords?: unknown;
    showLimit?: unknown;
  };
  const dryRun = body.dryRun === true;
  const sampleSize =
    typeof body.sampleSize === 'number' && body.sampleSize > 0 ? Math.floor(body.sampleSize) : undefined;
  // Strings only, and non-empty: an empty term matches every record, which
  // would turn a sample into a dump of the whole base.
  const showRecords = Array.isArray(body.showRecords)
    ? body.showRecords.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    : undefined;
  const showLimit =
    typeof body.showLimit === 'number' && body.showLimit > 0 ? Math.floor(body.showLimit) : undefined;

  const started = Date.now();
  try {
    const { runId, tables } = await withDb(dbUrl!, (db) =>
      runSync(db, {
        apiKey: apiKey!,
        baseId: baseId!,
        dryRun,
        sampleSize,
        showRecords,
        showLimit,
        log: (line) => console.log(`[sync] ${line}`),
      })
    );

    for (const t of tables) {
      console.log(
        `[sync] ${t.table}: read ${t.readFromAirtable}, insert ${t.inserted}, update ${t.updated}, ` +
          `blocked ${t.blocked}, unresolved ${t.unresolvedParents}, anomalies ${t.anomalies}` +
          (t.wouldInsertExisting ? `, WOULD DUPLICATE ${t.wouldInsertExisting}` : '')
      );
    }
    console.log(
      `[sync] run ${runId} finished in ${Math.round((Date.now() - started) / 1000)}s` +
        `${dryRun ? ' (dry run — nothing was written to the mirror)' : ''}`
    );
  } catch (err) {
    // The run row is already closed as 'failed' with the reason by runSync;
    // this is only the log line. Nothing is retried automatically — a sync
    // that half-ran should be looked at before it runs again.
    console.error(`[sync] failed after ${Math.round((Date.now() - started) / 1000)}s:`, err);
  }
};

/** Constant-time compare, so the secret cannot be guessed a character at a time. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
