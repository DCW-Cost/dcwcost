# Things that have never fired

Measured 2026-10-06 against production and `src/`.

"Never exercised" is a different state from "working", and only a list tells
them apart. A mechanism is not proven by existing — it is proven by one run
where it fires. Everything below is something that would report a problem if
one occurred, and which has never reported anything.

There are three states here, and they are not the same:

- **Declared, no code** — something names it, nothing can produce it. This is
  the worst state, because the name makes it look handled.
- **Wired, never fired** — the code exists and runs, but the condition has
  never been met. It may work. Nobody knows.
- **Ran, found nothing** — the check executed against real data and returned
  zero. This is the only one that is actually evidence.

## Declared, no code

| thing | where | evidence |
|---|---|---|
| `vanished` anomaly kind | `sync_anomaly_kind` enum | **0 occurrences** of the string anywhere in `src/` |
| trigger refusing while a run is live | `src/pages/api/sync/trigger.ts` | no 409 path exists; parked, never built |

A kind in the enum with no emitter reads, to anyone browsing the schema, as a
case that is being handled.

**This table listed `value_disagreement` here and was wrong.** The check behind
it was `grep "kind: 'value_disagreement'"`, which matches the TypeScript object
literal the other kinds use — but that one is written as a SQL literal inside
`deriveGrossSf`, so the grep returned zero and looked authoritative. A document
about things that look covered and are not, produced by a check that matched
the wrong thing. Re-run as `grep "'value_disagreement'"` it has one emitter.

## Wired, never fired

| thing | where | evidence |
|---|---|---|
| `value_disagreement` | `run.ts:792`, in `deriveGrossSf` | wired, but see below — it cannot currently fire |
| run budget, before each table | `run.ts:200` | no run has exceeded `RUN_BUDGET_MS` (13 min); since batching, runs finish in 3–4s |
| run budget, per page | `run.ts:390` | same |

### A fourth state: wired, runs, and structurally cannot fire

`value_disagreement` deserves its own note, because it looks like the healthiest
entry here and is the most misleading.

It compares each project's `gross_sf` against the latest deliverable's
`building_sf` and reports a conflict. Measured 2026-10-06: **355 projects have
both values, and 0 disagree.** That reads as 355 projects checked and clean.

But all 355 had `gross_sf` FILLED FROM that same `building_sf`, by the same
function, ten lines earlier. It is comparing a value against its own source. It
cannot disagree, and 0 is not evidence of agreement — it is arithmetic.

It becomes a real check only when `gross_sf` arrives independently, from the
reader's documents. Until then "355 checked, 0 problems" is a sentence that
means nothing, and is worse than an obvious zero because it looks like coverage.

### unknown_choice

Retired from this list on 2026-10-06, and worth recording how. It was exercised
by the `out_of_office` map: Airtable's Category option
`"In Person Client Meeting/Event "` carries a trailing space, and
`unknownChoice` trims the incoming value while comparing against the known list
untrimmed. Copying Airtable verbatim would have raised a false `unknown_choice`
on every record in that category. Written trimmed, the full 843-row load
produced **0** — the detector was put in front of a case that would have tripped
it and correctly stayed silent, which is the only way a zero becomes evidence.

## Ran, found nothing

| thing | where | evidence |
|---|---|---|
| stale-link counter | `run.ts:745` | executed on a real run; **0 stale across 9,172 links** |

This is the only entry that is evidence rather than an open question. It ran,
against the full set, and the zero means something.

Two caveats on its scope, both as of 2026-10-06. The population has since grown
to **9,945** links, because `out_of_office_people` added 773 — and those were
created the same day, so no run has yet had a prior state to find them missing
from. And the counter still only LOGS: it writes a line nobody reads rather than
the `vanished` anomaly that describes exactly what it detects. Wiring the two
together moves `vanished` out of "declared, no code" but not out of this file,
because 0 stale means it would emit nothing. Retiring it needs a test that hands
the path a pair Airtable no longer has and asserts the anomaly appears.

## How things leave this list

By failing on purpose. Not by being read, not by being built, not by
appearing in a passing test — by being put in front of the broken state it
exists to catch, and complaining.

The three habits that produce that:

1. **For a check — make it fail first.** Run it against the broken state
   before the fix. A check that has only ever passed is indistinguishable
   from one that cannot fail.
2. **For a mechanism — trigger it.** It is not proven by existing. It is
   proven by one run where it fires.
3. **For a claim — ask who would notice if it were false.** The bundler
   built the module but would not catch what the test runner rejects. The
   replay runs the migration but never its verification block. Something
   *consuming* an artefact is not the same as something *checking* it.
4. **For an expected value — measure it, or mark it unverified.** The number
   in a verification block is a prediction and gets the same treatment as any
   other. 018's block predicted 851 attendance links and told the reader to
   treat anything less as failure; production produced 773, which was correct.
   851 came from arithmetic over a row count whose null rate had already been
   measured an hour earlier and was simply not subtracted. That slip produced
   a false alarm; the same slip in the other direction produces a FALSE PASS.
   A verification block with a wrong expected value is the same class of
   artefact as one nobody runs.
5. **For a check on your own code — make sure it matches how the code is
   actually written.** The grep that declared `value_disagreement` to have no
   emitter searched for the TypeScript spelling; that kind is written as a SQL
   literal. One spelling, confidently reported.

## Why this file exists

Each of the following was discovered separately, and each had looked covered:

- verification blocks that were read rather than run
- source-reading tests matching something, just not the right thing
- `onPage`, written "for progress that outlives a crash", never called
- dry runs reporting counts nobody compared against a real run
- `empty_record`, assumed applied and built, when neither the enum value nor
  a single line of code existed

Rediscovering them one at a time is the cost of not having written them down.
