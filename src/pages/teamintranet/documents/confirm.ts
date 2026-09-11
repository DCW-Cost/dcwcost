/**
 * Step two of an upload: the browser reports whether the file actually landed.
 *
 * `ok: true` records the storage path, which is what makes the row real — until
 * then it has no file and the reader must not pick it up.
 *
 * `ok: false` deletes the row. A failed upload should leave nothing behind,
 * and the alternative (a permanent "pending" row whose file never arrives)
 * is the kind of debris nobody notices until the queue is full of it.
 *
 * Deleting is safe against abuse: row-level security only lets someone remove
 * a deliverable they uploaded, and this runs as them.
 */
import type { APIRoute } from 'astro';
import { serverClient } from '../../../lib/intranet/auth.ts';
import { BUCKET } from '../../../lib/intranet/documents.ts';

export const prerender = false;

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ cookies, request }) => {
  const supabase = serverClient(cookies, request);
  if (!supabase) return json({ error: 'No database configured.' }, 503);

  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return json({ error: 'Not signed in.' }, 401);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Could not read that request.' }, 400);
  }

  const id = String(body.deliverableId ?? '');
  if (!id) return json({ error: 'Missing deliverable id.' }, 400);

  if (body.ok === false) {
    await supabase.from('deliverables').delete().eq('id', id);
    return json({ ok: true, discarded: true });
  }

  const path = String(body.path ?? '');
  if (!path) return json({ error: 'Missing storage path.' }, 400);

  const { error } = await supabase
    .from('deliverables')
    .update({ storage_path: `${BUCKET}/${path}` })
    .eq('id', id);

  if (error) return json({ error: error.message }, 400);
  return json({ ok: true });
};
