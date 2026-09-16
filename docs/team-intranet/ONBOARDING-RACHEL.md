# Handover — the DCW Cost Library

Written for Rachel, September 2026. Everything you need to work on this project
alongside Lacie: what to get access to, how the pieces fit, what is genuinely
built, and what is waiting.

You already have the hard part — you know what the tool needs to do. This is
about removing the friction between that and shipping.

---

## Part 1 · Access

### Lacie has to grant these — you cannot self-serve

| What | Why | How |
| --- | --- | --- |
| **Netlify** — site `dcwc` | Deploys, build logs, environment variables | Needs a **paid seat, $20/month**. Netlify → Team → Members → Invite |
| **Supabase** — project `vsjxkokabstpvltcaxwu` | The database, sign-in, uploaded files | Supabase → Project Settings → Team → Invite |
| **Intranet admin** | Approving accounts, triaging the wishlist | A row in `bootstrap_admins`, or Lacie promotes you from the Admin screen |

### You set these up yourself

| What | Notes |
| --- | --- |
| **Claude Code** | $20 Pro runs it with lower limits; $200 Max is what Lacie uses. Start on Pro and upgrade if you hit them |
| **GitHub** | You already have access to `DCW-Cost/dcwcost` — confirm you can open it |
| **Local clone** | Optional but worth it. See Part 5 |

### Already sorted, nothing to do

Entra ID app registration (DCW tenant), the domain gate, and your `@dcwcost.com`
sign-in to the tool itself.

---

## Part 2 · How the pieces connect

Thirty seconds here makes every later error message legible.

```
  You, prompting Claude Code
        │
        ▼
  GitHub  ──────────►  Netlify  ─────────►  dcwc.netlify.app
  (the code)           (builds & hosts)     (the live site)
        │
        └─ reads ──►  Supabase
                      (database · sign-in · uploaded files)
```

You push code to **GitHub**. **Netlify** notices, rebuilds, publishes.
**Supabase** holds the data and handles sign-in. Claude Code does the pushing.

**Two DCW websites exist and they are easy to confuse:**

| | What it is | Runs the intranet? |
| --- | --- | --- |
| `dcwcost.com` | the site you built through Microsoft | **no** |
| `dcwc.netlify.app` | this repo | **yes** |

Moving the tool to `dcwcost.com/teamintranet` later is a DNS change, not a
rebuild. Nothing in the code assumes a domain.

**The tool lives at** `https://dcwc.netlify.app/teamintranet/`

---

## Part 3 · What is actually built

Honest inventory. The distinction that matters is **real data vs demonstration
data**, and it is not uniform across the app.

| Screen | State |
| --- | --- |
| **Sign-in** (Microsoft / Entra ID) | **Real.** Working end to end on live accounts |
| **Admin** — approve, revoke, roles | Renders; the writes do not persist yet |
| **Wishlist** — file, vote, triage | **Real.** Writes to Supabase, genuinely persists |
| **Add Documents** — upload a cost plan | **Real.** Files land in private storage and queue for the reader |
| **How it works** — in-tool FAQ | Real, static content |
| **Cost Library** — elements, ranges, verdicts | Screens real, **every figure invented** |
| **Reader Queue** | Screens real, questions are fixtures |
| **Estimate Builder** | Designed, not built. Button honestly disabled |

### Two things that are genuinely real and worth knowing

**The statistics.** Outlier rejection (median absolute deviation on the log
scale), the green/amber/red confidence gate, and the trend test all actually run
and are covered by `npm test` — 23 tests. It is the *data* they run on that is
invented, not the maths.

**The security model.** Three gates: Entra ID authenticates against the DCW
tenant, the address must end `@dcwcost.com`, and an admin must approve the
account. Profiles are created by a database trigger, never by the app, so nobody
can insert themselves as an active admin.

### The reader does not exist yet

This is the biggest gap and the thing most likely to be misunderstood. **Uploading
a document stores it and queues it. Nothing reads it.** The three-pass reader is
specified in detail in `PLAN.md` §6 — comprehend the document's conventions,
extract line items, reconcile against the cover sheet — and none of it is written.

An `ANTHROPIC_API_KEY` is already set in Netlify, so the moment that worker exists
it has what it needs.

---

## Part 4 · Code deploys itself. Database changes do not.

**This is the single most confusable thing in the setup**, and it has already cost
an evening. Hold on to it.

| Change | How it reaches production |
| --- | --- |
| Code | Merge a PR → Netlify rebuilds → live in about two minutes |
| **Database** | **You run the SQL by hand in Supabase, once. Nothing automates this** |

Merging a PR puts a migration *file* in the repository. It does not execute it.
Netlify deploys code; it never touches Supabase. So a merge can ship code that
expects a column or a policy the database does not have yet — and the failure is
usually silent rather than loud.

**Migrations live in `docs/team-intranet/migrations/`, numbered, and are run in
order.** All of `001`–`003` are applied to the live project as of 16 Sept 2026.
If you add a new one, it is `004_…` and somebody runs it deliberately.

> Automating this is possible — the Supabase CLI plus a GitHub Action, so a merge
> runs new migrations itself. It is on the list, not yet built. It trades a human
> gate on production data for convenience, which is worth doing on a quiet day
> rather than mid-flight.

### The failure mode to recognise

**Row-level security does not raise an error when it refuses a write.** It filters
the rows out first, so an UPDATE or DELETE that policy forbids returns *success
with nothing changed*.

That is how the upload broke: `deliverables` had no UPDATE policy, `confirm.ts`
checked only for an error, and so the app reported "Stored" while the database had
done nothing. The document then showed as "Upload incomplete" with no explanation
anywhere.

**Any write you add should count its affected rows** — `.select()` makes the
result carry what actually changed, and zero rows means denied. Every write in
`documents/confirm.ts` does this now; copy that shape.

To see which policies a table has:

```sql
select cmd, count(*) from pg_policies
 where schemaname = 'public' and tablename = 'deliverables'
 group by cmd order by cmd;
```

Four rows — SELECT, INSERT, UPDATE, DELETE — is correct for `deliverables` today.

---

## Part 5 · Working on it

### The loop

**You prompt → Claude Code edits → commits → pushes → Netlify rebuilds → live.**

That is the whole thing. No separate build step, no deploy command.

Easiest start with no terminal: [claude.ai/code](https://claude.ai/code), connect
GitHub, pick `DCW-Cost/dcwcost`, and prompt from there.

**One rule:** work on a branch, not `main`. Claude Code does this by default.
`main` is what deploys.

> You do not need to learn to code first. The way this was built is: describe
> what you want in plain English, say you are not a developer, and ask for
> step-by-step instructions. That is a legitimate way to work — and faster than
> reading the codebase front to back before touching it.

### Running it on your own machine (optional, worth it)

```bash
git clone https://github.com/DCW-Cost/dcwcost.git
cd dcwcost
npm install
npm run dev          # http://localhost:4321
```

Create `.env` in that folder:

```
INTRANET_ENABLED=true
INTRANET_DATA=fixtures
INTRANET_EMAIL_DOMAIN=dcwcost.com
```

That is enough. **Leave the Supabase variables out** and it runs in demo mode
with invented data and treats you as an admin — perfect for trying things, and
the reason `INTRANET_ENABLED` exists so that mode can never reach a public URL.

`.env` is gitignored. Never commit it.

### Where things live

```
src/
  middleware.ts                every /teamintranet request passes through here
  lib/intranet/
    gate.ts                    the INTRANET_ENABLED master switch
    auth.ts                    Entra ID + session handling
    stats.ts                   outlier rejection, confidence gate, trend
    wishlist.ts                the wishlist (talks to Supabase directly)
    documents.ts               uploads
    data/types.ts              ← the DataProvider interface. The key seam
    data/fixtures.ts           invented demo data
  pages/teamintranet/          the screens
docs/team-intranet/
  PLAN.md                      the design, and why each decision was made
  HANDOFF.md                   architecture orientation
  ZEBEL-GAP.md                 capability roadmap from the Zebel evaluation
  migrations/                  SQL applied to the live database, in order
  deck/                        generators for the pilot deck and business model
```

### The one architectural idea to understand

**Pages never touch the database directly.** Every screen imports `provider` from
`src/lib/intranet/data/`. Swapping fixtures for real cost data means writing
`data/supabase.ts` against the `DataProvider` interface in `types.ts` and setting
`INTRANET_DATA=supabase`. No page changes.

The wishlist deliberately bypasses that seam and talks to Supabase directly — the
cost library has an excuse for being fake, a suggestion box does not.

---

## Part 6 · Good places to start

Ordered by how hard they are to get wrong.

1. **Wording.** Anything in `src/pages/teamintranet/` that reads awkwardly to an
   estimator. You are better placed than anyone to fix this. Zero risk.
2. **The FAQ.** `src/pages/teamintranet/faq/index.astro` is a plain list of
   questions and answers. Add the ones the team actually asks you.
3. **Wishlist triage.** You are an admin — prioritise, set target dates, add
   notes. No code at all, and it is what keeps the team engaged.
4. **A real feature.** Take the top-voted wishlist item and describe it to Claude
   Code. Mention `src/lib/intranet/data/types.ts`.

### The two biggest pieces of work, in order

**The extraction worker.** Turns a queued document into library rows. Everything
else is waiting on it — the Cost Library cannot show real numbers until documents
have been read. `PLAN.md` §6 specifies it.

**The Airtable backfill.** The cost plans are attachments on Airtable records, so
this is a scripted pull, not a person clicking 1,235 times. Needs
`AIRTABLE_API_KEY` and `AIRTABLE_BASE_ID`. Worth doing **after** the reader is
proven on a handful of real documents.

`ZEBEL-GAP.md` has the capability roadmap beyond that, drawn from the May Zebel
demo — per-line unit of measure, cross-project line comparison, comp toggles and
overrides-with-notes are the four your own estimators asked for by name.

---

## Part 7 · Things not to do

- **Never put the Supabase `service_role` / secret key in this project.** It
  bypasses every security policy in the database. The `anon` key is the one that
  belongs in the app, and it is safe in a browser *because* those policies exist.
- **Never grant admin through an environment variable.** Use `bootstrap_admins`,
  so a leaked build config cannot grant it.
- **Any new database view needs `security_invoker = true`.** Without it the view
  runs with its owner's privileges and reads straight past row-level security.
- **Do not add a `from = "/*"` catch-all to `netlify.toml`.** It breaks the
  contact form. The comment there is not decoration — the form was broken by
  exactly this once.
- **Never edit a migration that has already been applied.** Add a new numbered
  one instead.

---

## Part 8 · When something breaks

It will, and almost none of it is dangerous. The database holds real accounts, the
wishlist, and any uploaded documents; the cost figures are still invented.

| Symptom | Almost always |
| --- | --- |
| Build fails | Netlify → Deploys → click the red one → read the last 20 lines. Paste them into Claude Code |
| A page 404s | `INTRANET_ENABLED` is not `true` for that deploy context, or the build has not finished |
| "Invalid API key" | Wrong Supabase key. Must be the **anon/publishable** one, never the secret |
| A change did not appear | Environment variables need a **fresh deploy**. Saving alone does nothing |
| A write "succeeds" but nothing changed | A missing row-level-security policy. See §4 |

**Environment variables only take effect on a new build.** This catches everyone
at least once.

When stuck, paste the actual error text rather than describing it. That is the
single biggest difference between a fast answer and a slow one.

---

## Part 9 · Worth knowing before a conversation about it

**The numbers in the deck are now real.** Your own time-tracking analysis replaced
the largest placeholder in the business model: a cost report takes **18.9 hours**,
and **58.5% of that is report production** — nearly four times takeoff. That is
the bucket this tool attacks, and it is measured rather than asserted.

The one judgement left is that the Library removes 30% of report production →
3.3 hours a report, ~1,400 hours a year, about one FTE.

**What the tool does not do: 19 hours does not become 1.5.** Takeoff, QC, client
time and revisions are 7.8 of those 19 hours and the Library touches none of
them. If anyone quotes a figure like that, the arithmetic falls apart in front of
an estimator in about four seconds.

**Governance.** DCW's decision matrix puts a cost database as an internal
practice with the CEO (#46), and as something DCW sells with the Board plus TSC
veto (#47). The operating plan also currently parks AI plan reading as a
next-year *buy from a specialist* — which this contradicts. Worth naming
deliberately rather than drifting past.
