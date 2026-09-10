/**
 * The seam.
 *
 * Pages import `provider` from here and nothing else. Today it resolves to
 * fixtures; when the Supabase project exists, `supabase.ts` implements the same
 * `DataProvider` interface and this file switches to it. No page changes.
 *
 * Set INTRANET_DATA=supabase (plus the Supabase env vars) to switch.
 */

import type { DataProvider } from './types.ts';
import { fixtureProvider } from './fixtures.ts';

const requested = import.meta.env?.INTRANET_DATA ?? 'fixtures';

function resolve(): DataProvider {
  if (requested === 'supabase') {
    // Deliberately not implemented yet. Failing loudly here is better than a
    // page silently rendering demo numbers while claiming to be live.
    throw new Error(
      'INTRANET_DATA=supabase but the Supabase provider is not implemented yet. ' +
        'See docs/team-intranet/PLAN.md §2 — this lands once the project and keys exist.',
    );
  }
  return fixtureProvider;
}

export const provider = resolve();

/** True while the UI is showing invented numbers. Drives the banner. */
export const usingFixtures = provider.name === 'fixtures';

export type * from './types.ts';
