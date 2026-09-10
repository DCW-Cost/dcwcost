/**
 * Demo data for building the UI before Airtable, Box and Supabase are wired.
 *
 * IMPORTANT: none of this is real DCW data. Project names are generic
 * descriptors ("Civic aquatic — Kent"), not clients, and every figure is
 * invented. The banner on every intranet page says so, and it stays until a
 * real provider replaces this one.
 *
 * The shapes here are the ones the real queries must return, so this file
 * doubles as a specification for the Supabase provider.
 */

import type {
  DataProvider,
  Estimate,
  LibraryFilters,
  Observation,
  Profile,
  ReaderQuestion,
  TaxonomyNode,
} from './types.ts';

const TAXONOMY: TaxonomyNode[] = [
  { code: 'A', parentCode: null, level: 1, title: 'Substructure' },
  { code: 'A10', parentCode: 'A', level: 2, title: 'Foundations' },
  { code: 'A20', parentCode: 'A', level: 2, title: 'Basement Construction' },
  { code: 'B', parentCode: null, level: 1, title: 'Shell' },
  { code: 'B10', parentCode: 'B', level: 2, title: 'Superstructure' },
  { code: 'B20', parentCode: 'B', level: 2, title: 'Exterior Enclosure' },
  { code: 'B30', parentCode: 'B', level: 2, title: 'Roofing' },
  { code: 'C', parentCode: null, level: 1, title: 'Interiors' },
  { code: 'C10', parentCode: 'C', level: 2, title: 'Interior Construction' },
  { code: 'C20', parentCode: 'C', level: 2, title: 'Stairs' },
  { code: 'C30', parentCode: 'C', level: 2, title: 'Interior Finishes' },
  { code: 'D', parentCode: null, level: 1, title: 'Services' },
  { code: 'D10', parentCode: 'D', level: 2, title: 'Conveying' },
  { code: 'D20', parentCode: 'D', level: 2, title: 'Plumbing' },
  { code: 'D30', parentCode: 'D', level: 2, title: 'HVAC' },
  { code: 'D40', parentCode: 'D', level: 2, title: 'Fire Protection' },
  { code: 'D50', parentCode: 'D', level: 2, title: 'Electrical' },
  { code: 'E', parentCode: null, level: 1, title: 'Equipment & Furnishings' },
  { code: 'E10', parentCode: 'E', level: 2, title: 'Equipment' },
];

interface Seed {
  project: string;
  client: string;
  sector: string;
  region: string;
  sf: number;
  date: string;
  estimator: string;
  markup: number;
  assumption?: boolean;
}

/**
 * Index 3 (Bellevue) is the one project carrying an unconfirmed reader
 * assumption. Which elements include it is what makes some results amber, so
 * the demo shows all three gate states rather than a wall of one colour.
 */
const PROJECTS: Seed[] = [
  { project: 'Civic aquatic — Kent', client: 'City of Kent', sector: 'Civic', region: 'Seattle', sf: 39800, date: '2025-11-14', estimator: 'Brian Thompson', markup: 1.0 },
  { project: 'Civic rec — Olympia', client: 'City of Olympia', sector: 'Civic', region: 'Seattle', sf: 52100, date: '2025-06-02', estimator: 'Katya M.', markup: 1.22 },
  { project: 'Library — Ballard', client: 'Seattle Public Library', sector: 'Civic', region: 'Seattle', sf: 62400, date: '2026-03-09', estimator: 'Brian Thompson', markup: 1.0 },
  { project: 'Community center — Bellevue', client: 'City of Bellevue', sector: 'Civic', region: 'Seattle', sf: 71200, date: '2025-08-21', estimator: 'Rachel Quimby', markup: 1.0, assumption: true },
  { project: 'Aquatic — Vancouver WA', client: 'Clark County', sector: 'Civic', region: 'Portland', sf: 44600, date: '2025-02-18', estimator: 'Katya M.', markup: 1.18 },
  { project: 'K-12 gym — Tacoma', client: 'Tacoma SD', sector: 'Education', region: 'Seattle', sf: 48900, date: '2026-01-22', estimator: 'Charu S.', markup: 1.0 },
  { project: 'Field house — Everett', client: 'City of Everett', sector: 'Civic', region: 'Seattle', sf: 44100, date: '2025-08-05', estimator: 'Brian Thompson', markup: 1.0 },
  { project: 'Rec center — Spokane', client: 'City of Spokane', sector: 'Civic', region: 'Spokane', sf: 55300, date: '2025-04-11', estimator: 'Charu S.', markup: 1.15 },
  { project: 'Aquatic — Federal Way', client: 'City of Federal Way', sector: 'Civic', region: 'Seattle', sf: 46200, date: '2025-09-30', estimator: 'Katya M.', markup: 1.0 },
  { project: 'Community pool — Yakima', client: 'City of Yakima', sector: 'Civic', region: 'Spokane', sf: 41500, date: '2025-12-08', estimator: 'Charu S.', markup: 1.19 },
  { project: 'K-12 natatorium — Kirkland', client: 'Lake Washington SD', sector: 'Education', region: 'Seattle', sf: 53700, date: '2026-02-11', estimator: 'Brian Thompson', markup: 1.0 },
];

const ALL = PROJECTS.map((_, i) => i);
const WITHOUT_ASSUMPTION = ALL.filter((i) => i !== 3);

interface ElementSpec {
  base: number;
  /** Relative jitter applied per project. Small = tight agreement. */
  sigma: number;
  note: string;
  /** Which projects priced this element. Defaults to all of them. */
  on?: number[];
  /** A genuine anomaly to prove outlier rejection works on real output. */
  outlier?: { project: number; rate: number };
}

const ELEMENTS: Record<string, ElementSpec> = {
  // Tight agreement across many projects — but Bellevue's unconfirmed
  // assumption is in the pool, so this lands amber and says why.
  A10: {
    base: 10.94,
    sigma: 0.05,
    note: 'Spread footings, slab-on-grade',
    on: ALL,
    outlier: { project: 6, rate: 24.6 }, // Everett: deep foundations
  },
  B10: { base: 38.4, sigma: 0.06, note: 'Steel frame, long-span', on: WITHOUT_ASSUMPTION },
  B20: { base: 27.15, sigma: 0.19, note: 'Curtain wall, high-humidity assembly', on: [0, 1, 2, 4, 5, 8] },
  B30: { base: 9.8, sigma: 0.05, note: 'Membrane roofing', on: WITHOUT_ASSUMPTION },
  C10: { base: 18.6, sigma: 0.09, note: 'Partitions, locker rooms', on: ALL },
  C20: { base: 2.15, sigma: 0.11, note: 'Egress stairs', on: [0, 2, 5] },
  C30: { base: 16.4, sigma: 0.06, note: 'Tile, resilient, coatings', on: WITHOUT_ASSUMPTION },
  D20: { base: 14.2, sigma: 0.05, note: 'Domestic and drainage', on: WITHOUT_ASSUMPTION },
  D30: { base: 31.5, sigma: 0.17, note: 'Dehumidification, air handling', on: [0, 1, 4, 8, 9] },
  D40: { base: 4.9, sigma: 0.06, note: 'Sprinklers, standpipes', on: WITHOUT_ASSUMPTION },
  D50: { base: 26.75, sigma: 0.07, note: 'Power, lighting, controls', on: ALL },
  E10: { base: 21.4, sigma: 0.0, note: 'Pool filtration and water treatment', on: [4] },
  A20: { base: 13.4, sigma: 0.05, note: 'Below-grade mechanical vault', on: [4, 4] },
};

/** Deterministic jitter in [-1, 1], so the demo is stable across builds. */
function jitter(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

function buildObservations(): Observation[] {
  const out: Observation[] = [];
  for (const [code, spec] of Object.entries(ELEMENTS)) {
    const indices = spec.on ?? ALL;
    indices.forEach((pi, k) => {
      const p = PROJECTS[pi]!;
      const isOutlier = spec.outlier?.project === pi;
      const bare = isOutlier
        ? spec.outlier!.rate
        : +(spec.base * (1 + spec.sigma * jitter(`${code}:${pi}`))).toFixed(2);

      // ~4%/yr escalation from issue date to today, applied to the bare rate.
      const years = (Date.now() - new Date(p.date).getTime()) / (365.2425 * 864e5);
      const escalated = +(bare * Math.pow(1.04, years)).toFixed(2);

      out.push({
        lineItemId: `${code}-${pi}-${k}`,
        taxonomyCode: code,
        rawDescription: spec.note,
        unitCost: +(bare * p.markup).toFixed(2),
        bareCostPerSf: bare,
        escalatedBareCostPerSf: escalated,
        basis: p.markup === 1 ? 'bare' : 'loaded',
        projectId: `p${pi}`,
        projectName: p.project,
        clientName: p.client,
        sector: p.sector,
        region: p.region,
        grossSf: p.sf,
        deliverableType: 'cost_estimate',
        phase: 'design_development',
        issueDate: p.date,
        estimator: p.estimator,
        boxFileUrl: '#',
        markupFactor: p.markup,
        markupComponents:
          p.markup === 1
            ? []
            : [
                { label: 'General conditions', pct: 8.5 },
                { label: "GC's fee", pct: 5.0 },
                { label: 'Design contingency', pct: p.markup >= 1.22 ? 8.5 : 4.5 },
              ],
        hasOpenAssumption: Boolean(p.assumption),
      });
    });
  }
  return out;
}

const OBSERVATIONS = buildObservations();

const QUESTIONS: ReaderQuestion[] = [
  {
    id: 'q1',
    deliverableId: 'd-1',
    documentName: 'Olympia_RecCenter_DD_Estimate_r2.xlsx',
    projectName: 'Civic rec — Olympia',
    kind: 'markup_basis',
    mode: 'question',
    state: 'open',
    prompt:
      "There's a 22% block at the bottom labelled “GC's / Fee / Contingency”, but three element lines on p.4 appear to already carry their own contingency. I can't tell whether that block applies to everything or only to the unmarked elements.",
    evidence: "p.7 markup block 22.0% · p.4 rows 18–20 read “incl. cont.” · the sheet reconciles either way",
    options: ['Applies to everything', 'Only the unmarked lines'],
    boxFileUrl: '#',
  },
  {
    id: 'q2',
    deliverableId: 'd-2',
    documentName: 'Bellevue_CommunityCtr_DD.pdf',
    projectName: 'Community center — Bellevue',
    kind: 'gross_area',
    mode: 'assumption',
    state: 'open',
    prompt:
      'No gross area on the cover sheet. I found 71,200 SF in the summary block on page 2 and the elemental totals reconcile against it.',
    evidence: 'p.2 summary block · totals reconcile to 0.3% · Airtable records 71,200 SF for this project',
    proposedAnswer: '71,200 GSF',
    boxFileUrl: '#',
  },
  {
    id: 'q3',
    deliverableId: 'd-3',
    documentName: 'Spokane_RecCtr_2025_estimate.xlsx',
    projectName: 'Rec center — Spokane',
    kind: 'coding_system',
    mode: 'question',
    state: 'open',
    prompt:
      'This plan’s rows look like “03 30 00 — Cast-in-place concrete”. That’s MasterFormat, not the UniFormat used across most of the archive.',
    evidence: '46 of 51 rows match a MasterFormat division pattern · no UniFormat codes present',
    options: ['Map onto UniFormat', 'Keep as MasterFormat detail'],
    boxFileUrl: '#',
  },
  {
    id: 'q4',
    deliverableId: 'd-4',
    documentName: 'Kent_Aquatic_DD_Estimate.xlsx',
    projectName: 'Civic aquatic — Kent',
    kind: 'pricing_base_date',
    mode: 'assumption',
    state: 'open',
    prompt:
      'Pricing base date not stated. The escalation line references “midpoint Q1 2027”, so I’ve treated the issue date as the base and escalation to Q1 2027 as a markup.',
    evidence: 'p.1 escalation line · issue date 14 Nov 2025 · alternative reading moves rates by ≈4.2%',
    proposedAnswer: 'Base = issue date, 14 Nov 2025',
    boxFileUrl: '#',
  },
  {
    id: 'q5',
    deliverableId: 'd-5',
    documentName: 'Everett_FieldHouse_review.pdf',
    projectName: 'Field house — Everett',
    kind: 'deliverable_type',
    mode: 'assumption',
    state: 'open',
    prompt:
      'This reads as a review of a contractor’s estimate rather than one of ours — it comments on someone else’s numbers throughout. Classifying it as an estimate review, which keeps it out of the pricing pool.',
    evidence: '“we have reviewed the enclosed” on p.1 · variance columns against a third-party total',
    proposedAnswer: 'Estimate review — excluded from pricing',
    boxFileUrl: '#',
  },
  {
    id: 'q6',
    deliverableId: 'd-6',
    documentName: 'Tacoma_Gym_DD_r3.xlsx',
    projectName: 'K-12 gym — Tacoma',
    kind: 'reconciliation',
    mode: 'question',
    state: 'open',
    prompt:
      'The line items sum to $8.94M but the cover sheet says $9.38M — a gap of 4.7%, above the current 3% threshold. The difference is close to the “Owner’s contingency” block on p.9, which sits outside the elemental breakdown.',
    evidence: 'extracted $8,938,400 · stated $9,381,200 · p.9 owner’s contingency $442,100',
    options: ['Owner’s contingency is excluded from elements', 'Something was missed — re-read'],
    boxFileUrl: '#',
  },
  {
    id: 'q7',
    deliverableId: 'd-7',
    documentName: 'Vancouver_Aquatic_CD_estimate.pdf',
    projectName: 'Aquatic — Vancouver WA',
    kind: 'taxonomy_mapping',
    mode: 'question',
    state: 'open',
    prompt:
      '“Pool systems & water treatment” doesn’t map cleanly onto UniFormat. It could sit under E10 Equipment or be split across D20 Plumbing and D30 HVAC.',
    evidence: 'single line, $954,400 · no sub-breakdown given · appears in 3 other aquatic plans',
    options: ['E10 Equipment', 'Split across D20 / D30', 'Leave unmapped'],
    boxFileUrl: '#',
  },
];

const ME: Profile = {
  id: 'u1',
  fullName: 'Katya M.',
  email: 'katya@dcwcost.com',
  role: 'admin',
  status: 'active',
};

const PENDING: Profile[] = [
  { id: 'u8', fullName: 'Wills R.', email: 'wills@dcwcost.com', role: 'viewer', status: 'pending', requestedAt: '2026-09-10T08:12:00Z' },
  { id: 'u9', fullName: 'Matt D.', email: 'matt@dcwcost.com', role: 'viewer', status: 'pending', requestedAt: '2026-09-09T16:40:00Z' },
];

const ACTIVE: Profile[] = [
  ME,
  { id: 'u2', fullName: 'Rachel Quimby', email: 'rachel@dcwcost.com', role: 'admin', status: 'active' },
  { id: 'u3', fullName: 'Trish Drew', email: 'trish@dcwcost.com', role: 'admin', status: 'active' },
  { id: 'u4', fullName: 'Brian Thompson', email: 'brian@dcwcost.com', role: 'admin', status: 'active' },
  { id: 'u5', fullName: 'Charu S.', email: 'charu@dcwcost.com', role: 'estimator', status: 'active' },
  { id: 'u6', fullName: 'Brittany L.', email: 'brittany@dcwcost.com', role: 'estimator', status: 'active' },
];

const ESTIMATE: Estimate = {
  id: 'renton-aquatic',
  name: 'Community Aquatic Center — Renton',
  status: 'building',
  createdByName: 'Katya M.',
  updatedAt: '2026-09-10T14:05:00Z',
  inputs: [
    { filename: 'Renton_Aquatic_RFP_Addendum2.pdf', kind: 'RFP', status: 'read · 31 requirements found' },
    { filename: 'AquaticCenter_ProgramDoc_r4.docx', kind: 'Program', status: 'read · area schedule found' },
    { filename: '100pct_DD_SetA_architectural.pdf', kind: 'Drawings', status: 'read · 48,500 GSF confirmed' },
    { filename: 'Div01_GeneralRequirements.pdf', kind: 'Spec', status: 'read · 4 exclusions found' },
    { filename: 'DCW_CostPlan_Template_2026.xlsx', kind: 'Template', status: 'read · export target' },
  ],
  brief: {
    grossSf: 48500,
    sector: 'Civic · recreation',
    location: 'Renton, WA',
    deliveryMethod: 'CM/GC',
    phase: 'DD (100%)',
    constructionStart: 'April 2027',
    constructionMidpoint: 'Q3 2027',
    midpointAssumed: true,
    statedBudget: 11200000,
    programMix: [
      { use: 'Pool hall', sf: 21400 },
      { use: 'Locker / support', sf: 9700 },
      { use: 'Fitness', sf: 8200 },
      { use: 'Lobby / admin', sf: 6100 },
      { use: 'Back of house', sf: 3100 },
    ],
    requirements: [
      { type: 'exclude', text: 'Hazardous materials abatement — by owner under separate contract', cite: 'RFP §5.4' },
      { type: 'exclude', text: 'Elevator / conveying — single-storey, none in the DD set', cite: 'Drawing A0.01; Div 01 §1.9', appliesTo: ['D10'] },
      { type: 'include', text: 'Pool systems, filtration and water treatment in base scope', cite: 'RFP §4.1' },
      { type: 'include', text: 'LEED Gold certification target', cite: 'RFP §3.2' },
      { type: 'alternate', text: 'Rooftop solar array — price separately', cite: 'RFP §6.2 Alt 1' },
      { type: 'allowance', text: 'Site signage and wayfinding — $85,000 allowance', cite: 'Div 01 §1.11' },
    ],
  },
  lines: [],
};

export const fixtureProvider: DataProvider = {
  name: 'fixtures',

  async getCurrentUser() {
    return ME;
  },

  async getTaxonomy() {
    return TAXONOMY;
  },

  async getObservations(filters: LibraryFilters) {
    return OBSERVATIONS.filter((o) => {
      if (o.taxonomyCode !== filters.taxonomyCode) return false;
      if (filters.sectors?.length && !filters.sectors.includes(o.sector)) return false;
      if (filters.regions?.length && !filters.regions.includes(o.region)) return false;
      if (filters.minGrossSf != null && o.grossSf < filters.minGrossSf) return false;
      if (filters.maxGrossSf != null && o.grossSf > filters.maxGrossSf) return false;
      const types = filters.deliverableTypes ?? ['cost_estimate'];
      return types.includes(o.deliverableType);
    });
  },

  async getOpenQuestions() {
    return QUESTIONS;
  },

  async getPendingProfiles() {
    return PENDING;
  },

  async getActiveProfiles() {
    return ACTIVE;
  },

  async getEstimate(id: string) {
    return id === ESTIMATE.id ? ESTIMATE : null;
  },

  async listEstimates() {
    return [
      {
        id: ESTIMATE.id,
        name: ESTIMATE.name,
        status: ESTIMATE.status,
        updatedAt: ESTIMATE.updatedAt,
        createdByName: ESTIMATE.createdByName,
      },
    ];
  },
};

export { TAXONOMY };
