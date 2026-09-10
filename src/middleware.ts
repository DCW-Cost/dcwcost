/**
 * Route guard for /teamintranet.
 *
 * Every intranet request resolves a session before any page renders, so no
 * page has to remember to check. Marketing routes pass straight through and
 * stay static.
 *
 * This is defence in depth, not the only defence: row-level security in
 * Postgres is what actually protects the data. A bug here should mean an
 * empty page, not a leak.
 */

import { defineMiddleware } from 'astro:middleware';
import { resolveSession, signinUrl, type SessionState } from './lib/intranet/auth.ts';

/** Reachable without an approved profile. */
const PUBLIC_PATHS = [
  '/teamintranet/signin',
  '/teamintranet/pending',
  '/teamintranet/auth/',
];

const isIntranet = (p: string) => p === '/teamintranet' || p.startsWith('/teamintranet/');
const isPublic = (p: string) => PUBLIC_PATHS.some((allowed) => p.startsWith(allowed));

export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname;
  if (!isIntranet(path)) return next();

  // The whole area is switched off unless explicitly enabled, so that an
  // accidental merge cannot publish an internal tool onto the marketing site.
  const enabled =
    (typeof process !== 'undefined' ? process.env?.INTRANET_ENABLED : undefined) ??
    import.meta.env.INTRANET_ENABLED;
  if (enabled !== 'true') {
    return new Response('Not found', { status: 404 });
  }

  const session: SessionState = await resolveSession(context.cookies, context.request);
  context.locals.session = session;
  context.locals.profile = 'profile' in session ? session.profile : undefined;

  if (!isPublic(path)) {
    if (session.kind === 'anonymous' || session.kind === 'wrong-domain') {
      return context.redirect(signinUrl(path), 302);
    }
    if (session.kind === 'pending' || session.kind === 'revoked') {
      return context.redirect('/teamintranet/pending', 302);
    }
  }

  const response = await next();

  // Responses carrying a session must never be cached by a CDN — one person's
  // cookie served to another is the worst possible bug in here.
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return response;
});
