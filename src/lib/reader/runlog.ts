/**
 * ingest_runs as the reader's log.
 *
 * One run per document per invocation, linked by ingest_runs.deliverable_id
 * (migration 005b). Every stage appends a timestamped line to the run's notes.
 * The sweeper finds a stuck document through that link: a run with no
 * finished_at, older than any invocation can live, names the document to fail.
 */
import type { Db } from './db.ts';

export const IN_PROGRESS = ['downloading', 'framing', 'extracting', 'reconciling'] as const;

export function stamp(line: string): string {
  return `${new Date().toISOString().slice(11, 19)}Z ${line.replace(/\s+/g, ' ').slice(0, 2000)}\n`;
}

export async function openRun(db: Db, deliverableId: string, triggeredBy: string | null, scope: string): Promise<string> {
  const res = await db.query(
    `insert into ingest_runs (deliverable_id, triggered_by, scope, notes) values ($1, $2, $3, $4) returning id`,
    [deliverableId, triggeredBy, scope, stamp('run opened — pass one')]
  );
  return String(res.rows[0].id);
}

export async function appendRun(db: Db, runId: string, lines: string[]): Promise<void> {
  if (lines.length === 0) return;
  await db.query(`update ingest_runs set notes = coalesce(notes, '') || $2 where id = $1`, [
    runId,
    lines.map(stamp).join(''),
  ]);
}

export async function closeRun(
  db: Db,
  runId: string,
  outcome: {
    attempted: number;
    succeeded: number;
    failed: number;
    inputTokens?: number;
    outputTokens?: number;
    estimatedCost?: number;
    line: string;
  }
): Promise<void> {
  await db.query(
    `update ingest_runs
        set finished_at = now(),
            docs_attempted = $2, docs_succeeded = $3, docs_failed = $4,
            input_tokens = $5, output_tokens = $6, estimated_cost = $7,
            notes = coalesce(notes, '') || $8
      where id = $1 and finished_at is null`,
    [
      runId,
      outcome.attempted,
      outcome.succeeded,
      outcome.failed,
      outcome.inputTokens ?? null,
      outcome.outputTokens ?? null,
      outcome.estimatedCost ?? null,
      stamp(outcome.line),
    ]
  );
}
