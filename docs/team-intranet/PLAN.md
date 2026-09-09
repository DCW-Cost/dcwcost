# DCW Team Intranet + Historical Cost Database

**Build plan — v1, 9 September 2026**
Prepared from the Rachel/Lacie calls of 9 September and 12 March.

---

## 1. What we're building

A password-protected area of `dcwcost.com` at **`/teamintranet`** where DCW
employees log in and query every cost line item the firm has ever issued.

The product is not "a database with a search box." It is a tool that answers the
estimator's real question:

> *"I'm pricing foundations on a 45,000 SF healthcare project in Seattle at DD.
> What have we actually charged, is that number trustworthy, and where is it
> heading?"*

Three capabilities make that possible, and each is an explicit ask from the
9 September call:

1. **Normalize.** Every historical line item is converted into the unit the
   estimator asks for — `$/SF`, `$/CY`, `$/LF`, `% of total` — regardless of how
   it was originally priced.
2. **Judge.** The tool reports a range, discards statistical anomalies, and
   states plainly whether the underlying data is good enough to price from.
   When it isn't, it says *"insufficient data — price this manually."*
3. **Project.** Where pricing has moved consistently over time, the tool
   escalates historical numbers to today's dollars and reports the trend.

Rachel's framing is the north star for the schema: *"What they need to know is
everything every estimator has said about each line item."* The atomic unit of
this database is therefore a **line-item observation**, not a project.

---

## 2. The stack decision

**Recommendation: keep Airtable + Softr. Add Postgres alongside them. Do not
migrate anything yet.**

This was the central open question going into this plan, and the honest answer
is that the two systems are solving different problems and should not be merged
right now.

### Why Airtable stays

- It is the operational system of record for projects, clients, time tracking,
  PTO, reimbursements, and the workflow board. The entire team lives in the
  Softr front end every day.
- Brittany goes on maternity leave. Ripping out the system she runs while she is
  out is how you lose a quarter.
- Rachel's concern is legitimate — *"we've got a lot of ownership over our data,
  and if I moved it somewhere else Brittany would have trouble with that."*
  Nothing in this plan moves DCW's operational data.

### Why the cost data needs Postgres

The cost library is a fundamentally different workload:

| | Airtable | What the cost library needs |
|---|---|---|
| Scale | Base record caps (50k–500k depending on tier) | 1,235 deliverables × 40–120 line items ≈ **50k–150k rows**, growing weekly |
| Queries | Filters and rollups | Percentile math, MAD outlier rejection, regression over time, unit conversion joins |
| Front end | Softr preset blocks | A real estimating UI — Rachel already hit this wall building the calendar view by hand |
| Cost | Grows per-seat as data grows | Flat |

Airtable would technically hold the rows. It cannot do the statistics, and Softr
cannot render the interface. That's the whole argument.

### The shape

```
  Airtable (system of record, unchanged)
     │   projects · clients · deliverables · Box links · time tracking
     │
     │   one-way sync, every 15 min, read-only
     ▼
  Supabase / Postgres  ◄──── ingestion pipeline ◄──── Box (source documents)
     │   projects (mirror) · deliverables · line_items · taxonomy
     │   uom_conversions · cost_indices · estimator_notes · audit
     │
     ▼
  /teamintranet  (Astro SSR on the existing dcwcost.com Netlify site)
     Cost Library · Cost Plan Builder · Review Queue · Admin
```

Airtable remains authoritative for anything a human types. Postgres is
authoritative only for what the pipeline extracts from cost documents. There is
exactly one direction of data flow, so the two can never disagree about a
project's name or due date.

**Softr is untouched.** If the intranet later proves it can replace Softr, that
is a separate decision with its own business case — exactly as agreed at 23:35
on the 9 September call.

---

## 3. Where the code lives

`/teamintranet` ships **inside this repo**, on the existing Netlify deploy. One
domain, one login, one build.

The site is currently `output: 'static'`. Astro 5 supports mixing: add the
Netlify adapter, keep every marketing page prerendered, and mark only the
intranet routes as server-rendered.

```js
// astro.config.mjs
import netlify from '@astrojs/netlify';

export default defineConfig({
  site: 'https://dcwcost.com',
  output: 'static',          // marketing pages stay static — unchanged
  adapter: netlify(),        // enables per-route SSR
  integrations: [sitemap()],
});
```

```js
// src/pages/teamintranet/*.astro
export const prerender = false;   // this route runs server-side
```

Three practical notes:

- **Netlify Forms still works.** Form detection scans built static HTML. The
  contact page stays prerendered, so the existing form is unaffected. Do not
  make it SSR.
- **Exclude `/teamintranet/*` from the sitemap** and add
  `Disallow: /teamintranet` to `robots.txt`. This content must never be indexed.
- **`src/data/` stays as it is.** The intranet reads from Postgres; the
  marketing site keeps its flat content files.

Alternative considered and rejected: a separate Next.js app on
`intranet.dcwcost.com`. It buys nothing here and costs a second repo, a second
deploy, a second auth domain, and a cross-origin session.

---

## 4. Authentication and the admin panel

DCW is a Microsoft 365 shop, so identity should come from Entra ID rather than
from a new set of passwords nobody wants to manage.

**Sign-in flow**

1. Employee clicks *Sign in with Microsoft* → Entra ID (Supabase Auth's Azure
   provider).
2. A hard gate rejects any address outside `@dcwcost.com` before a profile row
   is even created.
3. First successful sign-in creates a `profiles` row with `status = 'pending'`.
   A pending user sees a holding page and nothing else.
4. **Rachel Quimby, Brian Thompson, or Trish Drew** approve from the Admin
   panel. Status flips to `active`, the role is assigned, access begins.
5. Any admin can set `status = 'revoked'` at any time, which kills access on the
   next request — no waiting for a token to expire.

Offboarding is doubly covered: disabling someone in Entra ID also locks them
out, whether or not anyone remembers to revoke the profile.

**Roles**

| Role | Can do |
|---|---|
| `admin` | Everything, plus approve/revoke users and view the audit log |
| `estimator` | Query the library, build cost plans, work the review queue |
| `viewer` | Query the library read-only; no exports of client-identified data |
| `pending` | Holding page only |

Every rule above is enforced in Postgres **row-level security**, not in the UI.
RLS is deny-by-default on every table; a bug in an Astro page cannot leak a row
that policy forbids. The service-role key never reaches the browser — all
database access goes through server-rendered routes and server endpoints.

---

## 5. The data model

Full DDL is in [`schema.sql`](./schema.sql). The reasoning behind it:

### 5.1 The core tables

- **`projects`** — mirrored from Airtable. Carries the fields that make cost
  comparison meaningful: `gross_sf`, `sector`, `market`, `region`,
  `delivery_method`, `construction_start`.
- **`deliverables`** — one row per document DCW sent. Crucially typed:
  `cost_estimate` / `estimate_review` / `reconciliation` / `rom`. Rachel flagged
  this on the call — *"this one is just an estimate review, which is totally
  different from a cost estimate."* Mixing a review of someone else's numbers
  into DCW's own pricing history would poison every statistic downstream, so
  type is a first-class filter everywhere.
  Also carries `design_phase` (concept / SD / DD / CD / bid), `estimator`,
  `issue_date`, `box_file_url`, and `version` — Airtable's version history maps
  straight onto this.
- **`line_items`** — the observation. Keeps *both* the raw and the normalized
  form of everything: `raw_description` next to `taxonomy_code`,
  `uom_raw` next to `uom_canonical`. The raw column is never overwritten, so a
  bad mapping is always recoverable and always auditable.
- **`estimator_notes`** — assumptions, exclusions, clarifications attached to a
  line item. This is Rachel's *"everything every estimator has said"*
  requirement, and it is the thing that makes the tool trusted rather than
  merely correct.

### 5.2 The taxonomy

`a 10 foundations` in the plan Lacie read out on the call is **UniFormat II
(ASTM E1557) code A10 — Foundations**. If that holds across the archive — and
it should, since it's the standard for elemental cost planning — DCW's cost
plans are *already coded*, and the taxonomy is a solved problem rather than an
NLP problem.

So: **UniFormat is the spine** (Levels 1–3), with CSI MasterFormat carried as a
secondary mapping for trade-level detail where estimators used it. Raw
descriptions map onto the spine; anything unmappable lands in the review queue
rather than being silently guessed at.

*→ Confirm with Rachel (Q1 in §12). This assumption is load-bearing.*

### 5.3 The normalization strategy — the hard part

Rachel put her finger on the real difficulty: *"you can't have mixed units in
the same sort of… it just kind of makes it messy."* She's right, and the fix is
to stop trying to force one unit and instead compute **three parallel
normalizations** for every line item:

| Normalization | Always computable? | Good for |
|---|---|---|
| **`$/project GSF`** | Yes, whenever project GSF is known | The universal comparator — works for lump sum, LF, CY, everything |
| **`% of project total`** | Yes | Sanity-checking scope and mix; the `3%` in the plan on the call |
| **`$/native unit`** | Only when a quantity is present | Apples-to-apples within a unit family (CY of concrete vs. CY of concrete) |

`$/GSF` is the unlock. It is DCW's own existing convention, and it sidesteps the
lump-sum problem entirely: a lump-sum elevator package can't be converted to
`$/EA` without a count, but it absolutely can be expressed as `$/GSF` of the
building. Every observation gets a comparable number.

The `uom_conversions` table then handles the genuine unit math within families —
SF↔SM, LF↔LM, CY↔CF, TON↔LB. **It deliberately does not convert across
families.** A lump sum is not secretly 400 lineal feet, and the tool will never
pretend otherwise; it reports `$/GSF` and `%` for that row and marks
`$/native unit` as not applicable.

### 5.4 Escalation

Comparing a 2024 dollar to a 2026 dollar without adjustment produces garbage,
and it silently corrupts trend detection. Every observation is escalated to
today before it is pooled.

`cost_indices` holds a quarterly index per region. Start by deriving DCW's own
internal index from repeat line items in its own archive — that measures DCW's
actual market, not a national average — and cross-check it against ENR's Seattle
CCI. Store the index version used on every computed result so a number can
always be reproduced.

---

## 6. Ingestion

### 6.1 Getting the documents

Airtable's Cost Database base already links every deliverable to its Box file —
that work is done. The pipeline reads that table via the Airtable API, follows
`project_folder_link` into Box, and pulls the `.xlsx` or `.pdf` via a Box
service account (JWT / client-credentials app).

Rachel's `report uploaded` view (~70 vetted records) is the pilot set. The full
grid view (1,235 deliverables) is the backfill.

### 6.2 Two lanes, deterministic first

**Excel lane.** Most DCW deliverables come from DCW's own templates, which
repeat. A template-fingerprint library plus a grid parser reads those
deterministically: locate the header row, map columns, pull the numbers. No
model call, no cost, perfect auditability. This is where most of the volume
should land.

**PDF lane.** Extract the text layer first (`pdfplumber`); OCR only genuinely
scanned documents. Then Claude structures the extracted text.

**Model extraction, where it's needed.** `claude-sonnet-5` for bulk,
`claude-opus-5` for documents the bulk pass flags as low-confidence. Three rules
keep this trustworthy:

1. **Strict structured output.** A JSON schema, `strict: true`, no prose.
2. **Extraction only — never arithmetic.** The model reads numbers off the page.
   Every total, conversion, and statistic is computed afterward in SQL or
   Python. A model that is not allowed to do math cannot get math wrong.
3. **Provenance on every field.** Sheet name and cell range, or PDF page and
   bounding box, plus a confidence score. Every number in the library can be
   traced back to the exact spot in the exact document it came from.

### 6.3 The review queue

Anything below the confidence threshold, and anything that can't be mapped to
the taxonomy, goes into a review screen in the intranet: extracted rows on the
left, source document on the right, accept / correct / reject.

This is not just data hygiene. It is how the estimating team comes to trust the
tool — they will believe numbers they have personally signed off on, and they
will not believe numbers that appeared by magic. Budget real time for it.

### 6.4 What the backfill actually costs

Lacie's concern on the call — *"if the volume of these estimates isn't going to
trip any sort of blocks and charge us an exorbitant amount of money"* — deserves
a real number rather than a shrug.

Worst case, assuming **every** one of the 1,235 documents goes through the model
(no Excel fast path at all), at roughly 8K input and 4K output tokens per
document:

| Path | Input | Output | Total |
|---|---|---|---|
| Sonnet 5, standard | 9.9M × $2/M = $20 | 4.9M × $10/M = $49 | **≈ $69** |
| Sonnet 5, Batch API (−50%) | $10 | $25 | **≈ $35** |
| Opus 5, standard | 9.9M × $5/M = $50 | 4.9M × $25/M = $124 | **≈ $174** |
| Opus 5, Batch API (−50%) | $25 | $62 | **≈ $87** |

**The entire two-year backfill costs somewhere between $35 and $175, once.** The
70-document pilot is under $10. Prompt caching on the shared system prompt and
the Excel fast path both push the real figure toward the bottom of that range.

This is not a budget concern. It should not be treated as one on Friday.

---

## 7. The analytics engine

This is the part that makes it a tool rather than a filing cabinet.

An estimator queries: *category + target unit + filters* (sector, region, GSF
band, delivery method, design phase, date range). The engine:

1. **Filters** to comparable observations — including by deliverable type, so
   estimate reviews never contaminate DCW's own pricing.
2. **Escalates** every observation to today's dollars.
3. **Log-transforms.** Construction costs are right-skewed and roughly
   log-normal; running statistics on raw dollars overstates the mean and
   mislabels legitimate high-end projects as outliers.
4. **Rejects outliers** using **median absolute deviation**, modified z-score
   `|Mz| > 3.5`, with a 1.5×IQR fence as a cross-check. *Not* mean ± 2σ — that
   test is unreliable at the sample sizes involved (often n < 20) and lets a
   single extreme value drag the threshold out past itself.
5. **Reports** n, median, mean, p10 / p25 / p75 / p90, min, max, and coefficient
   of variation — plus every excluded outlier, named, with the reason. Nothing
   is thrown away invisibly.
6. **Detects trend** with a **Theil–Sen** estimator on escalation-neutral
   residuals — robust to outliers and honest at small n. A trend is surfaced
   only at n ≥ 8 and p < 0.10; otherwise the tool says there isn't enough signal
   rather than drawing a line through four points.

### The confidence gate

Lacie's explicit requirement: *"I want the logic of the tool to say, this is
statistically correct data to build this pricing estimate off of, or it's not,
and you need to research and do it manually."*

Every result carries a traffic light:

| | Criteria (all must hold) | Meaning |
|---|---|---|
| 🟢 **Green** | n ≥ 8 after outlier removal · CV ≤ 0.25 · ≥ 3 distinct projects · ≥ 2 distinct estimators · most recent observation within 18 months | Price from this |
| 🟡 **Amber** | n 4–7, or CV 0.25–0.50, or newest observation 18–36 months old | Useful, but apply judgment |
| 🔴 **Red** | n < 4, or CV > 0.50, or all observations from a single project or single estimator | Insufficient — research and price manually |

Two design rules that matter more than the thresholds:

- **The reason always ships with the colour.** Never a bare red light — always
  *"Red: only 2 observations, both from Ballard Library, 2024."* An estimator
  can act on that; they cannot act on a colour.
- **The thresholds are configurable by an admin and versioned.** Rachel and the
  estimating team will want to tune them once they see real output, and they
  should be able to without a deploy.

### Drill-down

Every statistic is clickable, down to the list of source observations: project,
client, estimator, date, phase, the original description, the estimator's notes,
and a link straight to the document in Box. That drill-down *is* Rachel's
*"everything every estimator has said about each line item"* — delivered.

---

## 8. What the estimator actually uses

**Cost Library** — search or browse the UniFormat tree. Pick a target unit. Set
filters. Get the statistics card, the confidence light, the trend, and the
source list.

**Cost Plan Builder** — the payoff, and the "automate inputs for future cost
plans" requirement. Enter the project shell (GSF, sector, region, phase,
delivery method). The tool generates a UniFormat line-item template with a
suggested rate per element, each carrying its own confidence light and its own
drill-down. The estimator accepts, overrides, or leaves red items blank to price
by hand — and every override is captured with a reason, which becomes training
data for the next version. Export to DCW's Excel deliverable format.

**Review Queue** — low-confidence extractions awaiting human confirmation.

**Admin** — user approval and revocation, role assignment, ingest run history,
confidence thresholds, escalation index management, audit log.

---

## 9. Security and data privacy

Cost data is DCW's most commercially sensitive asset, and much of it is
client-confidential. Non-negotiables:

- **Entra ID SSO**, domain-locked, plus explicit admin approval. Two gates, not
  one.
- **RLS deny-by-default on every table.** Policy lives in the database. The
  service-role key never reaches the browser.
- **Client confidentiality tiering.** A `confidentiality` flag on `projects`.
  Aggregate statistics are always available to any active user; drilling through
  to a *named* client or project on a restricted engagement requires elevated
  role. Rachel and Trish set that policy — the schema just enforces whatever
  they decide.
- **Documents stay in Box.** The database stores extracted values and links, not
  copies of client deliverables. This deliberately keeps DCW's document
  ownership story exactly where it is today, which was Rachel's concern.
- **API, not consumer tooling.** Extraction runs through the Anthropic API,
  where inputs and outputs are not used for model training by default. This is
  the material difference from pasting client cost plans into a chat window, and
  it's worth stating plainly to the team on Friday.
- **Full audit log** — every query, every export, every admin action, with actor
  and timestamp.
- **Backups.** Supabase point-in-time recovery. Airtable remains the independent
  operational record, so no single failure loses both.

---

## 10. Phasing

### Phase 0 — the Friday demo (this week)

Scope deliberately narrow and deliberately honest:

- `/teamintranet` live behind Microsoft sign-in, with real accounts for Rachel,
  Trish, Brian, and Lacie, and the approval panel working.
- 10–20 hand-picked deliverables from the `report uploaded` view, ingested end
  to end.
- **One or two UniFormat categories deep** — A10 Foundations and B20 Exterior
  Enclosure are good candidates — showing the full loop: query → normalized
  range → confidence light → drill-down → link to the source document in Box.

Show it as a prototype on twenty documents, not a finished product on 1,235.
The estimating team will trust a small honest demo and will pick apart an
oversold one — and Rachel has already noted this team doesn't hand out
enthusiasm easily.

### Phase 1 — pilot (weeks 1–3)
Airtable sync running. All ~70 vetted reports ingested. Review queue live and
worked by an estimator. Taxonomy confirmed against real documents.

### Phase 2 — backfill and intelligence (weeks 4–8)
All 1,235 deliverables. Escalation index built and validated. Outlier rejection,
trend detection, and the confidence gate tuned against real output with Rachel.

### Phase 3 — the builder (weeks 9–12)
Cost Plan Builder, override capture, Excel export in DCW's deliverable format.

### Phase 4 — separate decision, later
Whether the intranet absorbs what Softr does today. Revisit with real usage data
in hand. Not now.

---

## 11. Risks worth naming

| Risk | Mitigation |
|---|---|
| **Scope inconsistency between estimators.** Two "A10 Foundations" lines may include different work — one loaded with GCs and contingency, one bare. This is the single biggest threat to data quality, and no amount of statistics fixes it. | Capture markup/contingency treatment as an explicit field per deliverable; filter on it; let the confidence gate widen CV and go amber when scope varies. Confirm the convention with Rachel (Q3). |
| Older deliverables (2024) are messy — Rachel's own note. | Ingest newest-first. Recency weighting matters more than volume for pricing anyway. |
| The estimating team doesn't adopt it. | The review queue puts their hands on the data early; the drill-down means they can always verify a number rather than trusting it. |
| Airtable API rate limits (5 req/sec) during backfill. | Batch, cache, and sync incrementally on `last_modified`. Not a real constraint at this scale. |
| Extraction errors quietly enter the library. | Confidence thresholds, human review below threshold, full provenance on every field, and reversible raw columns. |
| Scope creep into replacing Softr. | Explicitly deferred to Phase 4. Already agreed on the 9 September call. |

---

## 12. Open questions for Rachel

These block or reshape parts of the build. Worth twenty minutes at the 3pm.

1. **Is UniFormat coding consistent** across all years and all estimators? The
   `A10` in the plan we looked at suggests yes. If it's inconsistent, §5.2 grows
   a mapping layer and the pilot gets longer.
2. **Does every cost plan carry project GSF** on the cover sheet? `$/GSF` is the
   universal comparator — without GSF an observation can only be compared by
   percentage.
3. **How are markups, GCs, escalation, and contingency handled** — as line items
   inside the elemental breakdown, or as a separate block at the bottom? This
   determines whether line-item rates are bare or loaded, and it must be
   consistent to compare anything.
4. **Client confidentiality:** can any DCW employee see any client's numbers, or
   are some engagements restricted? Trish should weigh in.
5. **Box access:** service account, or per-user OAuth? Service account is
   simpler for the pipeline; per-user is stricter.
6. **Airtable plan tier** — record caps and API limits, so we size the sync
   correctly.
7. **Escalation index:** derive DCW's own from the archive, or subscribe to a
   published PNW index? Recommend deriving internally and cross-checking
   against ENR Seattle CCI.
8. **Version history:** when a deliverable was reissued, is the latest version
   the only one that counts, or is each issuance a legitimate observation?
   Recommend keeping all versions, flagged, and defaulting queries to the
   latest.

---

## 13. Immediate next steps

| Who | What |
|---|---|
| Rachel | Airtable account for Lacie + share the DCW and Cost Database bases (exclude the HR base with health insurance and 401k data) |
| Rachel | Answers to §12, especially Q1–Q3 |
| Lacie | Stand up Supabase, wire Entra ID sign-in, build the `/teamintranet` shell and admin panel |
| Lacie | Ingest 10–20 pilot documents; get one category rendering end to end for Friday |
| Both | Walk the Phase 0 demo before Friday, and agree what is explicitly *not* claimed to be finished |
