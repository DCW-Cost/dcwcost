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
import { allRecordIds, coerce, unknownChoice } from './coerce.ts';
import { buildJoinUpsert, buildUpsert, columnsFor, completedAtOnInsert, planJoins, planRow, updatedColumns } from './plan.ts';
import { LOAD_ORDER, spec, TABLES } from './tables.ts';
import { renderPlan, selectedTables } from './run.ts';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------- coercion

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
  assert.match(sql, /returning \(xmax = 0\) as inserted/);
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
  assert.match(sql, /returning \(xmax = 0\) as inserted/);
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
  const src = readFileSync(new URL('./run.ts', import.meta.url), 'utf8');
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
