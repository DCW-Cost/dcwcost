-- ============================================================================
-- 026 — an estimator is a person, not a string
--
-- WHY NOW, AND WHY THIS IS THE LAST CHEAP MOMENT
--
-- deliverables.estimator is free text and EMPTY on all 5,560 rows. Nothing has
-- drifted, because nothing has ever been entered. The upload form offered a
-- text box, and the moment anyone typed into it the drift would have started:
-- "Katya Nichols", "katya", "K. Nichols" and one typo are four estimators to
-- every query that follows.
--
-- THIS IS NOT TIDINESS. IT IS A CONFIDENCE RULE THAT WOULD HAVE LIED.
--
-- confidence_rules.green_min_estimators defaults to 2: a library result only
-- goes green when at least two distinct estimators contributed to the pool.
-- That is a deliberate guard against one person's habits reading as a market
-- rate. Counting distinct free text defeats it exactly — one estimator whose
-- name was typed two ways satisfies the rule, and the result turns green on
-- the strength of a spelling.
--
-- Measured on production 2026-10-15, which is what makes this free:
--
--   deliverables                     5560
--   with a non-empty estimator          0
--   reader_conventions                  0 rows
--   confidence_rules                    0 rows
--   people                             24  (13 Active, 9 Past, 2 other)
--
-- No backfill, no reconciliation, no ambiguity about who "KN" was. Later,
-- with a decade of documents attributed, this same change needs a human to
-- adjudicate every spelling.
--
-- THREE PLACES, NOT ONE
--
-- 1. deliverables.estimator      -> estimator_id, referencing people
-- 2. reader_conventions.scope_estimator -> scope_estimator_id
-- 3. v_observations              -> joins through to people.name
--
-- (2) is the one that is easy to miss. pass-one.ts decides which learned
-- conventions apply to a document with
--
--     lower(scope_estimator) = lower(d.estimator)
--
-- — a string comparison between two free-text fields, governing which rules
-- the reader obeys. A convention scoped to one person simply would not fire
-- for a document whose estimator was spelled differently, and nothing would
-- report that it had not.
--
-- ON DELETE: people are soft-deleted by the sync (is_active, and
-- missing_from_airtable_since) rather than removed, so a hard delete should
-- not happen. If one ever does, SET NULL is right — losing the attribution is
-- bad, losing the document is worse.
-- ============================================================================

begin;

-- ============================================================================
-- 1. v_observations comes down FIRST, and goes back up in §4
--
-- Postgres refuses to drop a column a view depends on, and 024 put
-- `d.estimator` into v_observations. The first draft of this file dropped the
-- column in §2 and the view in §4, which fails on every run:
--
--   ERROR: cannot drop column estimator of table deliverables because
--          other objects depend on it
--
-- Transaction-wrapped, so it failed loudly and applied nothing — but it was a
-- hard stop, and it would have been one on production too. 012 hit the same
-- wall altering projects.sector and sequenced it this way for the same
-- reason.
--
-- IT MUST GO BACK UP WITH security_invoker = true. Not cosmetic: a view
-- without it runs as its owner and reads straight past the row-level security
-- of everything beneath it. §4 sets it explicitly.
-- ============================================================================

drop view if exists v_observations;


-- ============================================================================
-- 2. Deliverables
--
-- The drop is guarded. Today the column is empty on all 5,560 rows so there
-- is nothing to lose, but a migration that silently destroys a column's
-- contents when run later, on a database where someone has filled it in, is
-- a trap waiting for whoever runs it. Refuse instead, and say what to do.
-- ============================================================================

do $$
declare n bigint;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='deliverables'
                    and column_name='estimator') then
    return;                      -- already applied; replay is fine
  end if;

  execute 'select count(*) from deliverables where estimator is not null and estimator <> ''''' into n;
  if n > 0 then
    raise exception using
      message = format('026 will not drop deliverables.estimator: %s rows have a value.', n),
      detail  = 'The column is being replaced by estimator_id, a reference to people. '
                || 'Dropping it here would destroy those names with nothing recording that it happened.',
      hint    = 'Match them first: add estimator_id, UPDATE it from people by name, '
                || 'check what did not match, and only then re-run this migration. '
                || 'Names that match nobody are the whole reason this column is going away.';
  end if;
end $$;

alter table deliverables
  add column if not exists estimator_id uuid references people(id) on delete set null;

create index if not exists deliverables_estimator_id_idx
  on deliverables (estimator_id) where estimator_id is not null;

comment on column deliverables.estimator_id is
  'Who priced this document. A reference, not a name, because confidence_rules.green_min_estimators counts DISTINCT estimators and free text makes one person look like several.';

-- Dropped rather than kept alongside. A text column next to the reference is
-- a second answer to the same question, and the next person to write a query
-- has no way to know which one is authoritative. Nothing is lost: it holds no
-- values. Guarded so a replay does not fail on the second run.
alter table deliverables drop column if exists estimator;

-- ============================================================================
-- 3. Convention scoping
-- ============================================================================

alter table reader_conventions
  add column if not exists scope_estimator_id uuid references people(id) on delete set null;

comment on column reader_conventions.scope_estimator_id is
  'Narrows this convention to one estimator. NULL means it does not narrow on who priced the document.';

-- The old column goes BEFORE the new index, and the new index has a DIFFERENT
-- NAME. Both matter, and the second one is why this nearly shipped broken.
--
-- There is already an index called reader_conventions_scope_estimator_idx, on
-- the column being dropped. Creating the new one under that same name with
-- IF NOT EXISTS would find the name taken and do NOTHING — then the drop
-- below would take the old index away with its column, leaving
-- scope_estimator_id with no index at all. No error, every verification
-- green, and a silently unindexed lookup.
--
-- IF NOT EXISTS suppresses exactly the collision you need to hear about when
-- the name is reused for a different thing.
alter table reader_conventions drop column if exists scope_estimator;

create index if not exists reader_conventions_scope_estimator_id_idx
  on reader_conventions (scope_estimator_id) where scope_estimator_id is not null;

-- ============================================================================
-- 4. The library view, back up
--
-- Rebuilt rather than altered: a view cannot have a column removed in place,
-- and `estimator` changes from a stored string to one joined through people.
-- What the library DISPLAYS is unchanged — a name — while what it GROUPS BY
-- becomes an identity.
--
-- The people join is LEFT. An unattributed document is still an observation;
-- it just cannot contribute to the distinct-estimator count, which is the
-- correct behaviour rather than a gap.
-- ============================================================================

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
  li.unit_cost,
  li.total_cost,
  li.cost_per_project_sf,
  li.pct_of_total,
  li.basis,
  li.bare_unit_cost,
  li.bare_cost_per_project_sf,
  li.escalated_bare_cost_per_project_sf,
  li.is_markup,
  li.confidence,
  li.reviewed_at is not null  as human_reviewed,
  d.id                        as deliverable_id,
  d.type                      as deliverable_type,
  d.phase,
  d.issue_date,
  -- The identity the confidence rule counts, and the name a person reads.
  d.estimator_id,
  est.name                    as estimator,
  d.box_file_url,
  d.is_latest_version,
  f.markup_factor,
  f.markup_components,
  f.gsf_used,
  f.gsf_source,
  f.pricing_base_date,
  f.coding_system,
  f.has_open_assumption,
  p.id                        as project_id,
  p.name                      as project_name,
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
  left join projects   p on p.id = d.project_id
  left join people   est on est.id = d.estimator_id
  left join taxonomy   t on t.code = li.taxonomy_code
  left join units      u on u.code = li.uom_canonical
where d.status = 'accepted'
  and li.is_markup = false
  and li.basis <> 'undetermined';

commit;

-- ============================================================================
-- REPLAY-SAFE, AND ALL-OR-NOTHING. Every statement is guarded by IF EXISTS or
-- IF NOT EXISTS, and the whole file runs in one transaction so a failure
-- leaves the old shape rather than half the new one.
--
-- VERIFICATION — expected after applying, AND IDENTICAL after a second apply:
--
--   deliverables.estimator_id exists            true
--   deliverables.estimator GONE                 true
--   estimator_id references people              true
--   estimator_id on delete                      SET NULL
--   scope_estimator_id exists                   true
--   scope_estimator GONE                        true
--   new index exists, on scope_estimator_id     true
--   old index name GONE                         true
--   v_observations exists                       true
--   view exposes estimator_id                   true
--   view still exposes estimator (the name)     true
--   view is security_invoker                    true
--   view column count                           40
--   deliverables rows                           5560
--   rows with an estimator_id                   0
--
-- Run against production before committing, per the standing practice.
-- ============================================================================
--
-- select 'deliverables.estimator_id exists' as item,
--        (exists(select 1 from information_schema.columns
--                 where table_schema='public' and table_name='deliverables'
--                   and column_name='estimator_id'))::text as value
-- union all select 'deliverables.estimator GONE',
--        (not exists(select 1 from information_schema.columns
--                     where table_schema='public' and table_name='deliverables'
--                       and column_name='estimator'))::text
-- union all select 'estimator_id references people',
--        (exists(select 1 from information_schema.key_column_usage k
--                  join information_schema.referential_constraints rc
--                    on rc.constraint_name = k.constraint_name
--                 where k.table_name='deliverables' and k.column_name='estimator_id'))::text
-- union all select 'estimator_id on delete',
--        (select rc.delete_rule from information_schema.referential_constraints rc
--           join information_schema.key_column_usage k
--             on k.constraint_name = rc.constraint_name
--          where k.table_name='deliverables' and k.column_name='estimator_id' limit 1)
-- union all select 'scope_estimator_id exists',
--        (exists(select 1 from information_schema.columns
--                 where table_schema='public' and table_name='reader_conventions'
--                   and column_name='scope_estimator_id'))::text
-- union all select 'scope_estimator GONE',
--        (not exists(select 1 from information_schema.columns
--                     where table_schema='public' and table_name='reader_conventions'
--                       and column_name='scope_estimator'))::text
-- union all select 'new index exists, on scope_estimator_id',
--        (exists(select 1 from pg_indexes
--                 where indexname='reader_conventions_scope_estimator_id_idx'
--                   and indexdef like '%scope_estimator_id%'))::text
-- union all select 'old index name GONE',
--        (not exists(select 1 from pg_indexes
--                     where indexname='reader_conventions_scope_estimator_idx'))::text
-- union all select 'v_observations exists',
--        (to_regclass('public.v_observations') is not null)::text
-- union all select 'view exposes estimator_id',
--        (exists(select 1 from information_schema.columns
--                 where table_schema='public' and table_name='v_observations'
--                   and column_name='estimator_id'))::text
-- union all select 'view still exposes estimator (the name)',
--        (exists(select 1 from information_schema.columns
--                 where table_schema='public' and table_name='v_observations'
--                   and column_name='estimator'))::text
-- union all select 'view is security_invoker',
--        (select (c.reloptions::text like '%security_invoker=true%')::text
--           from pg_class c where c.relname='v_observations')
-- union all select 'view column count',
--        (select count(*)::text from information_schema.columns
--          where table_schema='public' and table_name='v_observations')
-- union all select 'deliverables rows', (select count(*)::text from deliverables)
-- union all select 'rows with an estimator_id',
--        (select count(*) filter (where estimator_id is not null)::text from deliverables);
--
-- ============================================================================
