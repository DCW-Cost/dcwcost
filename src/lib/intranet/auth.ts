/**
 * Sign-in for /teamintranet.
 *
 * Identity comes from Entra ID (Microsoft 365) via Supabase Auth, because
 * everyone at DCW already has an M365 account and nobody wants another
 * password. Three gates stand between a stranger and cost data:
 *
 *   1. Entra ID must authenticate them at all.
 *   2. Their address must end @dcwcost.com — checked here, before a profile
 *      row is created, so an outside guest account in the tenant is refused.
 *   3. An admin must have approved them. New profiles land `pending` and see
 *      a holding page and nothing else.
 *
 * Bootstrap problem: the first admin cannot be approved by an existing admin.
 * Seed the `bootstrap_admins` table before the first sign-in — those addresses
 * come out active and admin, everyone else lands pending. That decision is
 * made in the database, never here.
 *
 * Demo mode: with no Supabase credentials configured the whole area falls back
 * to the fixture user so the UI is still workable. That is a development
 * convenience and it announces itself on every page — it must never be how
 * this runs anywhere reachable.
 */

import { createServerClient, type CookieOptions } from '@supabase/ssr';
import type { AstroCookies } from 'astro';
import type { Profile } from './data/types.ts';

/**
 * Astro exposes build-time values on import.meta.env; the deployed Netlify
 * function gets its configuration from process.env. Read both.
 */
function env(name: string): string | undefined {
  const fromProcess = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return fromProcess ?? (import.meta.env as Record<string, string | undefined>)[name];
}

export const SUPABASE_URL = env('SUPABASE_URL');
export const SUPABASE_ANON_KEY = env('SUPABASE_ANON_KEY');

/** True when real credentials are configured. */
export const authConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export const ALLOWED_DOMAIN = (env('INTRANET_EMAIL_DOMAIN') ?? 'dcwcost.com').toLowerCase();

// Bootstrap admins live in the `bootstrap_admins` table, applied by the
// on_auth_user_created trigger. Deliberately not an env var: the app must not
// be able to decide who is an admin, or a leaked build config becomes a
// privilege escalation.

export function emailAllowed(email: string | undefined | null): boolean {
  if (!email) return false;
  return email.toLowerCase().endsWith('@' + ALLOWED_DOMAIN);
}

/** Parse an incoming Cookie header into the shape @supabase/ssr expects. */
function parseCookieHeader(header: string | null): Array<{ name: string; value: string }> {
  if (!header) return [];
  return header
    .split(';')
    .map((part) => {
      const eq = part.indexOf('=');
      if (eq === -1) return null;
      return {
        name: part.slice(0, eq).trim(),
        value: decodeURIComponent(part.slice(eq + 1).trim()),
      };
    })
    .filter((c): c is { name: string; value: string } => c !== null && c.name !== '');
}

/**
 * Supabase client bound to this request's cookies, so the session survives
 * navigation. Returns null in demo mode.
 *
 * Reads via the request's Cookie header (Astro has no bulk cookie getter) and
 * writes through Astro's cookie API so Set-Cookie lands on the response.
 */
export function serverClient(cookies: AstroCookies, request: Request) {
  if (!authConfigured) return null;
  return createServerClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => parseCookieHeader(request.headers.get('cookie')),
      setAll: (toSet: Array<{ name: string; value: string; options: CookieOptions }>) => {
        for (const { name, value, options } of toSet) {
          cookies.set(name, value, {
            ...options,
            path: options?.path ?? '/',
            httpOnly: options?.httpOnly ?? true,
            sameSite: options?.sameSite ?? 'lax',
            secure: options?.secure ?? import.meta.env.PROD,
          });
        }
      },
    },
  });
}

/** The demo identity used when no credentials are configured. */
export const DEMO_USER: Profile = {
  id: 'demo-user',
  fullName: 'Demo user',
  email: 'demo@' + ALLOWED_DOMAIN,
  role: 'admin',
  status: 'active',
};

export type SessionState =
  | { kind: 'demo'; profile: Profile }
  | { kind: 'anonymous' }
  | { kind: 'wrong-domain'; email: string }
  | { kind: 'pending'; profile: Profile }
  | { kind: 'revoked'; profile: Profile }
  | { kind: 'active'; profile: Profile };

/**
 * Resolve who is asking. Called by the middleware on every intranet request.
 */
export async function resolveSession(
  cookies: AstroCookies,
  request: Request,
): Promise<SessionState> {
  if (!authConfigured) return { kind: 'demo', profile: DEMO_USER };

  const supabase = serverClient(cookies, request)!;
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { kind: 'anonymous' };

  const email = user.email ?? '';
  if (!emailAllowed(email)) {
    // Authenticated by Microsoft, but not a DCW address. Never create a row.
    await supabase.auth.signOut();
    return { kind: 'wrong-domain', email };
  }

  const { data: existing } = await supabase
    .from('profiles')
    .select('id, email, full_name, role, status')
    .eq('id', user.id)
    .maybeSingle();

  if (!existing) {
    // The profile row is created by the on_auth_user_created trigger in
    // schema.sql, not from here. The app has no INSERT access to `profiles` at
    // all, because any policy permissive enough to let it write its own row
    // would also let someone write themselves in as an active admin.
    //
    // So a missing row means one of: the trigger has not been installed, the
    // address failed the database's own domain gate, or this profile is
    // pending and RLS is hiding it. All of them mean "wait" — never "let in".
    const fullName =
      (user.user_metadata?.full_name as string | undefined) ??
      (user.user_metadata?.name as string | undefined) ??
      email.split('@')[0]!;

    return {
      kind: 'pending',
      profile: { id: user.id, email, fullName, role: 'viewer', status: 'pending' },
    };
  }

  const profile: Profile = {
    id: existing.id,
    email: existing.email,
    fullName: existing.full_name ?? existing.email,
    role: existing.role as Profile['role'],
    status: existing.status as Profile['status'],
  };

  if (profile.status === 'revoked') {
    await supabase.auth.signOut();
    return { kind: 'revoked', profile };
  }
  if (profile.status === 'pending') return { kind: 'pending', profile };
  return { kind: 'active', profile };
}

/**
 * Carries the post-sign-in destination across the round trip to Microsoft.
 *
 * It is a cookie rather than a query parameter on the callback URL because
 * Supabase matches redirect URLs against its allowlist including the query
 * string — so a varying callback URL either fails the match (and silently
 * redirects to the project's Site URL) or forces a wildcard entry that is
 * far broader than it needs to be.
 */
export const NEXT_COOKIE = 'dcw_intranet_next';

/** Where a signed-out visitor should be sent, preserving where they were going. */
export function signinUrl(returnTo?: string): string {
  const base = '/teamintranet/signin';
  return returnTo && returnTo.startsWith('/teamintranet')
    ? `${base}?next=${encodeURIComponent(returnTo)}`
    : base;
}
