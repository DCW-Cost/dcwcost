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

export interface TableSpec {
  key: TableKey;
  /** Airtable table name. */
  airtable: string;
  fields: readonly FieldSpec[];
  /** Columns set to a constant when the row is created. */
  insertConstants?: Readonly<Record<string, string>>;
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
    fields: [
      { from: 'Company Name', to: 'company_name', kind: 'text' },
      { from: 'Client ID', to: 'client_code', kind: 'text' },
      { from: 'Type', to: 'type', kind: 'text[]' },
      { from: 'Website', to: 'website', kind: 'text' },
      { from: 'Address', to: 'address', kind: 'text' },
      { from: 'Company Billing Instructions', to: 'company_billing_instructions', kind: 'text' },
      { from: 'Fee Proposal Notes', to: 'fee_proposal_notes', kind: 'text' },
      { from: 'Created', to: 'airtable_created_at', kind: 'timestamptz' },
    ],
  },

  {
    key: 'client_companies',
    airtable: 'Client Company List',
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
      { from: 'Created', to: 'airtable_created_at', kind: 'timestamptz' },
    ],
  },

  {
    key: 'contacts',
    airtable: 'Contacts',
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
      { from: 'Added On', to: 'added_on', kind: 'timestamptz' },
    ],
  },

  {
    key: 'projects',
    airtable: 'New Project Entry',
    restrictUpdateTo: "projects.airtable_record_id is not null",
    fields: [
      { from: 'Project Title', to: 'name', kind: 'text' },
      { from: 'Link to Client Company (Add Here)', to: 'client_id', kind: 'link', linkTo: 'client_companies' },
      { from: 'Client Contact (Linked)', to: 'client_contact_id', kind: 'link', linkTo: 'contacts' },
      // sector, market and city are single `text` columns fed from Airtable
      // MULTIPLE selects. Keeping the first is all a text column can do; the
      // coercion reports every time it drops one, so the loss is counted in
      // sync_anomalies rather than invisible.
      { from: 'Primary Category', to: 'sector', kind: 'text' },
      // Secondary Category is NOT MAPPED.
      //
      // `market` is a single text column and Airtable's Secondary Category is
      // a multiple select that is genuinely multi-valued: in a sample of 100
      // projects, 66 carried two or more, frequently four to eight
      // ("Port", "Government / Essential Facilities", "Emergency /
      // Operations", "Offices / Administrative" on one record). Keeping the
      // first would discard real data on two thirds of projects, which is a
      // different thing from the rare loss sector and city accept below.
      //
      // Needs a text[] column of its own before it can be carried. Left out
      // rather than half-carried, because a `market` that silently holds one
      // of six categories is worse than a `market` that is empty: the first
      // looks like an answer.
      { from: 'Location (City, State)', to: 'city', kind: 'text' },
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
      { from: 'Date Created', to: 'airtable_created_at', kind: 'timestamptz' },
    ],
    // gross_sf is NOT mapped from Airtable. It is the universal normaliser
    // (PLAN §5.3) and Airtable has a building area for only about 18% of
    // projects, so the reader's frame is its primary source. See derive.ts.
  },

  {
    key: 'deliverables',
    airtable: 'DCW Project Tasks',
    insertConstants: { source: 'airtable' },
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

      { from: 'Project Manager *', to: 'project_manager_id', kind: 'link', linkTo: 'people' },
      { from: 'Project Support *', to: 'project_support_id', kind: 'link', linkTo: 'people' },
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
      { from: '*Delivery Method', to: 'delivery_method', kind: 'text' },
      { from: '*New, Reno, Demo, Etc', to: 'new_reno_demo_etc', kind: 'text[]' },
      { from: '*Project Size', to: 'project_size', kind: 'text[]' },
      { from: '*Report Format', to: 'report_format', kind: 'text[]' },
      { from: '*Work Breakdown', to: 'work_breakdown', kind: 'text' },
      { from: '*DCW Estimated Project Cost', to: 'dcw_estimated_project_cost', kind: 'numeric' },
      { from: '*Project Folder Link', to: 'project_folder_link', kind: 'text' },

      { from: 'Date Created', to: 'airtable_created_at', kind: 'timestamptz' },
      { from: 'Last Modified Time', to: 'airtable_last_modified_at', kind: 'timestamptz' },
    ],
  },
];

export function spec(key: TableKey): TableSpec {
  const found = TABLES.find((t) => t.key === key);
  if (!found) throw new Error(`no table spec for ${key}`);
  return found;
}
