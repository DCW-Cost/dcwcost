/**
 * The seam.
 *
 * Pages get their data from here and nothing else, so swapping the source is a
 * configuration change rather than an edit to every screen.
 *
 * Set INTRANET_DATA=supabase (plus the Supabase env vars) to read real data.
 * Anything else serves fixtures.
 *
 * ---------------------------------------------------------------------------
 * Two exports, and which one to use
 *
 *   getProvider(cookies, request)   ← use this
 *   provider                        ← fixtures only, kept so existing pages
 *                                     keep working during the migration
 *
 * The original plan was that no page would change when the real provider
 * landed. That turned out not to survive contact with the security model.
 * Fixtures have no owner, so a module-level constant is fine; real data does,
 * and every query has to run as the signed-in person or row-level security has
 * nothing to check against. PLAN.md §9 is explicit:
 *
 *   "RLS deny-by-default on every table. Policy lives in the database. The
 *    service-role key never reaches the browser."
 *
 * The alternative would be a module-level client holding a service-role key,
 * which bypasses every policy in the database and moves enforcement into
 * whatever the calling code remembers to check. That is the one thing this repo
 * says not to do, in four separate documents.
 *
 * So a page that needs real data asks for a provider bound to its own request:
 *
 *   const provider = getProvider(Astro.cookies, Astro.request);
 *
 * One line, and nothing downstream can forget who is asking. Pages still using
 * the `provider` constant keep working on fixtures until they are migrated;
 * with INTRANET_DATA=supabase they throw rather than quietly serving demo data.
 * ---------------------------------------------------------------------------
 */

import type { AstroCookies } from 'astro';
import type { DataProvider } from './types.ts';
import { fixtureProvider } from './fixtures.ts';
import { createSupabaseProvider } from './supabase.ts';

const requested = import.meta.env?.INTRANET_DATA ?? 'fixtures';

/** True when this deployment is configured to read real cost data. */
export const usingSupabase = requested === 'supabase';

/**
 * The provider for this request. Falls back to fixtures when that is what the
 * deployment is configured for, so the signature is the same either way.
 */
export function getProvider(cookies: AstroCookies, request: Request): DataProvider {
  return usingSupabase ? createSupabaseProvider(cookies, request) : fixtureProvider;
}

/**
 * Request-free provider, for pages not yet migrated.
 *
 * Deliberately throws under INTRANET_DATA=supabase: a page reaching for this
 * while the deployment claims to be live would render invented numbers with no
 * indication anything was wrong, which is worse than an error nobody can miss.
 *
 * The throw happens when the provider is *used*, not when this module loads.
 * Throwing at import time would take getProvider down with it, since every
 * migrated page imports from this same module.
 */
function resolveStatic(): DataProvider {
  if (!usingSupabase) return fixtureProvider;

  return new Proxy({} as DataProvider, {
    get(_target, prop) {
      // Promise resolution and runtime introspection probe these; answering
      // "not here" keeps an accidental `await provider` from masking the error.
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      throw new Error(
        'INTRANET_DATA=supabase, but this page used the request-free `provider`. ' +
          'Real data runs as the signed-in person so row-level security applies — ' +
          'use getProvider(Astro.cookies, Astro.request) instead. See PLAN.md §9.',
      );
    },
  });
}

export const provider = resolveStatic();

/** True while the UI is showing invented numbers. Drives the banner. */
export const usingFixtures = !usingSupabase;

export type * from './types.ts';
