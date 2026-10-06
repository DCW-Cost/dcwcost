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
| `vanished` anomaly kind | `sync_anomaly_kind` enum | **0 emitters** in `src/` (`grep "kind: 'vanished'"`) |
| `value_disagreement` anomaly kind | `sync_anomaly_kind` enum | **0 emitters** in `src/` |
| trigger refusing while a run is live | `src/pages/api/sync/trigger.ts` | no 409 path exists; parked, never built |

A kind in the enum with no emitter reads, to anyone browsing the schema, as a
case that is being handled. Two of the five existing kinds are in this state.

## Wired, never fired

| thing | where | evidence |
|---|---|---|
| `unknown_choice` | `plan.ts` (2 emitters) | **0 of 544** anomaly rows; every row is `coercion_failed` or `unresolved_link` |
| run budget, before each table | `run.ts:200` | no run has exceeded `RUN_BUDGET_MS` (13 min); since batching, runs finish in 3–4s |
| run budget, per page | `run.ts:390` | same |

`unknown_choice` is the one worth worrying about. It is the only detector for
a select option renamed in Airtable — a failure whose whole character is that
nothing else notices. It has two call sites, it runs on every choice field of
every record, and it has never produced a row. That is consistent with "no
option has been renamed" and equally consistent with "it cannot fire."
Distinguishing those requires renaming a choice in a copy of the base and
watching it complain.

## Ran, found nothing

| thing | where | evidence |
|---|---|---|
| stale-link counter | `run.ts:745` | executed on a real run; **0 stale across 9,172 links** |

This is the only entry that is evidence rather than an open question. It ran,
against the full set, and the zero means something.

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

## Why this file exists

Each of the following was discovered separately, and each had looked covered:

- verification blocks that were read rather than run
- source-reading tests matching something, just not the right thing
- `onPage`, written "for progress that outlives a crash", never called
- dry runs reporting counts nobody compared against a real run
- `empty_record`, assumed applied and built, when neither the enum value nor
  a single line of code existed

Rediscovering them one at a time is the cost of not having written them down.
