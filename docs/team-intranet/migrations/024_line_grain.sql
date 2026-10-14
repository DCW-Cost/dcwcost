-- ============================================================================
-- 024 — a line item declares what grain it was read at
--
-- The cost library will be built in two passes, and they read the SAME document
-- at two different levels of detail:
--
--   ELEMENTAL — one row per UNIFORMAT element, off the 'Section N Sum' tabs.
--     A10 Foundations ... $1,243,000 ... $14.02/SF ... 8.1% of total
--
--   DETAIL — one row per priced line, off the 'Section N' tabs.
--     Pile caps ... 240 EA @ $385 ... $92,400
--
-- Both are line_items. Nothing else about them differs, which is why they share
-- a table — but their totals OVERLAP. The elemental rows for a section are the
-- detail rows for that section, added up. Load both for one document and
-- sum(total_cost) returns twice the cost of the building.
--
-- There is no column today that tells them apart. source_sheet implies it
-- (Section 1 Sum vs Section 1), but implying is not declaring: a query would
-- have to know the tab-naming convention of an Excel template to avoid doubling
-- every number, and the first person to write that query without knowing it
-- gets a plausible answer that is exactly 100% too high.
--
-- So the grain is declared, not inferred.
--
-- NOT NULL WITH NO DEFAULT, ON PURPOSE. line_items holds 0 rows today, so the
-- column applies cleanly, and leaving the default off means every future writer
-- has to say which grain it is reading. A default would let pass two forget.
-- ============================================================================

-- ONE TRANSACTION. See the note on failure modes in the header.
begin;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'line_grain') then
    create type line_grain as enum ('elemental', 'detail');
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- THIS MIGRATION CAN ONLY BE APPLIED TO AN EMPTY line_items, AND THAT IS THE
-- POINT — BUT IT SHOULD SAY SO RATHER THAN JUST FAILING.
--
-- grain is NOT NULL with no default so that pass two cannot forget to declare
-- which level it read. The cost of that choice is that there is no value to
-- give rows that already exist, so applying this after extraction has started
-- is a hard failure. Postgres's own message for it ("column contains null
-- values") says nothing about why, which is how someone ends up adding a
-- default to get unstuck and silently mislabelling every existing row as
-- whatever the default happens to be.
--
-- So the guard below explains it instead. It is a no-op on a fresh apply and
-- on a replay; it only speaks up in the one case that needs explaining.
-- ----------------------------------------------------------------------------

do $$
declare n bigint;
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public'
                and table_name = 'line_items'
                and column_name = 'grain') then
    return;                      -- already applied; replay is fine
  end if;

  select count(*) into n from line_items;
  if n > 0 then
    raise exception using
      message = format('024 cannot add line_items.grain: the table already holds %s rows.', n),
      detail  = 'grain is NOT NULL with no default on purpose — every writer must '
                || 'declare which grain it read, because elemental and detail rows '
                || 'for one document overlap and summing across them double-counts.',
      hint    = 'Backfill, do not default: add the column nullable, set grain on the '
                || 'existing rows from what actually produced them (source_sheet is '
                || 'the evidence), then ALTER COLUMN grain SET NOT NULL. Adding a '
                || 'default to get past this labels every existing row by guess.';
  end if;
end $$;

alter table line_items add column if not exists grain line_grain not null;

-- The index the library actually queries on: elemental rows for one element,
-- which is the shape of every Option A question ("what did foundations cost").
create index if not exists line_items_grain_taxonomy_idx
  on line_items (grain, taxonomy_code);

comment on column line_items.grain is
  'Which level of the document this row was read at. Elemental and detail rows for the same deliverable overlap — never sum across grains.';

-- ============================================================================
-- v_observations HAS THREE DEAD REFERENCES AND ONE SILENT DROP
--
-- The view predates phase two of the mirror and was never revisited. Measured
-- against production on 2026-10-14, before this migration:
--
--   projects total                     1874
--   projects with client_name             0    <-- view reads this
--   projects with a client via join    1760
--   projects with gross_sf                0    <-- view reads this
--   deliverables.project_id nullable    YES
--   deliverables with no project          2    <-- inner join drops these
--
-- 1. p.client_name is NULL on every one of 1,874 projects. Clients moved to
--    project_client_companies in 019 and a project may have more than one, so
--    the scalar column was never going to hold them. pass-one.ts was fixed for
--    this; the view was not. Any client filter in the library matches nothing.
--
-- 2. p.gross_sf is NULL on every one of 1,874 projects — 020 cleared it because
--    it was derived rather than measured. The frame's gsf_used is the live
--    figure and is already in the view. A minGrossSf/maxGrossSf filter against
--    project_gross_sf matches nothing, which reads as "no comparable projects"
--    rather than as a broken filter.
--
-- 3. The projects join is INNER, and 022 made deliverables.project_id nullable
--    so that one genuinely project-less Airtable task could load. Two
--    deliverables have no project today. Their line items would vanish from the
--    library with no error — the dangerous kind of wrong, because the total
--    still looks reasonable.
--
-- Rebuilt below: clients come from the join as an array, project gross_sf is
-- dropped in favour of the frame's measured figure, and the projects join is
-- LEFT so a document without a project is still an observation.
--
-- The 'accepted' filter stays. All 5,560 deliverables are 'pending' today, so
-- the view correctly returns 0 rows until documents have actually been read.
-- ============================================================================

drop view if exists v_observations;

create view v_observations with (security_invoker = true) as
select
  li.id                       as line_item_id,
  li.grain,
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
  f.gsf_used,                               -- the ONLY live gross area; see note 2
  f.gsf_source,
  f.pricing_base_date,
  f.coding_system,
  f.has_open_assumption,
  p.id                        as project_id,
  p.name                      as project_name,
  -- A project may have several clients, so this is an array and a filter must
  -- use && or = any(). Empty array, never null, so callers need no null branch.
  coalesce((
    select array_agg(cc.company_name order by cc.company_name)
      from project_client_companies pcc
      join client_companies cc on cc.id = pcc.client_company_id
     where pcc.project_id = p.id
  ), '{}') as client_names,
  p.sector,
  p.region,
  p.delivery_method
from line_items li
  join deliverables    d on d.id = li.deliverable_id
  join document_frames f on f.deliverable_id = d.id
  left join projects   p on p.id = d.project_id   -- LEFT: see note 3
  left join taxonomy   t on t.code = li.taxonomy_code
  left join units      u on u.code = li.uom_canonical
where d.status = 'accepted'
  and li.is_markup = false     -- markups are analyzed separately, never pooled
                               -- with elemental rates
  and li.basis <> 'undetermined';  -- a rate whose markup basis the reader could
                                   -- not establish is not comparable to anything

commit;

-- ============================================================================
-- REPLAY-SAFE, AND ALL-OR-NOTHING. Every statement is guarded — the enum behind
-- a pg_type check, the column and index behind IF NOT EXISTS, the view behind
-- DROP IF EXISTS — and the whole file runs inside one BEGIN/COMMIT.
--
-- The transaction is about the FAILURE path, not the success path. The guard
-- above raises on a non-empty line_items, and without a transaction that raise
-- stops only its own statement: the alter, the index, the comment and the view
-- then each fail in turn on a column that does not exist, and the SQL editor
-- shows five errors of which only the FIRST says anything true. Wrapped, the
-- first error aborts the whole thing and is the only one you see.
--
-- Safe to wrap because nothing here is non-transactional: CREATE TYPE and its
-- first use may share a transaction (the restriction is on ALTER TYPE ... ADD
-- VALUE, which this file does not use — 005a does), and the index is not
-- CONCURRENTLY.
--
-- Applying it twice changes nothing the second time.
--
-- It was not, on the first draft. The enum was a bare CREATE TYPE, which aborts
-- a second paste at line one — and because everything else is downstream of it,
-- the whole v_observations rebuild silently never ran. Caught on replay by
-- Rachel, 2026-10-14. Verify a replay, not just an apply.
--
-- VERIFICATION — expected after applying, AND IDENTICAL after a second apply:
--
--   grain column exists                      true
--   grain is NOT NULL                        true
--   grain has NO default                     true
--   line_grain values                        elemental, detail
--        (declaration order, not alphabetical — the query orders by
--         enumsortorder. This line read 'detail, elemental' until the
--         production run on 2026-10-14 disagreed with it.)
--   line_items rows                          0
--   v_observations exists                    true
--   view exposes grain                       true
--   view exposes client_names                true
--   view no longer exposes client_name       true
--   view no longer exposes project_gross_sf  true
--   view is security_invoker                 true
--   view column count                        39
--   v_observations rows                      0
--
-- Run against production before committing, per the standing practice.
-- ============================================================================
--
-- select 'grain column exists' as item,
--        (exists(select 1 from information_schema.columns
--                 where table_schema='public' and table_name='line_items'
--                   and column_name='grain'))::text as value
-- union all select 'grain is NOT NULL',
--        (select (is_nullable='NO')::text from information_schema.columns
--          where table_schema='public' and table_name='line_items'
--            and column_name='grain')
-- union all select 'grain has NO default',
--        (select (column_default is null)::text from information_schema.columns
--          where table_schema='public' and table_name='line_items'
--            and column_name='grain')
-- union all select 'line_grain values',
--        (select string_agg(enumlabel,', ' order by enumsortorder)
--           from pg_enum where enumtypid='line_grain'::regtype)
-- union all select 'line_items rows', (select count(*)::text from line_items)
-- union all select 'v_observations exists',
--        (to_regclass('public.v_observations') is not null)::text
-- union all select 'view exposes grain',
--        (exists(select 1 from information_schema.columns
--                 where table_schema='public' and table_name='v_observations'
--                   and column_name='grain'))::text
-- union all select 'view exposes client_names',
--        (exists(select 1 from information_schema.columns
--                 where table_schema='public' and table_name='v_observations'
--                   and column_name='client_names'))::text
-- union all select 'view no longer exposes client_name',
--        (not exists(select 1 from information_schema.columns
--                     where table_schema='public' and table_name='v_observations'
--                       and column_name='client_name'))::text
-- union all select 'view no longer exposes project_gross_sf',
--        (not exists(select 1 from information_schema.columns
--                     where table_schema='public' and table_name='v_observations'
--                       and column_name='project_gross_sf'))::text
-- union all select 'view is security_invoker',
--        (select (c.reloptions::text like '%security_invoker=true%')::text
--           from pg_class c where c.relname='v_observations')
-- union all select 'view column count',
--        (select count(*)::text from information_schema.columns
--          where table_schema='public' and table_name='v_observations')
-- union all select 'v_observations rows', (select count(*)::text from v_observations);
--
-- ============================================================================
