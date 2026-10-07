-- ============================================================================
-- 019 — four join tables, three column drops, and one view
--
-- Everything the remaining four field maps need from the schema, in one
-- migration rather than one per discovery. Same argument as checking all seven
-- unverified foreign keys as a SET before writing any map, which is what found
-- time_entries.project_id and saved writing five maps around it.
--
-- NO BACKFILL AND NO ORDERING TRAP. project_notes, pursuits, activity_log and
-- time_entries all hold 0 rows, so the join tables are created empty and the
-- first sync fills them. 018 needed two backfills and a drop-last rule because
-- out_of_office was already loaded; none of that applies here.
--
-- ============================================================================
-- CARDINALITY, COUNTED ACROSS FULL POPULATIONS
--
-- Per the standing rule in tables.ts: any link whose config says
-- prefersSingleRecordLink:false gets counted across the whole table before it
-- becomes a scalar column. Measured 2026-10-07 against the live base.
--
-- SCALAR IS WRONG — these three become joins:
--
--   project_notes."DCW Project Tasks"   361 of 3,520 have 2+   (10%)
--   pursuits."Client Company"           774 of 3,491 have 2+   (22%)
--   pursuits."Client Contact (Link)"    749 of 3,491 have 2+   (21%)
--
-- AND ONE HAS NO COLUMN AT ALL:
--
--   pursuits."Assignees"                618 of 3,491 have 2+   (18%)
--
-- SCALAR IS SAFE — these three stay columns, FOR THREE DIFFERENT REASONS,
-- and the differences matter more than the shared conclusion:
--
--   activity_log.action_owner_id   0 MULTIPLES, COUNTED. This originally read
--                                  "single BY SCHEMA ... cannot become
--                                  multiple without somebody deliberately
--                                  changing the base", because the config says
--                                  prefersSingleRecordLink:true. THAT IS
--                                  WRONG — the flag is a UI preference and
--                                  Airtable does not enforce it. See 021:
--                                  "DCW Project Task" on the same table is
--                                  also marked true and 32 records hold
--                                  several. Safe by measurement, not schema.
--
--   activity_log.logged_by_id      SINGLE BY TODAY'S DATA ONLY. The config
--                                  says false — Airtable permits several —
--                                  and 3,944 records happen to have exactly
--                                  one (409 have none, 0 have multiple). It
--                                  can become multiple at any moment with no
--                                  schema change.
--
--   time_entries.pursuit_id        PERMITS MULTIPLE AND IS ENTIRELY UNUSED:
--                                  0 of 29,199 time entries link any pursuit.
--
-- EVERY ONE OF THESE IS A MEASUREMENT WITH A DATE ON IT, not a guarantee.
-- The first version of this analysis said "both are safe"; the second drew a
-- distinction between single-by-schema and single-by-data and called the
-- former settled. Neither was right. There is no single-by-schema for an
-- Airtable link — the flag that appears to provide it does not.
--
-- WHY SCALAR IS ACCEPTABLE FOR THE SECOND AND THIRD: a scalar column here is
-- NOT SILENT. When out_of_office hit this exact case the sync raised
-- coercion_failed "N links, kept the first" on all six records, which is how
-- it was found at all. That detector is proven — it fired six times on
-- 2026-10-06 and went quiet once the join existed.
--
-- BUT THE SAFETY NET HAS A HUMAN IN IT. It only helps if somebody reads
-- sync_anomalies, and that table keeps one row per issue PER RUN, so a raw
-- count there overstates. See the note at recordAnomalies in run.ts.
--
-- ============================================================================
-- time_entries.pursuit_id IS NOT 017, AND THIS COMMENT EXISTS TO SAY SO
--
-- 0 of 29,199 looks exactly like the case 017 dropped. It is the opposite one.
--
--   017's time_entries.project_id    had NO SOURCE. No Airtable field pointed
--                                    at New Project Entry, so nothing could
--                                    ever fill it.
--   this pursuit_id                  has a VALID SOURCE THAT IS EMPTY. The
--                                    link "DCW Project Pursuits" exists,
--                                    points where its name says, and simply
--                                    has not been used.
--
-- So it stays. Somebody checking "is this column used?" finds zero and reaches
-- for the 017 precedent, which is the rule applied correctly to the wrong
-- case. Whether the Airtable FIELD is vestigial after 29,199 unused records is
-- a question for the team, not something to settle by dropping a column.
-- ============================================================================

create table if not exists project_note_deliverables (
  project_note_id uuid not null references project_notes(id) on delete cascade,
  deliverable_id  uuid not null references deliverables(id)  on delete cascade,
  synced_at       timestamptz not null default now(),
  primary key (project_note_id, deliverable_id)
);
create index if not exists project_note_deliverables_deliverable_idx
  on project_note_deliverables (deliverable_id);

create table if not exists pursuit_client_companies (
  pursuit_id        uuid not null references pursuits(id)         on delete cascade,
  client_company_id uuid not null references client_companies(id) on delete cascade,
  synced_at         timestamptz not null default now(),
  primary key (pursuit_id, client_company_id)
);
create index if not exists pursuit_client_companies_company_idx
  on pursuit_client_companies (client_company_id);

create table if not exists pursuit_client_contacts (
  pursuit_id uuid not null references pursuits(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  synced_at  timestamptz not null default now(),
  primary key (pursuit_id, contact_id)
);
create index if not exists pursuit_client_contacts_contact_idx
  on pursuit_client_contacts (contact_id);

create table if not exists pursuit_assignees (
  pursuit_id uuid not null references pursuits(id) on delete cascade,
  person_id  uuid not null references people(id)   on delete cascade,
  synced_at  timestamptz not null default now(),
  primary key (pursuit_id, person_id)
);
create index if not exists pursuit_assignees_person_idx
  on pursuit_assignees (person_id);

-- GRANTS ARE COPIED FROM deliverable_project_managers, WHICH IS THE JOIN TABLE
-- THAT WORKS, AND THE SHAPE IS NOT OBVIOUS: insert and select at table level,
-- UPDATE AT COLUMN LEVEL on all three columns. has_table_privilege(role,
-- table, 'UPDATE') reads FALSE on a correctly configured join table, so the
-- obvious check reports a problem that is not there.
--
-- The column-level UPDATE is what satisfies buildJoinUpsert's
-- "on conflict do update set synced_at = now()". Omit it and the first sync of
-- a 3,500-row table fails outright on its first conflicting row.
grant insert, select on project_note_deliverables to airtable_sync;
grant update (project_note_id, deliverable_id, synced_at)
  on project_note_deliverables to airtable_sync;

grant insert, select on pursuit_client_companies to airtable_sync;
grant update (pursuit_id, client_company_id, synced_at)
  on pursuit_client_companies to airtable_sync;

grant insert, select on pursuit_client_contacts to airtable_sync;
grant update (pursuit_id, contact_id, synced_at)
  on pursuit_client_contacts to airtable_sync;

grant insert, select on pursuit_assignees to airtable_sync;
grant update (pursuit_id, person_id, synced_at)
  on pursuit_assignees to airtable_sync;

alter table project_note_deliverables enable row level security;
alter table pursuit_client_companies  enable row level security;
alter table pursuit_client_contacts   enable row level security;
alter table pursuit_assignees         enable row level security;

-- EVERY POLICY IS DROPPED FIRST, SO THIS MIGRATION CAN BE RE-RUN.
--
-- Postgres has no `create policy if not exists` — not in 17, not anywhere —
-- so an unguarded create is correct exactly once. The first version of this
-- file had 16 creates and 0 drops: run 1 clean, run 2 failed on the first
-- policy and aborted everything after it, which here was the other 15
-- policies, the three column drops and the view.
--
-- Same class as 007's unguarded rename. A migration that only works on a
-- virgin database is one nobody can replay, and replaying before applying is
-- the standing practice that catches things like this.
--
-- Everything else in this file is already idempotent: create table / create
-- index if not exists, grant, enable row level security, drop column if
-- exists, create or replace view.

drop policy if exists project_note_deliverables_read on project_note_deliverables;
create policy project_note_deliverables_read on project_note_deliverables
  for select to authenticated using (true);
drop policy if exists project_note_deliverables_sync_ins on project_note_deliverables;
create policy project_note_deliverables_sync_ins on project_note_deliverables
  for insert to airtable_sync with check (true);
drop policy if exists project_note_deliverables_sync_read on project_note_deliverables;
create policy project_note_deliverables_sync_read on project_note_deliverables
  for select to airtable_sync using (true);
drop policy if exists project_note_deliverables_sync_upd on project_note_deliverables;
create policy project_note_deliverables_sync_upd on project_note_deliverables
  for update to airtable_sync using (true) with check (true);

drop policy if exists pursuit_client_companies_read on pursuit_client_companies;
create policy pursuit_client_companies_read on pursuit_client_companies
  for select to authenticated using (true);
drop policy if exists pursuit_client_companies_sync_ins on pursuit_client_companies;
create policy pursuit_client_companies_sync_ins on pursuit_client_companies
  for insert to airtable_sync with check (true);
drop policy if exists pursuit_client_companies_sync_read on pursuit_client_companies;
create policy pursuit_client_companies_sync_read on pursuit_client_companies
  for select to airtable_sync using (true);
drop policy if exists pursuit_client_companies_sync_upd on pursuit_client_companies;
create policy pursuit_client_companies_sync_upd on pursuit_client_companies
  for update to airtable_sync using (true) with check (true);

drop policy if exists pursuit_client_contacts_read on pursuit_client_contacts;
create policy pursuit_client_contacts_read on pursuit_client_contacts
  for select to authenticated using (true);
drop policy if exists pursuit_client_contacts_sync_ins on pursuit_client_contacts;
create policy pursuit_client_contacts_sync_ins on pursuit_client_contacts
  for insert to airtable_sync with check (true);
drop policy if exists pursuit_client_contacts_sync_read on pursuit_client_contacts;
create policy pursuit_client_contacts_sync_read on pursuit_client_contacts
  for select to airtable_sync using (true);
drop policy if exists pursuit_client_contacts_sync_upd on pursuit_client_contacts;
create policy pursuit_client_contacts_sync_upd on pursuit_client_contacts
  for update to airtable_sync using (true) with check (true);

drop policy if exists pursuit_assignees_read on pursuit_assignees;
create policy pursuit_assignees_read on pursuit_assignees
  for select to authenticated using (true);
drop policy if exists pursuit_assignees_sync_ins on pursuit_assignees;
create policy pursuit_assignees_sync_ins on pursuit_assignees
  for insert to airtable_sync with check (true);
drop policy if exists pursuit_assignees_sync_read on pursuit_assignees;
create policy pursuit_assignees_sync_read on pursuit_assignees
  for select to airtable_sync using (true);
drop policy if exists pursuit_assignees_sync_upd on pursuit_assignees;
create policy pursuit_assignees_sync_upd on pursuit_assignees
  for update to airtable_sync using (true) with check (true);

-- ============================================================================
-- THE DROPS
--
-- Same reasoning as out_of_office.person_id in 018 and time_entries.project_id
-- in 017: a column holding one of three clients is worse than no column,
-- because the partial answer is the one somebody uses, and two sources for one
-- fact means every query has to know which to trust.
--
-- Free: all three tables hold 0 rows, and nothing in src/ reads project_notes
-- or pursuits — checked, not assumed.
-- ============================================================================

alter table project_notes drop column if exists deliverable_id;
alter table pursuits      drop column if exists client_company_id;
alter table pursuits      drop column if exists client_contact_id;

-- project_notes KEEPS project_id as a scalar and this is deliberate, not an
-- oversight. "DCW Projects" on Project Notes genuinely points at New Project
-- Entry — the documented exception to the standing rule that a link named for
-- a project means task — and it is single. So this table ends up with one
-- scalar link and one join link, which reads as inconsistent and is correct.

-- ============================================================================
-- THE VIEW — AND WHY IT DOES NOT EXPOSE "THE FIRST CLIENT"
--
-- The need is real: a pursuits page wants the client without writing a join
-- every time. The obvious shape is a "primary client" column, and it is a trap
-- this migration deliberately avoids.
--
-- OUR JOIN TABLES CARRY NO ORDER. They are (parent, child, synced_at), and
-- buildJoinUpsert writes rows from Airtable's array without recording its
-- index. Airtable's link arrays ARE ordered and that order is user-controlled,
-- but we discard it. So "the first client" would mean "whichever row the query
-- plan happened to return first" — stable-looking, arbitrary, and wrong for
-- the 22% with more than one.
--
-- THAT IS NOT HYPOTHETICAL. deriveGrossSf picks the "latest" deliverable with
-- distinct on and no tiebreak column; measured 2026-10-06, five projects have
-- tied deliverables with DIFFERENT building_sf, so their gross_sf is whichever
-- row came back first — Tribal School's four same-dated deliverables span
-- 10,000 to 25,000 sf. A "primary client" view would be the same bug, written
-- the day after that one was found.
--
-- So this view reports ALL of them, with counts. For the 78% with one client
-- it displays one name and the page is as cheap as a column would have been.
-- For the rest it displays the truth. Ordering inside string_agg is by name:
-- that is a DISPLAY order for a complete list, not a choice of which record
-- wins, which is the distinction that makes it safe.
--
-- If a genuine primary is ever needed, it needs Airtable's array index carried
-- into the join tables as a position column — a schema change AND a change to
-- buildJoinUpsert. That is the honest route; a view cannot invent the order.
--
-- security_invoker = true matches v_observations, v_question_answers and
-- v_wishlist, so RLS is evaluated as the querying user rather than the view's
-- owner. v_people_compensation is the one view without it, which is what 013
-- had to go back and fix.
-- ============================================================================

create or replace view v_pursuit_clients
with (security_invoker = true) as
select p.id as pursuit_id,
       (select count(*) from pursuit_client_companies x where x.pursuit_id = p.id)
         as client_company_count,
       -- company_name / contact_name, NOT name. Checked against the live
       -- schema; the first draft of this view used .name on both and would
       -- have failed on paste.
       (select string_agg(c.company_name, ', ' order by c.company_name)
          from pursuit_client_companies x
          join client_companies c on c.id = x.client_company_id
         where x.pursuit_id = p.id) as client_company_names,
       (select count(*) from pursuit_client_contacts x where x.pursuit_id = p.id)
         as client_contact_count,
       (select string_agg(ct.contact_name, ', ' order by ct.contact_name)
          from pursuit_client_contacts x
          join contacts ct on ct.id = x.contact_id
         where x.pursuit_id = p.id) as client_contact_names,
       (select count(*) from pursuit_assignees x where x.pursuit_id = p.id)
         as assignee_count,
       (select string_agg(pe.name, ', ' order by pe.name)
          from pursuit_assignees x
          join people pe on pe.id = x.person_id
         where x.pursuit_id = p.id) as assignee_names
  from pursuits p;

grant select on v_pursuit_clients to authenticated;

-- ============================================================================
-- VERIFICATION
--
-- Uncomment and run as a second query, after the above commits.
--
-- THE EXPECTED VALUES BELOW ARE NOT FILLED IN, DELIBERATELY. 018's block
-- predicted 851 attendance links and told the reader to treat anything less as
-- failure; production produced 773, which was correct, and the prediction came
-- from arithmetic over a null rate that had already been measured. An expected
-- value is a prediction and gets the same treatment as any other claim:
-- measured, or marked unverified.
--
-- What CAN be stated in advance, because it follows from the DDL rather than
-- from data:
--
--   four join tables exist           4
--   each has its two FKs             true  (8 foreign keys, all CASCADE)
--   SYNC CAN INSERT (all four)       true
--   SYNC CAN UPDATE synced_at        true   <- column-level; the table-level
--                                              check reads FALSE and is wrong
--   RLS on, 4 policies each          16
--   dropped columns gone             true
--   project_notes.project_id kept    uuid
--   v_pursuit_clients security_invoker  true
--   view readable by authenticated   true
--
-- Row counts are all 0 and stay 0: this migration creates empty tables. The
-- numbers that matter arrive with the first sync of each table, and belong in
-- that run's notes rather than predicted here.
--
-- Run against production before committing, per the standing practice.
-- ============================================================================
--
-- select 'four join tables exist' as item,
--        (select count(*)::text from information_schema.tables
--          where table_schema='public' and table_name in
--            ('project_note_deliverables','pursuit_client_companies',
--             'pursuit_client_contacts','pursuit_assignees')) as value
-- union all select 'foreign keys, all CASCADE',
--        (select count(*)::text from pg_constraint
--          where contype='f' and confdeltype='c'
--            and conrelid::regclass::text in
--              ('project_note_deliverables','pursuit_client_companies',
--               'pursuit_client_contacts','pursuit_assignees'))
-- union all select 'SYNC CAN INSERT (all four true)',
--        (has_table_privilege('airtable_sync','project_note_deliverables','INSERT')
--     and has_table_privilege('airtable_sync','pursuit_client_companies','INSERT')
--     and has_table_privilege('airtable_sync','pursuit_client_contacts','INSERT')
--     and has_table_privilege('airtable_sync','pursuit_assignees','INSERT'))::text
-- union all select 'SYNC CAN UPDATE synced_at (all four true)',
--        (has_column_privilege('airtable_sync','project_note_deliverables','synced_at','UPDATE')
--     and has_column_privilege('airtable_sync','pursuit_client_companies','synced_at','UPDATE')
--     and has_column_privilege('airtable_sync','pursuit_client_contacts','synced_at','UPDATE')
--     and has_column_privilege('airtable_sync','pursuit_assignees','synced_at','UPDATE'))::text
-- union all select 'policies across the four',
--        (select count(*)::text from pg_policies where tablename in
--          ('project_note_deliverables','pursuit_client_companies',
--           'pursuit_client_contacts','pursuit_assignees'))
-- union all select 'dropped columns gone',
--        (not exists (select 1 from information_schema.columns
--          where table_schema='public'
--            and ((table_name='project_notes' and column_name='deliverable_id')
--              or (table_name='pursuits' and column_name in
--                    ('client_company_id','client_contact_id')))))::text
-- union all select 'project_notes.project_id kept',
--        coalesce((select data_type from information_schema.columns
--                   where table_schema='public' and table_name='project_notes'
--                     and column_name='project_id'), 'MISSING')
-- union all select 'v_pursuit_clients security_invoker',
--        coalesce((select option_value from pg_class c
--                    join pg_namespace n on n.oid=c.relnamespace,
--                  pg_options_to_table(c.reloptions)
--                   where c.relname='v_pursuit_clients' and n.nspname='public'
--                     and option_name='security_invoker'), 'NOT SET')
-- union all select 'view readable by authenticated',
--        has_table_privilege('authenticated','v_pursuit_clients','SELECT')::text
-- union all select 'view returns rows (0 until pursuits loads)',
--        (select count(*)::text from v_pursuit_clients);
--
-- ============================================================================
