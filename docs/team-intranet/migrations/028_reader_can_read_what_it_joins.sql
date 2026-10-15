-- ============================================================================
-- 028 — let the reader read the things it was taught to join
--
-- The first real upload failed. The reader downloaded the workbook, parsed it
-- — 105 sheets, 72,592 cells, 43,369 formulas in 5 seconds — and then:
--
--   FAILED: error: permission denied for table deliverables
--
-- Not row-level security. RLS returns no rows; this is a missing GRANT.
--
-- AND THE QUIETER HALF, which Rachel spotted on review: the reader CAN read
-- v_observations, and that view is security_invoker. So wherever the missing
-- grants did not stop a query outright, they would have returned rows with
-- the estimator and the client silently absent — no error, just empty values
-- where a name belonged. The outright failure is the lucky case.
--
-- THE PATTERN, WHICH IS THE POINT OF THIS FILE
--
-- `cost_reader` holds COLUMN-level SELECT on deliverables — 24 columns, no
-- table-level grant. That is deliberate and good: the reader sees what it
-- needs and nothing else. The consequence nobody carried forward is that
-- A COLUMN ADDED LATER IS NOT IN THE LIST, and a table joined later is not
-- granted at all. A new object starts with no privileges.
--
-- Three of my own changes widened what pass one reads and granted none of it:
--
--   026        added deliverables.estimator_id and made pass one select it
--   026        joined people for the estimator's name
--   last week  joined project_client_companies and client_companies so the
--              reader learns the client from the join rather than from
--              projects.client_name, which is empty on all 1,874 rows
--
-- The third has never run successfully. The two runs that worked in September
-- predate it. So "the reader works" was true of a version that read fewer
-- tables than the current one does.
--
-- Measured on production 2026-10-15, before this migration:
--
--   cost_reader SELECT deliverables.estimator_id      false
--   cost_reader SELECT people (table)                 false
--   cost_reader SELECT people.name                    false
--   cost_reader SELECT project_client_companies       false
--   cost_reader SELECT client_companies               false
--   cost_reader SELECT reader_conventions             true   (table-level, so
--                                                             026's new column
--                                                             came free)
--
-- That last line is why reader_conventions needed nothing: a table-level
-- grant covers columns added afterwards, a column-level grant does not. The
-- protection that makes deliverables safe is the same property that makes it
-- fragile.
--
-- WHAT THIS GRANTS, AND WHAT IT DELIBERATELY DOES NOT
--
-- Column-level everywhere, never table-level. people in particular carries
-- hourly_profit_rate, which 006 protected from `authenticated` on purpose;
-- granting (id, name) keeps that protection exactly as it is. The reader has
-- no business knowing what anyone is paid.
--
-- RLS is on for all three tables, so a grant alone changes nothing — each
-- needs a policy naming cost_reader. They are read-only and unconditional
-- (`using (true)`), matching deliverables_reader_read and
-- projects_reader_read, which are the shape this role already uses.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. The column 026 added
-- ----------------------------------------------------------------------------

grant select (estimator_id) on deliverables to cost_reader;

-- ----------------------------------------------------------------------------
-- 2. People — two columns, and no more than two
--
-- pass one joins this only to put a name in the prompt: "estimator: Preeti
-- Pustake" is context a model can match against a cover sheet. Nothing else
-- about a person is any of the reader's business.
-- ----------------------------------------------------------------------------

grant select (id, name) on people to cost_reader;

drop policy if exists people_reader_read on people;
create policy people_reader_read on people
  for select to cost_reader
  using (true);

-- ----------------------------------------------------------------------------
-- 3. The client join
--
-- The reader learns a project's clients from project_client_companies, not
-- from projects.client_name — that column is empty on all 1,874 rows, and a
-- project may have more than one client anyway, which is why 012 made it a
-- join table.
-- ----------------------------------------------------------------------------

grant select (project_id, client_company_id) on project_client_companies to cost_reader;
grant select (id, company_name) on client_companies to cost_reader;

drop policy if exists project_client_companies_reader_read on project_client_companies;
create policy project_client_companies_reader_read on project_client_companies
  for select to cost_reader
  using (true);

drop policy if exists client_companies_reader_read on client_companies;
create policy client_companies_reader_read on client_companies
  for select to cost_reader
  using (true);

commit;

-- ============================================================================
-- REPLAY-SAFE. GRANT is idempotent, and `create policy` has no IF NOT EXISTS
-- — not in 17, not anywhere — so each is preceded by `drop policy if exists`.
-- One transaction, so a failure leaves none of it.
--
-- The first version of this file wrapped each create in a `do $$ ... if not
-- exists (select 1 from pg_policies)` block instead. That is also idempotent,
-- and it replayed cleanly three times — but it is not what this repo does,
-- and a comment here claimed it was "the pattern 007 and 011 use", which was
-- simply false: every migration that creates a policy uses drop-then-create.
--
-- The repo's own replay guard caught it. One pattern, uniformly, is what lets
-- a guard like that mean anything.
--
-- VERIFICATION — expected after applying, AND IDENTICAL after a second apply:
--
--   cost_reader SELECT deliverables.estimator_id        true
--   cost_reader SELECT people.name                      true
--   cost_reader SELECT people.id                        true
--   cost_reader CANNOT read people.hourly_profit_rate   true
--   cost_reader has NO table-level SELECT on people     true
--   cost_reader SELECT project_client_companies.project_id   true
--   cost_reader SELECT client_companies.company_name    true
--   people_reader_read policy                           1
--   project_client_companies_reader_read policy         1
--   client_companies_reader_read policy                 1
--   authenticated STILL cannot read hourly_profit_rate  true
--   reader CANNOT read people.email / phone / birthday   true
--   reader CANNOT read client_companies.company_billing_instructions  true
--   reader CANNOT read client_companies.fee_proposal_notes            true
--   reader has NO INSERT or UPDATE on people            true
--   anon still cannot read people.name                  true
--
-- The negatives matter most: this widens one role and must widen no other.
-- Rachel asked for company_billing_instructions specifically — it is the one
-- column on that table least suited to a reader, and it stays closed.
--
-- AND THE CHECK THAT WOULD HAVE PREVENTED THIS FILE
--
-- Grants passing is not the same as the query working. The audit below asks
-- the real question — can the reader read every column its SQL names — and
-- returns the blocked ones. It reported 37 of 37 readable after this
-- migration; before it, four were missing and the first real upload is how
-- we found out.
--
-- Run it after ANY change to what pass one selects, or to the reader's
-- grants. It is the boundary no typecheck, test or build can see.
--
-- Run against production before committing, per the standing practice.
-- ============================================================================
--
-- select 'cost_reader SELECT deliverables.estimator_id' as item,
--        has_column_privilege('cost_reader','deliverables','estimator_id','SELECT')::text as value
-- union all select 'cost_reader SELECT people.name',
--        has_column_privilege('cost_reader','people','name','SELECT')::text
-- union all select 'cost_reader SELECT people.id',
--        has_column_privilege('cost_reader','people','id','SELECT')::text
-- union all select 'cost_reader CANNOT read people.hourly_profit_rate',
--        (not has_column_privilege('cost_reader','people','hourly_profit_rate','SELECT'))::text
-- union all select 'cost_reader has NO table-level SELECT on people',
--        (not has_table_privilege('cost_reader','people','SELECT'))::text
-- union all select 'cost_reader SELECT project_client_companies.project_id',
--        has_column_privilege('cost_reader','project_client_companies','project_id','SELECT')::text
-- union all select 'cost_reader SELECT client_companies.company_name',
--        has_column_privilege('cost_reader','client_companies','company_name','SELECT')::text
-- union all select 'people_reader_read policy',
--        (select count(*)::text from pg_policies where policyname='people_reader_read')
-- union all select 'project_client_companies_reader_read policy',
--        (select count(*)::text from pg_policies where policyname='project_client_companies_reader_read')
-- union all select 'client_companies_reader_read policy',
--        (select count(*)::text from pg_policies where policyname='client_companies_reader_read')
-- union all select 'authenticated STILL cannot read hourly_profit_rate',
--        (not has_column_privilege('authenticated','people','hourly_profit_rate','SELECT'))::text;
--
-- ============================================================================

-- ----------------------------------------------------------------------------
-- THE AUDIT. Lists any column pass one names that cost_reader cannot read.
-- Empty result = good. Keep the list in step with pass-one.ts.
-- ----------------------------------------------------------------------------
--
-- with needed(tbl, col) as (values
--   ('deliverables','id'),('deliverables','original_filename'),('deliverables','type'),
--   ('deliverables','phase'),('deliverables','issue_date'),('deliverables','estimator_id'),
--   ('deliverables','upload_notes'),('deliverables','storage_path'),('deliverables','project_id'),
--   ('deliverables','status'),('deliverables','file_checksum'),('deliverables','source_format'),
--   ('projects','id'),('projects','name'),('projects','sector'),('projects','region'),
--   ('projects','city'),('projects','gross_sf'),('projects','delivery_method'),
--   ('projects','airtable_record_id'),
--   ('people','id'),('people','name'),
--   ('project_client_companies','project_id'),('project_client_companies','client_company_id'),
--   ('client_companies','id'),('client_companies','company_name'),
--   ('reader_conventions','id'),('reader_conventions','kind'),('reader_conventions','rule'),
--   ('reader_conventions','rationale'),('reader_conventions','scope_estimator_id'),
--   ('reader_conventions','scope_client'),('reader_conventions','scope_from'),
--   ('reader_conventions','scope_to'),('reader_conventions','active'),
--   ('reader_conventions','superseded_by'),('reader_conventions','scope_template')
-- )
-- select tbl || '.' || col as blocked_column
--   from needed
--  where not has_column_privilege('cost_reader', tbl, col, 'SELECT');
--
-- ============================================================================
