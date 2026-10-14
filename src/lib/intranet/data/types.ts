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
  /**
   * A project may have several clients, so this is an array — and it comes
   * from project_client_companies, not projects.client_name, which is empty
   * on all 1,874 rows. Empty array when the project has no client recorded.
   */
  clientNames: string[];
  sector: string;
  region: string;
  /**
   * The gross area the READER measured for this document and recorded on its
   * frame, not projects.gross_sf — which 020 cleared and which is null on all
   * 1,874 rows. Every $/SF figure in this observation uses this denominator,
   * and the frame records where it came from and how confident the reader was.
   */
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

/**
 * Which level of a document an observation was read at.
 *
 * `elemental` is one row per UNIFORMAT element off a document's summary tabs;
 * `detail` is one row per priced line off its working tabs. They describe the
 * same money at two resolutions, so pooling across them double-counts. See
 * migration 024.
 */
export type LineGrain = 'elemental' | 'detail';

export interface LibraryFilters {
  taxonomyCode: string;
  /**
   * Defaults to `elemental`. NEVER widen this to "both" — the elemental rows
   * for a section ARE its detail rows added up, so a pool containing both
   * counts the same cost twice and every statistic drawn from it is wrong by
   * a margin that looks plausible.
   */
  grain?: LineGrain;
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
 * One mirrored project, as a person would check it.
 *
 * Deliberately not the whole row. The question this answers is "does this
 * look right" — the client, what kind of work, where, and whether tasks
 * attached — which is the one check nobody can run on someone else's behalf.
 * A count of rows cannot answer it and neither can a query result pasted
 * into a conversation.
 *
 * `clients` is a list because 30 projects name two companies, which is why
 * migration 012 made it a join table rather than a column.
 */
export interface ProjectSummary {
  id: string;
  name: string;
  clients: string[];
  sector: string[];
  city: string[];
  taskCount: number;
}

/**
 * One row of the work list — a task, which is what a cost report actually
 * attaches to.
 *
 * THE GRAIN IS THE TASK, NOT THE PROJECT, AND THAT IS THE WHOLE POINT.
 *
 * A document belongs to one task. One project may carry many: the Bond
 * Planning job is a single project with nine tasks — three schools times
 * schematic/design-development/construction-documents — and four of the
 * sample reports belong to it. Asked to pick a project for those four, there
 * is no answer that distinguishes them, which is why the upload page's
 * project picker could never have worked no matter how good its search was.
 *
 * Picking a row here instead of a project means the file attaches to a
 * deliverable that already exists, mirrored from Airtable. Nothing is
 * created, so nothing can be orphaned.
 */
export interface TaskRow {
  /** deliverables.id — what an upload attaches to. */
  id: string;
  title: string;
  /** Multi-valued in Airtable: a task may be both 'Concept' and 'Option Study'. */
  taskType: string[];
  /**
   * Also multi-valued, and NOT only a number: the same field carries the
   * billing arrangement, so 'On-Call', 'Hourly', 'Pro Bono', 'No Bill' and
   * 'Split Task' appear alongside 'Task 1' and 'Task 2b'. Render as chips;
   * never parse it for an ordinal.
   */
  taskNumber: string[];
  projectManagers: string[];
  clients: string[];
  dueDate: string | null;
  /** Airtable's 'Phase II: On the Table (Workflow)' — ten states, 'Complete' last. */
  workflow: string | null;
  folderLink: string | null;
  projectId: string | null;
  projectName: string | null;
  /**
   * The project's fee proposal, e.g. 'FP-OR-2025-0088'. This is what DCW uses
   * as a project number. 89% of projects have one; the format varies enough
   * (`FPSEA-2019-0086c`) that it is matched by substring, never parsed.
   */
  projectFeeProposal: string | null;
  /** The task's own, which is the project's plus a suffix: 'FP-WA-2026-0106-2'. */
  taskFeeProposal: string | null;
  /** True once a cost report has been attached to this task. */
  hasFile: boolean;
  uploadedAt: string | null;
  /** deliverables.status — where the reader has got to with it. */
  ingestStatus: string;
}

/**
 * What to fetch. Deliberately narrow: these are the filters the database can
 * apply, so the page never has to hold all 5,560 tasks to show 398 of them.
 * Text search is done in the page over the returned set, which is small.
 */
export interface TaskFilters {
  /** Airtable's default view is 'Complete'. null means every state. */
  workflow?: string | null;
  /**
   * Due within this many days, matching Airtable's "the past year". Omit for
   * no date bound — which returns the 2,718 tasks with no due date too.
   */
  dueWithinDays?: number | null;
  /** true: only tasks that already have a file. false: only those without. */
  hasFile?: boolean | null;
}

/**
 * Something the sync could not handle, still unresolved.
 *
 * These are written on every run and have never been readable by anyone but
 * a person with database access. The list includes the records the sync
 * skipped and the values it had to drop, which is precisely the list someone
 * has to work through in Airtable — and could not see.
 */
export interface SyncAnomaly {
  id: number;
  seenAt: string;
  tableName: string;
  airtableRecordId: string | null;
  kind: string;
  fieldName: string | null;
  detail: string;
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
  /** Mirrored projects, for eyeballing what the sync loaded. Read-only. */
  listProjectSummaries(): Promise<ProjectSummary[]>;
  /**
   * The work list. Returns every task the filter matches — never a truncated
   * page — because a silently capped list is the exact bug this view replaces:
   * the upload page's project picker showed the first 500 of 1,874 projects
   * alphabetically, so three-quarters of them could not be chosen and people
   * typed a new project name instead, creating an orphan.
   */
  listTasks(filters: TaskFilters): Promise<TaskRow[]>;
  /** Unresolved sync anomalies, newest first. Read-only. */
  listOpenAnomalies(): Promise<SyncAnomaly[]>;
}
