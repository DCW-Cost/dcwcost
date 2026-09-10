/**
 * Starts the Microsoft sign-in. Redirects to Entra ID via Supabase, which
 * sends the browser back to /teamintranet/auth/callback with a code.
 */
import type { APIRoute } from 'astro';
import { serverClient, authConfigured } from '../../../lib/intranet/auth.ts';

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

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'azure',
    options: {
      // Entra ID scopes. `email` is what the domain gate checks.
      scopes: 'openid profile email offline_access',
      redirectTo: `${url.origin}/teamintranet/auth/callback?next=${encodeURIComponent(next)}`,
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
