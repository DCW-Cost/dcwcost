-- ============================================================================
-- 018 — out_of_office attendance becomes a join table
--
-- RUN THIS AFTER the 843-row load, not before. The backfill reads
-- out_of_office.person_id, and dropping that column is the LAST thing this
-- migration does. Against an empty table it would create the join table,
-- backfill nothing, and drop the column — leaving a calendar with no people
-- in it and no error to say so.
--
-- ============================================================================
-- WHAT THE MEASUREMENT SAID
--
-- The dry run over all 843 rows raised 6 coercion_failed anomalies, every one
-- of them "Collaborators → person_id: N links, kept the first". A single uuid
-- column cannot hold a group event:
--
--   TD + BB + TA OOO - Cost Estimate Summit @ Sound Transit      3 people
--   TD, BB, & BG QTL Site Visit 12pm-2pm                          3
--   BB + TA Bremerton                                             2
--   AJ + TD Lunch & Learn with SHKS                               2
--   BB + TD On-site - WA Decarb. Meeting                          2
--   RF + TA CMAA Conference                                       2
--
-- Five of the six are category "In Person Client Meeting/Event", which is the
-- group-event category, so this is a shape rather than six accidents.
--
-- A SAMPLE OF 100 SAID ZERO. The population of 843 has six. The sample was
-- not wrong, it was a sample — and the four tables still to be mapped hold
-- 3,479, 3,569, 3,475 and 29,119 rows, where the same reasoning would be
-- wrong by proportionally more.
--
-- ============================================================================
-- WHY THIS IS NOT BOOKKEEPING
--
-- 0.7% of rows would be a reasonable thing to absorb if nobody read it. But
-- this feeds a calendar of who is out, which makes the loss VISIBLE AND
-- ACTIONABLE: "TD out on the 21st" when three people were away is the error
-- somebody acts on — checks availability, sees one name, schedules with
-- somebody who is not there. The title still reads "TD + BB + TA", so the
-- screen looks right while the query behind it is wrong.
--
-- Six records today. A calendar makes it permanent: every future group event
-- has the same problem, and nobody notices, because the title looks right.
--
-- ============================================================================
-- person_id IS DROPPED RATHER THAN KEPT AS "FIRST ATTENDEE"
--
-- Keeping it means two sources for one fact, and every calendar query has to
-- know which to trust. That is 017's reasoning exactly: a column holding part
-- of an answer is worse than one that does not exist, because the partial
-- answer is the one somebody uses.
-- ============================================================================

create table if not exists out_of_office_people (
  out_of_office_id uuid not null references out_of_office(id) on delete cascade,
  person_id        uuid not null references people(id)        on delete cascade,
  synced_at        timestamptz not null default now(),
  primary key (out_of_office_id, person_id)
);

create index if not exists out_of_office_people_person_idx
  on out_of_office_people (person_id);

-- Grants copied from deliverable_project_managers, which is the join table
-- that works. NOTE THE SHAPE: insert and select at table level, UPDATE AT
-- COLUMN LEVEL on all three. has_table_privilege(...,'UPDATE') is FALSE there
-- and the joins still write, because buildJoinUpsert's
-- "on conflict do update set synced_at = now()" is satisfied by the
-- column-level grant. Granting table-level UPDATE instead would work but
-- would differ from every other join table for no reason.
grant insert, select on out_of_office_people to airtable_sync;
grant update (out_of_office_id, person_id, synced_at) on out_of_office_people to airtable_sync;

alter table out_of_office_people enable row level security;

create policy out_of_office_people_read on out_of_office_people
  for select to authenticated using (true);
create policy out_of_office_people_sync_ins on out_of_office_people
  for insert to airtable_sync with check (true);
create policy out_of_office_people_sync_read on out_of_office_people
  for select to airtable_sync using (true);
create policy out_of_office_people_sync_upd on out_of_office_people
  for update to airtable_sync using (true) with check (true);

-- ============================================================================
-- BACKFILL, IN TWO PARTS — AND THE SECOND ALONE WOULD NOT BE ENOUGH
--
-- The instinct is to backfill "the six records that lost people". That would
-- produce a join table holding six rows and a calendar showing six people,
-- because dropping person_id removes the other 837 as well.
--
-- Part one carries every existing link: 837 single-person records plus the
-- first attendee of each of the 6 groups = 843.
-- Part two adds the 8 who were dropped (14 people across 6 records, less the
-- 6 firsts already carried by part one).
-- Expected total: 851.
-- ============================================================================

-- PART ONE — everything person_id currently holds.
insert into out_of_office_people (out_of_office_id, person_id)
select o.id, o.person_id
  from out_of_office o
 where o.person_id is not null
on conflict do nothing;

-- PART TWO — the dropped attendees, recovered from the anomaly rows.
--
-- NO AIRTABLE READ IS NEEDED. Every coercion_failed row stores the complete
-- link array in airtable_value, so the people the sync declined to write are
-- already recorded. That is the property that made loading before this
-- migration safe rather than lossy.
--
-- ON THE 200-CHARACTER TRUNCATION: plan.ts stores
-- JSON.stringify(raw).slice(0, 200). The longest array here is three record
-- ids at about 60 characters, so nothing is cut — but a record with more than
-- nine attendees WOULD be truncated and would fail to parse as jsonb. The
-- verification below counts the result rather than trusting that, and if a
-- future table hits this, the fix is to widen the slice, not to re-read.
--
-- THE DISTINCT IS NOT DECORATION, and the reason is a general property of
-- sync_anomalies worth knowing before anything else reads that table:
--
--   A DRY RUN WRITES ANOMALY ROWS THAT ARE INDISTINGUISHABLE FROM A REAL
--   RUN'S EXCEPT BY run_id.
--
-- These 6 records were seen by the dry run AND by the real load, so there are
-- 12 anomaly rows, not 6, and undeduped this statement would process 28 link
-- values rather than 14. The primary key means the RESULT is correct either
-- way — but the inserted count would read 28-ish and look wrong, and anybody
-- checking it would go looking for a bug that is not there.
--
-- The same applies to anything treating sync_anomalies as a work queue: a
-- review screen, a backfill, a count of outstanding issues. The two
-- double-company contacts are in there several times over for the same
-- reason. Filter by run_id, or dedupe, or count distinct — but do not assume
-- one row means one problem.
insert into out_of_office_people (out_of_office_id, person_id)
select distinct o.id, p.id
  from sync_anomalies a
  join out_of_office o on o.airtable_record_id = a.airtable_record_id
  cross join lateral jsonb_array_elements_text(a.airtable_value::jsonb) as link(rec)
  join people p on p.airtable_record_id = link.rec
 where a.table_name = 'out_of_office'
   and a.kind = 'coercion_failed'
   and a.field_name = 'Collaborators'
on conflict do nothing;

-- LAST. Everything above reads this column.
alter table out_of_office drop column if exists person_id;

-- ============================================================================
-- VERIFICATION
--
-- Uncomment and run as a second query. Every row should read exactly this:
--
--   out_of_office rows                843
--   attendance links                  851
--   people covered                    843
--   records with more than one        6
--   the three-person records          2
--   person_id gone                    true
--   SYNC CAN INSERT LINKS             true
--   SYNC CAN UPDATE synced_at         true
--   nobody orphaned                   0
--
-- "attendance links 851" is the row this migration exists to prove, and 843
-- would be the failure that looks like success: it means part two found
-- nothing and the group events are still showing one person each.
--
-- "SYNC CAN UPDATE synced_at" is not padding. The grant is COLUMN-level, so
-- the obvious check — has_table_privilege(...,'UPDATE') — reads FALSE on a
-- correctly configured table. Asking the wrong question here would send
-- somebody adding a grant that is already there.
--
-- If "out_of_office rows" reads 0, the load has not run. Stop; do not treat
-- the other zeros as passing.
--
-- Run against production before committing, per the standing practice.
-- ============================================================================
--
-- select 'out_of_office rows' as item, (select count(*)::text from out_of_office) as value
-- union all select 'attendance links', (select count(*)::text from out_of_office_people)
-- union all select 'people covered',
--        (select count(distinct out_of_office_id)::text from out_of_office_people)
-- union all select 'records with more than one',
--        (select count(*)::text from (select out_of_office_id from out_of_office_people
--                                      group by 1 having count(*) > 1) x)
-- union all select 'the three-person records',
--        (select count(*)::text from (select out_of_office_id from out_of_office_people
--                                      group by 1 having count(*) = 3) y)
-- union all select 'person_id gone',
--        (not exists (select 1 from information_schema.columns
--                      where table_schema='public' and table_name='out_of_office'
--                        and column_name='person_id'))::text
-- union all select 'SYNC CAN INSERT LINKS',
--        has_table_privilege('airtable_sync','out_of_office_people','INSERT')::text
-- union all select 'SYNC CAN UPDATE synced_at',
--        has_column_privilege('airtable_sync','out_of_office_people','synced_at','UPDATE')::text
-- union all select 'nobody orphaned',
--        (select count(*)::text from out_of_office_people l
--          where not exists (select 1 from people p where p.id = l.person_id));
--
-- ============================================================================
