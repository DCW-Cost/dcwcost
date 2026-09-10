# DCW Team Intranet + Historical Cost Database

**Build plan — v2, 10 September 2026**
Prepared from the Rachel/Lacie calls of 9 September and 12 March.

> **Changed in v2.** Ingestion is now built around an **AI reader** that
> comprehends each cost plan before extracting from it — modelled on the
> MediaPact reader for media kits and rate cards. It asks when it can't
> decipher a coding system, proposes an assumption and requests confirmation
> when a plan has no gross area, and works out for itself which figures in a
> document are the real source of truth when markups and contingencies are
> handled inconsistently. Client confidentiality tiering is removed: every team
> member sees every client, matching how Airtable works today. Sections 5, 6, 7,
> 9, 11 and 12 changed; §6 is substantially new.

---

## 1. What we're building

A password-protected area of `dcwcost.com` at **`/teamintranet`** where DCW
employees log in and query every cost line item the firm has ever issued.

The product is not "a database with a search box." It is a tool that answers the
estimator's real question:

> *"I'm pricing foundations on a 45,000 SF healthcare project in Seattle at DD.
> What have we actually charged, is that number trustworthy, and where is it
> heading?"*

Four capabilities make that possible:

1. **Read.** An AI reader works through each historical cost plan the way an
   experienced estimator would — establishing what kind of document it is, how
   it's coded, what it's priced against, and where its markups live — before it
   extracts a single number. Where it can't resolve something, it asks a person
   rather than guessing.
2. **Normalize.** Every line item is converted into the unit the estimator asks
   for — `$/SF`, `$/CY`, `$/LF`, `% of total` — regardless of how it was
   originally priced, and onto a consistent bare-or-loaded basis regardless of
   how that document handled markups.
3. **Judge.** The tool reports a range, discards statistical anomalies, and
   states plainly whether the underlying data is good enough to price from.
   When it isn't, it says *"insufficient data — price this manually."*
4. **Project.** Where pricing has moved consistently over time, the tool
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
  Supabase / Postgres  ◄──── the Cost Reader ◄──── Box (source documents)
     │   projects (mirror) · deliverables · document_frames · line_items
     │   taxonomy · units · cost_indices · reader_questions
     │   reader_conventions · estimator_notes · audit
     │
     ▼
  /teamintranet  (Astro SSR on the existing dcwcost.com Netlify site)
     Cost Library · Cost Plan Builder · Reader Queue · Admin
```

Airtable remains authoritative for anything a human types. Postgres is
authoritative only for what the reader extracts from cost documents. There is
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
| `admin` | Everything, plus approve/revoke users, answer reader questions, edit learned conventions, view the audit log |
| `estimator` | Query the library, build cost plans, answer reader questions |
| `viewer` | Query the library read-only |
| `pending` | Holding page only |

Every rule above is enforced in Postgres **row-level security**, not in the UI.
RLS is deny-by-default on every table; a bug in an Astro page cannot leak a row
that policy forbids. The service-role key never reaches the browser — all
database access goes through server-rendered routes and server endpoints.

**All active users see all clients.** This matches how Airtable works today, so
the intranet introduces no exposure that doesn't already exist. The access
question is therefore binary — approved, or not — which keeps both the policy
and the code simple.

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
- **`document_frames`** — **new in v2.** The reader's comprehension of a single
  document, recorded before any line item is extracted: coding system, gross
  area and where it came from, markup structure, pricing base date, whether the
  document reconciles. Every downstream number depends on this being right, so
  it is stored explicitly, with a confidence per field, rather than being
  implicit in the extraction. See §6.2.
- **`line_items`** — the observation. Keeps *both* the raw and the normalized
  form of everything: `raw_description` next to `taxonomy_code`, `raw_uom` next
  to `uom_canonical`, and the as-written rate next to the bare-basis rate. The
  raw columns are never overwritten, so a bad mapping — or a wrong assumption
  later corrected — is always recoverable and always auditable.
- **`estimator_notes`** — assumptions, exclusions, clarifications attached to a
  line item. This is Rachel's *"everything every estimator has said"*
  requirement, and it is the thing that makes the tool trusted rather than
  merely correct.
- **`reader_questions`** and **`reader_conventions`** — **new in v2.** What the
  reader asked, what a human answered, and the rules learned from those answers.
  See §6.4 and §6.5.

### 5.2 The taxonomy

`a 10 foundations` in the plan Lacie read out on the call is **UniFormat II
(ASTM E1557) code A10 — Foundations**, so at least some of the archive is
already coded to the standard. **UniFormat is the spine** (Levels 1–3), with CSI
MasterFormat carried as a secondary mapping for trade-level detail.

In v1 this plan treated "is UniFormat used consistently?" as a blocking
question. It isn't any more. The reader establishes the coding system per
document, maps whatever it finds onto the spine, and asks when it can't —
see §6.4. Inconsistency across the archive is now an expected condition the
system handles, not a precondition for starting.

### 5.3 Normalization — the hard part

Rachel put her finger on the real difficulty: *"you can't have mixed units in
the same sort of… it just kind of makes it messy."* She's right, and the fix is
to stop trying to force one unit and instead compute **three parallel
normalizations** for every line item:

| Normalization | Always computable? | Good for |
|---|---|---|
| **`$/project GSF`** | Yes, whenever gross area is known | The universal comparator — works for lump sum, LF, CY, everything |
| **`% of project total`** | Yes | Sanity-checking scope and mix; the `3%` in the plan on the call |
| **`$/native unit`** | Only when a quantity is present | Apples-to-apples within a unit family (CY of concrete vs. CY of concrete) |

`$/GSF` is the unlock. It is DCW's own existing convention, and it sidesteps the
lump-sum problem entirely: a lump-sum elevator package can't be converted to
`$/EA` without a count, but it absolutely can be expressed as `$/GSF` of the
building. Every observation gets a comparable number.

The `units` table handles genuine unit math within families — SF↔SM, LF↔LM,
CY↔CF, TON↔LB. **It deliberately does not convert across families.** A lump sum
is not secretly 400 lineal feet, and the tool will never pretend otherwise; it
reports `$/GSF` and `%` for that row and marks `$/native unit` as not
applicable.

### 5.4 The fourth normalization: bare vs. loaded

**New in v2**, and the direct answer to *"if markups or contingencies are
handled in different ways, the AI should discern which data points are the
correct sources of truth."*

The problem is real and it is the biggest threat to data quality in the whole
project. If one estimator's `A10 Foundations` line is $10.59/SF bare, and
another's is $13.20/SF already carrying general conditions, fee and design
contingency, then pooling them produces a number that is wrong in a way nobody
can see.

So the reader determines, per document, **where the markups live** — applied
inside each element line, or added as a block at the bottom — and what the stack
consists of (general conditions, GC's fee, design and construction contingency,
escalation, bond and insurance). From that it derives a single **markup factor**
for the document.

Each line item then stores both:

- `unit_cost` — exactly as written in the document, never altered
- `bare_unit_cost` — the same rate reduced to a bare basis using the document's
  markup factor

The library pools on the **bare** basis by default, which is the only basis on
which the archive is internally consistent. The estimator can toggle to a loaded
view, and the tool applies a current markup stack to the bare median rather than
averaging a mix of the two. Which markups were stripped is shown on every result
and on every source row, so the arithmetic is never hidden.

When the reader can't determine the markup structure with confidence, that
document's rates are tagged `basis = unknown`, held out of the default pool, and
raised as a question.

### 5.5 Escalation

Comparing a 2024 dollar to a 2026 dollar without adjustment produces garbage,
and it silently corrupts trend detection. Every observation is escalated to
today before it is pooled.

One subtlety the reader handles: **a document's pricing base date is often not
its issue date.** Estimates are frequently priced to a projected midpoint of
construction, and escalating from the wrong date introduces error in exactly the
dimension we're trying to measure. The reader captures the stated base date from
the document, falls back to the issue date when none is given, and records which
it used.

`cost_indices` holds a quarterly index per region. Start by deriving DCW's own
internal index from repeat line items in its own archive — that measures DCW's
actual market, not a national average — and cross-check it against ENR's Seattle
CCI. Store the index version used on every computed result so a number can
always be reproduced.

---

## 6. The Cost Reader

**Substantially new in v2.** The model here is the MediaPact reader for media
kits and rate cards: point it at a document nobody standardized, and it works
out the structure rather than requiring one.

A DCW cost plan is harder than a rate card in one specific way — the numbers on
the page only mean something in the context of how the document was built. The
same `$13.20` is a different fact depending on whether it's loaded, what area
it's priced against, and what date it's priced to. So the reader is built
around a rule: **understand the document before extracting from it.**

### 6.1 Getting the documents

Airtable's Cost Database base already links every deliverable to its Box file —
that work is done. The pipeline reads that table via the Airtable API, follows
`project_folder_link` into Box, and pulls the `.xlsx` or `.pdf` via a Box
service account.

Rachel's `report uploaded` view (~70 vetted records) is the pilot set. The full
grid view (1,235 deliverables) is the backfill.

Excel and PDF are prepared differently before the reader sees them. Excel is
read cell-by-cell with structure and formulas intact, which preserves far more
signal than flattening to text — a formula like `=D12*1.18` is direct evidence
of a markup. PDFs get their text layer extracted first, with OCR reserved for
genuinely scanned documents.

### 6.2 Pass one — comprehend the document

Before extracting anything, the reader establishes the document's **frame** and
writes it to `document_frames`:

| What it determines | Why it matters |
|---|---|
| Deliverable type | An estimate review must never be pooled with DCW's own pricing |
| Coding system in use | UniFormat, MasterFormat, an in-house scheme, or none |
| Gross area, and its source | The denominator for every `$/GSF` figure |
| Markup structure and factor | Whether element rates are bare or loaded (§5.4) |
| Pricing base date | The starting point for escalation (§5.5) |
| Stated project total | The check figure for pass three |

The reader has tools available while it does this — it can search the document
for a term it expects but hasn't found, and it can look the project up in
Airtable to cross-check an area or a delivery method against what DCW already
recorded. That cross-check is what turns a blind guess into a supportable
assumption.

Every field in the frame carries its own confidence and a note on where the
answer came from.

### 6.3 Pass two — extract against the frame

Only now does the reader pull line items, and it does so knowing what the
document's conventions are. Two rules keep this trustworthy:

1. **The reader interprets; it never calculates.** It decides what a figure
   *means* — which code it belongs to, whether it's loaded, what it's priced
   against. Every number that enters the library as arithmetic (unit
   conversions, markup stripping, escalation, every statistic) is computed
   afterwards in SQL or Python from values the reader read off the page. A
   reader that isn't allowed to do math can't get math wrong.
2. **Provenance on every field.** Sheet name and cell range, or PDF page, plus a
   confidence score. Every number in the library traces back to the exact spot
   in the exact document it came from.

### 6.4 Pass three — reconcile, then ask

The reader sums what it extracted and compares it against the document's stated
total. This is the single most valuable check in the pipeline, because it is
deterministic and it catches the failure modes that matter: a missed section, a
double-counted subtotal, a misread markup.

Anything the reader could not resolve — including a reconciliation it can't
explain — becomes a **question**, never a silent guess. Questions come in two
lanes:

**Blocking questions** hold the document out of the library until answered:

> **Coding system unrecognized.** This plan's rows look like
> `03 30 00 — Cast-in-place concrete`. That's MasterFormat, not the UniFormat
> used in most of the archive. Map these onto UniFormat, or keep them as
> MasterFormat detail under a UniFormat parent?

> **Markup basis undetermined.** There's a 22% block at the bottom labelled
> "GC's / Fee / Contingency", but three element lines on p.4 appear to already
> include their own contingency. I can't tell whether that block applies to
> everything or only to the unmarked elements. Which is it?

**Assumptions awaiting confirmation** don't block — the reader proposes an
answer, states its evidence, and the data is usable while it waits:

> **No gross area on the cover sheet.** I found `62,400 SF` in the summary block
> on page 2, and the elemental totals reconcile against it to within 0.3%.
> Airtable records 62,400 SF for this project. **Assuming 62,400 GSF** —
> confirm?

> **Pricing base date not stated.** The escalation line references
> "midpoint Q2 2027", so I've taken the base date as the issue date and treated
> escalation to Q2 2027 as a markup rather than as the base. Confirm?

An assumption that goes unanswered stays visible on every result derived from
it. If it is later corrected, the affected rows are recomputed — this works
precisely because raw values are never overwritten (§5.1).

### 6.5 Answers teach the reader

This is what makes 1,235 documents tractable rather than exhausting.

When Rachel answers *"yes, Brian's 2024 plans use MasterFormat, map them this
way,"* that resolution is stored in `reader_conventions` as a rule scoped to
what it actually depends on — an estimator, a template fingerprint, a date
range, a client. Every subsequent document matching that scope applies the rule
automatically and does not ask again.

Practically, this means question volume should fall sharply as the backfill
proceeds: the first few dozen documents from an era teach the reader that era's
conventions, and the rest run clean. Conventions are visible and editable in
the Admin panel, and every line item records which conventions were applied to
it, so a convention that turns out to be wrong can be corrected and its
consequences replayed.

### 6.6 The Reader Queue

Questions and pending confirmations surface in the intranet as a working
screen: the reader's question on the left with its evidence, the source document
on the right, answer and move on. Estimators and admins can both work it.

This is not just data hygiene. It is how the estimating team comes to trust the
tool — they will believe numbers they have personally adjudicated, and they will
not believe numbers that appeared by magic. Budget real time for it, especially
in Phase 1.

### 6.7 What the backfill costs

Lacie's concern on the call — *"if the volume of these estimates isn't going to
trip any sort of blocks and charge us an exorbitant amount of money"* — deserves
a real number rather than a shrug.

The three-pass reader costs meaningfully more than v1's single-shot extraction,
because the document is read more than once. Recommended architecture splits the
work by what it actually demands: **judgment passes on Opus 5** (framing the
document, reconciling, deciding what to ask) and **the mechanical extraction
pass on Sonnet 5**, which is following a frame that has already been
established.

Worst case, assuming **every** one of the 1,235 documents goes through the full
three passes with no Excel shortcuts and no caching:

| Approach | Reading | Writing | Total, once |
|---|---|---|---|
| **Mixed, batched** — recommended | $76 | $60 | **≈ $136** |
| Mixed, standard rates | $151 | $121 | **≈ $272** |
| All Sonnet 5, batched — cheapest | $32 | $43 | **≈ $75** |
| All Opus 5, standard — the ceiling | $161 | $216 | **≈ $377** |

**The entire two-year backfill costs between $75 and $375, once.** The 70-document
pilot is under $25.

Two things push the real figure toward the bottom of that range. The document
text is re-sent across all three passes, which is exactly what prompt caching is
for — cached reads cost about a tenth of fresh ones. And most DCW deliverables
come from DCW's own Excel templates, where a template-fingerprint parser handles
the mechanical extraction pass at no model cost at all, leaving the reader to do
only the framing and the reconciliation.

Roughly double v1's estimate, for a system that understands what it's reading.
It remains a rounding error against a single estimator-hour, and it should not
be treated as a budget question on Friday.

---

## 7. The analytics engine

This is the part that makes it a tool rather than a filing cabinet.

An estimator queries: *category + target unit + basis + filters* (sector,
region, GSF band, delivery method, design phase, date range). The engine:

1. **Filters** to comparable observations — including by deliverable type, so
   estimate reviews never contaminate DCW's own pricing, and excluding any
   document whose markup basis the reader couldn't determine.
2. **Puts everything on one basis** — bare by default (§5.4), with the applied
   markup stack shown.
3. **Escalates** every observation to today's dollars from its own pricing base
   date (§5.5).
4. **Log-transforms.** Construction costs are right-skewed and roughly
   log-normal; running statistics on raw dollars overstates the mean and
   mislabels legitimate high-end projects as outliers.
5. **Rejects outliers** using **median absolute deviation**, modified z-score
   `|Mz| > 3.5`, with a 1.5×IQR fence as a cross-check. *Not* mean ± 2σ — that
   test is unreliable at the sample sizes involved (often n < 20) and lets a
   single extreme value drag the threshold out past itself.
6. **Reports** n, median, mean, p10 / p25 / p75 / p90, min, max, and coefficient
   of variation — plus every excluded outlier, named, with the reason. Nothing
   is thrown away invisibly.
7. **Detects trend** with a **Theil–Sen** estimator on escalation-neutral
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
| 🟢 **Green** | n ≥ 8 after outlier removal · CV ≤ 0.25 · ≥ 3 distinct projects · ≥ 2 distinct estimators · most recent observation within 18 months · no unconfirmed reader assumptions in the pool | Price from this |
| 🟡 **Amber** | n 4–7, or CV 0.25–0.50, or newest observation 18–36 months old, or some observations rest on unconfirmed assumptions | Useful, but apply judgment |
| 🔴 **Red** | n < 4, or CV > 0.50, or all observations from a single project or single estimator | Insufficient — research and price manually |

Three design rules that matter more than the thresholds:

- **The reason always ships with the colour.** Never a bare red light — always
  *"Red: only 2 observations, both from Ballard Library, 2024."* An estimator
  can act on that; they cannot act on a colour.
- **Unconfirmed assumptions are visible in the result.** If three of eleven
  observations rest on an assumed gross area the reader hasn't had confirmed,
  the result says so and offers a one-click jump to confirm them. Answering
  the question can move the light from amber to green on the spot.
- **The thresholds are configurable by an admin and versioned.** Rachel and the
  estimating team will want to tune them once they see real output, and they
  should be able to without a deploy.

### Drill-down

Every statistic is clickable, down to the list of source observations: project,
client, estimator, date, phase, the original description, the markups stripped,
the assumptions applied, the estimator's own notes, and a link straight to the
document in Box. That drill-down *is* Rachel's *"everything every estimator has
said about each line item"* — delivered.

---

## 8. What the estimator actually uses

**Cost Library** — search or browse the UniFormat tree. Pick a target unit and
basis. Set filters. Get the statistics card, the confidence light, the trend,
and the source list.

**Cost Plan Builder** — the payoff, and the "automate inputs for future cost
plans" requirement. Enter the project shell (GSF, sector, region, phase,
delivery method). The tool generates a UniFormat line-item template with a
suggested rate per element, each carrying its own confidence light and its own
drill-down. The estimator accepts, overrides, or leaves red items blank to price
by hand — and every override is captured with a reason, which becomes signal for
the next version. Export to DCW's Excel deliverable format.

**Reader Queue** — the reader's open questions and pending confirmations,
worked against the source document side by side (§6.6).

**Admin** — user approval and revocation, role assignment, reader conventions,
ingest run history, confidence thresholds, escalation index management, audit
log.

---

## 9. Security and data privacy

Cost data is DCW's most commercially sensitive asset. Non-negotiables:

- **Entra ID SSO**, domain-locked, plus explicit admin approval. Two gates, not
  one.
- **RLS deny-by-default on every table.** Policy lives in the database. The
  service-role key never reaches the browser.
- **All active users see all clients** — as they do in Airtable today. No
  per-client tiering is being built. If a future client contract ever requires
  ring-fencing, it's a flag on `projects` and one additional policy clause, but
  building it speculatively would add friction for a problem DCW doesn't have.
- **Documents stay in Box.** The database stores extracted values and links, not
  copies of client deliverables. This deliberately keeps DCW's document
  ownership story exactly where it is today, which was Rachel's concern.
- **API, not consumer tooling.** The reader runs through the Anthropic API,
  where inputs and outputs are not used for model training by default. This is
  the material difference from pasting client cost plans into a chat window, and
  it's worth stating plainly to the team on Friday.
- **Full audit log** — every query, every export, every reader answer, every
  admin action, with actor and timestamp. Reader answers are attributed, because
  a convention learned from a wrong answer needs to be traceable to who gave it.
- **Backups.** Supabase point-in-time recovery. Airtable remains the independent
  operational record, so no single failure loses both.

---

## 10. Phasing

### Phase 0 — the Friday demo (this week)

Scope deliberately narrow and deliberately honest:

- `/teamintranet` live behind Microsoft sign-in, with real accounts for Rachel,
  Trish, Brian, and Lacie, and the approval panel working.
- 10–20 hand-picked deliverables from the `report uploaded` view, read end to
  end — **including at least one document that makes the reader ask something**,
  so the queue is demonstrated rather than described. A plan with no stated
  gross area is the ideal candidate: it shows the assumption, the evidence, and
  the confirmation in one screen.
- **One or two UniFormat categories deep** — A10 Foundations and B20 Exterior
  Enclosure are good candidates — showing the full loop: query → normalized
  range → confidence light → drill-down → link to the source document in Box.

Show it as a prototype on twenty documents, not a finished product on 1,235.
The estimating team will trust a small honest demo and will pick apart an
oversold one — and Rachel has already noted this team doesn't hand out
enthusiasm easily.

### Phase 1 — pilot (weeks 1–3)
Airtable sync running. All ~70 vetted reports read. Reader Queue live and worked
by an estimator — this is where the archive's real conventions get discovered
and taught. Taxonomy and markup handling confirmed against actual documents.

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
| **The reader frames a document wrongly and does it confidently.** A misread markup structure or gross area corrupts every line item in that document, and it corrupts them plausibly. | The reconciliation check in §6.4 catches most of it deterministically — a wrong frame usually fails to add up. Beyond that: frames are stored explicitly with per-field confidence, low confidence goes to the queue, and raw values are never overwritten so a corrected frame replays cleanly. |
| **Question fatigue.** If the reader asks about every document, nobody works the queue and the project stalls. | Learned conventions (§6.5) are the answer — the point is that question volume falls as the backfill proceeds. Track questions-per-document as a headline metric during Phase 1; if it isn't dropping, the convention scoping is wrong and needs fixing before Phase 2. |
| **A wrong answer teaches a wrong convention** and propagates silently. | Conventions are visible and editable in Admin, every line item records which were applied, answers are attributed in the audit log, and corrections replay. |
| Older deliverables (2024) are messy — Rachel's own note. | Ingest newest-first. Recency weighting matters more than volume for pricing anyway, and the reader learns recent conventions before it meets the awkward ones. |
| The estimating team doesn't adopt it. | The Reader Queue puts their hands on the data early and makes them the authority; the drill-down means they can always verify a number rather than trusting it. |
| Airtable API rate limits (5 req/sec) during backfill. | Batch, cache, and sync incrementally on `last_modified`. Not a real constraint at this scale. |
| Scope creep into replacing Softr. | Explicitly deferred to Phase 4. Already agreed on the 9 September call. |

---

## 12. Questions

### Answered — 10 September

- **Does every cost plan carry gross area?** Doesn't need to. The reader looks
  for it, cross-checks Airtable, proposes an assumption with its evidence, and
  asks for confirmation. Documents without a stated area are ingestible.
- **How are markups and contingencies handled?** Inconsistently, and that's now
  the reader's job rather than a precondition. It determines the structure per
  document, derives a markup factor, and stores both the as-written and bare
  rates so the library can pool on one basis (§5.4).
- **Is UniFormat coding consistent?** No longer blocking. The reader identifies
  the coding system per document, maps what it finds, and asks when it can't
  (§6.4). Still useful to know roughly how mixed the archive is, for sizing
  Phase 1 — but it no longer gates the build.
- **Who can see which clients?** Everyone sees everything, matching Airtable
  today. No confidentiality tiering is being built (§9).

### Still open

1. **Who answers reader questions?** A designated estimator, Rachel, or whoever
   owns the project? This is an operational decision that shapes the queue's
   routing and notifications, and it matters more than it sounds — the queue
   only works if someone owns it.
2. **What reconciliation tolerance counts as clean?** A ±1% gap between summed
   line items and the stated total is probably rounding; ±8% is a missed
   section. Rachel's judgment on where the line sits will save a lot of noise.
3. **Box access:** service account, or per-user OAuth? Service account is
   simpler for the pipeline; per-user is stricter.
4. **Airtable plan tier** — record caps and API limits, so we size the sync
   correctly.
5. **Escalation index:** derive DCW's own from the archive, or subscribe to a
   published PNW index? Recommend deriving internally and cross-checking
   against ENR Seattle CCI.
6. **Version history:** when a deliverable was reissued, is the latest version
   the only one that counts, or is each issuance a legitimate observation?
   Recommend keeping all versions, flagged, and defaulting queries to the
   latest.

---

## 13. Immediate next steps

| Who | What |
|---|---|
| Rachel | Airtable account for Lacie + share the DCW and Cost Database bases (exclude the HR base with health insurance and 401k data) |
| Rachel | Answers to §12 "still open", especially Q1 and Q2 |
| Rachel | If possible, flag 2–3 documents you already know are awkward — a missing area, an odd markup block, unusual coding. They're the most valuable pilot inputs, because they exercise the reader rather than flatter it. |
| Lacie | Stand up Supabase, wire Entra ID sign-in, build the `/teamintranet` shell and admin panel |
| Lacie | Build the reader's three passes; run 10–20 pilot documents; get one category rendering end to end for Friday |
| Both | Walk the Phase 0 demo before Friday, and agree what is explicitly *not* claimed to be finished |
