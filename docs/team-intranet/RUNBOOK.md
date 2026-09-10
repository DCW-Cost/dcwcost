# Runbook — what to do next, in order

Written for Lacie. Every step says what to click, what you should see, and what
it means if you see something else. Nothing here needs a terminal.

**Tonight's goal:** the wishlist board working for real at tomorrow's meeting,
and — if the API key lands in time — one real cost plan read end to end.

Times are honest estimates, not optimism.

---

## Step 1 · Run the migration (5 minutes) — REQUIRED

This creates the wishlist tables and the document-upload plumbing. Without it,
the wishlist page loads but tells you it has nowhere to store anything.

1. Go to [supabase.com](https://supabase.com) → your project (`vsjxkokabstpvltcaxwu`)
2. Left sidebar → **SQL Editor** → **New query**
3. Open [`migrations/001_wishlist_and_uploads.sql`](migrations/001_wishlist_and_uploads.sql)
   and copy the **whole file**
4. Paste it in and hit **Run**

**You should see:** `Success. No rows returned.`

**If you see an error** mentioning `is_active_user does not exist` — the main
`schema.sql` has not been applied. That would be surprising, since sign-in works,
but that is what it means.

**If you see** `type "wishlist_kind" already exists` — you already ran it. Nothing
is broken; skip to step 2.

### Check it took

Do **not** re-run the migration to check it. Open
[`migrations/001_verify.sql`](migrations/001_verify.sql), copy the whole thing
into a **New query**, and Run. This one returns rows.

| item | expected |
| --- | --- |
| wishlist tables | `3` |
| wishlist policies | `13` |
| **v_wishlist invoker** | **`true`** |
| deliverables columns | `6` |
| storage bucket | `1` |
| **bucket is private** | **`true`** |

The two bold rows are the ones that matter. A view without `security_invoker`
runs with its owner's privileges and reads past every security policy beneath
it; a public bucket puts client cost plans on a guessable URL with no sign-in.
If either says `false`, stop and tell me.

---

## Step 2 · Create the Anthropic API key (10 minutes)

This is what lets the reader actually read a document. Everything else about
ingestion is built; this is the missing piece.

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Sign up **with your DCW address** (`lacie@dcwcost.com`), not a personal one.
   This is the account that will hold DCW's usage and billing, so it should be
   DCW's from the start rather than migrated later.
3. **Settings → Billing** → add a payment method and buy the smallest credit
   amount offered. Reading the whole 1,235-document archive costs on the order of
   $75–375 as a one-off, so you are not committing to much.
4. **Settings → API keys → Create key.** Name it `dcw-cost-library`.
5. Copy it. It starts `sk-ant-`. **You will not be shown it again.**

**Do not paste it into a chat, a document, or the repo.** It goes in one place:

### Put it in Netlify

1. [app.netlify.com](https://app.netlify.com) → site **dcwc**
2. **Site configuration → Environment variables → Add a variable**
3. Key: `ANTHROPIC_API_KEY`  ·  Value: the `sk-ant-…` key
4. Scopes: tick **Deploy previews** (and Production later, when this goes live)
5. Save

**How you know it worked:** the amber "The reader is not switched on yet" banner
on the Add Documents page disappears after the next deploy.

---

## Step 3 · Redeploy (2 minutes)

Environment variables only take effect on a new build.

1. Netlify → **Deploys**
2. **Trigger deploy → Deploy site**
3. Wait for the green tick, then open
   `https://deploy-preview-1--dcwc.netlify.app/teamintranet/wishlist/`

**You should see:** the board, with a working "File something" form and no red
banner. File a test item and vote for it. If the count goes to 1 and survives a
refresh, it is genuinely persisting.

---

## Step 4 · Seed the board before the meeting (10 minutes)

An empty board at a meeting gets an empty response. A board with six real items
gets people arguing about priority, which is what you want.

File these yourself — they came out of the Zebel call and are things the team
already said they need:

| Type | Title |
| --- | --- |
| Idea | Price per unit, per stall, per bedroom — not just per square foot |
| Idea | Compare one line item across projects without knowing which had it |
| Idea | Escalation tables we control, per market and project type |
| Idea | Turn a finished estimate back into library data |
| Idea | Break a cost code into detail rows as design progresses |
| Bug | "New estimate" does nothing |

Then in the meeting: **do not present the board. Open it and ask people to file
something while you are all sitting there.** A wishlist with the team's own words
on it by 11:30 is worth more than any slide.

---

## Step 5 · Get Rachel building (20 minutes, with her)

See [`ONBOARDING-RACHEL.md`](ONBOARDING-RACHEL.md) — it is written for her, so
send her the link rather than relaying it.

The one thing only you can do: **add her to Netlify**, which needs a paid seat
($20/month). Netlify → **Team → Members → Invite**. Everything else she can set
up herself.

---

## Step 6 · Test the reader on one real document (only if step 2 is done)

1. Find a cost plan you already know is messy — a missing gross area, an odd
   markup block, MasterFormat coding. **Pick an awkward one on purpose.** A clean
   document flatters the reader instead of testing it.
2. Go to **Add Documents**, drop it in, type the project name, and upload.
3. It queues. The extraction worker is not written yet, so it will sit at
   "Waiting to be read" — that part is honest and visible on the screen.

**Be clear about what this means:** uploading works and storage works tonight.
Turning a queued document into library rows is the next build, not a
configuration step. Do not promise the team otherwise in the morning.

---

## What is genuinely working after all this

| Thing | State |
| --- | --- |
| Microsoft sign-in, admin approval | Working, on real accounts |
| Wishlist — file, vote, triage | **Working, real database, persists** |
| In-tool FAQ | Working |
| Document upload and storage | Working |
| Reading an uploaded document | Not built — needs the extraction worker |
| Airtable bulk backfill | Not built — needs `AIRTABLE_API_KEY` + the job |
| Cost library figures | Still invented demo data |
| Estimate Builder | Designed, not built. Button honestly disabled |

---

## Answers to the things you were asked on the call

**"Is it pulling in an industry pricing database?"**
No. There is no external pricing source wired in and never has been. The demo
numbers are invented — plausible-shaped, not sourced. Nobody should treat them as
benchmarks. Connecting a published index (RSMeans, or FRED for escalation) is
possible and is a reasonable roadmap item, but it is not there today.

**"How will it ingest what is in Airtable?"**
A scripted pull, not a person clicking. The cost plans are attachments on Airtable
records, so the job walks the base, fetches each attachment, and queues it exactly
as a manual upload does. It needs `AIRTABLE_API_KEY` and `AIRTABLE_BASE_ID`, and
it is not written yet. Worth doing **after** the reader is proven on a handful of
documents, not before.

**"What do we tell Trish about data security?"**
Three specific things, in this order:

1. **Documents are read through Anthropic's business API, where inputs and outputs
   are not used to train models.** That is a different arrangement from pasting
   something into a consumer chatbot, and the distinction is the answer.
2. **The archive is not copied.** The database stores extracted values and a link
   back to the source. Client documents stay where they already live.
3. **Access is three gates:** Microsoft authenticates you against the DCW tenant,
   your address must be a DCW one, and an admin must approve the account. Admin
   status is decided in the database, so a leaked build config cannot grant it.

The honest caveat to volunteer rather than be asked: this has not been through a
formal security review, and before real client data goes in at scale it should be.

**"Should we just buy Zebel?"**
Genuinely worth taking seriously — see [`ZEBEL-GAP.md`](ZEBEL-GAP.md). Short
version: they are ahead on estimating mechanics and years of polish; we are ahead
on statistical honesty and on reading messy historical documents, which is exactly
the part they solve with a human services team. Their enterprise tier at
$30–60k/year sits **above the $20k CEO limit in your own governance matrix
(item #13)**, so it is a Board decision needing about two months of lead time.
That is worth knowing before it comes up in a room.
