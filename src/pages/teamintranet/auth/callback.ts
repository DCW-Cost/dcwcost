/**
 * Where Entra ID sends the browser back. Exchanges the code for a session,
 * then hands off to the middleware, which creates or reads the profile and
 * decides whether this person gets in, waits, or is turned away.
 */
import type { APIRoute } from 'astro';
import { serverClient, authConfigured } from '../../../lib/intranet/auth.ts';

export const prerender = false;

export const GET: APIRoute = async ({ cookies, request, url, redirect }) => {
  if (!authConfigured) return redirect('/teamintranet/signin', 302);

  const code = url.searchParams.get('code');
  const oauthError = url.searchParams.get('error_description') ?? url.searchParams.get('error');
  const next = url.searchParams.get('next') ?? '/teamintranet/';

  if (oauthError) {
    return redirect(`/teamintranet/signin?error=${encodeURIComponent(oauthError)}`, 302);
  }
  if (!code) {
    return redirect('/teamintranet/signin?error=missing_code', 302);
  }

  const supabase = serverClient(cookies, request)!;
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return redirect(`/teamintranet/signin?error=${encodeURIComponent(error.message)}`, 302);
  }

  // Only ever bounce to somewhere inside the intranet — never to an arbitrary
  // URL an attacker put in the query string.
  const safeNext = next.startsWith('/teamintranet') ? next : '/teamintranet/';
  return redirect(safeNext, 302);
};
