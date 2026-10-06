/**
 * The field map. This file is the sync's configuration, not its logic.
 *
 * Phase two is meant to be an edit to this file and nothing else: eight more
 * `TableSpec` entries, no new code. That only stays true if everything here
 * stays declarative, so anything that cannot be said as data is called out
 * where it appears rather than quietly special-cased.
 *
 * PHASE ONE IS SIX TABLES, and that is not the same as "projects and
 * deliverables". Those two resolve foreign keys into client_companies,
 * contacts and people, and contacts resolves into subconsultants — so the
 * dependency tail comes with them. It is cheap: subconsultants and
 * client_companies are 486 rows between them. The six total about 9,630 of
 * the base's ~48,500, and leave out Time Tracking, which is 29,119 on its own.
 *
 * DELIBERATELY NOT HERE:
 *   - the 18 file fields. Separate phase; Airtable's attachment URLs expire in
 *     about two hours, so they have to be fetched in the run that read them.
 *   - lookups and rollups. The specification's own rule, and Postgres joins.
 *   - anything the inventory's notes retired.
 */
import type { Kind } from './coerce.ts';

/** Postgres table names, in the order they must load. */
export const LOAD_ORDER = [
  'people',
  'subconsultants',
  'client_companies',
  'contacts',
  'projects',
  'deliverables',
  // PHASE TWO BEGINS HERE, and these three are the rehearsal: 33 rows and
  // 69 Airtable fields across tables nothing yet depends on. They go first
  // precisely because they are cheap to get wrong.
  //
  // Order still matters. subconsultant_tasks links to deliverables and
  // subconsultants, both above it; subconsultant_invoices links to
  // subconsultant_tasks, so it must follow it.
  'subconsultant_tasks',
  'subconsultant_invoices',
  'bid_results',
] as const;

export type TableKey = (typeof LOAD_ORDER)[number];

export interface FieldSpec {
  /** Airtable field name, exactly as the base spells it. */
  from: string;
  /** Postgres column. */
  to: string;
  kind: Kind;
  /** For `link`: the mirror table whose airtable_record_id this resolves against. */
  linkTo?: TableKey;
  /**
   * For a single select whose value something downstream depends on. An
   * unrecognised value still loads, and raises an `unknown_choice` anomaly.
   */
  choices?: readonly string[];
  /**
   * always          write on insert and on every update (the default)
   * insert_only     write when the row is created, never again
   * if_null_or_equal  write only when the column is null or already agrees —
   *                 for a column the sync shares with something else
   */
  writeWhen?: 'always' | 'insert_only' | 'if_null_or_equal';
}

/**
 * A multi-valued Airtable link that becomes rows in a join table.
 *
 * THIS IS THE ONE NON-DECLARATIVE PIECE OF THE SYNC, and saying so keeps the
 * claim at the top of this file honest. A `FieldSpec` is read by generic code
 * that turns it into a column; a `JoinSpec` needs about forty lines in run.ts
 * that know what a join table is. That was the trade: one mechanism now, so
 * that phase two stays entries in this file rather than new code.
 *
 * Kept as a separate list from `fields` rather than a `kind: 'links'` entry.
 * Everything in `fields` maps to a column on this table; a join contributes
 * none, so folding it in would make `to` optional and push a "skip this one"
 * check into columnsFor, updatedColumns, buildUpsert and planRow. Two
 * concepts, two lists.
 *
 * Both column names are explicit rather than derived from the table name.
 * `deliverables → deliverable_id` and `projects → project_id` are one naive
 * singularisation apart, and the first table that does not follow the pattern
 * would break silently. Four tables is not enough to earn a rule.
 *
 * LINKS ARE ADDED AND NEVER REMOVED, and that is UNRESOLVED rather than
 * overlooked. If a subconsultant is unlinked from a task in Airtable, the row
 * here stays: the sync holds no DELETE on any table by design (007), and none
 * of the four join tables has an `is_active` to mark the link gone. Whether a
 * removed link is an error to flag — like a vanished project — or an ordinary
 * edit to follow is a real question that applies identically to all four, and
 * it is deliberately still open. Anyone finding the missing DELETE should read
 * this rather than assume it was forgotten.
 */
export interface JoinSpec {
  /** The multi-valued Airtable field on THIS table. */
  from: string;
  /** The join table rows are written into. */
  table: string;
  /** Column in the join table holding this table's id. */
  parentColumn: string;
  /** Column holding the linked record's id. */
  childColumn: string;
  /** Which mirror table `childColumn` resolves against. */
  linkTo: TableKey;
}

export interface TableSpec {
  key: TableKey;
  /** Airtable table name. */
  airtable: string;
  fields: readonly FieldSpec[];
  /** Multi-valued links that become rows elsewhere. See JoinSpec. */
  joins?: readonly JoinSpec[];
  /** Columns set to a constant when the row is created. */
  insertConstants?: Readonly<Record<string, string>>;
  /**
   * The column fed by the record's `createdTime`, which is NOT a field.
   *
   * Airtable returns createdTime as record metadata, beside `fields` rather
   * than inside it, so no `from` could ever name it. This is declared on the
   * table because there is nowhere else it could live, not because a special
   * case was easier.
   *
   * It replaces mapping the "Date Created" / "Added On" FIELDS, which are
   * createdTime columns formatted date-only. Those return "2024-09-10" for a
   * record created at 2024-09-10T21:28:29Z, so the field stored UTC midnight
   * and rendered in Pacific as the 9th — a day early, on every row, with
   * nothing in the data to reveal it. The metadata carries the real instant.
   *
   * Updatable rather than insert-only on purpose: a mirror already holding
   * the midnight values corrects itself on the next sync.
   */
  createdAtColumn?: string;
  /**
   * Added to the ON CONFLICT ... DO UPDATE, so the sync never updates a row it
   * does not own. Only the two tables it shares with the portal and the
   * reader need this.
   */
  restrictUpdateTo?: string;
}

/**
 * Phase II's terminal value. Confirmed against the base on 2026-09-29: it is a
 * single select on DCW Project Tasks whose only terminal choice is "Complete".
 * Migration 007's trigger matches the same word, and `completed_at` on insert
 * is derived from it (see derive.ts). If it is renamed in Airtable, the
 * `choices` guard below turns that into an anomaly instead of a silence.
 */
export const PHASE_II_COMPLETE = 'Complete';

const PHASE_II_CHOICES = [
  'Docs Received - UNASSIGNED',
  'Docs Received - Assigned',
  'Special Projects',
  'Report / Takeoff Development',
  'Quality Control',
  'Draft Delivered',
  'Needs Revision -  Schedule TBD',
  'Needs Revision - Schedule Confirmed',
  'Pending Final Response',
  PHASE_II_COMPLETE,
] as const;

export const TABLES: readonly TableSpec[] = [
  {
    key: 'people',
    airtable: 'Collaborators',
    fields: [
      { from: 'Name', to: 'name', kind: 'text' },
      { from: 'Email', to: 'email', kind: 'text' },
      { from: 'Phone', to: 'phone', kind: 'text' },
      { from: 'Title', to: 'title', kind: 'text' },
      { from: 'Status', to: 'status', kind: 'text' },
      { from: 'Group', to: 'group_name', kind: 'text[]' },
      { from: 'Color Code', to: 'color_code', kind: 'text' },
      { from: 'Birthday', to: 'birthday', kind: 'date' },
      { from: 'DCW Start Date', to: 'dcw_start_date', kind: 'date' },
      { from: 'DCW End Date', to: 'dcw_end_date', kind: 'date' },
      { from: 'Hourly Profit Rate', to: 'hourly_profit_rate', kind: 'numeric' },
    ],
  },

  {
    key: 'subconsultants',
    airtable: 'Subconsultants',
    createdAtColumn: 'airtable_created_at',
    fields: [
      { from: 'Company Name', to: 'company_name', kind: 'text' },
      { from: 'Client ID', to: 'client_code', kind: 'text' },
      { from: 'Type', to: 'type', kind: 'text[]' },
      { from: 'Website', to: 'website', kind: 'text' },
      { from: 'Address', to: 'address', kind: 'text' },
      { from: 'Company Billing Instructions', to: 'company_billing_instructions', kind: 'text' },
      { from: 'Fee Proposal Notes', to: 'fee_proposal_notes', kind: 'text' },
    ],
  },

  {
    key: 'client_companies',
    airtable: 'Client Company List',
    createdAtColumn: 'airtable_created_at',
    fields: [
      { from: 'Company Name', to: 'company_name', kind: 'text' },
      { from: 'Client ID', to: 'client_code', kind: 'text' },
      { from: 'Client Priority', to: 'client_priority', kind: 'text' },
      { from: 'Type', to: 'type', kind: 'text' },
      { from: 'Website', to: 'website', kind: 'text' },
      // Four, not one. DCW works with the WA and the OR office of the same
      // client on different projects; the inventory collapsed all four.
      { from: 'Address (WA)', to: 'address_wa', kind: 'text' },
      { from: 'Address (OR)', to: 'address_or', kind: 'text' },
      { from: 'Address (CA)', to: 'address_ca', kind: 'text' },
      { from: 'Address (Other)', to: 'address_other', kind: 'text' },
      { from: 'Company Billing Instructions', to: 'company_billing_instructions', kind: 'text' },
      { from: 'Fee Proposal Notes', to: 'fee_proposal_notes', kind: 'text' },
      { from: 'Client Lead', to: 'client_lead_id', kind: 'link', linkTo: 'people' },
      { from: 'Client Lead Backup', to: 'client_lead_backup_id', kind: 'link', linkTo: 'people' },
    ],
  },

  {
    key: 'contacts',
    airtable: 'Contacts',
    createdAtColumn: 'added_on',
    fields: [
      { from: 'Contact (First Last)', to: 'contact_name', kind: 'text' },
      { from: 'Contact Email', to: 'contact_email', kind: 'text' },
      { from: 'Contact Phone', to: 'contact_phone', kind: 'text' },
      { from: 'Contact Job Title', to: 'contact_job_title', kind: 'text' },
      { from: 'Company Department', to: 'company_department', kind: 'text[]' },
      { from: 'Primary Address', to: 'primary_address', kind: 'text' },
      { from: 'Accurate Info', to: 'accurate_info', kind: 'text' },
      { from: 'Send 10 Year Letter?', to: 'send_10_year_letter', kind: 'boolean' },
      // One company per contact, enforced by contacts_one_company. Two columns
      // because the company lives in one of two tables, not because a contact
      // can have two.
      { from: 'Company Link (Primary Key)', to: 'client_company_id', kind: 'link', linkTo: 'client_companies' },
      { from: 'Link to Subconsultant Company', to: 'subconsultant_id', kind: 'link', linkTo: 'subconsultants' },
    ],
  },

  {
    key: 'projects',
    airtable: 'New Project Entry',
    createdAtColumn: 'airtable_created_at',
    restrictUpdateTo: "projects.airtable_record_id is not null",
    // 287 of 1,643 projects name more than one client contact — 17%, the
    // highest multi-value rate in phase one. Migration 011.
    //
    // The client company join is 012's, and it is here rather than as a
    // `client_id` column because 30 projects name two companies. A scalar
    // column had to pick one of them, and the 30 were checked by hand: all
    // real, joint ventures and parent/subsidiary pairs, not data entry.
    joins: [
      { from: 'Client Contact (Linked)', table: 'project_client_contacts',
        parentColumn: 'project_id', childColumn: 'contact_id', linkTo: 'contacts' },
      { from: 'Link to Client Company (Add Here)', table: 'project_client_companies',
        parentColumn: 'project_id', childColumn: 'client_company_id', linkTo: 'client_companies' },
    ],
    fields: [
      { from: 'Project Title', to: 'name', kind: 'text' },
      // sector, market and city are all text[] as of 012. They were scalar
      // because the first measurement said 7% and 2% of projects carried a
      // second value, which sounded like noise worth absorbing — until the
      // dry run put a number on it: 116 projects would have lost a sector and
      // 37 a city, every one of them reported as an anomaly nobody could act
      // on, because the fix was a column type and not a data correction.
      { from: 'Primary Category', to: 'sector', kind: 'text[]' },
      // Secondary Category was never scalar: 66 of 100 sampled projects carry
      // two or more, often four to eight. It went to text[] in 009, which is
      // what made the other two look like the exception rather than the rule.
      { from: 'Secondary Category', to: 'market', kind: 'text[]' },
      { from: 'Location (City, State)', to: 'city', kind: 'text[]' },
      { from: 'Delivery Method', to: 'delivery_method', kind: 'text' },
      // Construction Start Date is NOT MAPPED, and that is deliberate.
      //
      // Two reasons, and the second is the stronger one.
      //
      // FIRST, it is not a date. Airtable types it as a single select whose
      // choices are month buckets — "May-21", "Jun-21", one stray "Q1 2023" —
      // and it is populated on 3 of 1,877 projects.
      //
      // Airtable types it as a single select whose choices are month buckets —
      // "May-21", "Jun-21", … and one stray "Q1 2023". It is not a date and
      // never was. `construction_start` is a Postgres `date`, so writing this
      // into it would assert a precision the source does not have, and
      // new Date("May-21") yields a real-looking day that is simply wrong.
      // "2018" would land as 2018-01-01 and read later as the first of January.
      //
      // SECOND, and this is why it stays out rather than waiting for a column:
      // construction start is the ESCALATION TARGET — what a rate is escalated
      // TO. The reader already extracts it from the document with evidence and
      // confidence (Evergreen to April 2026, Oregon Zoo to Q1 2028, both read
      // from the workbook). That is squarely "what the estimate was priced
      // against", which is the document's side of the line, not Airtable's.
      //
      // Carrying a coarse month bucket populated three times would put a worse
      // source in competition with a better one. This is recorded here so that
      // whoever finds the gap in six months reads a decision rather than an
      // oversight.
      { from: 'Secured Project Status', to: 'project_status', kind: 'text' },
      { from: 'Contract Amount', to: 'contract_amount', kind: 'numeric' },
      { from: 'Estimated Cost - Building', to: 'estimated_cost_building', kind: 'numeric' },
      { from: 'Estimated Cost - Site', to: 'estimated_cost_site', kind: 'numeric' },
      { from: 'Fee Proposal # (Overall Project)', to: 'fee_proposal', kind: 'text' },
      { from: 'Invoice Due By', to: 'invoice_instructions', kind: 'text' },
      { from: 'NDA', to: 'nda', kind: 'boolean' },
      { from: 'Need to Fix for the Resume Builder', to: 'need_to_fix_for_the_resume_builder', kind: 'boolean' },
      { from: 'Time Card Required', to: 'time_card_required', kind: 'boolean' },
      { from: 'Project Description', to: 'project_description', kind: 'text' },
      { from: 'Project Descriptions for Resume', to: 'project_descriptions_for_resume', kind: 'text' },
      { from: 'Project Owner', to: 'project_owner', kind: 'text[]' },
      { from: 'Scope Categories', to: 'scope_categories', kind: 'text[]' },
    ],
    // gross_sf is NOT mapped from Airtable. It is the universal normaliser
    // (PLAN §5.3) and Airtable has a building area for only about 18% of
    // projects, so the reader's frame is its primary source. See derive.ts.
  },

  {
    key: 'deliverables',
    airtable: 'DCW Project Tasks',
    createdAtColumn: 'airtable_created_at',
    insertConstants: { source: 'airtable' },
    // Project Manager is multi-valued on 380 of 3,085 tasks (12%) and Project
    // Support likewise, so both are join tables rather than scalar columns —
    // a scalar would drop a person, silently, on one task in eight.
    // Migration 011.
    //
    // Subconsultants was never mapped at all: 006 dropped it as one of the 36
    // reversed links, and deliverable_subconsultants has sat empty since,
    // with nothing able to fill it. This is what fills it.
    joins: [
      { from: 'Project Manager *', table: 'deliverable_project_managers',
        parentColumn: 'deliverable_id', childColumn: 'person_id', linkTo: 'people' },
      { from: 'Project Support *', table: 'deliverable_project_support',
        parentColumn: 'deliverable_id', childColumn: 'person_id', linkTo: 'people' },
      // "Subconsultants" on DCW Project Tasks is NOT MAPPED, and the name is
      // the trap. It does not link to the Subconsultants table — it links to
      // SUBCONSULTANT TASKS (tblfus0PSLP8ASQDc), which is why its linked
      // records display as "1", "2", "3" rather than company names.
      //
      // It is the inverse of Subconsultant Tasks → Project, so it is a
      // reversed link: exactly the class 006 dropped 36 of, and one this map
      // reintroduced by trusting the field's name. The relationship it
      // describes is already modelled, as subconsultant_tasks.deliverable_id.
      //
      // The real chain is deliverable → subconsultant_tasks → subconsultant,
      // and subconsultant_tasks carries status and notes as well. See the
      // note on deliverable_subconsultants below.
    ],
    // The portal uploads documents into this table too. Those rows have a null
    // airtable_record_id and source 'upload', and the sync must never touch
    // them — nulls never conflict, so the unique index alone would not stop it.
    restrictUpdateTo: "deliverables.source = 'airtable' and deliverables.airtable_record_id is not null",
    fields: [
      { from: 'DCW Projects', to: 'project_id', kind: 'link', linkTo: 'projects' },
      { from: 'Task Name', to: 'task_name', kind: 'text' },
      { from: 'Project Task Title', to: 'project_task_title', kind: 'text' },
      { from: 'Task Number', to: 'task_number', kind: 'text[]' },
      { from: 'Task Status', to: 'task_status', kind: 'text' },
      { from: 'Task Type', to: 'task_type', kind: 'text[]' },

      { from: 'Phase I: Upcoming', to: 'phase_i_upcoming', kind: 'text' },
      { from: 'Phase II: On the Table (Workflow)', to: 'phase_ii_workflow', kind: 'text', choices: PHASE_II_CHOICES },
      { from: 'Phase III: Billing', to: 'phase_iii_billing', kind: 'text' },

      { from: 'Start Date', to: 'start_date', kind: 'date' },
      { from: 'Due Date', to: 'due_date', kind: 'date' },
      { from: 'Initial Draft Delivery', to: 'initial_draft_delivery', kind: 'date' },
      { from: 'Final Draft Delivery', to: 'final_draft_delivery', kind: 'date' },
      { from: 'Revision Delivery', to: 'revision_delivery', kind: 'date' },
      { from: 'Review Again On', to: 'review_again_on', kind: 'date' },
      { from: 'Schedule', to: 'schedule', kind: 'text' },
      { from: 'Schedule Notes', to: 'schedule_notes', kind: 'text' },

      { from: 'Next Action Owner', to: 'next_action_owner_id', kind: 'link', linkTo: 'people' },

      { from: 'Next Action', to: 'next_action', kind: 'text' },
      { from: 'Next Action Due Date', to: 'next_action_due_date', kind: 'date' },
      { from: 'Blocker / Risk Notes', to: 'blocker_risk_notes', kind: 'text' },
      { from: 'Check In for Cost Planners', to: 'check_in_for_cost_planners', kind: 'text' },
      { from: 'Meeting Update Notes', to: 'meeting_update_notes', kind: 'text' },
      { from: 'Support Needed', to: 'support_needed', kind: 'boolean' },
      { from: 'Support Request Notes', to: 'support_request_notes', kind: 'text' },
      { from: 'Tech Team Decision', to: 'tech_team_decision', kind: 'text' },
      { from: 'Tech Team Meeting Notes', to: 'tech_team_meeting_notes', kind: 'text' },
      { from: 'Waiting On', to: 'waiting_on', kind: 'text' },
      { from: 'Workload Heat', to: 'workload_heat', kind: 'text' },
      { from: 'Special Note', to: 'special_note', kind: 'text' },
      { from: 'Client Correspondence', to: 'client_correspondence', kind: 'text' },
      { from: 'Correspondence Note Link', to: 'correspondence_note_link', kind: 'text' },
      { from: 'Has Note Been Transfered?', to: 'has_note_been_transfered', kind: 'boolean' },

      { from: 'Billed Before Complete', to: 'billed_before_complete', kind: 'boolean' },
      { from: 'Collections Status', to: 'collections_status', kind: 'text' },
      { from: 'Hourly Rate', to: 'hourly_rate', kind: 'numeric' },
      // Text, not numeric. Airtable types it as a number today, but an invoice
      // reference is an identifier — a leading zero or an "R-" prefix would be
      // destroyed by a numeric column, and neither is recoverable afterwards.
      { from: 'Invoice #', to: 'invoice', kind: 'text' },
      { from: 'Invoice Date', to: 'invoice_date', kind: 'date' },
      { from: 'Next Collection Action Needed On', to: 'next_collection_action_needed_on', kind: 'date' },
      { from: 'Send Timesheets By', to: 'send_timesheets_by', kind: 'date' },
      { from: 'Time Card Complete', to: 'time_card_complete', kind: 'boolean' },
      { from: 'Task Hours', to: 'task_hours', kind: 'numeric' },
      { from: 'Fee Proposal # (TBD)', to: 'fee_proposal', kind: 'text' },
      { from: 'Fee Proposal Link', to: 'fee_proposal_link', kind: 'text' },

      // Project scope as at THIS phase. These also exist on the project, and
      // that is the point: they move between SD and DD, and holding them per
      // deliverable is what makes the movement visible.
      { from: '*Budget', to: 'budget', kind: 'numeric' },
      { from: '*Building SF', to: 'building_sf', kind: 'numeric' },
      { from: '*Sitework SF', to: 'sitework_sf', kind: 'numeric' },
      // *Construction Start Date and *Construction Completion Date are NOT
      // MAPPED, for the same reason as their project-level twins: both are
      // single selects of buckets, not dates. Start is "May-21" style months;
      // Completion is bare YEARS — "2018", "2019", "2020", "2021", "2022".
      // A year in a `date` column becomes the first of January, which is a
      // fact nobody stated. See the note on projects.
      // Text, not date (migration 009). Airtable calls it a date; it is a
      // single select of bare years — 2018 to 2022 — on 857 of 5,552 tasks.
      // Real usage, so it is carried; "2018" in a date column would become
      // the first of January, which nobody stated.
      { from: '*Construction Completion Date', to: 'construction_completion', kind: 'text' },
      { from: '*Delivery Method', to: 'delivery_method', kind: 'text' },
      { from: '*New, Reno, Demo, Etc', to: 'new_reno_demo_etc', kind: 'text[]' },
      { from: '*Project Size', to: 'project_size', kind: 'text[]' },
      { from: '*Report Format', to: 'report_format', kind: 'text[]' },
      { from: '*Work Breakdown', to: 'work_breakdown', kind: 'text' },
      { from: '*DCW Estimated Project Cost', to: 'dcw_estimated_project_cost', kind: 'numeric' },
      { from: '*Project Folder Link', to: 'project_folder_link', kind: 'text' },

      { from: 'Last Modified Time', to: 'airtable_last_modified_at', kind: 'timestamptz' },
    ],
  },

  // ===========================================================================
  // STANDING RULE FOR THIS BASE: A LINK NAMED FOR A PROJECT USUALLY MEANS
  // TASK. Check what every link POINTS AT before mapping it. Three
  // instances, which makes it a convention rather than three accidents:
  //
  //   Subconsultant Tasks."Project"     -->  DCW Project Tasks
  //   Subconsultant Invoices."Task"     -->  Subconsultant Tasks
  //   Time Tracking."DCW Projects"      -->  DCW Project Tasks
  //
  // Two of those cost a migration. The name is actively misleading here,
  // not merely unreliable, and anyone reading "DCW Projects" on a child
  // table will assume projects — both of us did, until it was checked.
  //
  // THE ONE EXCEPTION, recorded so nobody has to look it up again:
  // Project Notes."DCW Projects" GENUINELY POINTS AT New Project Entry.
  // That table has two separate links, to a project and to a task, and
  // both are real. Checked 6 October 2026 against the live base.
  //
  // Why the convention exists is not knowable from the API — Airtable
  // exposes no rename or repoint history. What is observable is that
  // renaming link fields is routine here: the inverse of Time Tracking's
  // link is "Time Tracking Link" rather than the default "Time Tracking",
  // and Project Notes' inverse is "Billing Notes". Both sides carry names
  // somebody chose, so the names cannot be trusted in either direction.
  // ===========================================================================

  // ===========================================================================
  // PHASE TWO — the rehearsal. Three tables, 33 rows, 69 Airtable fields.
  //
  // Every link below was verified by checking WHAT IT POINTS AT, not what it
  // is called. That check found two of four link fields here are named for
  // something other than their target, and one was a genuine mismatch
  // requiring migration 016. It is the same check that caught
  // "Subconsultants" on DCW Project Tasks pointing at Subconsultant Tasks in
  // phase one.
  // ===========================================================================

  {
    key: 'subconsultant_tasks',
    airtable: 'Subconsultant Tasks',
    fields: [
      // "Project" LINKS TO DCW PROJECT TASKS, NOT TO PROJECTS. The field is
      // named for a project and points at a task — which is why the mirror
      // column is deliverable_id and why mapping this by its name would have
      // produced a project_id column that does not exist on this table.
      //
      // The lookups hanging off it confirm the target rather than relying on
      // the link alone: "Task Fee (from Project)" and
      // "Image (from Project Manager *) (from Project)" are both DCW Project
      // Tasks fields.
      { from: 'Project', to: 'deliverable_id', kind: 'link', linkTo: 'deliverables' },
      { from: 'Subconsultants', to: 'subconsultant_id', kind: 'link', linkTo: 'subconsultants' },
      // Four choices, written down while they are visible. unknown_choice
      // only fires against a list, and a renamed option in Airtable is a
      // two-second edit with no visible consequence there.
      {
        from: 'Status',
        to: 'status',
        kind: 'text',
        choices: [
          'Initial Reach Out Required',
          'Sent Fee Proposal',
          'Confirmed Involvement',
          'Complete',
        ],
      },
      { from: 'Notes', to: 'notes', kind: 'text' },
    ],
  },

  {
    key: 'subconsultant_invoices',
    airtable: 'Subconsultant Invoices',
    fields: [
      // "Task" LINKS TO SUBCONSULTANT TASKS, not to DCW Project Tasks. The
      // mirror had deliverable_id waiting for it, which referenced the wrong
      // table entirely; migration 016 adds subconsultant_task_id and drops
      // deliverable_id rather than deriving a link the source never asserts.
      { from: 'Task', to: 'subconsultant_task_id', kind: 'link', linkTo: 'subconsultant_tasks' },
      { from: 'Subconsultant', to: 'subconsultant_id', kind: 'link', linkTo: 'subconsultants' },
      { from: 'Invoice #', to: 'invoice', kind: 'text' },
      { from: 'Total', to: 'total', kind: 'numeric' },
      {
        from: 'Status',
        to: 'status',
        kind: 'text',
        choices: ['Received', 'Waiting Confirmation', 'Paid'],
      },
      { from: 'Date Received', to: 'date_received', kind: 'date' },
      { from: 'Date Paid', to: 'date_paid', kind: 'date' },
      { from: 'Notes', to: 'notes', kind: 'text' },
      // invoice_paths and payment_confirmation_paths are attachment columns.
      // NOT MAPPED, deliberately: Airtable attachment URLs expire after about
      // two hours, so storing one is storing a link that is dead by the time
      // anybody clicks it. Attachments need downloading into the
      // airtable-mirror bucket, which is its own piece of work.
    ],
  },

  {
    key: 'bid_results',
    airtable: 'Bid Results',
    fields: [
      // "Link to Project" does point at New Project Entry. Checked rather
      // than assumed, which is the only reason that sentence is worth
      // writing.
      { from: 'Link to Project', to: 'project_id', kind: 'link', linkTo: 'projects' },
      { from: 'Our Number', to: 'our_number', kind: 'numeric' },
      { from: 'Low Bid (Excluding Outliers)', to: 'low_bid', kind: 'numeric' },
      { from: 'High Bid (Excluding Outliers)', to: 'high_bid', kind: 'numeric' },
      { from: 'Closest Bid To Our Number', to: 'closest_bid_to_our_number', kind: 'numeric' },
      // TEXT, not integer, and migration 016 changes the column to match.
      // The Airtable field is a singleSelect whose choices are 1-9 and
      // "10 or more". Against an integer that last value either fails to
      // coerce or silently becomes 10 — and 10 is a plausible bid count that
      // nobody would question, which makes the silent version the worse one.
      {
        from: '# of Bids Recieved',
        to: 'bids_received',
        kind: 'text',
        choices: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10 or more'],
      },
      { from: 'Link to Bid Report', to: 'link_to_bid_report', kind: 'text' },
      { from: 'Notes', to: 'notes', kind: 'text' },
      // attachment_paths: same attachment problem as the invoices above.
    ],
    // "Date Added" is a createdTime field, so it comes from record metadata
    // rather than from `fields` — see TableSpec.createdAtColumn.
    createdAtColumn: 'date_added',
  },

];

export function spec(key: TableKey): TableSpec {
  const found = TABLES.find((t) => t.key === key);
  if (!found) throw new Error(`no table spec for ${key}`);
  return found;
}

/**
 * Records the sync cannot write, and what skipping each one costs.
 *
 * A record is skipped when a column the database requires would be null —
 * see requiredColumns() in run.ts. Most skips need no explanation: a blank
 * row in Airtable whose every field is a formula or a zero rollup is a shell
 * somebody created and abandoned, and the anomaly saying "company_name would
 * be null" is the whole story.
 *
 * This map is for the ones where it is NOT the whole story, because the
 * record is deliberate and skipping it DEFERS a problem rather than avoiding
 * one. The note is appended to the anomaly so the consequence is recorded
 * where it will be read, at the moment it is caused, rather than rediscovered
 * later as a symptom.
 */
export const KNOWN_SKIPS: Readonly<Record<string, string>> = {
  recXCLgbkVXQtgUlk:
    'This is the NON-BILLABLE BUCKET, not an abandoned row. Task Name "Non-billable", ' +
    'Project Task Title "Non-project Work", created March 2021, carrying 19,566 logged ' +
    'hours. It has no project link BY DESIGN, because it is not project work — and ' +
    'deliverables.project_id is NOT NULL, so the mirror cannot hold it. ' +
    'THE CONSEQUENCE IS DEFERRED, NOT AVOIDED: phase one does not sync time_entries, so ' +
    'nothing is lost today. When time tracking is synced, every entry pointing at this ' +
    'record will fail to resolve — 19,566 hours of them — and the decision made here is ' +
    'what they will be symptoms of. ' +
    'THE FIX AT THAT POINT IS TO MAKE deliverables.project_id NULLABLE, not to invent a ' +
    '"Non-project Work" project to hang it from. A deliverable genuinely can exist ' +
    'without a project; that is the true shape. Creating a row that does not exist to ' +
    'satisfy a constraint would make the data lie about itself.',
};
