-- ============================================================================
-- Migration 004 — the reader's database role
--
-- Run it in Supabase → SQL Editor → New query → paste → Run.
-- Expected result: "Success. No rows returned."
--
-- Then follow "After running this" at the bottom. The role has no password
-- until you give it one, and it cannot connect without one.
--
-- Requires 001, 002 and 003.
--
-- NOT PURELY ADDITIVE. Unlike 001–003 this migration changes two objects that
-- already exist: it narrows the `line_items_review_write` policy to the
-- `authenticated` role, and it replaces the foreign key on
-- `reader_questions.line_item_id` so that it sets null instead of cascading.
-- Both are explained where they happen, and both are safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Why this exists
--
-- Nothing may write COST data today. schema.sql does have write policies —
-- `line_items_review_write` lets an estimator correct a classification,
-- `reader_questions_answer` lets anyone active answer, and 001 and 003 add
-- more on `deliverables` — but nothing may create a frame or a line item. The
-- comment on that gap explains why: "Everything else is written by the
-- pipeline's service role."
--
-- That line assumes the reader holds the service-role key. It would work, and
-- it is the usual shortcut. It also hands the component that touches every
-- client cost plan a credential that ignores every policy in this database —
-- including `profiles`, the wishlist, `estimates` and `bootstrap_admins`, none
-- of which the reader has any business reading.
--
-- So the reader gets its own role instead, allowed to do its job and nothing
-- else:
--
--   reads    deliverables, projects, taxonomy, units, cost_indices,
--            confidence_rules, reader_conventions, and its own prior output
--   writes   document_frames, line_items, reader_questions, estimator_notes,
--            ingest_runs
--   updates  frames and runs; a deliverable's ingest status and file facts;
--            the DERIVED columns of line items — never the raw ones, and never
--            on a row a person has reviewed
--   deletes  unreviewed line items of a document being re-read, and the
--            estimator notes that hang off them — nothing else
--
-- It cannot see `profiles`, `bootstrap_admins`, the wishlist, estimates, or
-- `audit_log`. If its credential ever leaks, the blast radius is bad cost rows
-- — recoverable, and visible in the data — rather than everything.
--
-- Widening this later is one line and a migration. Narrowing a service-role key
-- after the fact means first working out what it was actually using, which it
-- never had to tell anyone. Cheap direction first.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- The role
--
-- LOGIN because the reader connects directly rather than through PostgREST:
-- PostgREST authenticates as `anon` or `authenticated`, and neither is what we
-- want here.
--
-- Deliberately NOT: SUPERUSER, CREATEDB, CREATEROLE, BYPASSRLS. In particular
-- no BYPASSRLS — the policies below are the enforcement, and a role that
-- ignored them would defeat the point of this migration.
--
-- No password is set here. A password in a migration is a password in git.
-- ----------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'cost_reader') then
    create role cost_reader with login nosuperuser nocreatedb nocreaterole
                                 noinherit nobypassrls;
  end if;
end
$$;

comment on role cost_reader is
  'The document reader. Writes frames, line items, notes, questions and run '
  'logs; reads reference data and its own output. No access to profiles, '
  'wishlist, estimates or audit_log. Set its password out of band.';

-- A runaway loop should exhaust its own budget rather than the database's.
--
-- CHECK THE POOL SIZE BEFORE TRUSTING THE CONNECTION LIMIT. Supavisor opens
-- server connections per user up to the project's pool size; if that is larger
-- than the limit here, clients start getting "too many connections for role"
-- instead of queueing. Set this at or above the pool size shown in the
-- dashboard, or lower the pool size. The reader should also use one connection
-- per invocation rather than holding one.
alter role cost_reader connection limit 15;
alter role cost_reader set statement_timeout = '120s';

-- The reader must NEVER hold a transaction open across a model call. A framing
-- pass takes longer than this, so an open transaction would be killed mid-read
-- — and in the pooler's transaction mode it would pin a server connection for
-- the whole wait. Read, close, call the API, then write.
alter role cost_reader set idle_in_transaction_session_timeout = '60s';

grant usage on schema public to cost_reader;

-- ----------------------------------------------------------------------------
-- Table privileges
--
-- Two layers have to agree: a GRANT says the role may attempt the operation,
-- and a policy says which rows. Both are needed, and the GRANT is the coarser
-- of the two — so it is kept as tight as the policies.
-- ----------------------------------------------------------------------------

-- Reads: reference data, and the documents it has been asked to read.
grant select on
  deliverables,
  projects,
  taxonomy,
  units,
  cost_indices,
  confidence_rules,
  reader_conventions
to cost_reader;

-- Reads of its own output. SELECT is not optional on these: closing a run needs
-- it for the WHERE clause, and `insert … returning id` needs it for the
-- returned row, which RLS also filters.
grant select on
  document_frames,
  line_items,
  reader_questions,
  estimator_notes,
  ingest_runs
to cost_reader;

-- Writes: its own output only.
grant insert on
  document_frames,
  line_items,
  reader_questions,
  estimator_notes,
  ingest_runs
to cost_reader;

-- reader_questions.id is a bigserial, so an insert also needs its sequence.
-- The other tables default to gen_random_uuid() and need nothing.
grant usage on sequence reader_questions_id_seq to cost_reader;

-- Re-running a document replaces its frame rather than accumulating them
-- (document_frames.deliverable_id is unique), and a run is opened then closed.
grant update on document_frames, ingest_runs to cost_reader;

-- Column-level, deliberately. The reader moves a deliverable through its
-- ingest states and records what it learned about the file itself; it must not
-- be able to rewrite which project a document belongs to, its Box link, or its
-- issue date.
grant update (status, ingested_at, file_checksum, source_format,
              stated_total_cost)
  on deliverables to cost_reader;

-- Line items: the reader may correct what it DERIVED, never what it READ.
-- PLAN.md §6.4 has a corrected frame recompute the line items beneath it —
-- markups restripped, a different area applied, escalation redone — and that
-- has to be possible without discarding the evidence it was computed from.
--
-- Withheld on purpose: raw_description, raw_code, raw_uom, raw_quantity,
-- raw_unit_cost, raw_total_cost (what the document said — evidence, per
-- PLAN.md §5.1), source_sheet, source_cell_range, source_page (where it said
-- it), and reviewed_by / reviewed_at (a person's decision, not the pipeline's).
grant update (
  taxonomy_code, uom_canonical, quantity, unit_cost, total_cost,
  cost_per_project_sf, pct_of_total, basis, bare_unit_cost,
  bare_cost_per_project_sf, escalated_bare_cost_per_project_sf,
  escalation_index_version, is_markup, confidence
) on line_items to cost_reader;

-- Re-reading a document must not leave two sets of line items behind it.
-- line_items has no version column, so a second run would double every figure
-- that document contributes to v_observations. The policy below confines this
-- to documents still in the pipeline.
grant delete on line_items to cost_reader;

-- No DELETE anywhere else. Raw values are evidence (PLAN.md §5.1) and a
-- superseded issuance is kept rather than removed (§12).

-- ----------------------------------------------------------------------------
-- Policies
--
-- The existing policies were written for people and mostly resolve false for
-- this role — but note they were created without a TO clause, so they DO apply
-- to it and are evaluated. That works only because `is_active_user()` and
-- `is_admin()` are SECURITY DEFINER and executable by every role, and because
-- 003's deliverables_update calls auth.uid() directly, which PUBLIC may also
-- execute. These were read from this database's catalog before writing this
-- migration, but nothing has been proved against it until the verification
-- block below is run — do that, because a future change to either would stop
-- the reader quietly rather than loudly.
--
-- `to cost_reader` matters on the policies below: without it a policy applies
-- to every role, which would quietly widen what signed-in people can do.
--
-- `drop policy if exists` first, so this migration can be re-run.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- First, one existing policy has to be narrowed, or the reader cannot update a
-- line item at all.
--
-- `line_items_review_write` (schema.sql) was created without a TO clause, so it
-- applies to every role including this one. Unlike every other policy the
-- reader meets, its USING clause queries `profiles` DIRECTLY rather than
-- through a SECURITY DEFINER function:
--
--   is_active_user() and exists (select 1 from profiles where id = auth.uid()
--                                  and role in ('admin','estimator'))
--
-- Postgres checks table permissions for every table a policy references before
-- it reads a single row, and this role has no SELECT on `profiles`. So every
-- reader UPDATE on line_items would fail with "permission denied for table
-- profiles" — and it would fail before the reader's own permissive policy was
-- ever considered.
--
-- Narrowing it to `authenticated` changes nothing for people, who arrive as
-- that role, and takes it out of the reader's path. Verified against this
-- database: it is the only existing policy that reaches into a table directly
-- on anything the reader writes.
-- ----------------------------------------------------------------------------

alter policy line_items_review_write on line_items to authenticated;

-- ----------------------------------------------------------------------------
-- Second, one foreign key has to stop cascading, or a re-read destroys answers.
--
-- `reader_questions.line_item_id` is ON DELETE CASCADE. Cascades run as the
-- table owner and ignore row-level security, so deleting a document's line
-- items to re-read it would also delete every question attached to them —
-- including answered ones, with their `answer` and `answered_by`. PLAN.md §6.6
-- calls that attribution part of the data, and §6.5 needs the answer to resume
-- the document. Resuming after an answer would delete the answer.
--
-- Worse, where a question has been promoted to a convention,
-- `reader_conventions.learned_from` points at it with NO ACTION — so the
-- cascade hits a foreign-key violation and the entire DELETE errors.
--
-- SET NULL instead: the question survives the re-read, still tied to its
-- deliverable. line_item_id is nullable, so this is a safe change.
--
-- `estimator_notes.line_item_id` keeps its cascade, because that column is NOT
-- NULL and cannot be set null. A note is regenerated from the document on each
-- read, so losing it with its line item is correct rather than merely tolerable
-- — but it means a re-read does delete notes, which the summary above now says.
-- ----------------------------------------------------------------------------

-- `drop constraint if exists` alone would be a quiet no-op if this database's
-- constraint were named something else — and the `add` would then sit a second
-- foreign key beside the cascading one, both firing, with the cascade still
-- destroying answered questions. The name below was read from this database's
-- catalog, but "almost certainly right" is exactly what `if exists` hides, so
-- the block asserts the end state instead of assuming it.
do $$
declare
  n_fks   integer;
  del_act "char";
begin
  alter table reader_questions
    drop constraint if exists reader_questions_line_item_id_fkey;

  alter table reader_questions
    add constraint reader_questions_line_item_id_fkey
    foreign key (line_item_id) references line_items(id) on delete set null;

  select count(*) into n_fks
    from pg_constraint c
   where c.contype = 'f'
     and c.conrelid = 'public.reader_questions'::regclass
     and c.conkey = array[(select attnum from pg_attribute
                            where attrelid = 'public.reader_questions'::regclass
                              and attname = 'line_item_id')];

  if n_fks <> 1 then
    raise exception
      'reader_questions.line_item_id has % foreign keys, expected exactly 1. '
      'The original constraint was probably named something else and is still '
      'in place, still cascading. Find it in pg_constraint and drop it by name.',
      n_fks;
  end if;

  select c.confdeltype into del_act
    from pg_constraint c
   where c.conname = 'reader_questions_line_item_id_fkey'
     and c.conrelid = 'public.reader_questions'::regclass;

  if del_act <> 'n' then
    raise exception
      'reader_questions.line_item_id delete action is %, expected n (SET NULL).',
      del_act;
  end if;
end
$$;

-- Reads.
drop policy if exists deliverables_reader_read on deliverables;
create policy deliverables_reader_read on deliverables
  for select to cost_reader using (true);

drop policy if exists projects_reader_read on projects;
create policy projects_reader_read on projects
  for select to cost_reader using (true);

drop policy if exists taxonomy_reader_read on taxonomy;
create policy taxonomy_reader_read on taxonomy
  for select to cost_reader using (true);

drop policy if exists units_reader_read on units;
create policy units_reader_read on units
  for select to cost_reader using (true);

drop policy if exists indices_reader_read on cost_indices;
create policy indices_reader_read on cost_indices
  for select to cost_reader using (true);

drop policy if exists rules_reader_read on confidence_rules;
create policy rules_reader_read on confidence_rules
  for select to cost_reader using (true);

drop policy if exists conventions_reader_read on reader_conventions;
create policy conventions_reader_read on reader_conventions
  for select to cost_reader using (true);

drop policy if exists frames_reader_read on document_frames;
create policy frames_reader_read on document_frames
  for select to cost_reader using (true);

drop policy if exists line_items_reader_read on line_items;
create policy line_items_reader_read on line_items
  for select to cost_reader using (true);

drop policy if exists questions_reader_read on reader_questions;
create policy questions_reader_read on reader_questions
  for select to cost_reader using (true);

drop policy if exists notes_reader_read on estimator_notes;
create policy notes_reader_read on estimator_notes
  for select to cost_reader using (true);

drop policy if exists runs_reader_read on ingest_runs;
create policy runs_reader_read on ingest_runs
  for select to cost_reader using (true);

-- Writes.
drop policy if exists frames_reader_write on document_frames;
create policy frames_reader_write on document_frames
  for insert to cost_reader with check (true);

drop policy if exists frames_reader_update on document_frames;
create policy frames_reader_update on document_frames
  for update to cost_reader using (true) with check (true);

drop policy if exists line_items_reader_write on line_items;
create policy line_items_reader_write on line_items
  for insert to cost_reader with check (true);

-- A line item a person has reviewed is their decision, not the pipeline's.
-- The reader may recompute anything it derived, but not on a row somebody has
-- already confirmed — silently re-escalating an approved rate is exactly the
-- kind of change nobody would notice.
--
-- This applies to accepted documents too: PLAN.md §6.4 has a corrected frame
-- recompute the line items beneath it, and an accepted document can still
-- carry an assumption that later turns out wrong. Accepted is not frozen;
-- reviewed is.
drop policy if exists line_items_reader_update on line_items;
create policy line_items_reader_update on line_items
  for update to cost_reader
  using (reviewed_at is null) with check (reviewed_at is null);

drop policy if exists questions_reader_write on reader_questions;
create policy questions_reader_write on reader_questions
  for insert to cost_reader with check (true);

drop policy if exists notes_reader_write on estimator_notes;
create policy notes_reader_write on estimator_notes
  for insert to cost_reader with check (true);

drop policy if exists runs_reader_write on ingest_runs;
create policy runs_reader_write on ingest_runs
  for insert to cost_reader with check (true);

drop policy if exists runs_reader_update on ingest_runs;
create policy runs_reader_update on ingest_runs
  for update to cost_reader using (true) with check (true);

-- Deleting line items, so a re-read does not leave two sets behind it. Three
-- conditions, each doing a different job:
--
--   reviewed_at is null   a reviewed row is a person's work and survives
--   status in (...)       the same in-progress list the deliverables policy
--                         uses, so the reader cannot clear a document it is
--                         not allowed to be working on. `accepted` and
--                         `skipped` are both excluded: an accepted document's
--                         line items are the library, and a skipped one is
--                         nobody's business.
--
-- Consequence worth stating: a re-read of a document containing reviewed rows
-- would leave those rows alongside a fresh set, double-counting that document
-- in v_observations. The database cannot prevent that without also forbidding
-- the recompute, so the READER must refuse to re-read such a document and raise
-- a question instead. That is application logic; this policy is the floor
-- beneath it.
drop policy if exists line_items_reader_delete on line_items;
create policy line_items_reader_delete on line_items
  for delete to cost_reader
  using (
    reviewed_at is null
    and exists (
      select 1 from deliverables d
       where d.id = line_items.deliverable_id
         and d.status in ('pending', 'downloading', 'framing', 'extracting',
                          'reconciling', 'needs_answer', 'failed')
    )
  );

-- Deliverables: the reader may only touch a document that is actually in the
-- pipeline, and every in-progress state has to appear in USING — otherwise the
-- reader could not advance a document past its own first step, and a denied
-- UPDATE changes 0 rows and raises nothing, which is precisely the silent
-- failure 003 was written to fix.
--
-- `needs_answer` is in USING so the reader can resume a document once somebody
-- answers its question (PLAN.md §6.5). `accepted` is not: a finished document
-- is moved back by a person, not by the pipeline.
drop policy if exists deliverables_reader_update on deliverables;
create policy deliverables_reader_update on deliverables
  for update to cost_reader
  using (
    status in ('pending', 'downloading', 'framing', 'extracting',
               'reconciling', 'needs_answer', 'failed')
  )
  with check (
    status in ('pending', 'downloading', 'framing', 'extracting',
               'reconciling', 'needs_answer', 'accepted', 'failed', 'skipped')
  );

-- ----------------------------------------------------------------------------
-- No storage access, deliberately
--
-- An earlier draft of this migration granted SELECT on storage.objects. That
-- was wrong and is gone. storage.objects holds only metadata; the file itself
-- is served by the Storage HTTP API, which identifies its caller from a JWT and
-- never from a Postgres login. The grant would have let the reader list object
-- paths and fetch nothing. Minting a cost_reader JWT means holding the
-- project's JWT secret, which is as powerful as the service-role key and would
-- defeat this migration entirely.
--
-- Instead: when a document is queued, the app mints a short-lived signed URL
-- from the uploader's own session — the pattern documents/sign.ts already uses
-- — and hands that URL to the reader. The reader needs no storage privileges,
-- and the URL expires on its own.
--
-- This affects hand uploads only. Box documents arrive through the Box service
-- account (PLAN.md §6.1); Airtable-sourced rows carry an Airtable attachment
-- URL in `storage_path` (migration 001) and are fetched from Airtable. Neither
-- path touches Supabase storage.
-- ----------------------------------------------------------------------------

-- ============================================================================
-- Verification — run in a NEW query. Expected:
--
--   item                        value
--   --------------------------  -----------------------------------------
--   reader policies             22
--   can read deliverables       true
--   can insert line items       true
--   can update frames           true
--   can use question sequence   true
--   CANNOT read profiles        true
--   CANNOT read wishlist        true
--   CANNOT read estimates       true
--   CANNOT read audit_log       true
--   CANNOT create in public     true
--   CANNOT edit raw_total_cost  true
--   CANNOT edit box_file_url    true
--   CANNOT edit issue_date      true
--   is_active_user executable   true
--   is_admin executable         true
--   auth.uid executable         true
--   relations reachable         (the 12 named below, and nothing else)
--   definer fns executable      public.guard_wishlist_triage,
--                               public.handle_new_auth_user,
--                               public.is_active_user, public.is_admin
--   review policy narrowed      authenticated
--   question FK sets null       1
--
-- The name rows return names rather than counts on purpose: if something has
-- been granted that should not have been, a count tells you only that you have
-- a problem, while a name tells you which one. Names are schema-qualified, so
-- a Supabase-owned `extensions.foo` cannot be mistaken for one of ours.
--
-- Treat the first run as the baseline. Supabase may expose objects to every
-- role that this migration has no say over; what matters is that the list does
-- not GROW later.
--
-- Expected relations: confidence_rules, cost_indices, deliverables,
-- document_frames, estimator_notes, ingest_runs, line_items, projects,
-- reader_conventions, reader_questions, taxonomy, units.
-- ============================================================================
--
-- select 'reader policies' as item,
--        (select count(*)::text from pg_policy p
--          where exists (select 1 from pg_roles r
--                         where r.oid = any (p.polroles)
--                           and r.rolname = 'cost_reader')) as value
-- union all
-- select 'can read deliverables',
--        has_table_privilege('cost_reader',
--                            'public.deliverables', 'SELECT')::text
-- union all
-- select 'can insert line items',
--        has_table_privilege('cost_reader', 'public.line_items', 'INSERT')::text
-- union all
-- select 'can update frames',
--        has_table_privilege('cost_reader',
--                            'public.document_frames', 'UPDATE')::text
-- union all
-- select 'can use question sequence',
--        has_sequence_privilege('cost_reader',
--                               'public.reader_questions_id_seq', 'USAGE')::text
-- union all
-- select 'CANNOT read profiles',
--        (not has_any_column_privilege('cost_reader',
--                                      'public.profiles', 'SELECT'))::text
-- union all
-- select 'CANNOT read wishlist',
--        (not has_any_column_privilege('cost_reader',
--                                      'public.wishlist_items', 'SELECT'))::text
-- union all
-- select 'CANNOT read estimates',
--        (not has_any_column_privilege('cost_reader',
--                                      'public.estimates', 'SELECT'))::text
-- union all
-- select 'CANNOT read audit_log',
--        (not has_any_column_privilege('cost_reader',
--                                      'public.audit_log', 'SELECT'))::text
-- union all
-- select 'CANNOT create in public',
--        (not has_schema_privilege('cost_reader', 'public', 'CREATE'))::text
-- union all
-- -- The column-level grants are the finest-grained thing here, so prove
-- -- the withheld columns are withheld rather than trusting the GRANT text.
-- select 'CANNOT edit raw_total_cost',
--        (not has_column_privilege('cost_reader', 'public.line_items',
--                                  'raw_total_cost', 'UPDATE'))::text
-- union all
-- select 'CANNOT edit box_file_url',
--        (not has_column_privilege('cost_reader', 'public.deliverables',
--                                  'box_file_url', 'UPDATE'))::text
-- union all
-- select 'CANNOT edit issue_date',
--        (not has_column_privilege('cost_reader', 'public.deliverables',
--                                  'issue_date', 'UPDATE'))::text
-- union all
-- -- The existing policies are evaluated for this role and depend on these
-- -- being callable. If any goes false, the reader stops silently.
-- select 'is_active_user executable',
--        has_function_privilege('cost_reader',
--                               'public.is_active_user()', 'EXECUTE')::text
-- union all
-- select 'is_admin executable',
--        has_function_privilege('cost_reader',
--                               'public.is_admin()', 'EXECUTE')::text
-- union all
-- select 'auth.uid executable',
--        has_function_privilege('cost_reader', 'auth.uid()', 'EXECUTE')::text
-- union all
-- -- The catch-all. Every relation this role can reach, in any schema, by any
-- -- privilege, including column-level grants and including views and
-- -- materialized views — a materialized view has no row-level security at all.
-- -- Resolved through pg_class by oid rather than by name, so a schema the
-- -- current user cannot use does not error the whole query.
-- select 'relations reachable',
--        coalesce((select string_agg(n.nspname || '.' || c.relname, ', '
--                                    order by n.nspname, c.relname)
--                    from pg_class c
--                    join pg_namespace n on n.oid = c.relnamespace
--                   where c.relkind in ('r', 'p', 'v', 'm', 'f')
--                     and n.nspname not in ('pg_catalog', 'information_schema')
--                     and (has_any_column_privilege('cost_reader', c.oid, 'SELECT')
--                       or has_any_column_privilege('cost_reader', c.oid, 'INSERT')
--                       or has_any_column_privilege('cost_reader', c.oid, 'UPDATE')
--                       or has_table_privilege('cost_reader', c.oid, 'DELETE'))), 'none')
-- union all
-- -- New functions are executable by every role by default, which is the real
-- -- standing exposure this migration cannot close. Watch the list.
-- select 'definer fns executable',
--        coalesce((select string_agg(n.nspname || '.' || pr.proname, ', '
--                                    order by n.nspname, pr.proname)
--                    from pg_proc pr
--                    join pg_namespace n on n.oid = pr.pronamespace
--                   where pr.prosecdef
--                     and n.nspname not in ('pg_catalog', 'information_schema')
--                     -- has_function_privilege ignores schema USAGE, and
--                     -- Supabase ships definer functions in extensions, vault,
--                     -- pgsodium and others that every role may "execute" but
--                     -- cannot reach. Filter to what is actually callable.
--                     and has_schema_privilege('cost_reader', n.oid, 'USAGE')
--                     and has_function_privilege('cost_reader', pr.oid, 'EXECUTE')), 'none')
-- union all
-- -- Prove the two changes to existing objects actually took.
-- select 'review policy narrowed',
--        (select array_to_string(roles, ',') from pg_policies
--          where schemaname = 'public' and tablename = 'line_items'
--            and policyname = 'line_items_review_write')
-- union all
-- select 'question FK sets null',
--        (select count(*)::text from pg_constraint c
--          where c.contype = 'f'
--            and c.conrelid = 'public.reader_questions'::regclass
--            and c.confdeltype = 'n'
--            and c.conkey = array[(select attnum from pg_attribute
--                                   where attrelid = 'public.reader_questions'::regclass
--                                     and attname = 'line_item_id')]);

-- ============================================================================
-- After running this
--
-- 1. GIVE THE ROLE A PASSWORD — not in the SQL editor.
--
--    `alter role … password '…'` leaves the password in the editor's history,
--    in saved snippets, and in the Postgres log if DDL logging is on. Use
--    psql's \password instead, which sends only a SCRAM hash and never the
--    password itself:
--
--        psql "postgresql://postgres.<project-ref>@<pooler-host>:5432/postgres" -c "\password cost_reader"
--
--    Note there is no password in that string: psql prompts for it, so it
--    never reaches your shell history — which is the whole point of doing this
--    outside the SQL editor. One line, no backslash: a trailing backslash is
--    not a line continuation in PowerShell or cmd.
--
--    Use the SESSION-mode pooler (port 5432), not db.<ref>.supabase.co — that
--    host is IPv6-only without the IPv4 add-on, which affects your own machine
--    as much as it affects Netlify.
--
--    Generate something long and random. It goes into Netlify and nowhere else
--    — not a chat, not a commit, not a document.
--
-- 2. BUILD THE CONNECTION STRING, and use the POOLER rather than the direct
--    host. db.<ref>.supabase.co is IPv6-only without the IPv4 add-on, and
--    Netlify functions connect over IPv4.
--
--        postgresql://cost_reader.<project-ref>:<password>@<pooler-host>:6543/postgres?sslmode=require
--
--    The username is `cost_reader.<project-ref>`, not `cost_reader`. Take the
--    host from the dashboard's Connect dialog — it looks like
--    aws-0-<region>.pooler.supabase.com, so copy it rather than composing it.
--
--    `sslmode=require` behaves differently per driver: recent node-postgres
--    reads it as full certificate verification, and Supabase's chain goes to
--    its own CA, so the connection fails unless the driver is given that CA
--    (downloadable from the dashboard). Confirm once the driver is chosen.
--
--    Port 6543 is transaction mode: disable prepared statements in the driver,
--    and do not rely on SET persisting between statements. Port 5432 on the
--    pooler is session mode if
--    that becomes a problem.
--
--    Store it in Netlify as READER_DATABASE_URL, marked secret and scoped to
--    Functions only. Environment variables only take effect on a new build.
--
-- 3. CHECK IT IS ACTUALLY LIMITED. Run the verification block above, then prove
--    the denials through a real connection rather than `set role` — on Supabase
--    the `postgres` role may not be permitted to `set role` at all, and
--    connecting as the reader tests step 2 at the same time:
--
--        psql "<the READER_DATABASE_URL>"
--        select count(*) from deliverables;          -- expect a number
--        select count(*) from profiles;              -- expect: permission denied
--        delete from document_frames where false;    -- expect: permission denied
--
--    Note the table. The reader now HAS delete on line_items — scoped by
--    policy, but the grant is real — so deleting from there returns DELETE 0
--    and proves nothing. document_frames is a table it may never delete from.
--
--    `where false` matters either way: if the role turned out wider than
--    intended, a bare delete would empty the table while proving the point.
--
--    If the profiles query returns rows, stop. Nothing should use this role
--    until that is understood.
--
-- 4. If the reader ever needs access this does not grant, add it in a new
--    numbered migration rather than widening the role by hand. The grants above
--    are the written record of what the pipeline can reach.
-- ============================================================================
