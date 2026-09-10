/**
 * Domain types for the cost library.
 *
 * These mirror the tables in docs/team-intranet/schema.sql. They are the
 * contract between the pages and whatever is supplying data — fixtures today,
 * Supabase once the project exists — so pages never import a provider directly.
 */

export type ConfidenceLevel = 'green' | 'amber' | 'red';
export type CostBasis = 'bare' | 'loaded' | 'undetermined';
export type CodingSystem =
  | 'uniformat'
  | 'masterformat'
  | 'in_house'
  | 'mixed'
  | 'none'
  | 'undetermined';

export type DeliverableType =
  | 'cost_estimate'
  | 'estimate_review'
  | 'reconciliation'
  | 'rom'
  | 'other';

export type DesignPhase =
  | 'concept'
  | 'schematic'
  | 'design_development'
  | 'construction_documents'
  | 'bid'
  | 'unknown';

export interface Profile {
  id: string;
  fullName: string;
  email: string;
  role: 'admin' | 'estimator' | 'viewer';
  status: 'pending' | 'active' | 'revoked';
  requestedAt?: string;
}

export interface TaxonomyNode {
  code: string;
  parentCode: string | null;
  level: 1 | 2 | 3;
  title: string;
}

/**
 * One line item from one historical deliverable, joined to everything needed to
 * judge and display it. The read model behind `v_observations`.
 */
export interface Observation {
  lineItemId: string;
  taxonomyCode: string;
  rawDescription: string;

  /** As written in the source document. Never altered. */
  unitCost: number;
  /** Reduced to a bare basis using the document's markup factor. */
  bareCostPerSf: number;
  /** Bare, then escalated to the current period. This is the poolable figure. */
  escalatedBareCostPerSf: number;
  basis: CostBasis;

  projectId: string;
  projectName: string;
  clientName: string;
  sector: string;
  region: string;
  grossSf: number;
  deliverableType: DeliverableType;
  phase: DesignPhase;
  issueDate: string;
  estimator: string;
  boxFileUrl: string;

  markupFactor: number;
  markupComponents: Array<{ label: string; pct: number }>;
  /** True when this observation rests on a reader assumption nobody confirmed. */
  hasOpenAssumption: boolean;
}

export interface LibraryFilters {
  taxonomyCode: string;
  sectors?: string[];
  regions?: string[];
  minGrossSf?: number;
  maxGrossSf?: number;
  phases?: DesignPhase[];
  /** Defaults to cost estimates only — reviews are not DCW's own pricing. */
  deliverableTypes?: DeliverableType[];
}

export type QuestionKind =
  | 'coding_system'
  | 'gross_area'
  | 'markup_basis'
  | 'deliverable_type'
  | 'pricing_base_date'
  | 'reconciliation'
  | 'taxonomy_mapping'
  | 'other';

export interface ReaderQuestion {
  id: string;
  deliverableId: string;
  documentName: string;
  projectName: string;
  kind: QuestionKind;
  /** `question` blocks the document; `assumption` is proposed and usable. */
  mode: 'question' | 'assumption';
  state: 'open' | 'answered' | 'confirmed' | 'corrected';
  prompt: string;
  evidence: string;
  proposedAnswer?: string;
  options?: string[];
  answer?: string;
  answeredByName?: string;
  answeredAt?: string;
  boxFileUrl: string;
}

export type LineDisposition =
  | 'proposed'
  | 'accepted'
  | 'overridden'
  | 'excluded_by_requirement'
  | 'left_blank'
  | 'manually_added';

export interface EstimateLine {
  id: string;
  taxonomyCode: string;
  title: string;
  note?: string;
  confidence: ConfidenceLevel | 'excluded';
  /** Null for a red-gated line: blank on purpose, never a guessed number. */
  suggestedRate: number | null;
  suggestedReason: string;
  sampleN: number;
  disposition: LineDisposition;
  finalRate: number | null;
  excludedSource?: string;
  blankReason?: string;
  observations: Array<{ label: string; value: string; excluded?: boolean }>;
  attribution?: string;
}

export interface EstimateBrief {
  grossSf: number;
  sector: string;
  location: string;
  deliveryMethod: string;
  phase: string;
  constructionStart: string;
  constructionMidpoint: string;
  midpointAssumed: boolean;
  statedBudget: number | null;
  programMix: Array<{ use: string; sf: number }>;
  requirements: Array<{
    type: 'include' | 'exclude' | 'alternate' | 'allowance';
    text: string;
    cite: string;
    /**
     * Elements this requirement governs, as the reader resolved them. This is
     * what lets an exclusion show up on the face of the estimate as "left out
     * on purpose, per RFP §5.4" rather than as a silent omission.
     */
    appliesTo?: string[];
  }>;
}

export interface EstimateInput {
  filename: string;
  kind: string;
  status: string;
}

export interface Estimate {
  id: string;
  name: string;
  status: string;
  createdByName: string;
  updatedAt: string;
  brief: EstimateBrief;
  inputs: EstimateInput[];
  lines: EstimateLine[];
}

/**
 * Everything a page needs. Implemented by fixtures now and by Supabase later;
 * pages depend on this shape and nothing else.
 */
export interface DataProvider {
  readonly name: string;
  getCurrentUser(): Promise<Profile>;
  getTaxonomy(): Promise<TaxonomyNode[]>;
  getObservations(filters: LibraryFilters): Promise<Observation[]>;
  getOpenQuestions(): Promise<ReaderQuestion[]>;
  getPendingProfiles(): Promise<Profile[]>;
  getActiveProfiles(): Promise<Profile[]>;
  getEstimate(id: string): Promise<Estimate | null>;
  listEstimates(): Promise<Array<Pick<Estimate, 'id' | 'name' | 'status' | 'updatedAt' | 'createdByName'>>>;
}
