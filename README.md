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

**Status.** The UI is real and the statistics are real — outlier rejection,
the confidence gate and the trend test all run for genuine
(`src/lib/intranet/stats.ts`, covered by `npm test`). The *data* is not: it
comes from `src/lib/intranet/data/fixtures.ts` and every figure is invented.
Both banners at the top of each page say so.

**Not ready to merge to `main`.** These routes are prerendered and unauthenticated
while the UI is built. Before they ship they need the Netlify adapter with
`prerender = false`, Entra ID sign-in, and a real data provider. Until then
`INTRANET_ENABLED` is unset, `/teamintranet` is excluded from the sitemap, the
pages carry `noindex`, and `robots.txt` disallows the path.

**Swapping in real data.** Pages only ever import `provider` from
`src/lib/intranet/data/`. Implement the `DataProvider` interface in a
`supabase.ts` alongside `fixtures.ts` and switch the resolver — no page changes.

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
