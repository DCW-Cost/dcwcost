import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  median,
  quantile,
  mad,
  coefficientOfVariation,
  rejectOutliers,
  trend,
  assessConfidence,
  summarize,
  DEFAULT_RULES,
} from './stats.ts';

const close = (a: number, b: number, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) < tol, `expected ${a} ≈ ${b}`);

test('median handles odd and even lengths', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.ok(Number.isNaN(median([])));
});

test('quantile interpolates like PERCENTILE', () => {
  const xs = [1, 2, 3, 4];
  close(quantile(xs, 0), 1);
  close(quantile(xs, 0.5), 2.5);
  close(quantile(xs, 1), 4);
  close(quantile(xs, 0.25), 1.75);
});

test('mad is zero for identical values', () => {
  assert.equal(mad([5, 5, 5, 5]), 0);
  assert.equal(mad([1, 2, 3, 4, 5]), 1);
});

test('coefficient of variation is undefined below n=2', () => {
  assert.ok(Number.isNaN(coefficientOfVariation([7])));
  close(coefficientOfVariation([10, 10, 10]), 0);
});

test('outlier rejection catches a genuine anomaly', () => {
  // Nine tightly clustered foundation rates plus one deep-foundation job.
  const values = [10.9, 11.0, 10.7, 11.2, 10.8, 11.1, 10.95, 11.05, 10.85, 24.6];
  const { kept, rejected } = rejectOutliers(values, (v) => v);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]!.value, 24.6);
  assert.equal(kept.length, 9);
});

test('outlier rejection leaves a merely-expensive project alone', () => {
  // Wide but legitimate spread — nothing here is an anomaly, it is just variance.
  const values = [18, 22, 27, 31, 35, 40, 44, 49];
  const { rejected } = rejectOutliers(values, (v) => v);
  assert.equal(rejected.length, 0);
});

test('MAD catches masked outliers that mean ± 2σ misses entirely', () => {
  // Masking: two anomalies inflate σ enough that neither breaches the 2σ
  // threshold, so a standard-deviation test silently keeps both and the median
  // it feeds is badly wrong. This is the specific failure mode that made MAD
  // the primary test in PLAN.md §7 — not a stylistic preference.
  const values = [10, 10.5, 11, 10.2, 10.8, 10.4, 10.6, 60, 65];

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(
    values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1),
  );
  const twoSigmaKeeps = values.filter((v) => Math.abs(v - mean) <= 2 * sd);
  assert.equal(twoSigmaKeeps.length, values.length, 'sanity: 2σ rejects nothing here');

  const { kept, rejected } = rejectOutliers(values, (v) => v);
  assert.equal(rejected.length, 2);
  assert.deepEqual(
    rejected.map((r) => r.value).sort((a, b) => a - b),
    [60, 65],
  );
  assert.equal(kept.length, 7);
});

test('the IQR fence is deliberately strict against a very tight cluster', () => {
  // Pinning a real trade-off rather than discovering it in production. When the
  // surviving observations agree closely, the fence sits close too, so a value
  // 30% away is treated as an anomaly. That is defensible — an outlier is
  // relative to the spread of its own data — but it is aggressive, so it is
  // switchable per query and worth revisiting against the real archive.
  const tight = [10, 10.1, 10.2, 10.15, 10.05, 10.25, 10.3, 10.12, 13];
  assert.equal(rejectOutliers(tight, (v) => v).rejected.length, 1);
  assert.equal(
    rejectOutliers(tight, (v) => v, { iqrFence: false }).rejected.length,
    1,
    'the modified z-score reaches the same verdict here without the fence',
  );
});

test('outlier rejection is a no-op below n=4 and on zero MAD', () => {
  assert.equal(rejectOutliers([1, 2, 99], (v) => v).rejected.length, 0);
  assert.equal(rejectOutliers([5, 5, 5, 5, 5], (v) => v).rejected.length, 0);
});

test('outlier rejection tolerates non-positive values without throwing', () => {
  const { kept, rejected } = rejectOutliers([0, 1, 2, 3], (v) => v);
  assert.equal(kept.length, 4);
  assert.equal(rejected.length, 0);
});

test('trend finds a real upward slope and reports it per year', () => {
  const points = Array.from({ length: 10 }, (_, i) => ({
    date: new Date(2024, i * 2, 1),
    value: 100 + i * 5,
  }));
  const t = trend(points);
  assert.ok(t.significant, 'a clean monotonic rise should be significant');
  assert.ok(t.slopePerYear > 0);
  // +5 every two months is +30/yr on a median near 122 — about +25%/yr.
  assert.ok(t.percentPerYear > 0.2 && t.percentPerYear < 0.3, `got ${t.percentPerYear}`);
});

test('trend refuses to call noise a trend', () => {
  const noise = [12, 9, 14, 8, 13, 10, 11, 12, 9, 13];
  const points = noise.map((v, i) => ({ date: new Date(2024, i * 2, 1), value: v }));
  assert.equal(trend(points).significant, false);
});

test('trend will not report significance below the minimum sample', () => {
  const points = Array.from({ length: 5 }, (_, i) => ({
    date: new Date(2024, i * 2, 1),
    value: 100 + i * 20,
  }));
  assert.equal(trend(points).significant, false, 'n=5 is below minN=8');
});

test('confidence gate: green needs every condition', () => {
  const v = assessConfidence({
    n: 11,
    cv: 0.19,
    distinctProjects: 7,
    distinctEstimators: 4,
    newestAgeMonths: 2,
    openAssumptions: 0,
  });
  assert.equal(v.level, 'green');
  assert.match(v.headline, /Price from this/);
});

test('confidence gate: an unconfirmed assumption demotes green to amber', () => {
  const base = {
    n: 11,
    cv: 0.19,
    distinctProjects: 7,
    distinctEstimators: 4,
    newestAgeMonths: 2,
  };
  assert.equal(assessConfidence({ ...base, openAssumptions: 0 }).level, 'green');
  const demoted = assessConfidence({ ...base, openAssumptions: 3 });
  assert.equal(demoted.level, 'amber');
  assert.ok(demoted.reasons.some((r) => /unconfirmed assumption/.test(r)));
});

test('confidence gate: red when everything comes from one project', () => {
  const v = assessConfidence({
    n: 6,
    cv: 0.1,
    distinctProjects: 1,
    distinctEstimators: 1,
    newestAgeMonths: 4,
    openAssumptions: 0,
  });
  assert.equal(v.level, 'red');
  assert.ok(v.reasons.some((r) => /single project/.test(r)));
});

test('confidence gate: red on too few observations, and it says so plainly', () => {
  const v = assessConfidence({
    n: 2,
    cv: 0.05,
    distinctProjects: 2,
    distinctEstimators: 2,
    newestAgeMonths: 1,
    openAssumptions: 0,
  });
  assert.equal(v.level, 'red');
  assert.ok(v.reasons.some((r) => /only 2 observations/.test(r)));
});

test('confidence gate: stale data is amber, not green', () => {
  const v = assessConfidence({
    n: 10,
    cv: 0.15,
    distinctProjects: 5,
    distinctEstimators: 3,
    newestAgeMonths: 26,
    openAssumptions: 0,
  });
  assert.equal(v.level, 'amber');
  assert.ok(v.reasons.some((r) => /26 months old/.test(r)));
});

test('confidence gate: every verdict carries at least one reason', () => {
  for (const level of ['green', 'amber', 'red'] as const) {
    const input =
      level === 'green'
        ? { n: 12, cv: 0.1, distinctProjects: 6, distinctEstimators: 3, newestAgeMonths: 1, openAssumptions: 0 }
        : level === 'amber'
          ? { n: 5, cv: 0.2, distinctProjects: 3, distinctEstimators: 2, newestAgeMonths: 5, openAssumptions: 0 }
          : { n: 1, cv: NaN, distinctProjects: 1, distinctEstimators: 1, newestAgeMonths: 1, openAssumptions: 0 };
    const v = assessConfidence(input);
    assert.equal(v.level, level);
    assert.ok(v.reasons.length > 0, `${level} verdict must explain itself`);
  }
});

test('rules are overridable, as the admin panel needs', () => {
  const strict = { ...DEFAULT_RULES, greenMinN: 20 };
  const input = {
    n: 11,
    cv: 0.19,
    distinctProjects: 7,
    distinctEstimators: 4,
    newestAgeMonths: 2,
    openAssumptions: 0,
  };
  assert.equal(assessConfidence(input).level, 'green');
  assert.equal(assessConfidence(input, strict).level, 'amber');
});

test('summarize reports the full spread', () => {
  const s = summarize([10, 12, 14, 16, 18]);
  assert.equal(s.n, 5);
  close(s.median, 14);
  close(s.min, 10);
  close(s.max, 18);
  assert.ok(s.cv > 0);
});
