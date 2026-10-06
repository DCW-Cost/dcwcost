import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSort, sortHref, sortProjects, SORT_KEYS } from './project-sort.ts';
import type { ProjectSummary } from './data/types.ts';

const P = (name: string, clients: string[], sector: string[], city: string[], taskCount: number): ProjectSummary =>
  ({ id: name, name, clients, sector, city, taskCount });

const SAMPLE: ProjectSummary[] = [
  P('Oregon Zoo Entry Plaza', ['Opsis Architecture'], ['Community'], ['Portland, OR'], 12),
  P('Blue Lake Park', ['MIG Inc'], ['Parks'], ['Fairview, OR'], 3),
  P('No client here', [], ['Civic'], ['Olympia, WA'], 0),
  P('Phase 10 Works', ['Zed Partners'], [], ['Tacoma, WA'], 7),
  P('Phase 2 Works', ['Zed Partners'], ['Civic'], ['Tacoma, WA'], 40),
];

test('every sortable column actually sorts', () => {
  for (const key of SORT_KEYS) {
    const asc = sortProjects(SAMPLE, key, 'asc').map((p) => p.name);
    const desc = sortProjects(SAMPLE, key, 'desc').map((p) => p.name);
    assert.equal(asc.length, SAMPLE.length, `${key} must not drop rows`);
    assert.notDeepEqual(asc, desc, `${key} must respond to direction`);
  }
});

test('numbers sort as numbers, not as text', () => {
  // The bug this catches: tasks sorted lexically puts 40 before 7, and a
  // "most tasks" view that is wrong looks exactly like one that is right.
  const byTasks = sortProjects(SAMPLE, 'tasks', 'desc').map((p) => p.taskCount);
  assert.deepEqual(byTasks, [40, 12, 7, 3, 0]);
});

test('project names sort the way they are written', () => {
  // "Phase 2" before "Phase 10". Plain string comparison gets this backwards.
  const names = sortProjects(SAMPLE, 'name', 'asc').map((p) => p.name);
  assert.ok(names.indexOf('Phase 2 Works') < names.indexOf('Phase 10 Works'));
});

test('blanks come to the top ascending, which is how you find them', () => {
  // Deliberate, not a side effect. A project with no client is the thing
  // worth looking at, and sorting by Client should bring it to you rather
  // than bury it at the end.
  assert.equal(sortProjects(SAMPLE, 'client', 'asc')[0].name, 'No client here');
  assert.equal(sortProjects(SAMPLE, 'sector', 'asc')[0].name, 'Phase 10 Works');
});

test('the order is stable, so the same URL gives the same rows', () => {
  // Two projects share a client and a location. Without a tiebreak their
  // order is whatever the sort happened to do, and a row appears to move on
  // reload — which reads as the data changing.
  const once = sortProjects(SAMPLE, 'location', 'asc').map((p) => p.name);
  const twice = sortProjects(SAMPLE, 'location', 'asc').map((p) => p.name);
  assert.deepEqual(once, twice);
  const tied = once.filter((n) => n.startsWith('Phase'));
  assert.deepEqual(tied, ['Phase 2 Works', 'Phase 10 Works'], 'ties fall back to name');
});

test('sorting never mutates the caller’s list', () => {
  const before = SAMPLE.map((p) => p.name);
  sortProjects(SAMPLE, 'tasks', 'desc');
  assert.deepEqual(SAMPLE.map((p) => p.name), before);
});

test('a junk sort parameter falls back rather than erroring', () => {
  // These arrive from the address bar, where anything can be typed.
  assert.deepEqual(parseSort('nonsense', 'sideways'), { sort: 'name', dir: 'asc' });
  assert.deepEqual(parseSort(null, null), { sort: 'name', dir: 'asc' });
  assert.deepEqual(parseSort('tasks', 'desc'), { sort: 'tasks', dir: 'desc' });
});

test('a header link flips its own column and keeps the filter', () => {
  assert.equal(sortHref('name', 'asc', 'name', ''), '?sort=name&dir=desc');
  assert.equal(sortHref('name', 'desc', 'name', ''), '?sort=name&dir=asc');
  // A different column starts ascending rather than inheriting a direction.
  assert.equal(sortHref('name', 'desc', 'tasks', ''), '?sort=tasks&dir=asc');
  // Losing the filter on a sort click would be the obvious annoyance.
  assert.match(sortHref('name', 'asc', 'tasks', 'zoo'), /^\?q=zoo&/);
});

test('the page reads the URL and delegates the ordering', () => {
  // Logic in an .astro file cannot be reached by a test, which is how a
  // shadowed variable took the sync down for an hour. The page must not
  // grow its own comparator.
  const page = readFileSync(
    new URL('../../pages/teamintranet/projects/index.astro', import.meta.url),
    'utf8',
  );
  assert.match(page, /sortProjects\(filtered, sort, dir\)/);
  assert.ok(!page.includes('new Intl.Collator'), 'the comparator belongs in the module');
  assert.ok(!/\.sort\(\(a, b\)/.test(page), 'the page must not sort inline');
});
