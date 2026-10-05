-- ============================================================================
-- 013 — close the INSERT path into people, and stop the engine behind it
--
-- WHAT THIS FIXES, AND WHY IT IS NOT ANOTHER LIST
--
-- Six migrations have now each discovered that anon or authenticated held a
-- privilege nobody granted on purpose:
--
--   006  anon on 14 tables, not the 22 that existed
--   007  sweep_missing_from_airtable() executable by all three roles
--   007  the three sync bookkeeping tables, missed again
--   010  22 TABLES revoked; the three views left untouched
--   011  table-level UPDATE on the new join tables
--   012  v_people_compensation writable by authenticated  <- this one
--
-- Five of those six have one engine. Supabase installs DEFAULT PRIVILEGES on
-- schema public that grant everything to anon, authenticated and service_role
-- on every table, view, sequence and function created there. Every object
-- arrives open, and the only thing standing between that and production is
-- somebody remembering to write the REVOKE.
--
-- Each fix so far has been another list of objects. A list is correct on the
-- day it is written and wrong as soon as the next object exists. Section 4
-- removes the defaults instead, so a new object arrives unreachable and has
-- to be granted deliberately.
--
-- THIS MAKES LATER MIGRATIONS FAIL LOUDLY. That is the intent. After 013, a
-- new table is invisible to the app until something grants it — including a
-- table created by hand in the Supabase dashboard, which will appear to the
-- app as though it does not exist. The failure is immediate and legible,
-- which is the opposite of how all six instances above behaved.
--
-- ============================================================================
-- SECTION 1 — v_people_compensation
--
-- authenticated held INSERT, UPDATE, DELETE and TRUNCATE on this view and
-- nothing at all on people. The view is WHERE is_admin() with
-- security_invoker = false, so it runs as postgres and RLS on people does
-- not apply to it.
--
-- For SELECT the guard works. For UPDATE and DELETE it works by accident —
-- a non-admin sees no rows, so those statements affect none. For INSERT it
-- does not work at all: without WITH CHECK OPTION, Postgres never evaluates
-- a view's WHERE clause on insert. Any logged-in user, including one still
-- pending approval, could POST to /rest/v1/v_people_compensation and write a
-- row into people with any status, email and hourly_profit_rate.
--
-- Nothing was exploited: people has 0 rows today, and is_admin() reads
-- profiles rather than people, so this was never privilege escalation. The
-- sync is what makes it matter — it is about to load staff and their profit
-- rates into exactly this table.
--
-- The fix is both halves. The REVOKE closes it now; the CHECK OPTION means
-- the guard lives in the view, so re-granting INSERT later does not reopen
-- it. A revoke alone leaves a loaded gun with the safety on.
--
-- ALTER VIEW rather than CREATE OR REPLACE. Replacing the view would restate
-- its six columns and its security_invoker setting, and 012 is a fresh
-- reminder that a rebuilt view is a chance to silently change one of those.
-- ALTER cannot: it touches one storage option and nothing else.
-- ============================================================================

alter view public.v_people_compensation set (check_option = cascaded);

revoke insert, update, delete, truncate, references, trigger
  on public.v_people_compensation from authenticated;

-- ============================================================================
-- SECTION 2 — the other three views
--
-- REFERENCES and TRIGGER, which RLS does not cover and 010 revoked from 22
-- tables without touching a single view. Low consequence on a view, and the
-- same rule: a role holds what it was shown to need.
-- ============================================================================

revoke references, trigger on public.v_observations     from authenticated;
revoke references, trigger on public.v_question_answers from authenticated;
revoke references, trigger on public.v_wishlist         from authenticated;

-- ============================================================================
-- SECTION 3 — sequences
--
-- All six sequences in public were readable, usable and SETTABLE by anon,
-- authenticated and service_role. UPDATE on a sequence permits setval, which
-- nothing needs and which would collide primary keys on every later insert.
--
-- anon holds no privilege on any of the six owning tables, so it needs
-- nothing here at all.
--
-- authenticated inserts into three of the six and genuinely needs USAGE on
-- those, for the nextval() in their defaults. It inserts into none of the
-- other three. USAGE is kept exactly where an insert exists to need it.
-- ============================================================================

revoke all on sequence
  public.audit_log_id_seq,
  public.confidence_rules_id_seq,
  public.cost_indices_id_seq,
  public.reader_conventions_id_seq,
  public.reader_questions_id_seq,
  public.sync_anomalies_id_seq
  from anon;

revoke select, update on sequence
  public.audit_log_id_seq,
  public.confidence_rules_id_seq,
  public.cost_indices_id_seq,
  public.reader_conventions_id_seq,
  public.reader_questions_id_seq,
  public.sync_anomalies_id_seq
  from authenticated;

-- authenticated has SELECT only on audit_log, cost_indices and
-- sync_anomalies, so it never calls nextval on their sequences.
revoke usage on sequence
  public.audit_log_id_seq,
  public.cost_indices_id_seq,
  public.sync_anomalies_id_seq
  from authenticated;

-- ============================================================================
-- SECTION 4 — the default privileges themselves
--
-- This is the part that is not a list.
--
-- Two roles hold default ACLs on schema public: postgres and supabase_admin.
-- Migrations run through the SQL editor execute as postgres, so the postgres
-- entry is the one that governs every object this project creates, and it is
-- the one that produced all five instances.
--
-- FUNCTIONS ARE INCLUDED DELIBERATELY. The default EXECUTE grant is what left
-- sweep_missing_from_airtable() callable by anon in 007 — a function that
-- marks the entire mirror missing. Note that a trigger function needs no
-- EXECUTE grant, because Postgres does not check it for triggers; a function
-- called from an RLS policy or exposed as PostgREST RPC does, and from here
-- on must be granted by name.
--
-- service_role keeps its defaults. It is the trusted backend key, it already
-- bypasses RLS by design, and narrowing it would break the server routes
-- without closing anything a client can reach.
-- ============================================================================

alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

-- The supabase_admin entry covers objects supabase_admin creates rather than
-- objects we create, so it is not the one that caused any of the six.
-- Altering it requires membership in that role, which postgres may not have
-- on a hosted project. Attempted, and reported either way rather than failing
-- the migration — an advisory finding, not a blocker.
do $block$
begin
  alter default privileges for role supabase_admin in schema public
    revoke all on tables from anon, authenticated;
  alter default privileges for role supabase_admin in schema public
    revoke all on sequences from anon, authenticated;
  alter default privileges for role supabase_admin in schema public
    revoke all on functions from anon, authenticated;
  raise notice '013: supabase_admin default privileges narrowed as well.';
exception
  when others then
    raise notice '013: could not alter supabase_admin default privileges (%). The postgres entry is narrowed, which is the one that governs objects created by migrations.', sqlerrm;
end
$block$;

-- ============================================================================
-- VERIFICATION
--
-- Uncomment and run as a second query. Every row should read exactly this:
--
--   v_pc structurally insertable      YES   <- correct; see STEP 2
--   v_pc check option                 CASCADED
--   v_pc reloptions                   security_invoker=false,check_option=cascaded
--   v_pc authenticated privs          SELECT
--   anon on ANY relation              none
--   anon on any sequence              none
--   authenticated writes a view       none
--   authenticated sequence USAGE      confidence_rules_id_seq, reader_conventions_id_seq, reader_questions_id_seq
--   authenticated sequence UPDATE     none
--   default privs: anon/auth in pub   supabase_admin/S, supabase_admin/f, supabase_admin/r
--                                     — or none, if section 4's guarded block succeeded
--   sync relations                    21
--   reader relations                  13
--
-- "v_pc structurally insertable" READS YES AND YES IS CORRECT. It is not a
-- failure and must not be read as one. information_schema's
-- is_insertable_into reports whether a view is structurally auto-updatable —
-- one base relation, no aggregates, plain column references — and a check
-- option does not change any of that. The check option governs whether the
-- WHERE is ENFORCED on insert, not whether an insert is structurally
-- possible. The row is kept because it is the reason the check option is
-- needed at all: the view stays insertable, so the guard has to live
-- somewhere, and STEP 2 is what shows that it does.
--
-- "v_pc reloptions" must still contain security_invoker=false. 006 set that
-- explicitly, so it is stored and printed rather than implied, and both
-- options must appear. If it ever reads true, the view starts enforcing RLS
-- on people and admins stop seeing compensation — the harmless direction,
-- but still not what was written. Using ALTER VIEW rather than CREATE OR
-- REPLACE is what makes that essentially impossible here.
--
-- "default privs: anon/auth in pub" is the row that makes the other eleven
-- stop needing to be rewritten each time. It asks whether any default ACL on
-- schema public still names anon or authenticated, for any object type and
-- any granting role. The postgres entries must be gone. A remaining
-- supabase_admin entry is the advisory case from section 4: it governs
-- objects supabase_admin creates, not ours. Before 013 this row read
-- "postgres/S, postgres/f, postgres/r, supabase_admin/S, supabase_admin/f,
-- supabase_admin/r"; the three postgres entries are the ones that must go.
--
-- The three relation rows are the standing query from 012, unchanged except
-- that relkind is cast to text — it is a "char", and the concatenation is
-- ambiguous without the cast. 012's copy is corrected in the same commit.
--
-- Every statement below was run against production before this file was
-- committed, which is the practice 012 did not follow and should have. The
-- STEP 2 probe was run there too, against the UNFIXED view, and correctly
-- reported GUARD FAILED — a check that cannot fail proves nothing, so it was
-- shown failing before it was trusted to pass. people held 0 rows before and
-- after.
--
-- STEP 1 — the catalog query.
-- ============================================================================
--
-- with pub as (select c.oid, c.relname, c.relkind from pg_class c
--                join pg_namespace n on n.oid = c.relnamespace
--               where n.nspname='public' and c.relkind in ('r','v','m','p','f')),
-- seqs as materialized (select c.oid, c.relname from pg_class c
--                join pg_namespace n on n.oid = c.relnamespace
--               where n.nspname='public' and c.relkind = 'S')
-- select 'v_pc structurally insertable' as item,
--        (select is_insertable_into from information_schema.views
--          where table_schema='public' and table_name='v_people_compensation') as value
-- union all select 'v_pc check option',
--        (select check_option from information_schema.views
--          where table_schema='public' and table_name='v_people_compensation')
-- union all select 'v_pc reloptions',
--        (select coalesce(array_to_string(c.reloptions,','),'(none)') from pg_class c
--           join pg_namespace n on n.oid=c.relnamespace
--          where n.nspname='public' and c.relname='v_people_compensation')
-- union all select 'v_pc authenticated privs',
--        coalesce((select string_agg(privilege_type, ', ' order by privilege_type)
--                    from information_schema.role_table_grants
--                   where table_schema='public' and table_name='v_people_compensation'
--                     and grantee='authenticated'), 'none')
-- union all select 'anon on ANY relation',
--        coalesce((select string_agg(relname || ' (' || relkind::text || ')', ', ' order by relname)
--                    from pub
--                   where has_table_privilege('anon', oid, 'SELECT')
--                      or has_table_privilege('anon', oid, 'INSERT')
--                      or has_table_privilege('anon', oid, 'UPDATE')
--                      or has_table_privilege('anon', oid, 'DELETE')
--                      or has_table_privilege('anon', oid, 'TRUNCATE')), 'none')
-- union all select 'anon on any sequence',
--        coalesce((select string_agg(relname, ', ' order by relname) from seqs
--                   where has_sequence_privilege('anon', oid, 'USAGE')
--                      or has_sequence_privilege('anon', oid, 'SELECT')
--                      or has_sequence_privilege('anon', oid, 'UPDATE')), 'none')
-- union all select 'authenticated writes a view',
--        coalesce((select string_agg(relname, ', ' order by relname) from pub
--                   where relkind in ('v','m')
--                     and (has_table_privilege('authenticated', oid, 'INSERT')
--                       or has_table_privilege('authenticated', oid, 'UPDATE')
--                       or has_table_privilege('authenticated', oid, 'DELETE'))), 'none')
-- union all select 'authenticated sequence USAGE',
--        coalesce((select string_agg(relname, ', ' order by relname) from seqs
--                   where has_sequence_privilege('authenticated', oid, 'USAGE')), 'none')
-- union all select 'authenticated sequence UPDATE',
--        coalesce((select string_agg(relname, ', ' order by relname) from seqs
--                   where has_sequence_privilege('authenticated', oid, 'UPDATE')), 'none')
-- union all select 'default privs: anon/auth in pub',
--        coalesce((select string_agg(pg_get_userbyid(d.defaclrole) || '/' ||
--                                    d.defaclobjtype::text, ', ' order by
--                                    pg_get_userbyid(d.defaclrole) || '/' || d.defaclobjtype::text)
--                    from pg_default_acl d
--                    join pg_namespace n on n.oid = d.defaclnamespace
--                   where n.nspname = 'public'
--                     and (d.defaclacl::text like '%anon=%'
--                       or d.defaclacl::text like '%authenticated=%')), 'none')
-- union all select 'sync relations',
--        (select count(*)::text from pub
--          where has_any_column_privilege('airtable_sync', oid,'SELECT')
--             or has_any_column_privilege('airtable_sync', oid,'INSERT')
--             or has_any_column_privilege('airtable_sync', oid,'UPDATE'))
-- union all select 'reader relations',
--        (select count(*)::text from pub
--          where has_any_column_privilege('cost_reader', oid,'SELECT')
--             or has_any_column_privilege('cost_reader', oid,'INSERT')
--             or has_any_column_privilege('cost_reader', oid,'UPDATE'));
--
-- ============================================================================
--
-- ============================================================================
-- STEP 2 — the guard probe
--
-- The only check here that tests BEHAVIOUR rather than catalogue state, and
-- the only one that can tell whether the check option actually holds. No
-- query over pg_catalog can: every column it could read says the same thing
-- before and after the fix.
--
-- IT ATTEMPTS A REAL INSERT INTO people, THROUGH THE VIEW. It is safe to run
-- on production, and the safety is structural rather than careful: a DO block
-- is one statement, so the RAISE on the failure path aborts it and takes the
-- probe row with it. There is no path on which a row persists — if the guard
-- holds, the insert was rejected and there is nothing to undo; if the guard
-- is open, the insert succeeded and the RAISE rolls it back.
--
-- Run it as postgres, as the SQL editor does. auth.uid() is null there, so
-- is_admin() is false and the probe is a non-admin insert. Postgres owns the
-- view, so the REVOKE does not apply to it — which is the point: this tests
-- the structural half on its own, with the grant half deliberately bypassed.
-- That is the same thing as re-granting INSERT and trying again.
--
-- Expected after 013:  NOTICE  guard holds, rejected by: check option
-- Before 013:          ERROR   GUARD FAILED: (insert was not rejected)
--
-- An INCONCLUSIVE message means the insert was refused for some unrelated
-- reason — a new NOT NULL column on people, most likely — and the probe
-- tested nothing. Fix the probe rather than recording a pass.
-- ============================================================================
--
-- do $guard$
-- declare
--   blocked boolean := false;
--   why     text    := '(insert was not rejected)';
-- begin
--   begin
--     insert into public.v_people_compensation
--       (id, airtable_record_id, name, email, status, hourly_profit_rate)
--     values (gen_random_uuid(), 'recGUARDPROBE000', 'guard probe',
--             'probe@example.invalid', 'active', 999);
--   exception
--     when with_check_option_violation then blocked := true; why := 'check option';
--     when insufficient_privilege      then blocked := true; why := 'no INSERT privilege';
--     when others                      then blocked := false;
--       why := 'INCONCLUSIVE: rejected for an unrelated reason (' || sqlerrm || ')';
--   end;
--
--   if not blocked then
--     raise exception 'GUARD FAILED: % -- the probe row is rolled back with this error', why;
--   end if;
--   raise notice 'guard holds, rejected by: %', why;
-- end
-- $guard$;
--
-- ============================================================================
