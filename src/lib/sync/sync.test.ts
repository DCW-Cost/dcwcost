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

test('a genuinely multi-valued select gets an array column, not the first value', () => {
  // Secondary Category carries 2+ values on 66 of 100 sampled projects,
  // often four to eight, so migration 009 made market text[]. sector (7%)
  // and city (2%) stay scalar and log what they drop — that loss is rare
  // enough to accept; two thirds is not.
  const market = spec('projects').fields.find((f) => f.to === 'market');
  assert.equal(market?.kind, 'text[]', 'market must be read as a list');
  assert.equal(spec('projects').fields.find((f) => f.to === 'sector')?.kind, 'text');
  assert.equal(spec('projects').fields.find((f) => f.to === 'city')?.kind, 'text');
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

test('the join spec expresses the join table that already existed, unchanged', () => {
  // deliverable_subconsultants was built by 006 and has never been written
  // to. If the mechanism needed a special case to describe it, the mechanism
  // would be wrong — so this is the test the shape had to pass.
  const sub = spec('deliverables').joins?.find((j) => j.table === 'deliverable_subconsultants');
  assert.ok(sub, 'the pre-existing join table must be expressible');
  assert.equal(sub?.from, 'Subconsultants');
  assert.equal(sub?.parentColumn, 'deliverable_id');
  assert.equal(sub?.childColumn, 'subconsultant_id');
  assert.equal(sub?.linkTo, 'subconsultants');
});

test('the asymmetric join needs no special path either', () => {
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
  // Next Action Owner is single-valued in Airtable and stays a scalar FK.
  assert.ok(spec('deliverables').fields.some((f) => f.to === 'next_action_owner_id'));
});

test('a record becomes one planned join per populated link field', () => {
  const planned = planJoins(spec('deliverables'), {
    id: 'recABCDEFGHIJKLMN',
    fields: {
      'Project Manager *': ['recAAAAAAAAAAAAAA', 'recBBBBBBBBBBBBBB'],
      'Subconsultants': ['recCCCCCCCCCCCCCC'],
      // Project Support absent — an empty link contributes nothing
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
