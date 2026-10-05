-- ============================================================================
-- Migration 012 — two more multi-valued fields, and the client relationship
--
-- Run it in Supabase → SQL Editor → New query → paste → Run.
-- Expected result: "Success. No rows returned."
--
-- Requires 001 through 011.
--
-- NOT PURELY ADDITIVE. It changes two column types, drops a column, drops a
-- table, and drops and recreates a view. Every column and table it touches is
-- empty — checked against the live catalog — and the view it recreates is
-- restored from the live definition rather than retyped.
--
-- Safe to re-run, and correct from either starting state: the type changes
-- are guarded on the column's current type, not on its contents.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Why this exists
--
-- The first full dry run read all 9,637 records instead of 25 per table, and
-- reported what the sample could not:
--
--   116 projects have more than one Primary Category   → sector keeps the first
--    37 projects have more than one Location           → city keeps the first
--    30 projects link to more than one Client Company  → client_id keeps the first
--
-- The sample had said 7% for Primary Category and the full run says 6%, which
-- is a small reassurance that sampling was telling the truth — but it had
-- nothing to say about the other two.
--
-- ONE OF THESE IS NOT LIKE THE OTHERS, and it is the reason this is not just
-- a type change. The thirty multi-client projects were checked by hand, and
-- none is a data error. Two patterns, both structural:
--
--   owner + their agent        Multnomah County + Klosh Group
--                              Portland General Electric + Otak CPM
--                              Everett Housing Authority + ARC Architects
--
--   two design firms on a team OLIN + Cameron McCarthy
--                              Skylab Architecture + KPFF
--                              TCA Architecture + SHKS Architects
--
-- DCW is engaged where two client-side organisations are both real. That is a
-- join table, not a wider column.
--
-- WHAT THE JOIN TABLE LOSES, STATED SO IT READS AS A COST RATHER THAN A MISS:
-- it does not record WHICH company is the owner and which is the architect or
-- project manager. There is no role column, because Airtable does not record
-- the distinction either — and a column nobody can populate is worse than an
-- absent one. If that distinction is ever needed it has to come from
-- somewhere, and Airtable is not currently that somewhere.
-- ----------------------------------------------------------------------------


-- ============================================================================
-- 1. v_observations is dropped first, and recreated in §6
--
-- Postgres refuses to alter the type of a column a view depends on, and
-- `v_observations` selects `p.sector`. So the view comes down before §2 and
-- goes back up after.
--
-- IT MUST GO BACK UP WITH security_invoker = true. That is not cosmetic: a
-- view without it runs as its owner and ignores the row-level security of
-- everything beneath it, which would turn a reporting view into a way around
-- every policy in this database. The current setting was read from the live
-- catalog before writing this, and §6 restores it explicitly.
-- ============================================================================

drop view if exists v_observations;


-- ============================================================================
-- 2. projects.sector becomes text[]
--
-- Fed by Airtable's "Primary Category", a multiple select, and multi-valued
-- on 116 of 1,877 projects. Same decision as `market` in 009 and the same
-- reasoning: the sync records every value it drops, but 116 projects losing a
-- category is not a rare loss worth logging, it is data the column cannot
-- hold.
--
-- The index goes from btree to GIN, because the question asked of an array
-- column is "which projects are in this sector", and that is a containment
-- query.
-- ============================================================================

drop index if exists projects_sector_idx;

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'projects'
       and column_name = 'sector' and data_type <> 'ARRAY')
  then
    alter table projects
      alter column sector type text[]
      using case when sector is null then null else array[sector] end;
  end if;
end $$;

create index if not exists projects_sector_idx on projects using gin (sector);

comment on column projects.sector is
  'Airtable "Primary Category", a multiple select. text[] because 116 of 1,877 projects carry more than one. Was scalar until migration 012.';


-- ============================================================================
-- 3. projects.city becomes text[]
--
-- 37 projects name more than one location, and one names NINETEEN — Camano,
-- Coupeville, Darrington, Freeland and the rest. That is a county-wide or
-- multi-site job, and for it the list IS the location; there is no primary
-- one being obscured by noise.
--
-- `region` is untouched and stays scalar. It is the coarse grouping that
-- joins `cost_indices`, it is what v_observations reports, and nothing about
-- a project spanning five towns changes which index region it prices in.
-- ============================================================================

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'projects'
       and column_name = 'city' and data_type <> 'ARRAY')
  then
    alter table projects
      alter column city type text[]
      using case when city is null then null else array[city] end;
  end if;
end $$;

create index if not exists projects_city_idx on projects using gin (city);

comment on column projects.city is
  'Airtable "Location (City, State)", a multiple select. text[] because 37 projects name more than one and one names nineteen. region stays scalar — it is the cost_indices join.';


-- ============================================================================
-- 4. project_client_companies, and the column it replaces
--
-- The third join table, built to the same shape as the two in 011 and for the
-- same reason. No role column: see the header.
-- ============================================================================

create table if not exists project_client_companies (
  project_id        uuid not null references projects(id) on delete cascade,
  client_company_id uuid not null references client_companies(id) on delete cascade,
  synced_at         timestamptz not null default now(),
  primary key (project_id, client_company_id)
);

create index if not exists project_client_companies_company_idx
  on project_client_companies (client_company_id);

comment on table project_client_companies is
  'Airtable "Link to Client Company (Add Here)" on New Project Entry. A join table because 30 projects name two companies, and all 30 are real: an owner plus their agent, or two design firms on one team. No role column — Airtable does not record which is which, and a column nobody can populate is worse than an absent one.';

-- Empty, and its index goes with it. `client_name` (text) is untouched:
-- v_observations reads it, and it is the display name rather than the link.
alter table projects drop column if exists client_id;


-- ============================================================================
-- 5. deliverable_subconsultants is dropped — it has no source
--
-- 006 created it as one of two "genuine many-to-many" relationships, reading
-- the inventory's `tasks.subconsultants_id`. That field is "Subconsultants"
-- on DCW Project Tasks, and it does NOT link to Subconsultants: it links to
-- SUBCONSULTANT TASKS. The tell was visible in the dry run's own output, where
-- those linked records display as "1", "2", "3" rather than company names.
--
-- So it is the inverse of Subconsultant Tasks → Project — the 37th reversed
-- link, not a join. The relationship is already modelled as
-- `subconsultant_tasks.deliverable_id`, and the real chain is
-- deliverable → subconsultant_tasks → subconsultant, which carries status and
-- notes besides.
--
-- Dropped rather than left empty with a comment, which is the same answer
-- `deliverable_assignees` got in 011 and for the same reason: an empty table
-- makes the next person read a comment to find out it is not broken.
-- ============================================================================

drop table if exists deliverable_subconsultants;


-- ============================================================================
-- 6. v_observations, restored
--
-- The definition is the live one, read back with pg_get_viewdef before this
-- migration was written rather than retyped from schema.sql — which is stale
-- and would have silently reverted whatever it is behind on.
--
-- `p.sector` is now text[], so THE VIEW'S OWN OUTPUT TYPE CHANGES. Anything
-- grouping or filtering on it must handle an array. That is deliberate: the
-- alternative is `p.sector[1] as sector`, which would keep the old shape by
-- silently discarding the other categories — the exact behaviour §2 exists to
-- stop. Nothing consumes this view yet (line_items is empty, so it returns no
-- rows), which makes now the cheapest possible moment for that to change.
-- ============================================================================

create view v_observations with (security_invoker = true) as
 select li.id as line_item_id,
    li.taxonomy_code,
    t.title as taxonomy_title,
    li.raw_description,
    li.uom_canonical,
    u.family as unit_family,
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
    li.reviewed_at is not null as human_reviewed,
    d.id as deliverable_id,
    d.type as deliverable_type,
    d.phase,
    d.issue_date,
    d.estimator,
    d.box_file_url,
    d.is_latest_version,
    f.markup_factor,
    f.markup_components,
    f.gsf_used,
    f.gsf_source,
    f.pricing_base_date,
    f.coding_system,
    f.has_open_assumption,
    p.id as project_id,
    p.name as project_name,
    p.client_name,
    p.sector,
    p.region,
    p.gross_sf as project_gross_sf,
    p.delivery_method
   from line_items li
     join deliverables d on d.id = li.deliverable_id
     join document_frames f on f.deliverable_id = d.id
     join projects p on p.id = d.project_id
     left join taxonomy t on t.code = li.taxonomy_code
     left join units u on u.code = li.uom_canonical
  where d.status = 'accepted'::ingest_status
    and li.is_markup = false
    and li.basis <> 'undetermined'::cost_basis;


-- ============================================================================
-- 7. Privileges, from this migration's own object list
--
-- Per 010's rule. The list is project_client_companies and v_observations —
-- the one table created and the one view recreated.
--
-- AND A FIFTH INSTANCE OF THE SAME PATTERN, FOUND WHILE WRITING THIS.
--
-- 010 revoked `anon` on all twenty-two tables it had been granted on. It did
-- not touch VIEWS, and `anon` holds full privileges on v_observations,
-- v_question_answers and v_wishlist. Worse, 010's verification block asked
-- the question with `relkind = 'r'` — so the check that existed to catch this
-- shared the blind spot with the fix.
--
-- It is contained: all three are `security_invoker = true`, so reading one as
-- anon requires privileges on the tables beneath it, which 010 removed. The
-- grant is nonetheless real, and "contained by something else" is how the
-- last four of these were described too.
--
-- The previous four were objects created later in the same file than the rule
-- that should have covered them. This one is a different axis — the right
-- objects, the wrong KIND of object — which is worth naming separately,
-- because "drive it from the object list" would not have caught it either.
-- The list was complete. It was a list of tables.
-- ============================================================================

revoke all on v_observations, v_question_answers, v_wishlist from anon;

-- The portal reads all three; nothing writes them. v_observations is not
-- auto-updatable anyway (it joins six relations), but the grant should say so
-- rather than relying on Postgres to refuse.
revoke insert, update, delete, truncate on v_observations, v_question_answers, v_wishlist
  from authenticated;
grant select on v_observations, v_question_answers, v_wishlist to authenticated;

-- cost_reader reads v_observations: it is the library the reader contributes
-- to, and 004 granted it the underlying tables.
grant select on v_observations to cost_reader;

alter table project_client_companies enable row level security;

revoke all on project_client_companies from anon;
revoke insert, update, delete, truncate, references, trigger
  on project_client_companies from authenticated;
grant select on project_client_companies to authenticated;

grant select, insert on project_client_companies to airtable_sync;

-- Column-level UPDATE, matching the two join tables in 011 exactly. It
-- enumerates every column, so it permits what a table-level grant would
-- permit today; what it changes is that a column added later is not
-- automatically writable. Revoked first so this is correct from either
-- starting state.
revoke update on project_client_companies from airtable_sync;
grant update (project_id, client_company_id, synced_at)
  on project_client_companies to airtable_sync;

drop policy if exists project_client_companies_read      on project_client_companies;
drop policy if exists project_client_companies_sync_read on project_client_companies;
drop policy if exists project_client_companies_sync_ins  on project_client_companies;
drop policy if exists project_client_companies_sync_upd  on project_client_companies;

create policy project_client_companies_read      on project_client_companies for select to authenticated using (is_active_user());
create policy project_client_companies_sync_read on project_client_companies for select to airtable_sync using (true);
create policy project_client_companies_sync_ins  on project_client_companies for insert to airtable_sync with check (true);
create policy project_client_companies_sync_upd  on project_client_companies for update to airtable_sync using (true) with check (true);


-- ============================================================================
-- VERIFICATION
--
-- Uncomment and run as a second query. Every row should read exactly this:
--
--   sector is text[]             true
--   city is text[]               true
--   region still scalar          true
--   client_id gone               true
--   subconsultants table gone    true
--   v_observations exists        1
--   v_observations is invoker    security_invoker=true
--   three join tables, one shape true
--   anon on ANY relation         none
--   anon on any sequence         none
--   authenticated writes a view  none
--   anon on project_client_co.   none
--   sync relations               21
--   reader relations             13
--
-- Both counts now span every relkind rather than just tables, so if either
-- comes back one higher than stated, that is the finding and not a typo:
-- it means a view is carrying a privilege nobody granted it on purpose.
--
-- "three join tables, one shape" is the check worth having: after 011 there
-- were four and they had to match; 012 drops one and adds one, so there are
-- three and they still have to. The shape is table-level SELECT and INSERT,
-- no table-level UPDATE, column-level UPDATE on synced_at, and no DELETE.
--
-- "anon on ANY relation" IS THE STANDING QUERY, and it replaces the one in
-- 010 rather than sitting alongside it. 010 asked with relkind = 'r', which
-- is how three views kept full privileges through a migration whose entire
-- subject was revoking them — the check and the fix shared a blind spot.
--
-- This one asks across every relkind: ordinary tables, views, materialised
-- views, partitioned tables and foreign tables, plus sequences, which carry
-- their own privileges and would not appear under any of the above. Five
-- instances of the same shape is enough to stop writing a narrower version
-- each time. Copy these three rows into every migration that grants or
-- revokes anything — and RUN them against the database before committing,
-- which is how the ::text cast below came to be missing. relkind is a
-- "char", so the concatenation is ambiguous without it and the whole query
-- aborts. It shipped here unrun; 013 was run first.
--
-- `reader relations` moves 12 → 13: cost_reader gains v_observations, which
-- it could read before only because the view carried default privileges. Now
-- it is granted deliberately. If that number is 14, something else was
-- granted that nobody intended.
-- ============================================================================
--
-- with three(t) as (values ('deliverable_project_managers'),
--                          ('deliverable_project_support'),
--                          ('project_client_contacts')),
-- all_join(t) as (select t from three union all values ('project_client_companies')),
-- pub as (select c.oid, c.relname, c.relkind from pg_class c
--           join pg_namespace n on n.oid = c.relnamespace
--          where n.nspname='public' and c.relkind in ('r','v','m','p','f'))
-- select 'sector is text[]' as item,
--        (select (data_type='ARRAY')::text from information_schema.columns
--          where table_schema='public' and table_name='projects' and column_name='sector') as value
-- union all select 'city is text[]',
--        (select (data_type='ARRAY')::text from information_schema.columns
--          where table_schema='public' and table_name='projects' and column_name='city')
-- union all select 'region still scalar',
--        (select (data_type='text')::text from information_schema.columns
--          where table_schema='public' and table_name='projects' and column_name='region')
-- union all select 'client_id gone',
--        (not exists (select 1 from information_schema.columns where table_schema='public'
--          and table_name='projects' and column_name='client_id'))::text
-- union all select 'subconsultants table gone',
--        (not exists (select 1 from information_schema.tables where table_schema='public'
--          and table_name='deliverable_subconsultants'))::text
-- union all select 'v_observations exists',
--        (select count(*)::text from pg_views where schemaname='public' and viewname='v_observations')
-- union all select 'v_observations is invoker',
--        (select coalesce(array_to_string(c.reloptions,','),'(none)') from pg_class c
--          join pg_namespace n on n.oid=c.relnamespace
--         where n.nspname='public' and c.relname='v_observations')
-- union all select 'three join tables, one shape',
--        (select bool_and(not has_table_privilege('airtable_sync', t,'UPDATE')
--                     and has_table_privilege('airtable_sync', t,'INSERT')
--                     and has_table_privilege('airtable_sync', t,'SELECT')
--                     and not has_table_privilege('airtable_sync', t,'DELETE')
--                     and has_column_privilege('airtable_sync', t,'synced_at','UPDATE'))
--           from all_join)::text
-- union all select 'anon on ANY relation',
--        coalesce((select string_agg(c.relname || ' (' || c.relkind::text || ')', ', ' order by c.relname)
--                    from pg_class c join pg_namespace n on n.oid = c.relnamespace
--                   where n.nspname = 'public' and c.relkind in ('r','v','m','p','f')
--                     and (has_table_privilege('anon', c.oid, 'SELECT')
--                       or has_table_privilege('anon', c.oid, 'INSERT')
--                       or has_table_privilege('anon', c.oid, 'UPDATE')
--                       or has_table_privilege('anon', c.oid, 'DELETE')
--                       or has_table_privilege('anon', c.oid, 'TRUNCATE'))), 'none')
-- union all select 'anon on any sequence',
--        coalesce((select string_agg(c.relname, ', ' order by c.relname)
--                    from pg_class c join pg_namespace n on n.oid = c.relnamespace
--                   where n.nspname = 'public' and c.relkind = 'S'
--                     and (has_sequence_privilege('anon', c.oid, 'USAGE')
--                       or has_sequence_privilege('anon', c.oid, 'SELECT')
--                       or has_sequence_privilege('anon', c.oid, 'UPDATE'))), 'none')
-- union all select 'authenticated writes a view',
--        coalesce((select string_agg(c.relname, ', ' order by c.relname)
--                    from pg_class c join pg_namespace n on n.oid = c.relnamespace
--                   where n.nspname = 'public' and c.relkind in ('v','m')
--                     and (has_table_privilege('authenticated', c.oid, 'INSERT')
--                       or has_table_privilege('authenticated', c.oid, 'UPDATE')
--                       or has_table_privilege('authenticated', c.oid, 'DELETE'))), 'none')
-- union all select 'anon on project_client_co.',
--        coalesce((select string_agg(relname, ', ') from pub
--                   where relname='project_client_companies'
--                     and has_table_privilege('anon', oid, 'SELECT')), 'none')
-- union all select 'sync relations',
--        (select count(*)::text from pub
--          where (has_any_column_privilege('airtable_sync', oid,'SELECT')
--            or has_any_column_privilege('airtable_sync', oid,'INSERT')
--            or has_any_column_privilege('airtable_sync', oid,'UPDATE')))
-- union all select 'reader relations',
--        (select count(*)::text from pub
--          where has_any_column_privilege('cost_reader', oid,'SELECT')
--             or has_any_column_privilege('cost_reader', oid,'INSERT')
--             or has_any_column_privilege('cost_reader', oid,'UPDATE'));
--
-- ============================================================================


-- ============================================================================
-- AFTER RUNNING THIS
--
-- 1. RUN THE VERIFICATION BLOCK, and run it. Three of the last five shipped
--    with a defect in the block rather than the migration.
--
-- 2. THE FIELD MAP CHANGES WITH THIS, and the sync will not work until it
--    does: `sector` and `city` must be read as text[] rather than text, and
--    "Link to Client Company (Add Here)" becomes a JoinSpec rather than a
--    scalar field. A text[] column fed by a scalar coercion fails on the
--    first row, which is at least loud.
--
-- 3. THEN A FULL DRY RUN against the final shape. The last one reported 116,
--    37 and 30 coercion failures on these three fields; all three should be
--    gone. The 12 unresolved subconsultant links should be gone too, because
--    the field that produced them is no longer read.
--
-- 4. STILL OPEN, and now across three join tables rather than four: a link
--    removed in Airtable has nowhere to be recorded. None of them has
--    is_active and the sync holds no DELETE. One decision covers all three.
-- ============================================================================
