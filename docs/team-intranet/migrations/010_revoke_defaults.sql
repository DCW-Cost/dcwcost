-- ============================================================================
-- Migration 010 — taking back what Supabase granted by default
--
-- Run it in Supabase → SQL Editor → New query → paste → Run.
-- Expected result: "Success. No rows returned."
--
-- Requires 001 through 009.
--
-- NARROWS ONLY. Nothing here grants anything that was not already granted,
-- and nothing here touches data. Safe to re-run. The one statement that gives
-- rather than takes (§5) restores a column grant that the revoke above it
-- would otherwise have removed as collateral.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Why this exists
--
-- Supabase's default privileges grant ALL — select, insert, update, delete,
-- truncate, references, trigger — to `anon` and `authenticated` on every table
-- created in `public`. 006 revoked them on the fourteen tables it created, and
-- nothing before 006 ever did. So twenty-two tables still carry the defaults,
-- including `profiles`, `bootstrap_admins`, `audit_log` and `line_items`.
--
-- Row-level security has been holding: the read policies resolve to
-- `is_active_user()`, which is false without a session, so an anonymous
-- request gets zero rows. Nothing is exposed today.
--
-- BUT RLS DOES NOT COVER ALL OF IT. Policies govern SELECT, INSERT, UPDATE and
-- DELETE. TRUNCATE, REFERENCES and TRIGGER sit outside row-level security
-- entirely — no policy is ever consulted. So on those three, "RLS is holding"
-- is not merely thin, it is not true: nothing is holding them.
--
-- What has kept that harmless is PostgREST, which only ever issues the four
-- verbs policies cover. That is a property of the layer in front of the
-- database rather than of the grant, and it is not where this schema has put
-- its trust anywhere else.
--
-- THREE DIFFERENT SITUATIONS, WHICH IS WHY THIS MIGRATION IS NOT A BLANKET
--
--   1. A grant nobody chose.        `anon` on all twenty-two. A Supabase
--                                   default, never a decision. §2 removes it.
--
--   2. A grant with no governing    `authenticated` holding write privileges
--      intent.                      on seven tables that have no write policy
--                                   at all, so every write already fails with
--                                   zero rows. §4 makes the failure loud.
--
--   3. A grant AND a policy, both   ten tables where somebody wrote a write
--      written deliberately.        policy on purpose — line_items_review_write
--                                   exists so an estimator can correct a
--                                   classification, and 004 narrowed it to
--                                   `authenticated` deliberately. The UI is not
--                                   built yet. LEFT ALONE: revoking half of a
--                                   deliberate pair to re-add it later is
--                                   churn, not tightening.
--
-- The five tables the portal genuinely writes — deliverables, projects,
-- profiles, wishlist_items, wishlist_votes — keep every write privilege they
-- have. They lose only the three in §3, which no policy governs and no code
-- can reach.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- A RULE FOR EVERY MIGRATION AFTER THIS ONE, AND THE REASON FOR IT
--
-- Put the GRANTs and REVOKEs at the END of a migration, after everything it
-- creates, and drive them from one list of that migration's own objects.
--
-- This is the third defect of an identical shape:
--
--   006  revoked `anon` on the fourteen tables it created; the twenty-two that
--        predated it were never considered, which is this migration.
--   007  revoked the sweep function from PUBLIC but not from the anon and
--        authenticated grants Supabase's defaults had already created.
--   007  revoked writes from `authenticated` on fourteen tables, then created
--        sync_runs, sync_run_tables and sync_anomalies LOWER IN THE SAME FILE
--        and never added them to the list. §5 finishes it.
--
-- Every one is the same mistake: the revoke was written against what existed
-- at the moment it was written, and objects added afterwards were not in it.
-- Not three lapses of attention — one structural habit. Writing the privilege
-- section last, from an explicit list, is what stops it, because the list is
-- then visibly the same length as the set of things the migration touched.
--
-- Together with 008's standing rule — read back out of the catalog what anon,
-- authenticated and service_role can do with everything the migration touched
-- — that is the checklist.
-- ----------------------------------------------------------------------------


-- ============================================================================
-- 2. anon loses everything on the twenty-two
--
-- Nothing in the application needs it, and that was established by reading the
-- code rather than assuming:
--
--   bootstrap_admins is read in exactly one place, inside a SECURITY DEFINER
--   function (schema.sql), which runs as the owner and needs no grant here.
--
--   profiles is read only after auth.getUser() returns a user — at which point
--   the request carries a session and PostgREST runs it as `authenticated`.
--   Before sign-in, loadSession returns { kind: 'anonymous' } without touching
--   a public table.
--
--   The anon key builds the client; it does not read tables. It talks to the
--   `auth` schema, and the public tables are reached only once a session
--   upgrades the role.
--
--   The marketing site reads src/data/*.js, not the database.
--
-- So there are no exceptions to name. If a future page genuinely needs to read
-- something before sign-in, it should get a grant that says so.
-- ============================================================================

revoke all on
  audit_log, bootstrap_admins, confidence_rules, cost_indices, deliverables,
  document_frames, estimate_briefs, estimate_inputs, estimate_lines, estimates,
  estimator_notes, ingest_runs, line_items, profiles, projects,
  reader_conventions, reader_questions, taxonomy, units,
  wishlist_comments, wishlist_items, wishlist_votes
from anon;


-- ============================================================================
-- 3. authenticated loses TRUNCATE, REFERENCES and TRIGGER on the same twenty-two
--
-- The most valuable statement in this migration, and the safest.
--
-- These three are the only privileges on this schema currently held back by
-- nothing at all. RLS never sees them. And nothing can use them: PostgREST
-- issues only SELECT, INSERT, UPDATE and DELETE, and REFERENCES and TRIGGER
-- are DDL privileges no application path touches.
--
-- So this reaches the five tables the portal really does write —
-- deliverables, projects, profiles, wishlist_items, wishlist_votes — without
-- going anywhere near the privileges those writes depend on.
-- ============================================================================

revoke truncate, references, trigger on
  audit_log, bootstrap_admins, confidence_rules, cost_indices, deliverables,
  document_frames, estimate_briefs, estimate_inputs, estimate_lines, estimates,
  estimator_notes, ingest_runs, line_items, profiles, projects,
  reader_conventions, reader_questions, taxonomy, units,
  wishlist_comments, wishlist_items, wishlist_votes
from authenticated;


-- ============================================================================
-- 4. authenticated loses writes on the seven tables it cannot write anyway
--
-- Situation 2 from the header: a grant with no governing intent.
--
--   audit_log, cost_indices, taxonomy, units   no write policy of any kind
--   document_frames, estimator_notes,          write policies exist, but only
--   ingest_runs                                for cost_reader
--
-- Every INSERT, UPDATE and DELETE by a signed-in user on these already
-- affects zero rows, because no policy admits it. Removing the privilege
-- changes a silent nothing into a permission error, which is the difference
-- between a write that failed and a write that was refused.
--
-- SELECT is untouched: the portal reads all seven.
-- ============================================================================

revoke insert, update, delete on
  audit_log, cost_indices, taxonomy, units,
  document_frames, estimator_notes, ingest_runs
from authenticated;


-- ============================================================================
-- 5. Finishing 007 on the three tables it created after its own revoke
--
-- 007 revoked these six privileges from `authenticated` on the fourteen mirror
-- tables, then created sync_runs, sync_run_tables and sync_anomalies further
-- down the same file and never added them to the list. They kept Supabase's
-- defaults, so the sync's own bookkeeping has been writable-by-privilege by
-- any signed-in user, and truncatable by anything that can issue SQL as that
-- role.
--
-- THE RE-GRANT BELOW IS NOT AN OVERSIGHT REVERSED, IT IS COLLATERAL REPAIRED.
-- `revoke update` removes column-level UPDATE along with the table-level kind,
-- so it would take away 007's `grant update (resolved_at, resolved_by,
-- resolution) on sync_anomalies` — the path by which an admin marks an anomaly
-- resolved. Revoke first, then give that back by name.
--
-- AND NOTE THE ASYMMETRY WITH 006, BECAUSE THE WRONG LESSON IS EASY TO DRAW.
--
-- 006 revoked SELECT on `deliverables` from cost_reader and proved that 004's
-- and 005b's column-level UPDATE grants survived it untouched. That is true,
-- and it is not the general rule. The rule is per privilege:
--
--   revoke SELECT  leaves column-level UPDATE alone — a different privilege
--   revoke UPDATE  removes column-level UPDATE everywhere it was granted
--
-- Confirmed on a real Postgres: a role holding `grant update (b, c)` keeps b
-- and c after a table-level `revoke select`, and loses both after a
-- table-level `revoke update`. So "we checked in 006 and column grants
-- survive a revoke" is the wrong generalisation to carry forward — it depends
-- entirely on whether the revoked privilege is the same one the column grant
-- named.
-- ============================================================================

revoke insert, update, delete, truncate, references, trigger on
  sync_runs, sync_run_tables, sync_anomalies
from authenticated;

grant update (resolved_at, resolved_by, resolution) on sync_anomalies to authenticated;


-- ============================================================================
-- 6. NOT DONE HERE: the billing columns on deliverables
--
-- Every active user can currently read `deliverables.hourly_rate`, `invoice`,
-- `invoice_date`, `collections_status` and `next_collection_action_needed_on`.
-- `authenticated` holds table-level SELECT and the policy is
-- `using (is_active_user())`.
--
-- 006 and 007 went to some trouble to keep those columns away from
-- `cost_reader`, and the portal's own users can read them. That is not
-- necessarily wrong — staff seeing task hourly rates and collections status
-- may be entirely normal — but it arrived as a side effect of merging tasks
-- into `deliverables`, not as a decision. It is recorded here as an open
-- question about who at DCW should see what, which is not a database question.
--
-- IF THE ANSWER TURNS OUT TO BE ADMINS ONLY, the shape is already built once,
-- for people.hourly_profit_rate in 006:
--
--   revoke select on deliverables from authenticated;
--   grant select (…every other column by name…) on deliverables to authenticated;
--   create or replace view v_deliverable_billing with (security_invoker = false)
--     as select … from deliverables where is_admin();
--
-- With the same two consequences: every column added to `deliverables` later
-- is invisible to the portal until granted, and `select *` errors rather than
-- omitting. A known change rather than a new design.
-- ============================================================================


-- ============================================================================
-- VERIFICATION
--
-- Uncomment and run as a second query. Every row should read exactly this:
--
--   anon on any public table     none
--   authenticated TRUNCATE       none
--   authenticated REFERENCES     none
--   authenticated TRIGGER        none
--   writes gone on the seven     true
--   portal can still write x5    true
--   sync tables: no writes       true
--   admin can still resolve      true
--   portal can still read x7     true
--   reader relations             12
--   sync relations               19
--
-- "anon on any public table" is deliberately asked of EVERY table rather than
-- the twenty-two, because the point of this migration is that the answer
-- should now be the same everywhere. A name appearing there later is a table
-- somebody created without thinking about its defaults.
-- ============================================================================
--
-- with pub as (
--   select c.oid, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname = 'public' and c.relkind = 'r'),
-- seven(t) as (values ('audit_log'),('cost_indices'),('taxonomy'),('units'),
--                     ('document_frames'),('estimator_notes'),('ingest_runs')),
-- five(t)  as (values ('deliverables'),('projects'),('profiles'),
--                     ('wishlist_items'),('wishlist_votes')),
-- syncbk(t) as (values ('sync_runs'),('sync_run_tables'),('sync_anomalies'))
-- select 'anon on any public table' as item,
--        coalesce((select string_agg(relname, ', ' order by relname) from pub
--                   where has_table_privilege('anon', oid, 'SELECT')
--                      or has_table_privilege('anon', oid, 'INSERT')
--                      or has_table_privilege('anon', oid, 'UPDATE')
--                      or has_table_privilege('anon', oid, 'DELETE')
--                      or has_table_privilege('anon', oid, 'TRUNCATE')), 'none') as value
-- union all select 'authenticated TRUNCATE',
--        coalesce((select string_agg(relname, ', ' order by relname) from pub
--                   where has_table_privilege('authenticated', oid, 'TRUNCATE')), 'none')
-- union all select 'authenticated REFERENCES',
--        coalesce((select string_agg(relname, ', ' order by relname) from pub
--                   where has_table_privilege('authenticated', oid, 'REFERENCES')), 'none')
-- union all select 'authenticated TRIGGER',
--        coalesce((select string_agg(relname, ', ' order by relname) from pub
--                   where has_table_privilege('authenticated', oid, 'TRIGGER')), 'none')
-- union all select 'writes gone on the seven',
--        (select bool_and(not has_table_privilege('authenticated', t, 'INSERT')
--                     and not has_table_privilege('authenticated', t, 'UPDATE')
--                     and not has_table_privilege('authenticated', t, 'DELETE'))
--           from seven)::text
-- union all select 'portal can still write x5',
--        (select bool_and(has_table_privilege('authenticated', t, 'INSERT')
--                      or has_table_privilege('authenticated', t, 'UPDATE')
--                      or has_table_privilege('authenticated', t, 'DELETE'))
--           from five)::text
-- union all select 'sync tables: no writes',
--        (select bool_and(not has_table_privilege('authenticated', t, 'INSERT')
--                     and not has_table_privilege('authenticated', t, 'DELETE'))
--           from syncbk)::text
-- union all select 'admin can still resolve',
--        (has_column_privilege('authenticated','public.sync_anomalies','resolved_at','UPDATE')
--     and has_column_privilege('authenticated','public.sync_anomalies','resolution','UPDATE'))::text
-- union all select 'portal can still read x7',
--        (select bool_and(has_table_privilege('authenticated', t, 'SELECT')) from seven)::text
-- union all select 'reader relations',
--        (select count(*)::text from pub
--          where has_any_column_privilege('cost_reader', oid, 'SELECT')
--             or has_any_column_privilege('cost_reader', oid, 'INSERT')
--             or has_any_column_privilege('cost_reader', oid, 'UPDATE'))
-- union all select 'sync relations',
--        (select count(*)::text from pub
--          where has_any_column_privilege('airtable_sync', oid, 'SELECT')
--             or has_any_column_privilege('airtable_sync', oid, 'INSERT')
--             or has_any_column_privilege('airtable_sync', oid, 'UPDATE'));
--
-- ============================================================================


-- ============================================================================
-- AFTER RUNNING THIS
--
-- 1. RUN THE VERIFICATION BLOCK, and run it rather than reading it. Both 008's
--    and 009's shipped with defects — one errored, one asserted something
--    false — because a verification block is commented-out SQL and a replay
--    never executes it.
--
-- 2. THEN EXERCISE THE FIVE WRITE PATHS, because this is the first migration
--    that has touched tables the portal writes to. The catalog says the
--    privileges survived; only the app can say the flows did:
--
--      - file a wishlist item, edit it, vote, unvote, delete it
--      - upload a document (writes deliverables and projects) and let the
--        confirm step run
--      - approve or decline somebody on the admin screen (writes profiles)
--
--    A failure here looks like a permission error, not a silent nothing, which
--    is the good direction — but find out on purpose rather than from Brittany.
--
--    AND READ THE ERROR, BECAUSE TWO DIFFERENT FAILURES LOOK SIMILAR:
--
--      "permission denied for table X"        a GRANT is missing. This
--                                             migration took something it
--                                             should not have.
--      "new row violates row-level security"  the grant is intact and a
--      or an UPDATE affecting zero rows       POLICY refused. Nothing to do
--                                             with this migration.
--
--    That distinction is the whole difference between a regression and a
--    working system behaving correctly. A replay without a real session
--    produces the second for everything, because is_active_user() is false
--    without one — which is why a clean replay cannot answer this question
--    and signing in can.
--
-- 3. WHAT IS LEFT FOR THE NEXT ONE. `authenticated` still holds
--    insert/update/delete on the five live-write tables and on the ten that
--    have a deliberate policy and no UI yet. Narrowing those means matching
--    each grant to the policy that governs it, table by table, and it is the
--    part with real breakage risk. Deliberately a separate migration.
--
-- 4. THE OPEN QUESTION IN §6 is yours, not the schema's: should every active
--    user see task hourly rates and collections status?
-- ============================================================================
