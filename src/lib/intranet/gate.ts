/**
 * The master switch for /teamintranet.
 *
 * Lives here rather than in middleware.ts so it can be tested directly —
 * middleware.ts imports `astro:middleware`, a virtual module only Astro's
 * build can resolve, which puts everything in that file out of reach of a
 * plain unit test.
 */

/**
 * Whether the switch is on.
 *
 * Deliberately forgiving. This value is typed by a person into a hosting
 * dashboard, where `True`, `TRUE` and a trailing space are all things that
 * happen — and a strict `=== 'true'` turns any of them into a site-wide 404
 * with no clue as to why. The switch is a boolean, so read it as one.
 *
 * Still fails CLOSED: anything not recognisably affirmative leaves the area
 * switched off, so a typo can never publish the intranet by accident.
 */
export function isEnabled(raw: string | undefined | null): boolean {
  if (!raw) return false;
  return ['true', '1', 'yes', 'on'].includes(raw.trim().toLowerCase());
}
