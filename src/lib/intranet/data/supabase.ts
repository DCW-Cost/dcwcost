/**
 * The real provider: the cost library, served from Postgres.
 *
 * This is the sibling of `fixtures.ts`. Same interface, same shapes — the
 * difference is that these numbers came out of documents DCW actually issued.
 *
 * ---------------------------------------------------------------------------
 * Why this is a factory rather than a singleton
 *
 * `fixtures.ts` can be a module-level constant because invented data has no
 * owner. Real data does. Every query here runs through the signed-in person's
 * own cookie session, which is what makes row-level security the thing actually
 * enforcing access — exactly as PLAN.md §9 requires:
 *
 *   "RLS deny-by-default on every table. Policy lives in the database. The
 *    service-role key never reaches the browser."
 *
 * The alternative — a module-level client holding a service-role key — would
 * move enforcement out of the database and into whatever the calling code
 * happens to remember to check. That is the failure this schema was built to
 * avoid, and four separate documents in this repo say not to do it.
 *
 * So the provider must be built per request, and pages ask for it by handing
 * over the request they are already holding:
 *
 *   const provider = getProvider(Astro.cookies, Astro.request);
 *
 * One line per page, and nothing downstream can forget who is asking.
 *
 * Note that access here is not per-person row filtering: PLAN.md §9 settles
 * that every active user sees every client, matching Airtable today. The
 * policies check that the caller is an active user at all. Carrying the session
 * is what satisfies that check.
 * ---------------------------------------------------------------------------
 */
import type { AstroCookies } from 'astro';
import { serverClient } from '../auth.ts';
import type {
  CostBasis,
  DataProvider,
  DeliverableType,
  DesignPhase,
  Estimate,
  EstimateBrief,
  EstimateLine,
  LibraryFilters,
  LineDisposition,
  Observation,
  Profile,
  ReaderQuestion,
  TaxonomyNode,
} from './types.ts';

/** Rows come back as loose JSON; narrow at the boundary rather than trusting it. */
type Row = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number => {
  // Postgres numeric arrives as a string through PostgREST — parse, never assume.
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
};
const bool = (v: unknown): boolean => v === true;

/** A jsonb array of {label, pct}. Anything else becomes an empty list. */
function markupComponents(v: unknown): Array<{ label: string; pct: number }> {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is Row => typeof x === 'object' && x !== null)
    .map((x) => ({ label: str(x.label), pct: num(x.pct) }));
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => str(x)).filter(Boolean);
}

/**
 * Thrown when the provider is asked for data it cannot fetch. Pages should let
 * this surface rather than catching it into an empty list — an empty library
 * and an unreachable one must never look the same on screen.
 */
export class ProviderError extends Error {
  constructor(operation: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Cost library query failed (${operation}): ${detail}`);
    this.name = 'ProviderError';
  }
}

export function createSupabaseProvider(
  cookies: AstroCookies,
  request: Request,
): DataProvider {
  const db = serverClient(cookies, request);
  if (!db) {
    throw new Error(
      'INTRANET_DATA=supabase but Supabase is not configured. ' +
        'Set SUPABASE_URL and SUPABASE_ANON_KEY, then redeploy — environment ' +
        'variables only take effect on a new build.',
    );
  }

  /** Every read goes through here so failures are uniform and loud. */
  async function rows(operation: string, build: () => PromiseLike<{ data: unknown; error: unknown }>) {
    const { data, error } = await build();
    if (error) throw new ProviderError(operation, error);
    return Array.isArray(data) ? (data as Row[]) : [];
  }

  /**
   * As `rows`, but pages through the whole result set.
   *
   * PostgREST caps an unbounded select at 1,000 rows and says nothing about it.
   * For a statistics engine that is the worst possible failure: a pool silently
   * missing its tail still produces a median, a confidence light and a trend,
   * all of them wrong and none of them complaining. So paging is explicit, and
   * hitting the ceiling is an error rather than a quiet truncation.
   */
  async function allRows(
    operation: string,
    build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
  ) {
    const PAGE = 1000;
    const MAX_ROWS = 200_000; // ~1,235 deliverables x 40-120 line items, with headroom.
    const out: Row[] = [];

    for (let from = 0; from < MAX_ROWS; from += PAGE) {
      const { data, error } = await build(from, from + PAGE - 1);
      if (error) throw new ProviderError(operation, error);
      const page = Array.isArray(data) ? (data as Row[]) : [];
      out.push(...page);
      if (page.length < PAGE) return out;
    }

    throw new ProviderError(
      operation,
      `more than ${MAX_ROWS} rows matched; refusing to return a truncated pool`,
    );
  }

  // -------------------------------------------------------------------------
  // Mappers. One per shape, so the column-name coupling lives in one place.
  // -------------------------------------------------------------------------

  const toProfile = (r: Row): Profile => ({
    id: str(r.id),
    fullName: str(r.full_name),
    email: str(r.email),
    role: str(r.role) as Profile['role'],
    status: str(r.status) as Profile['status'],
    requestedAt: strOrNull(r.created_at) ?? undefined,
  });

  const toTaxonomyNode = (r: Row): TaxonomyNode => ({
    code: str(r.code),
    parentCode: strOrNull(r.parent_code),
    level: num(r.level) as 1 | 2 | 3,
    title: str(r.title),
  });

  const toObservation = (r: Row): Observation => ({
    lineItemId: str(r.line_item_id),
    taxonomyCode: str(r.taxonomy_code),
    rawDescription: str(r.raw_description),

    // These are numbers by contract, and the query below drops any row where
    // the poolable figure is missing — so a null here never becomes a $0
    // observation dragging a median down without appearing in the source list.
    unitCost: num(r.unit_cost),
    bareCostPerSf: num(r.bare_cost_per_project_sf),
    escalatedBareCostPerSf: num(r.escalated_bare_cost_per_project_sf),
    basis: str(r.basis) as CostBasis,

    projectId: str(r.project_id),
    projectName: str(r.project_name),
    clientName: str(r.client_name),
    sector: str(r.sector),
    region: str(r.region),
    grossSf: num(r.project_gross_sf),
    deliverableType: str(r.deliverable_type) as DeliverableType,
    phase: str(r.phase) as DesignPhase,
    issueDate: str(r.issue_date),
    estimator: str(r.estimator),
    boxFileUrl: str(r.box_file_url),

    markupFactor: num(r.markup_factor),
    markupComponents: markupComponents(r.markup_components),
    hasOpenAssumption: bool(r.has_open_assumption),
  });

  /**
   * Reader questions need the document and project they belong to, which
   * `v_question_answers` does not carry. Joined here through the foreign keys
   * rather than by widening the view, so nothing outside this file changes.
   */
  const toReaderQuestion = (r: Row): ReaderQuestion => {
    const deliverable = (r.deliverables ?? {}) as Row;
    const project = (deliverable.projects ?? {}) as Row;
    const answeredBy = (r.answered_by_profile ?? {}) as Row;

    return {
      id: str(r.id),
      deliverableId: str(r.deliverable_id),
      documentName: str(deliverable.original_filename) || str(deliverable.airtable_record_id),
      projectName: str(project.name),
      kind: str(r.kind) as ReaderQuestion['kind'],
      mode: str(r.mode) as ReaderQuestion['mode'],
      state: str(r.state) as ReaderQuestion['state'],
      prompt: str(r.prompt),
      evidence: str(r.evidence),
      proposedAnswer: r.proposed_answer == null ? undefined : str(r.proposed_answer),
      options: Array.isArray(r.options) ? stringList(r.options) : undefined,
      answer: r.answer == null ? undefined : str(r.answer),
      answeredByName: strOrNull(answeredBy.full_name) ?? undefined,
      answeredAt: strOrNull(r.answered_at) ?? undefined,
      boxFileUrl: str(deliverable.box_file_url),
    };
  };

  /**
   * KNOWN GAP, deliberately left as it was — see the note at the end of this
   * file. A missing brief, and a brief whose gross_sf has not been read yet,
   * both map to 0 GSF here. That is a real denominator problem and the honest
   * fix changes `Estimate.brief` and `EstimateBrief.grossSf` to nullable in
   * types.ts, which is a contract change affecting every page that divides by
   * area. Not smuggled into this PR.
   */
  const toEstimateBrief = (r: Row | null): EstimateBrief => {
    const b = r ?? {};
    // The four requirement kinds are stored as separate jsonb columns; the
    // interface wants one list carrying its type. Flattened here.
    const requirements: EstimateBrief['requirements'] = [];
    const kinds = [
      ['include', b.inclusions],
      ['exclude', b.exclusions],
      ['alternate', b.alternates],
      ['allowance', b.allowances],
    ] as const;
    for (const [type, raw] of kinds) {
      if (!Array.isArray(raw)) continue;
      for (const item of raw) {
        if (typeof item === 'string') {
          requirements.push({ type, text: item, cite: '' });
        } else if (item && typeof item === 'object') {
          const o = item as Row;
          requirements.push({
            type,
            text: str(o.text),
            cite: str(o.cite),
            appliesTo: Array.isArray(o.appliesTo) ? stringList(o.appliesTo) : undefined,
          });
        }
      }
    }

    const mix = Array.isArray(b.program_mix)
      ? (b.program_mix as Row[]).map((m) => ({ use: str(m.use), sf: num(m.sf) }))
      : [];

    return {
      grossSf: num(b.gross_sf),
      sector: str(b.sector),
      location: str(b.region),
      deliveryMethod: str(b.delivery_method),
      phase: str(b.phase),
      constructionStart: str(b.construction_start),
      constructionMidpoint: str(b.construction_midpoint),
      // The reader marks an inferred midpoint by leaving the stored value null
      // and deriving it; surface that rather than presenting a guess as stated.
      midpointAssumed: b.construction_midpoint == null,
      statedBudget: numOrNull(b.stated_budget),
      programMix: mix,
      requirements,
    };
  };

  const toEstimateLine = (r: Row): EstimateLine => {
    const taxonomy = (r.taxonomy ?? {}) as Row;
    const decidedBy = (r.decided_by_profile ?? {}) as Row;
    const disposition = str(r.disposition) as LineDisposition;
    return {
      id: str(r.id),
      taxonomyCode: str(r.taxonomy_code),
      title: str(taxonomy.title),
      note: strOrNull(r.override_reason) ?? undefined,
      confidence: str(r.suggested_confidence) as EstimateLine['confidence'],
      // Null is meaningful: a red-gated line is blank on purpose (PLAN.md §8).
      suggestedRate: numOrNull(r.suggested_rate),
      suggestedReason: str(r.suggested_reason),
      sampleN: num(r.sample_n),
      disposition,
      finalRate: numOrNull(r.final_rate),
      excludedSource: strOrNull(r.excluded_source) ?? undefined,
      // Only a deliberately blank line has a blank reason. Reusing
      // suggested_reason for every line would put "why this is blank" on lines
      // that carry a rate, which reads as a contradiction on the face of the
      // estimate.
      blankReason:
        disposition === 'left_blank'
          ? strOrNull(r.suggested_reason) ?? undefined
          : undefined,
      // Per-line source observations are resolved from `sample_query` at display
      // time rather than stored on the line, so they are not populated here.
      observations: [],
      // The person who decided the line, by name. decided_by is a uuid; showing
      // it raw would put an opaque id where a reviewer expects "Trish said so".
      attribution: strOrNull(decidedBy.full_name) ?? undefined,
    };
  };

  // -------------------------------------------------------------------------
  // The interface.
  // -------------------------------------------------------------------------

  return {
    name: 'supabase',

    async getCurrentUser(): Promise<Profile> {
      const { data: auth, error: authError } = await db.auth.getUser();
      if (authError) throw new ProviderError('getCurrentUser', authError);
      const id = auth?.user?.id;
      if (!id) throw new ProviderError('getCurrentUser', 'no signed-in user');

      const found = await rows('getCurrentUser', () =>
        db.from('profiles').select('*').eq('id', id).limit(1),
      );
      if (!found.length) throw new ProviderError('getCurrentUser', 'no profile row');
      return toProfile(found[0]);
    },

    async getTaxonomy(): Promise<TaxonomyNode[]> {
      const found = await rows('getTaxonomy', () =>
        db
          .from('taxonomy')
          .select('code, parent_code, level, title')
          .eq('active', true)
          .order('code'),
      );
      return found.map(toTaxonomyNode);
    },

    async getObservations(filters: LibraryFilters): Promise<Observation[]> {
      // `like('taxonomy_code', '%')` matches every row in the archive, so an
      // empty code would quietly return the whole library where the caller
      // asked for one element — a pool nobody chose, with a confidence light
      // on top of it. Refuse instead.
      if (!filters.taxonomyCode) {
        throw new ProviderError('getObservations', 'no taxonomy code given');
      }

      const found = await allRows('getObservations', (from, to) => {
        let q = db
          .from('v_observations')
          .select('*')
          // Descendants of the requested node, not just exact matches: asking for
          // A10 should return A1010 and A1020 too.
          .like('taxonomy_code', `${filters.taxonomyCode}%`)
          // Markup rows are the stack, not priced work. Never pooled.
          .eq('is_markup', false)
          // A superseded issuance is kept as evidence but excluded by default
          // (PLAN.md §12, version history).
          .eq('is_latest_version', true)
          // A document whose markup basis the reader could not determine is held
          // out of the pool entirely (PLAN.md §5.4 and §7 step 1).
          .neq('basis', 'undetermined')
          // A line with no poolable figure is not an observation. NIC, "included
          // above" and unpriced scope all land here; counting them as zero would
          // understate every statistic they touched.
          .not('escalated_bare_cost_per_project_sf', 'is', null);

        // Estimate reviews are someone else's numbers. Mixing them into DCW's
        // own pricing history would poison every statistic downstream, so the
        // default is DCW's own estimates only (PLAN.md §5.1).
        // `?? ` alone would let an explicitly empty array through, which reads
        // as "no type filter" to a caller and returns nothing from PostgREST.
        // Either way the estimate-reviews guard is lost, so length is what
        // decides.
        const types = filters.deliverableTypes?.length
          ? filters.deliverableTypes
          : (['cost_estimate'] as DeliverableType[]);
        q = q.in('deliverable_type', types);

        if (filters.sectors?.length) q = q.in('sector', filters.sectors);
        if (filters.regions?.length) q = q.in('region', filters.regions);
        if (filters.phases?.length) q = q.in('phase', filters.phases);
        if (filters.minGrossSf != null) q = q.gte('project_gross_sf', filters.minGrossSf);
        if (filters.maxGrossSf != null) q = q.lte('project_gross_sf', filters.maxGrossSf);

        // The tiebreaker is not cosmetic. Paging by position requires a total
        // order, and every line from one document shares an issue date — so
        // with ties, Postgres may return them differently on each page request
        // and a boundary falling inside a tie silently duplicates some rows and
        // drops others. line_item_id is unique, which makes the order total.
        return q
          .order('issue_date', { ascending: false })
          .order('line_item_id', { ascending: true })
          .range(from, to);
      });

      return found.map(toObservation);
    },

    async getOpenQuestions(): Promise<ReaderQuestion[]> {
      const found = await rows('getOpenQuestions', () =>
        db
          .from('reader_questions')
          .select(
            `id, deliverable_id, kind, mode, state, prompt, evidence,
             proposed_answer, options, answer, answered_at, created_at,
             answered_by_profile:profiles!reader_questions_answered_by_fkey(full_name),
             deliverables(original_filename, airtable_record_id, box_file_url,
                          projects(name))`,
          )
          .eq('state', 'open')
          // Blocking questions first: they hold a document out of the library,
          // where an assumption is usable while it waits (PLAN.md §6.4).
          // Ascending is correct here — Postgres orders an enum by declaration
          // order, and question_mode declares 'question' before 'assumption'.
          // (Alphabetically it would be the other way round; verified against
          // pg_enum rather than assumed.)
          .order('mode', { ascending: true })
          .order('created_at', { ascending: true }),
      );
      return found.map(toReaderQuestion);
    },

    async getPendingProfiles(): Promise<Profile[]> {
      const found = await rows('getPendingProfiles', () =>
        db.from('profiles').select('*').eq('status', 'pending').order('created_at'),
      );
      return found.map(toProfile);
    },

    async getActiveProfiles(): Promise<Profile[]> {
      const found = await rows('getActiveProfiles', () =>
        db.from('profiles').select('*').eq('status', 'active').order('full_name'),
      );
      return found.map(toProfile);
    },

    async getEstimate(id: string): Promise<Estimate | null> {
      const found = await rows('getEstimate', () =>
        db
          .from('estimates')
          .select(
            `id, name, status, created_at, updated_at,
             created_by_profile:profiles!estimates_created_by_fkey(full_name),
             estimate_briefs(*),
             estimate_inputs(filename, input_kind, read_status),
             estimate_lines(*, taxonomy(title),
                            decided_by_profile:profiles!estimate_lines_decided_by_fkey(full_name))`,
          )
          .eq('id', id)
          .limit(1),
      );
      if (!found.length) return null;

      const r = found[0];
      const createdBy = (r.created_by_profile ?? {}) as Row;
      const briefRows = r.estimate_briefs;
      const brief = Array.isArray(briefRows) ? ((briefRows[0] ?? null) as Row | null) : (briefRows as Row | null);
      const inputs = Array.isArray(r.estimate_inputs) ? (r.estimate_inputs as Row[]) : [];
      const lines = Array.isArray(r.estimate_lines) ? (r.estimate_lines as Row[]) : [];

      return {
        id: str(r.id),
        name: str(r.name),
        status: str(r.status),
        createdByName: str(createdBy.full_name),
        updatedAt: str(r.updated_at),
        brief: toEstimateBrief(brief),
        inputs: inputs.map((i) => ({
          filename: str(i.filename),
          kind: str(i.input_kind),
          status: str(i.read_status),
        })),
        lines: lines
          .slice()
          .sort((a, b) => num(a.sort_order) - num(b.sort_order))
          .map(toEstimateLine),
      };
    },

    async listEstimates() {
      const found = await rows('listEstimates', () =>
        db
          .from('estimates')
          .select(
            `id, name, status, updated_at,
             created_by_profile:profiles!estimates_created_by_fkey(full_name)`,
          )
          .order('updated_at', { ascending: false }),
      );
      return found.map((r) => {
        const createdBy = (r.created_by_profile ?? {}) as Row;
        return {
          id: str(r.id),
          name: str(r.name),
          status: str(r.status),
          updatedAt: str(r.updated_at),
          createdByName: str(createdBy.full_name),
        };
      });
    },
  };
}

/**
 * Open items, recorded here rather than lost in a thread.
 *
 * 1. A missing brief, or a brief with no gross area yet, reads as 0 GSF.
 *    `estimate_briefs` is a separate table with no trigger creating it, and the
 *    `draft` and `reading_inputs` statuses both precede `brief_review` — so an
 *    estimate normally has no brief while its inputs are being read. Zero is
 *    the denominator for every $/GSF figure, so this needs fixing before the
 *    Estimate Builder is used in anger. The fix is nullable `brief` and
 *    nullable `grossSf` in types.ts, which makes the type-checker find every
 *    page that divides without checking. That is a contract change and belongs
 *    in its own PR.
 *
 * 2. The requirement mapper reads `{ text, cite }` from the jsonb requirement
 *    columns. schema.sql documents them as `{ scope, source }`. Nothing has
 *    written one yet, so neither shape is confirmed — settle it when the reader
 *    is built, and make the writer and this reader agree.
 *
 * Both are harmless today: `estimates` is empty. Neither should survive to the
 * point where an estimator sees a number.
 */
