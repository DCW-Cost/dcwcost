-- ============================================================================
-- 021 — activity_log task attachment becomes a join
--
-- Found by the dry run, before anything was loaded. activity_log holds 0 rows,
-- so there is no backfill, no dedupe question and no drop-last ordering trap.
-- 018 needed all three because out_of_office was already loaded.
--
-- ============================================================================
-- prefersSingleRecordLink IS A UI PREFERENCE, NOT A CONSTRAINT
--
-- This is the finding, and it is worth more than the column it fixes.
--
-- Airtable's link fields carry a flag, prefersSingleRecordLink. It changes how
-- the EDITOR behaves. IT DOES NOT STOP ANYBODY PUTTING SEVERAL IN, and the
-- field's type stays multipleRecordLinks either way.
--
--   Activity Log."DCW Project Task"   prefersSingleRecordLink: TRUE
--   records holding more than one:    32
--
-- Mapped as a scalar, those 32 keep the first task and drop the rest.
--
-- THE RULE WRITTEN INTO tables.ts EARLIER TODAY WAS HALF WRONG. It said: any
-- link whose config says prefersSingleRecordLink:false gets counted across the
-- full population before it becomes a scalar column. True as far as it went,
-- but it implied the converse — that TRUE meant settled. It does not. The flag
-- is evidence of nothing in either direction, and the only thing that settles
-- cardinality is counting the records.
--
-- The same claim had been written into three comments, in the form "single BY
-- SCHEMA ... cannot become multiple without a deliberate base change". Those
-- are corrected in the same commit.
--
-- ============================================================================
-- WHAT RESTS ON THE OLD ASSUMPTION, MEASURED 2026-10-07
--
--   activity_log.deliverable_id     flag true    32 multiples   <- this one
--   activity_log.action_owner_id    flag true     0 multiples
--   project_notes.project_id        flag true     0 multiples
--   project_notes.added_by_id       flag true     0 multiples
--
-- Only the first is losing data. The other three stay scalar — but they are
-- safe BY MEASUREMENT, WITH A DATE ON IT, not by anything Airtable enforces.
-- If any of them gains a second value the sync keeps the first and raises
-- coercion_failed, which is exactly how this one was found.
--
-- project_notes is already loaded and is unaffected: it ran with zero
-- anomalies on both links, so nothing was dropped.
-- ============================================================================

create table if not exists activity_log_deliverables (
  activity_log_id uuid not null references activity_log(id) on delete cascade,
  deliverable_id  uuid not null references deliverables(id) on delete cascade,
  synced_at       timestamptz not null default now(),
  primary key (activity_log_id, deliverable_id)
);

create index if not exists activity_log_deliverables_deliverable_idx
  on activity_log_deliverables (deliverable_id);

-- Grants copied from the join tables that work. NOTE THE SHAPE: insert and
-- select at table level, UPDATE AT COLUMN LEVEL on all three. The obvious
-- check — has_table_privilege(role, table, 'UPDATE') — reads FALSE on a
-- correctly configured join table, so asking the wrong question here reports a
-- problem that is not there. The column-level grant is what satisfies
-- buildJoinUpsert's "on conflict do update set synced_at = now()".
grant insert, select on activity_log_deliverables to airtable_sync;
grant update (activity_log_id, deliverable_id, synced_at)
  on activity_log_deliverables to airtable_sync;

alter table activity_log_deliverables enable row level security;

drop policy if exists activity_log_deliverables_read      on activity_log_deliverables;
drop policy if exists activity_log_deliverables_sync_ins  on activity_log_deliverables;
drop policy if exists activity_log_deliverables_sync_read on activity_log_deliverables;
drop policy if exists activity_log_deliverables_sync_upd  on activity_log_deliverables;

create policy activity_log_deliverables_read on activity_log_deliverables
  for select to authenticated using (true);
create policy activity_log_deliverables_sync_ins on activity_log_deliverables
  for insert to airtable_sync with check (true);
create policy activity_log_deliverables_sync_read on activity_log_deliverables
  for select to airtable_sync using (true);
create policy activity_log_deliverables_sync_upd on activity_log_deliverables
  for update to airtable_sync using (true) with check (true);

-- Dropped rather than left unmapped, for 016's reason: a column with no writer
-- is one somebody later fills from somewhere. Free — activity_log holds 0 rows
-- and nothing in src/ reads it.
alter table activity_log drop column if exists deliverable_id;

-- ============================================================================
-- VERIFICATION
--
-- Uncomment and run as a second query, after the above commits.
--
-- Expected values are stated only where they follow from the DDL. Row counts
-- are 0 and stay 0: this creates an empty table, and the numbers that matter
-- arrive with the first load. 018 predicted 851 links and production produced
-- 773, which was correct — an expected value is measured or marked unverified.
--
--   join table exists                  true
--   two FKs, both CASCADE              2
--   SYNC CAN INSERT                    true
--   SYNC CAN UPDATE synced_at          true
--   sync has NO table-level UPDATE     true
--   policies                           4
--   deliverable_id gone                true
--   logged_by_id kept                  uuid
--   action_owner_id kept               uuid
--   activity_log rows                  0
--
-- Run against production before committing, per the standing practice.
-- ============================================================================
--
-- select 'join table exists' as item,
--        (to_regclass('public.activity_log_deliverables') is not null)::text as value
-- union all select 'two FKs, both CASCADE',
--        (select count(*)::text from pg_constraint
--          where contype='f' and confdeltype='c'
--            and conrelid='activity_log_deliverables'::regclass)
-- union all select 'SYNC CAN INSERT',
--        has_table_privilege('airtable_sync','activity_log_deliverables','INSERT')::text
-- union all select 'SYNC CAN UPDATE synced_at',
--        has_column_privilege('airtable_sync','activity_log_deliverables','synced_at','UPDATE')::text
-- union all select 'sync has NO table-level UPDATE',
--        (not has_table_privilege('airtable_sync','activity_log_deliverables','UPDATE'))::text
-- union all select 'policies',
--        (select count(*)::text from pg_policies where tablename='activity_log_deliverables')
-- union all select 'deliverable_id gone',
--        (not exists (select 1 from information_schema.columns
--                      where table_schema='public' and table_name='activity_log'
--                        and column_name='deliverable_id'))::text
-- union all select 'logged_by_id kept',
--        coalesce((select data_type from information_schema.columns
--                   where table_schema='public' and table_name='activity_log'
--                     and column_name='logged_by_id'), 'MISSING')
-- union all select 'action_owner_id kept',
--        coalesce((select data_type from information_schema.columns
--                   where table_schema='public' and table_name='activity_log'
--                     and column_name='action_owner_id'), 'MISSING')
-- union all select 'activity_log rows', (select count(*)::text from activity_log);
--
-- ============================================================================
