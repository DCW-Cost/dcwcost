-- ============================================================================
-- Migration 003 — let an uploader finish and undo their own upload
--
-- Run it in Supabase → SQL Editor → New query → paste → Run.
-- Expected result: "Success. No rows returned."
--
-- Requires 001 and 002.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- The problem
--
-- `deliverables` had exactly two policies: read (001's parent schema) and
-- insert (001). No UPDATE, no DELETE.
--
-- That broke the two-step upload in the worst possible way — silently.
-- /documents/confirm sets `storage_path` once the file lands, and row-level
-- security denied it. A denied UPDATE is not an error: PostgREST reports
-- success with zero rows changed. So the browser was told the upload had been
-- recorded, redirected to "Stored", and the row kept `storage_path` NULL —
-- leaving a document that shows as "Upload incomplete" with nothing on screen
-- explaining why.
--
-- The failed-upload cleanup was denied the same way, which is why the row
-- could not remove itself either.
--
-- The application code now verifies that a write actually affected a row, so
-- this class of silent denial surfaces rather than passing as success. These
-- policies are the other half: the writes the flow legitimately needs.
-- ----------------------------------------------------------------------------

-- Finish your own upload — this is what records `storage_path`. Admins may fix
-- up anyone's, since they are the ones who reconcile a hand-uploaded document
-- against its real Airtable record later.
--
-- `uploaded_by` is pinned in the WITH CHECK so an update cannot reassign a
-- document to somebody else on the way through.
create policy deliverables_update on deliverables
  for update
  using (is_admin() or (is_active_user() and uploaded_by = auth.uid()))
  with check (is_admin() or uploaded_by = auth.uid());

-- Undo your own. This is what removes a half-made row when the file never
-- arrives; without it the debris is permanent.
--
-- Deliberately narrower than update: only admins may remove a document that
-- someone else uploaded, because deleting a deliverable takes everything the
-- reader extracted from it along too.
create policy deliverables_delete on deliverables
  for delete
  using (is_admin() or (is_active_user() and uploaded_by = auth.uid()));

-- A hand-made project is equally undoable by whoever made it — a failed upload
-- can otherwise leave an empty project behind with no way to clear it.
create policy projects_delete on projects
  for delete
  using (is_admin() or (is_active_user() and created_by = auth.uid()));

-- ============================================================================
-- Verification — run in a NEW query. Expected:
--
--   item                       value
--   -------------------------  -----
--   deliverables update        1
--   deliverables delete        1
--   projects delete            1
--   orphan rows (no file)      0 after you clear them — see below
-- ============================================================================
--
-- select 'deliverables update' as item, count(*)::text as value
--   from pg_policies where schemaname='public' and tablename='deliverables' and cmd='UPDATE'
-- union all
-- select 'deliverables delete', count(*)::text
--   from pg_policies where schemaname='public' and tablename='deliverables' and cmd='DELETE'
-- union all
-- select 'projects delete', count(*)::text
--   from pg_policies where schemaname='public' and tablename='projects' and cmd='DELETE'
-- union all
-- select 'orphan rows (no file)', count(*)::text
--   from deliverables where storage_path is null and airtable_record_id is null;
--
-- ----------------------------------------------------------------------------
-- Clearing the rows left behind by the silent failure
--
-- Any document showing "Upload incomplete" was registered but never got its
-- file recorded. The file may or may not have reached storage; either way the
-- row is not usable and re-uploading is cleaner than repairing it.
--
-- Run this to remove them, then upload again:
--
-- delete from deliverables
--  where source = 'upload'
--    and storage_path is null
--    and airtable_record_id is null;
--
-- Empty projects those uploads created, if you want them gone too:
--
-- delete from projects p
--  where p.created_by is not null
--    and not exists (select 1 from deliverables d where d.project_id = p.id);
-- ----------------------------------------------------------------------------
