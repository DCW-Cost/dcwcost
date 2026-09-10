# Turning on sign-in

Everything on the code side is built. Three values are missing, and they can
only be created by a person in a browser: a **Supabase project**, an **Entra ID
app registration**, and the secret that ties them together.

About 30 minutes. Do it in this order.

> **You may need help with step 2.** Registering an app in Entra ID requires
> Application Administrator (or Global Administrator) rights on DCW's Microsoft
> tenant. If the Azure portal won't let you create a registration, that's the
> reason — whoever administers DCW's Microsoft 365 can do it, or grant you the
> role.

---

## 1. Create the Supabase project

1. [supabase.com/dashboard](https://supabase.com/dashboard) → **New project**.
   Name it `dcw-cost-library`. Choose the **West US (Oregon)** region — closest
   to the team, and it keeps the data in the US.
2. Save the database password somewhere safe. You won't need it for the app,
   but you will if you ever connect directly.
3. Wait for it to finish provisioning, then go to
   **Project Settings → API** and copy two values:
   - **Project URL** → this is `SUPABASE_URL`
   - **anon / public** key → this is `SUPABASE_ANON_KEY`

The anon key is safe to expose — it's designed to sit in a browser, and
row-level security is what actually protects the data.

**Do not copy the `service_role` key into this project.** It bypasses every
security policy. Nothing here needs it.

---

## 2. Register the app in Entra ID

In the [Azure portal](https://portal.azure.com) → **Microsoft Entra ID** →
**App registrations** → **New registration**:

| Field | Value |
| ----- | ----- |
| Name | `DCW Cost Library` |
| Supported account types | **Accounts in this organizational directory only** (single tenant) |
| Redirect URI | Platform **Web**, URI `https://<YOUR-PROJECT-REF>.supabase.co/auth/v1/callback` |

`<YOUR-PROJECT-REF>` is the subdomain from the Project URL in step 1.

Single tenant matters: it means only DCW's own directory can authenticate here
at all, before any of our own checks run.

After registering, from the **Overview** page copy:

- **Application (client) ID**
- **Directory (tenant) ID**

Then **Certificates & secrets** → **New client secret**. Set the longest expiry
your policy allows and note the date — *sign-in breaks on the day it expires*,
so put a calendar reminder a month before. Copy the secret **Value** (not the
Secret ID) immediately; it's only shown once.

Finally, **API permissions** should already list `User.Read` under Microsoft
Graph. Add the delegated permissions `email`, `openid`, `profile` and
`offline_access` if they aren't there, then click **Grant admin consent for
DCW** so nobody is prompted individually.

---

## 3. Connect Supabase to Entra ID

In the Supabase dashboard:

1. **Authentication → Providers → Azure** → enable it, and fill in:
   - **Client ID** — the Application (client) ID from step 2
   - **Secret** — the client secret *Value* from step 2
   - **Azure Tenant URL** — `https://login.microsoftonline.com/<DIRECTORY-TENANT-ID>`

   **Leave "Allow users without an email" OFF.** The email address is what
   every gate in this system runs on: `profiles.email` is `not null unique`
   with a domain check constraint, the signup trigger refuses to create a row
   without one, and the app signs out anyone whose address fails the domain
   test. A user with no email would authenticate with Microsoft and then hit a
   silent dead end, with no profile row for an admin to even see.

   If sign-in ever fails complaining about a missing email, **this toggle is
   not the fix** — it means the Entra registration isn't releasing the email
   claim. Go back to step 2 and check that `email`, `openid`, `profile` and
   `offline_access` are under API permissions and that admin consent was
   granted.
2. **Authentication → URL Configuration**:
   - **Site URL**: `https://dcwc.netlify.app`
   - **Redirect URLs** — add:
     - `https://dcwc.netlify.app/teamintranet/auth/callback`
     - `https://deploy-preview-*--dcwc.netlify.app/teamintranet/auth/callback`
       (wildcard, so every pull-request preview works without adding each one)
     - `http://localhost:4321/teamintranet/auth/callback` — only if you'll run
       the site on your own machine

   **Which domain, and why it isn't dcwcost.com.** This repository is the site
   published at **dcwc.netlify.app**. `dcwcost.com` is a separate, existing DCW
   site that this code does not control and cannot add routes to, so the
   intranet lives at `https://dcwc.netlify.app/teamintranet` — see
   "Where this ends up living" at the bottom.

   Sign-in uses whatever hostname actually served the page, so it works at any
   of these without a code change. What matters is that the exact URL appears
   on this allowlist; anything missing gets refused after Microsoft has already
   authenticated, which is a confusing failure to debug.
3. **SQL Editor** → paste the whole of
   [`schema.sql`](./schema.sql) and run it. That creates the tables, the
   row-level security policies, and the trigger that creates a profile when
   someone signs in for the first time.
4. Still in the SQL Editor, seed yourself as the first admin **before signing
   in**:

   ```sql
   insert into bootstrap_admins (email, note)
   values ('lacie@dcwcost.com', 'first admin');
   ```

   This is the answer to the chicken-and-egg problem: the first admin can't be
   approved by an existing admin. Anyone in this table comes out **active** and
   **admin** on first sign-in; everyone else lands **pending** and waits.

   Add Rachel, Brian and Trish the same way if you want them admin from the
   start — otherwise approve them from the Admin screen once you're in.

---

## 4. Point the app at it

Two ways to do this. **Pick 4a if you don't have the code on your own machine** —
it's all browser, and it tests the real thing rather than a laptop.

---

### 4a. Through Netlify (no terminal needed)

**Set the environment variables.**
Netlify → your site → **Site configuration → Environment variables** →
*Add a variable* → *Add a single variable*, four times:

| Key | Value |
| --- | ----- |
| `INTRANET_ENABLED` | `true` |
| `SUPABASE_URL` | the Project URL from step 1 |
| `SUPABASE_ANON_KEY` | the anon key from step 1 |
| `INTRANET_EMAIL_DOMAIN` | `dcwcost.com` |

**Scope `INTRANET_ENABLED` to deploy previews only** — when adding it, choose
*Different value for each deploy context* and set it only for **Deploy
Previews**, leaving Production blank. That way the intranet is reachable on the
preview URL for testing but stays switched off on the live dcwc.netlify.app
even if the branch is merged by accident. The other three are safe in all contexts.

**Get the preview URL.** Open the pull request on GitHub. Netlify comments on
it with a **Deploy Preview** link, something like
`https://deploy-preview-1--dcwc.netlify.app`. If the deploy ran before you
added the variables, hit *Retry deploy* in Netlify so it picks them up.

**Tell Supabase about that URL.** Supabase → **Authentication → URL
Configuration → Redirect URLs** → add:

```
https://deploy-preview-1--dcwc.netlify.app/teamintranet/auth/callback
```

substituting your actual preview URL. Without this, Microsoft will authenticate
you and then Supabase will refuse to hand the session back.

**Then visit** `<your-preview-url>/teamintranet/` and sign in.

While you're on the preview, **also submit the contact form** and check it
arrives in Netlify → **Forms**. Adding the server-rendering adapter changed how
the site deploys, and this is the one thing that could plausibly have broken.
Better to find out on a preview than on the live site.

---

### 4b. On your own machine

Requires [Node.js 22+](https://nodejs.org) and a copy of the repository.
Copy the template and fill in the two values from step 1:

```bash
cp .env.example .env
```

```bash
INTRANET_ENABLED=true
SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
SUPABASE_ANON_KEY=eyJ...
INTRANET_EMAIL_DOMAIN=dcwcost.com
INTRANET_DATA=fixtures
```

`.env` is gitignored. Never commit it.

Then:

```bash
npm install
npm run dev
```

Open <http://localhost:4321/teamintranet/> — you should be redirected to the
sign-in page with a **Sign in with Microsoft** button.

---

## 5. What should happen

| You do | You should get |
| ------ | -------------- |
| Visit `/teamintranet/` signed out | Redirected to `/teamintranet/signin` |
| Sign in as `lacie@dcwcost.com` | Straight into the Cost Library, as an admin |
| Sign in as another `@dcwcost.com` address | The "waiting for approval" page |
| Approve that person from **Admin** | They get in on their next page load |
| Sign in with a personal Microsoft account | Refused — no profile row is ever created |
| Unset `INTRANET_ENABLED` | Every `/teamintranet` route returns 404 |

If a real DCW address gets stuck on "waiting for approval" and you expected it
to be admin, the address almost certainly isn't in `bootstrap_admins` — check
spelling and that you seeded it *before* the first sign-in. If it was after,
just approve them from the Admin screen, or run:

```sql
update profiles set status = 'active', role = 'admin', approved_at = now()
where email = 'someone@dcwcost.com';
```

---

## 6. Before this goes anywhere public

The current build is **not** ready to be reachable, even with sign-in working:

- **The data is still fixtures.** Every figure on screen is invented. Real data
  needs `src/lib/intranet/data/supabase.ts` implementing the `DataProvider`
  interface, then `INTRANET_DATA=supabase`.
- **The write actions are inert.** Approve, Revoke, Confirm and Accept render
  but don't persist yet.
- **Netlify needs the same environment variables** set in
  **Site configuration → Environment variables**, or the deployed build falls
  back to demo mode — where *everyone is treated as an admin*. Set
  `INTRANET_ENABLED` there last, once the rest is in place.

---

## Deploying later

The site builds to a static marketing site plus one serverless function for
`/teamintranet/*`. Netlify picks this up automatically from
`@astrojs/netlify`; no extra configuration beyond the environment variables.

Rotate the Entra ID client secret before it expires, in Azure and then in
Supabase. That is the one piece of scheduled maintenance this setup needs.

---

## Where this ends up living

Worth being explicit, because there are two DCW sites and they are easy to
confuse:

| Site | What it is | Does this repo control it? |
| ---- | ---------- | -------------------------- |
| **dcwcost.com** | The existing DCW website | **No.** Built and hosted separately |
| **dcwc.netlify.app** | This repository, deployed by Netlify | Yes |

So the intranet lives at **`https://dcwc.netlify.app/teamintranet`**, and will
keep living there until someone changes the hosting. Nothing in this build can
put it on `dcwcost.com/teamintranet` — that would require this repository to
replace the existing site, which is a much larger decision than standing up an
internal tool.

That is not a problem. The intranet is for the team, not for clients: it is
behind a Microsoft sign-in, excluded from the sitemap, `noindex`ed and
disallowed in `robots.txt`. Nobody will ever find it by browsing, so the
hostname matters far less than it would for a public page.

Three ways forward, in the order they are worth doing:

1. **Leave it at `dcwc.netlify.app/teamintranet`.** Works today, costs nothing,
   and the team bookmarks it. Fine for the pilot and probably for a good while
   after.
2. **Point a subdomain at it** — a `CNAME` for `intranet.dcwcost.com` at the
   Netlify site, added by whoever manages DNS for dcwcost.com. Gives a
   professional URL without touching the existing website at all, and is
   completely independent of any decision about replacing it. Note that the
   marketing pages in this repository would also answer on that hostname, which
   is harmless but slightly odd; it can be redirected later if it bothers
   anyone.
3. **`dcwcost.com/teamintranet`** — only meaningful if this repository becomes
   the DCW website. That is a business decision about the website, and the
   intranet should not wait on it.

Recommendation: ship on (1), move to (2) once the team is actually using it
daily, and treat (3) as unrelated.

One consequence worth knowing: `astro.config.mjs` sets
`site: 'https://dcwcost.com'`, so the marketing pages in this repository
declare `dcwcost.com` as their canonical URL even while served from
`dcwc.netlify.app`. For a second copy of a marketing site that is the right
setting — it stops this deployment competing with the real site in search
results. It has no effect on the intranet, which uses the live request's own
hostname for sign-in.
