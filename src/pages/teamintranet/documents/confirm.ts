/**
 * Step two of an upload: the browser reports whether the file actually landed.
 *
 * `ok: true` records the storage path, which is what makes the row real — until
 * then it has no file and the reader must not pick it up.
 *
 * `ok: false` deletes the row. A failed upload should leave nothing behind, and
 * the alternative (a permanent "pending" row whose file never arrives) is the
 * kind of debris nobody notices until the queue is full of it.
 *
 * WHY EVERY WRITE HERE COUNTS ITS ROWS
 *
 * Row-level security does not raise an error when it refuses a write. It
 * filters the rows out first, so an UPDATE or DELETE that policy forbids comes
 * back as success with nothing changed. Checking only `error` therefore reports
 * a denied write as a completed one.
 *
 * That is not hypothetical: `deliverables` shipped with no UPDATE policy, this
 * endpoint returned ok, the browser showed "Stored", and `storage_path` stayed
 * NULL — a document that looked filed and was not, with nothing on screen to
 * explain it. 003 adds the policies; this counts the rows so the next missing
 * one is loud instead of silent.
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

const DENIED =
  'The database refused that write. The upload policies are probably missing — ' +
  'run migrations/003_deliverable_writes.sql in Supabase.';

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

  // The upload failed: take the row back out. `.select()` makes the result
  // carry the deleted rows, so a policy that silently removed nothing is
  // visible rather than passing as a clean-up that never happened.
  if (body.ok === false) {
    const { data, error } = await supabase
      .from('deliverables')
      .delete()
      .eq('id', id)
      .select('id');
    if (error) return json({ error: error.message }, 400);
    if (!data || data.length === 0) return json({ error: DENIED }, 403);
    return json({ ok: true, discarded: true });
  }

  const path = String(body.path ?? '');
  if (!path) return json({ error: 'Missing storage path.' }, 400);

  const { data, error } = await supabase
    .from('deliverables')
    .update({ storage_path: `${BUCKET}/${path}` })
    .eq('id', id)
    .select('id');

  if (error) return json({ error: error.message }, 400);
  // Zero rows here is the exact failure described above: policy refused, no
  // error raised, nothing written. Never report that as stored.
  if (!data || data.length === 0) return json({ error: DENIED }, 403);

  return json({ ok: true });
};
