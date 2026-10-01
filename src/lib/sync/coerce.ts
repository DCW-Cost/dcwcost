/**
 * Turning what Airtable sends into what a Postgres column will take.
 *
 * Every function here is pure and every failure is a value, never a throw. A
 * sync that refuses a whole record because one field would not parse is worse
 * than one that loads the record, leaves that column null, and says so — the
 * record is the thing somebody needs; the field is a detail they can fix in
 * Airtable once they know.
 *
 * WHAT AIRTABLE ACTUALLY SENDS, AND WHY THIS IS DEFENSIVE
 *
 * The REST API returns a single select as a bare string, a multiple select as
 * an array of strings, and a linked record as an array of record ids. Some
 * clients — the MCP server among them — enrich those into objects carrying
 * `{id, name}`. This module accepts both shapes for both cases, because the
 * cost of accepting an object that never arrives is three lines, and the cost
 * of assuming the wrong one is every select column in the mirror silently
 * landing as "[object Object]".
 */

export type Kind =
  | 'text'
  | 'text[]'
  | 'numeric'
  | 'integer'
  | 'boolean'
  | 'date'
  | 'timestamptz'
  | 'link';

export interface Coerced {
  /** The value to bind, or null. Never undefined — a bound null is explicit. */
  value: unknown;
  /**
   * Set when the value could not be represented. The record still loads; this
   * becomes a `coercion_failed` anomaly naming the field and what arrived.
   */
  problem?: string;
}

const ok = (value: unknown): Coerced => ({ value });
const bad = (problem: string): Coerced => ({ value: null, problem });

/** `{name: 'Complete'}` and `'Complete'` both mean Complete. */
function selectName(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string') {
    return (v as { name: string }).name;
  }
  return null;
}

/** `'recAbc…'` and `{id: 'recAbc…'}` both mean that record. */
function recordId(v: unknown): string | null {
  if (typeof v === 'string') return /^rec[A-Za-z0-9]{14}$/.test(v) ? v : null;
  if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') {
    const id = (v as { id: string }).id;
    return /^rec[A-Za-z0-9]{14}$/.test(id) ? id : null;
  }
  return null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function coerce(kind: Kind, raw: unknown): Coerced {
  // Airtable omits empty fields entirely rather than sending null, and an
  // empty string is how a cleared text field arrives. Both mean "no value".
  if (raw === undefined || raw === null) return ok(null);
  if (typeof raw === 'string' && raw.trim() === '') return ok(null);
  if (Array.isArray(raw) && raw.length === 0) return ok(null);

  switch (kind) {
    case 'text': {
      const many = Array.isArray(raw) && raw.length > 1;
      const one = Array.isArray(raw) ? raw[0] : raw;
      const name = selectName(one);
      const value = name !== null ? name.trim()
        : typeof one === 'number' || typeof one === 'boolean' ? String(one)
        : null;
      if (value === null) return bad(`expected text, got ${describe(raw)}`);
      // A multiple select feeding a single text column. Keeping the first is
      // the only thing a text column can do, but doing it silently is how a
      // project quietly loses its second category. Say so every time.
      if (many) {
        const all = (raw as unknown[]).map(selectName).filter(Boolean).join(' | ');
        return { value, problem: `${(raw as unknown[]).length} values (${all}); kept the first` };
      }
      return ok(value);
    }

    case 'text[]': {
      const items = Array.isArray(raw) ? raw : [raw];
      const out: string[] = [];
      for (const item of items) {
        const name = selectName(item);
        if (name === null) return bad(`expected a list of text, got ${describe(raw)}`);
        const trimmed = name.trim();
        if (trimmed !== '') out.push(trimmed);
      }
      return out.length ? ok(out) : ok(null);
    }

    case 'numeric':
    case 'integer': {
      const one = Array.isArray(raw) ? raw[0] : raw;
      const n = typeof one === 'number' ? one : Number(selectName(one) ?? NaN);
      if (!Number.isFinite(n)) return bad(`expected a number, got ${describe(raw)}`);
      if (kind === 'integer' && !Number.isInteger(n)) return ok(Math.round(n));
      return ok(n);
    }

    case 'boolean': {
      // An Airtable checkbox is `true` or absent. Anything else is a field
      // that is not the checkbox this map thinks it is.
      if (typeof raw === 'boolean') return ok(raw);
      const name = selectName(Array.isArray(raw) ? raw[0] : raw);
      if (name === null) return bad(`expected a checkbox, got ${describe(raw)}`);
      const l = name.trim().toLowerCase();
      if (['true', 'yes', 'checked', '1'].includes(l)) return ok(true);
      if (['false', 'no', 'unchecked', '0'].includes(l)) return ok(false);
      return bad(`expected a checkbox, got ${JSON.stringify(name).slice(0, 60)}`);
    }

    case 'date': {
      const one = Array.isArray(raw) ? raw[0] : raw;
      const s = selectName(one);
      if (s === null) return bad(`expected a date, got ${describe(raw)}`);
      const t = s.trim();
      if (ISO_DATE.test(t)) return ok(t);
      // An Airtable date field with a time component, or a date written by a
      // person into a text field. Keep the day, drop the rest.
      const parsed = new Date(t);
      if (Number.isNaN(parsed.getTime())) return bad(`not a date: ${JSON.stringify(t).slice(0, 60)}`);
      return ok(parsed.toISOString().slice(0, 10));
    }

    case 'timestamptz': {
      const one = Array.isArray(raw) ? raw[0] : raw;
      const s = selectName(one);
      if (s === null) return bad(`expected a timestamp, got ${describe(raw)}`);
      const parsed = new Date(s.trim());
      if (Number.isNaN(parsed.getTime())) return bad(`not a timestamp: ${JSON.stringify(s).slice(0, 60)}`);
      return ok(parsed.toISOString());
    }

    case 'link': {
      // A link field is always a list in Airtable, even at one entry. The
      // mirror stores a single uuid, so anything past the first is dropped —
      // and saying so is the point: a task with two project links is a data
      // question, not something to silently pick a winner for.
      const items = Array.isArray(raw) ? raw : [raw];
      const ids = items.map(recordId).filter((v): v is string => v !== null);
      if (ids.length === 0) return bad(`expected a linked record, got ${describe(raw)}`);
      if (ids.length > 1) return { value: ids[0], problem: `${ids.length} links, kept the first (${ids[0]})` };
      return ok(ids[0]);
    }
  }
}

function describe(raw: unknown): string {
  if (Array.isArray(raw)) return `an array of ${raw.length} (${JSON.stringify(raw[0] ?? null).slice(0, 40)}…)`;
  return `${typeof raw} ${JSON.stringify(raw).slice(0, 40)}`;
}

/**
 * Every record id in a link field, in order.
 *
 * `coerce('link', …)` keeps the first and reports the rest as a problem,
 * because the column it feeds holds one. A join table holds all of them, so
 * this is the other half: same parsing, no loss, no complaint.
 *
 * Anything that is not a record id is skipped rather than throwing — the
 * caller counts what it resolved against what it was given.
 */
export function allRecordIds(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const item of items) {
    const id = recordId(item);
    if (id !== null && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * A single-select value the field map did not expect.
 *
 * Renaming a choice in Airtable is a two-second edit with no visible
 * consequence there, and Phase II's "Complete" is what decides whether
 * `completed_at` is ever set. This is how that surfaces as a row in
 * sync_anomalies rather than as a column that quietly stops filling.
 *
 * The value is still loaded. Refusing it would lose data over a label.
 */
export function unknownChoice(known: readonly string[], value: unknown): string | null {
  const name = selectName(Array.isArray(value) ? value[0] : value);
  if (name === null) return null;
  const t = name.trim();
  if (t === '') return null;
  return known.some((k) => k.toLowerCase() === t.toLowerCase()) ? null : t;
}
