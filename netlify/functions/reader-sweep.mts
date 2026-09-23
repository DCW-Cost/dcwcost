/**
 * The slow sweeper: nothing the reader touches may stay stuck.
 *
 * There is a document in Airtable that has said "Processing" since June,
 * because nothing ever checked. This checks, every 15 minutes:
 *
 *  1. DEAD RUNS. A run with no finished_at, older than any invocation can live
 *     (a background function is cut off at 15 minutes), belongs to an
 *     invocation that died without cleaning up. Its document is moved out of
 *     its in-progress state to `failed`, and the run is closed saying why.
 *
 *  2. NEVER STARTED. An uploaded document with its file, still `pending` long
 *     after upload, with no run at all, was never triggered — the trigger
 *     failed, or it predates the reader. It is marked `failed` with a run that
 *     says so, which puts "Read now" in front of a person.
 *
 * What it cannot do is re-run anything. Re-reading needs a signed URL, a
 * signed URL needs a person's session, and the reader has no storage access by
 * design. So the sweeper makes stuck work VISIBLE; a person restarts it.
 *
 * Scheduled functions get 30 seconds. One connection, bounded batches.
 */
import type { Config } from '@netlify/functions';
import { withDb } from '../../src/lib/reader/db.ts';
import { stamp, IN_PROGRESS } from '../../src/lib/reader/runlog.ts';
import { STALE_RUN_MINUTES, UNTRIGGERED_MINUTES } from '../../src/lib/reader/limits.ts';

export default async () => {
  const dbUrl = Netlify.env.get('READER_DATABASE_URL');
  if (!dbUrl) {
    console.error('[reader-sweep] READER_DATABASE_URL unset in this context');
    return;
  }

  const summary = await withDb(dbUrl, async (db) => {
    let deadRuns = 0;
    let failedDocs = 0;
    let untriggered = 0;

    const stale = await db.query(
      `select id, deliverable_id from ingest_runs
        where finished_at is null
          and started_at < now() - make_interval(mins => $1)
        order by started_at
        limit 50`,
      [STALE_RUN_MINUTES]
    );
    for (const run of stale.rows) {
      const id: string | null = run.deliverable_id;
      if (id) {
        const moved = await db.query(
          `update deliverables set status = 'failed' where id = $1 and status = any($2::ingest_status[])`,
          [id, [...IN_PROGRESS]]
        );
        failedDocs += moved.rowCount ?? 0;
      }
      await db.query(
        `update ingest_runs
            set finished_at = now(), docs_attempted = 1, docs_failed = 1,
                notes = coalesce(notes, '') || $2
          where id = $1 and finished_at is null`,
        [
          run.id,
          stamp(
            `FAILED: timed out — no finish recorded after ${STALE_RUN_MINUTES} min; the invocation died. ` +
              'Closed by the sweeper; use "Read now" to retry.'
          ),
        ]
      );
      deadRuns++;
    }

    const orphans = await db.query(
      `select d.id from deliverables d
        where d.source = 'upload' and d.status = 'pending' and d.storage_path is not null
          and d.uploaded_at < now() - make_interval(mins => $1)
          and not exists (select 1 from ingest_runs r where r.deliverable_id = d.id)
        order by d.uploaded_at
        limit 50`,
      [UNTRIGGERED_MINUTES]
    );
    for (const d of orphans.rows) {
      const moved = await db.query(`update deliverables set status = 'failed' where id = $1 and status = 'pending'`, [d.id]);
      if (!moved.rowCount) continue;
      await db.query(
        `insert into ingest_runs (deliverable_id, scope, finished_at, docs_attempted, docs_failed, notes)
         values ($1, 'incremental', now(), 0, 1, $2)`,
        [
          d.id,
          stamp(
              `FAILED: never started — pending with its file for over ${UNTRIGGERED_MINUTES} min and no run. ` +
                'The trigger did not fire or predates the reader. Marked by the sweeper; use "Read now".'
            ),
        ]
      );
      untriggered++;
    }
    return { deadRuns, failedDocs, untriggered };
  });

  console.log(
    `[reader-sweep] closed ${summary.deadRuns} dead runs (${summary.failedDocs} documents failed), ` +
      `${summary.untriggered} never-started documents flagged`
  );
};

export const config: Config = {
  schedule: '*/15 * * * *',
};
