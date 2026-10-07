-- ============================================================================
-- Migration 006 — the Airtable mirror
--
-- Run it in Supabase → SQL Editor → New query → paste → Run.
-- Expected result: "Success. No rows returned."
--
-- Requires 001, 002, 003, 004, 005a and 005b.
--
-- NOT PURELY ADDITIVE. Three things that already exist change here:
--
--   1. `cost_reader`'s SELECT on `deliverables` becomes column-level. It was
--      table-level, and a table-level SELECT covers every column added later —
--      so the task columns below would have handed the reader `hourly_rate`,
--      `invoice`, `invoice_date` and `collections_status` without a line of
--      SQL ever naming them. See §10.
--   2. `authenticated` and `anon` lose write privileges on the mirror tables,
--      and lose table-level SELECT on `people`. See §9.
--   3. `deliverables` grows the task columns and becomes the task record. §4.
--
-- All three are safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Why this exists
--
-- Airtable is the system of record and stays that way. This is the read side:
-- one direction, keyed on `airtable_record_id`, never deleting. The sync
-- itself is not written yet — this is only the shape it will fill.
--
-- WHAT THE FIELD INVENTORY SAID, AND WHERE IT COULD NOT BE BUILT AS WRITTEN
--
-- The inventory described 20 tables and 331 columns. Its own header said 313;
-- that figure counted mapping rows rather than columns, and 331 is the count
-- of the tables it actually describes. Four things needed deciding, and the
-- reasoning is recorded here because it is not recoverable from the SQL.
--
--   TASKS ARE DELIVERABLES. The inventory proposed a new `tasks` table. A DCW
--   task IS the thing delivered, and `deliverables` already exists, already
--   mirrors Airtable on `airtable_record_id`, and already carries the entire
--   reader pipeline: `document_frames.deliverable_id`, `line_items`,
--   `ingest_runs`, 003's write policy, 004's column grants. A second table
--   would have left the pipeline attached to a record the business does not
--   use. The task columns are added to `deliverables` instead. §4.
--
--   A consequence worth stating plainly: `deliverables.status` is already the
--   `ingest_status` enum — the reader's pipeline state, not a business state.
--   Airtable's Task Status therefore lands as `task_status`, and the two never
--   mix. Phase I/II/III get their own columns for the same reason.
--
--   NOT EVERY TASK PRODUCES A DOCUMENT. A project meeting can be its own
--   billed line item. Every file-bearing column on `deliverables`
--   (`storage_path`, `box_file_url`, `source_format`, `file_checksum`) is
--   already nullable and stays that way; nothing here adds a constraint that
--   would assume a document exists.
--
--   36 REVERSED FOREIGN KEYS. The inventory turned every Airtable link into a
--   single `uuid` column regardless of cardinality, so `people` carried
--   `dcw_project_tasks_id` — one task per person. Airtable links are
--   multi-valued and the FK belongs on the child. All 36 are dropped. Where
--   the relationship is genuinely many-to-many there is a join table: §6.
--
--   Dropping them also dissolved the load-order problem rather than working
--   around it. The inventory's step 1 (`people`) referenced steps 2, 6, 7, 8,
--   9, 10, 12, 13 and 16, and the contacts <-> client_companies cycle it
--   acknowledged disappears once `company_contacts_linked_id` is gone. The
--   order below is a clean DAG and needs no second pass.
--
--   FOUR ADDRESSES INTO ONE COLUMN. Address (CA), (OR), (Other) and (WA) all
--   mapped to a single `address`, which would have kept one of four and lost
--   the rest silently. DCW works with the WA and the OR office of the same
--   client, so all four are kept. §2.
--
-- DEFERRED, NOT FORGOTTEN
--
-- Six tables are not created here: team_capacity, operational_metrics,
-- learning, faq, continuing_education, cost_statements. The inventory's own
-- notes retire each of them — "never used", "we don't need this moved over
-- now", "may not need to move over at all". That is roughly 41 columns, each
-- of which would need a policy, a grant and sync code for data nobody reads.
-- A later migration can add any of them, which is cheaper than carrying them.
--
-- Also not carried: the Dashboard table, which links to Softr URLs and works
-- nowhere else, and the lookup and rollup columns the inventory listed against
-- its own rule that lookups are not carried — `dcw_projects_with_client`,
-- `company_contacts`, `subconsultants.dcw_project_tasks`, `note_includes`,
-- `end_of_week_summary`, `daily_time_tracking_hours` and
-- `pursuits.client_company_list_copy`. Postgres joins for these, and the value
-- can never go stale.
-- ----------------------------------------------------------------------------


-- ============================================================================
-- 1. Mirror bookkeeping
--
-- Every mirrored table carries the same four columns. The inventory listed
-- none of them, though its own rules require all four:
--
--   airtable_record_id  the sync key. UNIQUE, so a re-run updates rather than
--                       duplicates — rule 2 of the specification.
--   synced_at           when this row last heard from Airtable.
--   is_active           false once the row stops appearing. Rule 3 is "never
--                       delete": a project that vanishes has almost always
--                       been an error, not a deletion.
--   missing_from_airtable_since
--                       when it first went missing, so the gap is datable
--                       rather than a flag somebody has to happen to notice.
--
-- `projects` and `deliverables` already have the first two; §3 and §4 add only
-- what they lack.
-- ============================================================================


-- ============================================================================
-- 2. The people and companies the work hangs off
-- ============================================================================

-- Everyone at DCW. Replaces both Airtable's Collaborators and the Operations
-- base's Team Members — the same people, split in Airtable only because it
-- cannot hide a column from one view.
--
-- Deliberately distinct from `profiles`, which is the portal's auth identity.
-- A person exists here whether or not they ever sign in, and `profiles` rows
-- arrive only through the on_auth_user_created trigger. Joining the two is a
-- later migration's job, once a sync exists to prove the emails line up.
create table if not exists people (
  id                  uuid primary key default gen_random_uuid(),
  airtable_record_id  text unique not null,

  name                text not null,
  email               text,
  phone               text,
  title               text,
  status              text,
  -- `group` is a reserved word and would need quoting at every use site,
  -- forever. Renamed rather than quoted.
  group_name          text[],
  color_code          text,
  birthday            date,
  dcw_start_date      date,
  dcw_end_date        date,

  -- Admins only. §9 revokes table-level SELECT on this table and grants the
  -- other columns back by name, because a policy cannot hide a column — RLS
  -- filters rows. This is the one column the interface must not be trusted
  -- to hide.
  hourly_profit_rate  numeric(12,2),

  image_paths         text[],

  is_active                   boolean not null default true,
  missing_from_airtable_since timestamptz,
  synced_at                   timestamptz not null default now()
);

create index if not exists people_email_idx  on people (lower(email));
create index if not exists people_status_idx on people (status);

comment on column people.hourly_profit_rate is
  'Admin-only. Protected by a column grant, not by a policy. See migration 006 section 9.';


-- Client organisations.
create table if not exists client_companies (
  id                  uuid primary key default gen_random_uuid(),
  airtable_record_id  text unique not null,

  company_name        text not null,
  -- Airtable calls this "Client ID". Renamed so it cannot be mistaken for a
  -- foreign key: it is a human-assigned code.
  client_code         text,
  client_priority     text,
  type                text,
  website             text,

  -- Four addresses, not one. DCW works with the WA office and the OR office
  -- of the same client on different projects, and the inventory collapsed all
  -- four into a single column. Kept as four columns rather than a child table
  -- because the set is fixed and small; a fifth region would be the moment to
  -- normalise.
  address_wa          text,
  address_or          text,
  address_ca          text,
  address_other       text,

  company_billing_instructions text,
  fee_proposal_notes  text,

  client_lead_id        uuid references people(id) on delete set null,
  client_lead_backup_id uuid references people(id) on delete set null,

  company_logo_paths  text[],

  airtable_created_at timestamptz,
  is_active                   boolean not null default true,
  missing_from_airtable_since timestamptz,
  synced_at                   timestamptz not null default now()
);

create index if not exists client_companies_name_idx on client_companies (company_name);
create index if not exists client_companies_lead_idx on client_companies (client_lead_id);


-- Subconsultant firms.
create table if not exists subconsultants (
  id                  uuid primary key default gen_random_uuid(),
  airtable_record_id  text unique not null,

  company_name        text not null,
  client_code         text,
  type                text[],
  website             text,
  address             text,
  company_billing_instructions text,
  fee_proposal_notes  text,

  company_logo_paths  text[],
  w9_paths            text[],

  airtable_created_at timestamptz,
  is_active                   boolean not null default true,
  missing_from_airtable_since timestamptz,
  synced_at                   timestamptz not null default now()
);

create index if not exists subconsultants_name_idx on subconsultants (company_name);


-- People at client and subconsultant companies.
--
-- The inventory gave a contact three company links — `company_id`,
-- `client_company_list_copy_id` and `link_to_subconsultant_company_id` — and
-- its own note says one of them is a mistake. A contact belongs to one
-- company. That company lives in one of two tables, so this is two nullable
-- columns and a constraint, not three links and a convention.
--
-- Both are nullable on purpose. The inventory notes contacts who belong to
-- neither — the 401(k) contact, the payroll people — and those rows must
-- still load.
create table if not exists contacts (
  id                  uuid primary key default gen_random_uuid(),
  airtable_record_id  text unique not null,

  contact_name        text,
  contact_email       text,
  contact_phone       text,
  contact_job_title   text,
  company_department  text[],
  primary_address     text,
  accurate_info       text,
  send_10_year_letter boolean,

  client_company_id   uuid references client_companies(id) on delete set null,
  subconsultant_id    uuid references subconsultants(id) on delete set null,

  added_on            timestamptz,
  is_active                   boolean not null default true,
  missing_from_airtable_since timestamptz,
  synced_at                   timestamptz not null default now(),

  constraint contacts_one_company check (
    client_company_id is null or subconsultant_id is null
  )
);

create index if not exists contacts_client_company_idx on contacts (client_company_id);
create index if not exists contacts_subconsultant_idx  on contacts (subconsultant_id);
create index if not exists contacts_email_idx          on contacts (lower(contact_email));


-- ============================================================================
-- 3. Extending `projects`
--
-- `projects` already exists with four rows and is read by `v_observations`,
-- which selects `p.name`, `p.client_name`, `p.sector`, `p.region`,
-- `p.gross_sf` and `p.delivery_method`. Those names stay. The Airtable field
-- maps onto the existing column rather than arriving beside it under a second
-- name, because renaming breaks working, tested code for no gain:
--
--   Project Title                     -> name
--   Location (City, State)            -> city + region
--   Construction Start Date           -> construction_start   (date, not text)
--   Secured Project Status            -> project_status
--   Primary Category                  -> sector
--   Secondary Category                -> market
--   Record ID (Project)               -> airtable_record_id
--   Delivery Method                   -> delivery_method      (already present)
--   Link to Client Company (Add Here) -> client_id            (new, below)
--
-- `gross_sf` remains the universal normaliser per PLAN §5.3 and is NOT
-- conflated with building_sf or sitework_sf.
--
-- NOT ADDED HERE ON PURPOSE: budget, building_sf, sitework_sf,
-- construction_completion, new_reno_demo_etc and project_size. Those exist on
-- both Airtable tables, and they belong to the deliverable: they change between
-- phases as the design develops, and the point of keeping them is to see how
-- area and budget moved between SD and DD. A project-level copy would be a
-- second answer that silently goes stale. They are added in §4 instead.
--
-- `delivery_method` and `construction_start` are the exception: they already
-- exist on `projects`, `v_observations` reads the first, and this migration
-- does not drop live columns. Both therefore appear in both places — the
-- project's value is the contract-level one, the deliverable's is the value as
-- at that phase.
-- ============================================================================

alter table projects
  add column if not exists client_id          uuid references client_companies(id) on delete set null,
  add column if not exists client_contact_id  uuid references contacts(id) on delete set null,

  add column if not exists contract_amount            numeric(14,2),
  add column if not exists estimated_cost_building    numeric(14,2),
  add column if not exists estimated_cost_site        numeric(14,2),

  add column if not exists fee_proposal               text,
  -- Airtable types this as text and the values look like terms ("Net 30")
  -- rather than dates. Left as text deliberately; if the sync proves they are
  -- all dates, narrowing it later is a one-line migration, whereas guessing
  -- wrong now loses the data on load.
  add column if not exists invoice_due_by             text,

  add column if not exists nda                        boolean,
  add column if not exists need_to_fix_for_the_resume_builder boolean,
  add column if not exists time_card_required         boolean,

  add column if not exists project_description        text,
  add column if not exists project_descriptions_for_resume text,
  add column if not exists project_owner              text[],
  add column if not exists scope_categories           text[],

  add column if not exists project_image_paths        text[],

  add column if not exists airtable_created_at        timestamptz,
  add column if not exists is_active                  boolean not null default true,
  add column if not exists missing_from_airtable_since timestamptz;

create index if not exists projects_client_idx         on projects (client_id);
create index if not exists projects_client_contact_idx on projects (client_contact_id);

comment on column projects.client_id is
  'Airtable "Link to Client Company (Add Here)". client_name is kept for now because v_observations reads it; the sync should keep the two consistent until a later migration retires the text column.';


-- ============================================================================
-- 4. Extending `deliverables` — the task record
--
-- A DCW task IS the deliverable. These are the columns from Airtable's
-- "DCW Project Tasks", added to the table the reader already works against.
--
-- Naming collisions with what is already here, all resolved by the new name:
--
--   status      is the `ingest_status` enum (the reader's pipeline state).
--               Airtable's Task Status lands as `task_status`.
--   phase       is the `design_phase` enum (SD/DD/CD).
--               Airtable's Phase I/II/III land as phase_i/ii/iii_*.
--   type        is the `deliverable_type` enum (cost_estimate, review, …).
--               Airtable's Task Type lands as `task_type`.
--   issue_date  is when the document was issued; `due_date` is when the task
--               is owed. Different things, both kept.
--
-- DROPPED FROM THE INVENTORY:
--   billing_notes (text)   billing notes moved to `project_notes` with a tag;
--                          the text column is dead on arrival. The link is
--                          `project_notes.deliverable_id` (§5).
--   activity_log_id, assigned_team_members_id, team_capacity_id,
--   time_tracking_id, subconsultants_id, dcw_projects_id
--                          reversed to-many links. The FK lives on the child,
--                          or in a join table (§6). `project_id` already
--                          exists and is the link to the project.
-- ============================================================================

alter table deliverables
  -- Identity and workflow -----------------------------------------------
  add column if not exists task_name           text,
  add column if not exists project_task_title  text,
  -- Scalar. The inventory typed this text[], which an Airtable formula field
  -- produced; a task has one number.
  add column if not exists task_number         text,
  add column if not exists task_status         text,
  add column if not exists task_type           text[],

  -- Phase II is a progression (documents received -> milestones -> complete),
  -- not a flag, and it is the completion signal — Task Status is not. The
  -- trigger in §7 reads this column and nothing else.
  add column if not exists phase_i_upcoming    text,
  add column if not exists phase_ii_workflow   text,
  add column if not exists phase_iii_billing   text,

  -- Dates and schedule ---------------------------------------------------
  add column if not exists start_date              date,
  add column if not exists due_date                date,
  -- The delivery timeline, distinct from the due date. Captured by Airtable
  -- automation today; the sync will need to carry it.
  add column if not exists initial_draft_delivery  date,
  add column if not exists final_draft_delivery    date,
  add column if not exists revision_delivery       date,
  add column if not exists review_again_on         date,
  add column if not exists schedule                text,
  add column if not exists schedule_notes          text,

  -- Who is on it ---------------------------------------------------------
  add column if not exists project_manager_id  uuid references people(id) on delete set null,
  add column if not exists project_support_id  uuid references people(id) on delete set null,
  add column if not exists next_action_owner_id uuid references people(id) on delete set null,

  -- Workload and correspondence ------------------------------------------
  add column if not exists next_action                text,
  add column if not exists next_action_due_date       date,
  add column if not exists blocker_risk_notes         text,
  add column if not exists check_in_for_cost_planners text,
  add column if not exists meeting_update_notes       text,
  add column if not exists support_needed             boolean,
  add column if not exists support_request_notes      text,
  add column if not exists tech_team_decision         text,
  add column if not exists tech_team_meeting_notes    text,
  add column if not exists waiting_on                 text,
  add column if not exists workload_heat              text,
  add column if not exists special_note               text,
  add column if not exists client_correspondence      text,
  add column if not exists correspondence_note_link   text,
  add column if not exists has_note_been_transfered   boolean,

  -- Billing. Every column below is withheld from cost_reader in §10 ------
  add column if not exists billed_before_complete           boolean,
  add column if not exists collections_status               text,
  add column if not exists hourly_rate                      numeric(14,2),
  -- Text, not numeric. Invoice numbers carry leading zeros and prefixes; the
  -- inventory had this numeric here and text on subconsultant_invoices.
  add column if not exists invoice                          text,
  add column if not exists invoice_date                     date,
  add column if not exists next_collection_action_needed_on date,
  add column if not exists send_timesheets_by               date,
  add column if not exists time_card_complete               boolean,
  add column if not exists task_hours                       numeric,
  add column if not exists fee_proposal                     text,
  add column if not exists fee_proposal_link                text,

  -- Project scope as at this phase ---------------------------------------
  -- These also exist on the project. That is the point: they change between
  -- phases as the design develops, and holding them per deliverable is what
  -- makes "how did area and budget move between SD and DD" answerable.
  add column if not exists budget                      numeric(14,2),
  add column if not exists building_sf                 numeric(14,2),
  add column if not exists sitework_sf                 numeric(14,2),
  add column if not exists construction_start          date,
  add column if not exists construction_completion     date,
  add column if not exists delivery_method             text,
  add column if not exists new_reno_demo_etc           text[],
  add column if not exists project_size                text[],
  add column if not exists report_format               text[],
  add column if not exists work_breakdown              text,
  add column if not exists dcw_estimated_project_cost  numeric(14,2),
  add column if not exists project_folder_link         text,

  -- New. NO AIRTABLE SOURCE — the sync must not try to read either of these
  -- and must not overwrite them on a re-run.
  --
  -- ready_for_cost_library: an estimator ticks it when the report should enter
  -- the cost library. Complete is not the trigger on its own — they may want a
  -- week first.
  add column if not exists ready_for_cost_library boolean not null default false,
  -- completed_at: set by the trigger in §7 when Phase II reaches complete,
  -- and cleared if Phase II moves back.
  add column if not exists completed_at           timestamptz,

  -- Bookkeeping ----------------------------------------------------------
  add column if not exists airtable_created_at         timestamptz,
  add column if not exists airtable_last_modified_at   timestamptz,
  add column if not exists is_active                   boolean not null default true,
  add column if not exists missing_from_airtable_since timestamptz;

create index if not exists deliverables_task_status_idx on deliverables (task_status);
create index if not exists deliverables_pm_idx          on deliverables (project_manager_id);
create index if not exists deliverables_support_idx     on deliverables (project_support_id);
create index if not exists deliverables_due_date_idx    on deliverables (due_date);
create index if not exists deliverables_cost_library_idx
  on deliverables (ready_for_cost_library) where ready_for_cost_library;

comment on column deliverables.ready_for_cost_library is
  'NEW FIELD — no Airtable source. An estimator ticks it when the report should enter the cost library. Task completion alone is not the trigger.';
comment on column deliverables.completed_at is
  'NEW FIELD — no Airtable source. Maintained by trg_deliverables_completed_at from phase_ii_workflow. See migration 006 section 7.';
comment on column deliverables.task_status is
  'Airtable Task Status. NOT the completion signal — phase_ii_workflow is. deliverables.status is the reader pipeline state and is unrelated.';


-- ============================================================================
-- 5. The child tables
--
-- Created in dependency order. `pursuits` comes before `time_entries` because
-- Brittany logs time against a pursuit before notice to proceed, so the time
-- entry points at it.
-- ============================================================================

-- Pursuits, before a project exists.
--
-- DROPPED: `assignees_id` (a reversed to-many — a pursuit has several
-- assignees). Only two many-to-many relationships get join tables in this
-- migration, and this is not one of them; if pursuit assignment turns out to
-- matter, a `pursuit_assignees` table is the follow-up.
create table if not exists pursuits (
  id                  uuid primary key default gen_random_uuid(),
  airtable_record_id  text unique not null,

  title               text,
  status              text,
  project_pursuit_number text,
  fee_proposal        text,
  box_link            text,
  notes               text,

  client_company_id   uuid references client_companies(id) on delete set null,
  client_contact_id   uuid references contacts(id) on delete set null,

  due_date                          date,
  confirmed_win_on                  date,
  date_fee_proposal_rates_provided  date,
  date_marketing_materials_provided date,
  ready_to_start                    text,

  materials_provided        text[],
  prime_proposal_components text[],
  project_category          text[],
  project_type              text[],
  request_the_following     text[],
  unique_rates              text[],
  submitting_as             text,
  tailored_language_needed  text,

  -- These come from the website enquiry form that feeds this table.
  preferred_meeting_date_and_time timestamptz,
  select_preferred_meeting_type   text[],
  your_company        text,
  your_email          text,
  your_name           text,
  your_phone_number   text,

  -- Airtable derives both of these from the request date for a dashboard
  -- view. Carried as given; Postgres can compute them from
  -- airtable_created_at once something needs them.
  month_year_pursuit_was_requested text,
  year_pursuit_was_requested       text,

  final_proposal_paths         text[],
  key_indesign_components_paths text[],
  upload_files_paths           text[],

  -- Airtable has both "Created" and "Date Created" on this table and they
  -- appear to be the same fact. Both are carried rather than guessed at; if
  -- the sync confirms they agree, drop one later.
  airtable_created_at timestamptz,
  date_created        timestamptz,

  is_active                   boolean not null default true,
  missing_from_airtable_since timestamptz,
  synced_at                   timestamptz not null default now()
);

create index if not exists pursuits_client_company_idx on pursuits (client_company_id);
create index if not exists pursuits_status_idx         on pursuits (status);


-- Notes against a project or a deliverable, tagged by kind.
--
-- Billing instructions for Pam live here, not on the client record, and this
-- is where the task's old free-text `billing_notes` column went — the tag in
-- `notes_include_info_on` is what identifies them.
create table if not exists project_notes (
  id                  uuid primary key default gen_random_uuid(),
  airtable_record_id  text unique not null,

  project_id      uuid references projects(id) on delete cascade,
  deliverable_id  uuid references deliverables(id) on delete cascade,
  added_by_id     uuid references people(id) on delete set null,

  notes                 text,
  notes_include_info_on text[],
  docs_link_bluebeam_session text,

  snip_image_paths    text[],

  airtable_created_at timestamptz,
  is_active                   boolean not null default true,
  missing_from_airtable_since timestamptz,
  synced_at                   timestamptz not null default now()
);

create index if not exists project_notes_project_idx     on project_notes (project_id);
create index if not exists project_notes_deliverable_idx on project_notes (deliverable_id);
create index if not exists project_notes_tags_idx        on project_notes using gin (notes_include_info_on);


-- Time tracking.
--
-- `deliverable_id` is the important one and the inventory did not have it:
-- its column list offered only a project and a pursuit, though its own prose
-- said time links to a task. Time is billed per task and Pam's invoicing
-- depends on it, so the task link is here and indexed.
create table if not exists time_entries (
  id                  uuid primary key default gen_random_uuid(),
  airtable_record_id  text unique not null,

  person_id       uuid references people(id) on delete set null,
  deliverable_id  uuid references deliverables(id) on delete cascade,
  project_id      uuid references projects(id) on delete cascade,
  pursuit_id      uuid references pursuits(id) on delete cascade,

  entry_date      timestamptz,
  duration        numeric,
  notes           text,
  billable_status text,

  -- The business buckets. Only cost_planning_tags is still filled in
  -- practice; the rest are carried so history survives the move.
  admin_tags              text,
  billing_tags            text,
  cost_planning_tags      text,
  education_training_tags text,
  innovation_tags         text,
  management_tags         text,
  marketing_tags          text,
  out_of_office_tags      text,

  airtable_created_at timestamptz,
  airtable_revised_at timestamptz,
  is_active                   boolean not null default true,
  missing_from_airtable_since timestamptz,
  synced_at                   timestamptz not null default now()
);

create index if not exists time_entries_deliverable_idx on time_entries (deliverable_id);
create index if not exists time_entries_person_idx      on time_entries (person_id);
create index if not exists time_entries_project_idx     on time_entries (project_id);
create index if not exists time_entries_pursuit_idx     on time_entries (pursuit_id);
create index if not exists time_entries_date_idx        on time_entries (entry_date);


-- The status-change timeline. Written by Airtable automations today; it will
-- need database triggers here, which is a later migration's job — this one
-- only makes somewhere for the history to land.
create table if not exists activity_log (
  id                  uuid primary key default gen_random_uuid(),
  airtable_record_id  text unique not null,

  deliverable_id  uuid references deliverables(id) on delete cascade,
  logged_by_id    uuid references people(id) on delete set null,
  action_owner_id uuid references people(id) on delete set null,

  activity_name     text,
  activity_summary  text,
  activity_type     text,
  date_logged       timestamptz,
  milestone_date    date,
  previous_value    text,
  new_value         text,
  source            text,
  visibility        text,
  action_required   boolean,
  action_due_date   date,
  workload_relevant boolean,
  pinned_to_project_detail boolean,

  attachments_paths text[],

  is_active                   boolean not null default true,
  missing_from_airtable_since timestamptz,
  synced_at                   timestamptz not null default now()
);

create index if not exists activity_log_deliverable_idx on activity_log (deliverable_id);
create index if not exists activity_log_logged_idx      on activity_log (date_logged);


-- Bid results against DCW's number.
create table if not exists bid_results (
  id                  uuid primary key default gen_random_uuid(),
  airtable_record_id  text unique not null,

  project_id  uuid references projects(id) on delete cascade,

  our_number                numeric(14,2),
  low_bid                   numeric(14,2),
  high_bid                  numeric(14,2),
  closest_bid_to_our_number numeric(14,2),
  -- The inventory called this `of_bids_recieved` and typed it text: the
  -- leading "#" of "# of Bids Received" was stripped by the generator and the
  -- spelling came along for the ride. It is a count.
  bids_received             integer,

  link_to_bid_report text,
  notes              text,
  date_added         timestamptz,
  attachment_paths   text[],

  is_active                   boolean not null default true,
  missing_from_airtable_since timestamptz,
  synced_at                   timestamptz not null default now()
);

create index if not exists bid_results_project_idx on bid_results (project_id);


-- Leave and absence.
create table if not exists out_of_office (
  id                  uuid primary key default gen_random_uuid(),
  airtable_record_id  text unique not null,

  person_id  uuid references people(id) on delete cascade,

  vacation_title text,
  category       text,
  approval       text,
  start_date     date,
  end_date       date,
  notes          text,

  attachments_paths text[],

  created_on          timestamptz,
  is_active                   boolean not null default true,
  missing_from_airtable_since timestamptz,
  synced_at                   timestamptz not null default now()
);

create index if not exists out_of_office_person_idx on out_of_office (person_id);
create index if not exists out_of_office_dates_idx  on out_of_office (start_date, end_date);


-- Subconsultant work against a deliverable.
--
-- The inventory keyed this to a project. The table is named for tasks, and
-- `subconsultant_invoices` keys to a task, so a project here was the wrong
-- grain — it would have made it impossible to say which deliverable a
-- subconsultant's work belonged to on a project with several.
create table if not exists subconsultant_tasks (
  id                  uuid primary key default gen_random_uuid(),
  airtable_record_id  text unique not null,

  deliverable_id   uuid references deliverables(id) on delete cascade,
  subconsultant_id uuid references subconsultants(id) on delete cascade,

  status text,
  notes  text,

  is_active                   boolean not null default true,
  missing_from_airtable_since timestamptz,
  synced_at                   timestamptz not null default now()
);

create index if not exists subconsultant_tasks_deliverable_idx on subconsultant_tasks (deliverable_id);
create index if not exists subconsultant_tasks_sub_idx         on subconsultant_tasks (subconsultant_id);


-- Subconsultant invoices.
create table if not exists subconsultant_invoices (
  id                  uuid primary key default gen_random_uuid(),
  airtable_record_id  text unique not null,

  subconsultant_id uuid references subconsultants(id) on delete cascade,
  deliverable_id   uuid references deliverables(id) on delete cascade,

  -- Text everywhere, for the same reason as deliverables.invoice.
  invoice       text,
  total         numeric(14,2),
  status        text,
  date_received date,
  date_paid     date,
  notes         text,

  invoice_paths              text[],
  payment_confirmation_paths text[],

  is_active                   boolean not null default true,
  missing_from_airtable_since timestamptz,
  synced_at                   timestamptz not null default now()
);

create index if not exists subconsultant_invoices_sub_idx on subconsultant_invoices (subconsultant_id);
create index if not exists subconsultant_invoices_deliverable_idx on subconsultant_invoices (deliverable_id);


-- ============================================================================
-- 6. The two genuine many-to-many links
--
-- Everything else the inventory typed as a link was one-to-many and now lives
-- as a single FK on the child. These two are real: a deliverable can involve
-- several subconsultants, and several DCW people can be assigned to it.
--
-- No `airtable_record_id` on either — an Airtable link is not a record, it is
-- an entry in a cell. The sync rebuilds these rows from the parent's link
-- field, which is why the primary key is the pair.
-- ============================================================================

create table if not exists deliverable_subconsultants (
  deliverable_id   uuid not null references deliverables(id) on delete cascade,
  subconsultant_id uuid not null references subconsultants(id) on delete cascade,
  synced_at        timestamptz not null default now(),
  primary key (deliverable_id, subconsultant_id)
);

create index if not exists deliverable_subconsultants_sub_idx
  on deliverable_subconsultants (subconsultant_id);

create table if not exists deliverable_assignees (
  deliverable_id uuid not null references deliverables(id) on delete cascade,
  person_id      uuid not null references people(id) on delete cascade,
  synced_at      timestamptz not null default now(),
  primary key (deliverable_id, person_id)
);

create index if not exists deliverable_assignees_person_idx
  on deliverable_assignees (person_id);


-- ============================================================================
-- 7. completed_at
--
-- Phase II is the completion signal, not Task Status. It is free text today
-- and it is a progression — documents received, then milestones, then
-- complete — so this reads the one terminal value rather than treating the
-- column as a flag.
--
-- Moving backwards clears the timestamp. A task that reopens is not complete,
-- and leaving a stale completed_at behind would quietly poison anything that
-- counts throughput or drives the cost library.
--
-- THE MATCHED STRING WAS CONFIRMED AGAINST THE BASE on 2026-09-29. Phase II is
-- a single select on `DCW Project Tasks`, and its terminal choice is exactly
-- "Complete". It is the only terminal value in the list — the others are
-- Docs Received (unassigned, then assigned), Special Projects, Report /
-- Takeoff Development, Quality Control, Draft Delivered, Needs Revision
-- (schedule TBD, then confirmed) and Pending Final Response — so there is no
-- second finished state for this to miss.
--
-- The revision states sit after Draft Delivered, so a task marked complete
-- that then needs a revision moves backwards through this field, which is
-- what clears the timestamp.
--
-- `completed_value` below remains the single place to change it if the choice
-- is ever renamed in Airtable; the comparison is lower(trim(...)) so casing
-- and stray spaces do not matter. After any such change, re-run this
-- migration and backfill with:
--
--   update deliverables set phase_ii_workflow = phase_ii_workflow;
--
-- which re-fires the trigger without changing any data.
-- ============================================================================

create or replace function set_deliverable_completed_at() returns trigger
  language plpgsql as $fn$
declare
  completed_value constant text := 'complete';
  is_complete     boolean;
begin
  is_complete := lower(trim(coalesce(new.phase_ii_workflow, ''))) = completed_value;

  if is_complete and new.completed_at is null then
    new.completed_at := now();
  elsif not is_complete then
    new.completed_at := null;
  end if;

  return new;
end;
$fn$;

comment on function set_deliverable_completed_at() is
  'Maintains deliverables.completed_at from phase_ii_workflow. See migration 006 section 7 — the matched value is a constant in the function body.';

drop trigger if exists trg_deliverables_completed_at on deliverables;
create trigger trg_deliverables_completed_at
  before insert or update of phase_ii_workflow on deliverables
  for each row execute function set_deliverable_completed_at();


-- ============================================================================
-- 8. Row-level security
--
-- Deny by default, like the rest of this schema. Any active user reads the
-- mirror; nobody writes it through the portal, because Airtable is the system
-- of record and the sync runs as the service role, which bypasses RLS.
--
-- `to authenticated` on every policy is deliberate and is the lesson of 004:
-- a policy created without a TO clause applies to every role, including
-- `cost_reader`, which would quietly widen what the reader can see.
-- ============================================================================

alter table people                     enable row level security;
alter table client_companies           enable row level security;
alter table subconsultants             enable row level security;
alter table contacts                   enable row level security;
alter table pursuits                   enable row level security;
alter table project_notes              enable row level security;
alter table time_entries               enable row level security;
alter table activity_log               enable row level security;
alter table bid_results                enable row level security;
alter table out_of_office              enable row level security;
alter table subconsultant_tasks        enable row level security;
alter table subconsultant_invoices     enable row level security;
alter table deliverable_subconsultants enable row level security;
alter table deliverable_assignees      enable row level security;

drop policy if exists people_read                     on people;
drop policy if exists client_companies_read           on client_companies;
drop policy if exists subconsultants_read             on subconsultants;
drop policy if exists contacts_read                   on contacts;
drop policy if exists pursuits_read                   on pursuits;
drop policy if exists project_notes_read              on project_notes;
drop policy if exists time_entries_read               on time_entries;
drop policy if exists activity_log_read               on activity_log;
drop policy if exists bid_results_read                on bid_results;
drop policy if exists out_of_office_read              on out_of_office;
drop policy if exists subconsultant_tasks_read        on subconsultant_tasks;
drop policy if exists subconsultant_invoices_read     on subconsultant_invoices;
drop policy if exists deliverable_subconsultants_read on deliverable_subconsultants;
drop policy if exists deliverable_assignees_read      on deliverable_assignees;

drop policy if exists people_read on people;
create policy people_read                     on people                     for select to authenticated using (is_active_user());
drop policy if exists client_companies_read on client_companies;
create policy client_companies_read           on client_companies           for select to authenticated using (is_active_user());
drop policy if exists subconsultants_read on subconsultants;
create policy subconsultants_read             on subconsultants             for select to authenticated using (is_active_user());
drop policy if exists contacts_read on contacts;
create policy contacts_read                   on contacts                   for select to authenticated using (is_active_user());
drop policy if exists pursuits_read on pursuits;
create policy pursuits_read                   on pursuits                   for select to authenticated using (is_active_user());
drop policy if exists project_notes_read on project_notes;
create policy project_notes_read              on project_notes              for select to authenticated using (is_active_user());
drop policy if exists time_entries_read on time_entries;
create policy time_entries_read               on time_entries               for select to authenticated using (is_active_user());
drop policy if exists activity_log_read on activity_log;
create policy activity_log_read               on activity_log               for select to authenticated using (is_active_user());
drop policy if exists bid_results_read on bid_results;
create policy bid_results_read                on bid_results                for select to authenticated using (is_active_user());
drop policy if exists out_of_office_read on out_of_office;
create policy out_of_office_read              on out_of_office              for select to authenticated using (is_active_user());
drop policy if exists subconsultant_tasks_read on subconsultant_tasks;
create policy subconsultant_tasks_read        on subconsultant_tasks        for select to authenticated using (is_active_user());
drop policy if exists subconsultant_invoices_read on subconsultant_invoices;
create policy subconsultant_invoices_read     on subconsultant_invoices     for select to authenticated using (is_active_user());
create policy deliverable_subconsultants_read on deliverable_subconsultants for select to authenticated using (is_active_user());
drop policy if exists deliverable_assignees_read on deliverable_assignees;
create policy deliverable_assignees_read      on deliverable_assignees      for select to authenticated using (is_active_user());

-- No INSERT, UPDATE or DELETE policy anywhere above, on purpose. Rule 1 of the
-- specification is that nothing is written back to Airtable, and the corollary
-- is that nothing writes the mirror except the sync.


-- ============================================================================
-- 9. Portal privileges
--
-- Supabase's default privileges grant `anon` and `authenticated` the full set
-- — SELECT, INSERT, UPDATE, DELETE — on every table created in `public`. That
-- was checked against this database rather than assumed. RLS is currently the
-- only thing standing between an anonymous request and these tables, so the
-- grants are narrowed to match what the policies already say.
--
-- Defence in depth: a policy added carelessly later cannot turn into a write
-- path if the privilege was never there.
-- ============================================================================

revoke all on people, client_companies, subconsultants, contacts, pursuits,
              project_notes, time_entries, activity_log, bid_results,
              out_of_office, subconsultant_tasks, subconsultant_invoices,
              deliverable_subconsultants, deliverable_assignees
  from anon;

revoke insert, update, delete, truncate, references, trigger on
              people, client_companies, subconsultants, contacts, pursuits,
              project_notes, time_entries, activity_log, bid_results,
              out_of_office, subconsultant_tasks, subconsultant_invoices,
              deliverable_subconsultants, deliverable_assignees
  from authenticated;

grant select on client_companies, subconsultants, contacts, pursuits,
                project_notes, time_entries, activity_log, bid_results,
                out_of_office, subconsultant_tasks, subconsultant_invoices,
                deliverable_subconsultants, deliverable_assignees
  to authenticated;

-- ----------------------------------------------------------------------------
-- people.hourly_profit_rate
--
-- A policy cannot hide a column — RLS filters rows — so this is a privilege,
-- and a column privilege only takes effect if the role does NOT hold a
-- table-level SELECT. Hence the revoke first, then every other column back by
-- name.
--
-- TWO CONSEQUENCES, both accepted deliberately:
--
--   1. Every column added to `people` later is invisible to the portal until
--      it is granted here. That is the maintenance cost of this mechanism.
--   2. `select *` on `people` as `authenticated` now ERRORS rather than
--      quietly omitting the column. PostgREST enumerates columns so ordinary
--      API reads are fine. The app was checked before this landed: nothing
--      reads `people` today, and the `select('*')` calls in
--      src/lib/intranet/data/supabase.ts are against `profiles` and
--      `wishlist_items`, which are different tables. Anything that starts
--      reading `people` must name its columns.
-- ----------------------------------------------------------------------------

revoke select on people from authenticated;

grant select (
  id, airtable_record_id, name, email, phone, title, status, group_name,
  color_code, birthday, dcw_start_date, dcw_end_date, image_paths,
  is_active, missing_from_airtable_since, synced_at
) on people to authenticated;

-- ----------------------------------------------------------------------------
-- …and how an admin reads it anyway
--
-- "Admins only" cannot be expressed as a column grant. Column privileges are
-- per database role, and every signed-in portal user — admin or not — reaches
-- Postgres as the same `authenticated` role. The grant above therefore hides
-- the column from admins too.
--
-- So the admin path is a view that runs as its owner and checks `is_admin()`
-- itself. Note `security_invoker = false`: this is the one place in this
-- schema that deliberately departs from the `security_invoker = true`
-- convention used by v_observations and v_question_answers, because running
-- as the invoker is exactly what we need NOT to do here. The `where` clause is
-- the entire enforcement, so it must not be removed.
--
-- A non-admin selecting from this view gets zero rows, not an error.
-- ----------------------------------------------------------------------------

create or replace view v_people_compensation with (security_invoker = false) as
  select p.id,
         p.airtable_record_id,
         p.name,
         p.email,
         p.status,
         p.hourly_profit_rate
    from people p
   where is_admin();

comment on view v_people_compensation is
  'Admin-only read path for people.hourly_profit_rate. SECURITY DEFINER by design (security_invoker = false) because a column grant cannot distinguish an admin from any other authenticated user. The is_admin() predicate is the enforcement. See migration 006 section 9.';

revoke all on v_people_compensation from anon;
grant select on v_people_compensation to authenticated;


-- ============================================================================
-- 10. cost_reader
--
-- 004 granted `select on deliverables` at table level. A table-level SELECT
-- covers every column added to the table afterwards, so §4 would have handed
-- the reader `hourly_rate`, `invoice`, `invoice_date`, `collections_status`,
-- `billing_notes` and the collection dates the moment it ran — without a line
-- of SQL naming any of them, and without anything in the reader changing.
--
-- So the grant becomes column-level, the same way 004 already handles UPDATE
-- on this table. The list below is exactly the 24 columns the reader could
-- read before this migration, plus one:
--
--   ready_for_cost_library   because it is the reader's gate. An estimator
--                            ticks it when a report should enter the cost
--                            library, which is precisely the question the
--                            reader needs answered to know what to ingest.
--                            If that turns out to belong on the sync's side
--                            instead, delete the line — nothing else changes.
--
-- Everything else added in §4 is withheld. Adding a column to `deliverables`
-- in future does NOT give it to the reader, which is the point.
-- ============================================================================

revoke select on deliverables from cost_reader;

grant select (
  id, airtable_record_id, project_id,
  type, phase, version, is_latest_version,
  issue_date, estimator,
  box_file_url, source_format, file_checksum,
  stated_total_cost, currency,
  status, upload_notes,
  synced_at, ingested_at,
  source, storage_path, original_filename,
  uploaded_by, uploaded_at, byte_size,
  ready_for_cost_library
) on deliverables to cost_reader;

-- `projects` is left at table level, so the columns added in §3 become
-- readable by the reader automatically. That is what "extend SELECT to the new
-- columns it can already reach" asks for, and the reader has a real use for
-- the project context.
--
-- Worth knowing what it now includes: contract_amount, estimated_cost_building
-- and estimated_cost_site. None is client-confidential in the way the task
-- billing columns are, but if that judgement is wrong the fix is the same
-- pattern as above — revoke, then grant the named columns.

-- The fourteen tables created in §2, §5 and §6 grant the reader nothing.
-- Supabase's default privileges cover `anon`, `authenticated`, `service_role`
-- and `postgres`; `cost_reader` is a custom role and is not in them, so it
-- picks up nothing by default. The verification block proves it rather than
-- trusting it.


-- ============================================================================
-- VERIFICATION
--
-- Uncomment and run as a second query. Every row should read exactly this:
--
--   mirror tables created        14
--   deliverables task columns    63
--   projects new columns         18
--   contacts one-company check   1
--   completed_at trigger         1
--   reader CAN read stated_total true
--   reader CAN read cost library true
--   reader CANNOT read hourly    true
--   reader CANNOT read invoice   true
--   reader CANNOT read collect.  true
--   reader CANNOT read task_stat true
--   reader KEEPS update(type)    true
--   reader KEEPS update(status)  true
--   reader CANNOT read people    true
--   reader CANNOT read time_ent  true
--   portal CAN read people.name  true
--   portal CANNOT read profit    true
--   admin view exists            1
--   anon CANNOT read people      true
--   portal CANNOT write mirror   true
--   reader relations             (the same 12 as after 004, and nothing more)
--
-- The last row is the one that matters most over time. 004 established the
-- list; this migration adds fourteen tables and must not add a thirteenth
-- relation to it. Compare the names, not the count — a count tells you that
-- something is wrong, a name tells you which.
--
-- Expected relations: confidence_rules, cost_indices, deliverables,
-- document_frames, estimator_notes, ingest_runs, line_items, projects,
-- reader_conventions, reader_questions, taxonomy, units.
-- ============================================================================
--
-- select 'mirror tables created' as item,
--        count(*)::text as value
--   from information_schema.tables
--  where table_schema = 'public'
--    and table_name in ('people','client_companies','subconsultants','contacts',
--                       'pursuits','project_notes','time_entries','activity_log',
--                       'bid_results','out_of_office','subconsultant_tasks',
--                       'subconsultant_invoices','deliverable_subconsultants',
--                       'deliverable_assignees')
-- union all
-- select 'deliverables task columns',
--        (select count(*)::text from information_schema.columns
--          where table_schema = 'public' and table_name = 'deliverables'
--            and column_name not in ('id','airtable_record_id','project_id','type',
--                 'phase','version','is_latest_version','issue_date','estimator',
--                 'box_file_url','source_format','file_checksum','stated_total_cost',
--                 'currency','status','upload_notes','synced_at','ingested_at',
--                 'source','storage_path','original_filename','uploaded_by',
--                 'uploaded_at','byte_size'))
-- union all
-- select 'projects new columns',
--        (select count(*)::text from information_schema.columns
--          where table_schema = 'public' and table_name = 'projects'
--            and column_name in ('client_id','client_contact_id','contract_amount',
--                 'estimated_cost_building','estimated_cost_site','fee_proposal',
--                 'invoice_due_by','nda','need_to_fix_for_the_resume_builder',
--                 'time_card_required','project_description',
--                 'project_descriptions_for_resume','project_owner',
--                 'scope_categories','project_image_paths','airtable_created_at',
--                 'is_active','missing_from_airtable_since'))
-- union all
-- select 'contacts one-company check',
--        (select count(*)::text from pg_constraint
--          where conname = 'contacts_one_company')
-- union all
-- select 'completed_at trigger',
--        (select count(*)::text from pg_trigger
--          where tgname = 'trg_deliverables_completed_at' and not tgisinternal)
-- union all
-- select 'reader CAN read stated_total',
--        has_column_privilege('cost_reader','public.deliverables',
--                             'stated_total_cost','SELECT')::text
-- union all
-- select 'reader CAN read cost library',
--        has_column_privilege('cost_reader','public.deliverables',
--                             'ready_for_cost_library','SELECT')::text
-- union all
-- select 'reader CANNOT read hourly',
--        (not has_column_privilege('cost_reader','public.deliverables',
--                                  'hourly_rate','SELECT'))::text
-- union all
-- select 'reader CANNOT read invoice',
--        (not has_column_privilege('cost_reader','public.deliverables',
--                                  'invoice','SELECT'))::text
-- union all
-- select 'reader CANNOT read collect.',
--        (not has_column_privilege('cost_reader','public.deliverables',
--                                  'collections_status','SELECT'))::text
-- union all
-- select 'reader CANNOT read task_stat',
--        (not has_column_privilege('cost_reader','public.deliverables',
--                                  'task_status','SELECT'))::text
-- union all
-- -- The revoke above removes SELECT only. Column-level UPDATE grants are
-- -- separate ACL entries, so 005b's `grant update (type)` and 004's write
-- -- grants must survive it. If either of these is false the reader has
-- -- quietly lost the ability to correct a document, which would not show up
-- -- as an error anywhere — it would just stop happening.
-- select 'reader KEEPS update(type)',
--        has_column_privilege('cost_reader','public.deliverables',
--                             'type','UPDATE')::text
-- union all
-- select 'reader KEEPS update(status)',
--        has_column_privilege('cost_reader','public.deliverables',
--                             'status','UPDATE')::text
-- union all
-- select 'reader CANNOT read people',
--        (not has_any_column_privilege('cost_reader','public.people','SELECT'))::text
-- union all
-- select 'reader CANNOT read time_ent',
--        (not has_any_column_privilege('cost_reader','public.time_entries','SELECT'))::text
-- union all
-- select 'portal CAN read people.name',
--        has_column_privilege('authenticated','public.people','name','SELECT')::text
-- union all
-- select 'portal CANNOT read profit',
--        (not has_column_privilege('authenticated','public.people',
--                                  'hourly_profit_rate','SELECT'))::text
-- union all
-- select 'admin view exists',
--        (select count(*)::text from pg_views
--          where schemaname = 'public' and viewname = 'v_people_compensation')
-- union all
-- select 'anon CANNOT read people',
--        (not has_any_column_privilege('anon','public.people','SELECT'))::text
-- union all
-- select 'portal CANNOT write mirror',
--        (not has_table_privilege('authenticated','public.time_entries','INSERT')
--     and not has_table_privilege('authenticated','public.people','UPDATE')
--     and not has_table_privilege('authenticated','public.contacts','DELETE'))::text
-- union all
-- select 'reader relations',
--        coalesce((select string_agg(c.relname, ', ' order by c.relname)
--                    from pg_class c join pg_namespace n on n.oid = c.relnamespace
--                   where n.nspname = 'public' and c.relkind in ('r','v','m')
--                     and (has_any_column_privilege('cost_reader', c.oid, 'SELECT')
--                       or has_any_column_privilege('cost_reader', c.oid, 'INSERT')
--                       or has_any_column_privilege('cost_reader', c.oid, 'UPDATE')
--                       or has_table_privilege('cost_reader', c.oid, 'DELETE'))), 'none');
--
-- ============================================================================


-- ============================================================================
-- AFTER RUNNING THIS
--
-- 1. RUN THE VERIFICATION BLOCK. The three rows to read first are
--    "reader CANNOT read hourly", "portal CANNOT read profit" and
--    "reader relations". If any of them is wrong, stop: the point of this
--    migration was that adding 63 columns to `deliverables` must not widen
--    anything, and a false there means it did.
--
-- 2. PHASE II IS CONFIRMED, so there is nothing to do here — but know where
--    the assumption lives. §7 matches the literal 'complete', checked against
--    the base on 2026-09-29: Phase II is a single select on DCW Project Tasks
--    and "Complete" is its only terminal choice.
--
--    If that choice is ever renamed in Airtable, the sync will keep loading
--    the new text and completed_at will silently stop being set — no error,
--    just a column that stops filling. Change the constant in
--    set_deliverable_completed_at(), re-run this file, then:
--
--        update deliverables set phase_ii_workflow = phase_ii_workflow;
--
--    which re-fires the trigger over existing rows without changing data.
--
-- 3. REGENERATE schema.sql. It is already out of date — it does not show
--    `deliverables.source`, `storage_path`, `original_filename`, `uploaded_by`,
--    `uploaded_at`, `byte_size`, or `projects.created_by` and `created_at`,
--    all of which 002 and 003 added and all of which are live. Writing 006
--    against schema.sql alone would have collided with them. Dump the live
--    catalog into it so 007 starts from the truth.
--
-- 4. THE COUNT. The inventory said 313 columns; its tables actually describe
--    331. This migration creates neither number, and that is intended rather
--    than an error. What it actually creates, counted from this file:
--
--        224   columns across the 14 new tables
--         18   added to `projects`
--         63   added to `deliverables`
--        ---
--        305   total
--
--    The difference from 331 is the six deferred tables and the Dashboard
--    (roughly 41 columns), the 36 reversed to-many links replaced by two join
--    tables, the lookups and rollups the specification's own rule excludes,
--    the mangled and redundant columns (`company_contactsed_id`, two of the
--    three contact company links, the dead `billing_notes` text), and the
--    fields that map onto a column `projects` already has — offset by the
--    four bookkeeping columns every mirrored table now carries.
--
--    Do not treat 305 as a target either. Reconcile against the catalog:
--
--        select table_name, count(*)
--          from information_schema.columns
--         where table_schema = 'public'
--           and table_name in (…the fourteen…)
--         group by table_name order by table_name;
--
-- 5. THE SYNC IS NOT WRITTEN AND SHOULD NOT BE YET. Two things are still
--    guesses that only the sync can settle, and both are cheap now and
--    expensive after a load:
--      - `projects.invoice_due_by` is text because its values look like terms
--        rather than dates.
--      - `pursuits.airtable_created_at` and `pursuits.date_created` are
--        carried as two columns because Airtable has two fields that look
--        like the same fact.
--
-- 6. WHAT THIS MIGRATION DOES NOT DO. `people` and `profiles` are not linked;
--    a person exists here whether or not they ever sign in. `activity_log` has
--    somewhere to land but no triggers to write it — Airtable automations do
--    that today. Pursuit assignees were dropped with the other reversed links
--    and have no join table. Each is a later migration, deliberately.
-- ============================================================================
