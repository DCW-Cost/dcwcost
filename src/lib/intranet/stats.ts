/**
 * Statistics for the cost library.
 *
 * Two decisions drive everything in here, both from PLAN.md §7:
 *
 *  1. Construction costs are right-skewed and roughly log-normal, so outlier
 *     detection runs on ln(x). Testing raw dollars overstates the mean and
 *     mislabels legitimately expensive projects as anomalies.
 *
 *  2. Outliers are rejected by median absolute deviation, not mean ± 2σ. At the
 *     sample sizes involved here — often fewer than twenty observations — a
 *     single extreme value drags a standard-deviation threshold out far enough
 *     to protect itself. The median doesn't move.
 *
 * Nothing in this module knows where its numbers came from. Escalation and
 * markup stripping happen upstream in units.ts; by the time a value reaches
 * here it is already on one basis and in one period.
 */

/** Sorted copy. Used everywhere below, so it is worth doing once. */
function sorted(xs: readonly number[]): number[] {
  return [...xs].sort((a, b) => a - b);
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const s = sorted(xs);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Linear-interpolated quantile (the same convention as NumPy's default and
 * Excel's PERCENTILE, so a figure here matches one an estimator checks by hand).
 */
export function quantile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return NaN;
  if (xs.length === 1) return xs[0]!;
  const s = sorted(xs);
  const pos = (s.length - 1) * Math.min(Math.max(p, 0), 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo]!;
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

/** Median absolute deviation. */
export function mad(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

/** Sample coefficient of variation. Undefined at n < 2 or mean 0. */
export function coefficientOfVariation(xs: readonly number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  if (m === 0) return NaN;
  const variance =
    xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance) / Math.abs(m);
}

export interface OutlierOptions {
  /** Modified z-score above which a point is rejected. PLAN.md §7 uses 3.5. */
  threshold?: number;
  /** Also apply a 1.5×IQR fence as a cross-check. */
  iqrFence?: boolean;
}

export interface OutlierResult<T> {
  kept: T[];
  rejected: Array<{ item: T; value: number; score: number; reason: string }>;
}

/**
 * Reject outliers by modified z-score on the log scale.
 *
 * The modified z-score is 0.6745·(x − median) / MAD; the constant makes it
 * comparable to a standard z-score for normally distributed data.
 *
 * Two guards matter in practice. Below four observations nothing is rejected —
 * with n=3 the MAD is dominated by whichever point is closest to the median, and
 * "reject the odd one out" is not a meaningful judgement. And when the MAD is
 * zero (identical values, which happens with repeated allowances) every score
 * would be infinite, so the set is returned untouched.
 */
export function rejectOutliers<T>(
  items: readonly T[],
  getValue: (item: T) => number,
  options: OutlierOptions = {},
): OutlierResult<T> {
  const { threshold = 3.5, iqrFence = true } = options;
  const values = items.map(getValue);

  if (items.length < 4 || values.some((v) => !Number.isFinite(v) || v <= 0)) {
    return { kept: [...items], rejected: [] };
  }

  const logs = values.map(Math.log);
  const logMedian = median(logs);
  const logMad = mad(logs);

  const iqrLo = quantile(logs, 0.25);
  const iqrHi = quantile(logs, 0.75);
  const iqr = iqrHi - iqrLo;
  const fenceLo = iqrLo - 1.5 * iqr;
  const fenceHi = iqrHi + 1.5 * iqr;

  const kept: T[] = [];
  const rejected: OutlierResult<T>['rejected'] = [];

  items.forEach((item, i) => {
    const logValue = logs[i]!;
    const score = logMad === 0 ? 0 : (0.6745 * (logValue - logMedian)) / logMad;
    const beyondFence = iqrFence && iqr > 0 && (logValue < fenceLo || logValue > fenceHi);

    if (Math.abs(score) > threshold) {
      rejected.push({
        item,
        value: values[i]!,
        score,
        reason: `modified z-score ${score.toFixed(1)}, threshold ±${threshold}`,
      });
    } else if (beyondFence) {
      rejected.push({
        item,
        value: values[i]!,
        score,
        reason: 'beyond the 1.5×IQR fence',
      });
    } else {
      kept.push(item);
    }
  });

  return { kept, rejected };
}

/** Normal CDF via an Abramowitz & Stegun erf approximation (|ε| < 1.5e-7). */
function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

export interface TrendResult {
  /** Theil–Sen slope, in value-units per year. */
  slopePerYear: number;
  /** Slope as a share of the median value, e.g. 0.041 for +4.1%/yr. */
  percentPerYear: number;
  /** Two-sided p-value from the Mann–Kendall S statistic. */
  pValue: number;
  n: number;
  significant: boolean;
}

/**
 * Theil–Sen slope with a Mann–Kendall significance test.
 *
 * Theil–Sen takes the median of all pairwise slopes, so a couple of odd points
 * cannot swing it the way they swing least squares — which matters when a
 * "trend" is being read off eight observations and then used to price real work.
 */
export function trend(
  points: ReadonlyArray<{ date: Date; value: number }>,
  options: { minN?: number; maxPValue?: number } = {},
): TrendResult {
  const { minN = 8, maxPValue = 0.1 } = options;
  const n = points.length;
  const empty: TrendResult = {
    slopePerYear: NaN,
    percentPerYear: NaN,
    pValue: NaN,
    n,
    significant: false,
  };
  if (n < 2) return empty;

  const YEAR_MS = 365.2425 * 24 * 60 * 60 * 1000;
  const t = points.map((p) => p.date.getTime() / YEAR_MS);
  const v = points.map((p) => p.value);

  const slopes: number[] = [];
  let S = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dt = t[j]! - t[i]!;
      if (dt !== 0) slopes.push((v[j]! - v[i]!) / dt);
      S += Math.sign(v[j]! - v[i]!) * Math.sign(dt);
    }
  }
  if (slopes.length === 0) return empty;

  const slope = median(slopes);
  const mid = median(v);

  // Mann–Kendall normal approximation. Not meaningful below ~8 points, which is
  // why `significant` also gates on n.
  const varS = (n * (n - 1) * (2 * n + 5)) / 18;
  let z = 0;
  if (varS > 0) {
    if (S > 0) z = (S - 1) / Math.sqrt(varS);
    else if (S < 0) z = (S + 1) / Math.sqrt(varS);
  }
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));

  return {
    slopePerYear: slope,
    percentPerYear: mid === 0 ? NaN : slope / mid,
    pValue,
    n,
    significant: n >= minN && pValue < maxPValue,
  };
}

export type ConfidenceLevel = 'green' | 'amber' | 'red';

/** Mirrors the `confidence_rules` table. Defaults match PLAN.md §7. */
export interface ConfidenceRules {
  greenMinN: number;
  greenMaxCv: number;
  greenMinProjects: number;
  greenMinEstimators: number;
  greenMaxAgeMonths: number;
  greenRequiresConfirmedAssumptions: boolean;
  amberMinN: number;
  amberMaxCv: number;
  amberMaxAgeMonths: number;
}

export const DEFAULT_RULES: ConfidenceRules = {
  greenMinN: 8,
  greenMaxCv: 0.25,
  greenMinProjects: 3,
  greenMinEstimators: 2,
  greenMaxAgeMonths: 18,
  greenRequiresConfirmedAssumptions: true,
  amberMinN: 4,
  amberMaxCv: 0.5,
  amberMaxAgeMonths: 36,
};

export interface ConfidenceInput {
  n: number;
  cv: number;
  distinctProjects: number;
  distinctEstimators: number;
  newestAgeMonths: number;
  openAssumptions: number;
}

export interface ConfidenceVerdict {
  level: ConfidenceLevel;
  /**
   * Why, in words an estimator can act on. The rule from PLAN.md §7 is that the
   * reason always ships with the colour — a bare red light tells nobody what to
   * do next.
   */
  reasons: string[];
  headline: string;
}

export function assessConfidence(
  input: ConfidenceInput,
  rules: ConfidenceRules = DEFAULT_RULES,
): ConfidenceVerdict {
  const { n, cv, distinctProjects, distinctEstimators, newestAgeMonths, openAssumptions } = input;

  const red: string[] = [];
  if (n < rules.amberMinN) {
    red.push(n === 0 ? 'no observations match these filters' : `only ${n} observation${n === 1 ? '' : 's'}`);
  }
  if (Number.isFinite(cv) && cv > rules.amberMaxCv) {
    red.push(`spread ${cv.toFixed(2)} — the observations disagree too much to average`);
  }
  if (n > 0 && distinctProjects < 2) {
    red.push('every observation comes from a single project');
  }
  if (n > 0 && distinctEstimators < 2 && distinctProjects < 2) {
    red.push('every observation comes from a single estimator');
  }
  if (red.length) {
    return {
      level: 'red',
      reasons: red,
      headline: 'Insufficient data — research and price this manually',
    };
  }

  const amber: string[] = [];
  if (n < rules.greenMinN) amber.push(`${n} observations — usable, but a thin sample`);
  if (Number.isFinite(cv) && cv > rules.greenMaxCv) amber.push(`spread ${cv.toFixed(2)}`);
  if (distinctProjects < rules.greenMinProjects) {
    amber.push(`only ${distinctProjects} distinct project${distinctProjects === 1 ? '' : 's'}`);
  }
  if (distinctEstimators < rules.greenMinEstimators) {
    amber.push('only one estimator priced this');
  }
  if (newestAgeMonths > rules.greenMaxAgeMonths) {
    amber.push(`newest observation is ${Math.round(newestAgeMonths)} months old`);
  }
  if (rules.greenRequiresConfirmedAssumptions && openAssumptions > 0) {
    amber.push(
      `${openAssumptions} observation${openAssumptions === 1 ? '' : 's'} rest${openAssumptions === 1 ? 's' : ''} on an unconfirmed assumption`,
    );
  }

  if (amber.length) {
    return { level: 'amber', reasons: amber, headline: 'Usable — apply judgment' };
  }

  return {
    level: 'green',
    reasons: [
      `${n} observations across ${distinctProjects} projects and ${distinctEstimators} estimators`,
      `spread ${cv.toFixed(2)}`,
    ],
    headline: 'Price from this',
  };
}

export interface Summary {
  n: number;
  median: number;
  mean: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
  min: number;
  max: number;
  cv: number;
}

export function summarize(values: readonly number[]): Summary {
  return {
    n: values.length,
    median: median(values),
    mean: mean(values),
    p10: quantile(values, 0.1),
    p25: quantile(values, 0.25),
    p75: quantile(values, 0.75),
    p90: quantile(values, 0.9),
    min: values.length ? Math.min(...values) : NaN,
    max: values.length ? Math.max(...values) : NaN,
    cv: coefficientOfVariation(values),
  };
}

export function monthsBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / (30.436875 * 24 * 60 * 60 * 1000);
}
