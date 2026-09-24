/**
 * Pass one, end to end, for ONE document.
 *
 * One document per invocation, deliberately: a background function has 15
 * minutes of wall clock, a 15 MB workbook takes seconds to parse but the
 * framing conversation can take several minutes, and a batch would let one
 * slow document starve the rest. Each upload, and each "Read now", starts its
 * own invocation.
 *
 * The shape, and why:
 *
 *   open run → claim → download → parse → read context → [model] → write
 *
 * Every database step opens a connection, does its work, and closes it. The
 * model call in the middle happens with no connection held. The final write is
 * the one transaction — frame, questions, type and status land together or not
 * at all — and it contains nothing but local writes (see db.ts).
 *
 * The run is opened BEFORE the claim so that any document this code moves into
 * an in-progress state has an open run pointing at it; that is how the sweeper
 * finds it if this invocation dies without cleaning up.
 *
 * On success the document is `framed`: understood, not yet extracted. Pass two
 * does not exist yet, so that is where it waits.
 */
import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { withDb, inTransaction, mustTouch, DeniedWrite, type Db } from './db.ts';
import { openRun, appendRun, closeRun, IN_PROGRESS } from './runlog.ts';
import { parseWorkbook } from './workbook.ts';
import { runFramePass, estimateCost, READER_VERSION, type DocContext, type Frame } from './frame.ts';
import { MAX_BYTES } from './limits.ts';
import { planQuestions, PASS_ONE_KINDS } from './questions.ts';

export interface PassOneInput {
  dbUrl: string;
  anthropicKey: string;
  deliverableId: string;
  /** Short-lived signed download URL, already checked against storage_path by the caller. */
  signedUrl: string;
  triggeredBy: string | null;
  /** Wall-clock budget for this invocation, in ms. */
  budgetMs: number;
}

export type PassOneOutcome =
  | { kind: 'framed'; runId: string; questions: number }
  | { kind: 'not_claimed'; runId: string; status: string | null }
  | { kind: 'failed'; runId: string | null; reason: string };

/** States a document may be claimed from. `framed` because "Read now" re-frames it. */
export const CLAIMABLE = ['pending', 'failed', 'framed'] as const;

/** Anything that might echo a URL with a token in it is scrubbed before it is logged. */
export function scrub(message: string, secrets: string[]): string {
  let out = message;
  for (const s of secrets) if (s && s.length > 8) out = out.split(s).join('[redacted]');
  return out.replace(/token=[^&\s"]+/gi, 'token=[redacted]').slice(0, 1500);
}

export async function runPassOne(input: PassOneInput): Promise<PassOneOutcome> {
  const { dbUrl, deliverableId } = input;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.budgetMs);
  const secrets = [input.signedUrl, new URL(input.signedUrl).search];
  let runId: string | null = null;

  const log = async (lines: string[]) => {
    if (runId) await withDb(dbUrl, (db) => appendRun(db, runId!, lines));
  };

  try {
    // ---- open run, then claim ------------------------------------------------
    runId = await withDb(dbUrl, (db) => openRun(db, deliverableId, input.triggeredBy, 'incremental'));

    const claimed = await withDb(dbUrl, async (db) => {
      // A second trigger for a document already in flight gets 0 rows here and
      // stops, rather than running the same document twice.
      const res = await db.query(
        `update deliverables set status = 'downloading'
          where id = $1 and status = any($2::ingest_status[]) and storage_path is not null
          returning source_format`,
        [deliverableId, [...CLAIMABLE]]
      );
      if (res.rowCount) return { ok: true as const, format: String(res.rows[0].source_format ?? '') };
      const cur = await db.query(`select status from deliverables where id = $1`, [deliverableId]);
      return { ok: false as const, status: cur.rows[0]?.status ?? null };
    });

    if (!claimed.ok) {
      await withDb(dbUrl, (db) =>
        closeRun(db, runId!, {
          attempted: 0,
          succeeded: 0,
          failed: 0,
          line: `not claimed — status is ${claimed.status ?? 'missing'}; another run has it, or it is not waiting`,
        })
      );
      return { kind: 'not_claimed', runId, status: claimed.status };
    }

    if (claimed.format === 'pdf') {
      throw new Error('PDF framing is not built yet — pass one reads Excel and CSV only');
    }

    // ---- download ------------------------------------------------------------
    await log(['downloading via signed URL']);
    const res = await fetch(input.signedUrl, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]) });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status} (the signed URL may have expired)`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_BYTES) throw new Error(`file is ${declared} bytes, over the ${MAX_BYTES} limit`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_BYTES) throw new Error(`file is ${bytes.byteLength} bytes, over the limit`);
    const checksum = createHash('sha256').update(bytes).digest('hex');

    await withDb(dbUrl, async (db) => {
      await mustTouch(
        db,
        'move to framing',
        `update deliverables set status = 'framing', file_checksum = $2 where id = $1 and status = 'downloading'`,
        [deliverableId, checksum]
      );
      await appendRun(db, runId!, [`downloaded ${bytes.byteLength} bytes, sha256 ${checksum.slice(0, 16)}…; framing`]);
    });

    // ---- parse -----------------------------------------------------------------
    const t0 = Date.now();
    const wb = parseWorkbook(bytes);
    await log([
      `parsed in ${Date.now() - t0} ms: ${wb.sheets.length} sheets, ${wb.cellCount} cells, ${wb.formulaCount} formulas`,
    ]);

    // ---- context ---------------------------------------------------------------
    const ctx = await withDb(dbUrl, (db) => readContext(db, deliverableId));

    // ---- the model — no connection held ----------------------------------------
    const client = new Anthropic({ apiKey: input.anthropicKey, maxRetries: 3, timeout: 8 * 60_000 });
    const pending: string[] = [];
    const result = await runFramePass(client, wb, ctx, controller.signal, (l) => pending.push(l));

    // ---- write: one short transaction, local writes only ------------------------
    const f = result.frame;
    const cost = estimateCost(result.usage);
    const written = await withDb(dbUrl, (db) =>
      inTransaction(db, async () => {
        const frameId = await writeFrame(db, deliverableId, f, result.model);
        const filed = await fileQuestions(db, deliverableId, frameId, f);
        const open = await db.query(
          `select count(*)::int as n from reader_questions
            where deliverable_id = $1 and mode = 'assumption' and state = 'open'`,
          [deliverableId]
        );
        const hasOpen = open.rows[0].n > 0;
        await db.query(`update document_frames set has_open_assumption = $2 where id = $1`, [frameId, hasOpen]);
        await mustTouch(
          db,
          'mark framed',
          `update deliverables
              set status = 'framed',
                  type = $2::deliverable_type,
                  stated_total_cost = coalesce($3, stated_total_cost)
            where id = $1 and status = 'framing'`,
          [deliverableId, f.deliverable_type, f.stated_total_cost]
        );
        return { filed, hasOpen };
      })
    );

    await withDb(dbUrl, async (db) => {
      await appendRun(db, runId!, [
        ...pending,
        `frame: coding ${f.coding_system} (${f.coding_confidence}); gsf ${f.gsf_used ?? '—'} from ${f.gsf_source ?? '—'} (${f.gsf_confidence}); ` +
          `basis ${f.basis}, factor ${f.markup_factor ?? '—'} [${f.notes.factor_note}] (${f.markup_confidence}); ` +
          `base date ${f.pricing_base_date ?? '—'} ${f.base_date_source ?? ''} (${f.base_date_confidence}); ` +
          `stated total ${f.stated_total_cost ?? '—'} at ${f.notes.stated_total_cell ?? '—'} (${f.stated_total_confidence}); ` +
          `type ${f.deliverable_type} (was ${ctx.recordedType}; ${f.deliverable_type_confidence})`,
        `questions: ${written.filed.filed} filed, ${written.filed.kept} still stand, ${written.filed.withdrawn} withdrawn; ` +
          `open assumptions ${written.hasOpen ? 'yes' : 'none'}`,
        `${READER_VERSION}, model ${result.model}, ${result.toolCalls} tool calls; tokens in ${result.usage.input} + cache read ` +
          `${result.usage.cacheRead} + cache write ${result.usage.cacheWrite}, out ${result.usage.output}; est. $${cost}`,
      ]);
      await closeRun(db, runId!, {
        attempted: 1,
        succeeded: 1,
        failed: 0,
        inputTokens: result.usage.input + result.usage.cacheRead + result.usage.cacheWrite,
        outputTokens: result.usage.output,
        estimatedCost: cost,
        line: 'pass one complete — framed, waiting for extraction',
      });
    });
    return { kind: 'framed', runId, questions: written.filed.filed };
  } catch (err) {
    const reason = scrub(
      controller.signal.aborted
        ? `timed out after ${Math.round(input.budgetMs / 1000)} s`
        : err instanceof DeniedWrite
          ? err.message
          : err instanceof Error
            ? `${err.name}: ${err.message}`
            : String(err),
      secrets
    );
    await failDocument(dbUrl, deliverableId, runId, reason);
    return { kind: 'failed', runId, reason };
  } finally {
    clearTimeout(timer);
  }
}

/** Move the document out of any in-progress state and close its run. Never throws. */
async function failDocument(dbUrl: string, deliverableId: string, runId: string | null, reason: string) {
  try {
    await withDb(dbUrl, async (db) => {
      await db.query(`update deliverables set status = 'failed' where id = $1 and status = any($2::ingest_status[])`, [
        deliverableId,
        [...IN_PROGRESS],
      ]);
      if (runId) await closeRun(db, runId, { attempted: 1, succeeded: 0, failed: 1, line: `FAILED: ${reason}` });
    });
  } catch (cleanup) {
    // The sweeper is the backstop: an open run past its age is failed for us.
    console.error(`[reader] could not record failure for ${deliverableId}:`, cleanup instanceof Error ? cleanup.message : cleanup);
  }
}

async function readContext(db: Db, deliverableId: string): Promise<DocContext> {
  const d = await db.query(
    `select d.id, d.original_filename, d.type, d.phase, d.issue_date::text as issue_date, d.estimator, d.upload_notes,
            p.name, p.client_name, p.sector, p.region, p.city, p.gross_sf, p.delivery_method,
            p.airtable_record_id is not null as from_airtable
       from deliverables d join projects p on p.id = d.project_id
      where d.id = $1`,
    [deliverableId]
  );
  const r = d.rows[0];
  if (!r) throw new Error('deliverable or its project is not readable');

  // Conventions are narrow on purpose (PLAN §6.5): a rule scoped to one
  // estimator, client or date range applies only there. Template-scoped rules
  // need a template fingerprint, which pass one does not compute yet, so they
  // are not offered.
  const c = await db.query(
    `select id, kind, rule, rationale, scope_estimator, scope_client,
            scope_from::text as scope_from, scope_to::text as scope_to
       from reader_conventions
      where active and superseded_by is null and scope_template is null
        and (scope_estimator is null or lower(scope_estimator) = lower($1))
        and (scope_client is null or lower(scope_client) = lower($2))
        and (scope_from is null or ($3::date is not null and $3::date >= scope_from))
        and (scope_to is null or ($3::date is not null and $3::date <= scope_to))
      order by id
      limit 50`,
    [r.estimator ?? '', r.client_name ?? '', r.issue_date]
  );

  // What has already been asked about this document, and answered. A re-read
  // follows the answers instead of asking again.
  const q = await db.query(
    `select id, kind, mode, state, prompt, proposed_answer, answer, answer_note
       from reader_questions
      where deliverable_id = $1 and state <> 'withdrawn'
      order by id
      limit 100`,
    [deliverableId]
  );

  return {
    deliverableId,
    filename: r.original_filename,
    recordedType: r.type,
    recordedPhase: r.phase,
    issueDate: r.issue_date,
    estimator: r.estimator,
    uploadNotes: r.upload_notes,
    project: {
      name: r.name,
      clientName: r.client_name,
      sector: r.sector,
      region: r.region,
      city: r.city,
      grossSf: r.gross_sf === null ? null : Number(r.gross_sf),
      deliveryMethod: r.delivery_method,
      fromAirtable: Boolean(r.from_airtable),
    },
    conventions: c.rows.map((row) => ({
      id: Number(row.id),
      kind: row.kind,
      rule: row.rule,
      rationale: row.rationale,
      scope:
        [
          row.scope_estimator && `estimator ${row.scope_estimator}`,
          row.scope_client && `client ${row.scope_client}`,
          (row.scope_from || row.scope_to) && `dates ${row.scope_from ?? '…'} to ${row.scope_to ?? '…'}`,
        ]
          .filter(Boolean)
          .join(', ') || 'all documents',
    })),
    priorQuestions: q.rows.map((row) => ({
      id: Number(row.id),
      kind: row.kind,
      mode: row.mode,
      state: row.state,
      prompt: row.prompt,
      proposedAnswer: row.proposed_answer,
      answer: row.answer,
      answerNote: row.answer_note,
    })),
  };
}

/**
 * One frame per document (document_frames.deliverable_id is unique): a re-read
 * replaces the frame rather than accumulating them. `created_at` is left as
 * first written; the run log records when it was replaced.
 */
async function writeFrame(db: Db, deliverableId: string, f: Frame, model: string): Promise<string> {
  const res = await mustTouch(
    db,
    'write frame',
    `insert into document_frames (
        deliverable_id,
        coding_system, coding_confidence, coding_evidence,
        gsf_used, gsf_source, gsf_confidence, gsf_evidence,
        basis, markup_factor, markup_components, markup_confidence, markup_evidence,
        pricing_base_date, base_date_source, base_date_confidence, base_date_evidence,
        stated_total_confidence, stated_total_evidence,
        deliverable_type_confidence, deliverable_type_evidence,
        reader_version, framing_model, conventions_applied, has_open_assumption)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13,
             $14::date, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24::bigint[], false)
     on conflict (deliverable_id) do update set
        coding_system = excluded.coding_system, coding_confidence = excluded.coding_confidence,
        coding_evidence = excluded.coding_evidence,
        gsf_used = excluded.gsf_used, gsf_source = excluded.gsf_source,
        gsf_confidence = excluded.gsf_confidence, gsf_evidence = excluded.gsf_evidence,
        basis = excluded.basis, markup_factor = excluded.markup_factor,
        markup_components = excluded.markup_components, markup_confidence = excluded.markup_confidence,
        markup_evidence = excluded.markup_evidence,
        pricing_base_date = excluded.pricing_base_date, base_date_source = excluded.base_date_source,
        base_date_confidence = excluded.base_date_confidence, base_date_evidence = excluded.base_date_evidence,
        stated_total_confidence = excluded.stated_total_confidence,
        stated_total_evidence = excluded.stated_total_evidence,
        deliverable_type_confidence = excluded.deliverable_type_confidence,
        deliverable_type_evidence = excluded.deliverable_type_evidence,
        reader_version = excluded.reader_version, framing_model = excluded.framing_model,
        conventions_applied = excluded.conventions_applied,
        -- A re-frame invalidates the old reconciliation; pass three recomputes it.
        extracted_total = null, reconciles = null, reconciliation_delta_pct = null, reconciliation_note = null
     returning id`,
    [
      deliverableId,
      f.coding_system,
      f.coding_confidence,
      f.coding_evidence,
      f.gsf_used,
      f.gsf_source,
      f.gsf_confidence,
      f.gsf_evidence,
      f.basis,
      f.markup_factor,
      JSON.stringify(f.markup_components),
      f.markup_confidence,
      f.markup_evidence,
      f.pricing_base_date,
      f.base_date_source,
      f.base_date_confidence,
      f.base_date_evidence,
      f.stated_total_confidence,
      f.stated_total_evidence,
      f.deliverable_type_confidence,
      f.deliverable_type_evidence,
      READER_VERSION,
      model,
      f.conventions_applied,
    ]
  );
  return String(res.rows[0].id);
}

/**
 * File each assumption as an open question (§6.4), for the Reader Queue, and
 * withdraw the earlier read's open assumptions that this read no longer makes
 * (see questions.ts for the rule, and migration 005b for the grant).
 *
 * An answered question is never touched, and never blocks a new one: the model
 * was shown the answer, so asking again means it found something the answer
 * does not cover.
 */
async function fileQuestions(
  db: Db,
  deliverableId: string,
  frameId: string,
  f: Frame
): Promise<{ filed: number; kept: number; withdrawn: number }> {
  const open = await db.query(
    `select id, kind, prompt, proposed_answer from reader_questions
      where deliverable_id = $1 and mode = 'assumption' and state = 'open'
        and line_item_id is null and kind = any($2::question_kind[])
      order by id`,
    [deliverableId, [...PASS_ONE_KINDS]]
  );
  const plan = planQuestions(
    open.rows.map((r) => ({ id: Number(r.id), kind: r.kind, prompt: r.prompt, proposedAnswer: r.proposed_answer })),
    f.questions
  );

  for (const id of plan.withdraw) {
    await mustTouch(
      db,
      `withdraw question #${id}`,
      `update reader_questions set state = 'withdrawn' where id = $1 and mode = 'assumption' and state = 'open'`,
      [id]
    );
  }
  for (const q of plan.file) {
    await db.query(
      `insert into reader_questions (deliverable_id, frame_id, kind, mode, prompt, evidence, proposed_answer)
       values ($1, $2, $3::question_kind, 'assumption', $4, $5, $6::jsonb)`,
      [deliverableId, frameId, q.kind, q.prompt, q.evidence, JSON.stringify(q.proposedAnswer)]
    );
  }
  return { filed: plan.file.length, kept: plan.keep.length, withdrawn: plan.withdraw.length };
}

export { IN_PROGRESS };
