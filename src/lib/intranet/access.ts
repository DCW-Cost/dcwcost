/**
 * What an admin may change about somebody's access, decided before the
 * database is involved.
 *
 * Lives here rather than in profiles.ts for the same reason gate.ts lives apart
 * from middleware.ts: profiles.ts reaches Supabase through auth.ts, which pulls
 * in @supabase/ssr and Vite's `import.meta.env`, and that puts everything in
 * that file out of reach of a plain `node --test`. These are the rules a
 * mistake in would be most expensive, so they are the ones kept testable.
 */
import type { Profile } from './data/types.ts';

export type Role = Profile['role'];
export type Status = Profile['status'];

/** The only roles there are. Anything else is refused, never passed through. */
export const ROLES: readonly Role[] = ['admin', 'estimator', 'viewer'];

/** The only statuses there are. Mirrors the CHECK constraint in schema.sql. */
export const STATUSES: readonly Status[] = ['pending', 'active', 'revoked'];

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Admin',
  estimator: 'Estimator',
  viewer: 'Viewer',
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function isStatus(value: unknown): value is Status {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value);
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/** The columns a write is allowed to touch, as they arrive — unchecked. */
export interface ProfilePatch {
  role?: unknown;
  status?: unknown;
}

/**
 * Whether this admin may make this change to this person.
 *
 * Every refusal here is one the admin sees. That is the point: the database
 * refuses a write by changing nothing and reporting success, so anything that
 * can be caught before the round trip should be, with a sentence saying why.
 */
export function checkProfileWrite(
  actingId: string,
  targetId: string,
  patch: ProfilePatch,
): ActionResult {
  if (!actingId) return { ok: false, error: 'Not signed in.' };
  if (!targetId) return { ok: false, error: 'No person was named.' };

  // An admin revoking or demoting themselves is how an organisation ends up
  // with no admins and no way back in short of the SQL editor. Refused here
  // rather than by hiding the control, which enforces nothing.
  if (targetId === actingId) {
    return { ok: false, error: 'You cannot change your own access. Ask another admin.' };
  }

  if (patch.role !== undefined && !isRole(patch.role)) {
    return {
      ok: false,
      error: `${JSON.stringify(patch.role)} is not a role — pick admin, estimator or viewer.`,
    };
  }
  if (patch.status !== undefined && !isStatus(patch.status)) {
    return { ok: false, error: `${JSON.stringify(patch.status)} is not a status.` };
  }
  if (patch.role === undefined && patch.status === undefined) {
    return { ok: false, error: 'Nothing to change.' };
  }

  return { ok: true };
}
