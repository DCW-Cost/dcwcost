/**
 * Kept apart from src/lib/intranet/documents.ts on purpose: that module reads
 * Astro's import.meta.env and pulls in the session client, neither of which
 * exists inside a Netlify function. Same value as the upload limit there.
 */
export const MAX_BYTES = 50 * 1024 * 1024;

/**
 * Wall-clock budget for one pass-one invocation. Background functions are cut
 * off at 15 minutes; stopping at 13 leaves time to record the failure, so a
 * slow document ends `failed` with a reason instead of stuck in `framing`.
 */
export const PASS_ONE_BUDGET_MS = 13 * 60_000;

/** How old an unfinished run must be before the sweeper calls it dead. */
export const STALE_RUN_MINUTES = 20;

/** How long an uploaded document may sit `pending` with no run before the sweeper flags it. */
export const UNTRIGGERED_MINUTES = 30;
