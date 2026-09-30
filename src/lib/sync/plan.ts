/**
 * Turning a TableSpec into the statement that writes it.
 *
 * Pure: everything here takes a spec and a record and returns SQL and
 * parameters. That is what makes the field map testable without a database,
 * and what keeps phase two an edit to tables.ts rather than to this file.
 *
 * THE UPSERT IS THE DANGEROUS PART OF THIS SYNC, so what it does and does not
 * touch is decided here, once:
 *
 *  - It matches on `airtable_record_id`, which is UNIQUE. It never matches on
 *    null: a portal upload carries a null key, nulls never conflict, and an
 *    upsert that tried would INSERT a duplicate of every uploaded document on
 *    every run. `restrictUpdateTo` is the second lock on the same door.
 *
 *  - The DO UPDATE names only sync-owned columns. `deliverables` is shared
 *    with the reader, whose frame, status and totals must survive a sync.
 *    Migration 007's column grant makes a wider statement fail loudly rather
 *    than silently, but the grant is the safety net — this is the design.
 *
 *  - `synced_at` is set on EVERY touched row, including rows whose values did
 *    not change. See the comment on SYNCED_AT below before removing that.
 */
import type { FieldSpec, TableSpec } from './tables.ts';
import { coerce, unknownChoice, type Coerced } from './coerce.ts';
import { PHASE_II_COMPLETE } from './tables.ts';

export interface AirtableRecord {
  id: string;
  createdTime?: string;
  fields: Record<string, unknown>;
}

export interface Issue {
  kind: 'unknown_choice' | 'unresolved_link' | 'coercion_failed';
  field: string;
  airtableValue: string | null;
  detail: string;
}

export interface RowPlan {
  airtableRecordId: string;
  columns: string[];
  values: unknown[];
  issues: Issue[];
  /** Link columns still holding an Airtable record id, to resolve before writing. */
  pendingLinks: { column: string; linkTo: string; recordId: string }[];
}

/**
 * SYNCED_AT — DO NOT SKIP THIS FOR UNCHANGED ROWS.
 *
 * "Nothing changed, so don't write" is the obvious optimisation and it would
 * be a disaster. The sweep decides what a run failed to see by comparing
 * `synced_at` against the run's `started_at`; a row the sync read, found
 * unchanged, and did not stamp looks exactly like a row that vanished from
 * Airtable. Skip the stamp and the next sweep marks the entire mirror missing.
 *
 * The write is cheap. The correctness is not optional.
 */
const SYNCED_AT = 'synced_at';

/** Columns the statement writes, in order. */
export function columnsFor(spec: TableSpec): string[] {
  const cols = ['airtable_record_id'];
  for (const f of spec.fields) if (!cols.includes(f.to)) cols.push(f.to);
  for (const c of Object.keys(spec.insertConstants ?? {})) if (!cols.includes(c)) cols.push(c);
  if (spec.key === 'deliverables') cols.push('completed_at');
  return cols;
}

/** Columns the DO UPDATE re-writes. Insert-only and derived columns are absent by design. */
export function updatedColumns(spec: TableSpec): string[] {
  const insertOnly = new Set<string>(Object.keys(spec.insertConstants ?? {}));
  if (spec.key === 'deliverables') insertOnly.add('completed_at');
  for (const f of spec.fields) if (f.writeWhen === 'insert_only') insertOnly.add(f.to);

  const out: string[] = [];
  for (const c of columnsFor(spec)) {
    if (c === 'airtable_record_id' || insertOnly.has(c)) continue;
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

export function buildUpsert(spec: TableSpec): string {
  const cols = columnsFor(spec);
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const conditional = new Map<string, FieldSpec>();
  for (const f of spec.fields) if (f.writeWhen === 'if_null_or_equal') conditional.set(f.to, f);

  const sets = updatedColumns(spec).map((c) =>
    conditional.has(c)
      ? // Shared column: yield to whatever is already there unless it agrees.
        `${c} = case when ${spec.key}.${c} is null or ${spec.key}.${c} = excluded.${c} ` +
        `then excluded.${c} else ${spec.key}.${c} end`
      : `${c} = excluded.${c}`
  );
  sets.push(`${SYNCED_AT} = now()`);

  const where = spec.restrictUpdateTo ? `\n  where ${spec.restrictUpdateTo}` : '';

  return (
    `insert into ${spec.key} (${cols.join(', ')}, ${SYNCED_AT})\n` +
    `values (${placeholders.join(', ')}, now())\n` +
    `on conflict (airtable_record_id) do update set\n  ${sets.join(',\n  ')}${where}\n` +
    // xmax = 0 on the returned row means this was an INSERT rather than an
    // UPDATE. It is how the run counts the two apart without a second query.
    `returning (xmax = 0) as inserted`
  );
}

/**
 * completed_at, derived rather than mapped.
 *
 * Migration 007's trigger fires on UPDATE only, so nothing stamps a row that
 * arrives already complete — which is all 3,023 of them on the first load.
 * The sync sets it here instead, from the delivery date.
 *
 * `due_date` is not a stale target: it is maintained as the work moves and
 * ends up holding the date the report went out. 94% of tasks carrying one are
 * complete. The 360 complete tasks with no due date get null, because we do
 * not know when they finished and the import date would be a lie that looks
 * like history.
 *
 * This is the one derivation in the sync, and it is here rather than in
 * tables.ts because a value computed from two other fields is not something a
 * field map can say. It is named and pure so it stays testable.
 */
export function completedAtOnInsert(fields: Record<string, unknown>): string | null {
  const phase = fields['Phase II: On the Table (Workflow)'];
  const name = typeof phase === 'string' ? phase : (phase as { name?: string } | null)?.name;
  if (!name || name.trim().toLowerCase() !== PHASE_II_COMPLETE.toLowerCase()) return null;

  const due = coerce('date', fields['Due Date']);
  if (due.value === null || typeof due.value !== 'string') return null;
  return `${due.value}T00:00:00Z`;
}

/** Everything one Airtable record becomes, before links are resolved. */
export function planRow(spec: TableSpec, record: AirtableRecord): RowPlan {
  const issues: Issue[] = [];
  const pendingLinks: RowPlan['pendingLinks'] = [];
  const byColumn = new Map<string, unknown>();

  for (const f of spec.fields) {
    const raw = record.fields[f.from];

    if (f.choices) {
      const odd = unknownChoice(f.choices, raw);
      if (odd !== null) {
        issues.push({
          kind: 'unknown_choice',
          field: f.from,
          airtableValue: odd,
          detail:
            `"${odd}" is not one of the ${f.choices.length} values this sync knows for ${f.from}. ` +
            `The record still loaded. If the choice was renamed in Airtable, anything reading ${f.to} ` +
            `has quietly stopped matching.`,
        });
      }
    }

    const c: Coerced = coerce(f.kind, raw);
    if (c.problem) {
      issues.push({
        kind: 'coercion_failed',
        field: f.from,
        airtableValue: raw === undefined ? null : JSON.stringify(raw).slice(0, 200),
        detail: `${f.from} → ${f.to}: ${c.problem}. Column left null; the record still loaded.`,
      });
    }

    if (f.kind === 'link' && typeof c.value === 'string' && f.linkTo) {
      pendingLinks.push({ column: f.to, linkTo: f.linkTo, recordId: c.value });
      byColumn.set(f.to, null); // filled by the resolver
    } else {
      byColumn.set(f.to, c.value);
    }
  }

  for (const [col, val] of Object.entries(spec.insertConstants ?? {})) byColumn.set(col, val);
  if (spec.key === 'deliverables') byColumn.set('completed_at', completedAtOnInsert(record.fields));

  const columns = columnsFor(spec);
  const values: unknown[] = columns.map((c) => (c === 'airtable_record_id' ? record.id : byColumn.get(c) ?? null));

  return { airtableRecordId: record.id, columns, values, issues, pendingLinks };
}
