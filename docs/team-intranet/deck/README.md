# The pilot deck and the business model

Two generated artefacts, kept as generators rather than binaries so they stay
diffable and reproducible.

| File | Produces | Run it with |
| ---- | -------- | ----------- |
| `deck.js` | `DCW-Cost-Library-Pilot.pptx` — 17 slides, DCW branding, speaker notes on every slide | `npm i pptxgenjs && node deck.js` |
| `model.py` | `DCW-Cost-Library-Business-Model.xlsx` — the time-savings and business-impact model | `pip install openpyxl && python3 model.py` |
| `check.py` | Geometry QA on the deck | `pip install python-pptx && python3 check.py <file.pptx>` |

These are standalone tooling scripts, not part of the site build — `pptxgenjs`,
`openpyxl` and `python-pptx` are deliberately *not* site dependencies. Install
them here rather than at the repo root, so the site's `package.json` stays
untouched. `deck.js` is ESM because the repo sets `"type": "module"`.

Upload the `.pptx` to Google Drive and open it with Slides; Drive converts it to
a native Google Slides file, so every element stays editable.

## About the numbers

**The deck's demonstration figures are invented** — Kent, Olympia and Ballard
are not real jobs, and the deck says so on slide 9.

**The model's rates are placeholders**, and the workbook marks each one. Three
numbers turn it into a real forecast, and none of them exist in any document
available today:

- blended cost per estimator-hour (fully loaded)
- blended billing rate
- average fee per cost deliverable

A fourth — *hours per estimate* — is task **T-21** in the operating plan, an open
Q3 baseline. Until it lands, the 5.0 → 1.5 hour split is an estimate of an
estimate. `Notes & sources` in the workbook labels every figure as sourced,
placeholder, or judgement.

## The one result worth not getting wrong

There are **two** break-even fee cuts, not one:

- Margin **percentage** holds flat up to a cut equal to the drop in *total* job
  hours (~8% at the base case). This is exact: margin % is `1 − (hours × cost) / fee`,
  so scaling hours and fee by the same factor leaves it unchanged.
- Margin **dollars** per job hold flat only to about **2.8%**, because a fee cut
  applies to the whole fee while the saving applies to one step.

A discount between the two improves the ratio while quietly losing money. The
`Fee & margin` sheet shows both lines side by side for exactly this reason.
