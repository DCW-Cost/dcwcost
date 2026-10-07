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
  // Links only to people, which is first, so anywhere after that is safe.
  'out_of_office',
  // Links to projects AND deliverables (via the join), both above it.
  'project_notes',
  // Three joins, to client_companies, contacts and people — all above it.
  'pursuits',
  // Links to deliverables and people, both above it. No joins.
  'activity_log',
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
  // SECOND STANDING RULE: COUNT EVERY LINK ACROSS THE FULL POPULATION BEFORE
  // IT BECOMES A SCALAR COLUMN. Not a sample, and NOT the schema flag.
  //
  // prefersSingleRecordLink IS A UI PREFERENCE, NOT A CONSTRAINT. It changes
  // how the Airtable editor behaves. It does not stop anybody putting several
  // in, and the field's type stays multipleRecordLinks either way:
  //
  //   Activity Log."DCW Project Task"   prefersSingleRecordLink: TRUE
  //   records holding more than one:    32
  //
  // THE FIRST VERSION OF THIS RULE SAID "take cardinality from the schema,
  // never from a sample", and told you to count only the links marked false.
  // That was half right and the wrong half was load-bearing: it implied TRUE
  // meant settled. 021 had to add a join table because of it. The flag is
  // evidence of nothing in either direction.
  //
  // BOTH HALVES OF THE MISTAKE ARE WORTH KEEPING, because they are different:
  //
  //   SAMPLES MISS RARE-BUT-STRUCTURAL CASES. Six of out_of_office's 843
  //   records are group events carrying two or three people; a 100-row sample
  //   found none, which was the EXPECTED result rather than bad luck. No
  //   sample size anyone would reach for finds a 0.7% case reliably.
  //
  //   THE SCHEMA FLAG IS NOT A SUBSTITUTE. It looked like the answer to the
  //   sampling problem — cheap, authoritative, available before any data.
  //   It is simply not true.
  //
  // So: one query, counting the whole table, per link, every time. It is
  // cheap at any size and it is the only thing that settles the question.
  //
  // SCALAR COLUMNS THAT SURVIVED THAT COUNT, with the date, because "safe by
  // measurement" expires in a way "safe by schema" would not have:
  //
  //   activity_log.action_owner_id    0 multiples   2026-10-07
  //   activity_log.logged_by_id       0 multiples   2026-10-07
  //   project_notes.project_id        0 multiples   2026-10-07
  //   project_notes.added_by_id       0 multiples   2026-10-07
  //   time_entries.pursuit_id         0 of 29,199   2026-10-07
  //
  // If any of them gains a second value the sync keeps the first and raises
  // coercion_failed, which is how both out_of_office and this were found. The
  // detector works; it just reports after the fact rather than before.
  //
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

  // ===========================================================================
  // out_of_office — 843 rows, 18 Airtable fields, ONE link.
  //
  // Chosen as the first table after the rehearsal because it is the only one
  // of the five remaining whose only link is to people. project_notes has one
  // person link tangled with two project/task links; activity_log has two
  // person links plus a task link. Here a people-side resolution failure
  // arrives alone, on 843 rows rather than time_entries' 29,119.
  //
  // THE LINK, CHECKED RATHER THAN ASSUMED: "Collaborators" --> Collaborators,
  // which is the table people mirrors. Name and target agree, which is worth
  // stating only because on three other tables in this base they do not.
  // ===========================================================================

  {
    key: 'out_of_office',
    airtable: 'DCW Out of Office',
    // A JOIN, NOT A COLUMN — and the 843-row load is why.
    //
    // This was person_id, a single uuid, until the first run over the whole
    // table raised six "kept the first" anomalies. Six records are group
    // events (site visits, a summit, a conference), and five of the six are
    // category "In Person Client Meeting/Event", so it is a shape rather than
    // six accidents.
    //
    // A SAMPLE OF 100 SAID ZERO. The population of 843 has six. That is the
    // reason this is written down: the remaining tables are 3,479, 3,569,
    // 3,475 and 29,119 rows, and "I sampled 100 and saw none" is a claim
    // about 100 records.
    //
    // It matters more than 0.7% sounds because this feeds a calendar of who
    // is out. "TD out on the 21st" when three people were away is the error
    // somebody acts on — and the title still reads "TD + BB + TA", so the
    // screen looks right while the query behind it is wrong.
    //
    // person_id was DROPPED rather than kept as "first attendee": two sources
    // for one fact means every calendar query has to know which to trust.
    // Same reasoning as time_entries.project_id in 017.
    joins: [
      { from: 'Collaborators', table: 'out_of_office_people',
        parentColumn: 'out_of_office_id', childColumn: 'person_id', linkTo: 'people' },
    ],
    fields: [
      { from: 'Vacation Title', to: 'vacation_title', kind: 'text' },
      // THE TRAILING SPACE ON THE SIXTH CHOICE IS DELIBERATELY NOT COPIED.
      //
      // Airtable's option is literally "In Person Client Meeting/Event " with
      // a trailing space. unknownChoice trims the INCOMING value and compares
      // it against this list UNTRIMMED (coerce.ts: `k.toLowerCase() ===
      // t.toLowerCase()`), so a verbatim copy would never match and every
      // record using that category would raise a false unknown_choice.
      //
      // Trimmed is also what gets stored: coerce('text') writes name.trim().
      // So the list, the comparison and the column all agree on the trimmed
      // form, and the only thing with a trailing space is Airtable.
      {
        from: 'Category',
        to: 'category',
        kind: 'text',
        choices: [
          'Teammate OOO',
          'Appointment',
          'Working Remote',
          'Sick Day',
          'Teammate OOO - Half Day',
          'In Person Client Meeting/Event',
          'Volunteer',
          'Classes / Education',
          'Information',
          'Birthday',
          'Holiday Observance',
          'DCW Team Event',
          'Employee Work Anniversary',
          'Maternity/Paternity Leave',
          'Bereavement',
        ],
      },
      {
        from: 'Approval',
        to: 'approval',
        kind: 'text',
        choices: ['Waiting for Approval', 'Approved', 'Not Approved'],
      },
      { from: 'Start Date', to: 'start_date', kind: 'date' },
      { from: 'End Date', to: 'end_date', kind: 'date' },
      { from: 'Notes', to: 'notes', kind: 'text' },
      // attachments_paths: NOT MAPPED, same reason as the invoices and bid
      // results. Airtable attachment URLs expire after about two hours, so
      // mirroring one stores a link that is dead before anybody clicks it.
      //
      // NINE MORE FIELDS ARE UNMAPPED AND ALL OF THEM ARE DERIVED: "Softr
      // Title", "Start & End Date" and "Total Days" are formulas over columns
      // mirrored here; "Image", "Color Code", "Email", "Email (from
      // Collaborators) 2" and "Status" are lookups through the Collaborators
      // link, so they are reachable through person_id; "Created By" is an
      // Airtable user, not a Collaborators record, and has no column.
      //
      // That is 18 fields: 7 mapped, 1 createdTime below, 1 attachment, 9
      // derived.
    ],
    // "Created On" is a createdTime field, so it comes from record metadata
    // rather than from `fields` — see TableSpec.createdAtColumn.
    createdAtColumn: 'created_on',
  },

  // ===========================================================================
  // project_notes — 3,520 rows, 24 Airtable fields, three links.
  //
  // THE TABLE THAT BREAKS THE STANDING RULE, and deliberately so. Its "DCW
  // Projects" field GENUINELY POINTS AT New Project Entry, unlike the
  // identically named field on Time Tracking, which points at DCW Project
  // Tasks. Same spelling, same base, two different targets — which is why the
  // rule has to stay "check the target every time" rather than "this name
  // means task".
  //
  // So this table carries ONE SCALAR LINK AND ONE JOIN LINK, which reads as
  // inconsistent and is correct:
  //
  //   "DCW Projects"       single    -->  project_id          (projects)
  //   "DCW Project Tasks"  MULTIPLE  -->  project_note_deliverables (join)
  //   "Added  By"          single    -->  added_by_id         (people)
  //
  // Counted across the full population before deciding, per the cardinality
  // rule above: 361 of 3,520 notes attach to more than one task (10%), so a
  // scalar deliverable_id would drop the rest. 019 created the join and
  // dropped that column.
  // ===========================================================================

  {
    key: 'project_notes',
    airtable: 'Project Notes',
    joins: [
      { from: 'DCW Project Tasks', table: 'project_note_deliverables',
        parentColumn: 'project_note_id', childColumn: 'deliverable_id', linkTo: 'deliverables' },
    ],
    fields: [
      { from: 'DCW Projects', to: 'project_id', kind: 'link', linkTo: 'projects' },
      // THE DOUBLE SPACE IN "Added  By" IS REAL AND MUST BE PRESERVED. It is
      // the field's actual name in Airtable; a single space matches nothing
      // and the column would silently stay null on all 3,520 rows. The
      // lookup "Image (from Added  By)" carries it too.
      { from: 'Added  By', to: 'added_by_id', kind: 'link', linkTo: 'people' },
      { from: 'Notes', to: 'notes', kind: 'text' },
      // FIRST MULTI-SELECT IN THE MIRROR TO CARRY A CHOICES LIST, and it only
      // became possible today. unknownChoice used to check value[0] alone, so
      // a list on a multi-select would have read as guarding 13 options while
      // checking one — which is why none of the thirteen text[] fields in this
      // file has ever had one. It now checks every position.
      //
      // These labels are exactly the kind somebody tidies: "Billing
      // Instructions / Request", "Cost Report Directives", "Pursuit Notes".
      // Verified against the live base 2026-10-07, no trailing spaces.
      {
        from: 'Notes Include Info On:',
        to: 'notes_include_info_on',
        kind: 'text[]',
        choices: [
          'Billing Instructions / Request',
          'Billing Question',
          'Collections',
          'Cost Report Directives',
          'Quote',
          'Document Link/Bluebeam Link',
          'Schedule',
          'Meeting Notes',
          'Project Budget',
          'Revisions',
          'Miscellaneous Project Info / Correspondence',
          'Pursuit Notes',
          'Alternatives',
        ],
      },
      { from: 'Docs Link/Bluebeam Session', to: 'docs_link_bluebeam_session', kind: 'text' },
      // snip_image_paths: NOT MAPPED. Airtable attachment URLs expire after
      // about two hours, so mirroring one stores a dead link.
      //
      // SIXTEEN MORE FIELDS ARE UNMAPPED AND ALL ARE DERIVED: 11 lookups
      // (client company, project image, task status, due date and the rest —
      // all reachable through project_id or the join), 3 formulas (Title,
      // Record ID, AI Cost Database Summary), 1 aiText (Project Notes
      // Summary) and 1 createdBy, which is an Airtable user rather than a
      // Collaborators record and has no column.
      //
      // 24 fields: 5 mapped, 1 createdTime below, 1 join, 1 attachment, 16
      // derived.
    ],
    // "Date Created" is a createdTime field — record metadata, not a field.
    // NOTE THE COLUMN NAME: airtable_created_at here, not created_on as on
    // out_of_office. Checked rather than copied.
    createdAtColumn: 'airtable_created_at',
  },

  // ===========================================================================
  // pursuits — 3,491 rows, 52 Airtable fields, three joins, no link columns.
  //
  // 019 moved every link to a join table and dropped client_company_id and
  // client_contact_id, so there is no scalar-vs-join decision left here. The
  // targets, checked against the live base rather than taken from the names:
  //
  //   "Client Company"        -->  Client Company List   -->  client_companies
  //   "Client Contact (Link)" -->  Contacts              -->  contacts
  //   "Assignees"             -->  Collaborators         -->  people
  //   "Time Tracking"         -->  Time Tracking         -->  IGNORED, it is
  //                                the reverse side of time_entries.pursuit_id
  //
  // ===========================================================================
  // STANDING RULE, FIRST APPLIED HERE: GUARD CLOSED VOCABULARIES, NOT OPEN ONES
  //
  // unknownChoice CANNOT TELL A RENAMED OPTION FROM A NEWLY ADDED ONE. Both
  // arrive as a value it does not recognise. On a list that grows by design,
  // every addition is therefore a false alarm — and an anomaly that fires for
  // normal events teaches people to ignore the anomaly table, which costs more
  // than the detector is worth.
  //
  // So a choices list goes on vocabularies that are CLOSED BY DESIGN, where a
  // rename silently breaks something downstream and nothing else would notice.
  // Six of this table's twelve select fields qualify; the other six do not:
  //
  //   GUARDED       Status (11), Submitting As (2), Ready to Start (4),
  //                 Select preferred meeting type (3), Request the Following
  //                 (4), Project Type (7). 31 options in total.
  //
  //   NOT GUARDED   Prime Proposal Components (18) — borderline, called open.
  //                 Unique Rates (24) — one per client rate schedule.
  //                 Materials Provided (77) — grows with staff; it contains
  //                 "Andrew's Resume", "Charu's resume" and a bare "katy",
  //                 which is what a hand-maintained open list looks like.
  //                 Project Category (170) — building-type taxonomy.
  //                 Year (6) and Month-Year (72) — see below.
  //
  // ON Year AND Month-Year: their options STOP AT 2023, and it is 2026. They
  // are not growing lists, they are abandoned ones — either nobody fills them
  // in any more, or pursuits since 2023 leave them blank. Worth checking the
  // fill rate after the first load: if they ARE still used, somebody logging a
  // 2026 pursuit has no valid option to pick, which is a different and worse
  // problem than a stale list.
  //
  // ===========================================================================
  // TWO createdTime FIELDS, BOTH CORRECTLY SKIPPED
  //
  // "Date Created" and "Created" are both createdTime and both return the same
  // instant. Neither is mapped: createdAtColumn reads the record's metadata,
  // which is the only source carrying the real time rather than a date-only
  // rendering. Two fields that look like the obvious source for
  // airtable_created_at are therefore both absent from the map on purpose.
  // ===========================================================================

  {
    key: 'pursuits',
    airtable: 'DCW Project Pursuits',
    joins: [
      { from: 'Client Company', table: 'pursuit_client_companies',
        parentColumn: 'pursuit_id', childColumn: 'client_company_id', linkTo: 'client_companies' },
      { from: 'Client Contact (Link)', table: 'pursuit_client_contacts',
        parentColumn: 'pursuit_id', childColumn: 'contact_id', linkTo: 'contacts' },
      { from: 'Assignees', table: 'pursuit_assignees',
        parentColumn: 'pursuit_id', childColumn: 'person_id', linkTo: 'people' },
    ],
    fields: [
      { from: 'Title', to: 'title', kind: 'text' },
      {
        from: 'Status',
        to: 'status',
        kind: 'text',
        choices: [
          'RFQs To-Do',
          'Fee To-Do',
          'Unconfirmed',
          'Confirmed Win',
          'Confirmed Loss',
          'Win With Other Team',
          'Client Did Not Pursue',
          'DCW Did Not Pursue',
          'Lack of Response - Went W/ Other Team',
          'Cancelled',
          'On Hold',
        ],
      },
      { from: 'Project Pursuit Number', to: 'project_pursuit_number', kind: 'text' },
      { from: 'Fee Proposal #', to: 'fee_proposal', kind: 'text' },
      { from: 'Box Link', to: 'box_link', kind: 'text' },
      { from: 'Notes', to: 'notes', kind: 'text' },
      { from: 'Tailored Language Needed', to: 'tailored_language_needed', kind: 'text' },
      { from: 'Due Date', to: 'due_date', kind: 'date' },
      { from: 'Confirmed Win On', to: 'confirmed_win_on', kind: 'date' },
      { from: 'Date Fee Proposal / Rates Provided', to: 'date_fee_proposal_rates_provided', kind: 'date' },
      { from: 'Date Marketing Materials Provided', to: 'date_marketing_materials_provided', kind: 'date' },
      { from: 'Preferred Meeting Date & Time', to: 'preferred_meeting_date_and_time', kind: 'timestamptz' },
      {
        from: 'Ready to Start',
        to: 'ready_to_start',
        kind: 'text',
        choices: ['Waiting on Information', 'Ready to Start', 'In Progress', 'Ready for Approval'],
      },
      {
        from: 'Submitting As',
        to: 'submitting_as',
        kind: 'text',
        choices: ['Subconsultant', 'Prime Consultant'],
      },
      {
        from: 'Select preferred meeting type',
        to: 'select_preferred_meeting_type',
        kind: 'text[]',
        choices: ['Virtual Video Call', 'In-person', 'Phone call'],
      },
      {
        from: 'Request the Following',
        to: 'request_the_following',
        kind: 'text[]',
        choices: [
          'Resume (with project list)',
          'Firm Profile (includes all certifications)',
          'Project Examples (with pictures and descriptions)',
          'Headshot and logo as separate JPEG',
        ],
      },
      {
        from: 'Project Type',
        to: 'project_type',
        kind: 'text[]',
        choices: [
          'Addition / Expansion',
          'Demolition',
          'Improvements / Upgrades',
          'New Construction',
          'Renovation / Remodel',
          'Repair / Replace',
          'Sitework / Rework',
        ],
      },
      // DELIBERATELY UNGUARDED — open vocabularies, see the rule above.
      { from: 'Prime Proposal Components', to: 'prime_proposal_components', kind: 'text[]' },
      { from: 'Unique Rates', to: 'unique_rates', kind: 'text[]' },
      { from: 'Materials Provided', to: 'materials_provided', kind: 'text[]' },
      { from: 'Project Category', to: 'project_category', kind: 'text[]' },
      { from: 'Year Pursuit was Requested', to: 'year_pursuit_was_requested', kind: 'text' },
      { from: 'Month-Year Pursuit was Requested', to: 'month_year_pursuit_was_requested', kind: 'text' },
      { from: 'Your Name', to: 'your_name', kind: 'text' },
      { from: 'Your Email', to: 'your_email', kind: 'text' },
      { from: 'Your Company', to: 'your_company', kind: 'text' },
      { from: 'Your Phone Number', to: 'your_phone_number', kind: 'text' },
      // THREE ATTACHMENT COLUMNS ARE UNMAPPED, same reason as everywhere else:
      // Airtable attachment URLs expire after about two hours.
      //   final_proposal_paths          <- "Final Proposal (PDF)"
      //   key_indesign_components_paths <- "Key InDesign Components"
      //   upload_files_paths            <- "Upload Files"
      //
      // "Client Company List copy" is a plain text field with no column and no
      // evident purpose. Left unmapped and flagged rather than guessed at.
      //
      // 52 fields: 27 mapped, 1 createdTime below, 3 joins, 3 attachments,
      // 1 orphan, 17 derived (6 formulas, 9 lookups, 2 createdTime fields).
    ],
    createdAtColumn: 'airtable_created_at',
  },

  // ===========================================================================
  // activity_log — 4,443 rows and climbing, 26 Airtable fields, no joins.
  //
  // A CHANGE LOG WRITTEN BY AN AIRTABLE AUTOMATION, added around May 2026. The
  // oldest record is 2026-05-26 and the table gained roughly 90 rows during
  // the session that mapped it. 41 records in May, 2,904 in September.
  //
  // Every entry is one formatted string in "Activity Name":
  //
  //   💳 Invoice #4281, sent on 2026-10-07
  //   📆 Due date changed to: 2026-10-16
  //   🗣️ Client correspondence changed to: Waiting on Response
  //
  // MOST COLUMNS WILL BE NULL, and that is the source's shape rather than a
  // mapping failure. Across 72 records sampled from both ends of the table,
  // only Activity Name was ever populated — Activity Type, Source, Visibility,
  // Activity Summary, Previous Value and New Value were empty on all of them.
  // They appear to be fields built for manual entries nobody makes. The real
  // fill rates belong in the first load's notes, not here; 72 of 4,443 is a
  // sample, and this project has twice been wrong about what a sample proves.
  //
  // THE THREE SELECT FIELDS ARE GUARDED ANYWAY, which is a departure from the
  // reasoning used on pursuits. There the question was open vs closed; here
  // the lists are plainly closed but currently unpopulated, and the first
  // instinct was to skip them as "a detector watching an empty field".
  //
  // That was wrong, because SUPABASE IS EVENTUALLY THE SYSTEM OF RECORD and
  // Airtable gets phased out. These lists are not just something to watch for
  // renames — they are the specification of what the column may contain, and
  // whatever replaces the Airtable automation will need them. Guarding a
  // closed list costs nothing when nothing populates it, and the list is worth
  // having written down either way.
  //
  // previous_value and new_value are mapped despite being empty everywhere,
  // for the same reason: the log records THAT something changed but not what
  // it changed from. Whatever fills that in later writes into these columns.
  // ===========================================================================

  {
    key: 'activity_log',
    airtable: 'Activity Log',
    // A JOIN, AND THE DRY RUN IS WHY. "DCW Project Task" is marked
    // prefersSingleRecordLink:true, which was taken to mean one task per
    // entry. 32 records hold several. The flag is a UI preference that
    // Airtable does not enforce — see the corrected standing rule above and
    // migration 021, which added this table and dropped deliverable_id.
    //
    // Caught before any row was written, which is the whole point of a dry
    // run over a table that is not loaded yet.
    joins: [
      { from: 'DCW Project Task', table: 'activity_log_deliverables',
        parentColumn: 'activity_log_id', childColumn: 'deliverable_id', linkTo: 'deliverables' },
    ],
    fields: [
      // TWO SEPARATE PERSON LINKS ON ONE TABLE, the first in the mirror, and
      // BOTH ARE SAFE FOR THE SAME REASON: counted, and found to hold one.
      //
      //   "Action Owner"  0 multiples across the population, 2026-10-07
      //   "Logged By"     0 multiples; 3,944 with one, 409 with none
      //
      // AN EARLIER VERSION OF THIS COMMENT SAID Action Owner was "single BY
      // SCHEMA ... cannot hold several without a deliberate base change",
      // because its config says prefersSingleRecordLink:true. That is wrong:
      // the flag is a UI preference and Airtable does not enforce it. The
      // proof is in the same table — "DCW Project Task" is also marked true
      // and 32 records hold several, which is why 021 made it a join.
      //
      // So neither of these is settled, only measured. If either gains a
      // second value the sync keeps the first and raises coercion_failed,
      // which is how out_of_office's group events and this were both found.
      { from: 'Logged By', to: 'logged_by_id', kind: 'link', linkTo: 'people' },
      { from: 'Action Owner', to: 'action_owner_id', kind: 'link', linkTo: 'people' },

      { from: 'Activity Name', to: 'activity_name', kind: 'text' },
      { from: 'Activity Summary', to: 'activity_summary', kind: 'text' },
      { from: 'Previous Value', to: 'previous_value', kind: 'text' },
      { from: 'New Value', to: 'new_value', kind: 'text' },
      { from: 'Milestone Date', to: 'milestone_date', kind: 'date' },
      { from: 'Action Due Date', to: 'action_due_date', kind: 'date' },

      { from: 'Action Required?', to: 'action_required', kind: 'boolean' },
      { from: 'Workload-Relevant?', to: 'workload_relevant', kind: 'boolean' },
      { from: 'Pinned to Project Detail?', to: 'pinned_to_project_detail', kind: 'boolean' },

      {
        from: 'Activity Type',
        to: 'activity_type',
        kind: 'text',
        choices: [
          'Assignment',
          'Schedule Change',
          'Documents Received',
          'Report/Takeoff Started',
          'QC',
          'Draft Delivered',
          'Final Delivered',
          'Revisions',
          'Client Follow-Up',
          'Internal Note',
          'Billing / Invoice',
          'Complete',
          'Blocker',
          'Support Request',
        ],
      },
      {
        from: 'Source',
        to: 'source',
        kind: 'text',
        choices: ['Automation', 'Manual', 'Meeting', 'Email', 'Teams', 'Softr Update', 'Airtable Update'],
      },
      {
        from: 'Visibility',
        to: 'visibility',
        kind: 'text',
        choices: ['Internal', 'Leadership', 'Team', 'Admin'],
      },
      // attachments_paths: NOT MAPPED. Airtable attachment URLs expire after
      // about two hours. This one matters more than the others, because the
      // switch to Supabase means these files need real storage rather than a
      // link that is dead on arrival — see the note in the memory on the
      // mirror being transitional.
      //
      // "Date Logged" is a createdTime field and feeds date_logged below.
      //
      // 26 fields: 15 mapped, 1 createdTime, 1 attachment, 9 lookups.
    ],
    // NOTE THE COLUMN NAME: date_logged here. airtable_created_at on
    // project_notes and pursuits, created_on on out_of_office. Three tables,
    // three names, checked each time rather than copied.
    createdAtColumn: 'date_logged',
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
