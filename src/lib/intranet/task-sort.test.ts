import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TaskRow } from './tasks.ts';
import {
  filterTasks,
  parseTaskSort,
  sortTasks,
  workflowRank,
  workflowTone,
  WORKFLOW_ORDER,
} from './task-sort.ts';

const task = (over: Partial<TaskRow> & { id: string }): TaskRow => ({
  title: 'Untitled',
  taskType: [],
  taskNumber: [],
  projectManagers: [],
  clients: [],
  dueDate: null,
  workflow: null,
  folderLink: null,
  projectId: null,
  projectName: null,
  projectFeeProposal: null,
  taskFeeProposal: null,
  hasFile: false,
  uploadedAt: null,
  ingestStatus: 'pending',
  ...over,
});

test('the default sort is due date, latest first, matching the Airtable view', () => {
  assert.deepEqual(parseTaskSort(null, null), { sort: 'due', dir: 'desc' });
});

test('a non-date column defaults to ascending, because A-Z is what reads as unsorted', () => {
  assert.deepEqual(parseTaskSort('client', null), { sort: 'client', dir: 'asc' });
});

test('an unknown sort key falls back rather than throwing', () => {
  assert.deepEqual(parseTaskSort('; drop table', 'sideways'), { sort: 'due', dir: 'desc' });
});

test('an explicit direction always wins over the per-column default', () => {
  assert.deepEqual(parseTaskSort('due', 'asc'), { sort: 'due', dir: 'asc' });
  assert.deepEqual(parseTaskSort('client', 'desc'), { sort: 'client', dir: 'desc' });
});

/**
 * 2,718 of 5,560 tasks have no due date. If blanks led in one direction, one
 * click would bury every dated row under a wall of them and the page would
 * look broken.
 */
test('tasks with no due date sort last in BOTH directions', () => {
  const rows = [
    task({ id: 'a', title: 'a', dueDate: null }),
    task({ id: 'b', title: 'b', dueDate: '2026-01-01' }),
    task({ id: 'c', title: 'c', dueDate: '2026-06-01' }),
  ];

  assert.deepEqual(
    sortTasks(rows, 'due', 'desc').map((t) => t.id),
    ['c', 'b', 'a'],
  );
  assert.deepEqual(
    sortTasks(rows, 'due', 'asc').map((t) => t.id),
    ['b', 'c', 'a'],
  );
});

/**
 * 'Complete' is the END of the workflow, not the second letter of the
 * alphabet. Sorting these A-Z reads as random to anyone who works the list.
 */
test('workflow sorts in process order, not alphabetically', () => {
  const rows = [
    task({ id: 'done', title: 'done', workflow: 'Complete' }),
    task({ id: 'new', title: 'new', workflow: 'Docs Received - UNASSIGNED' }),
    task({ id: 'qc', title: 'qc', workflow: 'Quality Control' }),
  ];

  assert.deepEqual(
    sortTasks(rows, 'workflow', 'asc').map((t) => t.id),
    ['new', 'qc', 'done'],
  );
});

test('every workflow state in the production enum has a distinct rank', () => {
  const ranks = WORKFLOW_ORDER.map(workflowRank);
  assert.equal(new Set(ranks).size, WORKFLOW_ORDER.length);
});

test('an unrecognised workflow state sorts after every known one, and null after that', () => {
  const known = Math.max(...WORKFLOW_ORDER.map(workflowRank));
  assert.ok(workflowRank('Some New State Airtable Grew') > known);
  assert.ok(workflowRank(null) > workflowRank('Some New State Airtable Grew'));
});

/**
 * Several tasks on one project share a workflow state and a due date. Without
 * a total order the list reshuffles on every render, which reads as data
 * changing underneath you.
 */
test('ties break deterministically, so the order is stable across renders', () => {
  const rows = [
    task({ id: 'z', title: 'Same', workflow: 'Complete', dueDate: '2026-01-01' }),
    task({ id: 'a', title: 'Same', workflow: 'Complete', dueDate: '2026-01-01' }),
    task({ id: 'm', title: 'Same', workflow: 'Complete', dueDate: '2026-01-01' }),
  ];
  const once = sortTasks(rows, 'workflow', 'asc').map((t) => t.id);
  const twice = sortTasks([...rows].reverse(), 'workflow', 'asc').map((t) => t.id);
  assert.deepEqual(once, ['a', 'm', 'z']);
  assert.deepEqual(once, twice);
});

test('sorting never mutates the caller’s array', () => {
  const rows = [task({ id: 'b', title: 'b' }), task({ id: 'a', title: 'a' })];
  const before = rows.map((t) => t.id);
  sortTasks(rows, 'title', 'asc');
  assert.deepEqual(
    rows.map((t) => t.id),
    before,
  );
});

/**
 * The format is not uniform — 1,272 of 1,661 projects are FP-XX-YYYY-NNNN and
 * the rest are not — and the documents carry only the tail, so an exact match
 * would find nothing.
 */
test('the bare year-sequence finds a full fee proposal number', () => {
  const rows = [
    task({ id: 'hit', title: 'Edwin Pratt Park', projectFeeProposal: 'FP-OR-2025-0088' }),
    task({ id: 'miss', title: 'Somewhere Else', projectFeeProposal: 'FP-WA-2023-0163' }),
  ];
  assert.deepEqual(
    filterTasks(rows, '2025-0088').map((t) => t.id),
    ['hit'],
  );
});

test('the task-level fee proposal suffix is searchable too', () => {
  const rows = [
    task({ id: 'one', title: 'ES', taskFeeProposal: 'FP-WA-2026-0106-1' }),
    task({ id: 'three', title: 'Stadium', taskFeeProposal: 'FP-WA-2026-0106-3' }),
  ];
  assert.deepEqual(
    filterTasks(rows, '0106-3').map((t) => t.id),
    ['three'],
  );
});

test('search covers client, estimator, task number and task type, case-insensitively', () => {
  const rows = [
    task({ id: 'a', title: 'A', clients: ['Carleton Hart Architecture P.C.'] }),
    task({ id: 'b', title: 'B', projectManagers: ['Katya Nichols'] }),
    task({ id: 'c', title: 'C', taskNumber: ['On-Call'] }),
    task({ id: 'd', title: 'D', taskType: ['Schematic Design (SD)'] }),
  ];
  assert.deepEqual(filterTasks(rows, 'carleton').map((t) => t.id), ['a']);
  assert.deepEqual(filterTasks(rows, 'KATYA').map((t) => t.id), ['b']);
  assert.deepEqual(filterTasks(rows, 'on-call').map((t) => t.id), ['c']);
  assert.deepEqual(filterTasks(rows, 'schematic').map((t) => t.id), ['d']);
});

/**
 * Fields are joined with a separator that cannot occur in the data, so a
 * query never matches across a boundary — "Hart Katya" must not find a row
 * whose client ends in Hart and whose estimator begins with Katya.
 */
test('a query cannot match across two different fields', () => {
  const rows = [task({ id: 'a', title: 'A', clients: ['Hart'], projectManagers: ['Katya'] })];
  assert.deepEqual(filterTasks(rows, 'hart katya'), []);
});

test('an empty query returns everything, and the same array contents', () => {
  const rows = [task({ id: 'a', title: 'A' }), task({ id: 'b', title: 'B' })];
  assert.deepEqual(filterTasks(rows, '   ').map((t) => t.id), ['a', 'b']);
});

/**
 * Airtable's own colour for each state, shade included. If these drift apart,
 * the same job reads as two different situations depending on which tool you
 * opened.
 */
test('every workflow state gets the tone and shade Airtable gives it', () => {
  assert.equal(workflowTone('Docs Received - UNASSIGNED'), 'unassigned');
  assert.equal(workflowTone('Docs Received - Assigned'), 'assigned');
  assert.equal(workflowTone('Report / Takeoff Development'), 'active');
  assert.equal(workflowTone('Quality Control'), 'active');
  assert.equal(workflowTone('Special Projects'), 'special');
  assert.equal(workflowTone('Needs Revision - Schedule Confirmed'), 'revision-set');
  assert.equal(workflowTone('Draft Delivered'), 'delivered');
  assert.equal(workflowTone('Pending Final Response'), 'waiting');
  assert.equal(workflowTone('Complete'), 'done');
});

/**
 * Within a family the shade is the signal, so these must NOT collapse:
 * Complete is heavier than Draft Delivered, and a scheduled revision is
 * louder than an unscheduled one.
 */
test('shades within a family stay distinct', () => {
  const greys = ['Draft Delivered', 'Pending Final Response', 'Complete'].map(workflowTone);
  assert.equal(new Set(greys).size, 3);

  assert.notEqual(
    workflowTone('Needs Revision -  Schedule TBD'),
    workflowTone('Needs Revision - Schedule Confirmed'),
  );
  assert.notEqual(
    workflowTone('Docs Received - Assigned'),
    workflowTone('Report / Takeoff Development'),
  );
});

/**
 * The state is spelled with TWO spaces after the dash in Airtable, and so in
 * the database. A single-spaced key in the map would look right in the source
 * and silently fall through to the quietest tone — a revision needing
 * scheduling would render as calmly as a delivered draft.
 */
test('the double-spaced revision state is matched exactly, not approximately', () => {
  assert.equal(workflowTone('Needs Revision -  Schedule TBD'), 'revision-tbd');
  assert.equal(workflowTone('Needs Revision - Schedule TBD'), 'delivered');
});

test('every state in the production enum has its own tone, bar the one pair Airtable shares', () => {
  const tones = WORKFLOW_ORDER.map(workflowTone);
  // 10 states, 9 tones: Development and Quality Control share one in Airtable.
  assert.equal(new Set(tones).size, 9);
});

test('an unknown or absent state still gets a tone, so it renders as a chip', () => {
  assert.equal(workflowTone('Some New State Airtable Grew'), 'delivered');
  assert.equal(workflowTone(null), 'delivered');
});
