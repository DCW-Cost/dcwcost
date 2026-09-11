/**
 * Step one of an upload: register the document and hand back a signed URL.
 *
 * The file itself never passes through this server. Posting a multi-megabyte
 * cost plan as multipart form data to a serverless function hits a payload
 * limit and fails with a bare HTTP 400 — no error page, no log, nothing to
 * read. Even under the limit it is the wrong shape: the whole file crosses the
 * network twice and the function pays for the wait.
 *
 * Instead this endpoint takes only the metadata as JSON, creates the row, and
 * returns a short-lived signed URL the browser uploads to directly. The
 * function handles a few hundred bytes; Supabase handles the file.
 *
 * `storage_path` stays NULL until /documents/confirm says the upload landed, so
 * a row never claims to have a file it does not have.
 */
import type { APIRoute } from 'astro';
import { serverClient } from '../../../lib/intranet/auth.ts';
import { BUCKET, MAX_BYTES, humanSize } from '../../../lib/intranet/documents.ts';

export const prerender = false;

const ALLOWED_EXT = ['pdf', 'xlsx', 'xls', 'csv'] as const;

function bad(error: string, status = 400) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ cookies, request }) => {
  const supabase = serverClient(cookies, request);
  if (!supabase) return bad('No database configured.', 503);

  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return bad('Not signed in.', 401);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return bad('Could not read that request.');
  }

  const filename = String(body.filename ?? '').trim();
  const size = Number(body.size ?? 0);
  if (!filename) return bad('Pick a file first.');
  if (!Number.isFinite(size) || size <= 0) return bad('That file appears to be empty.');
  if (size > MAX_BYTES) {
    return bad(`That file is ${humanSize(size)}. The limit is ${humanSize(MAX_BYTES)}.`);
  }

  // Extension is the more reliable signal — browsers report an empty or odd
  // MIME type often enough. The bucket enforces MIME type again server-side.
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (!ALLOWED_EXT.includes(ext as (typeof ALLOWED_EXT)[number])) {
    return bad('Cost plans only — PDF, Excel or CSV.');
  }

  // A document hangs off a project, and `projects` is empty until the Airtable
  // sync runs, so the uploader may name one. They know what job this is.
  let projectId = String(body.projectId ?? '') || null;
  if (!projectId) {
    const name = String(body.newProjectName ?? '').trim();
    if (!name) return bad('Pick a project, or type a name for a new one.');
    const { data: proj, error: projError } = await supabase
      .from('projects')
      .insert({ name: name.slice(0, 200), created_by: auth.user.id })
      .select('id')
      .single();
    if (projError || !proj) return bad(projError?.message ?? 'Could not create that project.');
    projectId = String(proj.id);
  }

  const { data: row, error: insertError } = await supabase
    .from('deliverables')
    .insert({
      source: 'upload',
      project_id: projectId,
      original_filename: filename.slice(0, 260),
      byte_size: size,
      uploaded_by: auth.user.id,
      uploaded_at: new Date().toISOString(),
      estimator: String(body.estimator ?? '').trim() || null,
      issue_date: String(body.issueDate ?? '') || null,
      upload_notes: String(body.notes ?? '').trim().slice(0, 2000) || null,
      source_format: ext === 'pdf' ? 'pdf' : ext === 'csv' ? 'csv' : 'xlsx',
      status: 'pending',
    })
    .select('id')
    .single();

  if (insertError || !row) {
    return bad(insertError?.message ?? 'Could not register the document.');
  }

  // The object key is the deliverable's uuid, never the filename: two people
  // uploading "Estimate.pdf" must not collide, and a browser-supplied filename
  // is untrusted input that can carry path separators.
  const key = `${row.id}.${ext}`;

  const { data: signed, error: signError } = await supabase.storage
    .from(BUCKET)
    .createSignedUploadUrl(key);

  if (signError || !signed) {
    // No usable URL means no upload will follow. Drop the row rather than
    // leave a deliverable that can never have a file.
    await supabase.from('deliverables').delete().eq('id', row.id);
    const noBucket = /bucket.*not found/i.test(signError?.message ?? '');
    return bad(
      noBucket
        ? 'The storage bucket does not exist yet — run migrations/001_wishlist_and_uploads.sql.'
        : (signError?.message ?? 'Could not prepare the upload.')
    );
  }

  return new Response(
    JSON.stringify({
      deliverableId: row.id,
      signedUrl: signed.signedUrl,
      token: signed.token,
      path: signed.path,
    }),
    { headers: { 'content-type': 'application/json' } }
  );
};
