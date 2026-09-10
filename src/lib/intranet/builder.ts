/**
 * Phase 3a of the Estimate Builder: propose a rate for every element from the
 * library, filtered by the project's own brief.
 *
 * The whole point of this module is the disposition rule, from PLAN.md §8.2:
 *
 *   green / amber → propose the median, flagged with its confidence
 *   red           → propose NOTHING. The line arrives blank with a reason.
 *
 * A blank cell prompts an estimator. A confidently wrong number reaches a
 * client with their name on it. So `suggestedRate` is genuinely null on a
 * red-gated element, and nothing downstream may substitute a fallback.
 */

import type {
  DataProvider,
  EstimateBrief,
  EstimateLine,
  TaxonomyNode,
} from './data/types.ts';
import { buildResult } from './library.ts';

/** Size band around the subject project, so comparables are comparable. */
function sizeBand(grossSf: number): { min: number; max: number } {
  return { min: grossSf * 0.6, max: grossSf * 1.8 };
}

export async function proposeLines(
  provider: DataProvider,
  brief: EstimateBrief,
): Promise<EstimateLine[]> {
  const taxonomy = await provider.getTaxonomy();
  const elements = taxonomy.filter((t: TaxonomyNode) => t.level === 2);
  const band = sizeBand(brief.grossSf);

  // Requirement-driven exclusions, resolved to the elements they govern.
  const excluded = new Map<string, { text: string; cite: string }>();
  for (const req of brief.requirements) {
    if (req.type !== 'exclude') continue;
    for (const code of req.appliesTo ?? []) {
      excluded.set(code, { text: req.text, cite: req.cite });
    }
  }

  const lines: EstimateLine[] = [];

  for (const el of elements) {
    const exclusion = excluded.get(el.code);
    if (exclusion) {
      lines.push({
        id: el.code,
        taxonomyCode: el.code,
        title: el.title,
        confidence: 'excluded',
        suggestedRate: null,
        suggestedReason: '',
        sampleN: 0,
        disposition: 'excluded_by_requirement',
        finalRate: null,
        excludedSource: `${exclusion.cite} — ${exclusion.text}`,
        observations: [],
      });
      continue;
    }

    const observations = await provider.getObservations({
      taxonomyCode: el.code,
      minGrossSf: band.min,
      maxGrossSf: band.max,
    });

    if (observations.length === 0) continue;

    const result = buildResult(observations);
    const { verdict, summary } = result;
    const isRed = verdict.level === 'red';

    lines.push({
      id: el.code,
      taxonomyCode: el.code,
      title: el.title,
      note: observations[0]?.rawDescription,
      confidence: verdict.level,
      // Null on red. Deliberate — see the module comment.
      suggestedRate: isRed ? null : +summary.median.toFixed(2),
      suggestedReason: verdict.reasons.join(' · '),
      sampleN: result.kept.length,
      disposition: isRed ? 'left_blank' : 'proposed',
      finalRate: isRed ? null : +summary.median.toFixed(2),
      blankReason: isRed ? verdict.reasons.join(' · ') : undefined,
      observations: [
        ...result.kept.map((o) => ({
          label: `${o.projectName} · ${o.grossSf.toLocaleString('en-US')} GSF · ${new Date(
            o.issueDate,
          ).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}${
            o.markupFactor !== 1 ? ` · loaded ÷${o.markupFactor.toFixed(2)}` : ''
          }${o.hasOpenAssumption ? ' · area assumed, unconfirmed' : ''}`,
          value: '$' + o.escalatedBareCostPerSf.toFixed(2),
        })),
        ...result.rejected.map((r) => ({
          label: `${r.item.projectName} · excluded — ${r.reason}`,
          value: '$' + r.value.toFixed(2),
          excluded: true,
        })),
      ],
      attribution: result.openAssumptions
        ? `${result.openAssumptions} observation${result.openAssumptions === 1 ? '' : 's'} rest on an assumption nobody has confirmed — answering it in the Reader Queue may move this line to green.`
        : undefined,
    });
  }

  return lines;
}

export interface EstimateTotals {
  bareSubtotal: number;
  perSf: number;
  pricedLines: number;
  settledLines: number;
  unpricedLines: number;
}

export function totals(lines: readonly EstimateLine[], grossSf: number): EstimateTotals {
  let bareSubtotal = 0;
  let pricedLines = 0;
  let settledLines = 0;
  let unpricedLines = 0;

  for (const l of lines) {
    if (l.disposition === 'excluded_by_requirement') continue;
    if (l.finalRate == null) {
      unpricedLines++;
      continue;
    }
    bareSubtotal += l.finalRate * grossSf;
    pricedLines++;
    if (l.disposition === 'accepted' || l.disposition === 'overridden') settledLines++;
  }

  return {
    bareSubtotal,
    perSf: grossSf > 0 ? bareSubtotal / grossSf : 0,
    pricedLines,
    settledLines,
    unpricedLines,
  };
}
