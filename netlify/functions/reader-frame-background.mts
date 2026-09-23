/**
 * The reader's first pass, for one uploaded document.
 *
 * A BACKGROUND function (the -background suffix): Netlify answers the caller
 * with 202 at once and gives this up to 15 minutes. Started by the upload
 * confirm step, or by "Read now" on the documents page — always from a
 * signed-in person's session, because that session is what can mint a signed
 * URL for the private bucket. The reader itself has no storage access at all,
 * by design (migration 004).
 *
 * Connects as cost_reader via READER_DATABASE_URL. Never the service-role key.
 */
import type { Context } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { parseTriggerBody, signedUrlMatches } from '../../src/lib/reader/trigger.ts';
import { runPassOne } from '../../src/lib/reader/pass-one.ts';
import { withDb } from '../../src/lib/reader/db.ts';
import { PASS_ONE_BUDGET_MS } from '../../src/lib/reader/limits.ts';

export default async (req: Request, _context: Context) => {
  const started = Date.now();
  const dbUrl = Netlify.env.get('READER_DATABASE_URL');
  const anthropicKey = Netlify.env.get('ANTHROPIC_API_KEY');
  const supabaseUrl = Netlify.env.get('SUPABASE_URL');
  const anonKey = Netlify.env.get('SUPABASE_ANON_KEY');
  const missing = Object.entries({ READER_DATABASE_URL: dbUrl, ANTHROPIC_API_KEY: anthropicKey, SUPABASE_URL: supabaseUrl, SUPABASE_ANON_KEY: anonKey })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.error(`[reader] not configured in this context: ${missing.join(', ')} unset`);
    return;
  }

  if (req.method !== 'POST') return;
  const body = parseTriggerBody(await req.json().catch(() => null));
  if (!body) {
    console.warn('[reader] rejected: malformed trigger');
    return;
  }

  // 1. A live session for an active DCW user.
  const supabase = createClient(supabaseUrl!, anonKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${body.accessToken}` } },
  });
  const { data: who, error: authError } = await supabase.auth.getUser(body.accessToken);
  if (authError || !who?.user) {
    console.warn(`[reader] rejected ${body.deliverableId}: session did not verify`);
    return;
  }
  const { data: active, error: activeError } = await supabase.rpc('is_active_user');
  if (activeError || active !== true) {
    console.warn(`[reader] rejected ${body.deliverableId}: caller is not an active user`);
    return;
  }

  // 2. The URL is this project's storage, and this document's own object.
  const storagePath = await withDb(dbUrl!, async (db) => {
    const r = await db.query(`select storage_path from deliverables where id = $1`, [body.deliverableId]);
    return (r.rows[0]?.storage_path as string | null) ?? null;
  });
  if (!signedUrlMatches(body.signedUrl, supabaseUrl!, storagePath)) {
    console.warn(`[reader] rejected ${body.deliverableId}: signed URL does not point at this document's file`);
    return;
  }

  const outcome = await runPassOne({
    dbUrl: dbUrl!,
    anthropicKey: anthropicKey!,
    deliverableId: body.deliverableId,
    signedUrl: body.signedUrl,
    triggeredBy: who.user.id,
    budgetMs: PASS_ONE_BUDGET_MS - (Date.now() - started),
  });

  const secs = Math.round((Date.now() - started) / 1000);
  if (outcome.kind === 'failed') console.error(`[reader] ${body.deliverableId} failed after ${secs}s: ${outcome.reason}`);
  else console.log(`[reader] ${body.deliverableId} ${outcome.kind} in ${secs}s (run ${outcome.runId})`);
};
