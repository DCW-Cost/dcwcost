-- ============================================================================
-- Migration 008 — closing the last two gaps in the sync's privileges
--
-- Run it in Supabase → SQL Editor → New query → paste → Run.
-- Expected result: "Success. No rows returned."
--
-- Requires 001 through 007.
--
-- NOT PURELY ADDITIVE. It narrows what `airtable_sync` may do, and narrows
-- who may execute one function. Nothing here widens anything, and nothing
-- here touches data. Safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Why this exists
--
-- Two gaps, both left open by 007 and both now closed.
--
-- 1. `sweep_missing_from_airtable()` was executable by `anon` and
--    `authenticated`. 007 revoked it from PUBLIC, which was not enough. §1.
--
-- 2. `is_active` was locked down on `projects` and `deliverables` but not on
--    the 14 tables 006 created, because those carry table-level UPDATE. 007
--    documented that gap in prose. Prose drifts from grants, and the next
--    person reads the grants. §2.
--
-- The second one is not urgent in the way the first was. It is here now
-- because the tables are empty and the sync is not written: converting these
-- grants later, against 48,500 loaded rows and a sync built on the wider
-- permission, means re-verifying the sync against real data to prove nothing
-- depended on what was taken away.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- A RULE FOR EVERY MIGRATION AFTER THIS ONE
--
-- Supabase grants broad default privileges to `anon`, `authenticated` and
-- `service_role` on everything created in `public`. Not just tables —
-- functions, views and sequences too. Anything a migration creates is
-- reachable by an unauthenticated HTTP request until something says otherwise.
--
-- This has now caused two defects of identical shape:
--
--   006  every new mirror table arrived with full INSERT/UPDATE/DELETE for
--        anon and authenticated, with RLS as the only thing in the way. Found
--        by checking the catalog rather than assuming.
--
--   007  `sweep_missing_from_airtable()` — SECURITY DEFINER, runs as postgres,
--        mass-updates 14 tables — arrived executable by anon. The migration
--        revoked it from PUBLIC, which does not remove the explicit grants
--        Supabase's defaults create. Found only because a verification row
--        asserted the negative.
--
-- The second happened after the first had been found, documented and written
-- up, because the lesson was applied to the object type that had just failed
-- rather than to the mechanism.
--
-- So, as a standing step: before a migration is considered done, every object
-- it creates — table, function, view, sequence — is checked against what
-- anon, authenticated and service_role can now do with it, and the answer is
-- asserted in the verification block as a negative. "Nothing was granted" is
-- not an observation anyone can make by reading the migration; it has to be
-- read back out of the catalog.
--
--   select c.relname, c.relkind,
--          has_table_privilege('anon', c.oid, 'SELECT') as anon_select
--     from pg_class c join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname = 'public' and c.relkind in ('r','v','m');
--
--   select p.proname, p.prosecdef,
--          has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public';
-- ----------------------------------------------------------------------------


-- ============================================================================
-- 1. The sweep is not a public API
--
-- `sweep_missing_from_airtable()` is SECURITY DEFINER. It runs as the owner,
-- bypasses row-level security, and writes `is_active` across 14 tables. 007
-- revoked it from PUBLIC and granted it to airtable_sync, which looked
-- complete and was not: Supabase's default privileges had already granted
-- EXECUTE to anon, authenticated and service_role explicitly, and a revoke
-- from PUBLIC does not touch an explicit grant.
--
-- The ACL after 007 read:
--
--   postgres=X/postgres | anon=X/postgres | authenticated=X/postgres |
--   service_role=X/postgres | airtable_sync=X/postgres
--
-- Supabase exposes functions in `public` over PostgREST, so that was an
-- unauthenticated HTTP endpoint onto a definer function. Every call refused
-- while `sync_runs` was empty — the guard rejects an unknown run id — but
-- that stops being true the first time the sync runs, and the refusal
-- messages named the run's outcome and scope to the caller in the meantime.
--
-- service_role is revoked too. It bypasses RLS and could perform the updates
-- directly, so holding EXECUTE adds nothing; and if the sync is ever moved to
-- the service key, this is the line that should have to change deliberately.
--
-- Already applied by hand on 2026-09-29, ahead of this migration, because
-- leaving it until 008 was written and reviewed was the wrong trade. Repeated
-- here so the repository is the source of truth rather than a transcript.
-- ============================================================================

revoke all on function public.sweep_missing_from_airtable(uuid)
  from anon, authenticated, service_role;

comment on function public.sweep_missing_from_airtable(uuid) is
  'Marks rows a finished sync run did not see as inactive, and revives any that reappeared. Refuses unless the run finished, succeeded, was a full pass and was not a dry run. SECURITY DEFINER, so EXECUTE is granted to airtable_sync alone — see migration 008 section 1.';


-- ============================================================================
-- 2. is_active belongs to the sweep on all sixteen tables, not two
--
-- 007 withheld `is_active` and `missing_from_airtable_since` from
-- airtable_sync on `projects` and `deliverables`, so on those two the sweep
-- function is the only way to mark a row missing — and the sweep refuses
-- unless the run that would justify it actually finished.
--
-- On the 14 tables 006 created the grant was table-level, so the sync kept the
-- raw privilege to write those columns by hand. The guard was the sanctioned
-- path there rather than a wall.
--
-- The reason for closing it is not that the gap was likely to be exercised —
-- it would take a deliberate act — but that a reader of the schema would find
-- two tables protected and fourteen not, with nothing to say whether that was
-- a decision or an oversight. Enforcement has been chosen over memory at
-- every previous fork here, and a partial version of it is the worst of both:
-- it reads as a guarantee and is not one.
--
-- 175 columns, generated from the live catalog rather than transcribed from
-- 006, because 175 names is exactly the length at which a typo survives review
-- and surfaces months later as something that silently cannot be written.
--
-- THE COST, ACCEPTED KNOWINGLY FOR THE SECOND TIME
--
-- After this, a column added to any of these tables is invisible to the sync
-- until it is named in a grant. Add an Airtable field, extend the table, and
-- the sync will read it and fail to write it — with a permission error, which
-- is the good failure, but a puzzling one if you do not know this is here.
--
-- This is the same trade already accepted for `people.hourly_profit_rate` in
-- 006. It is written down twice on purpose: whoever adds a column in six
-- months should find the reason rather than a mystery.
-- ============================================================================

revoke update on
  people, client_companies, subconsultants, contacts, pursuits,
  project_notes, time_entries, activity_log, bid_results, out_of_office,
  subconsultant_tasks, subconsultant_invoices,
  deliverable_subconsultants, deliverable_assignees
from airtable_sync;

-- SELECT and INSERT are unchanged and stay table-level. A row that does not
-- exist yet cannot be marked missing, and `is_active` defaults to true, so
-- there is nothing to withhold at insert.

grant update (name, email, phone, title, status, group_name, color_code, birthday, dcw_start_date, dcw_end_date, hourly_profit_rate, image_paths, synced_at) on people to airtable_sync;

grant update (company_name, client_code, client_priority, type, website, address_wa, address_or, address_ca, address_other, company_billing_instructions, fee_proposal_notes, client_lead_id, client_lead_backup_id, company_logo_paths, airtable_created_at, synced_at) on client_companies to airtable_sync;

grant update (company_name, client_code, type, website, address, company_billing_instructions, fee_proposal_notes, company_logo_paths, w9_paths, airtable_created_at, synced_at) on subconsultants to airtable_sync;

grant update (contact_name, contact_email, contact_phone, contact_job_title, company_department, primary_address, accurate_info, send_10_year_letter, client_company_id, subconsultant_id, added_on, synced_at) on contacts to airtable_sync;

grant update (title, status, project_pursuit_number, fee_proposal, box_link, notes, client_company_id, client_contact_id, due_date, confirmed_win_on, date_fee_proposal_rates_provided, date_marketing_materials_provided, ready_to_start, materials_provided, prime_proposal_components, project_category, project_type, request_the_following, unique_rates, submitting_as, tailored_language_needed, preferred_meeting_date_and_time, select_preferred_meeting_type, your_company, your_email, your_name, your_phone_number, month_year_pursuit_was_requested, year_pursuit_was_requested, final_proposal_paths, key_indesign_components_paths, upload_files_paths, airtable_created_at, synced_at) on pursuits to airtable_sync;

grant update (project_id, deliverable_id, added_by_id, notes, notes_include_info_on, docs_link_bluebeam_session, snip_image_paths, airtable_created_at, synced_at) on project_notes to airtable_sync;

grant update (person_id, deliverable_id, project_id, pursuit_id, entry_date, duration, notes, billable_status, admin_tags, billing_tags, cost_planning_tags, education_training_tags, innovation_tags, management_tags, marketing_tags, out_of_office_tags, airtable_created_at, airtable_revised_at, synced_at) on time_entries to airtable_sync;

grant update (deliverable_id, logged_by_id, action_owner_id, activity_name, activity_summary, activity_type, date_logged, milestone_date, previous_value, new_value, source, visibility, action_required, action_due_date, workload_relevant, pinned_to_project_detail, attachments_paths, synced_at) on activity_log to airtable_sync;

grant update (project_id, our_number, low_bid, high_bid, closest_bid_to_our_number, bids_received, link_to_bid_report, notes, date_added, attachment_paths, synced_at) on bid_results to airtable_sync;

grant update (person_id, vacation_title, category, approval, start_date, end_date, notes, attachments_paths, created_on, synced_at) on out_of_office to airtable_sync;

grant update (deliverable_id, subconsultant_id, status, notes, synced_at) on subconsultant_tasks to airtable_sync;

grant update (subconsultant_id, deliverable_id, invoice, total, status, date_received, date_paid, notes, invoice_paths, payment_confirmation_paths, synced_at) on subconsultant_invoices to airtable_sync;

grant update (deliverable_id, subconsultant_id, synced_at) on deliverable_subconsultants to airtable_sync;

grant update (deliverable_id, person_id, synced_at) on deliverable_assignees to airtable_sync;

-- Note what is NOT in any list above: `is_active`,
-- `missing_from_airtable_since`, `id` and `airtable_record_id`. The first two
-- belong to the sweep. The last two are identity — set once, at insert.
--
-- `synced_at` IS in every list and must stay there. The sweep decides what a
-- run did not see by comparing `synced_at` against the run's `started_at`; a
-- sync that could not stamp it would look, to the sweep, like a sync that saw
-- nothing, and the next sweep would mark the entire mirror missing.


-- ============================================================================
-- VERIFICATION
--
-- Uncomment and run as a second query. Every row should read exactly this:
--
--   sweep: sync only            true
--   sweep: anon denied          true
--   sweep: authenticated denied true
--   sweep: service_role denied  true
--   sweep acl                   postgres=X/postgres, airtable_sync=X/postgres
--   definer fns anon can run    guard_wishlist_triage, handle_new_auth_user,
--                               is_active_user, is_admin
--   is_active locked (14)       true
--   missing_since locked (14)   true
--   synced_at writable (16)     true
--   sync can still update       true
--   sync CANNOT delete anywhere true
--   sync relations              19, unchanged
--   sync policies               56, unchanged
--
-- The "definer fns anon can run" row is 004's baseline, unchanged. It is here
-- rather than in a comment because the standing rule at the top of this file
-- says the negative has to be read back out of the catalog, not asserted in
-- prose. If a fifth name ever appears there, something granted EXECUTE that
-- nobody intended.
-- ============================================================================
--
-- -- Two lists, not one. has_column_privilege() RAISES on a column that does
-- -- not exist, so the flag checks cover only the 14 tables that carry
-- -- is_active. The two join tables have no such column — see "What this
-- -- migration does not do" — and including them turned the whole block into
-- -- an error rather than a result.
-- with has_flag(t) as (values
--   ('people'),('client_companies'),('subconsultants'),('contacts'),('pursuits'),
--   ('project_notes'),('time_entries'),('activity_log'),('bid_results'),
--   ('out_of_office'),('subconsultant_tasks'),('subconsultant_invoices'),
--   ('projects'),('deliverables')),
-- all16(t) as (select t from has_flag
--              union all values ('deliverable_subconsultants'),('deliverable_assignees'))
-- select 'sweep: sync only' as item,
--        has_function_privilege('airtable_sync','sweep_missing_from_airtable(uuid)','EXECUTE')::text as value
-- union all select 'sweep: anon denied',
--        (not has_function_privilege('anon','sweep_missing_from_airtable(uuid)','EXECUTE'))::text
-- union all select 'sweep: authenticated denied',
--        (not has_function_privilege('authenticated','sweep_missing_from_airtable(uuid)','EXECUTE'))::text
-- union all select 'sweep: service_role denied',
--        (not has_function_privilege('service_role','sweep_missing_from_airtable(uuid)','EXECUTE'))::text
-- union all select 'sweep acl',
--        (select array_to_string(proacl,', ') from pg_proc
--          where proname='sweep_missing_from_airtable')
-- union all select 'definer fns anon can run',
--        coalesce((select string_agg(p.proname,', ' order by p.proname)
--                    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--                   where n.nspname='public' and p.prosecdef
--                     and has_function_privilege('anon', p.oid,'EXECUTE')),'none')
-- union all select 'is_active locked, 16 tables',
--        (select bool_and(not has_column_privilege('airtable_sync', t, 'is_active','UPDATE'))
--           from has_flag)::text
-- union all select 'missing_since locked, 16',
--        (select bool_and(not has_column_privilege('airtable_sync', t,
--                         'missing_from_airtable_since','UPDATE')) from has_flag)::text
-- union all select 'synced_at writable, 16',
--        (select bool_and(has_column_privilege('airtable_sync', t, 'synced_at','UPDATE'))
--           from all16)::text
-- union all select 'sync can still update',
--        (has_column_privilege('airtable_sync','public.people','title','UPDATE')
--     and has_column_privilege('airtable_sync','public.time_entries','duration','UPDATE')
--     and has_column_privilege('airtable_sync','public.deliverables','task_status','UPDATE'))::text
-- union all select 'sync CANNOT delete anywhere',
--        (select bool_and(not has_table_privilege('airtable_sync', c.oid,'DELETE'))
--           from pg_class c join pg_namespace n on n.oid=c.relnamespace
--          where n.nspname='public' and c.relkind='r')::text
-- union all select 'sync relations',
--        (select count(*)::text from pg_class c join pg_namespace n on n.oid=c.relnamespace
--          where n.nspname='public' and c.relkind in ('r','v','m')
--            and (has_any_column_privilege('airtable_sync',c.oid,'SELECT')
--              or has_any_column_privilege('airtable_sync',c.oid,'INSERT')
--              or has_any_column_privilege('airtable_sync',c.oid,'UPDATE')))
-- union all select 'sync policies',
--        (select count(*)::text from pg_policy p where exists
--          (select 1 from pg_roles r where r.oid = any(p.polroles)
--            and r.rolname='airtable_sync'));
--
-- ============================================================================


-- ============================================================================
-- AFTER RUNNING THIS
--
-- 1. RUN THE VERIFICATION BLOCK. "is_active locked, 16 tables" is the row this
--    migration exists for, and "synced_at writable, 16" is the one that says
--    it did not overshoot.
--
-- 2. THEN PROVE IT BY WRITING. A revoked column privilege fails loudly, so
--    unlike 007's policies these do raise — but the revoke-then-grant in §2
--    is the kind of thing that can take more than intended, and the catalog
--    only says what was granted, not what the sync needs:
--
--        set role airtable_sync;
--
--        -- Expect: ERROR, permission denied. This is the point of §2.
--        update people set is_active = false where true;
--        update time_entries set missing_from_airtable_since = now() where true;
--
--        -- Expect: UPDATE n. The sync must still be able to do its job.
--        update people set title = 'still writable', synced_at = now() where true;
--        update time_entries set duration = duration where true;
--        update deliverable_assignees set synced_at = now() where true;
--
--        -- Expect: ERROR, permission denied for function.
--        select * from sweep_missing_from_airtable(gen_random_uuid());
--
--        reset role;
--
--    The last one matters: airtable_sync KEEPS execute, so this should fail on
--    the run id rather than on the privilege. Read the error — "no sync_run"
--    is correct, "permission denied for function" means §1 took too much.
--
-- 3. AND AS anon, WHICH IS THE ONE 007 GOT WRONG. Easiest from the API rather
--    than psql, using the project's anon key:
--
--        curl -s -X POST \
--          "$SUPABASE_URL/rest/v1/rpc/sweep_missing_from_airtable" \
--          -H "apikey: $SUPABASE_ANON_KEY" \
--          -H "Content-Type: application/json" \
--          -d '{"p_run_id": "00000000-0000-0000-0000-000000000000"}'
--
--    Expect a permission error, not a refusal message. A refusal message means
--    anon still holds EXECUTE and is merely being turned away by the guard —
--    which is what 007 did, and is not the same thing.
--
-- 4. WHAT THIS MIGRATION DOES NOT DO.
--
--    The two join tables — `deliverable_subconsultants` and
--    `deliverable_assignees` — have no `is_active` and are not in the sweep's
--    target list. A link removed in Airtable therefore persists in Postgres
--    with nothing to mark it gone, because the sync cannot delete and has
--    nowhere to record the absence. Whether a removed link is an error to be
--    flagged (like a vanished project) or an ordinary edit to be followed is
--    a real question and not one to answer inside a privileges migration.
--
--    There is still no sync. `people` and `profiles` are still unlinked. The
--    activity_log triggers are still Airtable automations. And the no-DELETE
--    guarantee still stops at the bucket: files go through the storage API
--    with a Supabase key that no grant in 007 or 008 constrains.
-- ============================================================================
