-- ============================================================================
-- Migration 011 — three relationships that are genuinely many-to-many
--
-- Run it in Supabase → SQL Editor → New query → paste → Run.
-- Expected result: "Success. No rows returned."
--
-- Requires 001 through 010.
--
-- NOT PURELY ADDITIVE. It drops one table and three columns. All four are
-- empty — checked against the live catalog — and nothing reads any of them:
-- no views, no application code, and the sync has not run outside a dry run.
-- Safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Why this exists
--
-- The first dry run reported that several link fields hold more than one
-- value, and the mirror models them as a single uuid. Measured across the
-- whole base rather than the 25-record sample:
--
--   Project Manager * on tasks        2,705 with one,  380 with two or more (12%)
--   Client Contact on projects        1,356 with one,  287 with two or more (17%)
--
-- A scalar column keeps the first and drops the rest, and what is dropped is a
-- person. "Who else worked on this" becomes unanswerable, quietly, on one
-- record in eight.
--
-- "ALLOWS MULTIPLE" IS NOT THE TEST, AND THIS IS THE PART WORTH KEEPING
--
-- Airtable creates a field on BOTH sides of every link, and the parent side
-- always allows many. "New Project Entry → DCW Project Tasks" and "DCW Project
-- Tasks → New Project Entry" are one relationship seen twice; it is a plain
-- foreign key on the child. Reading "allows multiple" as "needs a join table"
-- would have produced a join table for every link in the base.
--
-- The real test is whether BOTH sides allow multiple. Pairing all 43 link
-- fields across the six phase-one tables with their inverses:
--
--   2 are genuinely one-to-many   tasks → projects, contacts → client company.
--                                 Both already correct as FKs on the child,
--                                 which is what dropping 006's 36 reversed
--                                 links left behind.
--
--   5 are genuinely many-to-many  and three of them are built below.
--
-- THE OTHER TWO ARE LEFT AS SCALAR COLUMNS, AND THAT IS A MEASUREMENT RATHER
-- THAN AN OMISSION:
--
--   Client Lead / Client Lead Backup on companies    17 of 483 populated,
--                                                    every one a single person
--   Link to Subconsultant Company on contacts        3 populated, all single
--
-- The fields permit more than one; the data has never contained more than one.
-- `client_lead_id`, `client_lead_backup_id` and `contacts.subconsultant_id`
-- therefore stay as they are. If that changes, this comment is the record of
-- why they were not built as join tables, and the fix is the same shape as §2.
-- ----------------------------------------------------------------------------


-- ============================================================================
-- 1. deliverable_assignees is dropped — the field has never held a value
--
-- 006 created it for "Assigned Team Members" on DCW Project Tasks. That field
-- is EMPTY ON ALL 5,555 RECORDS. Not sparse: zero.
--
-- The inventory's own note on it reads "this was an attempt to track
-- estimators workload", which is the past tense of a feature that did not
-- happen. An empty table nobody can account for is worse than no table, and
-- there is no data to lose.
--
-- It also means the three Collaborators ↔ Tasks link fields are really two:
-- Project Manager and Project Support.
-- ============================================================================

drop table if exists deliverable_assignees;


-- ============================================================================
-- 2. Three join tables
--
-- Same shape as `deliverable_subconsultants`, which stays — a deliverable can
-- involve several subconsultants and that one was right.
--
-- No `role` column and no shared table: which table a row is in says what the
-- relationship is. One `deliverable_people` table with a role would need a
-- constraint to stop a row claiming two roles, an index per role to be useful,
-- and a reader who knows the convention. Three tables need none of that.
--
-- No `airtable_record_id`, for the same reason as the existing join table: an
-- Airtable link is not a record, it is an entry in a cell. The sync rebuilds
-- these rows from the parent's link field, which is why the key is the pair.
--
-- No `is_active` either, which is a deliberate gap rather than an oversight —
-- the same one §4 of 007 describes. A link removed in Airtable has nowhere to
-- be recorded, because the sync cannot delete and these tables have no flag.
-- Whether a removed link is an error to flag or an ordinary edit to follow is
-- unanswered, and it applies identically to all four join tables. Settling it
-- is one decision, not four.
-- ============================================================================

create table if not exists deliverable_project_managers (
  deliverable_id uuid not null references deliverables(id) on delete cascade,
  person_id      uuid not null references people(id) on delete cascade,
  synced_at      timestamptz not null default now(),
  primary key (deliverable_id, person_id)
);

create index if not exists deliverable_project_managers_person_idx
  on deliverable_project_managers (person_id);

comment on table deliverable_project_managers is
  'Airtable "Project Manager *" on DCW Project Tasks. A join table because 380 of 3,085 tasks name more than one, and a scalar column would silently drop a person.';


create table if not exists deliverable_project_support (
  deliverable_id uuid not null references deliverables(id) on delete cascade,
  person_id      uuid not null references people(id) on delete cascade,
  synced_at      timestamptz not null default now(),
  primary key (deliverable_id, person_id)
);

create index if not exists deliverable_project_support_person_idx
  on deliverable_project_support (person_id);

comment on table deliverable_project_support is
  'Airtable "Project Support *" on DCW Project Tasks. Separate from the project managers table rather than one table with a role column: which table a row is in says what the relationship is.';


create table if not exists project_client_contacts (
  project_id uuid not null references projects(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  synced_at  timestamptz not null default now(),
  primary key (project_id, contact_id)
);

create index if not exists project_client_contacts_contact_idx
  on project_client_contacts (contact_id);

comment on table project_client_contacts is
  'Airtable "Client Contact (Linked)" on New Project Entry. A join table because 287 of 1,643 projects name more than one contact — the highest multi-value rate in phase one at 17%.';


-- ============================================================================
-- 3. The scalar columns they replace
--
-- All three are empty: the sync has only ever run as a dry run, which writes
-- nothing. Their indexes (deliverables_pm_idx, deliverables_support_idx,
-- projects_client_contact_idx) are dropped by Postgres along with them, and
-- so are the column-level grants 007 gave airtable_sync on them.
-- ============================================================================

alter table deliverables drop column if exists project_manager_id;
alter table deliverables drop column if exists project_support_id;
alter table projects     drop column if exists client_contact_id;

-- `next_action_owner_id` on deliverables is NOT dropped. "Next Action Owner"
-- is a single-value link in Airtable and stays a scalar FK.


-- ============================================================================
-- 4. Privileges and policies
--
-- At the END of the migration, driven from one list of the objects it created,
-- which is the rule 010's header sets out. Three defects before it were the
-- same shape: a revoke written against what existed when it was written, with
-- objects added lower in the same file never added to it. The list below is
-- visibly the same three tables as §2.
--
-- Supabase grants ALL on every new table in `public` to anon, authenticated
-- and service_role, so the revokes are not tidying — they are the difference
-- between RLS being the only guard and being the second one. 008's standing
-- rule says to read the answer back out of the catalog rather than assume it,
-- and the verification block does.
-- ============================================================================

alter table deliverable_project_managers enable row level security;
alter table deliverable_project_support  enable row level security;
alter table project_client_contacts      enable row level security;

revoke all on
  deliverable_project_managers, deliverable_project_support, project_client_contacts
from anon;

revoke insert, update, delete, truncate, references, trigger on
  deliverable_project_managers, deliverable_project_support, project_client_contacts
from authenticated;

grant select on
  deliverable_project_managers, deliverable_project_support, project_client_contacts
to authenticated;

grant select, insert on
  deliverable_project_managers, deliverable_project_support, project_client_contacts
to airtable_sync;

-- UPDATE is COLUMN-LEVEL, matching deliverable_subconsultants exactly.
--
-- It enumerates every column, so it permits precisely what a table-level
-- grant would permit today — the two are identical in effect, and this is not
-- a tightening. What it changes is the future: a column added to one of these
-- tables later is automatically writable under a table-level grant and is not
-- under this one. That is the same mechanism 006 had to close on
-- `deliverables`, where table-level SELECT would have handed cost_reader the
-- billing columns the moment they existed.
--
-- The reason to match rather than to leave it is legibility. 008 converted
-- the fourteen mirror tables from table-level to column-level and
-- deliverable_subconsultants went with them; these three were written
-- afterwards and did not. Four join tables in two shapes is exactly the thing
-- a reader cannot tell a decision from an oversight.
--
-- And it is the FOURTH instance of one pattern — 006's anon on fourteen
-- tables rather than twenty-two, 007's sweep function, 007's three sync
-- bookkeeping tables, and now this. Every one a rule applied to what existed
-- when it was written rather than to what the rule was about. 010's header
-- says to drive the privilege section from the migration's own object list;
-- it did not say to check the list against the objects the rule ALREADY
-- covers elsewhere, which is what would have caught this.
-- Revoked first, so this is correct from either starting state. An earlier
-- draft of this migration granted table-level UPDATE; a database that ran
-- that draft and then this one would otherwise keep the table-level grant,
-- because granting at column level does not remove it. The file was
-- idempotent across runs of itself and not across versions of itself, which
-- is a distinction worth having in every migration that narrows something.
revoke update on
  deliverable_project_managers, deliverable_project_support, project_client_contacts
from airtable_sync;

grant update (deliverable_id, person_id, synced_at)
  on deliverable_project_managers to airtable_sync;
grant update (deliverable_id, person_id, synced_at)
  on deliverable_project_support to airtable_sync;
grant update (project_id, contact_id, synced_at)
  on project_client_contacts to airtable_sync;

-- No DELETE for the sync, as everywhere. These tables have no is_active, so a
-- link removed in Airtable currently persists — see the note in §2. That is a
-- gap to close with a decision, not by handing the sync a delete.

drop policy if exists deliverable_project_managers_read      on deliverable_project_managers;
drop policy if exists deliverable_project_managers_sync_read on deliverable_project_managers;
drop policy if exists deliverable_project_managers_sync_ins  on deliverable_project_managers;
drop policy if exists deliverable_project_managers_sync_upd  on deliverable_project_managers;
drop policy if exists deliverable_project_support_read       on deliverable_project_support;
drop policy if exists deliverable_project_support_sync_read  on deliverable_project_support;
drop policy if exists deliverable_project_support_sync_ins   on deliverable_project_support;
drop policy if exists deliverable_project_support_sync_upd   on deliverable_project_support;
drop policy if exists project_client_contacts_read           on project_client_contacts;
drop policy if exists project_client_contacts_sync_read      on project_client_contacts;
drop policy if exists project_client_contacts_sync_ins       on project_client_contacts;
drop policy if exists project_client_contacts_sync_upd       on project_client_contacts;

create policy deliverable_project_managers_read      on deliverable_project_managers for select to authenticated using (is_active_user());
create policy deliverable_project_managers_sync_read on deliverable_project_managers for select to airtable_sync using (true);
create policy deliverable_project_managers_sync_ins  on deliverable_project_managers for insert to airtable_sync with check (true);
create policy deliverable_project_managers_sync_upd  on deliverable_project_managers for update to airtable_sync using (true) with check (true);

create policy deliverable_project_support_read       on deliverable_project_support for select to authenticated using (is_active_user());
create policy deliverable_project_support_sync_read  on deliverable_project_support for select to airtable_sync using (true);
create policy deliverable_project_support_sync_ins   on deliverable_project_support for insert to airtable_sync with check (true);
create policy deliverable_project_support_sync_upd   on deliverable_project_support for update to airtable_sync using (true) with check (true);

create policy project_client_contacts_read           on project_client_contacts for select to authenticated using (is_active_user());
create policy project_client_contacts_sync_read      on project_client_contacts for select to airtable_sync using (true);
create policy project_client_contacts_sync_ins       on project_client_contacts for insert to airtable_sync with check (true);
create policy project_client_contacts_sync_upd       on project_client_contacts for update to airtable_sync using (true) with check (true);


-- ============================================================================
-- VERIFICATION
--
-- Uncomment and run as a second query. Every row should read exactly this:
--
--   three join tables exist      3
--   assignees table gone         true
--   three columns gone           true
--   next_action_owner_id kept    true
--   anon on the three            none
--   authenticated: read only     true
--   sync can write the three     true
--   sync UPDATE is column-level  true
--   all four join tables match   true
--   sync cannot delete them      true
--   sync relations               21
--   reader relations             12
--
-- `sync relations` moves from 19 to 21: minus deliverable_assignees, plus
-- three. `reader relations` must not move at all — cost_reader has no business
-- in any of this, and a 13 there would mean something leaked.
-- ============================================================================
--
-- with three(t) as (values ('deliverable_project_managers'),
--                          ('deliverable_project_support'),
--                          ('project_client_contacts')),
-- pub as (select c.oid, c.relname from pg_class c
--           join pg_namespace n on n.oid = c.relnamespace
--          where n.nspname='public' and c.relkind='r')
-- select 'three join tables exist' as item,
--        (select count(*)::text from information_schema.tables
--          where table_schema='public' and table_name in (select t from three)) as value
-- union all select 'assignees table gone',
--        (not exists (select 1 from information_schema.tables
--          where table_schema='public' and table_name='deliverable_assignees'))::text
-- union all select 'three columns gone',
--        (not exists (select 1 from information_schema.columns
--          where table_schema='public'
--            and ((table_name='deliverables' and column_name in ('project_manager_id','project_support_id'))
--              or (table_name='projects' and column_name='client_contact_id'))))::text
-- union all select 'next_action_owner_id kept',
--        (exists (select 1 from information_schema.columns
--          where table_schema='public' and table_name='deliverables'
--            and column_name='next_action_owner_id'))::text
-- union all select 'anon on the three',
--        coalesce((select string_agg(relname, ', ' order by relname) from pub
--                   where relname in (select t from three)
--                     and (has_table_privilege('anon', oid, 'SELECT')
--                       or has_table_privilege('anon', oid, 'INSERT')
--                       or has_table_privilege('anon', oid, 'TRUNCATE'))), 'none')
-- union all select 'authenticated: read only',
--        (select bool_and(has_table_privilege('authenticated', t, 'SELECT')
--                     and not has_table_privilege('authenticated', t, 'INSERT')
--                     and not has_table_privilege('authenticated', t, 'UPDATE')
--                     and not has_table_privilege('authenticated', t, 'DELETE')
--                     and not has_table_privilege('authenticated', t, 'TRUNCATE'))
--           from three)::text
-- union all select 'sync can write the three',
--        (select bool_and(has_table_privilege('airtable_sync', t, 'SELECT')
--                     and has_table_privilege('airtable_sync', t, 'INSERT')
--                     and has_table_privilege('airtable_sync', t, 'UPDATE'))
--           from three)::text
-- union all select 'sync UPDATE is column-level',
--        (select bool_and(not has_table_privilege('airtable_sync', t, 'UPDATE')
--                     and has_column_privilege('airtable_sync', t, 'synced_at', 'UPDATE'))
--           from three)::text
-- union all select 'all four join tables match',
--        (select bool_and(not has_table_privilege('airtable_sync', t, 'UPDATE')
--                     and has_table_privilege('airtable_sync', t, 'INSERT')
--                     and has_table_privilege('airtable_sync', t, 'SELECT')
--                     and not has_table_privilege('airtable_sync', t, 'DELETE'))
--           from (select t from three
--                 union all values ('deliverable_subconsultants')) all_four(t))::text
-- union all select 'sync cannot delete them',
--        (select bool_and(not has_table_privilege('airtable_sync', t, 'DELETE')) from three)::text
-- union all select 'sync relations',
--        (select count(*)::text from pub
--          where has_any_column_privilege('airtable_sync', oid, 'SELECT')
--             or has_any_column_privilege('airtable_sync', oid, 'INSERT')
--             or has_any_column_privilege('airtable_sync', oid, 'UPDATE'))
-- union all select 'reader relations',
--        (select count(*)::text from pub
--          where has_any_column_privilege('cost_reader', oid, 'SELECT')
--             or has_any_column_privilege('cost_reader', oid, 'INSERT')
--             or has_any_column_privilege('cost_reader', oid, 'UPDATE'));
--
-- ============================================================================


-- ============================================================================
-- AFTER RUNNING THIS
--
-- 1. RUN THE VERIFICATION BLOCK, and run it rather than read it. Two of the
--    last four shipped with defects — 008's errored, 009's asserted something
--    false — because a replay never executes commented-out SQL.
--
-- 2. THE SYNC'S FIELD MAP CHANGES WITH THIS, and it will not work until it
--    does. `tables.ts` still maps Project Manager *, Project Support * and
--    Client Contact (Linked) onto columns that no longer exist, so the next
--    run would fail on the first upsert. The map needs those three entries
--    removed and the join tables populated instead, which is a change to the
--    sync rather than to configuration — the first thing in phase one that is
--    not purely declarative.
--
-- 3. THE FULL DRY RUN COMES AFTER THAT, so it runs against the final shape.
--    The 25-record sample reported 88 unresolved links, nearly all of which
--    were an artefact of sampling — a contact pointing at company #300 when
--    only 25 companies were read. A full pass is the only way to tell those
--    from a link that is genuinely missing.
--
-- 4. STILL UNANSWERED, and now across four tables rather than one: a link
--    removed in Airtable has nowhere to be recorded. None of the join tables
--    has is_active, and the sync cannot delete. One decision covers all four.
-- ============================================================================
