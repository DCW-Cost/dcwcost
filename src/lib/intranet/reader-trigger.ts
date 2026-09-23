/**
 * Start the reader on one document, from a signed-in person's session.
 *
 * The reader has no storage privileges (migration 004), so it cannot fetch the
 * file itself. This mints a short-lived signed download URL with the person's
 * own session — the same pattern documents/sign.ts uses for uploads — and hands
 * it, with the person's access token, to the background function. The function
 * verifies both before it spends anything (src/lib/reader/trigger.ts).
 *
 * Never throws: a failed trigger must not fail the upload that called it. The
 * document stays `pending`, the sweeper flags it within the hour, and "Read
 * now" retries it.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { BUCKET } from './documents.ts';

/** Long enough to survive a cold start; short enough to be useless if leaked. */
const SIGNED_URL_SECONDS = 15 * 60;

export const READER_FUNCTION_PATH = '/.netlify/functions/reader-frame-background';

export async function startReader(
  supabase: SupabaseClient,
  request: Request,
  deliverableId: string,
  storagePath: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const key = storagePath.startsWith(`${BUCKET}/`) ? storagePath.slice(BUCKET.length + 1) : storagePath;
    const { data: signed, error: signError } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(key, SIGNED_URL_SECONDS);
    if (signError || !signed?.signedUrl) {
      return { ok: false, error: `Could not sign the file for the reader: ${signError?.message ?? 'no URL'}` };
    }

    const { data: session } = await supabase.auth.getSession();
    const accessToken = session.session?.access_token;
    if (!accessToken) return { ok: false, error: 'No session to start the reader with.' };

    const res = await fetch(new URL(READER_FUNCTION_PATH, request.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deliverableId, signedUrl: signed.signedUrl, accessToken }),
    });
    // A background function answers 202 immediately; anything else means it
    // is not deployed here (e.g. `astro dev`) or Netlify refused the call.
    if (res.status !== 202) {
      return { ok: false, error: `The reader did not accept the job (HTTP ${res.status}).` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
