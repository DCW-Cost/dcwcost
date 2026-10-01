/**
 * Reading a table out of Airtable, one page at a time.
 *
 * No SDK. `fetch` against the REST API is the whole of it, and adding a
 * dependency for two endpoints would also put one in front of the tests, which
 * are deliberately dependency-free in this repo.
 *
 * Airtable allows 5 requests per second per base and returns at most 100
 * records a page. Phase one is about 9,630 records — roughly 100 requests, so
 * twenty seconds of paging. That is comfortable inside a background function's
 * fifteen minutes and impossible inside a scheduled function's thirty seconds,
 * which is why this runs where it does.
 */

const API = 'https://api.airtable.com/v0';

/** 5 req/sec per base. 210ms leaves headroom for clock drift and retries. */
const MIN_GAP_MS = 210;

/** A 429 without a Retry-After header still has to wait for something. */
const DEFAULT_BACKOFF_MS = 2_000;
const MAX_ATTEMPTS = 4;

export interface AirtableRecord {
  id: string;
  createdTime?: string;
  fields: Record<string, unknown>;
}

export class AirtableError extends Error {
  readonly status?: number;
  // Written out rather than declared as a constructor parameter property:
  // Node's --experimental-strip-types removes types without transforming, and
  // a parameter property is a transform. Netlify's bundler copes, so this
  // would only have failed where the tests run — which is the worse place for
  // it to fail, because that is where it would not be noticed.
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One request at a time, spaced. Shared across every table in a run, because
 * the limit is per base rather than per table — a per-table limiter would run
 * six of them in parallel and be six times over.
 */
export class RateLimiter {
  private last = 0;
  private chain: Promise<void> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(async () => {
      const wait = this.last + MIN_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      return work();
    });
    // Keep the chain alive even when a call rejects, or one failure would
    // poison every later request on this limiter.
    this.chain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

export interface ReadOptions {
  apiKey: string;
  baseId: string;
  limiter: RateLimiter;
  /** Stop paging once this many records have been read. Dry runs use it to sample. */
  maxRecords?: number;
  /** Called after each page, for progress that outlives a crash. */
  onPage?: (soFar: number) => void;
}

/**
 * Every record in a table, following Airtable's `offset` cursor.
 *
 * Fields are requested whole rather than named: a `fields[]` list of 60 names
 * makes a URL long enough to be rejected, and the map in tables.ts decides
 * what is kept anyway. The cost is bandwidth on lookup fields we discard.
 */
export async function readTable(table: string, opts: ReadOptions): Promise<AirtableRecord[]> {
  const out: AirtableRecord[] = [];
  let offset: string | undefined;

  do {
    const url = new URL(`${API}/${opts.baseId}/${encodeURIComponent(table)}`);
    url.searchParams.set('pageSize', '100');
    // Cell format 'json' with a timezone/locale is what returns select values
    // as plain strings rather than as the display text of the user's locale.
    url.searchParams.set('cellFormat', 'json');
    url.searchParams.set('timeZone', 'America/Los_Angeles');
    url.searchParams.set('userLocale', 'en-us');
    if (offset) url.searchParams.set('offset', offset);

    const page = await request(url, opts);
    for (const r of page.records ?? []) out.push(r);
    offset = page.offset;
    opts.onPage?.(out.length);

    if (opts.maxRecords && out.length >= opts.maxRecords) return out.slice(0, opts.maxRecords);
  } while (offset);

  return out;
}

interface Page {
  records?: AirtableRecord[];
  offset?: string;
}

async function request(url: URL, opts: ReadOptions): Promise<Page> {
  let lastError = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await opts.limiter.run(() =>
      fetch(url, { headers: { Authorization: `Bearer ${opts.apiKey}` } })
    );

    if (res.ok) return (await res.json()) as Page;

    // Airtable's own backpressure. Honour the header it sends rather than
    // guessing, and never retry blindly — a tight retry loop against a 429 is
    // how a rate limit becomes a ban.
    if (res.status === 429) {
      const header = res.headers.get('retry-after');
      const waitMs = header ? Math.max(0, Number(header) * 1000) : DEFAULT_BACKOFF_MS * attempt;
      lastError = `429 rate limited (waited ${waitMs}ms)`;
      await sleep(Number.isFinite(waitMs) ? waitMs : DEFAULT_BACKOFF_MS);
      continue;
    }

    if (res.status >= 500) {
      lastError = `${res.status} from Airtable`;
      await sleep(DEFAULT_BACKOFF_MS * attempt);
      continue;
    }

    // 401, 403, 404, 422 — retrying will not help, and the message matters.
    const body = await res.text().catch(() => '');
    throw new AirtableError(
      `Airtable ${res.status} for ${url.pathname}: ${body.slice(0, 300)}`,
      res.status
    );
  }

  throw new AirtableError(`Airtable gave up after ${MAX_ATTEMPTS} attempts: ${lastError}`);
}
