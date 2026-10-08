/**
 * What the sync must get right before it touches anything.
 *
 * Only the pure parts are exercised here — coercion, the field map, and the
 * SQL the map produces. Nothing imports run.ts or db.ts, because those pull in
 * `pg` and this suite is deliberately dependency-free (node_modules is not
 * committed, and `npm test` has to work from a bare checkout).
 *
 * The upsert tests matter most. A sync that writes a column it does not own
 * destroys the reader's work silently, and migration 007's column grant would
 * turn that into a permission error at runtime — but finding it here is
 * cheaper than finding it in a failed run against 5,551 rows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { allRecordIds, coerce, unknownChoice } from './coerce.ts';
import {
  buildBatchUpsert,
  buildJoinUpsert,
  buildUpsert,
  columnsFor,
  completedAtOnInsert,
  maxRowsPerStatement,
  planJoins,
  planRow,
  updatedColumns,
} from './plan.ts';
import { KNOWN_SKIPS, LOAD_ORDER, spec, TABLES } from './tables.ts';
import { renderPlan, selectedTables } from './run.ts';
import { parseSyncRequest } from './request.ts';
import { handleSync } from '../../../netlify/functions/airtable-sync-background.mts';
import { readSource } from './read-source.ts';

// ---------------------------------------------------------------- coercion

/**
 * The body of one function, between its declaration and the next one named.
 *
 * NOT src.slice(indexOf(a), indexOf(b)) DIRECTLY, which is what this replaced.
 * indexOf returns -1 for a boundary that no longer exists, and slice(start, -1)
 * does not throw — it silently returns almost the whole file. The two callers
 * below bounded syncTable with `async function deriveGrossSf`, which 020
 * removed; they would have kept passing while asserting against run.ts in its
 * entirety. A missing boundary must fail loudly, so this checks both.
 */
function sliceFunction(src: string, from: string, to: string): string {
  const start = src.indexOf(from);
  assert.notEqual(start, -1, `slice start not found: ${from}`);
  const end = src.indexOf(to, start);
  assert.notEqual(end, -1, `slice end not found: ${to} — did the function move or get removed?`);
  return src.slice(start, end);
}

test('a select arrives as a bare string or as an object, and both mean the same', () => {
  assert.equal(coerce('text', 'Complete').value, 'Complete');
  assert.equal(coerce('text', { id: 'sel1', name: 'Complete' }).value, 'Complete');
});

test('an empty field, an empty string and an empty array all mean no value', () => {
  for (const empty of [undefined, null, '', '   ', []]) {
    assert.equal(coerce('text', empty).value, null, `${JSON.stringify(empty)} should be null`);
  }
});

test('a multiple select keeps every value — this is the task_number bug', () => {
  // 006 typed task_number as scalar text, reasoning from the field's name.
  // Two of thirty sampled tasks carry two values.
  const got = coerce('text[]', ['Task 3a', 'On-Call']);
  assert.deepEqual(got.value, ['Task 3a', 'On-Call']);
  assert.equal(got.problem, undefined);
});

test('a date with a time component keeps the day', () => {
  assert.equal(coerce('date', '2025-04-30').value, '2025-04-30');
  assert.equal(coerce('date', '2025-04-30T17:20:00.000Z').value, '2025-04-30');
});

test('a value that will not coerce leaves the column null and says why', () => {
  const got = coerce('numeric', 'not a number');
  assert.equal(got.value, null);
  assert.match(got.problem ?? '', /expected a number/);
});

test('a link field yields the record id, and flags more than one', () => {
  assert.equal(coerce('link', ['recABCDEFGHIJKLMN']).value, 'recABCDEFGHIJKLMN');
  const two = coerce('link', ['recABCDEFGHIJKLMN', 'recZYXWVUTSRQPONM']);
  assert.equal(two.value, 'recABCDEFGHIJKLMN');
  assert.match(two.problem ?? '', /2 links/);
});

test('an unrecognised choice is reported but does not stop the record', () => {
  const known = ['Complete', 'Quality Control'];
  assert.equal(unknownChoice(known, 'Complete'), null);
  assert.equal(unknownChoice(known, 'complete'), null, 'case must not matter');
  assert.equal(unknownChoice(known, 'Complete - Invoiced'), 'Complete - Invoiced');
});

// ------------------------------------------------------------- the field map

test('every table loads after the tables its links point at', () => {
  const seen = new Set<string>();
  for (const key of LOAD_ORDER) {
    for (const f of spec(key).fields) {
      if (f.kind !== 'link') continue;
      assert.ok(f.linkTo, `${key}.${f.to} is a link with no linkTo`);
      assert.ok(
        seen.has(f.linkTo!) || f.linkTo === key,
        `${key}.${f.to} resolves against ${f.linkTo}, which loads later`
      );
    }
    seen.add(key);
  }
});

test('no table maps two Airtable fields onto one column', () => {
  for (const t of TABLES) {
    const byColumn = new Map<string, string>();
    for (const f of t.fields) {
      const already = byColumn.get(f.to);
      assert.equal(already, undefined, `${t.key}.${f.to} is written by both "${already}" and "${f.from}"`);
      byColumn.set(f.to, f.from);
    }
  }
});

test('the two shared tables refuse to update rows the sync does not own', () => {
  // deliverables also holds portal uploads, with a null key and source
  // 'upload'. Nulls never conflict, so the unique index alone would not stop
  // an upsert inserting a duplicate of every uploaded document, every run.
  assert.match(spec('deliverables').restrictUpdateTo ?? '', /source = 'airtable'/);
  assert.match(spec('deliverables').restrictUpdateTo ?? '', /airtable_record_id is not null/);
  assert.match(spec('projects').restrictUpdateTo ?? '', /airtable_record_id is not null/);
});

// ------------------------------------------------------------- the upsert SQL

/** Exactly what migration 007 withholds from airtable_sync on deliverables. */
const READER_OWNED = [
  'type', 'phase', 'version', 'is_latest_version', 'issue_date', 'estimator',
  'box_file_url', 'source_format', 'file_checksum', 'stated_total_cost',
  'currency', 'status', 'upload_notes', 'ingested_at', 'storage_path',
  'original_filename', 'uploaded_by', 'uploaded_at', 'byte_size',
];

test('the deliverables upsert never rewrites a column the reader owns', () => {
  const updated = updatedColumns(spec('deliverables'));
  for (const col of READER_OWNED) {
    assert.ok(!updated.includes(col), `${col} is the reader's and must not be in the DO UPDATE`);
  }
});

test('columns with no Airtable source are written at insert and never again', () => {
  const t = spec('deliverables');
  // completed_at is derived from due_date at insert; after that the trigger
  // in 007 owns it, and 008 revokes UPDATE on it from the sync entirely.
  assert.ok(columnsFor(t).includes('completed_at'));
  assert.ok(!updatedColumns(t).includes('completed_at'));
  // source is a constant set when the row is created.
  assert.ok(columnsFor(t).includes('source'));
  assert.ok(!updatedColumns(t).includes('source'));
  // ready_for_cost_library is an estimator's tick. The sync never touches it.
  assert.ok(!columnsFor(t).includes('ready_for_cost_library'));
});

test('is_active is never written by the sync — that belongs to the sweep', () => {
  for (const t of TABLES) {
    assert.ok(!columnsFor(t).includes('is_active'), `${t.key} must not write is_active`);
    assert.ok(!columnsFor(t).includes('missing_from_airtable_since'), `${t.key}`);
  }
});

test('synced_at is stamped on every touched row, including unchanged ones', () => {
  // Skipping this for unchanged rows is the natural optimisation and would
  // arm the sweep against the entire mirror: a row read, found unchanged and
  // not stamped is indistinguishable from a row that vanished.
  for (const t of TABLES) {
    assert.match(buildUpsert(t), /synced_at = now\(\)/, `${t.key} must stamp synced_at on update`);
  }
});

test('the upsert matches on the unique key and reports which way it went', () => {
  const sql = buildUpsert(spec('people'));
  assert.match(sql, /on conflict \(airtable_record_id\) do update set/);
  assert.match(sql, /returning id, \(xmax = 0\) as inserted/);
  // `id` is load-bearing, not decoration: without it the uuid of a row just
  // written is unknown, the run has to recover uuids from the whole id list
  // afterwards, and the whole table stays in memory to supply it. Removing
  // it would not fail any other test and would quietly restore the ceiling.
  assert.match(sql, /returning id/, 'the upsert must return the uuid it wrote');
});

test('a shared column yields rather than overwrites when it disagrees', () => {
  // Nothing in phase one uses if_null_or_equal yet — gross_sf is handled as a
  // post-pass — so this proves the mechanism exists for when one does.
  const t = {
    key: 'projects' as const,
    airtable: 'x',
    fields: [{ from: 'A', to: 'gross_sf', kind: 'numeric' as const, writeWhen: 'if_null_or_equal' as const }],
  };
  assert.match(buildUpsert(t), /case when projects\.gross_sf is null or projects\.gross_sf = excluded\.gross_sf/);
});

// ------------------------------------------------------- completed_at at insert

test('completed_at comes from the due date, and only when Phase II says complete', () => {
  assert.equal(
    completedAtOnInsert({ 'Phase II: On the Table (Workflow)': 'Complete', 'Due Date': '2025-04-30' }),
    '2025-04-30T00:00:00Z'
  );
  assert.equal(
    completedAtOnInsert({ 'Phase II: On the Table (Workflow)': 'Quality Control', 'Due Date': '2025-04-30' }),
    null
  );
});

test('a complete task with no due date gets null, not the import date', () => {
  // 360 of the 3,023 complete tasks have no due date. Stamping those with the
  // load date would put something in the column that looks like history.
  assert.equal(completedAtOnInsert({ 'Phase II: On the Table (Workflow)': 'Complete' }), null);
});

// ------------------------------------------------------------------ planning

test('a record becomes values in the column order the statement expects', () => {
  const t = spec('people');
  const plan = planRow(t, {
    id: 'recABCDEFGHIJKLMN',
    fields: { Name: 'Katya M.', Email: 'katya@dcwcost.com', Group: ['Estimating', 'Leadership'] },
  });
  assert.equal(plan.columns.length, plan.values.length);
  assert.equal(plan.values[plan.columns.indexOf('airtable_record_id')], 'recABCDEFGHIJKLMN');
  assert.equal(plan.values[plan.columns.indexOf('name')], 'Katya M.');
  assert.deepEqual(plan.values[plan.columns.indexOf('group_name')], ['Estimating', 'Leadership']);
  assert.equal(plan.values[plan.columns.indexOf('title')], null, 'an absent field is an explicit null');
});

test('a link is held back for the resolver rather than written as a record id', () => {
  const plan = planRow(spec('contacts'), {
    id: 'recABCDEFGHIJKLMN',
    fields: { 'Contact (First Last)': 'A Person', 'Company Link (Primary Key)': ['recZYXWVUTSRQPONM'] },
  });
  assert.equal(plan.values[plan.columns.indexOf('client_company_id')], null);
  assert.deepEqual(plan.pendingLinks, [
    { column: 'client_company_id', linkTo: 'client_companies', recordId: 'recZYXWVUTSRQPONM' },
  ]);
});

test('an unexpected Phase II value is raised as an issue and still loads', () => {
  const plan = planRow(spec('deliverables'), {
    id: 'recABCDEFGHIJKLMN',
    fields: { 'Phase II: On the Table (Workflow)': 'Complete - Invoiced' },
  });
  const issue = plan.issues.find((i) => i.kind === 'unknown_choice');
  assert.ok(issue, 'a renamed choice must surface');
  assert.equal(plan.values[plan.columns.indexOf('phase_ii_workflow')], 'Complete - Invoiced');
});

test('a multiple select feeding a text column reports the values it drops', () => {
  // sector, market and city are single text columns fed from Airtable
  // multiple selects. Keeping the first is all a text column can do; doing it
  // silently is how a project loses its second category without trace.
  const got = coerce('text', ['Healthcare', 'Civic']);
  assert.equal(got.value, 'Healthcare');
  assert.match(got.problem ?? '', /2 values.*Healthcare \| Civic.*kept the first/);
  assert.equal(coerce('text', ['Healthcare']).problem, undefined, 'one value is not a loss');
});

test('no mapped column is fed by a multiple select it cannot hold', () => {
  // This started as "market is text[], sector and city stay scalar", on the
  // measurement that 7% and 2% of projects carried a second value. The dry
  // run turned those percentages into 116 and 37 real projects, each losing
  // real data and each reported to someone who could not act on it. 012
  // widened both, and the rule this test now states is the one that should
  // have been stated first: a multiple select never feeds a scalar column.
  for (const col of ['market', 'sector', 'city']) {
    assert.equal(spec('projects').fields.find((f) => f.to === col)?.kind, 'text[]', col);
  }
});

test('a year bucket is carried as text, never coerced into a date', () => {
  // "*Construction Completion Date" is a single select of bare years on 857
  // of 5,552 tasks. new Date('2018') is 2018-01-01 — a January nobody said.
  const f = spec('deliverables').fields.find((x) => x.to === 'construction_completion');
  assert.equal(f?.kind, 'text');
  assert.equal(coerce('text', '2018').value, '2018', 'the year survives as written');
});

test('construction_start is never mapped, on either table', () => {
  // A single select of month buckets ("May-21") on 3 of 1,877 projects and
  // 16 of 5,552 tasks — but the reason it stays out is whose fact it is.
  // Construction start is the escalation target, which the reader reads from
  // the document with evidence. Migration 009 section 3.
  for (const key of ['projects', 'deliverables'] as const) {
    assert.ok(
      !spec(key).fields.some((f) => f.to === 'construction_start'),
      `${key}.construction_start belongs to the document, not to Airtable`
    );
  }
});

// ------------------------------------------------------------ join tables

test('a link field yields every id, deduplicated, in order', () => {
  assert.deepEqual(allRecordIds(['recAAAAAAAAAAAAAA', 'recBBBBBBBBBBBBBB']),
    ['recAAAAAAAAAAAAAA', 'recBBBBBBBBBBBBBB']);
  assert.deepEqual(allRecordIds(['recAAAAAAAAAAAAAA', 'recAAAAAAAAAAAAAA']), ['recAAAAAAAAAAAAAA']);
  assert.deepEqual(allRecordIds([{ id: 'recAAAAAAAAAAAAAA', name: 'X' }]), ['recAAAAAAAAAAAAAA']);
  assert.deepEqual(allRecordIds(undefined), []);
});

test('the Subconsultants field is not mapped — it points at the wrong table', () => {
  // The name says Subconsultants; the field links to SUBCONSULTANT TASKS,
  // which is why its records display as "1", "2", "3" rather than company
  // names. It is the inverse of Subconsultant Tasks -> Project, so it is a
  // reversed link of the kind 006 dropped 36 of, and this map reintroduced
  // one by trusting the field's name over its target.
  assert.ok(
    !spec('deliverables').joins?.some((j) => j.from === 'Subconsultants'),
    'a reversed link must not be mapped, however it is named'
  );
  assert.ok(
    !spec('deliverables').joins?.some((j) => j.table === 'deliverable_subconsultants'),
    'deliverable_subconsultants has no source: the relationship is subconsultant_tasks'
  );
});

test('the mechanism still handles a join table named after neither side', () => {
  // project_client_contacts names neither side after the other, unlike the
  // deliverable_* tables.
  const j = spec('projects').joins?.[0];
  assert.equal(j?.table, 'project_client_contacts');
  assert.equal(j?.parentColumn, 'project_id');
  assert.equal(j?.childColumn, 'contact_id');
});

test('the scalar columns the join tables replaced are gone from the map', () => {
  // Migration 011 dropped these. A map still naming them would fail on the
  // first upsert, which is loud — but finding it here is cheaper.
  for (const gone of ['project_manager_id', 'project_support_id']) {
    assert.ok(!spec('deliverables').fields.some((f) => f.to === gone), `deliverables.${gone}`);
  }
  assert.ok(!spec('projects').fields.some((f) => f.to === 'client_contact_id'));
  // 012 dropped projects.client_id for project_client_companies.
  assert.ok(!spec('projects').fields.some((f) => f.to === 'client_id'));
  // Next Action Owner is single-valued in Airtable and stays a scalar FK.
  assert.ok(spec('deliverables').fields.some((f) => f.to === 'next_action_owner_id'));
});

test('the client company is a join, and the same field feeds only one of them', () => {
  const j = spec('projects').joins?.find((x) => x.table === 'project_client_companies');
  assert.equal(j?.from, 'Link to Client Company (Add Here)');
  assert.equal(j?.parentColumn, 'project_id');
  assert.equal(j?.childColumn, 'client_company_id');
  assert.equal(j?.linkTo, 'client_companies');
  // The field moved from `fields` to `joins`. Leaving it in both would write
  // the first company to a column 012 dropped, and the upsert would fail on
  // every project — loud, but after a full Airtable read.
  const froms = spec('projects').joins!.map((x) => x.from);
  assert.equal(new Set(froms).size, froms.length, 'one join per Airtable field');
});

test('client_companies loads before projects, so the join can resolve', () => {
  assert.ok(LOAD_ORDER.indexOf('client_companies') < LOAD_ORDER.indexOf('projects'));
});

// ------------------------------------------------- 012's widened columns

test('sector and city take every value now, with nothing reported', () => {
  // 116 projects carry a second sector and 37 a second city. Each one used
  // to be a kept-the-first anomaly: real data loss, reported honestly, and
  // unfixable by whoever read the report, because the answer was a column
  // type. 012 widened both.
  for (const col of ['sector', 'city', 'market']) {
    assert.equal(spec('projects').fields.find((f) => f.to === col)?.kind, 'text[]', col);
  }

  const plan = planRow(spec('projects'), {
    id: 'recABCDEFGHIJKLMN',
    fields: {
      'Project Title': 'Two of each',
      'Primary Category': ['Healthcare', 'Education'],
      'Location (City, State)': ['Portland, OR', 'Vancouver, WA'],
    },
  });
  assert.deepEqual(plan.values[plan.columns.indexOf('sector')], ['Healthcare', 'Education']);
  assert.deepEqual(plan.values[plan.columns.indexOf('city')], ['Portland, OR', 'Vancouver, WA']);
  assert.deepEqual(plan.issues, [], 'nothing dropped, so nothing to report');
});

test('region stays scalar and unmapped', () => {
  // 012 widened sector and city and deliberately left region alone: it is
  // single-valued in Airtable and nothing feeds it yet. A map that grew a
  // region entry would need the column type checked first.
  assert.ok(!spec('projects').fields.some((f) => f.to === 'region'));
});

test('a record becomes one planned join per populated link field', () => {
  const planned = planJoins(spec('deliverables'), {
    id: 'recABCDEFGHIJKLMN',
    fields: {
      'Project Manager *': ['recAAAAAAAAAAAAAA', 'recBBBBBBBBBBBBBB'],
      'Project Support *': ['recCCCCCCCCCCCCCC'],
    },
  });
  assert.equal(planned.length, 2, 'only the populated fields');
  const pm = planned.find((p) => p.join.table === 'deliverable_project_managers');
  assert.deepEqual(pm?.childRecordIds, ['recAAAAAAAAAAAAAA', 'recBBBBBBBBBBBBBB']);
  assert.equal(pm?.parentRecordId, 'recABCDEFGHIJKLMN');
});

test('a join row re-stamps synced_at rather than doing nothing', () => {
  // Same trap as the parent tables: "it already exists, skip it" is the
  // natural optimisation, and the sweep reads synced_at to decide what a run
  // failed to see. A link left unstamped looks like a link that vanished.
  const sql = buildJoinUpsert(spec('projects').joins![0]);
  assert.match(sql, /on conflict \(project_id, contact_id\) do update set synced_at = now\(\)/);
  // No `id` here, unlike the parent upsert. A join row's uuid is never
  // needed — nothing resolves against it — so returning one would be a
  // column fetched for no reader.
  assert.match(sql, /returning \(xmax = 0\) as inserted/);
  assert.ok(!/returning id/.test(sql), 'a join row has no uuid anybody needs');
});

// ------------------------------------------------------- the bundler gap

/**
 * Every module must be importable by the test runner, not just by the bundler.
 *
 * `airtable.ts` once used a constructor parameter property. Netlify's esbuild
 * transformed it happily; Node's --experimental-strip-types removes types
 * without transforming, so it threw — and because nothing in this suite
 * imported that module, nothing noticed. It broke only where no one was
 * looking, which is the same shape as a verification block nothing runs.
 *
 * The suite covers three of the six sync modules by testing them. This covers
 * the rest by the weakest possible means — importing them — which is exactly
 * the check that was missing. It also covers the Netlify entry points, which
 * no test will ever import for any other reason.
 */
test('every sync module and entry point imports under the test runner', async () => {
  const modules = [
    '../sync/coerce.ts',
    '../sync/tables.ts',
    '../sync/plan.ts',
    '../sync/airtable.ts',
    '../sync/db.ts',
    '../sync/run.ts',
    '../../../netlify/functions/airtable-sync-background.mts',
    '../../../netlify/functions/reader-frame-background.mts',
    '../../../netlify/functions/reader-sweep.mts',
  ];
  for (const m of modules) {
    await assert.doesNotReject(() => import(m), `${m} must import cleanly`);
  }
});

test('an anomaly says whether a value survived, not always "left null"', () => {
  // The message was hardcoded to "Column left null", which is true of a
  // number that would not parse and false of a multi-value that kept its
  // first — and the second is most of them. A report that misdescribes
  // itself reads as informative and is worse than none.
  // Since 012 no mapped SELECT can reach this path — every multi-valued one
  // feeds an array. A multi-valued LINK still can: the column holds one uuid
  // and a task with two projects is a question, not a tie to break.
  const kept = planRow(spec('deliverables'), {
    id: 'recABCDEFGHIJKLMN',
    fields: { 'DCW Projects': ['recAAAAAAAAAAAAAA', 'recBBBBBBBBBBBBBB'] },
  });
  assert.match(kept.issues[0].detail, /The first value was written/);

  const lost = planRow(spec('projects'), {
    id: 'recABCDEFGHIJKLMN',
    fields: { 'Contract Amount': 'not a number' },
  });
  assert.match(lost.issues[0].detail, /Column left null/);
});

// ------------------------------------------------- showing values, not counts

test('a rendered row shows the values, the joins and the nulls as a count', () => {
  // The whole point of showRecords: counts are blind to a field mapped to the
  // wrong column or a multi-select landing as one value. Both read 0
  // anomalies. Only a printed row shows them.
  const record = {
    id: 'recW3IXuUePp2V1Bq',
    fields: {
      'Project Title': 'Oregon Zoo Entry Plaza and Polar Plaza Shelter',
      'Primary Category': [{ name: 'Community' }],
      'Secondary Category': [{ name: 'Zoo & Aquariums' }, { name: 'Plaza' }],
      'Location (City, State)': [{ name: 'Portland, OR' }],
      'Link to Client Company (Add Here)': [{ id: 'recrscv0dGezArGmi' }],
    },
  };
  const out = renderPlan(spec('projects'), planRow(spec('projects'), record), record);

  assert.match(out, /name = "Oregon Zoo Entry Plaza and Polar Plaza Shelter"/);
  // The three columns 012 widened, each as a list — this is the assertion
  // that would have failed before 012 and said so in a way a count could not.
  assert.match(out, /sector = \["Community"\]\s+\(1\)/);
  assert.match(out, /market = \["Zoo & Aquariums", "Plaza"\]\s+\(2\)/);
  assert.match(out, /city = \["Portland, OR"\]\s+\(1\)/);
  assert.match(out, /JOIN project_client_companies -> client_companies: recrscv0dGezArGmi/);
  assert.match(out, /columns null/, 'nulls are counted, not listed');
  assert.match(out, /no anomalies/);
});

test('a complete task renders the completed_at the sync derived', () => {
  // completed_at comes from neither a column nor a constant — it is derived
  // from Phase II plus Due Date, so it is exactly the kind of value worth
  // seeing rather than trusting.
  const record = {
    id: 'recKtnJugR0TUc2D6',
    fields: {
      'Task Name': '30% Schematic Design (Polar Plaza Only)',
      'Phase II: On the Table (Workflow)': { name: 'Complete' },
      'Due Date': '2025-03-07',
      'Project Manager *': [{ id: 'reckA16yMOzFxZUiu' }],
    },
  };
  const out = renderPlan(spec('deliverables'), planRow(spec('deliverables'), record), record);
  assert.match(out, /completed_at = "2025-03-07T00:00:00Z"/);
  assert.match(out, /JOIN deliverable_project_managers -> people: reckA16yMOzFxZUiu/);
});

test('a long value is cut, with its real length kept', () => {
  // project_description is ~1,000 characters on a real project. Five
  // rendered rows would be mostly one field, and the columns worth checking
  // would scroll past.
  const record = {
    id: 'recW3IXuUePp2V1Bq',
    fields: { 'Project Title': 'Zoo', 'Project Description': 'x'.repeat(1000) },
  };
  const out = renderPlan(spec('projects'), planRow(spec('projects'), record), record);
  assert.match(out, /… \(1002 chars\)/, 'cut, and says how much was cut');
  assert.ok(out.length < 700, `rendered row stays small, got ${out.length}`);
  assert.match(out, /name = "Zoo"/, 'the short columns are still legible');
});

test('a link that did not resolve is named, not silently null', () => {
  // The failure mode this guards: an unresolved link leaves the column null,
  // and a null is skipped by the renderer — so the one outcome worth seeing
  // would look exactly like a field nobody filled in.
  const record = {
    id: 'recKtnJugR0TUc2D6',
    fields: { 'Task Name': 'Orphan', 'DCW Projects': [{ id: 'recMISSING0000000' }] },
  };
  const out = renderPlan(spec('deliverables'), planRow(spec('deliverables'), record), record);
  assert.match(out, /project_id = UNRESOLVED \(recMISSING0000000 not found in projects\)/);
});

// ------------------------------------------------------------ run scope

test('a scoped run writes parents before children whatever order is asked', () => {
  // The list arrives from an HTTP body, where nothing guarantees sensible
  // order. A child written before its parent resolves no links at all, so
  // the request is intersected with LOAD_ORDER rather than trusted.
  assert.deepEqual(selectedTables(['deliverables', 'projects']), ['projects', 'deliverables']);
  assert.deepEqual(selectedTables(['people', 'subconsultants']), ['people', 'subconsultants']);
  assert.deepEqual(selectedTables(), [...LOAD_ORDER]);
  assert.deepEqual(selectedTables([]), [...LOAD_ORDER], 'empty means all, not none');
});

test('an unknown table name fails the run rather than syncing less', () => {
  // Silently dropping a misspelling would sync fewer tables than were asked
  // for and report success, which is the failure this whole option exists
  // to avoid on a first real run.
  assert.throws(() => selectedTables(['peoples' as never]), /unknown table\(s\): peoples/);
});

test('the text match only sees fields the table maps', () => {
  // The failure this guards is the one the first dry run produced: Airtable
  // returns every field including lookups the map ignores, so a person's
  // record carries the name of every project they have touched. "Oregon Zoo"
  // matched two staff and five Metro tasks that have the phrase in no column
  // the mirror stores.
  const record = {
    id: 'recAAAAAAAAAAAAAA',
    fields: {
      'Task Name': 'Site Visit',
      // Not in the deliverables map: a lookup Airtable sends anyway.
      'Projects Lookup': ['Oregon Zoo Entry Plaza', 'Blue Lake Park'],
    },
  };
  const t = spec('deliverables');
  const plan = planRow(t, record);
  const out = renderPlan(t, plan, record);
  // The unmapped lookup must not appear in what would be written, which is
  // the same reason it must not drive a match.
  assert.ok(!out.includes('Oregon Zoo'), 'an unmapped lookup is not written');
  assert.match(out, /task_name = "Site Visit"/);
});

// ------------------------------------------- createdTime is not a field

test('airtable_created_at comes from the record, not the date-only field', () => {
  // The "Date Created" FIELD is a createdTime column formatted date-only:
  // Airtable returns "2024-09-10" for a record created at 21:28:29Z. Stored
  // as UTC midnight it renders in Pacific as the 9th — a day early on every
  // row, with nothing in the data to reveal it.
  const record = {
    id: 'recW3IXuUePp2V1Bq',
    createdTime: '2024-09-10T21:28:29.000Z',
    fields: {
      'Project Title': 'Oregon Zoo Entry Plaza',
      // Still present in Airtable's response, and must now be ignored.
      'Date Created': '2024-09-10',
    },
  };
  const plan = planRow(spec('projects'), record);
  const at = plan.values[plan.columns.indexOf('airtable_created_at')];
  assert.equal(at, '2024-09-10T21:28:29.000Z');
  assert.notEqual(at, '2024-09-10T00:00:00.000Z', 'midnight is the bug, not the value');
});

test('every table with a created column declares where it comes from', () => {
  // Five tables carry one. None may go back to mapping the field: the field
  // still exists in Airtable and still parses, so a reintroduced mapping
  // would look correct and be a day early.
  const expected: Record<string, string> = {
    subconsultants: 'airtable_created_at',
    client_companies: 'airtable_created_at',
    contacts: 'added_on',
    projects: 'airtable_created_at',
    deliverables: 'airtable_created_at',
  };
  for (const [key, col] of Object.entries(expected)) {
    assert.equal(spec(key as never).createdAtColumn, col, key);
    assert.ok(
      !spec(key as never).fields.some((f) => f.to === col),
      `${key}.${col} must not also be mapped from a field`
    );
  }
  assert.equal(spec('people').createdAtColumn, undefined, 'people has no created column');
});

test('a missing createdTime is an anomaly, not an Invalid Date', () => {
  const plan = planRow(spec('projects'), {
    id: 'recW3IXuUePp2V1Bq',
    fields: { 'Project Title': 'No metadata' },
  });
  assert.equal(plan.values[plan.columns.indexOf('airtable_created_at')], null);
  assert.equal(plan.issues.length, 0, 'absent metadata is empty, not malformed');

  const bad = planRow(spec('projects'), {
    id: 'recW3IXuUePp2V1Bq',
    createdTime: 'not a timestamp',
    fields: { 'Project Title': 'Bad metadata' },
  });
  assert.equal(bad.values[bad.columns.indexOf('airtable_created_at')], null);
  assert.match(bad.issues[0].detail, /createdTime → airtable_created_at/);
});

test('every counter on TableResult has a column to land in', () => {
  // blocked was counted for the whole life of the sync and had nowhere to
  // go but the free-text summary, because sync_run_tables had no column for
  // it. It read 0 on every dry run, which proves nothing: a dry run writes
  // nothing, so nothing can be blocked. This asserts the insert names every
  // counter, so the next one added cannot go missing the same way.
  const src = readSource(new URL('./run.ts', import.meta.url));
  const insert = src.slice(src.indexOf('insert into sync_run_tables'));
  const columns = insert.slice(0, insert.indexOf(')')).match(/\w+/g) ?? [];
  for (const counter of [
    'read_from_airtable', 'inserted', 'updated', 'unchanged',
    'would_insert_existing', 'unresolved_parents', 'anomalies', 'blocked',
  ]) {
    assert.ok(columns.includes(counter), `sync_run_tables insert must write ${counter}`);
  }
});

test('the text match only sees fields the table maps', () => {
  // The failure this guards is the one the first dry run produced: Airtable
  // returns every field including lookups the map ignores, so a person's
  // record carries the name of every project they have touched. "Oregon Zoo"
  // matched two staff and five Metro tasks that have the phrase in no column
  // the mirror stores.
  const record = {
    id: 'recAAAAAAAAAAAAAA',
    fields: {
      'Task Name': 'Site Visit',
      // Not in the deliverables map: a lookup Airtable sends anyway.
      'Projects Lookup': ['Oregon Zoo Entry Plaza', 'Blue Lake Park'],
    },
  };
  const t = spec('deliverables');
  const plan = planRow(t, record);
  const out = renderPlan(t, plan, record);
  // The unmapped lookup must not appear in what would be written, which is
  // the same reason it must not drive a match.
  assert.ok(!out.includes('Oregon Zoo'), 'an unmapped lookup is not written');
  assert.match(out, /task_name = "Site Visit"/);
});

// --------------------------------------------- parsing the request body

test('the request body becomes options, with empties dropped', () => {
  const p = parseSyncRequest({
    dryRun: true,
    sampleSize: 50.9,
    showRecords: ['Oregon Zoo', '', '   ', 'recKtnJugR0TUc2D6'],
    showLimit: 3,
    tables: ['people', 'subconsultants'],
  });
  assert.equal(p.dryRun, true);
  assert.equal(p.sampleSize, 50, 'floored');
  assert.deepEqual(p.showRecords, ['Oregon Zoo', 'recKtnJugR0TUc2D6'], 'blanks dropped');
  assert.equal(p.showLimit, 3);
  assert.deepEqual(p.tables, ['people', 'subconsultants']);
});

test('dryRun is strictly true, never truthy', () => {
  // The direction of this mistake is a real write someone believed was a
  // rehearsal, so "false", 1 and "yes" must all mean a real run was asked
  // for explicitly — not accidentally turned into one.
  assert.equal(parseSyncRequest({ dryRun: 'false' }).dryRun, false);
  assert.equal(parseSyncRequest({ dryRun: 'true' }).dryRun, false);
  assert.equal(parseSyncRequest({ dryRun: 1 }).dryRun, false);
  assert.equal(parseSyncRequest({}).dryRun, false);
  assert.equal(parseSyncRequest({ dryRun: true }).dryRun, true);
});

test('an empty or junk body gives an all-tables real run, not a crash', () => {
  for (const body of [undefined, null, {}, [], 'nonsense', 42]) {
    const p = parseSyncRequest(body);
    assert.equal(p.dryRun, false);
    assert.equal(p.tables, undefined, 'undefined means every table');
    assert.equal(p.showRecords, undefined);
  }
});

test('an unknown table name survives parsing so the run can reject it', () => {
  // Parsing must NOT filter it: runSync throws on an unknown name and closes
  // the run as failed with the reason. Dropping it here would sync fewer
  // tables than were asked for and report success.
  assert.deepEqual(parseSyncRequest({ tables: ['peoples'] }).tables, ['peoples']);
  assert.throws(() => selectedTables(parseSyncRequest({ tables: ['peoples'] }).tables), /unknown table/);
});

test('nothing the handler passes to runSync is named `tables`', () => {
  // The outage: the handler had `const tables = …`, then
  // `const { runId, tables } = await withDb(…)` inside the try block, and the
  // arrow passed to withDb bound to the shadow mid-initialisation. Every
  // request died in the temporal dead zone before opening a run, while the
  // background function answered 202. Nothing could catch it, because the
  // handler reads Netlify.env and no test can invoke it.
  const src = readSource(new URL('../../../netlify/functions/airtable-sync-background.mts', import.meta.url));
  assert.ok(!/const\s+tables\s*=/.test(src), 'no local named `tables` in the handler');
  assert.ok(
    /const\s*\{\s*runId,\s*tables:\s*\w+\s*\}/.test(src),
    "runSync's returned `tables` must be renamed on destructuring"
  );
  assert.ok(src.includes('parseSyncRequest'), 'body parsing stays in the tested module');
});

// ------------------------------ the handler, actually invoked

const ENV = {
  AIRTABLE_SYNC_DATABASE_URL: 'postgres://airtable_sync@example/db',
  AIRTABLE_API_KEY: 'key',
  AIRTABLE_BASE_ID: 'appNKOkUcvzzX3BIw',
  SYNC_TRIGGER_SECRET: 'sssssssssssssssssssssssssssssss1',
};

function post(body: unknown, secret = ENV.SYNC_TRIGGER_SECRET) {
  return new Request('https://example.test/.netlify/functions/airtable-sync-background', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sync-secret': secret },
    body: JSON.stringify(body),
  });
}

/** Records what the handler passed, and never touches a database. */
function spy() {
  const seen: any[] = [];
  const run = async (dbUrl: string, opts: any) => {
    seen.push({ dbUrl, opts });
    return { runId: 'run-1', tables: [] };
  };
  return { seen, run };
}

test('the handler passes through what it parsed', async () => {
  // THE TEST THAT WAS MISSING. Not "does the module load" — it loaded fine
  // while every request died — but "does what the handler parsed reach the
  // runner". The shadowed `tables` failed exactly here.
  const s = spy();
  await handleSync(post({ dryRun: true, tables: ['people', 'subconsultants'], showLimit: 2 }), ENV, s.run);
  assert.equal(s.seen.length, 1, 'the runner was called');
  assert.deepEqual(s.seen[0].opts.tables, ['people', 'subconsultants']);
  assert.equal(s.seen[0].opts.dryRun, true);
  assert.equal(s.seen[0].opts.showLimit, 2);
  assert.equal(s.seen[0].opts.baseId, ENV.AIRTABLE_BASE_ID);
  assert.equal(s.seen[0].dbUrl, ENV.AIRTABLE_SYNC_DATABASE_URL);
});

test('the handler adopts a run id the trigger opened', async () => {
  const s = spy();
  await handleSync(post({ runId: 'abc-123', tables: ['people'] }), ENV, s.run);
  assert.equal(s.seen[0].opts.runId, 'abc-123', 'otherwise a second row opens and the caller\'s id stays empty');
});

test('a bad secret runs nothing', async () => {
  const s = spy();
  await handleSync(post({ tables: ['people'] }, 'wrong'), ENV, s.run);
  assert.equal(s.seen.length, 0);
});

test('a missing env var runs nothing', async () => {
  for (const key of Object.keys(ENV)) {
    const s = spy();
    await handleSync(post({ tables: ['people'] }), { ...ENV, [key]: undefined }, s.run);
    assert.equal(s.seen.length, 0, `${key} unset must stop the run`);
  }
});

test('a GET runs nothing', async () => {
  const s = spy();
  const req = new Request('https://example.test/x', {
    method: 'GET',
    headers: { 'x-sync-secret': ENV.SYNC_TRIGGER_SECRET },
  });
  await handleSync(req, ENV, s.run);
  assert.equal(s.seen.length, 0);
});

test('a thrown run is caught, not left unhandled', async () => {
  // runSync closes the row as failed itself; the handler must not add an
  // unhandled rejection on top, which on Netlify kills the invocation
  // before the log line is written.
  const boom: any = async () => {
    throw new Error('database on fire');
  };
  await handleSync(post({ tables: ['people'] }), ENV, boom);
});

test('machine endpoints are exempt from the session guard on purpose', () => {
  // The guard only covers /teamintranet today, so /api/sync/trigger passes
  // through whether or not anyone intended it. This asserts the intent is
  // written down and checked first, so widening the guard later cannot
  // silently break the trigger.
  const mw = readSource(new URL('../../middleware.ts', import.meta.url));
  assert.match(mw, /MACHINE_PATHS = \[[^\]]*'\/api\/sync\/trigger'/);
  const machineAt = mw.indexOf('if (isMachine(path)) return next();');
  const intranetAt = mw.indexOf('if (!isIntranet(path)) return next();');
  assert.ok(machineAt > 0 && machineAt < intranetAt, 'the exemption must be checked first');
});

test('the trigger awaits the hand-off rather than firing and forgetting', () => {
  // `void fetch(...)` in a serverless function is cancelled the moment the
  // response is returned, because the instance is frozen. The first run
  // through this route left a row in `running` with nothing written.
  //
  // The reasoning that produced it was the error worth guarding: awaiting
  // the POST was confused with awaiting the fifteen minutes of work. Netlify
  // answers the POST in milliseconds and runs the function afterwards.
  const src = readSource(new URL('../../pages/api/sync/trigger.ts', import.meta.url));
  // Comments stripped first: this file explains the bug by name, and a
  // check that cannot tell prose from code would fail on the explanation.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/void\s+fetch\(/.test(code), 'the hand-off must not be fire-and-forget');
  assert.match(code, /await fetch\(/, 'the hand-off must be awaited');
  assert.match(code, /outcome = 'failed'/, 'a failed hand-off must close the row it opened');
  assert.match(code, /json\(502/, 'and must tell the caller');
});

// ------------------------ skipping what the database would refuse

test('every counter including skipped has a column to land in', () => {
  const src = readSource(new URL('./run.ts', import.meta.url));
  const insert = src.slice(src.indexOf('insert into sync_run_tables'));
  const columns = insert.slice(0, insert.indexOf(')')).match(/\w+/g) ?? [];
  for (const counter of [
    'read_from_airtable', 'inserted', 'updated', 'unchanged',
    'would_insert_existing', 'unresolved_parents', 'anomalies', 'blocked', 'skipped',
  ]) {
    assert.ok(columns.includes(counter), `sync_run_tables insert must write ${counter}`);
  }
});

test('required columns are read from the database, not declared', () => {
  // A list in the field map would drift: a migration adding a NOT NULL
  // column would not be reflected until someone remembered. That is the
  // failure shape this project has hit six times in other forms.
  const src = readSource(new URL('./run.ts', import.meta.url));
  assert.match(src, /information_schema\.columns/);
  assert.match(src, /is_nullable = 'NO' and column_default is null/);
  // Columns WITH a default must be excluded, or records would be skipped
  // over values Postgres was always going to supply.
  assert.ok(!/is_nullable = 'NO'\s*\)/.test(src), 'the default clause must not be dropped');
});

test('the skip check runs after link resolution, not before', () => {
  // deliverables.project_id is NOT NULL and is filled by resolution. Checked
  // before that, every deliverable would look unwritable; checked after, only
  // the ones whose project genuinely did not resolve do.
  const src = readSource(new URL('./run.ts', import.meta.url));
  // requiredColumns is now fetched once before the first page, so its
  // position no longer says anything. What matters is the order INSIDE the
  // page handler: resolve links, then decide what the database would refuse.
  const resolve = src.indexOf('result.unresolvedParents++');
  const skip = src.indexOf('const writable: RowPlan[] = [];');
  assert.ok(resolve > 0, 'link resolution must exist');
  assert.ok(skip > resolve, 'the skip pass must come after resolution');
  // And the fatal check must stay out of the page loop entirely.
  const req = src.indexOf('const required = await requiredColumns');
  const stream = src.indexOf('await streamTable(');
  assert.ok(req > 0 && req < stream, 'requiredColumns must be fetched before the first page');
});

test('the non-billable bucket records why skipping it defers a problem', () => {
  // Skipping recXCLgbkVXQtgUlk is not cleanup. It is a deliberate structure
  // with 19,566 hours on it, and the cost lands when time_entries syncs.
  const note = KNOWN_SKIPS['recXCLgbkVXQtgUlk'];
  assert.ok(note, 'the bucket must carry an explanation');
  assert.match(note, /19,566/, 'says what is at stake');
  assert.match(note, /by design/i, 'says the missing link is intentional');
  assert.match(note, /time_entries/, 'says when the cost lands');
  assert.match(note, /NULLABLE/, 'says what the fix is');
  assert.match(note, /lie about itself/, 'and why not a synthetic project');
});

test('a required column nothing maps fails the run before the first batch', () => {
  // If the database requires a column the field map never writes, every
  // insert fails. Saying so once, up front, beats discovering it 200 rows
  // into a transaction.
  const src = readSource(new URL('./run.ts', import.meta.url));
  assert.match(src, /the field map never writes/);
  assert.match(src, /throw new Error\(/);
});

// --------------------------------------------- finishing a killed run

test('joinsOnly is parsed, and strictly true', () => {
  assert.equal(parseSyncRequest({ joinsOnly: true }).joinsOnly, true);
  assert.equal(parseSyncRequest({ joinsOnly: 'true' }).joinsOnly, false);
  assert.equal(parseSyncRequest({}).joinsOnly, false);
});

test('the handler passes joinsOnly through to the runner', async () => {
  const s = spy();
  await handleSync(post({ tables: ['deliverables'], joinsOnly: true }), ENV, s.run);
  assert.equal(s.seen[0].opts.joinsOnly, true);
});

test('joinsOnly loads parent keys instead of writing parents', () => {
  // A join row needs its parent's uuid. On a normal run the parent upsert
  // supplies it; with the parent skipped it has to come from the mirror, or
  // every join row would be unresolved.
  const src = readSource(new URL('./run.ts', import.meta.url));
  const branch = src.slice(src.indexOf('if (opts.joinsOnly) {'));
  assert.match(branch.slice(0, 400), /loadKeyMap\(db, key\)/);
  // And it must not report a parent result, or the run reads as though the
  // parent was attempted and wrote nothing.
  assert.match(src, /opts\.joinsOnly \? \[\] : \[result\]/);
});

test('the time budget is checked inside the page loop', () => {
  // The 5 October run died inside deliverables' join tables with the budget
  // never consulted: it was checked in the LOAD_ORDER loop and nowhere else,
  // so a table whose joins are 5,377 writes could overrun without ever
  // asking. The run row was left saying `running` because closeRun never ran.
  //
  // Now that a table is written page by page, per page is the right place —
  // it is checked more often than per join was, and it covers the parent
  // writes as well as the join writes.
  const src = readSource(new URL('./run.ts', import.meta.url));
  const handler = src.slice(src.indexOf('}, async (page) => {'));
  assert.match(handler.slice(0, 900), /RUN_BUDGET_MS/, 'the page handler must check the budget');
  assert.match(handler.slice(0, 1200), /Re-run the same scope/, 'and say how to recover');
});

test('measure is parsed and reaches the runner', async () => {
  assert.equal(parseSyncRequest({ measure: true }).measure, true);
  assert.equal(parseSyncRequest({ measure: 'yes' }).measure, false);
  const s = spy();
  await handleSync(post({ dryRun: true, tables: ['deliverables'], sampleSize: 100, measure: true }), ENV, s.run);
  assert.equal(s.seen[0].opts.measure, true);
  assert.equal(s.seen[0].opts.sampleSize, 100);
});

test('measuring is off unless asked, because it costs memory to do', () => {
  // It keeps the response body as a string alongside the parsed objects.
  // Adding that to every run is the one thing a memory investigation must
  // not do, so the default path must still go straight to res.json().
  const src = readSource(new URL('./airtable.ts', import.meta.url));
  assert.match(src, /if \(!opts\.measure\) return \(await res\.json\(\)\) as Page;/);
  assert.equal(parseSyncRequest({}).measure, false);
});

test('a dry run loads out-of-scope parent keys, like a real run does', () => {
  // Observed: {"dryRun":true,"tables":["deliverables"]} reported 100 of 100
  // records unresolved and skipped, because the loop that loads keys for
  // out-of-scope tables exited early on dryRun. `projects` was not in scope,
  // so no project link resolved, so project_id was null on every record and
  // the skip pass removed all of them.
  //
  // A dry run that reports the opposite of the real run is worse than no dry
  // run, because it is the thing being trusted before writing.
  // Comments stripped first: the explanation below the loop quotes a JSON
  // body containing braces, and slicing to the first `}` lands inside it.
  const src = readSource(new URL('./run.ts', import.meta.url))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const loop = src.slice(src.indexOf('for (const key of skipped) {'));
  const body = loop.slice(0, loop.indexOf('\n  }') + 1);
  assert.ok(!/if \(opts\.dryRun\) continue;/.test(body), 'must not skip key loading on a dry run');
  assert.match(body, /loadKeyMap\(db, key\)/);
});

// ------------------------------------------------- streaming, not holding

test('nothing in syncTable holds the whole table', () => {
  // The ceiling was never a design decision — it was `readTable` building an
  // array because the upsert did not return the uuid it had written. 5,557
  // deliverables is 334 MB of raw JSON, and a run measured 821 MB of 1,024.
  const src = readSource(new URL('./run.ts', import.meta.url));
  const fn = sliceFunction(src, 'async function syncTable(', 'async function existingKeys(');
  assert.ok(!/\breadTable\(/.test(fn), 'syncTable must stream, not accumulate');
  assert.match(fn, /await streamTable\(/);
  // The page is the unit of work; a second full pass over records for joins
  // would put the array straight back.
  assert.ok(!/records\.filter|records\.map|of records\)/.test(fn), 'no whole-table array may survive');
});

test('join rows are written beside their parents, from the returned uuid', () => {
  // The structural change. Joins used to need a second pass over every
  // record because a parent's uuid was only knowable after the fact.
  const src = readSource(new URL('./run.ts', import.meta.url));
  assert.match(src, /parentKeys\.set\(recordId, String\(row\.id\)\)/);
  assert.ok(!src.includes('async function syncJoin'), 'the second pass is gone');
  // MATCHED BY KEY, NEVER BY POSITION. RETURNING order is unspecified, so
  // zipping the returned rows against what was sent would attach uuids to
  // the wrong records — silently, and only when Postgres happened to
  // reorder. The key has to come back in the clause for that reason.
  assert.match(src, /const recordId = String\(row\.airtable_record_id\)/);
});

test('the key map is published before the first page, and grows', () => {
  // Later tables resolve against it while this one is still streaming, so it
  // must be the same Map object throughout rather than replaced at the end.
  const src = readSource(new URL('./run.ts', import.meta.url));
  const fn = sliceFunction(src, 'async function syncTable(', 'async function existingKeys(');
  const publish = fn.indexOf('keys.set(key, parentKeys)');
  const stream = fn.indexOf('await streamTable(');
  assert.ok(publish > 0 && publish < stream, 'the map must be published before streaming starts');
  assert.ok(!/keys\.set\(key, new Map\(/.test(fn), 'it must never be replaced wholesale');
});

test('anomalies are written per page, not once at the end', () => {
  // A run killed mid-table used to record none at all for that table.
  const src = readSource(new URL('./run.ts', import.meta.url));
  const handler = src.slice(src.indexOf('}, async (page) => {'), src.indexOf('log(`${key}: read ${total}'));
  assert.match(handler, /await recordAnomalies\(db, runId, key, issues\)/);
});

test('streamTable hands over pages and keeps none of them', async () => {
  const { streamTable } = await import('./airtable.ts');
  const src = readSource(new URL('./airtable.ts', import.meta.url));
  const fn = src.slice(src.indexOf('export async function streamTable'));
  assert.ok(typeof streamTable === 'function');
  // It returns a count, not an array. Returning the records would make the
  // caller's discipline optional, which is how this went wrong the first time.
  assert.match(fn.slice(0, 400), /Promise<number>/);
  assert.ok(!/out\.push/.test(fn.slice(0, 1400)), 'streamTable must not accumulate');
});

test('maxRecords trims before the handler sees the page', () => {
  // sampleSize is how the memory baseline was measured. Handing over 100
  // records and trimming afterwards would mean the handler had already
  // planned and written rows the caller never asked for.
  const src = readSource(new URL('./airtable.ts', import.meta.url));
  const fn = src.slice(src.indexOf('export async function streamTable'));
  const trim = fn.indexOf('records = records.slice(0, opts.maxRecords - total)');
  const hand = fn.indexOf('await onRecords(');
  assert.ok(trim > 0 && trim < hand, 'trim must happen before the handler is called');
});

test('a join table records its own anomalies, under its own name', () => {
  // "recX is not in contacts" filed under `projects` is a row nobody
  // looking at project_client_contacts would ever find. The pre-streaming
  // code got this right via a separate function; the rewrite nearly lost it
  // by folding join issues into the parent's list.
  const src = readSource(new URL('./run.ts', import.meta.url));
  assert.match(src, /const joinIssues: \{ recordId: string; issue: Issue \}\[\] = \[\];/);
  assert.match(src, /await recordAnomalies\(db, runId, join\.table, joinIssues\)/);
  assert.match(src, /jr\.anomalies \+= joinIssues\.length/);
});

test('a measured run totals the bytes it read, not just the records', () => {
  // The per-page line cannot answer the question the measurement exists
  // for. If memory tracks BYTES rather than RECORDS, time_entries — person,
  // date, hours, task — extrapolates completely differently from
  // deliverables' 60 columns, whose pages already range 41–66 KB a record.
  const src = readSource(new URL('./run.ts', import.meta.url));
  assert.match(src, /bytesRead \+= m\.bytes/);
  assert.match(src, /TOTAL \$\{total\} records, \$\{bytesRead\} bytes on the wire/);
  // Only when asked, like the per-page measurement it totals.
  assert.match(src, /if \(opts\.measure\) \{\s*\n\s*log\(\s*\n\s*`\$\{key\}: TOTAL/);
});

// ------------------------------------------- sizing a table before mapping it

test('measureOnly is parsed as a table name, not a LOAD_ORDER key', () => {
  // The whole point is sizing a table that has no field map, so it cannot
  // be validated against LOAD_ORDER — "Time Tracking" is an Airtable table
  // name and will never be a key.
  assert.equal(parseSyncRequest({ measureOnly: 'Time Tracking' }).measureOnly, 'Time Tracking');
  assert.equal(parseSyncRequest({ measureOnly: '  ' }).measureOnly, undefined);
  assert.equal(parseSyncRequest({}).measureOnly, undefined);
  assert.equal(parseSyncRequest({ measureOnly: 42 }).measureOnly, undefined);
});

test('a measuring run writes nothing and syncs nothing', () => {
  // It must not touch LOAD_ORDER at all. The alternative considered was a
  // four-of-seventy-four field map for time_entries so a measurement could
  // run, which would have meant the next full sync loading that table with
  // most of its columns empty.
  const src = readSource(new URL('./run.ts', import.meta.url));
  const branch = src.slice(src.indexOf('if (opts.measureOnly) {'));
  const body = branch.slice(0, branch.indexOf('const selected = selectedTables'));
  assert.ok(!/syncTable\(/.test(body), 'a measuring run must not sync a table');
  assert.match(body, /return \{ runId, tables: \[\] \}/, 'and reports no table results');
  // Its run row must never read 'full', or the sweep would act on a run
  // that read one table and wrote nothing.
  assert.match(src, /scope, dry_run, notes\) values \(\$1, true, \$2\)/);
  assert.match(src, /`measure:\$\{table\}`/);
});

test('the measurement reports a distribution, not just an average', () => {
  // A mean alone is what made generalising from one page wrong: deliverables
  // average 54 KB with a 402 KB tail. Three more numbers cost nothing.
  const src = readSource(new URL('./run.ts', import.meta.url));
  const fn = src.slice(src.indexOf('async function measureAirtableTable'));
  for (const part of ['min ${', 'median ~${', 'max ${', 'avg ${']) {
    assert.ok(fn.includes(part), `the summary must report ${part}`);
  }
  assert.match(fn, /would reach the measured memory ceiling/);
});

test('the measuring handler keeps no pages', () => {
  // It can be pointed at a table of any size, which is only true because
  // the page is measured as it arrives and then dropped.
  const src = readSource(new URL('./run.ts', import.meta.url));
  const fn = src.slice(src.indexOf('async function measureAirtableTable'), src.indexOf('/**\n * The tables to sync'));
  assert.ok(!/push\(\.\.\.|\.push\(record/.test(fn), 'nothing may accumulate');
  assert.match(fn, /\(\) => \{\}/, 'the page handler discards');
});

test('a measuring run is labelled as one, wherever the row is opened', () => {
  // The row is opened by the trigger and adopted by the function, so the
  // function's own labelling never runs. Two measurements were recorded as
  // `scope phase1, dry_run false, succeeded` — a full-scope real sync that
  // wrote nothing — and that misled me within two minutes of shipping it.
  const route = readSource(new URL('../../pages/api/sync/trigger.ts', import.meta.url));
  const branch = route.slice(route.indexOf('if (opts.measureOnly) {'));
  assert.match(branch.slice(0, 500), /values \(\$1, true, \$2\)/, 'must record dry_run = true');
  assert.match(branch.slice(0, 500), /`measure:\$\{opts\.measureOnly\}`/, 'and a measure scope');
  // Still never 'full', whichever path opened it.
  assert.ok(!/values \('full'/.test(route));
});

test('no guard reads source without normalising line endings', () => {
  // The guards in this repo assert on the SHAPE of source files, matching
  // patterns that contain \n. Git on Windows checks files out as CRLF, so a
  // raw readFileSync makes every such pattern miss — indexOf returns -1, a
  // slice runs to end-of-file, and the assertion matches an unrelated
  // function. One of them passed for the wrong reason for an hour.
  //
  // readSource normalises. This stops the next guard reintroducing it.
  for (const file of [
    '../sync/sync.test.ts',
    '../intranet/project-sort.test.ts',
    '../intranet/data/provider.test.ts',
  ]) {
    const src = readSource(new URL(file, import.meta.url));
    assert.ok(
      !/readFileSync\(/.test(src),
      `${file} must use readSource, not readFileSync — CRLF breaks \n patterns`,
    );
  }
});

// --------------------------------------------- one statement, many rows

test('the batch size is derived from the column count, never assumed', () => {
  // Postgres accepts 65,535 bind parameters per statement and a batch
  // spends rows x columns of them. A hardcoded size would be fine until a
  // table wide enough to exceed it, where the failure is at execution.
  const deliverables = maxRowsPerStatement(spec('deliverables'));
  const contacts = maxRowsPerStatement(spec('contacts'));
  assert.ok(deliverables < contacts, 'a wider table must allow fewer rows');
  // Columns, not columns + 1: synced_at is now() in the statement, not a
  // bound parameter. Getting that wrong understates the ceiling, which is
  // the safe direction — but it is also how a correct implementation gets
  // "fixed" into a slower one.
  for (const key of ['deliverables', 'contacts'] as const) {
    const cols = columnsFor(spec(key)).length;
    const rows = maxRowsPerStatement(spec(key));
    assert.ok(rows * cols <= 65535, `${key}: ${rows} x ${cols} must fit in 65,535 parameters`);
    assert.ok((rows + 1) * cols > 65535, `${key}: must be the largest batch that fits`);
    // And the generated statement must actually bind that many.
    assert.equal((buildBatchUpsert(spec(key), 3).match(/\$\d+/g) ?? []).length, cols * 3);
  }
  // And it must be visible, or a slow run has nothing on screen to explain it.
  const src = readSource(new URL('./run.ts', import.meta.url));
  assert.match(src, /writing in batches of \$\{batchRows\} \(\$\{columnsFor\(t\)\.length\} columns\)/);
});

test('a batch statement binds every row and returns the key', () => {
  const sql = buildBatchUpsert(spec('people'), 3);
  const cols = columnsFor(spec('people')).length;
  assert.equal((sql.match(/\$\d+/g) ?? []).length, cols * 3, 'every column of every row is bound');
  assert.match(sql, /returning airtable_record_id, id, \(xmax = 0\) as inserted/);
  // Without the key there is no correspondence between sent and returned.
  assert.match(sql, /returning airtable_record_id/);
  assert.equal((sql.match(/now\(\)/g) ?? []).length, 4, 'synced_at per row, plus the DO UPDATE');
});

test('duplicate keys in one batch are recorded, not silently dropped', () => {
  // ON CONFLICT DO UPDATE refuses when a key appears twice in one
  // statement — "cannot affect row a second time". That cannot happen one
  // row at a time, so it is new. Dropping the duplicate quietly would hide
  // whether Airtable returned it twice or a page boundary overlapped.
  const src = readSource(new URL('./run.ts', import.meta.url));
  assert.match(src, /the same Airtable record id appeared twice/);
  assert.match(src, /const byKey = new Map<string, RowPlan>\(\)/);
  // Join pairs are deduped too, but a repeated link is benign and needs no
  // anomaly — the link is recorded once either way.
  assert.match(src, /const seenPairs = new Set<string>\(\)/);
});

test('a failed batch is replayed row by row, and writes nothing doing it', () => {
  // A bad row was ALREADY batch-wide and run-fatal: inTransaction wraps the
  // page, so one failing query rolled all of them back. That is how
  // client_companies died after 200 rows had committed. Batching costs
  // diagnosability, not blast radius — and the replay buys it back better,
  // because it names every bad row rather than the first.
  const src = readSource(new URL('./run.ts', import.meta.url));
  const fn = src.slice(src.indexOf('export async function findOffendingRows'));
  assert.match(fn.slice(0, 1200), /savepoint probe/, 'savepoints, so a good row cannot commit');
  assert.match(fn.slice(0, 1200), /rollback to savepoint probe/);
  assert.match(fn.slice(0, 1400), /finally \{[\s\S]*?rollback/, 'and the whole thing is always undone');
  assert.match(src, /offending row\(s\)/, 'the error names records, not just a constraint');
});

test('blocked rows are named, not counted', () => {
  // A row the DO UPDATE's WHERE or a policy excluded does not come back, so
  // blocked is the set difference. The single-row version could only report
  // rowCount 0 — a number with no record attached.
  const src = readSource(new URL('./run.ts', import.meta.url));
  assert.match(src, /const wrote = new Set<string>\(\)/);
  assert.match(src, /if \(wrote\.has\(p\.airtableRecordId\)\) continue;/);
  assert.match(src, /upsert returned no row/);
});

// ------------------------------- counting links Airtable no longer has

test('stale links are counted by Airtable id, so a dry run can report them', () => {
  // The obvious comparison is uuid pairs and it silently fails on a dry
  // run: nothing is written, parent uuids are sentinels, and every link
  // looks absent. Joining out to the two parent tables costs one query and
  // makes the count mean the same thing whether the run writes or not.
  const src = readSource(new URL('./run.ts', import.meta.url));
  const fn = src.slice(src.indexOf('async function existingLinkPairs'));
  assert.match(fn.slice(0, 900), /p\.airtable_record_id as parent_key/);
  assert.match(fn.slice(0, 900), /c\.airtable_record_id as child_key/);
  assert.match(src, /staleLinks\.get\(join\.table\)\?\.delete\(`\$\{planned\.parentRecordId\}\|\$\{childId\}`\)/);
});

test('a sampled run refuses to report a stale-link count', () => {
  // Reading 100 of 5,558 records leaves almost every link unseen, so the
  // count would be thousands of false disappearances. This is the number a
  // parked design decision is waiting on, and a misleading one is worse
  // than none.
  const src = readSource(new URL('./run.ts', import.meta.url));
  assert.match(src, /if \(!opts\.sampleSize\) \{\s*\n\s*for \(const join of joins\) \{/);
  assert.match(src, /stale-link count skipped, sampleSize would make it meaningless/);
});

test('an unresolved link is not counted as a disappeared one', () => {
  // They are different findings. A child missing from the mirror is a
  // resolution problem; a link missing from Airtable is a removal. Marking
  // seen BEFORE resolution keeps them apart.
  const src = readSource(new URL('./run.ts', import.meta.url));
  const mark = src.indexOf('staleLinks.get(join.table)?.delete(');
  const resolve = src.indexOf('const childUuid = childKeys?.get(childId);');
  assert.ok(mark > 0 && resolve > mark, 'the link must be marked seen before resolution is attempted');
});

// -------------------------------------- phase two: the three-table rehearsal

test('the rehearsal tables load after what they link to', () => {
  // subconsultant_invoices links to subconsultant_tasks, which links to
  // deliverables and subconsultants. Out of order, every link resolves to
  // nothing and the run reports thousands of unresolved parents instead of
  // a dependency mistake.
  const order = [...LOAD_ORDER];
  const at = (k: string) => order.indexOf(k as never);
  assert.ok(at('subconsultant_tasks') > at('deliverables'));
  assert.ok(at('subconsultant_tasks') > at('subconsultants'));
  assert.ok(at('subconsultant_invoices') > at('subconsultant_tasks'));
  assert.ok(at('bid_results') > at('projects'));
});

test('every rehearsal link points where the field map says', () => {
  // VERIFIED AGAINST THE LIVE BASE, not inferred from field names — which
  // is the check that found two of these four are named for something
  // other than their target.
  const expected: Array<[string, string, string]> = [
    // table, column, the mirror table it resolves against
    ['subconsultant_tasks', 'deliverable_id', 'deliverables'],
    ['subconsultant_tasks', 'subconsultant_id', 'subconsultants'],
    ['subconsultant_invoices', 'subconsultant_task_id', 'subconsultant_tasks'],
    ['subconsultant_invoices', 'subconsultant_id', 'subconsultants'],
    ['bid_results', 'project_id', 'projects'],
  ];
  for (const [table, column, target] of expected) {
    const f = spec(table as never).fields.find((x) => x.to === column);
    assert.ok(f, `${table}.${column} must be mapped`);
    assert.equal(f.kind, 'link', `${table}.${column} must be a link`);
    assert.equal(f.linkTo, target, `${table}.${column} must resolve against ${target}`);
  }
});

test('the two misleading link names are mapped to their target, not their name', () => {
  // "Project" on Subconsultant Tasks points at DCW PROJECT TASKS.
  // "Task" on Subconsultant Invoices points at SUBCONSULTANT TASKS.
  // Both would be wrong if mapped by what they are called, and the second
  // needed a migration because the column waiting for it referenced the
  // wrong table entirely.
  const project = spec('subconsultant_tasks').fields.find((f) => f.from === 'Project');
  assert.equal(project?.to, 'deliverable_id');
  assert.equal(project?.linkTo, 'deliverables');

  const task = spec('subconsultant_invoices').fields.find((f) => f.from === 'Task');
  assert.equal(task?.to, 'subconsultant_task_id');
  assert.equal(task?.linkTo, 'subconsultant_tasks');

  // And the column that referenced the wrong table must not be mapped.
  assert.ok(!spec('subconsultant_invoices').fields.some((f) => f.to === 'deliverable_id'));
});

test('bids_received is text, because "10 or more" is not a number', () => {
  // Against an integer it either fails to coerce or silently becomes 10 —
  // and 10 is a plausible bid count nobody would question, which makes the
  // silent version the dangerous one.
  const f = spec('bid_results').fields.find((x) => x.to === 'bids_received');
  assert.equal(f?.kind, 'text');
  assert.ok(f?.choices?.includes('10 or more'));
  assert.equal(f?.choices?.length, 10);
});

test('the rehearsal choices are written down so a rename is caught', () => {
  // unknown_choice only fires against a list. A renamed option in Airtable
  // is a two-second edit with no visible consequence there.
  assert.equal(spec('subconsultant_tasks').fields.find((f) => f.to === 'status')?.choices?.length, 4);
  assert.equal(spec('subconsultant_invoices').fields.find((f) => f.to === 'status')?.choices?.length, 3);
});

test('attachment columns are left unmapped on purpose', () => {
  // Airtable attachment URLs expire after about two hours, so storing one
  // stores a link that is dead before anybody clicks it. These need
  // downloading into the airtable-mirror bucket, which is separate work.
  for (const [table, column] of [
    ['subconsultant_invoices', 'invoice_paths'],
    ['subconsultant_invoices', 'payment_confirmation_paths'],
    ['bid_results', 'attachment_paths'],
  ] as const) {
    assert.ok(
      !spec(table).fields.some((f) => f.to === column),
      `${table}.${column} must not be mapped to an expiring URL`,
    );
  }
});

test('bid_results takes its created date from record metadata', () => {
  // "Date Added" is a createdTime field. Mapping it as a field would get a
  // date-only value and store UTC midnight — a day early in Pacific, on
  // every row, with nothing in the data to reveal it.
  assert.equal(spec('bid_results').createdAtColumn, 'date_added');
  assert.ok(!spec('bid_results').fields.some((f) => f.to === 'date_added'));
});

test('the standing rule about misleading link names is written down', () => {
  // Three instances cost two migrations. The next person mapping a table
  // in this base needs the rule before they need the explanation, so it
  // lives in the field map rather than in a commit message.
  const src = readSource(new URL('./tables.ts', import.meta.url));
  assert.match(src, /A LINK NAMED FOR A PROJECT USUALLY MEANS/);
  // And the exception, so nobody re-checks it or assumes it is wrong too.
  assert.match(src, /Project Notes\."DCW Projects" GENUINELY POINTS AT New Project Entry/);
});

// ===========================================================================
// out_of_office — first table after the rehearsal, 843 rows, one link.
// ===========================================================================

test('out_of_office attendance is a join, not a column', () => {
  // THE 843-ROW LOAD IS WHY. Six records are group events and a single uuid
  // kept the first attendee, dropping 1-2 others. A sample of 100 had found
  // none of them.
  //
  // person_id must NOT come back as a field: two sources for one fact means
  // every calendar query has to know which to trust.
  const s = spec('out_of_office');
  assert.ok(
    !s.fields.some((x) => x.to === 'person_id'),
    'person_id was dropped in 018; a column holding the first attendee is worse than none'
  );
  assert.equal(s.fields.filter((x) => x.kind === 'link').length, 0, 'the only link became a join');

  const j = s.joins?.find((x) => x.table === 'out_of_office_people');
  assert.ok(j, 'attendance must be written to out_of_office_people');
  assert.equal(j.from, 'Collaborators');
  assert.equal(j.parentColumn, 'out_of_office_id');
  assert.equal(j.childColumn, 'person_id');
  assert.equal(j.linkTo, 'people', 'Collaborators --> Collaborators, checked against the live base');
  assert.equal(s.joins?.length, 1, 'one join; a second means the map drifted');
});

test('the Category choice with a trailing space is written trimmed', () => {
  // AIRTABLE'S OPTION IS LITERALLY "In Person Client Meeting/Event " WITH A
  // TRAILING SPACE. unknownChoice trims the incoming value and compares it
  // against this list UNTRIMMED, so copying Airtable verbatim would raise a
  // false unknown_choice on every record using that category.
  //
  // This test exists because the verbatim copy is the obvious "fix" for
  // anyone who later diffs the list against the base and finds it differs.
  const category = spec('out_of_office').fields.find((x) => x.to === 'category');
  assert.ok(category?.choices, 'category must carry its choices');
  for (const c of category.choices) {
    assert.equal(c, c.trim(), `choice ${JSON.stringify(c)} must be stored trimmed`);
  }
  // And the behaviour that makes it matter, rather than just the shape:
  assert.equal(
    unknownChoice(category.choices, 'In Person Client Meeting/Event '),
    null,
    "Airtable's trailing-space value must match the trimmed list"
  );
});

test('out_of_office takes its created date from record metadata', () => {
  // "Created On" is a createdTime field: date-only, so it reads UTC midnight
  // and renders a day early in Pacific. The metadata carries the real instant.
  assert.equal(spec('out_of_office').createdAtColumn, 'created_on');
  const fromField = spec('out_of_office').fields.find((x) => x.to === 'created_on');
  assert.equal(fromField, undefined, 'created_on must not also be mapped as a field');
});

test('out_of_office leaves attachments unmapped', () => {
  // Airtable attachment URLs expire after about two hours.
  const mapped = spec('out_of_office').fields.map((f) => f.to);
  assert.ok(!mapped.includes('attachments_paths'), 'attachment URLs expire; do not mirror them');
});

test('out_of_office loads after the table it links to', () => {
  assert.ok(
    LOAD_ORDER.indexOf('people') < LOAD_ORDER.indexOf('out_of_office'),
    'person_id cannot resolve unless people is loaded first'
  );
});

test('the cardinality rule is written down where the next maps get written', () => {
  // out_of_office lost people on 6 of 843 rows and a 100-row sample found
  // none of them. The schema knew first: prefersSingleRecordLink:false.
  // This guard exists so the rule survives in the file the next four maps
  // are written into, not only in a commit message.
  const src = readSource(new URL('./tables.ts', import.meta.url));
  assert.match(src, /COUNT EVERY LINK ACROSS THE FULL POPULATION/);
  // The load-bearing half is the correction: the schema flag is NOT a
  // shortcut. The first version of this rule said to count only the links
  // marked false, which implied true meant settled. 32 activity_log records
  // proved otherwise and 021 had to add a join table.
  assert.match(src, /prefersSingleRecordLink IS A UI PREFERENCE, NOT A CONSTRAINT/);
  assert.ok(
    !/TAKE LINK CARDINALITY FROM THE SCHEMA/.test(src),
    'the superseded rule must not survive anywhere in the file'
  );
  // The scalar columns that passed the count, each with its date — "safe by
  // measurement" expires in a way "safe by schema" would not have.
  assert.match(src, /activity_log\.action_owner_id\s+0 multiples/);
  assert.match(src, /project_notes\.project_id\s+0 multiples/);
});

test('every migration can be re-run: no unguarded create policy', () => {
  // Postgres has no `create policy if not exists`, so an unguarded create is
  // correct exactly once and aborts every statement after it on a second
  // paste. 019 shipped that way and a replay caught it.
  //
  // THE DROP IS MATCHED WITH THE SAME FLEXIBILITY AS THE CREATE, and the
  // first version of this test was not. It matched creates with \s+ but
  // looked for the drop as an exact single-space string, so the repo's own
  // aligned style —
  //
  //   drop policy if exists project_client_contacts_sync_read      on project_client_contacts;
  //
  // — read as missing. It reported 48 unguarded statements across 006, 011,
  // 012 and 007, all of which were correctly guarded, and three files were
  // edited on the strength of it. A matcher that is strict on one side of a
  // pair and loose on the other invents findings.
  //
  // Dynamically created policies are skipped by both halves: inside
  // `execute format('create policy %I on %I', ...)` the name is %I, which
  // matches neither pattern. 007 drops and creates those in the same loop.
  const dir = new URL('../../../docs/team-intranet/migrations/', import.meta.url);
  // 001 and 003 PREDATE THE PRACTICE, which 004 introduced. Named here rather
  // than skipped by a date rule so the exclusion is a recorded decision.
  const PREDATES_THE_PRACTICE = ['001_wishlist_and_uploads.sql', '003_deliverable_writes.sql'];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => !PREDATES_THE_PRACTICE.includes(f));
  assert.ok(files.length > 10, 'migrations directory should not be empty');

  for (const file of files) {
    const body = readSource(new URL(file, dir))
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');

    for (const m of body.matchAll(/create policy (\w+)\s+on\s+([\w.]+)/g)) {
      const [name, table] = [m[1], m[2]];
      const guard = new RegExp(
        `drop policy if exists ${name}\\s+on\\s+${table.replace('.', '\\.')}\\s*;`
      );
      assert.ok(
        guard.test(body),
        `${file}: "create policy ${name} on ${table}" has no matching ` +
          `"drop policy if exists ${name} on ${table};" — the migration will ` +
          'fail on a second run and abort everything after it'
      );
    }
  }
});

test('npm test actually runs the tests, on Windows too', () => {
  // THE SCRIPT REPORTED SUCCESS WHILE RUNNING ZERO TESTS, for months.
  //
  //   "test": "node --experimental-strip-types --test 'src/**/*.test.ts'"
  //
  // That works in bash, which strips the single quotes and leaves node a glob
  // it expands itself. npm on Windows runs scripts through cmd.exe, which does
  // NOT strip single quotes — node received a literal 'src/**/*.test.ts',
  // matched nothing, ran nothing, and exited 0. `ℹ tests 0 … ℹ fail 0` reads
  // as a pass at a glance.
  //
  // Double quotes are stripped by both shells, so node glob-expands in each.
  //
  // This cost a whole session of running one file by hand while believing the
  // suite was green. Six other test files were never executed once.
  const pkg = JSON.parse(readSource(new URL('../../../package.json', import.meta.url)));
  const script: string = pkg.scripts.test;
  assert.ok(
    !script.includes("'"),
    `the test script must not use single quotes — cmd.exe does not strip them, ` +
      `so npm test silently matches no files and passes. Got: ${script}`
  );
  assert.match(script, /--test\s+"[^"]*\*\.test\.ts"/, 'the glob must be double-quoted');
});

test('a renamed choice is caught in position three, not just position one', () => {
  // THE SPECIFIC BLIND SPOT. unknownChoice used to read value[0] only, so a
  // record holding ["Schedule", "Quote", "Renamed Thing"] was judged on
  // "Schedule" alone and passed. A test exercising position one would pass
  // against the broken version too, which is why this one starts at three.
  const known = ['Schedule', 'Quote', 'Collections'];

  assert.equal(
    unknownChoice(known, ['Schedule', 'Quote', 'Renamed Thing']),
    'Renamed Thing',
    'an unknown value in LAST position must be found'
  );
  assert.equal(
    unknownChoice(known, ['Schedule', 'Renamed Thing', 'Quote']),
    'Renamed Thing',
    'an unknown value in the MIDDLE must be found'
  );
  assert.equal(unknownChoice(known, ['Renamed Thing', 'Schedule']), 'Renamed Thing');

  // Still correct on the cases it already handled.
  assert.equal(unknownChoice(known, ['Schedule', 'Quote', 'Collections']), null, 'all known');
  assert.equal(unknownChoice(known, 'Schedule'), null, 'bare single value');
  assert.equal(unknownChoice(known, { name: 'Quote' }), null, 'select object');
  assert.equal(unknownChoice(known, []), null, 'empty list is not an unknown choice');
  assert.equal(unknownChoice(known, null), null, 'absent is not an unknown choice');
  assert.equal(unknownChoice(known, ['', '   ']), null, 'blanks are not unknown choices');

  // The first unknown wins, deliberately — one anomaly per record per field.
  assert.equal(unknownChoice(known, ['Nope', 'Also Nope']), 'Nope', 'first unknown is reported');

  // Trimming applies to every position, not just the first. Airtable's
  // trailing-space options are real: see out_of_office's Category.
  assert.equal(unknownChoice(known, ['Schedule', 'Quote ']), null, 'trailing space still matches');
});

// ===========================================================================
// project_notes — the table that breaks the link-naming rule legitimately.
// ===========================================================================

test('project_notes keeps DCW Projects as a project, not a task', () => {
  // THE DOCUMENTED EXCEPTION. "DCW Projects" here points at New Project
  // Entry; the identically named field on Time Tracking points at DCW
  // Project Tasks. Same spelling, same base, different targets — verified
  // against the live base, not inferred from the name.
  const f = spec('project_notes').fields.find((x) => x.to === 'project_id');
  assert.ok(f, 'project_id must be mapped');
  assert.equal(f.kind, 'link');
  assert.equal(f.linkTo, 'projects', 'this one really is a project link');
});

test('project_notes task attachment is a join, because 10% have more than one', () => {
  const s = spec('project_notes');
  assert.ok(
    !s.fields.some((x) => x.to === 'deliverable_id'),
    '019 dropped deliverable_id; 361 of 3,520 notes attach to several tasks'
  );
  const j = s.joins?.find((x) => x.table === 'project_note_deliverables');
  assert.ok(j, 'tasks must be written to project_note_deliverables');
  assert.equal(j.from, 'DCW Project Tasks');
  assert.equal(j.parentColumn, 'project_note_id');
  assert.equal(j.childColumn, 'deliverable_id');
  assert.equal(j.linkTo, 'deliverables');
});

test('the double space in "Added  By" is preserved exactly', () => {
  // It is the field's real name in Airtable. A single space matches nothing
  // and added_by_id stays null on all 3,520 rows with no error anywhere.
  const f = spec('project_notes').fields.find((x) => x.to === 'added_by_id');
  assert.ok(f, 'added_by_id must be mapped');
  assert.equal(f.from, 'Added  By');
  assert.ok(/Added {2}By/.test(f.from), 'exactly two spaces, not one and not three');
  assert.equal(f.linkTo, 'people');
});

test('project_notes multi-select choices are listed and every position is guarded', () => {
  // This is the first text[] field in the mirror to carry a choices list,
  // which only became safe once unknownChoice stopped reading value[0].
  const f = spec('project_notes').fields.find((x) => x.to === 'notes_include_info_on');
  assert.ok(f?.choices, 'the 13 options must be written down');
  assert.equal(f.kind, 'text[]');
  assert.equal(f.choices.length, 13);
  for (const c of f.choices) assert.equal(c, c.trim(), `choice ${JSON.stringify(c)} must be trimmed`);

  // And the guard works past position one on this actual list.
  assert.equal(unknownChoice(f.choices, ['Schedule', 'Quote', 'Renamed']), 'Renamed');
  assert.equal(unknownChoice(f.choices, ['Schedule', 'Quote', 'Collections']), null);
});

test('project_notes takes its created date from metadata, under this table name', () => {
  // airtable_created_at here, created_on on out_of_office. Checked, not copied.
  assert.equal(spec('project_notes').createdAtColumn, 'airtable_created_at');
  assert.equal(
    spec('project_notes').fields.find((x) => x.to === 'airtable_created_at'),
    undefined,
    'it must not also be mapped as a field'
  );
});

test('project_notes leaves attachments unmapped and loads after its targets', () => {
  const s = spec('project_notes');
  assert.ok(!s.fields.map((f) => f.to).includes('snip_image_paths'), 'attachment URLs expire');
  assert.ok(LOAD_ORDER.indexOf('projects') < LOAD_ORDER.indexOf('project_notes'));
  assert.ok(LOAD_ORDER.indexOf('deliverables') < LOAD_ORDER.indexOf('project_notes'));
  assert.ok(LOAD_ORDER.indexOf('people') < LOAD_ORDER.indexOf('project_notes'));
});

// ===========================================================================
// pursuits — the first table where the choices answer differs per field.
// ===========================================================================

test('pursuits resolves all three joins against the tables 019 built', () => {
  const s = spec('pursuits');
  const expected: Array<[string, string, string, string]> = [
    ['Client Company',        'pursuit_client_companies', 'client_company_id', 'client_companies'],
    ['Client Contact (Link)', 'pursuit_client_contacts',  'contact_id',        'contacts'],
    ['Assignees',             'pursuit_assignees',        'person_id',         'people'],
  ];
  for (const [from, table, child, linkTo] of expected) {
    const j = s.joins?.find((x) => x.table === table);
    assert.ok(j, `${table} must be written`);
    assert.equal(j.from, from);
    assert.equal(j.parentColumn, 'pursuit_id');
    assert.equal(j.childColumn, child);
    assert.equal(j.linkTo, linkTo);
  }
  assert.equal(s.joins?.length, 3, 'three joins; "Time Tracking" is the reverse side and is not one');
  assert.equal(s.fields.filter((f) => f.kind === 'link').length, 0, '019 left no link columns');
});

test('pursuits guards closed vocabularies and leaves open ones alone', () => {
  // unknownChoice cannot tell a rename from an addition, so a choices list on
  // a list that grows by design is a false-alarm generator — and an anomaly
  // that fires for normal events teaches people to ignore the table.
  const s = spec('pursuits');
  const get = (to: string) => s.fields.find((f) => f.to === to);

  const GUARDED: Array<[string, number]> = [
    ['status', 11],
    ['submitting_as', 2],
    ['ready_to_start', 4],
    ['select_preferred_meeting_type', 3],
    ['request_the_following', 4],
    ['project_type', 7],
  ];
  for (const [col, n] of GUARDED) {
    const f = get(col);
    assert.ok(f?.choices, `${col} is a closed vocabulary and must carry its options`);
    assert.equal(f.choices.length, n, `${col} should list ${n} options`);
    for (const c of f.choices) assert.equal(c, c.trim(), `${col}: ${JSON.stringify(c)} must be trimmed`);
  }

  // Open lists: Year and Month-Year stop at 2023 and it is 2026, so they are
  // abandoned rather than growing; the rest grow with clients, staff and work.
  const OPEN = [
    'prime_proposal_components',
    'unique_rates',
    'materials_provided',
    'project_category',
    'year_pursuit_was_requested',
    'month_year_pursuit_was_requested',
  ];
  for (const col of OPEN) {
    const f = get(col);
    assert.ok(f, `${col} must still be mapped`);
    assert.equal(f.choices, undefined, `${col} is an open vocabulary; guarding it fires on every addition`);
  }
});

test('pursuits skips both createdTime fields and takes the date from metadata', () => {
  // "Date Created" AND "Created" are both createdTime and both return the
  // same instant. Mapping either would store a date-only rendering.
  const s = spec('pursuits');
  assert.equal(s.createdAtColumn, 'airtable_created_at');
  for (const name of ['Date Created', 'Created']) {
    assert.equal(
      s.fields.find((f) => f.from === name),
      undefined,
      `"${name}" is createdTime metadata, not a field to map`
    );
  }
});

test('pursuits leaves its three attachment columns unmapped', () => {
  const mapped = spec('pursuits').fields.map((f) => f.to);
  for (const col of ['final_proposal_paths', 'key_indesign_components_paths', 'upload_files_paths']) {
    assert.ok(!mapped.includes(col), `${col}: Airtable attachment URLs expire in about two hours`);
  }
});

test('pursuits loads after the three tables its joins resolve against', () => {
  for (const parent of ['client_companies', 'contacts', 'people'] as const) {
    assert.ok(
      LOAD_ORDER.indexOf(parent) < LOAD_ORDER.indexOf('pursuits'),
      `${parent} must load before pursuits or its join cannot resolve`
    );
  }
});

// ===========================================================================
// activity_log — two person links, three guarded-but-empty vocabularies.
// ===========================================================================

test('activity_log maps its two person links to distinct columns', () => {
  // The first table in the mirror with two links to the same target. They are
  // safe as scalars for DIFFERENT reasons: Action Owner is single by schema
  // (prefersSingleRecordLink:true), Logged By is single by today's data only
  // (3,944 with one, 409 with none, 0 with several across the population).
  const s = spec('activity_log');
  const logged = s.fields.find((f) => f.to === 'logged_by_id');
  const owner = s.fields.find((f) => f.to === 'action_owner_id');
  assert.ok(logged && owner, 'both person links must be mapped');
  assert.equal(logged.from, 'Logged By');
  assert.equal(owner.from, 'Action Owner');
  assert.equal(logged.linkTo, 'people');
  assert.equal(owner.linkTo, 'people');
  assert.notEqual(logged.to, owner.to, 'two links to people need two columns, not one');

  // The task attachment is a JOIN, not a column. "DCW Project Task" is
  // marked prefersSingleRecordLink:true and 32 records hold several anyway.
  assert.ok(
    !s.fields.some((f) => f.to === 'deliverable_id'),
    '021 dropped deliverable_id; the flag suggesting one task per entry is not enforced'
  );
  const task = s.joins?.find((j) => j.table === 'activity_log_deliverables');
  assert.ok(task, 'tasks must be written to activity_log_deliverables');
  assert.equal(task.from, 'DCW Project Task');
  assert.equal(task.parentColumn, 'activity_log_id');
  assert.equal(task.childColumn, 'deliverable_id');
  assert.equal(task.linkTo, 'deliverables');
  assert.equal(s.joins?.length, 1, 'one join; the two person links stay scalar');
});

test('activity_log guards its three closed vocabularies even though they are empty', () => {
  // Departure from the pursuits reasoning, and deliberate. These lists are
  // closed but currently unpopulated — 72 records sampled from both ends of
  // the table had only Activity Name filled. The instinct was to skip them as
  // "a detector watching an empty field".
  //
  // Supabase eventually becomes the system of record, so these lists are the
  // SPECIFICATION of what the column may hold, not only a rename detector.
  // Guarding a closed list costs nothing when nothing populates it.
  const s = spec('activity_log');
  const expected: Array<[string, number]> = [
    ['activity_type', 14],
    ['source', 7],
    ['visibility', 4],
  ];
  for (const [col, n] of expected) {
    const f = s.fields.find((x) => x.to === col);
    assert.ok(f?.choices, `${col} is a closed vocabulary and must carry its options`);
    assert.equal(f.choices.length, n);
    for (const c of f.choices) assert.equal(c, c.trim(), `${col}: ${JSON.stringify(c)} must be trimmed`);
  }
});

test('activity_log maps previous_value and new_value despite both being empty', () => {
  // The log records THAT something changed but not what it changed from.
  // Mapped anyway: whatever replaces the Airtable automation writes here.
  const mapped = spec('activity_log').fields.map((f) => f.to);
  assert.ok(mapped.includes('previous_value'));
  assert.ok(mapped.includes('new_value'));
});

test('activity_log takes its date from metadata, under a third column name', () => {
  // date_logged here; airtable_created_at on project_notes and pursuits;
  // created_on on out_of_office. Three tables, three names.
  const s = spec('activity_log');
  assert.equal(s.createdAtColumn, 'date_logged');
  assert.equal(
    s.fields.find((f) => f.from === 'Date Logged'),
    undefined,
    'Date Logged is createdTime metadata, not a field to map'
  );
});

test('activity_log leaves attachments unmapped and loads after its targets', () => {
  const s = spec('activity_log');
  assert.ok(!s.fields.map((f) => f.to).includes('attachments_paths'), 'Airtable URLs expire');
  assert.ok(LOAD_ORDER.indexOf('deliverables') < LOAD_ORDER.indexOf('activity_log'));
  assert.ok(LOAD_ORDER.indexOf('people') < LOAD_ORDER.indexOf('activity_log'));
});

// ===========================================================================
// time_entries — the last of phase two, and the table the link-naming rule
// came from.
// ===========================================================================

test('time_entries DCW Projects resolves against deliverables, not projects', () => {
  // THE ORIGINAL INSTANCE. "DCW Projects" here points at DCW Project Tasks;
  // the identically named field on project_notes points at New Project Entry.
  // 017 dropped time_entries.project_id over exactly this.
  const s = spec('time_entries');
  // A JOIN since 023: ten of 29,215 records hold two or three tasks, and
  // prefersSingleRecordLink said true. One of the ten is six BILLABLE hours
  // across three distinct Pattison scopes.
  assert.ok(
    !s.fields.some((x) => x.to === 'deliverable_id'),
    '023 dropped deliverable_id; the flag suggesting one task per entry is not enforced'
  );
  const f = s.joins?.find((j) => j.table === 'time_entry_deliverables');
  assert.ok(f, 'tasks must be written to time_entry_deliverables');
  assert.equal(f.from, 'DCW Projects');
  assert.equal(f.parentColumn, 'time_entry_id');
  assert.equal(f.childColumn, 'deliverable_id');
  assert.equal(f.linkTo, 'deliverables', 'named for projects, points at tasks');
  assert.ok(
    !s.fields.some((x) => x.to === 'project_id'),
    '017 dropped project_id: no Airtable field points at New Project Entry from this table'
  );
  // And the contrast, so the two are not conflated.
  assert.equal(
    spec('project_notes').fields.find((x) => x.from === 'DCW Projects')?.linkTo,
    'projects',
    'the same field name on project_notes genuinely is a project link'
  );
});

test('time_entries maps each of the eight tag vocabularies to its own column', () => {
  // They overlap heavily — "Meeting (Internal)" is in five of them — so a
  // crossed pair would be invisible in the data. Matched by exact name.
  const s = spec('time_entries');
  const pairs: Array<[string, string]> = [
    ['Admin Tags', 'admin_tags'],
    ['Billing Tags', 'billing_tags'],
    ['Cost Planning Tags', 'cost_planning_tags'],
    ['Education/Training Tags', 'education_training_tags'],
    ['Innovation Tags', 'innovation_tags'],
    ['Management Tags', 'management_tags'],
    ['Marketing Tags', 'marketing_tags'],
    ['Out of Office Tags', 'out_of_office_tags'],
  ];
  for (const [from, to] of pairs) {
    const f = s.fields.find((x) => x.from === from);
    assert.ok(f, `${from} must be mapped`);
    assert.equal(f.to, to, `${from} must land in ${to}, not another tag column`);
  }
  const tagCols = pairs.map(([, to]) => to);
  assert.equal(new Set(tagCols).size, 8, 'eight distinct columns');
});

test('time_entries guards seven tag lists and leaves Innovation open', () => {
  const s = spec('time_entries');
  const get = (to: string) => s.fields.find((x) => x.to === to);
  for (const col of ['admin_tags', 'billing_tags', 'cost_planning_tags',
                     'education_training_tags', 'management_tags', 'marketing_tags',
                     'out_of_office_tags', 'billable_status']) {
    const f = get(col);
    assert.ok(f?.choices, `${col} is a closed vocabulary and must carry its options`);
    for (const c of f.choices) assert.equal(c, c.trim(), `${col}: ${JSON.stringify(c)} must be trimmed`);
  }
  // Innovation Tags grows with every tool the company adopts — Vonage,
  // Calendly, Softr. Guarding it means an anomaly per adoption.
  assert.equal(get('innovation_tags')?.choices, undefined, 'Innovation Tags is an open list');
});

test('the four trailing-space options in this base are written trimmed', () => {
  // unknownChoice trims the incoming value and compares against the list as
  // given, so a verbatim copy never matches and fires on every record.
  const te = spec('time_entries');
  const choicesFor = (to: string): readonly string[] => {
    const f = te.fields.find((x) => x.to === to);
    assert.ok(f?.choices, `${to} must carry its choices`);
    return f.choices;
  };
  const edu = choicesFor('education_training_tags');
  const cost = choicesFor('cost_planning_tags');
  assert.ok(edu.includes('Personal development'), 'Airtable has "Personal development "');
  assert.ok(cost.includes('QC3'), 'Airtable has "QC3 "');
  // And they still match the untrimmed value coming from Airtable.
  assert.equal(unknownChoice(edu, 'Personal development '), null);
  assert.equal(unknownChoice(cost, 'QC3 '), null);

  const ooo = spec('out_of_office').fields.find((f) => f.to === 'category');
  assert.ok(ooo?.choices?.includes('In Person Client Meeting/Event'));
});

test('the Cost Planning separator is listed as a value but is not a category', () => {
  // "___DONT USE ANY PAST THIS POINT__" is a line somebody drew to deprecate
  // the entries below it, because deleting a choice blanks it on every record
  // using it. Listed so a record still carrying it raises no false anomaly.
  const f = spec('time_entries').fields.find((x) => x.to === 'cost_planning_tags');
  assert.ok(f?.choices?.includes('___DONT USE ANY PAST THIS POINT__'));
  const src = readSource(new URL('./tables.ts', import.meta.url));
  assert.match(src, /Not a category — a line somebody drew/);
});

test('time_entries leaves the multipleCollaborators field alone', () => {
  // "Need to Work With.." is NOT a record link. It returns Airtable user
  // objects, not rec… ids, so a link mapping resolves nothing on every row.
  const s = spec('time_entries');
  assert.equal(s.fields.find((f) => f.from === 'Need to Work With..'), undefined);
  assert.equal(s.createdAtColumn, 'airtable_created_at');
  for (const parent of ['people', 'deliverables', 'pursuits'] as const) {
    assert.ok(LOAD_ORDER.indexOf(parent) < LOAD_ORDER.indexOf('time_entries'));
  }
});
