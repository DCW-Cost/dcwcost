-- ============================================================================
-- Migration 007 — what the sync needs before it can be written
--
-- Run it in Supabase → SQL Editor → New query → paste → Run.
-- Expected result: "Success. No rows returned."
--
-- Requires 001 through 006.
--
-- NOT PURELY ADDITIVE. Four things that already exist change here:
--
--   1. `deliverables.task_number` becomes text[]. It was text, and that was
--      wrong — Airtable's Task Number is a multipleSelects that genuinely
--      holds more than one value. §1.
--   2. `projects.invoice_due_by` is renamed to `invoice_instructions`. It
--      never held a date. §3.
--   3. `set_deliverable_completed_at()` fires on transitions only, and no
--      longer on INSERT at all. §5.
--   4. `pursuits.date_created` is dropped. §2.
--
-- All four are safe to re-run. None of them can lose data: every table they
-- touch is empty apart from `deliverables`, which holds two portal uploads
-- with none of these columns set.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Why this exists
--
-- 006 built the shape of the Airtable mirror. This migration is everything the
-- sync needs that is not sync code: two type corrections, a rename, a trigger
-- that behaves correctly during a bulk load, somewhere for the sync to report
-- what it could not understand, a database role that cannot delete, and a
-- bucket for the files.
--
-- Writing the sync first would mean writing it against a schema with a known
-- type bug and no role able to enforce its central rule.
--
-- THE RULE THIS MIGRATION EXISTS TO ENFORCE
--
-- Never delete. A row that stops appearing in Airtable has almost always been
-- tidied or filtered, not deleted — DCW marks projects cancelled or on hold,
-- it does not remove them. 006 gave every mirrored table `is_active` and
-- `missing_from_airtable_since` to record that. Nothing enforced it.
--
-- The obvious way to run a sync is with the Supabase service key. That key
-- holds DELETE on every table and `rolbypassrls`, so the rule would be back to
-- being remembered rather than enforced — which is what we were trying to get
-- away from. §7 creates `airtable_sync` instead: a login role with SELECT,
-- INSERT and UPDATE on the mirror and DELETE on nothing at all.
--
-- READ THIS BEFORE TRUSTING THAT GUARANTEE: IT COVERS ROWS, NOT FILES.
--
-- Supabase storage is written through the storage API with a Supabase key, not
-- through a Postgres role — `src/lib/intranet/documents.ts` does
-- `storage.from(...).upload(...)`. A Postgres privilege cannot guard it. The
-- file phase of the sync will therefore hold a credential that CAN delete
-- objects in the bucket created in §9, and no grant in this migration
-- constrains it. The no-DELETE property is real and worth having; it stops the
-- sync destroying history in the tables. It does not extend to the 18 file
-- fields. Anyone reading §7 and concluding "the sync cannot delete anything"
-- would be wrong.
-- ----------------------------------------------------------------------------


-- ============================================================================
-- 1. task_number is a list
--
-- 006 typed this `text`, reasoning that a task has one number. That reasoned
-- from the field's name rather than its data. Airtable's "Task Number" is a
-- multipleSelects, and in a sample of 30 task records two carried two values —
-- ["Task 3a", "On-Call"] and ["On-Call", "Task 1"]. A scalar column would have
-- dropped the second silently on roughly one row in fifteen.
--
-- The field inventory had this right as text[] and 006 overrode it. Corrected
-- here, before anything loads.
-- ============================================================================

-- GUARDED ON THE COLUMN'S CURRENT TYPE, NOT ON ITS CONTENTS, and the
-- difference is the whole point.
--
-- The obvious way to write this — a bare ALTER with
-- `using case when task_number is null then null else array[task_number] end`
-- — is idempotent-looking and silently wrong. On a second run the column is
-- already text[], and `array[task_number]` wraps what is there rather than
-- converting it, producing a two-dimensional array:
--
--     before   {"Task 3a",On-Call}
--     after    {{"Task 3a",On-Call}}     array_ndims = 2
--
-- No error. Harmless while the column is empty, and silent corruption of
-- every task number once the sync has loaded 5,551 of them — which is exactly
-- the class of failure this migration exists to prevent, arriving inside the
-- migration itself.
--
-- A null check would not have caught it either: the rows that break are the
-- populated ones.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'deliverables'
       and column_name  = 'task_number'
       and data_type   <> 'ARRAY')
  then
    alter table deliverables
      alter column task_number type text[]
      using case when task_number is null then null else array[task_number] end;
  end if;
end $$;

comment on column deliverables.task_number is
  'Airtable Task Number, a multipleSelects. Genuinely multi-valued — a task can be both "Task 3a" and "On-Call".';


-- ============================================================================
-- 2. pursuits.date_created
--
-- 006 carried both `airtable_created_at` ("Created") and `date_created`
-- ("Date Created") because Airtable has two fields that looked like the same
-- fact and the migration could not see the base to check. It can now: both are
-- `createdTime` fields. The same fact, computed twice.
-- ============================================================================

alter table pursuits drop column if exists date_created;


-- ============================================================================
-- 3. invoice_due_by was never a date
--
-- 006 kept this as text on the suspicion that it held terms like "Net 30"
-- rather than dates, and left narrowing it to the sync. Checked against the
-- base: 6 of 1,877 projects have a value, and they read
--
--   "15th of each month (send timesheets to Rachel by 10th of each month)"
--   "When project is considered complete"
--
-- Those are billing instructions for a specific project, not dates and not
-- company-level policy — so they do not belong in
-- `client_companies.company_billing_instructions` either. Renamed so that
-- nobody later assumes the column holds a date and tries to cast it. Nothing
-- reads this column and no data is loaded, so this is the cheapest this rename
-- will ever be.
-- ============================================================================

-- ALTER TABLE ... RENAME COLUMN has no IF EXISTS, so an unguarded rename
-- aborts the whole migration on a second run — and because this sits at §3,
-- everything after it (sync_runs, the sweep, both estimator columns) would
-- silently not apply. The error names only the rename; the eight sections it
-- took down with it are invisible.
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'projects'
                and column_name = 'invoice_due_by')
     and not exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'projects'
                and column_name = 'invoice_instructions')
  then
    alter table projects rename column invoice_due_by to invoice_instructions;
  end if;
end $$;

comment on column projects.invoice_instructions is
  'Free text, project-specific billing instructions. Airtable calls this "Invoice Due By"; it has never held a date. 6 of 1,877 projects have one.';


-- ============================================================================
-- 4. due_date holds the delivery date, and the name will mislead somebody
--
-- Airtable's "Due Date" is not a target that goes stale. It is maintained as
-- the report moves and ends up holding the date the work was actually
-- delivered. That is why `completed_at` is backfilled from it.
--
-- The evidence, rather than the assertion: of the 2,827 tasks that carry a Due
-- Date, 2,663 are complete — 94%. A field populated almost exclusively on
-- finished work is behaving like a delivery record.
--
-- The name is kept anyway. 164 tasks have a due date and are NOT complete, and
-- for those it genuinely is a target, so any name saying "delivered" would be
-- wrong for them. The ambiguity is in the business, not just the label, and
-- `completed_at` is where the unambiguous meaning now lives.
-- ============================================================================

comment on column deliverables.due_date is
  'Airtable "Due Date". NOT a stale target: it is maintained as the work moves and ends up holding the actual delivery date — 94% of tasks carrying one are complete. completed_at is derived from it. For the 164 tasks that are not yet complete it still reads as a target.';


-- ============================================================================
-- 5. completed_at fires on a transition, never on an insert
--
-- 006 set `completed_at := now()` on insert or update of phase_ii_workflow.
-- That is wrong for a bulk load: 3,023 of 5,551 tasks are already complete in
-- Airtable, so the first sync would stamp every one of them with the import
-- date. Nothing would error. The column would simply be full of a number that
-- looks like history and is not, which is worse than being empty.
--
-- Two ways to avoid it. A session switch the sync sets during the initial load
-- works, but a switch the sync forgets to set produces exactly the failure it
-- exists to prevent, and nothing would say so.
--
-- So the trigger fires on UPDATE only. A row that arrives already complete
-- changes nothing and stamps nothing; a row that LATER moves into complete
-- does. There is no switch to forget, and the intent is in the trigger's
-- declaration rather than in a setting somebody has to know about.
--
-- WHAT THAT MEANS FOR THE SYNC, AND WHY IT IS AN IMPROVEMENT
--
-- Because nothing fires on insert, the sync sets `completed_at` itself in the
-- INSERT, from `due_date`, for any task whose Phase II is already complete.
-- That is one rule covering both the initial load of 2,663 backfillable tasks
-- AND a task created in Airtable after go-live that is already finished. There
-- is no separate backfill pass and no special case.
--
-- The 360 tasks that are complete with no due date get null. That is honest:
-- we do not know when they finished.
--
-- The comparison below is between the two BOOLEANS rather than the two text
-- values on purpose. Quality Control → Draft Delivered changes the text but
-- neither value is complete, and that must not be read as a transition.
-- ============================================================================

create or replace function set_deliverable_completed_at() returns trigger
  language plpgsql as $fn$
declare
  -- Confirmed against the base on 2026-09-29: Phase II is a single select on
  -- DCW Project Tasks whose only terminal choice is exactly "Complete".
  -- If that choice is renamed in Airtable, change it here and nowhere else.
  completed_value constant text := 'complete';
  was_complete    boolean;
  is_complete     boolean;
begin
  is_complete  := lower(trim(coalesce(new.phase_ii_workflow, ''))) = completed_value;
  was_complete := lower(trim(coalesce(old.phase_ii_workflow, ''))) = completed_value;

  -- Not a transition into or out of complete. Leave completed_at alone —
  -- including on the sync's ordinary re-writes of an unchanged value.
  if is_complete = was_complete then
    return new;
  end if;

  if is_complete then
    new.completed_at := now();
  else
    -- Reopened. A task that needs a revision is not complete, and a stale
    -- completed_at would quietly poison anything counting throughput.
    new.completed_at := null;
  end if;

  return new;
end;
$fn$;

comment on function set_deliverable_completed_at() is
  'Maintains deliverables.completed_at from phase_ii_workflow, on UPDATE only. Inserts are the sync''s responsibility — see migration 007 section 5.';

-- Dropped and recreated rather than altered: the INSERT in 006's declaration
-- is the thing being removed, and it is not visible in the function body.
drop trigger if exists trg_deliverables_completed_at on deliverables;
create trigger trg_deliverables_completed_at
  before update of phase_ii_workflow on deliverables
  for each row execute function set_deliverable_completed_at();


-- ============================================================================
-- 6. sync_anomalies — what the sync saw and could not reconcile
--
-- Several mirrored columns key off free-text Airtable choices that anyone can
-- rename from the Airtable UI without knowing something downstream depends on
-- it. Phase II's "Complete" is the load-bearing one: rename it and
-- `completed_at` silently stops being set. Nothing errors, a column just stops
-- filling.
--
-- The same shape of problem covers a parent link that did not resolve, a row
-- that stopped appearing, a value that would not coerce, and a disagreement
-- between Airtable and a document. All of them are "the sync saw something it
-- did not expect", and none should need somebody to read a log to discover.
--
-- ON VOLUME, WHICH DECIDES WHETHER ANYONE READS THIS TABLE
--
-- Record disagreements, not agreements. The Activity Log holds 47 free-text
-- "Project complete!!" events; most will agree with the due date they are
-- being checked against, and 46 rows saying "these agree" would teach people
-- to ignore the table within a week. Log where they differ by more than a day.
--
-- WHY NOT reader_questions
--
-- `reader_questions.deliverable_id` is NOT NULL, so a project-level
-- disagreement — client, sector, location — has nowhere to go there, and
-- loosening that constraint to make room would weaken a table that is
-- correctly strict. Deliverable-level disagreements about what a document was
-- priced against still belong in reader_questions, with the kind that fits:
-- `gross_area`, `pricing_base_date`, `deliverable_type`. This table is for
-- everything else.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'sync_anomaly_kind') then
    create type sync_anomaly_kind as enum (
      'unknown_choice',      -- a single-select value the sync does not recognise
      'unresolved_link',     -- a linked record id with no row in the mirror
      'vanished',            -- present in a previous run, absent from this one
      'coercion_failed',     -- a value that would not fit the column's type
      'value_disagreement'   -- two sources disagree; both kept, neither wins
    );
  end if;
end $$;

create table if not exists sync_anomalies (
  id            bigint generated always as identity primary key,

  -- One id per sync run, so a run can be reviewed as a unit and the dry run
  -- can report its own findings.
  run_id        uuid not null,

  table_name          text not null,
  airtable_record_id  text,
  kind          sync_anomaly_kind not null,

  -- What was being read when this happened, and the two values that did not
  -- agree. Both text: the point is to preserve what was seen, not to type it.
  field_name      text,
  airtable_value  text,
  postgres_value  text,
  detail          text,

  seen_at       timestamptz not null default now(),
  resolved_at   timestamptz,
  resolved_by   uuid references profiles(id),
  resolution    text
);

create index if not exists sync_anomalies_run_idx  on sync_anomalies (run_id);
create index if not exists sync_anomalies_open_idx on sync_anomalies (kind, seen_at)
  where resolved_at is null;
create index if not exists sync_anomalies_record_idx
  on sync_anomalies (table_name, airtable_record_id);

comment on table sync_anomalies is
  'What a sync run could not understand or reconcile. Disagreements only, never agreements — a table full of "these matched" is a table nobody reads. See migration 007 section 6.';

-- An identity column does not need a separate sequence grant, unlike the
-- bigserial in 004 which needed `grant usage on sequence`. One less privilege
-- to remember.

-- The choices worth guarding by name, because something downstream reads them:
--   Phase II: On the Table (Workflow)   drives completed_at
--   Task Status
--   Phase I: Upcoming
--   Phase III: Billing
--   Billable Status                     (Time Tracking)
--   Collections Status
-- An unrecognised value in any of these is an `unknown_choice` row, and the
-- sync should still load the record — carrying an unexpected value through is
-- better than refusing the row.


-- ============================================================================
-- 7. The airtable_sync role
--
-- Follows 004's cost_reader exactly, for the same reason: the component that
-- touches every record in the business should not hold a credential that
-- ignores every policy in the database.
--
-- Deliberately NOT: SUPERUSER, CREATEDB, CREATEROLE, BYPASSRLS. In particular
-- no BYPASSRLS — §8's policies are the enforcement, and a role that ignored
-- them would defeat the point.
--
-- Deliberately NOT: DELETE. On anything. This is the whole reason the role
-- exists rather than the sync using the service key. A row vanishing from
-- Airtable is almost always an error, so the sync marks it inactive and
-- records when. A careless version that tries to delete instead fails loudly
-- with a permission error rather than quietly removing history.
--
-- No password is set here. A password in a migration is a password in git.
--
-- AND AGAIN, BECAUSE IT IS EASY TO READ TOO MUCH INTO THIS: the guarantee is
-- rows, not files. The bucket in §9 is written through the storage API with a
-- Supabase key, which no grant below constrains.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'airtable_sync') then
    create role airtable_sync with login nosuperuser nocreatedb nocreaterole
                                   noinherit nobypassrls;
  end if;
end $$;

comment on role airtable_sync is
  'The Airtable → Postgres mirror. SELECT, INSERT and UPDATE on the mirror tables; DELETE on nothing. See migration 007.';

-- A sync is a long sequence of small writes, not a single transaction, and it
-- should not be able to sit on a connection or a lock indefinitely.
alter role airtable_sync connection limit 5;
alter role airtable_sync set statement_timeout = '120s';
alter role airtable_sync set idle_in_transaction_session_timeout = '60s';

grant usage on schema public to airtable_sync;

-- ----------------------------------------------------------------------------
-- The 14 tables 006 created are the sync's own. It owns every column, so these
-- are table-level.
-- ----------------------------------------------------------------------------

grant select, insert, update on
  people, client_companies, subconsultants, contacts, pursuits,
  project_notes, time_entries, activity_log, bid_results, out_of_office,
  subconsultant_tasks, subconsultant_invoices,
  deliverable_subconsultants, deliverable_assignees
to airtable_sync;

-- Reporting what it could not understand. No UPDATE: resolving an anomaly is
-- a person's decision, not the pipeline's, which is the same line 004 drew
-- around reviewed_by on line_items.
grant select, insert on sync_anomalies to airtable_sync;

-- ----------------------------------------------------------------------------
-- `projects` and `deliverables` are shared, so these are column-level.
--
-- INSERT stays table-level on both. A row that does not exist yet has no
-- reader work on it to destroy, and the sync legitimately sets `source`,
-- and `completed_at` (§5), when it creates one. The protection that matters
-- is on UPDATE, which is where existing work can be overwritten.
--
-- THAT REASONING HOLDS ONLY IF THE SYNC NEVER INSERTS OVER AN EXISTING ROW,
-- WHICH IS NOT AS AUTOMATIC AS IT SOUNDS:
--
--   The sync touches only rows where `source = 'airtable'`, and never
--   matches on a null `airtable_record_id`.
--
-- The unique constraint on `airtable_record_id` catches the obvious duplicate.
-- The subtle case it does not catch: `airtable_record_id` is NULLABLE — 001
-- made it so for portal uploads, and `deliverables` holds two such rows today
-- with a null key. In Postgres nulls never conflict, so an upsert keyed on
-- that column will happily INSERT rather than match, and a sync that
-- generalised "upsert on airtable_record_id" would mint a duplicate for every
-- uploaded document on every run. Match on the key only when it is non-null,
-- and filter to source = 'airtable' besides.
-- ----------------------------------------------------------------------------

grant select, insert on projects, deliverables to airtable_sync;

-- Withheld from UPDATE on projects: `airtable_record_id` (the key — set once,
-- at insert), `stories`, `created_by` and `created_at` (the portal's).
--
-- `gross_sf` IS included, because the sync fills it where Airtable has a
-- building area. Airtable has one for about 18% of projects, so the reader's
-- frame is the primary source here, not the fallback.
--
-- THE RULE THE SYNC MUST FOLLOW, WHICH NO GRANT CAN EXPRESS:
--
--   write gross_sf only when it is currently null, or when Airtable's value
--   equals what is already there. If Airtable has a value and Postgres has a
--   different one, LEAVE POSTGRES ALONE and raise a `gross_area` question in
--   reader_questions.
--
-- A sync that wrote this unconditionally would undo the reader's work on
-- every run — silently, and the reader would not redo it, because the
-- document is already accepted. The column would quietly revert to Airtable's
-- sparse figures on a schedule.
grant update (
  name, client_name, sector, market, region, city, gross_sf,
  delivery_method, construction_start, project_status,
  client_id, client_contact_id,
  contract_amount, estimated_cost_building, estimated_cost_site,
  fee_proposal, invoice_instructions,
  nda, need_to_fix_for_the_resume_builder, time_card_required,
  project_description, project_descriptions_for_resume,
  project_owner, scope_categories, project_image_paths,
  airtable_created_at, synced_at
) on projects to airtable_sync;

-- `is_active` and `missing_from_airtable_since` are NOT in that list. They are
-- written only by sweep_missing_from_airtable() in §10, which refuses to run
-- against a pass that did not finish. See the note there about how far this
-- enforcement reaches.

-- Withheld from UPDATE on deliverables, and this is the list that matters:
--
--   the reader's    type, phase, status, stated_total_cost, file_checksum,
--                   ingested_at, source, storage_path, original_filename,
--                   byte_size, box_file_url, source_format, issue_date,
--                   estimator, version, is_latest_version, currency,
--                   upload_notes, uploaded_by, uploaded_at
--   nobody's        ready_for_cost_library and completed_at have no Airtable
--                   source. completed_at is set at INSERT and then by the
--                   trigger; the sync must never write it again.
--   the key         airtable_record_id
--
-- A full-row upsert would wipe the reader's frame on every run, silently, and
-- the reader would not redo it because the document is already accepted. With
-- this grant that upsert fails with a permission error on the first attempt.
grant update (
  project_id,
  task_name, project_task_title, task_number, task_status, task_type,
  phase_i_upcoming, phase_ii_workflow, phase_iii_billing,
  start_date, due_date,
  initial_draft_delivery, final_draft_delivery, revision_delivery,
  review_again_on, schedule, schedule_notes,
  project_manager_id, project_support_id, next_action_owner_id,
  next_action, next_action_due_date,
  blocker_risk_notes, check_in_for_cost_planners, meeting_update_notes,
  support_needed, support_request_notes,
  tech_team_decision, tech_team_meeting_notes,
  waiting_on, workload_heat, special_note,
  client_correspondence, correspondence_note_link, has_note_been_transfered,
  billed_before_complete, collections_status, hourly_rate,
  invoice, invoice_date, next_collection_action_needed_on,
  send_timesheets_by, time_card_complete, task_hours,
  fee_proposal, fee_proposal_link,
  budget, building_sf, sitework_sf,
  construction_start, construction_completion, delivery_method,
  new_reno_demo_etc, project_size, report_format, work_breakdown,
  dcw_estimated_project_cost, project_folder_link,
  airtable_created_at, airtable_last_modified_at, synced_at
) on deliverables to airtable_sync;

-- Same omission as on projects, and for the same reason: `is_active` and
-- `missing_from_airtable_since` belong to §10's sweep, not to the upsert.

-- Deliberately no grant at all on: profiles, bootstrap_admins, the wishlist,
-- estimates, audit_log, document_frames, line_items, reader_questions,
-- estimator_notes, ingest_runs, taxonomy, units, cost_indices,
-- confidence_rules, reader_conventions. The sync has no business in any of
-- them. Supabase's default privileges cover anon, authenticated, service_role
-- and postgres only, so a new role picks up nothing by default — §VERIFICATION
-- proves that rather than trusting it.


-- ============================================================================
-- 8. Policies for airtable_sync
--
-- A grant says the role may attempt the operation; a policy says which rows.
-- Both are needed, and without this section the role would hold every grant in
-- §7 and still write nothing.
--
-- This is 004's lesson arriving from the other direction, and it is worse here
-- than it looks. On the 14 tables 006 created, the read policies are
-- `to authenticated`, so a new role simply has none and RLS denies it.
--
-- On `projects` and `deliverables` the policies from 001 and 003 have no TO
-- clause, so they DO apply to airtable_sync — and they call `is_admin()` and
-- `auth.uid()`, which return null on a direct Postgres connection. They
-- evaluate false. The role would be blocked by a policy written for signed-in
-- people, and a policy denial is not an error: the write reports success and
-- changes zero rows. A sync could run to completion, report nothing wrong, and
-- have written nothing at all.
--
-- `to airtable_sync` on every policy below matters for the same reason it
-- mattered in 004: a policy without a TO clause applies to every role, and
-- these say `using (true)`.
-- ============================================================================

alter table sync_anomalies enable row level security;

do $$
declare
  t text;
  mirror text[] := array[
    'people','client_companies','subconsultants','contacts','pursuits',
    'project_notes','time_entries','activity_log','bid_results','out_of_office',
    'subconsultant_tasks','subconsultant_invoices',
    'deliverable_subconsultants','deliverable_assignees',
    'projects','deliverables'];
begin
  foreach t in array mirror loop
    execute format('drop policy if exists %I on %I', t || '_sync_read',   t);
    execute format('drop policy if exists %I on %I', t || '_sync_insert', t);
    execute format('drop policy if exists %I on %I', t || '_sync_update', t);

    execute format(
      'create policy %I on %I for select to airtable_sync using (true)',
      t || '_sync_read', t);
    execute format(
      'create policy %I on %I for insert to airtable_sync with check (true)',
      t || '_sync_insert', t);
    execute format(
      'create policy %I on %I for update to airtable_sync using (true) with check (true)',
      t || '_sync_update', t);
  end loop;
end $$;

-- No DELETE policy for airtable_sync anywhere, to match the absent grant.
-- Either alone would stop it; both together mean a careless sync fails at the
-- privilege check rather than silently writing zero rows.

-- sync_anomalies: the sync files them, people read and resolve them.
drop policy if exists sync_anomalies_sync_insert on sync_anomalies;
drop policy if exists sync_anomalies_sync_read   on sync_anomalies;
drop policy if exists sync_anomalies_read        on sync_anomalies;
drop policy if exists sync_anomalies_resolve     on sync_anomalies;

create policy sync_anomalies_sync_insert on sync_anomalies
  for insert to airtable_sync with check (true);
create policy sync_anomalies_sync_read on sync_anomalies
  for select to airtable_sync using (true);
create policy sync_anomalies_read on sync_anomalies
  for select to authenticated using (is_active_user());
create policy sync_anomalies_resolve on sync_anomalies
  for update to authenticated using (is_admin()) with check (is_admin());

revoke all on sync_anomalies from anon;
grant select on sync_anomalies to authenticated;
grant update (resolved_at, resolved_by, resolution) on sync_anomalies to authenticated;


-- ============================================================================
-- 9. The bucket
--
-- One bucket, not twelve. 18 file fields across 12 mirrored tables, and every
-- one of them wants the same policy: an active user reads, the sync writes. A
-- bucket is a policy boundary, so twelve buckets would be twelve policy sets
-- to keep in step, and the first one to drift would do so silently.
--
-- Paths are <table>/<airtable_record_id>/<filename>, which keeps a record's
-- files together and makes an orphan obvious.
--
-- Private. These are client logos, W9s, subconsultant invoices, headshots and
-- note snips; none of it should be reachable without signing in.
--
-- Airtable attachment URLs expire after roughly two hours, so files must be
-- fetched during the same run that read the record. That argues for the file
-- phase being separate and resumable — keyed on the path array still being
-- null — so a failure does not force re-reading the base.
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('airtable-mirror', 'airtable-mirror', false)
on conflict (id) do nothing;

-- Read for signed-in, active people. Writes come through the storage API as
-- the service role, which bypasses RLS and therefore needs no policy — and
-- which is exactly why §7's no-DELETE guarantee does not reach these objects.
drop policy if exists airtable_mirror_read on storage.objects;
create policy airtable_mirror_read on storage.objects
  for select to authenticated
  using (bucket_id = 'airtable-mirror' and is_active_user());


-- ============================================================================
-- 10. sync_runs, and the sweep that cannot run without one
--
-- The never-delete rule works by marking a vanished row inactive instead of
-- removing it. Deciding a row has vanished means knowing the full set the run
-- saw — and that is only true of a run that FINISHED. A pass that died halfway
-- and then swept would mark everything it had not reached as missing, which is
-- the same disaster as deleting, arriving by a different door.
--
-- So there has to be something that records a run completing, and the sweep
-- has to be unable to proceed without it. Not "the sync checks" — a sync that
-- remembers to check is a sync that can forget.
--
-- SHAPED TO MATCH ingest_runs, WHICH ALREADY ANSWERS THE SAME QUESTION
--
-- `ingest_runs` (004) carries id, started_at, finished_at, triggered_by,
-- scope, counts and notes. The spine here is deliberately identical, so
-- "what ran in the last day, and did it finish" is the same query shape
-- against either.
--
-- One difference, and it is the reason this table exists: `ingest_runs` has no
-- outcome column — it infers success from docs_failed. That is fine for a
-- report and not fine for a guard, because `finished_at is not null` cannot
-- distinguish "finished having worked" from "finished having failed". So
-- sync_runs records the outcome explicitly.
--
-- NOT DONE HERE, deliberately: adding a matching `outcome` to `ingest_runs`.
-- It would be a column nothing writes until the reader is changed to write it,
-- and a column that is always null is worse than an absent one. Worth doing
-- the next time the reader is touched.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'sync_run_outcome') then
    create type sync_run_outcome as enum ('running', 'succeeded', 'failed', 'cancelled');
  end if;
end $$;

create table if not exists sync_runs (
  id            uuid primary key default gen_random_uuid(),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  outcome       sync_run_outcome not null default 'running',

  -- 'full', or a single table name when only part of the base was read. The
  -- sweep is only ever valid after a 'full' pass: a partial one did not look
  -- at the tables it would be marking.
  scope         text not null default 'full',
  dry_run       boolean not null default false,
  triggered_by  uuid references profiles(id),
  notes         text
);

create index if not exists sync_runs_started_idx on sync_runs (started_at desc);
create index if not exists sync_runs_open_idx    on sync_runs (outcome)
  where finished_at is null;

comment on table sync_runs is
  'One row per sync run. The outcome column exists because finished_at alone cannot tell a run that worked from one that failed, and the sweep in sweep_missing_from_airtable() depends on the difference.';

-- Counts per table, one row each, rather than a jsonb blob on the run. The dry
-- run's whole job is to report these, and "40 inserts, 2 of which already
-- exist" is only answerable if the shape can hold both numbers.
create table if not exists sync_run_tables (
  run_id        uuid not null references sync_runs(id) on delete cascade,
  table_name    text not null,

  read_from_airtable  integer not null default 0,
  inserted            integer not null default 0,
  updated             integer not null default 0,
  unchanged           integer not null default 0,

  -- The duplicate check. `would_insert_existing` is the one that matters in a
  -- dry run: a row the sync is about to INSERT that already has a match. It
  -- should always be zero. Anything else means the key resolution is wrong —
  -- most likely a null airtable_record_id, where nulls never conflict and the
  -- unique constraint will not save you.
  would_insert_existing integer not null default 0,
  unresolved_parents    integer not null default 0,
  anomalies             integer not null default 0,

  primary key (run_id, table_name)
);

comment on column sync_run_tables.would_insert_existing is
  'Rows the sync would INSERT that already have a match. Always expected to be zero; a non-zero value means key resolution is wrong. See migration 007 section 7 on the nullable airtable_record_id.';

-- ----------------------------------------------------------------------------
-- The sweep
--
-- Marks anything the given run did not see as inactive, and un-marks anything
-- that has reappeared. It refuses outright unless the run finished, succeeded,
-- was a full pass and was not a dry run.
--
-- SECURITY DEFINER so that it, and not the sync, holds the privilege to write
-- `is_active` and `missing_from_airtable_since`. §7 withholds those columns
-- from airtable_sync on projects and deliverables, so on those two tables the
-- guard is real: the sync CANNOT mark a row inactive except by calling this,
-- and this refuses without a finished run.
--
-- HOW FAR THAT REACHES, STATED PLAINLY SO NOBODY OVERREADS IT:
--
-- On the 14 tables 006 created, §7 grants table-level UPDATE, so airtable_sync
-- retains the raw privilege to write `is_active` on them by hand. The guard is
-- the sanctioned path there, not a wall. Closing that gap means converting
-- those 14 grants to column-level — roughly 196 column names, entirely
-- mechanical, and the same pattern already used on deliverables. Worth doing
-- if the sweep ever moves out of one reviewed codebase; not done here because
-- it is a large amount of migration for a gap that only a deliberate act
-- reaches through.
-- ----------------------------------------------------------------------------

create or replace function sweep_missing_from_airtable(p_run_id uuid)
  returns table (table_name text, marked_missing integer, marked_returned integer)
  language plpgsql
  security definer
  set search_path = public
as $sweep$
declare
  r        sync_runs%rowtype;
  t        text;
  n_gone   integer;
  n_back   integer;
  targets  text[] := array[
    'people','client_companies','subconsultants','contacts','pursuits',
    'project_notes','time_entries','activity_log','bid_results','out_of_office',
    'subconsultant_tasks','subconsultant_invoices','projects','deliverables'];
begin
  select * into r from sync_runs where id = p_run_id;

  if not found then
    raise exception 'sweep refused: no sync_run %', p_run_id;
  end if;
  if r.finished_at is null then
    raise exception 'sweep refused: run % has not finished', p_run_id;
  end if;
  if r.outcome <> 'succeeded' then
    raise exception 'sweep refused: run % ended %, not succeeded', p_run_id, r.outcome;
  end if;
  if r.scope <> 'full' then
    raise exception 'sweep refused: run % read only %, so it cannot say what is missing',
                    p_run_id, r.scope;
  end if;
  if r.dry_run then
    raise exception 'sweep refused: run % was a dry run', p_run_id;
  end if;

  foreach t in array targets loop
    -- Not seen in this pass: mark it, and date it the first time only, so the
    -- record of when it went missing survives later runs.
    execute format($f$
      update %I set is_active = false,
                    missing_from_airtable_since = coalesce(missing_from_airtable_since, now())
       where synced_at < $1 and is_active
         %s $f$, t, case when t in ('projects','deliverables')
                         then 'and airtable_record_id is not null' else '' end)
      using r.started_at;
    get diagnostics n_gone = row_count;

    -- Came back. Airtable is the system of record; a reappearance is the
    -- answer, and the gap is closed rather than remembered.
    execute format($f$
      update %I set is_active = true, missing_from_airtable_since = null
       where synced_at >= $1 and not is_active $f$, t)
      using r.started_at;
    get diagnostics n_back = row_count;

    table_name := t; marked_missing := n_gone; marked_returned := n_back;
    return next;
  end loop;
end;
$sweep$;

comment on function sweep_missing_from_airtable(uuid) is
  'Marks rows a finished sync run did not see as inactive, and revives any that reappeared. Refuses unless the run finished, succeeded, was a full pass and was not a dry run. SECURITY DEFINER so the privilege to write is_active lives here rather than with the sync. See migration 007 section 10.';

-- Only the sync calls it, and only postgres owns it.
revoke all on function sweep_missing_from_airtable(uuid) from public;
grant execute on function sweep_missing_from_airtable(uuid) to airtable_sync;

-- Opening and closing a run, and reporting counts. No DELETE, as everywhere.
grant select, insert, update on sync_runs, sync_run_tables to airtable_sync;

alter table sync_runs       enable row level security;
alter table sync_run_tables enable row level security;

drop policy if exists sync_runs_sync_read         on sync_runs;
drop policy if exists sync_runs_sync_insert       on sync_runs;
drop policy if exists sync_runs_sync_update       on sync_runs;
drop policy if exists sync_runs_read              on sync_runs;
drop policy if exists sync_run_tables_sync_read   on sync_run_tables;
drop policy if exists sync_run_tables_sync_insert on sync_run_tables;
drop policy if exists sync_run_tables_sync_update on sync_run_tables;
drop policy if exists sync_run_tables_read        on sync_run_tables;

create policy sync_runs_sync_read   on sync_runs for select to airtable_sync using (true);
create policy sync_runs_sync_insert on sync_runs for insert to airtable_sync with check (true);
create policy sync_runs_sync_update on sync_runs for update to airtable_sync using (true) with check (true);
create policy sync_runs_read        on sync_runs for select to authenticated using (is_active_user());

create policy sync_run_tables_sync_read   on sync_run_tables for select to airtable_sync using (true);
create policy sync_run_tables_sync_insert on sync_run_tables for insert to airtable_sync with check (true);
create policy sync_run_tables_sync_update on sync_run_tables for update to airtable_sync using (true) with check (true);
create policy sync_run_tables_read        on sync_run_tables for select to authenticated using (is_active_user());

revoke all on sync_runs, sync_run_tables from anon;
grant select on sync_runs, sync_run_tables to authenticated;

-- sync_anomalies.run_id now points at something real.
alter table sync_anomalies
  drop constraint if exists sync_anomalies_run_id_fkey;
alter table sync_anomalies
  add constraint sync_anomalies_run_id_fkey
  foreign key (run_id) references sync_runs(id) on delete cascade;


-- ============================================================================
-- 11. Two things the estimators asked for
--
-- Both are read from the document, so both are the reader's to populate, and
-- both are here rather than in a later migration because retrofitting either
-- means re-reading every document already ingested. A migration in flight is
-- the cheap moment.
-- ============================================================================

-- An allowance is a placeholder price carried where the drawings do not yet
-- show enough to measure. In the data today it is indistinguishable from a
-- measured line, which means it pools with real rates and quietly drags an
-- average that somebody will later price work against.
--
-- Detected from the LABEL, not inferred from a missing quantity. Plenty of
-- legitimate lines have no quantity, and plenty of allowances carry one.
-- Guessing from shape would be wrong in both directions.
--
-- Nullable on purpose: false means the reader determined it is not an
-- allowance, null means nothing has looked. Those are different, and the
-- difference matters for the 0 documents ingested before this column existed.
alter table line_items
  add column if not exists is_allowance boolean;

comment on column line_items.is_allowance is
  'True when the line is an allowance — a placeholder where the drawings do not yet support a measurement. Read from the label, never inferred from a missing quantity. Null means no reader has looked.';

create index if not exists line_items_allowance_idx
  on line_items (is_allowance) where is_allowance;

-- line_items UPDATE is column-level for cost_reader (004), so a new column is
-- NOT automatically writable and this grant is required. INSERT is
-- table-level, so the reader can set it when it first writes the line.
grant update (is_allowance) on line_items to cost_reader;


-- Cost-affecting conditions stated in the basis of estimate: tribal work,
-- historical fabric, an unusual site constraint. The asterisk next to the
-- number that says "this one is not like the others".
--
-- text[] rather than an enum. These are read from prose and the useful set is
-- not known yet — an enum would force a migration every time an estimator
-- names a new one, and the first few months are exactly when that will happen.
-- Worth revisiting once the values have settled.
alter table document_frames
  add column if not exists special_considerations text[];

comment on column document_frames.special_considerations is
  'Cost-affecting conditions stated in the basis of estimate — tribal, historical, site constraints. Free text array rather than an enum because the useful set is not known yet. Pass one already reads this section.';

create index if not exists document_frames_considerations_idx
  on document_frames using gin (special_considerations);

-- NO GRANT NEEDED HERE, and that is worth saying rather than leaving as an
-- absence. cost_reader holds TABLE-level UPDATE and INSERT on document_frames
-- (004), so this column is writable the moment it exists.
--
-- Which is the same mechanism 006 had to close on `deliverables`, where
-- table-level SELECT would have handed the reader the billing columns. It is
-- benign here — the reader owns every column of a frame, so there is nothing
-- on that table it should not touch. Noted so the asymmetry reads as a
-- decision rather than an oversight.


-- ============================================================================
-- VERIFICATION
--
-- Uncomment and run as a second query. Every row should read exactly this:
--
--   task_number is text[]         true
--   pursuits.date_created gone    true
--   invoice_instructions renamed  true
--   trigger is UPDATE only        true
--   sync_anomalies exists         1
--   sync_runs exists              1
--   sync_run_tables exists        1
--   airtable_sync exists          1
--   airtable_sync no bypassrls    true
--   sync policies                 56   (16 x 3, +2 anomalies, +3 runs, +3 run_tables)
--   sync CANNOT set is_active     true
--   sweep is security definer     true
--   sweep executable by sync only true
--   is_allowance exists           true
--   reader CAN write allowance    true
--   special_considerations exists true
--   reader CAN write considerations true
--   sync CAN insert people        true
--   sync CAN update task_status   true
--   sync CAN update phase_ii      true
--   sync CANNOT update status     true
--   sync CANNOT update type       true
--   sync CANNOT update total      true
--   sync CANNOT update completed  true
--   sync CANNOT update cost_lib   true
--   sync CANNOT delete anywhere   true
--   sync CANNOT read profiles     true
--   sync CANNOT read line_items   true
--   sync CANNOT resolve anomalies true
--   bucket exists                 1
--   sync relations                (the 17 named below, and nothing else)
--
-- Expected relations (19): activity_log, bid_results, client_companies,
-- contacts, deliverable_assignees, deliverable_subconsultants, deliverables,
-- out_of_office, people, project_notes, projects, pursuits,
-- subconsultant_invoices, subconsultant_tasks, subconsultants,
-- sync_anomalies, sync_run_tables, sync_runs, time_entries.
--
-- As in 004, treat the first run as the baseline. What matters is that the
-- list does not GROW later.
--
-- PRIVILEGES ARE NOT PROOF. Every check below asks the catalog what the role
-- is allowed to do. None of them proves a policy lets it write a row, and a
-- policy denial is not an error — it reports success and changes nothing. The
-- write tests under "After running this" are the ones that would catch §8
-- being wrong, and they are not optional.
-- ============================================================================
--
-- select 'task_number is text[]' as item,
--        (select data_type = 'ARRAY' from information_schema.columns
--          where table_schema='public' and table_name='deliverables'
--            and column_name='task_number')::text as value
-- union all select 'pursuits.date_created gone',
--        (not exists (select 1 from information_schema.columns
--          where table_schema='public' and table_name='pursuits'
--            and column_name='date_created'))::text
-- union all select 'invoice_instructions renamed',
--        (exists (select 1 from information_schema.columns
--          where table_schema='public' and table_name='projects'
--            and column_name='invoice_instructions')
--     and not exists (select 1 from information_schema.columns
--          where table_schema='public' and table_name='projects'
--            and column_name='invoice_due_by'))::text
-- union all select 'trigger is UPDATE only',
--        (select (tgtype & 4) = 0 and (tgtype & 16) <> 0 and (tgtype & 2) <> 0
--           from pg_trigger where tgname='trg_deliverables_completed_at'
--            and not tgisinternal)::text
-- union all select 'sync_anomalies exists',
--        (select count(*)::text from information_schema.tables
--          where table_schema='public' and table_name='sync_anomalies')
-- union all select 'airtable_sync exists',
--        (select count(*)::text from pg_roles where rolname='airtable_sync')
-- union all select 'airtable_sync no bypassrls',
--        (select (not rolbypassrls)::text from pg_roles where rolname='airtable_sync')
-- union all select 'sync policies',
--        (select count(*)::text from pg_policy p
--          where exists (select 1 from pg_roles r
--                         where r.oid = any (p.polroles) and r.rolname='airtable_sync'))
-- union all select 'sync CAN insert people',
--        has_table_privilege('airtable_sync','public.people','INSERT')::text
-- union all select 'sync CAN update task_status',
--        has_column_privilege('airtable_sync','public.deliverables','task_status','UPDATE')::text
-- union all select 'sync CAN update phase_ii',
--        has_column_privilege('airtable_sync','public.deliverables','phase_ii_workflow','UPDATE')::text
-- union all select 'sync CANNOT update status',
--        (not has_column_privilege('airtable_sync','public.deliverables','status','UPDATE'))::text
-- union all select 'sync CANNOT update type',
--        (not has_column_privilege('airtable_sync','public.deliverables','type','UPDATE'))::text
-- union all select 'sync CANNOT update total',
--        (not has_column_privilege('airtable_sync','public.deliverables','stated_total_cost','UPDATE'))::text
-- union all select 'sync CANNOT update completed',
--        (not has_column_privilege('airtable_sync','public.deliverables','completed_at','UPDATE'))::text
-- union all select 'sync CANNOT update cost_lib',
--        (not has_column_privilege('airtable_sync','public.deliverables','ready_for_cost_library','UPDATE'))::text
-- union all select 'sync CANNOT delete anywhere',
--        (select bool_and(not has_table_privilege('airtable_sync', c.oid, 'DELETE'))
--           from pg_class c join pg_namespace n on n.oid=c.relnamespace
--          where n.nspname='public' and c.relkind='r')::text
-- union all select 'sync CANNOT read profiles',
--        (not has_any_column_privilege('airtable_sync','public.profiles','SELECT'))::text
-- union all select 'sync CANNOT read line_items',
--        (not has_any_column_privilege('airtable_sync','public.line_items','SELECT'))::text
-- union all select 'sync CANNOT resolve anomalies',
--        (not has_any_column_privilege('airtable_sync','public.sync_anomalies','UPDATE'))::text
-- union all select 'sweep is security definer',
--        (select prosecdef::text from pg_proc
--          where proname='sweep_missing_from_airtable')
-- union all select 'sweep executable by sync only',
--        (has_function_privilege('airtable_sync','sweep_missing_from_airtable(uuid)','EXECUTE')
--     and not has_function_privilege('authenticated','sweep_missing_from_airtable(uuid)','EXECUTE'))::text
-- union all select 'sync_runs exists',
--        (select count(*)::text from information_schema.tables
--          where table_schema='public' and table_name='sync_runs')
-- union all select 'sync_run_tables exists',
--        (select count(*)::text from information_schema.tables
--          where table_schema='public' and table_name='sync_run_tables')
-- union all select 'sync CANNOT set is_active',
--        (not has_column_privilege('airtable_sync','public.deliverables','is_active','UPDATE')
--     and not has_column_privilege('airtable_sync','public.projects','is_active','UPDATE'))::text
-- union all select 'is_allowance exists',
--        (exists (select 1 from information_schema.columns where table_schema='public'
--           and table_name='line_items' and column_name='is_allowance'))::text
-- union all select 'reader CAN write allowance',
--        has_column_privilege('cost_reader','public.line_items','is_allowance','UPDATE')::text
-- union all select 'special_considerations exists',
--        (exists (select 1 from information_schema.columns where table_schema='public'
--           and table_name='document_frames' and column_name='special_considerations'))::text
-- union all select 'reader CAN write considerations',
--        has_column_privilege('cost_reader','public.document_frames',
--                             'special_considerations','UPDATE')::text
-- union all select 'bucket exists',
--        (select count(*)::text from storage.buckets where id='airtable-mirror')
-- union all select 'sync relations',
--        coalesce((select string_agg(c.relname, ', ' order by c.relname)
--                    from pg_class c join pg_namespace n on n.oid=c.relnamespace
--                   where n.nspname='public' and c.relkind in ('r','v','m')
--                     and (has_any_column_privilege('airtable_sync', c.oid, 'SELECT')
--                       or has_any_column_privilege('airtable_sync', c.oid, 'INSERT')
--                       or has_any_column_privilege('airtable_sync', c.oid, 'UPDATE')
--                       or has_table_privilege('airtable_sync', c.oid, 'DELETE'))), 'none');
--
-- ============================================================================


-- ============================================================================
-- AFTER RUNNING THIS
--
-- 1. RUN THE VERIFICATION BLOCK. "sync CANNOT update status" and
--    "sync relations" are the two to read first.
--
-- 2. THEN PROVE IT BY WRITING, WHICH THE CATALOG CANNOT. Both of the new
--    mechanisms in this migration — the policies in §8 and the trigger in §5 —
--    fail SILENTLY when they are wrong. A missing policy is not an error; the
--    write succeeds and changes zero rows. Check the row counts, not just the
--    absence of an exception.
--
--    Locally, `set role` is enough. On Supabase connect as the role instead —
--    `postgres` may not be permitted to `set role`, and connecting proves the
--    credential at the same time.
--
--        set role airtable_sync;
--
--        -- Expect: INSERT 0 1. Zero would mean §8's policy is missing.
--        insert into people (airtable_record_id, name)
--        values ('recSYNCTEST00001', 'Sync test') returning id;
--
--        -- Expect: UPDATE 1.
--        update people set title = 'written by the sync'
--         where airtable_record_id = 'recSYNCTEST00001';
--
--        -- Expect: ERROR, permission denied for table deliverables.
--        update deliverables set status = 'accepted' where true;
--
--        -- Expect: ERROR. completed_at is set at insert and by the trigger,
--        -- never by an update.
--        update deliverables set completed_at = now() where true;
--
--        -- Expect: ERROR, permission denied. This is the never-delete rule.
--        delete from people where airtable_record_id = 'recSYNCTEST00001';
--
--        -- Expect: ERROR, permission denied for table profiles.
--        select count(*) from profiles;
--
--        reset role;
--        delete from people where airtable_record_id = 'recSYNCTEST00001';
--
--    Note the last line runs as you, not the sync — the sync cannot clean up
--    after itself, which is the point.
--
-- 3. PROVE THE TRIGGER DOES NOT FIRE ON INSERT. This is the one that would
--    quietly fill completed_at with the import date for 3,023 tasks:
--
--        insert into deliverables (project_id, source, phase_ii_workflow)
--        values ((select id from projects limit 1), 'airtable', 'Complete')
--        returning completed_at;            -- expect NULL
--
--        update deliverables set phase_ii_workflow = 'Complete'
--         where completed_at is null and phase_ii_workflow = 'Complete'
--        returning completed_at;            -- expect NULL — not a transition
--
--        update deliverables set phase_ii_workflow = 'Quality Control'
--         where phase_ii_workflow = 'Complete' returning completed_at;
--        update deliverables set phase_ii_workflow = 'Complete'
--         where phase_ii_workflow = 'Quality Control'
--        returning completed_at;            -- expect a timestamp
--
--    Roll that back, or delete the test row afterwards.
--
-- 3b. PROVE THE SWEEP REFUSES. This is the guard that stops a half-finished
--     pass marking the base as vanished, and like §8's policies it is only
--     proved by trying it. Each of these should RAISE, not return rows:
--
--         -- an open run
--         insert into sync_runs (scope) values ('full') returning id;   -- :open
--         select * from sweep_missing_from_airtable(':open');
--         -- expect: sweep refused: run ... has not finished
--
--         update sync_runs set finished_at = now(), outcome = 'failed'
--          where id = ':open';
--         select * from sweep_missing_from_airtable(':open');
--         -- expect: sweep refused: run ... ended failed, not succeeded
--
--         update sync_runs set outcome = 'succeeded', scope = 'people'
--          where id = ':open';
--         select * from sweep_missing_from_airtable(':open');
--         -- expect: sweep refused: run ... read only people
--
--         update sync_runs set scope = 'full', dry_run = true where id = ':open';
--         select * from sweep_missing_from_airtable(':open');
--         -- expect: sweep refused: run ... was a dry run
--
--         update sync_runs set dry_run = false where id = ':open';
--         select * from sweep_missing_from_airtable(':open');
--         -- expect: 14 rows of counts, all zero on an empty mirror
--
--     Then prove the sync cannot go round it, which is the whole point of
--     withholding the column in §7:
--
--         set role airtable_sync;
--         update deliverables set is_active = false where true;
--         -- expect: ERROR, permission denied
--         reset role;
--
-- 4. THE SYNC SETS completed_at AT INSERT. Because §5 no longer fires on
--    insert, the sync is responsible for it: for a task whose Phase II is
--    already complete, set completed_at from due_date in the INSERT. One rule
--    for the initial load of 2,663 backfillable tasks and for any task created
--    in Airtable after go-live that is already finished. The 360 complete
--    tasks with no due date get null, which is honest.
--
-- 5. GIVE THE ROLE A PASSWORD AND STORE IT AS AIRTABLE_SYNC_DATABASE_URL,
--    the same way 004 handles READER_DATABASE_URL — Netlify, marked secret,
--    Functions only. Follow 004's "After running this" for the pooler host,
--    sslmode and port caveats; they are identical here.
--
--    The sync's db module should refuse to connect if the URL does not log in
--    as airtable_sync, exactly as src/lib/reader/db.ts does for cost_reader.
--    That check is what stops someone quietly pointing it at the service key
--    when something does not work.
--
-- 6. WHAT THIS MIGRATION DOES NOT DO. There is no sync. There are no
--    activity_log triggers — Airtable automations write that history today and
--    the Postgres equivalent is a later migration. `people` and `profiles` are
--    still unlinked. And the no-DELETE guarantee stops at the bucket: files go
--    through the storage API with a Supabase key, which no grant here
--    constrains.
-- ============================================================================
