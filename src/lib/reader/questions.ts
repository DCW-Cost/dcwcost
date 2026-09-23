/**
 * What a re-read does with the questions an earlier read left open.
 *
 * The new frame's assumptions REPLACE the old frame's open ones. For each open
 * assumption from an earlier read of this document:
 *
 *   - the new frame asks the same thing  → keep it; do not file a duplicate
 *   - the new frame asks something else,
 *     or no longer needs to ask at all   → withdraw it (migration 005b)
 *
 * and anything the new frame asks that is not already open is filed fresh.
 *
 * "The same thing" means the same kind and the same proposed answer — the
 * reader still assumes what it assumed before. A changed proposal is a changed
 * mind, and a person should answer the new one, not the old. For `other`,
 * which covers unrelated things, the prompt itself must match.
 *
 * Only pass one's own questions are in play: open ASSUMPTIONS, not tied to a
 * line item, of the kinds pass one files. Blocking questions, answered ones,
 * and anything pass two or three will file (taxonomy mapping, reconciliation)
 * are never touched here.
 */
import type { AssumptionQuestion } from './frame.ts';

export const PASS_ONE_KINDS = ['coding_system', 'gross_area', 'markup_basis', 'deliverable_type', 'pricing_base_date', 'other'] as const;

export interface OpenQuestion {
  id: number;
  kind: string;
  prompt: string;
  proposedAnswer: unknown;
}

export interface QuestionPlan {
  keep: number[];
  withdraw: number[];
  file: AssumptionQuestion[];
}

/** Order-insensitive structural equality for the small JSON proposals we store. */
function sameJson(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
        : v;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

function same(open: OpenQuestion, fresh: AssumptionQuestion): boolean {
  if (open.kind !== fresh.kind) return false;
  if (fresh.kind === 'other') return open.prompt.trim() === fresh.prompt.trim();
  return sameJson(open.proposedAnswer, fresh.proposedAnswer);
}

export function planQuestions(open: OpenQuestion[], fresh: AssumptionQuestion[]): QuestionPlan {
  const keep: number[] = [];
  const withdraw: number[] = [];
  const matched = new Set<number>();

  for (const q of open) {
    const i = fresh.findIndex((f, idx) => !matched.has(idx) && same(q, f));
    if (i >= 0) {
      matched.add(i);
      keep.push(q.id);
    } else {
      withdraw.push(q.id);
    }
  }
  return { keep, withdraw, file: fresh.filter((_, idx) => !matched.has(idx)) };
}
