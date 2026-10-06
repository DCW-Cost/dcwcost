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
 * IF A RUN EVER DIES ON MEMORY, LOOK HERE FIRST, and the numbers are now
 * measured through this client rather than guessed. One page of DCW Project
 * Tasks, 5 October 2026:
 *
 *   100 records, 6,004,287 bytes on the wire — 60,043 average per record
 *   min 5,095 · median 29,705 · max 288,462
 *
 * An earlier note here said a single task was 21.8 MB with a 16-million-
 * character rollup. THAT WAS AN ARTEFACT of the Airtable MCP server, which
 * expands linked records; on this client the largest record in the page is
 * 288 KB, seventy-five times smaller. The note is kept rather than deleted
 * because the figure circulated for a while and someone may remember it.
 *
 * The distribution is right-skewed — the mean is twice the median — but no
 * single record dominates: the largest is 4.8% of its page. Extrapolating
 * from an average is therefore sound here, which is not something to assume
 * of another table without measuring it the same way.
 *
 * EVERY RECORD IS HELD AT ONCE, which is the actual problem. 5,557 tasks is
 * about 334 MB of raw JSON before parsing, and a run was observed at 821 MB
 * of a 1,024 MB limit. Measured against a 100-record run at 174 MB, memory
 * runs at roughly 162 MB of baseline plus 118 KB per record — about twice
 * the wire size, which is what parsed objects plus a retained RowPlan cost.
 *
 * The fix is to stream: read a page, plan it, write it, discard it, keeping
 * only the key map and the join pairs, which are strings and stay under a
 * megabyte. Not a smaller pageSize — the volume is per record, not per page.
 */
export async function readTable(table: string, opts: ReadOptions): Promise<AirtableRecord[]> {
  const out: AirtableRecord[] = [];
  await streamTable(table, opts, (page) => {
    out.push(...page);
  });
  return out;
}

/**
 * The same read, handed to the caller a page at a time and never kept.
 *
 * This is the one that matters. `readTable` accumulates, which is why a
 * table was a memory ceiling: 5,557 tasks at ~60 KB each is 334 MB of raw
 * JSON before anything parses it, and a run was measured at 821 MB of a
 * 1,024 MB limit. Nothing needed the whole array — it was held because the
 * upsert did not return the uuid it had just written, so the ids had to be
 * looked up afterwards against the full list.
 *
 * The handler is awaited, so a caller can write a page before the next is
 * fetched and the page then falls out of scope. Memory becomes flat in the
 * size of the table rather than linear.
 */
export async function streamTable(
  table: string,
  opts: ReadOptions,
  onRecords: (page: AirtableRecord[], soFar: number) => Promise<void> | void
): Promise<number> {
  let total = 0;
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
    let records = page.records ?? [];
    offset = page.offset;

    // Trim before handing over, so a caller never sees more than it asked
    // for and never has to undo work it has already done.
    if (opts.maxRecords && total + records.length >= opts.maxRecords) {
      records = records.slice(0, opts.maxRecords - total);
      offset = undefined;
    }

    total += records.length;
    await onRecords(records, total);
    opts.onPage?.(total);
  } while (offset);

  return total;
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
