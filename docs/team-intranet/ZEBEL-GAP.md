# Zebel, and what it tells us to build

Source: the Zebel demo Hamid Hajian gave DCW on 20 May 2026 (74 minutes, Rachel,
Trish, Tim, Eric, Will attending).

This is a capability comparison, not a verdict. Zebel is a good product built by
an estimator over six years; several of the reactions in that room —
Trish on piles, Will on comparing asphalt across projects — are the clearest
statements of what DCW's estimators actually need that exist anywhere.

---

## The one-paragraph version

Zebel is far ahead on **estimating mechanics**: unit-of-measure flexibility,
progressive refinement from concept to CD, bid management, versioning. We are
ahead on **statistical honesty and document ingestion**: Zebel averages the comps
you pick and shows you the result, whereas this tool rejects outliers, measures
agreement, and refuses to price when the data does not support it. Zebel's
onboarding is *"send us your files and our former estimators will clean them"*,
which is a services answer to the problem our reader solves with software.

Those are complementary, not competing. The gap list below is mostly things worth
building regardless of what DCW decides about Zebel.

---

## What Zebel does that we do not

Ordered by how much their absence hurts. **P1** items came up unprompted from
estimators in the room, which is the strongest signal available.

### P1 — the estimators asked for these by name

**1 · Per-line unit of measure**
Zebel drives each line by whatever unit makes that line predictable: cost per
bedroom for finished carpentry, per unit for cabinets, per stall for parking, per
elevator stop for elevators, gross SF only where gross SF is right. Switchable per
line, recalculating instantly.

> *"We are not driving everything off gross square footage."*

We normalise everything to $/GSF. That is correct for comparing whole buildings
and wrong for a great many individual elements. **This is the single biggest gap.**

**2 · Compare one line item across projects**
Will's question, and we have no answer to it:

> *"If I want to compare asphalt pricing, but I don't remember which projects have asphalt."*

Today you must already know which projects to look at. That is precisely the
knowledge a new estimator does not have — and losing that knowledge is what the
operating plan is trying to fix.

**3 · Toggle individual comps on and off, per line**
Zebel shows each comparable's contribution and lets you drop one you know is not
representative. Ours shows a pooled result. Trish's piles example is the case:
one project had bored piles, another did not, so the conventional-footings numbers
are not comparable and an estimator needs to say so.

**4 · Overrides that carry a note, permanently**
Override a number in Zebel and it asks why, keeps the note against the project,
and automatically turns off the comps so the provenance is unambiguous. Months
later anyone can read why. We have no override path at all.

**5 · Notes on historical projects surfacing at the line level**
A note reading *"expensive crown molds"* appears next to that project's number
when it looks like an outlier — so the estimator can tell an anomaly from a
mistake. We reject outliers statistically but cannot say *why* one is odd.

### P2 — structurally important

**6 · A project metrics layer, not just costs**
Zebel stores acreage, unit counts, parking stalls, efficiency ratios, elevator
stops alongside the dollars, and offers them as hints when you are estimating:

> *"It's not just looking up the dollars from past projects, it's also looking up design metrics."*

Our schema has `gross_sf` and little else. Everything in item 1 depends on fixing
this first.

**7 · Escalation tables DCW controls**
Per market, per project type, backward and forward looking, from RSMeans or FRED
or DCW's own judgement — and applied identically for everyone, so a report does
not depend on who ran it. We hard-code a single rate.

**8 · Progressive refinement without switching templates**
Break a standard cost code into project-specific detail rows as design advances,
concept → DD → CD, in one continuous estimate. Directly answers Eric's reservation:

> *"When we start getting into more detailed DD and CD level estimates, we're still going to have to be hands-on."*

**9 · Budget source tagging**
Every line tagged historical / sub input / manual, with analytics showing the mix.
You watch "99% historical" fall toward "sub input" as real bids arrive, and
confidence rises with it. This pairs beautifully with our confidence gate — it is
the same idea applied to a different axis.

**10 · The four-step new-estimate wizard, with auto-suggested comps**
New-or-revision → template → comps → programming questionnaire. Zebel proposes
three comparables automatically. Standardisation via the workflow rather than a
policy document.

**11 · Version history and audit**
Every change, who made it, when. We have an `audit_log` table nothing writes to.

**12 · Versions, scenarios, phases and alternates**
Duplicate an estimate as revision 2, or as a parallel design scenario.

### P3 — valuable, later

**13 · Bid management** — bid packages, side-by-side tabs, attach the bid file,
plug missing scope in red, set a preferred bidder, insert into the budget.
Eric's *"30 to 40, maybe even half"* estimate of applicability suggests this
matters for the other half of DCW's work.

**14 · Customisable programming questionnaire** with Excel-style formulas.

**15 · Report output** with an assumptions section at the top — the design metrics
and inputs behind the estimate, printed alongside it. Hamid's reasoning is worth
quoting because every estimator recognises it:

> *"Six months later they come back… and you have to go back and say, what did I assume last go around? It wasn't even clear for myself what I assumed."*

**16 · Adjustment column** — apply a 40% premium to 50% of units, weighted
automatically.

**17 · Full CSV export** of everything, any time. Data ownership as a feature.

**18 · Hover hints** showing a metric's value across the chosen comps.

---

## What we do that Zebel does not

Worth being just as specific about, because it is the argument for continuing.

**1 · We refuse to answer when the data is bad.** Zebel takes the average of the
comps you picked. If those two projects disagree by 3×, it averages them anyway
and shows a confident number. We reject outliers, measure agreement, and return
*nothing* when the evidence does not support a price — with the reason attached.

**2 · Outlier rejection.** Automatic, on every element, using the median rather
than the mean, so one extreme value cannot hide behind the average it is
distorting.

**3 · We read messy historical documents.** Zebel's answer to a decade of
inconsistent spreadsheets is a services team of former estimators who clean and
load them for you, priced per project. Ours is a reader that works out each
document's conventions and asks when it cannot. **This is the real
differentiator**, and it is the thing DCW's own operating plan parks as *"a buy
from a specialist, not an in-house build."*

**4 · It asks rather than assumes**, and records who answered.

**5 · Trend detection** — whether an element's pricing is genuinely moving, tested
for significance rather than eyeballed.

**6 · It is ours.** No per-year fee, no vendor roadmap, no export-and-migrate if
the relationship ends.

---

## Suggested build order

Each phase is useful on its own — none of it is a prerequisite for a demo.

| Phase | Build | Why here |
| --- | --- | --- |
| **A** | Project metrics layer (6) | Everything in phase B needs it |
| **B** | Per-line unit of measure (1) · comp toggles (3) · overrides with notes (4) | The three the estimators named |
| **C** | Cross-project line comparison (2) · project notes at line level (5) | Answers Will's question |
| **D** | Escalation tables (7) · budget source tagging (9) | Consistency and confidence |
| **E** | Progressive refinement (8) · new-estimate wizard (10) | Answers Eric's reservation |
| **F** | Version history (11) · scenarios (12) · report assumptions (15) | Professional polish |
| **G** | Bid management (13) | Largest, most separable |

**Do not start any of this before the reader works.** Every capability above
operates on historical data, and we do not have any yet. A perfect unit-of-measure
system over invented numbers is worth nothing.

---

## The commercial question

Zebel enterprise runs **$30,000–60,000/year**, plus a variable "quick start"
onboarding fee based on how many projects you load and how messy they are, plus an
optional concierge tier. Unlimited users at every tier.

Hamid's framing was that this is *"not even 25% of hiring another seasoned
estimator"* — which is a fair way to price it.

Three things to have straight before this reaches a room:

1. **It is a Board decision.** $30–60k/year sits well above the $20k CEO limit in
   DCW's own governance matrix (item #13), and Board items need roughly two months
   of lead time. It cannot be decided in the moment.
2. **The operating plan already has an opinion**, and it points the other way:
   AI plan reading is parked as *"a buy from a specialist, not an in-house build"*,
   and Block 02 says explicitly *"no plan-reading or computer-vision layer."*
   Whichever direction DCW goes, someone should say out loud that the plan is
   being changed rather than drifting past it.
3. **The honest comparison is not "build vs buy" — it is "build vs buy vs both."**
   Zebel is strong at estimating mechanics and weak at ingesting a messy archive.
   This tool is the reverse. A DCW that had both would be genuinely unusual; a DCW
   that had to choose should choose based on which problem is actually costing it
   more, and the hours-per-estimate baseline (operating plan task T-21) is what
   would tell you that.
