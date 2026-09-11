-- ============================================================================
-- Migration 002 — let a document exist while it is still being uploaded
--
-- Run it in Supabase → SQL Editor → New query → paste → Run.
-- Expected result: "Success. No rows returned."
--
-- Requires 001 to have been applied first.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- The problem
--
-- 001 added `deliverables_has_a_source`: every row must be reachable from
-- Airtable, from storage, or from Box. That was right when an upload was a
-- single step — the file arrived with the row.
--
-- Uploads are now two steps: register the document, then send the file
-- straight from the browser to storage (the file no longer passes through the
-- server, which is what was returning HTTP 400 on anything sizeable). Between
-- those steps the row legitimately has no file, so the INSERT failed with
--
--   new row for relation "deliverables" violates check constraint
--   "deliverables_has_a_source"
--
-- The invariant worth keeping is not "always reachable" — it is "reachable
-- before anything reads it". A row still waiting for its file is the one case
-- where no source is correct, and it is exactly the case the old constraint
-- forbade.
-- ----------------------------------------------------------------------------

alter table deliverables drop constraint if exists deliverables_has_a_source;

alter table deliverables
  add constraint deliverables_has_a_source check (
    -- Still being uploaded: no file yet, and that is the whole point.
    -- `storage_path` is what /documents/confirm sets once the file lands, so
    -- NULL here means precisely "not uploaded", never "lost".
    status = 'pending'
    or airtable_record_id is not null
    or storage_path is not null
    or box_file_url is not null
  ) not valid;

-- `not valid` skips existing rows so this cannot fail on data already present;
-- validating separately takes a weaker lock and reports rather than aborts.
alter table deliverables validate constraint deliverables_has_a_source;

-- ----------------------------------------------------------------------------
-- Anything that reads a deliverable must skip rows whose file never arrived.
-- A partial index makes "give me the documents that are actually ready" cheap
-- and, more usefully, makes the intent explicit for whoever writes the reader.
-- ----------------------------------------------------------------------------
create index if not exists deliverables_ready_idx
  on deliverables (status)
  where storage_path is not null or airtable_record_id is not null;

-- ============================================================================
-- Verification — run in a NEW query. Expected:
--
--   item                        value
--   --------------------------  -----
--   constraint present          true
--   constraint validated        true
--   pending rows without file   (however many uploads are mid-flight; 0 is fine)
-- ============================================================================
--
-- select 'constraint present' as item,
--        exists (select 1 from pg_constraint
--                 where conname = 'deliverables_has_a_source'
--                   and conrelid = 'public.deliverables'::regclass)::text as value
-- union all
-- select 'constraint validated',
--        coalesce((select convalidated::text from pg_constraint
--                   where conname = 'deliverables_has_a_source'
--                     and conrelid = 'public.deliverables'::regclass), 'MISSING')
-- union all
-- select 'pending rows without file',
--        (select count(*)::text from deliverables
--          where storage_path is null and airtable_record_id is null);
