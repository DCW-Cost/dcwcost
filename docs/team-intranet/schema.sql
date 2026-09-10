-- ============================================================================
-- DCW Team Intranet — historical cost database
-- Target: Postgres 15+ / Supabase
--
-- Design notes:
--   * Airtable stays the system of record for projects and deliverables.
--     Everything mirrored from it carries an `airtable_record_id` and is
--     refreshed by a one-way sync. Never write back to those columns.
--   * Raw extracted values are never overwritten. Every normalized column sits
--     NEXT TO its raw source, so a bad mapping — or a reader assumption later
--     corrected — is always recoverable by recomputing from raw.
--   * The reader interprets; it never calculates. All math (totals, unit
--     conversion, markup stripping, escalation, statistics) happens here or in
--     the analytics layer, from values the reader read off the page.
--   * Every line item's meaning depends on its document's frame — how that
--     document was coded, what area it was priced against, where its markups
--     live. Frames are therefore stored explicitly (§3b), not left implicit.
--   * All active users see all clients, as they do in Airtable today. There is
--     no per-client tiering. RLS is still deny-by-default on every table (§7).
-- ============================================================================

create extension if not exists "pgcrypto";

-- ============================================================================
-- 1. Identity and access
-- ============================================================================

create type user_status as enum ('pending', 'active', 'revoked');
create type user_role   as enum ('admin', 'estimator', 'viewer');

-- Extends Supabase auth.users. A row is created on first Entra ID sign-in with
-- status='pending'; an admin flips it to 'active'.
create table profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  email           text not null unique,
  full_name       text,
  status          user_status not null default 'pending',
  role            user_role   not null default 'viewer',
  approved_by     uuid references profiles(id),
  approved_at     timestamptz,
  revoked_by      uuid references profiles(id),
  revoked_at      timestamptz,
  last_seen_at    timestamptz,
  created_at      timestamptz not null default now(),

  -- Hard domain gate. Belt and braces with the check in the auth hook.
  constraint dcw_email_only check (email like '%@dcwcost.com')
);

create index on profiles (status) where status = 'pending';

-- Helper used throughout the RLS policies below.
create or replace function is_active_user() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and status = 'active'
  );
$$;

create or replace function is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and status = 'active' and role = 'admin'
  );
$$;

-- ---------------------------------------------------------------------------
-- Profile creation.
--
-- Profiles are created by a trigger, never by the client. If the app inserted
-- its own row it would need an INSERT policy, and any policy permissive enough
-- to allow that also lets someone insert themselves as an active admin. The
-- trigger runs as the definer, so the app needs no write access at all and the
-- status/role columns cannot be chosen by the person signing up.
--
-- Bootstrap: the first admin cannot be approved by an existing admin, so seed
-- `bootstrap_admins` before anyone signs in. Those addresses come out active
-- and admin; everyone else lands pending.
-- ---------------------------------------------------------------------------

create table bootstrap_admins (
  email       text primary key,
  note        text,
  created_at  timestamptz not null default now()
);

create or replace function handle_new_auth_user() returns trigger
  language plpgsql security definer set search_path = public, auth as $$
declare
  addr   text := lower(coalesce(new.email, ''));
  domain text := lower(coalesce(
                   current_setting('app.intranet_email_domain', true),
                   'dcwcost.com'));
  boot   boolean;
begin
  -- Domain gate, enforced in the database as well as the app. An outside guest
  -- account in the tenant gets no profile row at all, so it can never be
  -- approved by mistake.
  if addr = '' or addr not like ('%@' || domain) then
    return new;
  end if;

  select exists (select 1 from bootstrap_admins b where lower(b.email) = addr)
    into boot;

  insert into profiles (id, email, full_name, role, status, approved_at)
  values (
    new.id,
    addr,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(addr, '@', 1)
    ),
    case when boot then 'admin'::user_role else 'viewer'::user_role end,
    case when boot then 'active'::user_status else 'pending'::user_status end,
    case when boot then now() else null end
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_auth_user();

-- ============================================================================
-- 2. Reference data
-- ============================================================================

-- UniFormat II (ASTM E1557) is the spine. Level 1 = A, B, C…
-- Level 2 = A10, Level 3 = A1010. Self-referencing so the UI can render a tree.
create table taxonomy (
  code            text primary key,              -- 'A10', 'A1010'
  parent_code     text references taxonomy(code),
  level           smallint not null check (level between 1 and 3),
  title           text not null,                 -- 'Foundations'
  masterformat    text[],                        -- optional CSI cross-reference
  active          boolean not null default true
);

create index on taxonomy (parent_code);

-- Unit families. Conversion is only ever permitted WITHIN a family — a lump sum
-- is not secretly some number of lineal feet, and the tool must never pretend
-- otherwise. Cross-family comparison happens via $/GSF and % of total instead.
create type unit_family as enum
  ('area', 'length', 'volume', 'weight', 'count', 'lump_sum', 'time');

create table units (
  code            text primary key,              -- 'SF', 'CY', 'LF', 'EA', 'LS'
  label           text not null,
  family          unit_family not null,
  -- Factor to the family's base unit (area→SF, length→LF, volume→CF, weight→LB).
  -- NULL for lump_sum and count, which have no meaningful conversion.
  to_base_factor  numeric(20,10)
);

-- Quarterly construction cost index, per region. Start by deriving DCW's own
-- from repeat line items in its own archive, then cross-check against ENR
-- Seattle CCI. Every computed result records the index version it used.
create table cost_indices (
  id              bigserial primary key,
  region          text not null,                 -- 'Seattle', 'Portland', 'PNW'
  period          date not null,                 -- first day of the quarter
  index_value     numeric(10,4) not null,
  source          text not null,                 -- 'dcw_internal_v1', 'enr_cci'
  version         text not null,
  created_at      timestamptz not null default now(),
  unique (region, period, source, version)
);

-- ============================================================================
-- 3. Projects and deliverables (mirrored from Airtable)
-- ============================================================================

create table projects (
  id                  uuid primary key default gen_random_uuid(),
  airtable_record_id  text unique not null,
  name                text not null,
  client_name         text,
  sector              text,          -- healthcare, civic, K-12, MEP, parks…
  market              text,
  region              text,          -- joins cost_indices.region
  city                text,
  gross_sf            numeric(14,2), -- the universal normalizer. See PLAN §5.3
  stories             smallint,
  delivery_method     text,          -- DBB, CM/GC, design-build, progressive
  construction_start  date,
  project_status      text,
  synced_at           timestamptz not null default now()
);

create index on projects (sector);
create index on projects (region);
create index on projects (gross_sf);

-- A deliverable's TYPE is load-bearing. An estimate review is a critique of
-- someone else's numbers, not DCW pricing, and must never be pooled with
-- DCW's own estimates. Rachel flagged this explicitly on 2026-09-09.
create type deliverable_type as enum
  ('cost_estimate', 'estimate_review', 'reconciliation', 'rom', 'other');

create type design_phase as enum
  ('concept', 'schematic', 'design_development', 'construction_documents',
   'bid', 'unknown');

-- 'needs_answer' is a BLOCKING reader question — the document stays out of the
-- library until a human resolves it. 'accepted' documents may still carry
-- unconfirmed assumptions; those are non-blocking and tracked on the frame.
create type ingest_status as enum
  ('pending', 'downloading', 'framing', 'extracting', 'reconciling',
   'needs_answer', 'accepted', 'failed', 'skipped');

create table deliverables (
  id                  uuid primary key default gen_random_uuid(),
  airtable_record_id  text unique not null,
  project_id          uuid not null references projects(id) on delete cascade,

  type                deliverable_type not null default 'cost_estimate',
  phase               design_phase not null default 'unknown',
  version             smallint not null default 1,
  is_latest_version   boolean not null default true,

  issue_date          date,
  estimator           text,          -- who authored it. Drives the
                                     -- "≥2 distinct estimators" confidence rule
  box_file_url        text,
  source_format       text,          -- 'xlsx' | 'pdf'
  file_checksum       text,          -- re-ingest detection

  -- How this document handles markups, what area it is priced against, and how
  -- it is coded all live on its frame (§3b) rather than here, because each is a
  -- reader determination with its own evidence and confidence.

  stated_total_cost   numeric(16,2), -- the check figure, as printed
  currency            char(3) not null default 'USD',

  status              ingest_status not null default 'pending',
  upload_notes        text,          -- carried over from Airtable
  synced_at           timestamptz not null default now(),
  ingested_at         timestamptz
);

create index on deliverables (project_id);
create index on deliverables (type, phase);
create index on deliverables (issue_date);
create index on deliverables (status) where status in ('needs_answer', 'failed');

-- ============================================================================
-- 3b. Document frames — what the reader understood before extracting
--
-- The same "$13.20" means different things depending on whether it is loaded,
-- what area it is priced against, and what date it is priced to. Pass one of
-- the reader establishes exactly that, and it is recorded here with evidence
-- and confidence per determination. Every derived figure in `line_items`
-- depends on this row being right, so a corrected frame recomputes them.
-- See PLAN §6.2.
-- ============================================================================

create type coding_system as enum
  ('uniformat', 'masterformat', 'in_house', 'mixed', 'none', 'undetermined');

-- Where element rates sit relative to the document's markup stack.
create type cost_basis as enum ('bare', 'loaded', 'undetermined');

create table document_frames (
  id                  uuid primary key default gen_random_uuid(),
  deliverable_id      uuid not null unique
                        references deliverables(id) on delete cascade,

  -- ---- Coding ----
  coding_system       coding_system not null default 'undetermined',
  coding_confidence   numeric(4,3),
  coding_evidence     text,          -- what in the document indicated it

  -- ---- The denominator for every $/GSF figure ----
  gsf_used            numeric(14,2),
  gsf_source          text,          -- 'cover_sheet' | 'summary_block' |
                                     -- 'airtable' | 'back_calculated' | 'assumed'
  gsf_confidence      numeric(4,3),
  gsf_evidence        text,          -- 'p.2 summary block; totals reconcile
                                     --  to 0.3%; Airtable agrees'

  -- ---- Markup structure. See PLAN §5.4 ----
  basis               cost_basis not null default 'undetermined',
  markup_factor       numeric(8,5),  -- loaded = bare x factor. 1.0 when bare.
  markup_components   jsonb,         -- [{label:'General conditions', pct:8.5},
                                     --  {label:"GC's fee", pct:5.0}, …]
  markup_confidence   numeric(4,3),
  markup_evidence     text,

  -- ---- Escalation starting point. Often NOT the issue date. PLAN §5.5 ----
  pricing_base_date   date,
  base_date_source    text,          -- 'stated' | 'issue_date_fallback'

  -- ---- Pass three: does it add up? PLAN §6.4 ----
  extracted_total     numeric(16,2), -- sum of what the reader pulled
  reconciles          boolean,
  reconciliation_delta_pct numeric(8,4),
  reconciliation_note text,          -- the explanation, where there is one

  -- ---- Provenance ----
  reader_version      text not null,
  framing_model       text,          -- e.g. 'claude-opus-5'
  extraction_model    text,          -- e.g. 'claude-sonnet-5' or 'template_parser'
  conventions_applied bigint[],      -- reader_conventions.id, see §5b
  has_open_assumption boolean not null default false,
  created_at          timestamptz not null default now()
);

create index on document_frames (deliverable_id);
create index on document_frames (has_open_assumption) where has_open_assumption;
create index on document_frames (reconciles) where reconciles is false;

-- ============================================================================
-- 4. The observations
-- ============================================================================

create table line_items (
  id                  uuid primary key default gen_random_uuid(),
  deliverable_id      uuid not null references deliverables(id) on delete cascade,
  sort_order          integer,

  -- ---- Raw, exactly as extracted. Never overwritten. ----
  raw_description     text not null,
  raw_code            text,                       -- whatever code appeared
  raw_uom             text,
  raw_quantity        numeric(18,4),
  raw_unit_cost       numeric(16,4),
  raw_total_cost      numeric(16,2),

  -- ---- Normalized. Rebuildable from raw at any time. ----
  taxonomy_code       text references taxonomy(code),
  uom_canonical       text references units(code),
  quantity            numeric(18,4),
  unit_cost           numeric(16,4),
  total_cost          numeric(16,2),

  -- ---- Derived comparators. See PLAN §5.3. ----
  -- Always computable when the frame established a gross area — this is what
  -- makes a lump-sum row comparable to a per-CY row.
  cost_per_project_sf numeric(16,6),
  pct_of_total        numeric(8,5),

  -- ---- Bare vs. loaded. See PLAN §5.4. ----
  -- `unit_cost` above is always as-written. These are the same rate reduced to
  -- a bare basis using the frame's markup_factor, which is the only basis on
  -- which the archive is internally consistent. The library pools on bare by
  -- default; 'undetermined' rows are held out of the default pool entirely.
  basis                     cost_basis not null default 'undetermined',
  bare_unit_cost            numeric(16,4),
  bare_cost_per_project_sf  numeric(16,6),

  -- Escalated to the current period using cost_indices, from the frame's
  -- pricing_base_date rather than the issue date.
  escalated_bare_cost_per_project_sf numeric(16,6),
  escalation_index_version           text,

  is_markup           boolean not null default false,  -- GC, fee, contingency,
                                                       -- escalation lines
  -- ---- Provenance. Every number traces back to its exact source. ----
  source_sheet        text,          -- Excel sheet name
  source_cell_range   text,          -- 'B42:F42'
  source_page         smallint,      -- PDF page, 1-indexed
  extraction_method   text,          -- 'template_parser' | 'model_sonnet5' |
                                     -- 'model_opus5' | 'human'
  confidence          numeric(4,3),
  reviewed_by         uuid references profiles(id),
  reviewed_at         timestamptz,

  created_at          timestamptz not null default now()
);

create index on line_items (deliverable_id);
create index on line_items (taxonomy_code);
create index on line_items (taxonomy_code, uom_canonical);
create index on line_items (taxonomy_code, basis) where basis <> 'undetermined';
create index on line_items (confidence) where reviewed_at is null;

-- "Everything every estimator has said about each line item." — Rachel, 2026-09-09
create table estimator_notes (
  id              uuid primary key default gen_random_uuid(),
  line_item_id    uuid not null references line_items(id) on delete cascade,
  note_type       text,              -- 'assumption' | 'exclusion' |
                                     -- 'clarification' | 'qualification'
  body            text not null,
  source_page     smallint,
  created_at      timestamptz not null default now()
);

create index on estimator_notes (line_item_id);

-- ============================================================================
-- 4b. The reader's questions, and what it learns from the answers
--
-- The reader never guesses silently. Anything it cannot resolve becomes a row
-- here: 'question' rows block the document out of the library until answered;
-- 'assumption' rows do not block — the reader proposes an answer with its
-- evidence and the data stays usable while it waits, but every result derived
-- from it says so. See PLAN §6.4.
-- ============================================================================

create type question_kind as enum
  ('coding_system', 'gross_area', 'markup_basis', 'deliverable_type',
   'pricing_base_date', 'reconciliation', 'taxonomy_mapping', 'other');

-- 'question' blocks; 'assumption' is proposed and awaits confirmation.
create type question_mode as enum ('question', 'assumption');

create type question_state as enum
  ('open', 'answered', 'confirmed', 'corrected', 'withdrawn');

create table reader_questions (
  id              bigserial primary key,
  deliverable_id  uuid not null references deliverables(id) on delete cascade,
  frame_id        uuid references document_frames(id) on delete cascade,
  line_item_id    uuid references line_items(id) on delete cascade,

  kind            question_kind not null,
  mode            question_mode not null,
  state           question_state not null default 'open',

  prompt          text not null,     -- what the reader is asking, in plain words
  evidence        text,              -- what it found, and where
  proposed_answer jsonb,             -- the assumption, when mode='assumption'
  options         jsonb,             -- discrete choices, where they exist

  answer          jsonb,             -- what the human decided
  answered_by     uuid references profiles(id),
  answered_at     timestamptz,
  answer_note     text,

  -- Set when an answer was generalized into a standing rule (§4b below).
  became_convention bigint,

  created_at      timestamptz not null default now()
);

create index on reader_questions (state) where state = 'open';
create index on reader_questions (deliverable_id);
create index on reader_questions (mode, state);

-- What the reader learned. This is what makes 1,235 documents tractable rather
-- than exhausting: an answer is generalized to a scope, and every subsequent
-- document matching that scope applies it without asking again. Scope is
-- deliberately narrow and explicit — a convention that is true of Brian's 2024
-- plans is not necessarily true of anyone else's. See PLAN §6.5.
create table reader_conventions (
  id              bigserial primary key,
  kind            question_kind not null,

  -- Scope. NULL means "does not narrow on this dimension".
  scope_estimator text,
  scope_template  text,              -- template fingerprint
  scope_client    text,
  scope_from      date,
  scope_to        date,

  rule            jsonb not null,    -- the determination to apply
  rationale       text,

  active          boolean not null default true,
  learned_from    bigint references reader_questions(id),
  created_by      uuid references profiles(id),
  created_at      timestamptz not null default now(),
  superseded_by   bigint references reader_conventions(id)
);

create index on reader_conventions (kind) where active;
create index on reader_conventions (scope_estimator) where active;

alter table reader_questions
  add constraint reader_questions_became_convention_fk
  foreign key (became_convention) references reader_conventions(id);

-- ============================================================================
-- 5. Analytics configuration
-- ============================================================================

-- The confidence gate's thresholds are versioned and admin-editable, so Rachel
-- and the estimating team can tune them once they see real output — without a
-- deploy. See PLAN §7.
create table confidence_rules (
  id                    bigserial primary key,
  version               text not null,
  active                boolean not null default false,

  green_min_n           smallint not null default 8,
  green_max_cv          numeric(5,3) not null default 0.25,
  green_min_projects    smallint not null default 3,
  green_min_estimators  smallint not null default 2,
  green_max_age_months  smallint not null default 18,
  -- Green additionally requires that no observation in the pool rests on a
  -- reader assumption a human hasn't confirmed. Confirming them can move a
  -- result from amber to green on the spot. See PLAN §7.
  green_requires_confirmed_assumptions boolean not null default true,

  amber_min_n           smallint not null default 4,
  amber_max_cv          numeric(5,3) not null default 0.50,
  amber_max_age_months  smallint not null default 36,

  -- Modified z-score threshold for MAD-based outlier rejection.
  -- NOT mean ± 2σ — unreliable at n < 20. See PLAN §7.
  outlier_mad_threshold numeric(4,2) not null default 3.5,
  trend_min_n           smallint not null default 8,
  trend_max_p_value     numeric(4,3) not null default 0.10,

  -- How far the sum of extracted line items may sit from the document's stated
  -- total before the reader stops and asks. Rounding means they never match
  -- exactly, so this is a threshold, not an equality check.
  --   below 'note'    -> accepted silently
  --   'note'..'block' -> accepted, gap recorded and shown in drill-down
  --   above 'block'   -> blocking question; usually a missed section or a
  --                      double-counted subtotal
  --
  -- These are NOT picked by hand. They are DERIVED from how DCW's own documents
  -- actually behave: measure the reconciliation gap across the archive, and set
  -- 'note' where the bulk of documents sit and 'block' where the genuine
  -- outliers begin — the same MAD-based outlier logic used on cost data. The
  -- values below are provisional seeds for the pilot only; calibration replaces
  -- them and is re-run as the archive grows. See PLAN §6.7 and the columns
  -- below, which record where a calibrated pair came from.
  reconcile_note_pct    numeric(5,3) not null default 0.5,
  reconcile_block_pct   numeric(5,3) not null default 3.0,
  reconcile_calibrated_from  text,      -- 'seed' | 'pilot_verified' | 'archive'
  reconcile_sample_n         integer,   -- documents the calibration measured
  reconcile_calibrated_at    timestamptz,

  created_by            uuid references profiles(id),
  created_at            timestamptz not null default now(),
  unique (version)
);

create unique index one_active_confidence_rule
  on confidence_rules (active) where active;

-- ============================================================================
-- 6. Operations: ingest runs, overrides, audit
-- ============================================================================

create table ingest_runs (
  id              uuid primary key default gen_random_uuid(),
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  triggered_by    uuid references profiles(id),
  scope           text,              -- 'pilot' | 'backfill' | 'incremental'
  docs_attempted  integer not null default 0,
  docs_succeeded  integer not null default 0,
  docs_failed     integer not null default 0,
  input_tokens    bigint,
  output_tokens   bigint,
  estimated_cost  numeric(10,4),
  notes           text
);

create table audit_log (
  id              bigserial primary key,
  actor_id        uuid references profiles(id),
  action          text not null,     -- 'query' | 'export' | 'approve_user' |
                                     -- 'revoke_user' | 'edit_thresholds' | …
  target          text,
  detail          jsonb,
  ip              inet,
  created_at      timestamptz not null default now()
);

create index on audit_log (actor_id, created_at desc);
create index on audit_log (action, created_at desc);

-- ============================================================================
-- 6b. The Estimate Builder — the round trip
--
-- An estimator drops in their documents and the client's requirements, and gets
-- back a populated, editable cost plan scoped to what that project actually
-- asks for. Structurally this is the same reader as §3b/§4b, pointed forward:
-- instead of reading a historical plan to learn what DCW charged, it reads a
-- new project's inputs to work out what it should charge. See PLAN §8.1.
-- ============================================================================

create type estimate_status as enum
  ('draft', 'reading_inputs', 'brief_review', 'building', 'in_review',
   'exported', 'abandoned');

create table estimates (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid references projects(id),   -- null for a pure pursuit
  name            text not null,
  created_by      uuid not null references profiles(id),
  status          estimate_status not null default 'draft',
  target_phase    design_phase not null default 'unknown',
  exported_at     timestamptz,
  export_file_url text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index on estimates (created_by, updated_at desc);
create index on estimates (project_id);

-- What the estimator dropped in: RFP, program document, drawing set, area
-- schedule, spec sections, a prior estimate to update, DCW's own template.
create table estimate_inputs (
  id              uuid primary key default gen_random_uuid(),
  estimate_id     uuid not null references estimates(id) on delete cascade,
  filename        text not null,
  storage_url     text not null,      -- Box, same as the archive
  input_kind      text,               -- 'rfp' | 'program' | 'drawings' |
                                      -- 'area_schedule' | 'spec' |
                                      -- 'prior_estimate' | 'template' | 'other'
  uploaded_by     uuid not null references profiles(id),
  read_status     ingest_status not null default 'pending',
  uploaded_at     timestamptz not null default now()
);

create index on estimate_inputs (estimate_id);

-- The reader's understanding of the NEW project. The forward-facing twin of
-- document_frames. Confirmed on one screen before any line is proposed, because
-- everything downstream inherits it.
create table estimate_briefs (
  id                  uuid primary key default gen_random_uuid(),
  estimate_id         uuid not null unique
                        references estimates(id) on delete cascade,

  gross_sf            numeric(14,2),
  -- A 40,000 SF building that is 60% lab prices nothing like one that is 100%
  -- open office. Mix drives which elements appear, not only their rates.
  program_mix         jsonb,          -- [{use:'lab', sf:24000}, …]
  sector              text,
  region              text,
  delivery_method     text,
  phase               design_phase,

  -- The escalation target. Pricing a 2028 start in 2026 dollars is a large,
  -- silent error, so this is captured explicitly rather than inferred.
  construction_start  date,
  construction_midpoint date,

  -- The part that makes this more than a filled-in template. Sourced from the
  -- client's own requirement documents in Phase 3b.
  inclusions          jsonb,          -- [{scope:'…', source:'RFP §3.2'}, …]
  exclusions          jsonb,
  alternates          jsonb,
  allowances          jsonb,
  owner_furnished     jsonb,
  performance_reqs    jsonb,          -- LEED / energy targets that carry cost
  stated_budget       numeric(16,2),

  confidence          numeric(4,3),
  confirmed_by        uuid references profiles(id),
  confirmed_at        timestamptz,
  created_at          timestamptz not null default now()
);

-- One row per element in the estimate being built. Carries what the tool
-- proposed, what the estimator decided, and why — the override reason is the
-- feedback signal for the next version.
create type line_disposition as enum
  ('proposed', 'accepted', 'overridden', 'excluded_by_requirement',
   'left_blank', 'manually_added');

create table estimate_lines (
  id                  uuid primary key default gen_random_uuid(),
  estimate_id         uuid not null references estimates(id) on delete cascade,
  taxonomy_code       text not null references taxonomy(code),
  sort_order          integer,

  -- ---- What the library proposed ----
  suggested_rate      numeric(16,6),  -- $/GSF, bare basis
  suggested_confidence text,          -- 'green' | 'amber' | 'red'
  suggested_reason    text,           -- the plain-words justification shown to
                                      -- the estimator, e.g. "11 obs, 7 projects"
  sample_n            smallint,
  sample_query        jsonb,          -- the exact filters, so it reproduces
  -- A red line arrives BLANK. The tool does not fill a cell with a number it
  -- cannot stand behind: a blank prompts an estimator, a bad number reaches a
  -- client. See PLAN §8.2.

  -- ---- What the estimator decided ----
  disposition         line_disposition not null default 'proposed',
  final_rate          numeric(16,6),
  override_reason     text,
  -- Set when a requirement in the brief removed this scope, so "left out on
  -- purpose" is visible on the face of the document and distinguishable from
  -- "forgotten".
  excluded_source     text,           -- e.g. 'RFP §5.4 — hazmat by owner'
  decided_by          uuid references profiles(id),
  decided_at          timestamptz,

  extended_cost       numeric(16,2),
  created_at          timestamptz not null default now()
);

create index on estimate_lines (estimate_id, sort_order);
create index on estimate_lines (taxonomy_code);
create index on estimate_lines (disposition) where disposition = 'proposed';

-- ============================================================================
-- 7. Row-level security — deny by default, everywhere
--
-- Policy lives in the database, not in the Astro pages. A bug in the UI cannot
-- leak a row that policy forbids. The service-role key never reaches a browser.
--
-- Access is binary: an approved, active user sees all cost data for all
-- clients, exactly as they do in Airtable today. There is no per-client
-- tiering. Were a future client contract ever to require ring-fencing, it is a
-- flag on `projects` and one extra clause in the three read policies below —
-- but building it speculatively would add friction for a problem DCW does not
-- have. See PLAN §9.
-- ============================================================================

alter table profiles           enable row level security;
alter table bootstrap_admins   enable row level security;
alter table projects           enable row level security;
alter table deliverables       enable row level security;
alter table document_frames    enable row level security;
alter table line_items         enable row level security;
alter table estimator_notes    enable row level security;
alter table reader_questions   enable row level security;
alter table reader_conventions enable row level security;
alter table taxonomy           enable row level security;
alter table units              enable row level security;
alter table cost_indices       enable row level security;
alter table confidence_rules   enable row level security;
alter table ingest_runs        enable row level security;
alter table estimates          enable row level security;
alter table estimate_inputs    enable row level security;
alter table estimate_briefs    enable row level security;
alter table estimate_lines     enable row level security;
alter table audit_log          enable row level security;

-- Profiles: you can always read yourself. Admins read and write everyone.
create policy profiles_self_read on profiles
  for select using (id = auth.uid());
create policy profiles_admin_read on profiles
  for select using (is_admin());
create policy profiles_admin_write on profiles
  for update using (is_admin());

-- No INSERT policy on profiles, on purpose. Rows arrive only through the
-- on_auth_user_created trigger above, so nobody can insert themselves as an
-- active admin.

-- Bootstrap list: admins only, and only through the dashboard or SQL editor
-- before the first sign-in. Deliberately not readable by the app.
create policy bootstrap_admin_only on bootstrap_admins
  for all using (is_admin());

-- Reference data: any active user reads; only admins write.
create policy taxonomy_read on taxonomy
  for select using (is_active_user());
create policy units_read on units
  for select using (is_active_user());
create policy indices_read on cost_indices
  for select using (is_active_user());
create policy rules_read on confidence_rules
  for select using (is_active_user());
create policy rules_admin_write on confidence_rules
  for all using (is_admin());

-- Cost data: any active user, every client.
create policy projects_read on projects
  for select using (is_active_user());
create policy deliverables_read on deliverables
  for select using (is_active_user());
create policy frames_read on document_frames
  for select using (is_active_user());
create policy line_items_read on line_items
  for select using (is_active_user());
create policy notes_read on estimator_notes
  for select using (is_active_user());

-- The Reader Queue. Estimators and admins answer questions and confirm
-- assumptions; that is the only write path into cost data from the UI.
-- Everything else is written by the pipeline's service role.
-- Anyone active may answer, because the person who knows the answer is often
-- whoever ran that job rather than whoever holds a particular role. Answers are
-- attributed via answered_by and that attribution is public to the team —
-- see v_question_answers below.
create policy reader_questions_read on reader_questions
  for select using (is_active_user());

create policy reader_questions_answer on reader_questions
  for update using (is_active_user());

create policy line_items_review_write on line_items
  for update using (
    is_active_user() and exists (
      select 1 from profiles
      where id = auth.uid() and role in ('admin', 'estimator')
    )
  );

-- Conventions are readable by everyone active — a line item records which were
-- applied to it, and that has to be inspectable — but only admins edit them,
-- because a wrong convention propagates across the whole archive.
create policy conventions_read on reader_conventions
  for select using (is_active_user());
create policy conventions_admin_write on reader_conventions
  for all using (is_admin());

-- Operations tables.
create policy ingest_runs_read on ingest_runs
  for select using (is_active_user());
create policy audit_admin_only on audit_log
  for select using (is_admin());

-- Estimates in progress. Readable by the whole team — estimators cover for each
-- other, and a colleague's in-progress estimate is exactly the thing you want to
-- pick up when someone is out. Editable by its author, or any admin.
create policy estimates_read on estimates
  for select using (is_active_user());
create policy estimates_write on estimates
  for all using (created_by = auth.uid() or is_admin());

create policy estimate_inputs_read on estimate_inputs
  for select using (is_active_user());
create policy estimate_briefs_read on estimate_briefs
  for select using (is_active_user());
create policy estimate_lines_read on estimate_lines
  for select using (is_active_user());

create policy estimate_inputs_write on estimate_inputs
  for all using (
    is_admin() or exists (
      select 1 from estimates e
      where e.id = estimate_inputs.estimate_id and e.created_by = auth.uid()
    )
  );

create policy estimate_briefs_write on estimate_briefs
  for all using (
    is_admin() or exists (
      select 1 from estimates e
      where e.id = estimate_briefs.estimate_id and e.created_by = auth.uid()
    )
  );

create policy estimate_lines_write on estimate_lines
  for all using (
    is_admin() or exists (
      select 1 from estimates e
      where e.id = estimate_lines.estimate_id and e.created_by = auth.uid()
    )
  );

-- ============================================================================
-- 8. Convenience view: one comparable observation per row
--
-- The analytics layer filters this, escalates, log-transforms, rejects outliers
-- by MAD, and applies the confidence gate. Keeping the join here means the
-- statistics code never has to reassemble it.
-- ============================================================================

-- security_invoker: without this a view runs with its OWNER's privileges, which
-- in Supabase is a superuser — so it would read straight past the row-level
-- security on the tables underneath and hand every row to anyone who can
-- SELECT from it, pending accounts included. Requires Postgres 15+.
create view v_observations with (security_invoker = true) as
select
  li.id                       as line_item_id,
  li.taxonomy_code,
  t.title                     as taxonomy_title,
  li.raw_description,
  li.uom_canonical,
  u.family                    as unit_family,
  li.quantity,
  li.unit_cost,                             -- as written
  li.total_cost,
  li.cost_per_project_sf,
  li.pct_of_total,
  li.basis,
  li.bare_unit_cost,                        -- the poolable figure
  li.bare_cost_per_project_sf,
  li.escalated_bare_cost_per_project_sf,
  li.is_markup,
  li.confidence,
  li.reviewed_at is not null  as human_reviewed,
  d.id                        as deliverable_id,
  d.type                      as deliverable_type,
  d.phase,
  d.issue_date,
  d.estimator,
  d.box_file_url,
  d.is_latest_version,
  f.markup_factor,
  f.markup_components,                      -- what was stripped, shown on drill-down
  f.gsf_used,
  f.gsf_source,
  f.pricing_base_date,
  f.coding_system,
  -- Surfaces in the result so the confidence gate can demote, and so the UI can
  -- offer a one-click jump to the pending confirmation. See PLAN §7.
  f.has_open_assumption,
  p.id                        as project_id,
  p.name                      as project_name,
  p.client_name,
  p.sector,
  p.region,
  p.gross_sf                  as project_gross_sf,
  p.delivery_method
from line_items li
  join deliverables    d on d.id = li.deliverable_id
  join document_frames f on f.deliverable_id = d.id
  join projects        p on p.id = d.project_id
  left join taxonomy t on t.code = li.taxonomy_code
  left join units    u on u.code = li.uom_canonical
where d.status = 'accepted'
  and li.is_markup = false     -- markups are analyzed separately, never pooled
                               -- with elemental rates
  and li.basis <> 'undetermined';  -- a rate whose markup basis the reader could
                                   -- not establish is not comparable to anything

-- ============================================================================
-- 9. Who settled what
--
-- Attribution is part of the data, not a line in an audit log. Any active user
-- may answer a reader question, and the answer travels with its consequences:
-- shown on the question, on the document it resolved, on any convention learned
-- from it, and in the drill-down of every library result that depends on it.
--
-- Two reasons this matters. Someone reading a number months later can go ask
-- the person who settled it. And an answer that turns out to be wrong can be
-- traced to its source and its effects replayed — which works because raw
-- extracted values are never overwritten. See PLAN §4 and §6.6.
-- ============================================================================

-- security_invoker: without this a view runs with its OWNER's privileges, which
-- in Supabase is a superuser — so it would read straight past the row-level
-- security on the tables underneath and hand every row to anyone who can
-- SELECT from it, pending accounts included. Requires Postgres 15+.
create view v_question_answers with (security_invoker = true) as
select
  q.id                as question_id,
  q.deliverable_id,
  q.kind,
  q.mode,
  q.state,
  q.prompt,
  q.evidence,
  q.proposed_answer,
  q.answer,
  q.answered_at,
  p.full_name         as answered_by_name,
  p.email             as answered_by_email,
  c.id                as convention_id,
  c.rule              as convention_rule,
  cp.full_name        as convention_created_by_name
from reader_questions q
  left join profiles p  on p.id = q.answered_by
  left join reader_conventions c on c.id = q.became_convention
  left join profiles cp on cp.id = c.created_by;

