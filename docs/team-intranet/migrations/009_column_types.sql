-- ============================================================================
-- Migration 009 — two columns whose type does not match their data
--
-- Run it in Supabase → SQL Editor → New query → paste → Run.
-- Expected result: "Success. No rows returned."
--
-- Requires 001 through 008.
--
-- NOT PURELY ADDITIVE: it changes the type of two existing columns. Both are
-- empty, nothing reads either, and neither has an index, a constraint or a
-- view over it — checked against the live catalog before this was written.
-- Safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Why this exists
--
-- Building the sync's field map meant reading the Airtable base rather than
-- the field inventory, and three columns turned out to be the wrong shape for
-- what Airtable actually holds. Two are worth fixing. The third is worth
-- abandoning, and §3 records that so nobody wires it up later.
--
-- Doing it now rather than after the first load is the whole point: the
-- alternative is importing 1,877 projects and 5,552 tasks with these columns
-- blank, changing the types, and running the load again.
-- ----------------------------------------------------------------------------


-- ============================================================================
-- 1. projects.market becomes text[]
--
-- It is fed by Airtable's "Secondary Category", which is a multiple select and
-- is genuinely multi-valued: in a sample of 100 projects, 66 carried two or
-- more, frequently four to eight — one reads "Port", "Government / Essential
-- Facilities", "Emergency / Operations", "Offices / Administrative".
--
-- `sector` and `city` are fed from multiple selects too and stay scalar,
-- because there the loss is 7% and 2%, and the sync records every value it
-- drops. Two thirds is a different thing: a `market` holding one of six
-- categories is worse than an empty one, because it looks like an answer.
--
-- GUARDED ON THE COLUMN'S CURRENT TYPE, NOT ITS CONTENTS. 007 shipped an
-- array[col] conversion that succeeded on a second run and produced a
-- two-dimensional array — no error, silent corruption. A null check would not
-- have caught it either: the rows that break are the populated ones.
-- ============================================================================

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'projects'
       and column_name = 'market' and data_type <> 'ARRAY')
  then
    alter table projects
      alter column market type text[]
      using case when market is null then null else array[market] end;
  end if;
end $$;

comment on column projects.market is
  'Airtable "Secondary Category", a multiple select. text[] because two thirds of projects carry more than one, often four to eight. sector stays scalar: it is multi-valued on only 7 percent.';


-- ============================================================================
-- 2. deliverables.construction_completion becomes text
--
-- 006 typed it `date` because Airtable calls the field "*Construction
-- Completion Date". It is a single select whose choices are bare YEARS —
-- 2018, 2019, 2020, 2021, 2022 — populated on 857 of 5,552 tasks, which is
-- real usage rather than an abandoned field.
--
-- So the answer is not to coerce it. new Date('2018') is 2018-01-01, and a
-- January nobody stated is worse than a year everybody can read. Text carries
-- "2018" faithfully, and anyone who wants to sort by it can parse it knowing
-- what precision they actually have.
--
-- The cast is explicit because Postgres will not turn a date into text
-- without being told how.
-- ============================================================================

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'deliverables'
       and column_name = 'construction_completion' and data_type = 'date')
  then
    alter table deliverables
      alter column construction_completion type text
      using construction_completion::text;
  end if;
end $$;

comment on column deliverables.construction_completion is
  'Airtable "*Construction Completion Date", a single select of bare years (2018-2022), populated on 857 of 5,552 tasks. Text, not date: a year in a date column becomes the first of January, which nobody stated.';


-- ============================================================================
-- 3. construction_start is abandoned, on both tables
--
-- No type change here — a comment, because the decision is the thing worth
-- recording. A reader of the schema will otherwise find an empty column and
-- assume the sync was never finished.
--
-- Airtable's "Construction Start Date" is a single select of month buckets
-- ("May-21", "Jun-21", one stray "Q1 2023"), populated on 3 of 1,877 projects
-- and 16 of 5,552 tasks. That alone would argue for leaving it out.
--
-- The stronger reason is whose fact it is. Construction start is the
-- ESCALATION TARGET — what a rate is escalated TO — and the reader already
-- extracts it from the document with evidence and confidence, because that is
-- what the basis of estimate states. The division of labour is that Airtable
-- is authoritative for what the project IS and the document for what the
-- estimate was PRICED AGAINST. This is the second kind.
--
-- Carrying a coarse month bucket populated three times would put a worse
-- source in competition with a better one, and somebody would then have to
-- reconcile the loser.
--
-- Neither column is dropped. `projects.construction_start` predates all of
-- this and something may yet want it; `deliverables.construction_start` is a
-- plausible home if the reader's determination ever wants to live on the
-- deliverable rather than on the frame. Dropping a column to make a point is
-- not worth a migration.
-- ============================================================================

comment on column projects.construction_start is
  'NOT fed by the Airtable sync, deliberately. Airtable holds month buckets ("May-21") on 3 of 1,877 projects, and construction start is the escalation target, which the reader reads from the document with evidence. See migration 009 section 3.';

comment on column deliverables.construction_start is
  'NOT fed by the Airtable sync, deliberately — 16 of 5,552 tasks, and the wrong type besides. Construction start is the escalation target and belongs to the document, not to Airtable. See migration 009 section 3.';


-- ============================================================================
-- VERIFICATION
--
-- Uncomment and run as a second query. Every row should read exactly this:
--
--   market is text[]             true
--   completion is text           true
--   both still empty             true
--   sync can still write market  true
--   sync can still write compl.  true
--   reader can still read market true
--   sync still cannot set active true
--   anon gained nothing          none
--
-- The last two are the standing rule from 008: a migration is not done until
-- what anon, authenticated and service_role can do with everything it touched
-- has been read back out of the catalog. This migration creates no objects, so
-- the answer should be that nothing changed — and "should be" is exactly why
-- the rule exists.
--
-- Column privileges survive a type change in Postgres, because they are held
-- against the column's number rather than its type. Rows four to six check
-- that rather than trusting it.
-- ============================================================================
--
-- select 'market is text[]' as item,
--        (select (data_type = 'ARRAY')::text from information_schema.columns
--          where table_schema='public' and table_name='projects'
--            and column_name='market') as value
-- union all select 'completion is text',
--        (select (data_type = 'text')::text from information_schema.columns
--          where table_schema='public' and table_name='deliverables'
--            and column_name='construction_completion')
-- union all select 'both still empty',
--        ((select count(*) from projects where market is not null) = 0
--     and (select count(*) from deliverables where construction_completion is not null) = 0)::text
-- union all select 'sync can still write market',
--        has_column_privilege('airtable_sync','public.projects','market','UPDATE')::text
-- union all select 'sync can still write compl.',
--        has_column_privilege('airtable_sync','public.deliverables',
--                             'construction_completion','UPDATE')::text
-- union all select 'reader can still read market',
--        has_column_privilege('cost_reader','public.projects','market','SELECT')::text
-- union all select 'sync still cannot set active',
--        (not has_column_privilege('airtable_sync','public.projects','is_active','UPDATE'))::text
-- union all select 'anon gained nothing',
--        coalesce((select string_agg(c.relname, ', ')
--                    from pg_class c join pg_namespace n on n.oid = c.relnamespace
--                   where n.nspname = 'public' and c.relkind = 'r'
--                     and c.relname in ('projects','deliverables')
--                     and has_table_privilege('anon', c.oid, 'SELECT')), 'none');
--
-- ============================================================================


-- ============================================================================
-- AFTER RUNNING THIS
--
-- 1. RUN THE VERIFICATION BLOCK, and actually run it. 008 shipped a block that
--    errored rather than reported, because a verification block is
--    commented-out SQL and a replay never executes it. It is the one artefact
--    whose job is to prove the migration, and it earns that only by being run
--    at least once against the state the migration produces.
--
-- 2. THE SYNC'S FIELD MAP CHANGES WITH THIS. `market` and
--    `construction_completion` can be mapped once this is applied, and the
--    sync has to be updated in the same breath. A text[] column fed by a
--    scalar coercion fails on the first row, which is at least loud.
--
-- 3. WHAT IS STILL LEFT OUT: construction_start on both tables, by the
--    decision in section 3. Nothing else in phase one is unmapped.
-- ============================================================================
