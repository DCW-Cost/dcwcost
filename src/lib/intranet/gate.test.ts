/**
 * The master switch is parsed from a string a person typed into a hosting
 * dashboard. `True`, `TRUE` and a trailing space are all things that happen,
 * and a strict equality check turns any of them into a site-wide 404 with no
 * clue as to why — which is exactly what it did once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEnabled } from './gate.ts';

test('accepts the values a person actually types into a dashboard', () => {
  for (const v of ['true', 'True', 'TRUE', ' true', 'true ', '  TRUE  ', '1', 'yes', 'on']) {
    assert.equal(isEnabled(v), true, `expected ${JSON.stringify(v)} to open the gate`);
  }
});

test('fails closed on everything else, including the empty string', () => {
  for (const v of [undefined, '', ' ', 'false', 'False', '0', 'no', 'off', 'truthy', 'enabled']) {
    assert.equal(isEnabled(v), false, `expected ${JSON.stringify(v)} to keep the gate shut`);
  }
});
