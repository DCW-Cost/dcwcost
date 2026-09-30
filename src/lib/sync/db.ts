/**
 * The sync's database connection — as `airtable_sync`, never the service role.
 *
 * Deliberately the same shape as src/lib/reader/db.ts, including the refusal
 * to connect as anything else. That check is not ceremony: the service key
 * holds DELETE on every table and bypasses every policy, and "the sync wasn't
 * writing so I used the other connection string" is exactly how a role built
 * to make deletion impossible stops making it impossible.
 *
 * Migration 007 gives this role SELECT, INSERT and UPDATE on the mirror and
 * DELETE on nothing. Migration 008 makes `is_active` and
 * `missing_from_airtable_since` unwritable by it on all sixteen tables — those
 * belong to sweep_missing_from_airtable(), which refuses to run against a pass
 * that did not finish.
 */
import pg from 'pg';
import { supabaseCa } from '../reader/supabase-ca.ts';

export type Db = pg.Client;

export function clientConfig(url: string, ca: string): pg.ClientConfig {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new Error('AIRTABLE_SYNC_DATABASE_URL is not a valid URL.');
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) {
    throw new Error('AIRTABLE_SYNC_DATABASE_URL is not a postgres:// URL.');
  }
  if (!u.username.startsWith('airtable_sync')) {
    throw new Error('AIRTABLE_SYNC_DATABASE_URL does not log in as airtable_sync. Refusing to connect.');
  }
  for (const p of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat']) u.searchParams.delete(p);
  return {
    connectionString: u.toString(),
    ssl: { ca, rejectUnauthorized: true, servername: u.hostname },
    connectionTimeoutMillis: 15_000,
    // The server-side limits (statement_timeout 120 s,
    // idle_in_transaction_session_timeout 60 s) are set on the role by 007.
    query_timeout: 125_000,
    application_name: 'dcw-airtable-sync',
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

/**
 * A batch of upserts committed together.
 *
 * The pooler runs in transaction mode on 6543, where an open transaction pins
 * a server connection, and the role is cut off after 60 s idle in one — so
 * these wrap local writes only. Nothing that waits on Airtable may be called
 * inside.
 */
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

/**
 * How many rows a write touched, and whether that is a surprise.
 *
 * A grant refuses loudly; a POLICY refuses by filtering, so an upsert the
 * policy dislikes reports success and changes nothing. Every write here is
 * expected to affect exactly one row, and a zero is worth a line in
 * sync_anomalies rather than a shrug.
 */
export class BlockedWrite extends Error {}
