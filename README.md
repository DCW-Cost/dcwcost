# DCW Cost Management

Marketing website for **DCW Cost Management** (Drew Collaborative Works) — an
independent, owner-centered cost management firm serving the Pacific Northwest
since 2012. Women-owned (WBE/WOSB) and employee-owned (EOT).

Built with [Astro](https://astro.build) and deployed on
[Netlify](https://www.netlify.com).

## Pages

| Route                 | Description                                                       |
| --------------------- | ---------------------------------------------------------------- |
| `/`                   | Home — firm overview, service pillars, process, featured work    |
| `/about`              | Firm story, values, and leadership team                          |
| `/services`           | Cost Management services                                         |
| `/projects`           | Featured case study + case-study library + sectors               |
| `/projects/[slug]`    | Individual project case studies                                  |
| `/sectors/[slug]`     | Per-sector landing pages (government, healthcare, K-12, …)       |
| `/insights`           | Insights hub — perspective & PNW cost intelligence              |
| `/insights/[slug]`    | Individual articles                                              |
| `/careers`            | Careers, built around the Employee Ownership Trust               |
| `/employee-owned`     | The EOT story                                                    |
| `/contact`            | Offices, phone, email, and an enquiry form                       |

## Team intranet (`/teamintranet`) — in development

An internal cost-estimating tool living alongside the marketing site. See
[`docs/team-intranet/PLAN.md`](docs/team-intranet/PLAN.md) for the full design
and [`schema.sql`](docs/team-intranet/schema.sql) for the database.

| Route | Screen |
| ----- | ------ |
| `/teamintranet/` | Cost Library — every element, with its confidence verdict |
| `/teamintranet/library/[code]` | One element: range, sources, excluded outliers |
| `/teamintranet/estimates/` | Estimates in progress |
| `/teamintranet/estimates/[id]/brief` | What the reader understood from the client's documents |
| `/teamintranet/estimates/[id]` | The Estimate Builder |
| `/teamintranet/queue/` | Reader Queue — the reader's open questions |
| `/teamintranet/admin/` | Account approval and thresholds |

These routes are server-rendered (`prerender = false`) via `@astrojs/netlify`.
Every marketing page stays prerendered exactly as before.

**Sign-in** is Microsoft 365 / Entra ID through Supabase Auth, guarded by
`src/middleware.ts` on every request. Three gates: Entra ID authenticates,
the address must match `INTRANET_EMAIL_DOMAIN`, and an admin must have approved
the account. Profiles are created by a database trigger, never by the app, so
nobody can insert themselves as an active admin.
**To switch it on, follow [`docs/team-intranet/SETUP.md`](docs/team-intranet/SETUP.md)** —
it needs a Supabase project and an Entra ID app registration, which only a
person with a browser can create.

**What's real and what isn't.** The UI and the statistics are real — outlier
rejection, the confidence gate and the trend test all genuinely run
(`src/lib/intranet/stats.ts`, covered by `npm test`). The *data* is not: it
comes from `src/lib/intranet/data/fixtures.ts` and every figure is invented.
Write actions (approve, revoke, confirm, accept) render but don't persist yet.

**Not ready to merge to `main`.** With no Supabase credentials the area falls
back to a demo mode where *everyone is treated as an admin* — fine locally,
never anywhere reachable. Four things keep it contained: `INTRANET_ENABLED`
must be `true` or every route 404s, `/teamintranet` is excluded from the
sitemap, pages carry `noindex` and `X-Robots-Tag`, and `robots.txt` disallows
the path. Intranet responses also set `Cache-Control: private, no-store` so no
CDN can serve one person's session to another.

**Swapping in real data.** Pages only ever import `provider` from
`src/lib/intranet/data/`. Implement the `DataProvider` interface in a
`supabase.ts` alongside `fixtures.ts` and set `INTRANET_DATA=supabase` — no
page changes.

## Content lives in data files

Editable content is centralized in `src/data/` so copy changes don't require
touching page markup:

- `sectors.js` — sector landing pages + market grids
- `projects.js` — project case studies
- `insights.js` — Insights articles

> **⚠️ Verify before launch:** the team roster in `src/pages/about.astro` and
> the testimonials are drawn from public record and need confirmation against
> DCW's own records. (Founding year is confirmed: DCW was founded in 2012 and
> began delivering project work in 2013.) Project case studies in
> `src/data/projects.js` should likewise be confirmed and expanded.

## Local development

```bash
npm install     # install dependencies
npm run dev     # start the dev server at http://localhost:4321
npm run build   # build the static site to ./dist
npm run preview # preview the production build locally
```

## Deployment

Netlify builds with `npm run build` and publishes the `dist/` directory
(see `netlify.toml`). The contact form uses Netlify Forms
(`data-netlify="true"`).
