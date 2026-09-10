/**
 * Turns raw observations into the thing a Cost Library page renders.
 *
 * This is where the pipeline from PLAN.md §7 actually runs: filter, put on one
 * basis, escalate, reject outliers on the log scale, summarise, detect trend,
 * and gate. Pages call `buildResult` and render what comes back — no statistics
 * live in the templates.
 */

import type { Observation } from './data/types.ts';
import {
  assessConfidence,
  monthsBetween,
  rejectOutliers,
  summarize,
  trend,
  DEFAULT_RULES,
  type ConfidenceRules,
  type ConfidenceVerdict,
  type Summary,
  type TrendResult,
} from './stats.ts';

export interface LibraryResult {
  summary: Summary;
  verdict: ConfidenceVerdict;
  trend: TrendResult;
  kept: Observation[];
  rejected: Array<{ item: Observation; value: number; reason: string }>;
  distinctProjects: number;
  distinctEstimators: number;
  newestAgeMonths: number;
  openAssumptions: number;
  /** Union of every markup component stripped across the pooled documents. */
  strippedMarkups: string[];
}

/** The figure everything pools on: bare basis, escalated to today. */
const poolValue = (o: Observation) => o.escalatedBareCostPerSf;

export function buildResult(
  observations: readonly Observation[],
  rules: ConfidenceRules = DEFAULT_RULES,
  now: Date = new Date(),
): LibraryResult {
  // A rate whose markup basis the reader could not establish is not comparable
  // to anything, so it never enters the pool. schema.sql enforces the same rule
  // in v_observations; this guards the case where a provider hands us raw rows.
  const comparable = observations.filter((o) => o.basis !== 'undetermined');

  const { kept, rejected } = rejectOutliers(comparable, poolValue);
  const values = kept.map(poolValue);
  const summary = summarize(values);

  const distinctProjects = new Set(kept.map((o) => o.projectId)).size;
  const distinctEstimators = new Set(kept.map((o) => o.estimator)).size;
  const openAssumptions = kept.filter((o) => o.hasOpenAssumption).length;

  const newestAgeMonths = kept.length
    ? Math.min(...kept.map((o) => monthsBetween(new Date(o.issueDate), now)))
    : Infinity;

  const verdict = assessConfidence(
    {
      n: kept.length,
      cv: summary.cv,
      distinctProjects,
      distinctEstimators,
      newestAgeMonths: Number.isFinite(newestAgeMonths) ? newestAgeMonths : 999,
      openAssumptions,
    },
    rules,
  );

  const t = trend(
    kept.map((o) => ({ date: new Date(o.issueDate), value: poolValue(o) })),
  );

  const strippedMarkups = [
    ...new Set(kept.flatMap((o) => o.markupComponents.map((m) => m.label))),
  ];

  return {
    summary,
    verdict,
    trend: t,
    kept,
    rejected: rejected.map((r) => ({ item: r.item, value: r.value, reason: r.reason })),
    distinctProjects,
    distinctEstimators,
    newestAgeMonths,
    openAssumptions,
    strippedMarkups,
  };
}

export const money = (n: number) =>
  Number.isFinite(n) ? '$' + Math.round(n).toLocaleString('en-US') : '—';

export const rate = (n: number) => (Number.isFinite(n) ? '$' + n.toFixed(2) : '—');

export const pct = (n: number) =>
  Number.isFinite(n) ? (n >= 0 ? '+' : '') + (n * 100).toFixed(1) + '%' : '—';

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}
