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
import { coerce, unknownChoice } from './coerce.ts';
import { buildUpsert, columnsFor, completedAtOnInsert, planRow, updatedColumns } from './plan.ts';
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

test('the bucket fields Airtable calls dates are not mapped as dates', () => {
  // "Construction Start Date" is a single select of months ("May-21"), and
  // the task-level completion one is bare years ("2018"). Both would parse
  // into a confident, wrong date. Neither is carried until it has a home.
  for (const key of ['projects', 'deliverables'] as const) {
    for (const f of spec(key).fields) {
      assert.ok(
        !f.to.startsWith('construction_'),
        `${key}.${f.to} is mapped; those Airtable fields are buckets, not dates`
      );
    }
  }
});
