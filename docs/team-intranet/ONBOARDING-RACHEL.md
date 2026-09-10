# Getting set up to build

Written for Rachel. The goal is that you can change this tool and ship the
change yourself, without waiting on anyone.

You already have the hard part — you know what the tool needs to do. The setup
below is about ninety minutes, most of it waiting for installs.

> **You do not need to learn to code first.** The way this was built is: describe
> what you want in plain English, say you are not a developer, and ask for
> step-by-step instructions. That is a legitimate way to work, not a shortcut —
> and it is faster than reading the codebase front to back before touching it.

---

## What connects to what

Worth thirty seconds, because it makes every error message afterwards legible:

```
  You, prompting Claude Code
        │
        ▼
  GitHub  ──────────►  Netlify  ─────────►  dcwc.netlify.app
  (the code)           (builds & hosts)     (the live site)
        │
        └─ reads ──►  Supabase
                      (database, sign-in, uploaded files)
```

You push code to **GitHub**. **Netlify** notices, rebuilds, and publishes.
**Supabase** holds the data and handles sign-in. Claude Code does the pushing
for you.

Two DCW websites exist and they are easy to confuse:

| | What it is | Runs the intranet? |
| --- | --- | --- |
| `dcwcost.com` | the site you built through Microsoft | **no** |
| `dcwc.netlify.app` | this repo | **yes** |

Moving the tool onto `dcwcost.com/teamintranet` later is a DNS change, not a
rebuild. Nothing in the code assumes a domain.

---

## Step 1 · Claude Code

The $200/month Max plan is what Lacie is using. The $20 Pro plan also runs Claude
Code with lower limits — worth starting there and upgrading if you hit them
rather than paying for headroom you may not need.

1. Sign up at [claude.ai](https://claude.ai)
2. Install Claude Code: [code.claude.com/docs](https://code.claude.com/docs)
3. Easiest start, no terminal: open [claude.ai/code](https://claude.ai/code) in a
   browser, connect GitHub, and pick `DCW-Cost/dcwcost`. You can prompt from there
   and it pushes for you.

---

## Step 2 · GitHub

You already have access. Confirm you can see
[github.com/DCW-Cost/dcwcost](https://github.com/DCW-Cost/dcwcost).

In Claude Code, connect that repository. That is the whole setup — Claude Code
commits and pushes; Netlify picks it up automatically.

**One rule that matters:** work on a branch, not `main`. Claude Code does this by
default. `main` is what deploys.

---

## Step 3 · Netlify

Needs a paid seat ($20/month) — **Lacie has to invite you**, you cannot self-serve
this one. Team → Members → Invite.

Once you are in, the two things you will actually use:

- **Deploys** — every push shows here. Red means the build broke; click it and
  read the log. The error is almost always in the last twenty lines.
- **Site configuration → Environment variables** — API keys and settings. These
  only take effect on a **new deploy**, which catches everyone once.

---

## Step 4 · Supabase

[supabase.com](https://supabase.com) → sign in with GitHub → project
`vsjxkokabstpvltcaxwu`. Ask Lacie to add you if you cannot see it.

- **Table Editor** — browse the data
- **SQL Editor** — run queries and migrations
- **Authentication → Users** — who has signed in
- **Storage** — uploaded cost plans

**One thing you must never do:** copy the `service_role` / secret key into the
project. It bypasses every security policy in the database. The `anon` key is the
one that belongs in the app, and it is safe in a browser precisely *because* those
policies exist.

---

## Step 5 · Run it on your own machine (optional, but worth it)

Being able to try something without deploying makes you much faster.

```bash
git clone https://github.com/DCW-Cost/dcwcost.git
cd dcwcost
npm install
npm run dev          # http://localhost:4321
```

Create a file called `.env` in that folder:

```
INTRANET_ENABLED=true
INTRANET_DATA=fixtures
INTRANET_EMAIL_DOMAIN=dcwcost.com
```

That is enough. **Leave the Supabase variables out** and it runs in demo mode with
invented data and treats you as an admin — perfect for trying things, and the
reason `INTRANET_ENABLED` exists so that mode can never reach a public URL.

`.env` is gitignored. Never commit it.

---

## Read these three, in this order

1. [`HANDOFF.md`](HANDOFF.md) — what exists, and the three ideas worth
   understanding before changing anything
2. [`PLAN.md`](PLAN.md) — the design and *why* each decision was made. Long, but
   it is where the reasoning lives
3. [`ZEBEL-GAP.md`](ZEBEL-GAP.md) — what Zebel does that we do not, turned into a
   roadmap

Skip `schema.sql` until you need it. It is a reference, not a read-through.

---

## Good first things to change

Ordered by how hard they are to get wrong:

1. **Wording.** Anything in `src/pages/teamintranet/` that reads awkwardly to an
   estimator. You are better placed than anyone to fix this. Zero risk.
2. **The FAQ.** `src/pages/teamintranet/faq/index.astro` is a plain list of
   questions and answers. Add the ones the team actually asks you.
3. **Wishlist triage.** You are an admin — file, prioritise, set target dates.
   No code at all, and it is the thing that keeps the team engaged.
4. **A real feature.** Pick the top-voted wishlist item and describe it to Claude
   Code. Mention `src/lib/intranet/data/types.ts` — the `DataProvider` interface
   there is the seam everything else hangs off.

## Two things to be careful with

- **`netlify.toml`** — do not add a `from = "/*"` catch-all redirect. It breaks
  the contact form. There is a comment in the file explaining why; it is not
  decoration, the form was broken by exactly this once before.
- **Anything in `docs/team-intranet/migrations/`** — SQL that has been run against
  the live database. Never edit a migration that has already been applied; add a
  new numbered one instead.

---

## When something breaks

It will, and almost none of it is dangerous. The database has real data now
(accounts, the wishlist); the cost figures are still invented.

- **The site build fails** → Netlify → Deploys → click the red one → read the last
  twenty lines. Paste them into Claude Code and ask what they mean.
- **A page 404s** → `INTRANET_ENABLED` is not `true` on that deploy context, or the
  build has not finished.
- **"Invalid API key"** → the Supabase key is wrong or missing. Note that Supabase
  now issues `sb_publishable_…` keys alongside the older `eyJ…` ones; either works,
  but it must be the **anon/publishable** one, never the secret.
- **A change did not appear** → environment variables need a fresh deploy, and the
  browser may be caching. Hard refresh first.

When you are stuck, paste the actual error text rather than describing it. That
is the single biggest difference between a fast answer and a slow one.
