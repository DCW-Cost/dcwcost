# Portal brief — read-only pages over the Airtable mirror

For whoever is designing and building the next set of intranet pages. Written
2026-10-13, immediately after the Airtable → Supabase mirror finished loading.

**What this covers:** what data exists, what it looks like, what is empty, and
the patterns the codebase already uses. **What it does not cover:** which
screens to build. That list comes from Rachel, who built the Softr pages and
knows what the team needs.

---

## 1. The situation in one paragraph

The team currently uses a Softr portal that sits on top of Airtable. Every
record behind it has now been mirrored into Supabase — 14 tables, 11 join
tables, about 51,200 rows — and verified field-by-field against Airtable. The
job is to rebuild the Softr screens against the mirror. **Read-only first**, so
the pages can be judged on whether they show the right things before anyone
has to decide where edits should go.

Airtable remains the system of record for now. Supabase will take over later,
and the mirror's schema is the forward schema rather than a throwaway copy.

---

## 2. Rules that are not negotiable

**Read-only means read-only.** No writes to mirrored tables, by anything, for
now. The sync owns those rows and would overwrite an edit on its next run. This
is not a style preference — it is the reason the first pass is read-only.

**Row-level security is the access control, not the page code.** Every query
runs as the signed-in person through their own cookie session. A page that
"hides" a row in its template has not protected anything. See
`src/lib/intranet/wishlist.ts` for the pattern and the reasoning.

**`DataProvider` is for the cost library only.** Do not add methods to
`src/lib/intranet/data/types.ts` for these pages. That seam exists so the cost
library can run on fixtures; the mirror has real data and needs no such
indirection. New pages follow the wishlist pattern instead (section 6).

**Server-side rendering.** Pages are Astro with `prerender = false`. Data is
fetched on the server during the request, not in the browser.

---

## 3. What the data actually looks like

Row counts as of 2026-10-13. These grow — `activity_log` and `time_entries`
change daily.

| table | rows | what it is |
|---|---:|---|
| `time_entries` | 29,215 | hours logged, by person, against a task |
| `deliverables` | 5,560 | **tasks**, despite the name — see section 4 |
| `activity_log` | 4,454 | automated change log, May 2026 onward |
| `project_notes` | 3,521 | notes attached to a project |
| `pursuits` | 3,492 | RFQs and fee proposals |
| `projects` | 1,874 | |
| `contacts` | 1,697 | people at client companies |
| `out_of_office` | 843 | time off, holidays, offsite events |
| `client_companies` | 482 | |
| `people` | 24 | DCW staff |
| `subconsultant_tasks` | 13 | |
| `subconsultant_invoices` | 12 | |
| `bid_results` | 8 | |
| `subconsultants` | 3 | |

### Join tables — many relationships are NOT columns

Eleven relationships are many-to-many and live in their own tables. **A query
that reads only the parent table will silently miss these.**

| join table | links | rows |
|---|---|---:|
| `time_entry_deliverables` | time entry → task | 29,028 |
| `activity_log_deliverables` | log entry → task | 4,435 |
| `pursuit_assignees` | pursuit → person | 4,030 |
| `pursuit_client_contacts` | pursuit → contact | 3,902 |
| `pursuit_client_companies` | pursuit → company | 3,482 |
| `deliverable_project_managers` | task → person | 3,501 |
| `project_client_contacts` | project → contact | 1,998 |
| `deliverable_project_support` | task → person | 1,883 |
| `project_client_companies` | project → company | 1,790 |
| `project_note_deliverables` | note → task | 1,226 |
| `out_of_office_people` | entry → person | 773 |

There is one view already: **`v_pursuit_clients`** gives a pursuit's companies,
contacts and assignees as counts and comma-joined name lists, so a pursuits
list does not need three joins. More views like this are welcome — see
section 7.

---

## 4. Things that will catch you out

These are real, measured, and each one would otherwise be discovered by
building something and finding it blank.

### `deliverables` means TASKS

The table is named for documents but holds DCW Project Tasks. A project has
many tasks; a task is "Task 2 — 90% Design Development". Columns like
`issue_date`, `estimator`, `box_file_url`, `original_filename` and
`storage_path` are **all empty** — they belong to uploaded documents, a
separate future population of the same table. All 5,560 rows are
`source = 'airtable'`.

### `projects.client_name` is EMPTY on all 1,874 rows

The client comes through `project_client_companies` → `client_companies.company_name`.
1,760 projects have one. A project card that reads `client_name` shows nothing.

### Columns that are empty on every row

Do not design around these.

**projects** — `client_name`, `region`, `stories`, `gross_sf`,
`estimated_cost_building`, `estimated_cost_site`, `construction_start`,
`created_by`, `need_to_fix_for_the_resume_builder`

**deliverables** — `issue_date`, `estimator`, `box_file_url`, `byte_size`,
`file_checksum`, `original_filename`, `storage_path`, `source_format`,
`stated_total_cost`, `ingested_at`, `uploaded_at`, `uploaded_by`,
`upload_notes`, `construction_start`, `next_action`, `next_action_due_date`,
`next_action_owner_id`, `waiting_on`, `support_needed`, `support_request_notes`,
`blocker_risk_notes`, `meeting_update_notes`, `tech_team_decision`,
`tech_team_meeting_notes`, `workload_heat`, `review_again_on`,
`next_collection_action_needed_on`

**activity_log** — everything except `activity_name`, `date_logged`,
`milestone_date` and `logged_by_id`. That means `activity_type`, `source`,
`visibility`, `activity_summary`, `previous_value`, `new_value`,
`action_owner_id`, `action_required`, `action_due_date`, `workload_relevant`,
`pinned_to_project_detail` are all zero. The automation writes the whole entry
as one formatted string into `activity_name`:
`"💳 Invoice #4281, sent on 2026-10-07"`, `"📆 Due date changed to: 2026-10-16"`.

**time_entries** — `pursuit_id` (0 of 29,215; the link exists in Airtable and
has never been used)

**All attachment columns, on every table.** Fourteen of them. Airtable's file
URLs expire after about two hours, so nothing is mirrored — no logos, no
headshots, no project images, no invoice PDFs. The `airtable-mirror` storage
bucket exists and is empty. **Design around the absence of images for now.**

### Sparse but not empty — check before featuring

`pursuits.your_name` / `your_email` / `your_company` / `your_phone_number`
(~13 of 3,492) · `pursuits.request_the_following` (4) ·
`pursuits.prime_proposal_components` (3) ·
`pursuits.select_preferred_meeting_type` (1) ·
`pursuits.preferred_meeting_date_and_time` (1) ·
`projects.invoice_instructions` (6) · `deliverables.work_breakdown` (5) ·
`deliverables.dcw_estimated_project_cost` (10) · `contacts.subconsultant_id` (3)

### `Year` and `Month-Year` on pursuits stopped in 2023

2,219 of 3,492 are filled, but the dropdown has no options past 2023 and only
**3 of the 1,265 pursuits created since 2024** have a value. The field is
abandoned, not sparse. Do not build a year filter on it.

### Time entries, tasks and projects — the chain has a gap by design

```
time entry → task → project
```

- 18,175 entries have a task **and** that task has a project
- **10,839 entries have a task with NO project** — they point at a task called
  `" - Non-billable"`, the bucket for admin, training and time off. This is
  correct, not missing data. Non-billable work is not project work.
- 201 entries have no task at all

So **any "hours by project" view silently excludes 37% of logged time**, and
that is the right behaviour — but a total labelled "all time" would be wrong.
`deliverables.project_id` is nullable precisely to allow this.

### Duplicate tasks exist in Airtable

Tibbets Valley Park has the same task three times; Friendly Hall twice. They
inflate counts anywhere tasks are counted. Not a mirror bug — a known data
issue on the Airtable side.

---

## 5. Useful shapes

A few things worth knowing before choosing what to show.

**Distribution of the big tables** — `time_entries` spans several years;
`activity_log` starts 2026-05-26 and grew sharply from September (2,904 rows in
that month alone). A page listing either needs paging or a date window from the
start, not as an optimisation later.

**`people` has 24 rows** and is the natural filter for anything personal — time
logged, out of office, notes added, activity logged.

**`out_of_office` has 78 entries with no person** (of 843). They are company-wide:
holidays, "Information" notices, team events. Correct, not missing. Categories
are a 15-value list including `Teammate OOO`, `Appointment`, `Working Remote`,
`Holiday Observance`, `Birthday`, `Bereavement`.

**Six entries have several people** — group events like a site visit or a
conference, via `out_of_office_people`. A calendar that shows one name per
entry is wrong for those.

---

## 6. How to build a page

Follow `src/lib/intranet/wishlist.ts` and
`src/pages/teamintranet/projects/index.astro`.

**Data access** — a module in `src/lib/intranet/` that takes `AstroCookies`,
calls `serverClient(cookies)`, and returns typed rows. RLS runs the query as
the signed-in user. Do not use a service key, and do not add to `DataProvider`.

**Pages** — Astro, `export const prerender = false`, wrapped in
`IntranetLayout.astro`. Fetch in the frontmatter.

**Auth and roles** — already built. Sign-in, sessions, three roles
(`admin`, `estimator`, `viewer`), a pending-approval flow. See
`src/lib/intranet/gate.ts` and `access.ts`.

**Sorting and filtering** — `src/lib/intranet/project-sort.ts` is a worked
example of sortable columns with URL state, blanks-to-top ordering and a
numeric collator. Reuse the shape.

**Tests** — `npm test` runs the whole suite (169+ tests, 7 files). Pure logic
gets a unit test; anything that reads the database does not.

**PostgREST caps page size at 1,000 rows silently.** Anything that might return
more needs explicit paging. `src/lib/sync/run.ts` has an `allRows` helper
showing the pattern.

---

## 7. Suggestions, not requirements

**Views are cheap and worth it.** `v_pursuit_clients` already saves a pursuits
list three joins. A `v_project_summary` giving project + client company + task
count + latest activity would save every project screen the same work, and it
can be tested once rather than in every page. Views need
`with (security_invoker = true)` so RLS applies as the querying user — see
migration 019 for the pattern, and note that `v_people_compensation` is the one
view that lacked it and had to be fixed in 013.

**Start with a read-only screen that someone uses daily.** It proves auth,
data, layout and paging end to end with no ownership question to answer.

**Empty states are most of this job.** Given section 4, a large fraction of
fields are blank on a large fraction of rows. A card that renders a labelled
blank for every missing value will look broken. Decide early whether missing
fields are hidden or shown as absent.

---

## 8. Where to look

| | |
|---|---|
| field map, Airtable → Postgres | `src/lib/sync/tables.ts` — every column, with reasoning |
| schema history | `docs/team-intranet/migrations/` — 001 through 023 |
| known gaps and untested mechanisms | `docs/team-intranet/NEVER-EXERCISED.md` |
| existing pages | `src/pages/teamintranet/` |
| write pattern | `src/lib/intranet/wishlist.ts` |
| read pattern over the mirror | `src/pages/teamintranet/projects/index.astro` |

`tables.ts` is worth reading before designing anything. It records why each
field is mapped the way it is — including several Airtable fields whose names
do not match what they point at, which would otherwise be a trap.

---

## 9. The screen list

Everything above is raw material. This section is the actual specification,
and it comes from the person who built the Softr pages.

### Template — one block per screen

Copy this per screen. The things that are easy to forget are the last four:
sorting, grouping, who sees it, and what people do *next* after looking at it.

```
### <screen name>

Who uses it:        <role or named people, and roughly how often>
What it answers:    <the question someone opens this page to answer>

Shows:              <the records — e.g. "one row per task">
Fields on screen:   <field by field, in the order they appear>
Default filter:     <what is hidden by default — e.g. "only active">
Default sort:       <and whether users can change it>
Grouped by:         <if anything>

Drill-in:           <what clicking a row does, if anything>
Actions:            <buttons, even read-only ones like export or a Box link>
Editable in Softr:  <which fields, and who can change them — for phase two>

Volume:             <roughly how many rows on a normal day>
Notes:              <anything that would surprise someone rebuilding it>
```

### Worked example of the level of detail that helps

This is **invented** as a format illustration — replace it, do not build it.

```
### Example — My Open Tasks

Who uses it:        Every cost planner, several times a day
What it answers:    What am I meant to be working on, and what is overdue?

Shows:              One row per task assigned to the signed-in person
Fields on screen:   Project name · Task number & name · Due date ·
                    Schedule status · Client correspondence · Task hours
Default filter:     Task status is not Complete; assigned to me
Default sort:       Due date ascending, blanks last
Grouped by:         Nothing

Drill-in:           Row opens the task detail page
Actions:            Link out to the Box project folder
Editable in Softr:  Task status, schedule notes — the assignee only

Volume:             5 to 30 rows per person
Notes:              Overdue rows are shown in red. People scan for red first,
                    so losing that cue would change how the page is used.
```

### Draft list, derived from Airtable's view names — TO BE CORRECTED

Softr blocks bind to Airtable views, and a lot of those views say so in their
names. This was pulled from the live base on 2026-10-13. **It is a starting
point, not a specification** — a view named for Softr may have been abandoned,
and a Softr page may read a view that is not named for it.

**DCW Project Tasks** (17 Softr-named views, the busiest table)

| view | likely screen |
|---|---|
| `SOFTR Upcoming Projects (Secured w due date)` | upcoming work, dated |
| `SOFTR Upcoming Projects (Secured wo due date)` | upcoming work, undated |
| `SOFTR Upcoming Projects (Secured Combined)` | the two together |
| `SOFTR all upcoming projects` | wider upcoming list |
| `SOFTR - Project Tasks within the year` | this year's tasks |
| `Calendar (For Softr)` | task calendar |
| `Softr - Summary` | dashboard or landing |
| `SOFTR Find a Similar Report View` | precedent search |
| `Cost Database (Completed Projects) - For Softr` | completed-work library |
| `Cost Database for Softr Sync (No Edit)` | read-only cost data |
| `SOFTR - All Invoices View` | invoices |
| `Invoicing This Month (Linked to Softr)` | billing, current month |
| `Invoicing Review Last 100 Days (Linked to Softr)` | recent billing review |
| `Invoicing Review ALL TIME (Linked to Softr)` | all billing |
| `Invoicing Only Waiting to be Billed (Linked to Softr)` | unbilled queue |
| `View Upcoming Workload - Unassigned (for softer)` | unassigned work |
| `DO NOT DELETE - SOFTR LINK` | unknown — worth identifying |

**New Project Entry (projects)**

`SOFTR Resume Builder - DO NOT FILTER` · `Resume Builder (Softr DO NOT FILTER)`
· `Softr Add Note Filtered View (DO NOT DELETE)`

The last one implies **adding a note from Softr** — a write path, and probably
the first one to matter in phase two.

**Time Tracking**

`1 Month Filter - SOFTR DO NOT DELETE` · `2 Month Filter All - SOFTR DO NOT DELETE`
· `3 Month Filter Juniors - SOFTR DO NOT DELETE`

Three rolling windows, one of them split by seniority. Note that per-person
grids and calendars exist for most of the team — the Softr equivalent is
probably "my time", filtered to the signed-in person.

**DCW Project Pursuits**

`Softr - Fees Calendar` · `Softr - RFQ Calendar` · `Softr - Pursuit Calendar`

Three calendars over the same table on different dates. Also four **forms** —
`Request Qualifications`, `Request Fee Proposal`, `Request Meeting`,
`Add New DCW Project Pursuit` — which are write paths, and explain the
`your_name` / `your_email` / `your_company` columns that are nearly empty in
the mirror (13 of 3,492): they are form-submission fields.

**DCW Out of Office** — no Softr-named views, but the shape is obvious:

`Calendar` · `Birthdays!` · `Work Anniversaries` · `Holidays` · `Time Off` ·
`All PTO` · `For Approval` and five per-approver variants ·
`Out of Office Notice` (form)

The approval views matter: there is an approval workflow here, and
`out_of_office.approval` is populated on 470 of 843 rows.

### How to use this draft

For each row above: **delete it if that screen does not exist**, and fill in a
section-9 block if it does. The names tell us roughly what a screen shows and
nothing about who uses it, what it is for, or what the default filter and sort
are — which is most of what matters.

### What matters most in those blocks

**The question it answers**, because two screens showing the same table can be
completely different pages.

**Default filter and sort**, because they are usually invisible in a
screenshot and are most of what makes a page useful.

**Volume**, because 20 rows and 20,000 rows are different designs.

**Editable fields**, even though phase one is read-only — knowing which fields
will need writing later changes where they sit on the page, and tells us which
table's ownership has to move first.
