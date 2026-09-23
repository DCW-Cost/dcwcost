/**
 * "Read now" — start, or restart, the reader on one uploaded document.
 *
 * The retry path the sweeper points people at, and the way to re-frame a
 * document. Only a document that is waiting (`pending`), `failed`, or `framed`,
 * and whose file actually arrived, can be started; the reader's own claim
 * enforces the same rule again, so a double click or a second tab cannot run
 * one document twice.
 */
import type { APIRoute } from 'astro';
import { serverClient } from '../../../lib/intranet/auth.ts';
import { startReader } from '../../../lib/intranet/reader-trigger.ts';

export const prerender = false;

function back(params: Record<string, string>) {
  return new Response(null, {
    status: 303,
    headers: { location: `/teamintranet/documents/?${new URLSearchParams(params)}` },
  });
}

export const POST: APIRoute = async ({ cookies, request }) => {
  const supabase = serverClient(cookies, request);
  if (!supabase) return back({ bad: 'No database configured.' });

  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return back({ bad: 'Not signed in.' });

  const form = await request.formData().catch(() => null);
  const id = String(form?.get('deliverable_id') ?? '');
  if (!id) return back({ bad: 'Missing document.' });

  const { data: row, error } = await supabase
    .from('deliverables')
    .select('id, status, storage_path')
    .eq('id', id)
    .maybeSingle();
  if (error || !row) return back({ bad: error?.message ?? 'That document is not visible to you.' });
  if (!row.storage_path) return back({ bad: 'That document has no file yet.' });
  if (row.status !== 'pending' && row.status !== 'failed' && row.status !== 'framed') {
    return back({ bad: 'That document is already being read, or is finished.' });
  }

  const started = await startReader(supabase, request, String(row.id), String(row.storage_path));
  return started.ok
    ? back({ ok: 'Started. The reader works out the frame first — it takes a few minutes.' })
    : back({ bad: started.error ?? 'Could not start the reader.' });
};
