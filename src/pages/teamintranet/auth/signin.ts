/**
 * Starts the Microsoft sign-in. Redirects to Entra ID via Supabase, which
 * sends the browser back to /teamintranet/auth/callback with a code.
 */
import type { APIRoute } from 'astro';
import { serverClient, authConfigured, NEXT_COOKIE } from '../../../lib/intranet/auth.ts';

export const prerender = false;

export const GET: APIRoute = async ({ cookies, request, url, redirect }) => {
  if (!authConfigured) {
    return new Response(
      'Sign-in is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY — see docs/team-intranet/SETUP.md',
      { status: 503, headers: { 'Content-Type': 'text/plain' } },
    );
  }

  const next = url.searchParams.get('next') ?? '/teamintranet/';
  const supabase = serverClient(cookies, request)!;

  // Where to land after sign-in travels in a cookie, NOT in the callback's
  // query string. Supabase matches redirect URLs against its allowlist
  // including any query parameters, so a callback of
  // `/auth/callback?next=%2Fteamintranet%2F` does not match an allowlisted
  // `/auth/callback` — Supabase silently falls back to the project's Site URL
  // and the user lands on the wrong site entirely.
  //
  // Keeping the callback URL constant means exactly one allowlist entry per
  // environment, and nothing to keep in sync when the destination changes.
  //
  // sameSite 'lax' is required: the return leg from Microsoft is a top-level
  // navigation from another origin, and 'strict' would withhold the cookie.
  cookies.set(NEXT_COOKIE, next, {
    path: '/teamintranet',
    httpOnly: true,
    sameSite: 'lax',
    secure: url.protocol === 'https:',
    maxAge: 600,
  });

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'azure',
    options: {
      // Entra ID scopes. `email` is what the domain gate checks.
      scopes: 'openid profile email offline_access',
      redirectTo: `${url.origin}/teamintranet/auth/callback`,
    },
  });

  if (error || !data?.url) {
    return new Response(`Could not start sign-in: ${error?.message ?? 'no redirect URL'}`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  return redirect(data.url, 302);
};
