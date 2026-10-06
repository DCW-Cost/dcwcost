/**
 * The seam, checked where it is easy to get wrong.
 *
 * These are not tests of Supabase — that needs a database. They are tests of
 * the contract both providers must satisfy, and of the two mistakes that
 * would be invisible until a real deploy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixtureProvider } from './fixtures.ts';

test('fixtures implement every method the interface declares', async () => {
  // A method added to DataProvider and implemented only in supabase.ts type
  // checks fine and throws at runtime in demo mode, which is where everyone
  // develops.
  const declared = readFileSync(new URL('./types.ts', import.meta.url), 'utf8');
  const iface = declared.slice(declared.indexOf('export interface DataProvider'));
  const methods = [...iface.slice(0, iface.indexOf('\n}')).matchAll(/^\s{2}(\w+)\(/gm)].map((m) => m[1]);
  assert.ok(methods.length >= 8, `expected to find the methods, found ${methods.length}`);
  for (const m of methods) {
    assert.equal(typeof (fixtureProvider as never)[m], 'function', `fixtures must implement ${m}`);
  }
});

test('both providers are checked against the same method list', () => {
  // supabase.ts is not importable here — it reads import.meta.env at load —
  // so its coverage is checked by source rather than by call.
  const declared = readFileSync(new URL('./types.ts', import.meta.url), 'utf8');
  const iface = declared.slice(declared.indexOf('export interface DataProvider'));
  const methods = [...iface.slice(0, iface.indexOf('\n}')).matchAll(/^\s{2}(\w+)\(/gm)].map((m) => m[1]);
  const supa = readFileSync(new URL('./supabase.ts', import.meta.url), 'utf8');
  for (const m of methods) {
    assert.ok(supa.includes(`async ${m}(`), `supabase.ts must implement ${m}`);
  }
});

test('the layout never uses the throwing module-level provider', () => {
  // It did. Under INTRANET_DATA=supabase the module-level `provider` is a
  // Proxy that throws on any access, and the layout called
  // getOpenQuestions() unconditionally — so the first real-data deploy would
  // have broken every page in the intranet from the shell they all share,
  // including pages that had been migrated correctly.
  const layout = readFileSync(new URL('../../../layouts/IntranetLayout.astro', import.meta.url), 'utf8');
  assert.ok(
    !/import \{[^}]*\bprovider\b[^}]*\} from/.test(layout.replace(/getProvider/g, '')),
    'the layout must import getProvider, not provider',
  );
  assert.match(layout, /getProvider\(Astro\.cookies, Astro\.request\)/);
});

test('the projects page is read-only', () => {
  // The safety claim this page is built on. Nothing here may write.
  const page = readFileSync(
    new URL('../../../pages/teamintranet/projects/index.astro', import.meta.url),
    'utf8',
  );
  for (const forbidden of ['.insert(', '.update(', '.delete(', '.upsert(', 'method="POST"']) {
    assert.ok(!page.includes(forbidden), `the projects page must not contain ${forbidden}`);
  }
});

test('a project with nothing in it still renders something legible', async () => {
  // The fixture deliberately includes a project with no client, no sector
  // and no tasks, because an empty cell is ambiguous — missing data, or a
  // broken page? The page says "none" so a blank is a finding.
  const rows = await fixtureProvider.listProjectSummaries();
  const empty = rows.find((r) => r.clients.length === 0);
  assert.ok(empty, 'fixtures must include a project with no client');
  assert.equal(empty.taskCount, 0);
  const multi = rows.find((r) => r.clients.length > 1);
  assert.ok(multi, 'fixtures must include a two-client project, since 30 real ones exist');
});
