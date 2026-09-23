/**
 * Who may start the reader, and with what.
 *
 * The background function sits at a public URL, so its request is treated as
 * hostile until proven otherwise. Two checks, neither needing a new secret:
 *
 *  1. The caller holds a live session for an ACTIVE DCW user. The upload flow
 *     passes the uploader's own access token; it is verified against Supabase
 *     Auth, and is_active_user() is asked under that token. A stranger cannot
 *     spend the Anthropic budget by posting to the endpoint.
 *
 *  2. The signed URL points at THIS project's storage and at THIS document's
 *     object — nowhere else. Otherwise the endpoint would fetch any URL it was
 *     handed (server-side request forgery) and could frame one document from
 *     another's file.
 */
export interface TriggerBody {
  deliverableId: string;
  signedUrl: string;
  accessToken: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseTriggerBody(body: unknown): TriggerBody | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const deliverableId = typeof b.deliverableId === 'string' ? b.deliverableId.toLowerCase() : '';
  const signedUrl = typeof b.signedUrl === 'string' ? b.signedUrl : '';
  const accessToken = typeof b.accessToken === 'string' ? b.accessToken : '';
  if (!UUID.test(deliverableId) || !signedUrl || !accessToken) return null;
  return { deliverableId, signedUrl, accessToken };
}

/**
 * True only for `<SUPABASE_URL>/storage/v1/object/sign/<storage_path>?token=…`,
 * where storage_path is the row's own `deliverables/<key>`.
 */
export function signedUrlMatches(signedUrl: string, supabaseUrl: string, storagePath: string | null): boolean {
  if (!storagePath) return false;
  let u: URL;
  let base: URL;
  try {
    u = new URL(signedUrl);
    base = new URL(supabaseUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.origin !== base.origin) return false;
  if (u.username || u.password) return false;
  const expected = '/storage/v1/object/sign/' + storagePath.split('/').map(encodeURIComponent).join('/');
  return (u.pathname === expected || decodeURIComponent(u.pathname) === '/storage/v1/object/sign/' + storagePath) &&
    u.searchParams.has('token');
}
