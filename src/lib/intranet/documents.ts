/**
 * Getting historical cost plans into the library.
 *
 * Two routes in, and they solve different problems:
 *
 *   1. Drag-and-drop, here. For the handful of documents someone wants read
 *      right now — the awkward ones worth testing the reader against.
 *   2. Airtable bulk pull, later. The attachments already sit on Airtable
 *      records, so the backfill is a scripted job, not a person dragging 1,235
 *      files into a browser one at a time.
 *
 * Both land in the same place: a row in `deliverables` with status 'pending',
 * and the file itself in the private `deliverables` storage bucket. The reader
 * picks up pending rows separately — uploading does not block on extraction,
 * because reading a cost plan takes far longer than an HTTP request should.
 */
import type { AstroCookies } from 'astro';
import { serverClient, authConfigured } from './auth.ts';

export type IngestStatus =
  | 'pending'
  | 'downloading'
  | 'framing'
  | 'extracting'
  | 'reconciling'
  | 'needs_answer'
  | 'accepted'
  | 'failed'
  | 'skipped';

export interface UploadedDoc {
  id: string;
  originalFilename: string | null;
  status: IngestStatus;
  uploadedAt: string | null;
  uploadedByName: string | null;
  byteSize: number | null;
  issueDate: string | null;
  estimator: string | null;
  notes: string | null;
}

export const STATUS_LABEL: Record<IngestStatus, string> = {
  pending: 'Waiting to be read',
  downloading: 'Fetching',
  framing: 'Working out the conventions',
  extracting: 'Pulling line items',
  reconciling: 'Checking the totals',
  needs_answer: 'Needs an answer from you',
  accepted: 'In the library',
  failed: 'Could not read it',
  skipped: 'Skipped',
};

export const STATUS_TONE: Record<IngestStatus, 'green' | 'amber' | 'red' | 'excluded'> = {
  pending: 'excluded',
  downloading: 'amber',
  framing: 'amber',
  extracting: 'amber',
  reconciling: 'amber',
  needs_answer: 'amber',
  accepted: 'green',
  failed: 'red',
  skipped: 'excluded',
};

export const BUCKET = 'deliverables';
export const MAX_BYTES = 50 * 1024 * 1024;

export const ACCEPTED_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
];

export const ACCEPT_ATTR = '.pdf,.xlsx,.xls,.csv';

/** True once the reader has an API key and can actually extract anything. */
export const readerConfigured = Boolean(import.meta.env.ANTHROPIC_API_KEY);

/** True once uploads have somewhere to go. */
export const uploadsEnabled = authConfigured;

export function humanSize(bytes: number | null): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/**
 * Object key for an uploaded file.
 *
 * Deliberately NOT the original filename: two people uploading "Estimate.pdf"
 * must not collide, and a filename from a browser is untrusted input that can
 * carry path separators. The deliverable's own uuid is the key; the human name
 * is kept in a column where it is data rather than a path.
 */
function objectKey(deliverableId: string, filename: string): string {
  const dot = filename.lastIndexOf('.');
  const ext = dot > 0 ? filename.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : 'bin';
  return `${deliverableId}.${ext || 'bin'}`;
}

export async function listDocuments(
  cookies: AstroCookies,
  request: Request
): Promise<{ docs: UploadedDoc[]; error: string | null }> {
  const supabase = serverClient(cookies, request);
  if (!supabase) {
    return { docs: [], error: 'Uploading needs a database. Set SUPABASE_URL and SUPABASE_ANON_KEY.' };
  }

  const { data, error } = await supabase
    .from('deliverables')
    .select(
      'id, original_filename, status, uploaded_at, byte_size, issue_date, estimator, upload_notes'
    )
    .eq('source', 'upload')
    .order('uploaded_at', { ascending: false })
    .limit(200);

  if (error) {
    const missing = /column .* does not exist|schema cache/i.test(error.message);
    return {
      docs: [],
      error: missing
        ? 'The upload columns are not there yet — run migrations/001_wishlist_and_uploads.sql in Supabase.'
        : error.message,
    };
  }

  const docs: UploadedDoc[] = (data ?? []).map((r: Record<string, unknown>) => ({
    id: String(r.id),
    originalFilename: (r.original_filename as string) ?? null,
    status: (r.status as IngestStatus) ?? 'pending',
    uploadedAt: (r.uploaded_at as string) ?? null,
    uploadedByName: null,
    byteSize: (r.byte_size as number) ?? null,
    issueDate: (r.issue_date as string) ?? null,
    estimator: (r.estimator as string) ?? null,
    notes: (r.upload_notes as string) ?? null,
  }));

  return { docs, error: null };
}

/**
 * Store a file and register it for reading.
 *
 * The deliverable row is written FIRST so its id can name the object, and torn
 * down again if the upload fails. The alternative — upload, then insert — can
 * leave a file in the bucket that nothing references, which is the harder mess
 * to notice.
 */
export async function uploadDocument(
  cookies: AstroCookies,
  request: Request,
  input: {
    file: File;
    /** An existing project, or null when `newProjectName` names a new one. */
    projectId: string | null;
    newProjectName: string;
    estimator: string;
    issueDate: string;
    notes: string;
  }
): Promise<ActionResult> {
  const supabase = serverClient(cookies, request);
  if (!supabase) return { ok: false, error: 'No database configured.' };

  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return { ok: false, error: 'Not signed in.' };

  const { file } = input;
  if (!file || file.size === 0) return { ok: false, error: 'Pick a file first.' };
  if (file.size > MAX_BYTES) {
    return { ok: false, error: `That file is ${humanSize(file.size)}. The limit is 50 MB.` };
  }
  // Browsers report an empty or odd type often enough that extension is the
  // more reliable signal; the bucket enforces MIME type again server-side.
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!['pdf', 'xlsx', 'xls', 'csv'].includes(ext)) {
    return { ok: false, error: 'Cost plans only — PDF, Excel or CSV.' };
  }

  // A document must hang off a project. Until the Airtable sync runs there are
  // none, so let the uploader name one — they know what job this is.
  let projectId = input.projectId;
  if (!projectId) {
    const name = input.newProjectName.trim();
    if (!name) return { ok: false, error: 'Pick a project, or type a name for a new one.' };
    const { data: proj, error: projError } = await supabase
      .from('projects')
      .insert({ name: name.slice(0, 200), created_by: auth.user.id })
      .select('id')
      .single();
    if (projError || !proj) {
      return { ok: false, error: projError?.message ?? 'Could not create that project.' };
    }
    projectId = String(proj.id);
  }

  const { data: row, error: insertError } = await supabase
    .from('deliverables')
    .insert({
      source: 'upload',
      project_id: projectId,
      original_filename: file.name.slice(0, 260),
      byte_size: file.size,
      uploaded_by: auth.user.id,
      uploaded_at: new Date().toISOString(),
      estimator: input.estimator.trim() || null,
      issue_date: input.issueDate || null,
      upload_notes: input.notes.trim().slice(0, 2000) || null,
      source_format: ext === 'pdf' ? 'pdf' : ext === 'csv' ? 'csv' : 'xlsx',
      status: 'pending',
    })
    .select('id')
    .single();

  if (insertError || !row) {
    const needsProject = /project_id/.test(insertError?.message ?? '');
    return {
      ok: false,
      error: needsProject
        ? 'Every document needs a project to hang off. Pick one, or add the project first.'
        : (insertError?.message ?? 'Could not register the document.'),
    };
  }

  const key = objectKey(String(row.id), file.name);
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(key, file, { contentType: file.type || undefined, upsert: false });

  if (uploadError) {
    // Roll the row back so the list never shows a document whose file is absent.
    await supabase.from('deliverables').delete().eq('id', row.id);
    const noBucket = /bucket.*not found/i.test(uploadError.message);
    return {
      ok: false,
      error: noBucket
        ? 'The storage bucket does not exist yet — run migrations/001_wishlist_and_uploads.sql.'
        : uploadError.message,
    };
  }

  const { error: pathError } = await supabase
    .from('deliverables')
    .update({ storage_path: `${BUCKET}/${key}` })
    .eq('id', row.id);

  if (pathError) return { ok: false, error: pathError.message };
  return { ok: true };
}

/** Projects the uploader can attach a document to. */
export async function listProjects(
  cookies: AstroCookies,
  request: Request
): Promise<Array<{ id: string; name: string }>> {
  const supabase = serverClient(cookies, request);
  if (!supabase) return [];
  const { data } = await supabase.from('projects').select('id, name').order('name').limit(500);
  return (data ?? []).map((p: Record<string, unknown>) => ({
    id: String(p.id),
    name: String(p.name ?? 'Untitled'),
  }));
}
