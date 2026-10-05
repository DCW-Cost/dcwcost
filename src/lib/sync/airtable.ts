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
  /** Called with each page's measurement when `measure` is set. */
  onMeasure?: (m: PageMeasurement) => void;
  /**
   * Report the wire size of each page and the spread of record sizes.
   *
   * MEASURED THROUGH THIS CLIENT, WHICH IS THE POINT. A task record was
   * observed at 21.8 MB through the Airtable MCP server, with one rollup
   * field at 16 million characters — but the MCP expands linked records,
   * and the real sync reads all 5,557 tasks in about thirty seconds, so
   * the per-record size on THIS path was never established.
   *
   * It matters because a run was observed using 821 MB of a 1,024 MB
   * limit, and whether Time Tracking's 29,119 records can be read at all
   * rests on a number nobody has measured. Extrapolating from the MCP
   * figure would be fitting a line through a unit from a different path.
   *
   * Off by default: it keeps the response body as a string alongside the
   * parsed objects for the duration of a page, which is the one thing a
   * memory investigation should not do unasked.
   */
  measure?: boolean;
}

/** What one page cost on the wire, and how unevenly it was distributed. */
export interface PageMeasurement {
  records: number;
  bytes: number;
  perRecordMin: number;
  perRecordMedian: number;
  perRecordMax: number;
  /** The biggest record in the page. An average hides a 20x outlier; this does not. */
  largestRecordId: string | null;
}

/**
 * Every record in a table, following Airtable's `offset` cursor.
 *
 * Fields are requested whole rather than named: a `fields[]` list of 60 names
 * makes a URL long enough to be rejected, and the map in tables.ts decides
 * what is kept anyway. The cost is bandwidth on lookup fields we discard.
 *
 * IF A RUN EVER DIES ON MEMORY, LOOK HERE FIRST. That cost is not uniform.
 * DCW Project Tasks carries rollups that fan out across linked records, and
 * one task — recXCLgbkVXQtgUlk, the non-billable bucket with 19,566 hours on
 * it — came back as 21.8 MB of JSON for a SINGLE record, one of its rollup
 * fields alone being 16 million characters. That was observed through the
 * Airtable MCP server rather than this client, and the real sync reads all
 * 5,557 tasks in about thirty seconds, so the REST API with cellFormat=json
 * evidently returns something far smaller. But the fan-out is a property of
 * the base, not of the client, so the ceiling is not known — and a page of
 * 100 records is held in memory at once.
 *
 * The fix, if it is ever needed, is `returnFieldsByFieldId` plus a chunked
 * `fields[]` list over several requests, not a smaller pageSize: the volume
 * is per record, not per page.
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
    if (page.measurement) opts.onMeasure?.(page.measurement);
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
  measurement?: PageMeasurement;
}

function measurePage(records: AirtableRecord[], bytes: number): PageMeasurement {
  const sizes = records.map((r) => JSON.stringify(r).length).sort((a, b) => a - b);
  let largestRecordId: string | null = null;
  let largest = -1;
  for (const r of records) {
    const n = JSON.stringify(r).length;
    if (n > largest) {
      largest = n;
      largestRecordId = r.id ?? null;
    }
  }
  return {
    records: records.length,
    bytes,
    perRecordMin: sizes[0] ?? 0,
    perRecordMedian: sizes[Math.floor(sizes.length / 2)] ?? 0,
    perRecordMax: sizes[sizes.length - 1] ?? 0,
    largestRecordId,
  };
}

async function request(url: URL, opts: ReadOptions): Promise<Page> {
  let lastError = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await opts.limiter.run(() =>
      fetch(url, { headers: { Authorization: `Bearer ${opts.apiKey}` } })
    );

    if (res.ok) {
      if (!opts.measure) return (await res.json()) as Page;
      // Only when asked: holding the body as text as well as parsed is
      // exactly the extra allocation a memory investigation must not add
      // to every run.
      const body = await res.text();
      const page = JSON.parse(body) as Page;
      page.measurement = measurePage(page.records ?? [], body.length);
      return page;
    }

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
