# Handoff — DCW Cost Library

Everything needed to take over, run, and extend the team intranet.
Written for someone who has not seen this codebase before.

**You do not need a ZIP.** All of this lives in
[`github.com/DCW-Cost/dcwcost`](https://github.com/DCW-Cost/dcwcost), which DCW
owns. Get repository access from whoever administers the DCW GitHub org and you
have the editable source — not a copy of it, the real thing.

There is no separate "published app" project. The marketing site and the
intranet are one Astro project in one repository, deployed by one Netlify build.

---

## 1. The checklist, answered

| Asked for | Where it is | Notes |
| --------- | ----------- | ----- |
| Source code and project folders | the whole repo | `src/` is the app, `docs/` is the design record |
| `package.json` and lock file | `package.json`, `package-lock.json` | Node 22, pinned in `netlify.toml` |
| Authentication config | `src/lib/intranet/auth.ts`, `src/middleware.ts`, `src/pages/teamintranet/auth/*` | Entra ID → Supabase Auth → cookie session |
| Supabase config | `src/lib/intranet/auth.ts` | reads `SUPABASE_URL` / `SUPABASE_ANON_KEY` from env, nothing hard-coded |
| Migrations / database schema | `docs/team-intranet/schema.sql` | 19 tables, 2 views, 29 RLS policies, 1 trigger. Already applied to the live project |
| Airtable integration | **does not exist yet** | see §6. `fixtures.ts` mentions Airtable in comments only |
| Configuration and deployment files | `astro.config.mjs`, `netlify.toml`, `tsconfig.json` | |
| README / setup instructions | `README.md`, `docs/team-intranet/SETUP.md`, `docs/team-intranet/PLAN.md` | SETUP is the step-by-step; PLAN is the *why* |
| `.env.example` with placeholders only | `.env.example` | four variables, all placeholder values |

**No real `.env` file exists in this repository and none ever has.** `.gitignore`
excludes `.env` and `.env.*` while allowing `.env.example` through. The full git
history has been scanned for key patterns (Supabase JWTs, `sb_secret_…`,
`sk-ant-…`, Airtable PATs, `client_secret`); the only matches are lines of
documentation warning people *not* to use the `service_role` key.

Real values live in exactly two places, both outside git:

- **Netlify** → Site configuration → Environment variables (site `dcwc`)
- **Supabase** → Project settings → API (project ref `vsjxkokabstpvltcaxwu`)

---

## 2. Two sites, one repository — read this first

There are two different DCW websites and they are easy to confuse.

| | Built by | Repo | Runs the intranet? |
| --- | --- | --- | --- |
| `dcwcost.com` | Rachel, via Microsoft | not this one | no |
| `dcwc.netlify.app` | this repository | `DCW-Cost/dcwcost` | **yes** |

The intranet is live at
`https://deploy-preview-1--dcwc.netlify.app/teamintranet/` — a deploy preview,
not production. Production has `INTRANET_ENABLED` blank on purpose, so
`/teamintranet` returns 404 there.

Moving it to `dcwcost.com/teamintranet` later is a DNS and hosting decision, not
a code change. Nothing in the code assumes a domain.

---

## 3. Running it locally

```bash
git clone https://github.com/DCW-Cost/dcwcost.git
cd dcwcost
npm install
cp .env.example .env      # then fill in — see below
npm run dev               # http://localhost:4321
npm test                  # 21 tests, all passing
npm run build             # production build
```

Four environment variables, all documented inline in `.env.example`:

| Variable | Where to get it |
| -------- | --------------- |
| `INTRANET_ENABLED` | set to `true`. Without it every intranet route 404s |
| `SUPABASE_URL` | Supabase → Project settings → API |
| `SUPABASE_ANON_KEY` | same page. The **anon/publishable** key, never the secret one |
| `INTRANET_EMAIL_DOMAIN` | `dcwcost.com` |
| `INTRANET_DATA` | leave as `fixtures` for now |

**Leave `SUPABASE_URL` blank and it still runs.** With no credentials the app
falls back to a demo mode that serves invented data and treats you as an admin.
That is the fastest way to look around, and it is also why `INTRANET_ENABLED`
exists — demo mode must never reach a public URL.

---

## 4. How it is put together

```
src/
  middleware.ts                  every /teamintranet request passes through here
  lib/intranet/
    auth.ts                      Entra ID + Supabase session handling
    stats.ts                     outlier rejection, trend test, confidence gate
    stats.test.ts                21 tests — the statistics are real and covered
    builder.ts                   proposes rates for an estimate
    library.ts                   formatting helpers
    data/
      types.ts                   the DataProvider interface
      fixtures.ts                invented demo data (current default)
      index.ts                   picks a provider from INTRANET_DATA
  pages/teamintranet/            the seven screens
  components/intranet/           sidebar
  styles/intranet.css
docs/team-intranet/
  PLAN.md                        the full design, and why each decision was made
  SETUP.md                       Azure + Supabase + Netlify, step by step
  schema.sql                     the database
  HANDOFF.md                     this file
  deck/                          generators for the pilot deck and the model
```

### Three ideas worth understanding before changing anything

**1. Pages never touch the database directly.** Every screen imports `provider`
from `src/lib/intranet/data/`. Swapping fixtures for real data means writing
`data/supabase.ts` against the `DataProvider` interface in `types.ts` and setting
`INTRANET_DATA=supabase`. No page changes. This is the single most useful seam
in the codebase and the next real piece of work.

**2. Profiles are created by a database trigger, not by the app.** The app has no
`INSERT` permission on `profiles`. When someone signs in, a `SECURITY DEFINER`
trigger on `auth.users` creates their row as `viewer` / `pending` — unless their
address is in the `bootstrap_admins` table, in which case they land as an active
admin. This is deliberate: it means a leaked build config cannot grant anyone
admin. Admin status is decided in the database, full stop.

**3. Both database views carry `security_invoker = true`.** Without it a view
runs with its owner's privileges and reads straight past row-level security. If
you add a view, it needs that setting. There is a verification query at the
bottom of `SETUP.md` that checks for exactly this.

### Access control, in order

1. Entra ID authenticates the person against the DCW tenant
2. Their address must end in `INTRANET_EMAIL_DOMAIN` — a guest account in the
   tenant does not get a profile row created at all
3. An admin must have approved the account before it becomes `active`
4. Row-level security decides what each role can read and write, in the database

Containment while it is still a prototype: `INTRANET_ENABLED` must be `true` or
everything 404s; `/teamintranet` is excluded from the sitemap; pages carry
`noindex` and `X-Robots-Tag`; `robots.txt` disallows the path; and responses set
`Cache-Control: private, no-store` so no CDN can serve one person's session to
another.

---

## 5. What is real and what is not

**Real, working, verified on a deploy preview (10 Sep 2026):**

- Microsoft 365 sign-in, end to end, sessions persisting across navigation
- Admin approval and revocation of accounts
- All seven screens
- The statistics — MAD outlier rejection on the log scale, Theil–Sen trend with
  a Mann–Kendall significance test, the green/amber/red confidence gate. Covered
  by `npm test`
- The security model described above
- Netlify Forms still receives contact-form submissions with the SSR adapter in
  place. This was the real risk in adding the adapter — `netlify.toml` records
  the form having been broken once before by a catch-all redirect. It is not
  broken now, and that comment should stay

**Not real:**

- **Every number on screen is invented.** Kent, Olympia and Ballard are not real
  jobs. The data comes from `fixtures.ts`
- No cost plan has been read yet. The AI reader is designed and specified in
  `PLAN.md` §6; it is not built
- Write actions (approve, revoke, confirm, accept) render but do not persist
- The Estimate Builder is designed, not built

---

## 6. The next four pieces of work, in order

1. **`src/lib/intranet/data/supabase.ts`** — implement `DataProvider` against the
   real database. Unblocks everything else.
2. **Seed reference data** — the UniFormat II taxonomy and units tables are
   empty. `schema.sql` defines them; nothing has populated them.
3. **Make admin writes persist** — approve, decline, revoke, change role.
4. **Airtable sync** — *nothing exists for this yet.* The intended shape, from
   `PLAN.md`: Airtable stays the system of record for projects and clients;
   Postgres holds only cost data extracted from deliverables; the flow is one
   way, with no write-back to Airtable. Access was pending when this was built.

---

## 7. Accounts and who owns what

| Thing | Owned by | Action needed |
| --- | --- | --- |
| GitHub repo `DCW-Cost/dcwcost` | **DCW** | none — grant access as needed |
| Supabase project `vsjxkokabstpvltcaxwu` | created during the build | **confirm it sits on a DCW-owned Supabase org**, and move it if not |
| Netlify site `dcwc` | created during the build | **same — confirm the owning Netlify team** |
| Entra ID app registration | **DCW tenant** | none |
| Anthropic API key for the reader | **not yet created** | DCW should create its own when the reader is built |

The two worth checking now are Supabase and Netlify. Both were stood up quickly
to get a working prototype in front of people, and neither should stay on a
personal account. Both support transferring a project to an organisation without
redeploying — but the Supabase move changes nothing about the project ref, so no
environment variables change either.

Nothing here runs on an Anthropic account today: **no document has been sent to
any AI model yet.** The reader described in `PLAN.md` will need an Anthropic API
key, and that should be a DCW business account from day one — inputs and outputs
on the business API are not used to train models, which is the whole reason
client cost plans can go through it.

---

## 8. Rules that should not be relaxed

- **Never put the Supabase `service_role` / secret key in this project.** It
  bypasses every row-level security policy. The anon key is safe in a browser
  precisely because RLS is what protects the data.
- **Never grant admin through an environment variable.** Use `bootstrap_admins`.
- **Any new view needs `security_invoker = true`.**
- **Do not add a `from = "/*"` catch-all to `netlify.toml`.** It breaks the
  contact form. There is a comment there explaining this; it is not decoration.
- **Client documents stay in Box.** The database stores extracted values and
  links, never the documents themselves.

---

## 9. Where the reasoning is written down

`docs/team-intranet/PLAN.md` is the design document and it is worth reading
before changing the model — it covers the cost reader's three passes, the
normalisation problem (the same `$13.20` means different things depending on
markup basis, area basis and price date), the confidence gate thresholds and
why they sit where they do, and the estimate-builder round trip.

`docs/team-intranet/SETUP.md` is the operational runbook: the Entra app
registration, the Supabase project, the Netlify variables, and a troubleshooting
table covering the failures actually hit during setup — including the OAuth
redirect one, which is subtle. Supabase matches redirect URLs *including the
query string*, so adding `?next=…` to the callback silently falls back to the
project's Site URL. The destination is carried in a short-lived httpOnly cookie
instead.
