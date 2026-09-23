-- ============================================================================
-- Migration 005b — room for everything pass one determines
--
-- Run it in Supabase → SQL Editor → New query → paste → Run.
-- Expected result: "Success. No rows returned."
--
-- Requires 004 and 005a. 005a must have been run, and committed, in an
-- EARLIER query: this file uses the `framed` status 005a adds, and a script
-- that adds an enum value cannot also use it.
--
-- NOT PURELY ADDITIVE. It widens cost_reader in two places — UPDATE on
-- `deliverables.type`, and UPDATE on `reader_questions.state` under a policy
-- that only lets it withdraw its own open assumptions — and it replaces two of
-- 004's policies (`deliverables_reader_update`, `line_items_reader_delete`)
-- with versions that know about `framed`. Everything else is new columns.
-- Safe to re-run.
--
-- After this, 004's verification reads 23 reader policies, not 22: one is
-- added here (`questions_reader_withdraw`), the two replaced ones net to zero.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Why this exists
--
-- PLAN §6.2: every determination in a document's frame carries its own
-- confidence and a note on where the answer came from. document_frames had
-- those for the coding system, the gross area and the markup, but not for the
-- deliverable type, the pricing base date or the stated total — and pass one
-- could not record the type at all. Those determinations were being made and
-- then kept only in the run log, where nothing downstream can see them.
--
-- Pass one also files its assumptions as questions now (§6.4), and a re-read
-- that changes its mind must be able to take back the question it no longer
-- stands behind — otherwise the stale one stays open and a person answers the
-- wrong thing.
--
-- And ingest_runs had no link to the document a run was about. The first draft
-- of the reader wrote the id into the first line of the notes and had the
-- sweeper parse it back out; a string convention is not a constraint, so this
-- makes it a column before any of that ships.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- 1. Confidence and evidence for the type, the base date and the stated total
--
-- Named to match what is already there: base_date_* beside pricing_base_date
-- and base_date_source, as gsf_* sits beside gsf_used. The type and the stated
-- total themselves stay on deliverables — they are facts about the document —
-- and their confidence and evidence live on the frame, with the other reader
-- determinations.
--
-- cost_reader holds table-level INSERT and UPDATE on document_frames (004), so
-- it can write these without a new grant.
-- ----------------------------------------------------------------------------

alter table document_frames
  add column if not exists deliverable_type_confidence numeric(4,3),
  add column if not exists deliverable_type_evidence   text,
  add column if not exists base_date_confidence        numeric(4,3),
  add column if not exists base_date_evidence          text,
  add column if not exists stated_total_confidence     numeric(4,3),
  add column if not exists stated_total_evidence       text;

-- ----------------------------------------------------------------------------
-- 2. The deliverable type, which the reader may now correct
--
-- The type is load-bearing: an estimate review is a critique of someone else's
-- numbers and must never be pooled with DCW's own pricing (schema.sql §3). The
-- upload form does not ask for it, so every uploaded document arrives as the
-- default `cost_estimate` whether it is one or not. Pass one reads the document
-- and knows better.
--
-- The reader only ever reaches a document its own policy lets it update — one
-- in the pipeline, never `accepted` — and when it changes the type it also
-- files an assumption question, so a person confirms the change rather than
-- discovering it.
--
-- OPEN QUESTION, deliberately left open: who owns `type` on rows MIRRORED
-- from Airtable? A column grant cannot be conditional, so this grant covers
-- every deliverable the status policy lets the reader update — which will
-- include Airtable-sourced rows once the backfill exists. schema.sql says
-- mirrored columns are never written back, and the one-way sync would
-- overwrite the reader's value on its next pass anyway. Today the question is
-- moot: the reader can only reach uploads, because it starts from a signed
-- URL for the storage bucket. Whoever builds the backfill must decide it —
-- Airtable wins, the reader wins, or the reader files a question and leaves
-- the column alone — and write that decision down here rather than let this
-- grant answer it by default.
-- ----------------------------------------------------------------------------

grant update (type) on deliverables to cost_reader;

-- ----------------------------------------------------------------------------
-- 3. Withdrawing a question the reader no longer stands behind
--
-- A re-read can reach a different conclusion than the first read — a gross
-- area it had to assume turns up on page 3. The first read's question is then
-- wrong, and if it stays open a person answers it. So the reader may withdraw
-- its own open assumptions, and do nothing else to a question:
--
--   column grant   `state` only — never `answer`, `answered_by`, the prompt,
--                  or anything a person writes
--   USING          only an OPEN ASSUMPTION — never a blocking question, and
--                  never one a person has answered, confirmed or corrected
--   WITH CHECK     the only state it may set is `withdrawn`
--
-- Only the reader files assumptions (people answer questions; they do not
-- create them), so "open assumption" is exactly "the reader's own, unanswered".
-- ----------------------------------------------------------------------------

grant update (state) on reader_questions to cost_reader;

drop policy if exists questions_reader_withdraw on reader_questions;
create policy questions_reader_withdraw on reader_questions
  for update to cost_reader
  using (mode = 'assumption' and state = 'open')
  with check (mode = 'assumption' and state = 'withdrawn');

-- ----------------------------------------------------------------------------
-- 4. ingest_runs.deliverable_id
--
-- ON DELETE SET NULL, not cascade: deleting a document (003 lets an uploader
-- undo their own, and admins anyone's) should not erase the record that the
-- reader worked on it and what that cost. A run with a null deliverable is a
-- run about a document that no longer exists, which is true.
--
-- Nullable because a run is not always about one document — a backfill run
-- covers many.
--
-- cost_reader holds table-level INSERT, UPDATE and SELECT on ingest_runs
-- (004), so it can write and read this column without a new grant.
-- ----------------------------------------------------------------------------

alter table ingest_runs
  add column if not exists deliverable_id uuid references deliverables(id) on delete set null;

create index if not exists ingest_runs_deliverable_idx on ingest_runs (deliverable_id);

-- The sweeper's question is "which unfinished runs are there", so index that
-- directly rather than scanning every finished run to find none.
create index if not exists ingest_runs_open_idx on ingest_runs (started_at) where finished_at is null;

-- No backfill. The notes-first-line format this column replaces was never
-- deployed, so no existing run carries a document id to recover.

-- ----------------------------------------------------------------------------
-- 5. 004's two status-scoped policies, now including `framed`
--
-- `framed` is a document the reader has understood but not yet extracted. The
-- reader must be able to move a document INTO it (WITH CHECK) and pick it back
-- up from it — for pass two, or when a person presses "Read now" to re-frame
-- it (USING). The delete policy keeps the same list as the update policy, for
-- the reason 004 gives: the reader must not clear line items from a document it
-- is not allowed to be working on.
--
-- Everything else about both policies is unchanged from 004.
-- ----------------------------------------------------------------------------

drop policy if exists deliverables_reader_update on deliverables;
create policy deliverables_reader_update on deliverables
  for update to cost_reader
  using (
    status in ('pending', 'downloading', 'framing', 'framed', 'extracting',
               'reconciling', 'needs_answer', 'failed')
  )
  with check (
    status in ('pending', 'downloading', 'framing', 'framed', 'extracting',
               'reconciling', 'needs_answer', 'accepted', 'failed', 'skipped')
  );

drop policy if exists line_items_reader_delete on line_items;
create policy line_items_reader_delete on line_items
  for delete to cost_reader
  using (
    reviewed_at is null
    and exists (
      select 1 from deliverables d
       where d.id = line_items.deliverable_id
         and d.status in ('pending', 'downloading', 'framing', 'framed',
                          'extracting', 'reconciling', 'needs_answer', 'failed')
    )
  );

-- ============================================================================
-- Verification — run in a NEW query. Expected:
--
--   item                           value
--   -----------------------------  -----
--   new frame columns              6
--   reader can update type         true
--   still CANNOT edit box link     true
--   still CANNOT edit issue date   true
--   reader can withdraw questions  true
--   CANNOT write an answer         true
--   CANNOT reattribute an answer   true
--   withdraw is withdraw-only      1
--   run link sets null             1
--   reader policies                23   (004's 22, plus questions_reader_withdraw)
--   policies know 'framed'         3    (update USING, update WITH CHECK, delete)
-- ============================================================================
--
-- select 'new frame columns' as item,
--        (select count(*)::text from information_schema.columns
--          where table_schema = 'public' and table_name = 'document_frames'
--            and column_name in ('deliverable_type_confidence', 'deliverable_type_evidence',
--                                'base_date_confidence', 'base_date_evidence',
--                                'stated_total_confidence', 'stated_total_evidence')) as value
-- union all
-- select 'reader can update type',
--        has_column_privilege('cost_reader', 'public.deliverables', 'type', 'UPDATE')::text
-- union all
-- select 'still CANNOT edit box link',
--        (not has_column_privilege('cost_reader', 'public.deliverables',
--                                  'box_file_url', 'UPDATE'))::text
-- union all
-- select 'still CANNOT edit issue date',
--        (not has_column_privilege('cost_reader', 'public.deliverables',
--                                  'issue_date', 'UPDATE'))::text
-- union all
-- select 'reader can withdraw questions',
--        has_column_privilege('cost_reader', 'public.reader_questions', 'state', 'UPDATE')::text
-- union all
-- select 'CANNOT write an answer',
--        (not has_column_privilege('cost_reader', 'public.reader_questions',
--                                  'answer', 'UPDATE'))::text
-- union all
-- select 'CANNOT reattribute an answer',
--        (not has_column_privilege('cost_reader', 'public.reader_questions',
--                                  'answered_by', 'UPDATE'))::text
-- union all
-- -- The policy's WITH CHECK must name `withdrawn` and nothing else it could set.
-- select 'withdraw is withdraw-only',
--        (select count(*)::text from pg_policies
--          where schemaname = 'public' and tablename = 'reader_questions'
--            and policyname = 'questions_reader_withdraw'
--            and 'cost_reader' = any (roles)
--            and qual like '%open%' and qual like '%assumption%'
--            and with_check like '%withdrawn%'
--            and with_check not like '%answered%'
--            and with_check not like '%confirmed%'
--            and with_check not like '%corrected%')
-- union all
-- select 'run link sets null',
--        (select count(*)::text from pg_constraint c
--          where c.contype = 'f'
--            and c.conrelid = 'public.ingest_runs'::regclass
--            and c.confrelid = 'public.deliverables'::regclass
--            and c.confdeltype = 'n')
-- union all
-- select 'reader policies',
--        (select count(*)::text from pg_policy p
--          where exists (select 1 from pg_roles r
--                         where r.oid = any (p.polroles)
--                           and r.rolname = 'cost_reader'))
-- union all
-- select 'policies know ''framed''',
--        ((select count(*) from pg_policies
--           where schemaname = 'public'
--             and policyname in ('deliverables_reader_update', 'line_items_reader_delete')
--             and qual like '%framed%')
--         + (select count(*) from pg_policies
--             where schemaname = 'public'
--               and policyname = 'deliverables_reader_update'
--               and with_check like '%framed%'))::text;
