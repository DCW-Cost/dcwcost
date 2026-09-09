-- ============================================================================
-- DCW Team Intranet — historical cost database
-- Target: Postgres 15+ / Supabase
--
-- Design notes:
--   * Airtable stays the system of record for projects and deliverables.
--     Everything mirrored from it carries an `airtable_record_id` and is
--     refreshed by a one-way sync. Never write back to those columns.
--   * Raw extracted values are never overwritten. Every normalized column sits
--     NEXT TO its raw source, so a bad mapping is always recoverable.
--   * All math (totals, conversions, statistics) happens here or in the
--     analytics layer — never in the extraction model.
--   * RLS is deny-by-default on every table. See §7.
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

create type confidentiality as enum ('standard', 'restricted');

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
  confidentiality     confidentiality not null default 'standard',
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

create type ingest_status as enum
  ('pending', 'downloading', 'extracting', 'needs_review', 'accepted', 'failed', 'skipped');

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

  -- How markups are treated in this document. Determines whether line-item
  -- rates are bare or loaded — see PLAN §12 Q3. Do not pool across values.
  markup_treatment    text,          -- 'bare' | 'loaded' | 'unknown'

  total_cost          numeric(16,2), -- as stated on the document
  currency            char(3) not null default 'USD',

  status              ingest_status not null default 'pending',
  extraction_confidence numeric(4,3),
  upload_notes        text,          -- carried over from Airtable
  synced_at           timestamptz not null default now(),
  ingested_at         timestamptz
);

create index on deliverables (project_id);
create index on deliverables (type, phase);
create index on deliverables (issue_date);
create index on deliverables (status) where status in ('needs_review', 'failed');

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
  -- Always computable when the project's GSF is known — this is what makes a
  -- lump-sum row comparable to a per-CY row.
  cost_per_project_sf numeric(16,6),
  pct_of_total        numeric(8,5),
  -- Escalated to the current period using cost_indices.
  escalated_cost_per_project_sf numeric(16,6),
  escalation_index_version      text,

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

  amber_min_n           smallint not null default 4,
  amber_max_cv          numeric(5,3) not null default 0.50,
  amber_max_age_months  smallint not null default 36,

  -- Modified z-score threshold for MAD-based outlier rejection.
  -- NOT mean ± 2σ — unreliable at n < 20. See PLAN §7.
  outlier_mad_threshold numeric(4,2) not null default 3.5,
  trend_min_n           smallint not null default 8,
  trend_max_p_value     numeric(4,3) not null default 0.10,

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

-- When an estimator overrides a suggested rate in the Cost Plan Builder, the
-- reason is captured. This is the feedback loop that improves the next version.
create table rate_overrides (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references profiles(id),
  taxonomy_code   text not null references taxonomy(code),
  suggested_value numeric(16,6),
  suggested_confidence text,         -- 'green' | 'amber' | 'red'
  override_value  numeric(16,6),
  reason          text,
  context         jsonb,             -- the filters in play at the time
  created_at      timestamptz not null default now()
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
-- 7. Row-level security — deny by default, everywhere
--
-- Policy lives in the database, not in the Astro pages. A bug in the UI cannot
-- leak a row that policy forbids. The service-role key never reaches a browser.
-- ============================================================================

alter table profiles          enable row level security;
alter table projects          enable row level security;
alter table deliverables      enable row level security;
alter table line_items        enable row level security;
alter table estimator_notes   enable row level security;
alter table taxonomy          enable row level security;
alter table units             enable row level security;
alter table cost_indices      enable row level security;
alter table confidence_rules  enable row level security;
alter table ingest_runs       enable row level security;
alter table rate_overrides    enable row level security;
alter table audit_log         enable row level security;

-- Profiles: you can always read yourself. Admins read and write everyone.
create policy profiles_self_read on profiles
  for select using (id = auth.uid());
create policy profiles_admin_read on profiles
  for select using (is_admin());
create policy profiles_admin_write on profiles
  for update using (is_admin());

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

-- Cost data: active users only. Restricted-confidentiality projects are visible
-- in aggregate (the analytics layer queries with the service role and returns
-- only statistics) but drill-down through these policies requires admin.
-- Rachel and Trish set the policy; this enforces whatever they decide.
create policy projects_read on projects
  for select using (
    is_active_user() and (confidentiality = 'standard' or is_admin())
  );

create policy deliverables_read on deliverables
  for select using (
    is_active_user() and exists (
      select 1 from projects p
      where p.id = deliverables.project_id
        and (p.confidentiality = 'standard' or is_admin())
    )
  );

create policy line_items_read on line_items
  for select using (
    is_active_user() and exists (
      select 1 from deliverables d join projects p on p.id = d.project_id
      where d.id = line_items.deliverable_id
        and (p.confidentiality = 'standard' or is_admin())
    )
  );

create policy notes_read on estimator_notes
  for select using (
    is_active_user() and exists (
      select 1 from line_items li where li.id = estimator_notes.line_item_id
    )
  );

-- Estimators work the review queue; that is the only write path into cost data
-- from the UI. Everything else is written by the pipeline's service role.
create policy line_items_review_write on line_items
  for update using (
    is_active_user() and exists (
      select 1 from profiles
      where id = auth.uid() and role in ('admin', 'estimator')
    )
  );

-- Operations tables.
create policy ingest_runs_read on ingest_runs
  for select using (is_active_user());
create policy overrides_own on rate_overrides
  for all using (user_id = auth.uid() or is_admin());
create policy audit_admin_only on audit_log
  for select using (is_admin());

-- ============================================================================
-- 8. Convenience view: one comparable observation per row
--
-- The analytics layer filters this, escalates, log-transforms, rejects outliers
-- by MAD, and applies the confidence gate. Keeping the join here means the
-- statistics code never has to reassemble it.
-- ============================================================================

create view v_observations as
select
  li.id                       as line_item_id,
  li.taxonomy_code,
  t.title                     as taxonomy_title,
  li.raw_description,
  li.uom_canonical,
  u.family                    as unit_family,
  li.quantity,
  li.unit_cost,
  li.total_cost,
  li.cost_per_project_sf,
  li.escalated_cost_per_project_sf,
  li.pct_of_total,
  li.is_markup,
  li.confidence,
  li.reviewed_at is not null  as human_reviewed,
  d.id                        as deliverable_id,
  d.type                      as deliverable_type,
  d.phase,
  d.issue_date,
  d.estimator,
  d.markup_treatment,
  d.box_file_url,
  d.is_latest_version,
  p.id                        as project_id,
  p.name                      as project_name,
  p.client_name,
  p.sector,
  p.region,
  p.gross_sf,
  p.delivery_method,
  p.confidentiality
from line_items li
  join deliverables d on d.id = li.deliverable_id
  join projects     p on p.id = d.project_id
  left join taxonomy t on t.code = li.taxonomy_code
  left join units    u on u.code = li.uom_canonical
where d.status = 'accepted'
  and li.is_markup = false;    -- markups are analyzed separately, never pooled
                               -- with elemental rates
