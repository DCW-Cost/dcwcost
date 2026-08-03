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
