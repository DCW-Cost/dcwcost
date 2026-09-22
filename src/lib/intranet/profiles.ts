/**
 * Who can sign in, and as what.
 *
 * Approving somebody is an UPDATE of `profiles.status`, never an insert. There
 * is deliberately no INSERT policy on `profiles`: rows arrive only through the
 * on_auth_user_created trigger, because any policy permissive enough to let the
 * app write its own row would also let someone write themselves in as an active
 * admin. So a person signs in once, lands `pending`, and only then is there
 * anything on this page to approve.
 *
 * Like the wishlist, this talks to Supabase directly rather than through the
 * `DataProvider` seam in ./data. That seam is a read model and stays one —
 * writes have never gone through it. Every call below runs as the signed-in
 * person over their own cookie session, so `profiles_admin_write` in schema.sql
 * is what actually enforces "admins only"; the page hiding a button is a
 * courtesy on top of that.
 *
 * WHY EVERY WRITE COUNTS ITS ROWS
 *
 * Row-level security does not raise an error when it refuses a write. It
 * filters the rows out first, so an UPDATE that policy forbids comes back as
 * success with zero rows changed. Checking only `error` therefore reports a
 * denied write as a completed one — which is exactly how an upload once came
 * back "Stored" with no file behind it (see documents/confirm.ts and
 * migrations/003_deliverable_writes.sql). `.select()` makes the changed rows
 * come back, and zero of them is reported as the failure it is.
 */
import type { AstroCookies } from 'astro';
import { serverClient } from './auth.ts';
import { checkProfileWrite, isRole, isStatus, type ActionResult, type ProfilePatch } from './access.ts';

// Re-exported so a page wiring these controls has one door to knock on.
export { ROLES, ROLE_LABEL } from './access.ts';
export type { Role, Status, ActionResult } from './access.ts';

const DENIED =
  'The database refused that change, so nothing was written. Either the account ' +
  'you are signed in as is not an admin, or that person no longer has a profile row.';

/**
 * The one write path: check the rules, update, and insist a row actually moved.
 *
 * The update is narrowed by id alone. An admin acting on what the page showed
 * them should change that row or hear why not — never quietly miss because the
 * row's status had moved on since it was rendered.
 */
async function writeProfile(
  cookies: AstroCookies,
  request: Request,
  targetId: string,
  patch: ProfilePatch,
): Promise<ActionResult> {
  const supabase = serverClient(cookies, request);
  if (!supabase) return { ok: false, error: 'No database configured.' };

  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return { ok: false, error: 'Not signed in.' };

  // The acting id comes from the session, not the form, so "not yourself" is
  // decided by who is actually signed in.
  const checked = checkProfileWrite(auth.user.id, targetId, patch);
  if (!checked.ok) return checked;

  // Rebuilt from the checked values rather than forwarded, so nothing the
  // caller put in the patch can reach the update unread.
  const columns: Record<string, string> = {};
  if (isRole(patch.role)) columns.role = patch.role;
  if (isStatus(patch.status)) columns.status = patch.status;

  const { data, error } = await supabase
    .from('profiles')
    .update(columns)
    .eq('id', targetId)
    .select('id');

  if (error) return { ok: false, error: error.message };
  // Zero rows is the silent denial described at the top of this file. Never
  // report it as a change that happened.
  if (!data || data.length === 0) return { ok: false, error: DENIED };

  return { ok: true };
}

/**
 * Let somebody in, at the role the admin picked.
 *
 * Status and role move in one statement: an approval that set the status and
 * then failed to set the role would leave a new person active as a viewer with
 * nobody aware of it.
 */
export function approveProfile(
  cookies: AstroCookies,
  request: Request,
  input: { id: string; role: unknown },
): Promise<ActionResult> {
  return writeProfile(cookies, request, input.id, { status: 'active', role: input.role });
}

/** Turn down a request to join. No row is removed — the trigger owns those. */
export function declineProfile(
  cookies: AstroCookies,
  request: Request,
  id: string,
): Promise<ActionResult> {
  return writeProfile(cookies, request, id, { status: 'revoked' });
}

/**
 * Take an active person's access away. `resolveSession` signs a revoked profile
 * out on its next request, so this ends the session too, not just the listing.
 */
export function revokeProfile(
  cookies: AstroCookies,
  request: Request,
  id: string,
): Promise<ActionResult> {
  return writeProfile(cookies, request, id, { status: 'revoked' });
}

/** Change what somebody can do, leaving their status alone. */
export function setRole(
  cookies: AstroCookies,
  request: Request,
  input: { id: string; role: unknown },
): Promise<ActionResult> {
  return writeProfile(cookies, request, input.id, { role: input.role });
}
