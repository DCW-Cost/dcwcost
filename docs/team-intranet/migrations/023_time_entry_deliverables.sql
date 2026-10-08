-- ============================================================================
-- 023 — time entries attach to tasks through a join
--
-- The fourth join table of phase two, and the smallest cause: ten records of
-- 29,215. No backfill — time_entries holds 0 rows.
--
-- RUN THIS WITH 022, BEFORE LOADING time_entries. 022 makes a task's project
-- optional, which fixes 10,839 of the dry run's 10,849 problems. This fixes
-- the other ten.
--
-- ============================================================================
-- TEN RECORDS, AND THEY ARE NOT ALL THE SAME PROBLEM
--
-- "DCW Projects" on Time Tracking holds more than one task on ten records.
-- prefersSingleRecordLink is TRUE on that field, which is the second time
-- tonight that flag has been wrong — see the standing rule in tables.ts.
--
-- Reading the ten shows two different situations:
--
-- CASE A — THE SAME TASK, DUPLICATED IN AIRTABLE.
--
--   Brittany Gelleri, 2025-12-02, 0.5h, non-billable, "Revised fee (HDR)"
--     Tibbets Valley Park (TVP) Master Plan ... Task 1 - Preferred Option
--     Tibbets Valley Park (TVP) Master Plan ... Task 1 - Preferred Option
--     Tibbets Valley Park (TVP) Master Plan ... Task 1 - Preferred Option
--
--   Three records, identical names. Keeping the first loses nothing real,
--   because the other two are copies of it.
--
-- CASE B — GENUINELY DIFFERENT TASKS, AND THIS IS THE ONE THAT DECIDES IT.
--
--   Ryan Fouts, 2026-07-22, 6 hours, BILLABLE
--     Pattison Base: South Parcel Expansion - Hydrogen Interim Fueling
--       Station ... Task 1 - Permit Set
--     Pattison Base: South Parcel Expansion ... Task 1 - COP Review
--     Pattison South Parcel Expansion - ASI-18 Comp Clean 108B ... COP Review
--
--   Three distinct scopes. A scalar column attributes all six billable hours
--   to the Hydrogen Fueling Station and none to the other two, silently.
--   Six hours on the wrong scope is a reporting error, not a rounding one.
--
-- A single column cannot tell A from B — it keeps the first either way. The
-- join records both accurately, and makes the difference VISIBLE afterwards:
-- duplicates appear as several links to tasks with the same name, real splits
-- as links to different ones.
--
-- ============================================================================
-- A SEPARATE FINDING, FOR AIRTABLE RATHER THAN FOR THIS SCHEMA
--
-- Tibbets Valley Park has the same task three times and Friendly Hall twice.
-- Those are duplicate records in the base, and they inflate task counts
-- anywhere anyone counts them — not only here. Worth someone looking at
-- independently of this migration.
-- ============================================================================

create table if not exists time_entry_deliverables (
  time_entry_id  uuid not null references time_entries(id) on delete cascade,
  deliverable_id uuid not null references deliverables(id) on delete cascade,
  synced_at      timestamptz not null default now(),
  primary key (time_entry_id, deliverable_id)
);

create index if not exists time_entry_deliverables_deliverable_idx
  on time_entry_deliverables (deliverable_id);

-- Grants copied from the join tables that work. NOTE THE SHAPE: insert and
-- select at table level, UPDATE AT COLUMN LEVEL on all three. The obvious
-- check, has_table_privilege(role, table, 'UPDATE'), reads FALSE on a
-- correctly configured join table — so asking the wrong question here reports
-- a problem that is not there. The column-level grant is what satisfies
-- buildJoinUpsert's "on conflict do update set synced_at = now()".
grant insert, select on time_entry_deliverables to airtable_sync;
grant update (time_entry_id, deliverable_id, synced_at)
  on time_entry_deliverables to airtable_sync;

alter table time_entry_deliverables enable row level security;

drop policy if exists time_entry_deliverables_read      on time_entry_deliverables;
drop policy if exists time_entry_deliverables_sync_ins  on time_entry_deliverables;
drop policy if exists time_entry_deliverables_sync_read on time_entry_deliverables;
drop policy if exists time_entry_deliverables_sync_upd  on time_entry_deliverables;

create policy time_entry_deliverables_read on time_entry_deliverables
  for select to authenticated using (true);
create policy time_entry_deliverables_sync_ins on time_entry_deliverables
  for insert to airtable_sync with check (true);
create policy time_entry_deliverables_sync_read on time_entry_deliverables
  for select to airtable_sync using (true);
create policy time_entry_deliverables_sync_upd on time_entry_deliverables
  for update to airtable_sync using (true) with check (true);

-- Dropped rather than left unmapped, for 016's reason: a column with no
-- writer is one somebody later fills from somewhere. Free — time_entries
-- holds 0 rows and nothing in src/ reads it.
alter table time_entries drop column if exists deliverable_id;

-- ============================================================================
-- VERIFICATION
--
-- Uncomment and run as a second query, after the above commits. Expected
-- values are stated only where they follow from the DDL; row counts are 0 and
-- stay 0, because this creates an empty table.
--
--   join table exists                true
--   two FKs, both CASCADE            2
--   SYNC CAN INSERT                  true
--   SYNC CAN UPDATE synced_at        true
--   sync has NO table-level UPDATE   true
--   policies                         4
--   deliverable_id gone              true
--   person_id kept                   uuid
--   pursuit_id kept                  uuid
--   time_entries rows                0
--
-- person_id and pursuit_id STAY, and that is measured rather than assumed:
-- across all 29,215 records the dry run found 0 with multiple collaborators
-- and 0 with multiple pursuits. Safe by measurement, with a date on it.
--
-- Run against production before committing, per the standing practice.
-- ============================================================================
--
-- select 'join table exists' as item,
--        (to_regclass('public.time_entry_deliverables') is not null)::text as value
-- union all select 'two FKs, both CASCADE',
--        (select count(*)::text from pg_constraint
--          where contype='f' and confdeltype='c'
--            and conrelid='time_entry_deliverables'::regclass)
-- union all select 'SYNC CAN INSERT',
--        has_table_privilege('airtable_sync','time_entry_deliverables','INSERT')::text
-- union all select 'SYNC CAN UPDATE synced_at',
--        has_column_privilege('airtable_sync','time_entry_deliverables','synced_at','UPDATE')::text
-- union all select 'sync has NO table-level UPDATE',
--        (not has_table_privilege('airtable_sync','time_entry_deliverables','UPDATE'))::text
-- union all select 'policies',
--        (select count(*)::text from pg_policies where tablename='time_entry_deliverables')
-- union all select 'deliverable_id gone',
--        (not exists (select 1 from information_schema.columns
--                      where table_schema='public' and table_name='time_entries'
--                        and column_name='deliverable_id'))::text
-- union all select 'person_id kept',
--        coalesce((select data_type from information_schema.columns
--                   where table_schema='public' and table_name='time_entries'
--                     and column_name='person_id'), 'MISSING')
-- union all select 'pursuit_id kept',
--        coalesce((select data_type from information_schema.columns
--                   where table_schema='public' and table_name='time_entries'
--                     and column_name='pursuit_id'), 'MISSING')
-- union all select 'time_entries rows', (select count(*)::text from time_entries);
--
-- ============================================================================
