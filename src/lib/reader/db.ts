/**
 * The reader's database connection — as `cost_reader`, never the service role.
 *
 * Three rules this file exists to enforce:
 *
 *  1. VERIFY THE CERTIFICATE. The connection string's `sslmode` is stripped and
 *     replaced with an explicit `ssl: { ca }` built from Supabase's bundled CA,
 *     so what connects is checked rather than trusted. (Leaving `sslmode` in
 *     the string lets pg-connection-string build its own ssl config, which can
 *     override the one passed here.)
 *
 *  2. NO TRANSACTION ACROSS A MODEL CALL. `withDb` opens a connection, runs one
 *     short piece of work, and closes it. The role has a 60 s
 *     idle-in-transaction timeout, and the pooler is in transaction mode on
 *     6543, where an open transaction pins a server connection — so the shape
 *     is: read, close, call the model, then write. `inTransaction` exists for
 *     the final write only, where several rows must land together; it wraps
 *     local writes that take milliseconds, and nothing that waits on the
 *     network may be called inside it.
 *
 *  3. COUNT THE ROWS. Row-level security refuses a write by filtering, not by
 *     erroring, so an UPDATE that policy forbids "succeeds" with rowCount 0.
 *     Every write that must land goes through `mustTouch`.
 *
 * Parameterised queries use pg's unnamed prepared statements, which the pooler
 * handles in transaction mode; nothing here names a statement.
 */
import pg from 'pg';
import { supabaseCa } from './supabase-ca.ts';

export type Db = pg.Client;

/** Parse READER_DATABASE_URL into a client config, without ever echoing it. */
export function clientConfig(url: string, ca: string): pg.ClientConfig {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new Error('READER_DATABASE_URL is not a valid URL.');
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error('READER_DATABASE_URL is not a postgres:// URL.');
  if (!u.username.startsWith('cost_reader')) {
    // A different role here almost certainly means someone pasted the wrong
    // string — possibly one that bypasses every policy this reader relies on.
    throw new Error('READER_DATABASE_URL does not log in as cost_reader. Refusing to connect.');
  }
  for (const p of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat']) u.searchParams.delete(p);
  return {
    connectionString: u.toString(),
    ssl: { ca, rejectUnauthorized: true, servername: u.hostname },
    connectionTimeoutMillis: 15_000,
    // Client-side only. The server-side limits (statement_timeout 120 s,
    // idle_in_transaction_session_timeout 60 s) are set on the role by
    // migration 004; sending them again as startup parameters is something
    // the pooler is not guaranteed to pass through.
    query_timeout: 125_000,
    application_name: 'dcw-reader',
  };
}

export async function withDb<T>(url: string, work: (db: Db) => Promise<T>): Promise<T> {
  const db = new pg.Client(clientConfig(url, supabaseCa()));
  await db.connect();
  try {
    return await work(db);
  } finally {
    await db.end().catch(() => {});
  }
}

/** Several writes that must land together. Local writes only — never a model or HTTP call inside. */
export async function inTransaction<T>(db: Db, work: () => Promise<T>): Promise<T> {
  await db.query('begin');
  try {
    const out = await work();
    await db.query('commit');
    return out;
  } catch (err) {
    await db.query('rollback').catch(() => {});
    throw err;
  }
}

export class DeniedWrite extends Error {}

/** Run a write that must affect at least one row; zero rows means policy said no. */
export async function mustTouch(
  db: Db,
  what: string,
  sql: string,
  params: unknown[]
): Promise<pg.QueryResult> {
  const res = await db.query(sql, params);
  if (!res.rowCount) {
    throw new DeniedWrite(`${what}: 0 rows affected — refused by policy, or the row is not in the expected state.`);
  }
  return res;
}
