/**
 * Ordering and text-filtering the work list.
 *
 * In a module rather than in the page, for the same reason as project-sort:
 * logic inside an .astro file cannot be called by a test, and "it's obviously
 * fine" is said most often about small things.
 */
import type { TaskRow } from './data/types.ts';

export const TASK_SORT_KEYS = [
  'due',
  'title',
  'project',
  'client',
  'pm',
  'workflow',
  'file',
] as const;
export type TaskSortKey = (typeof TASK_SORT_KEYS)[number];
export type SortDir = 'asc' | 'desc';

/**
 * Airtable groups by this field in its own order, which is a workflow
 * sequence rather than anything alphabetical — 'Complete' is last because it
 * is the end of the process, not because of the C. Sorting it A-Z would put
 * 'Complete' second and 'Docs Received - UNASSIGNED' fourth, which reads as
 * random to anyone who works the list.
 *
 * Read from the production enum on 2026-10-14. A state not in this list sorts
 * after every state that is, rather than being dropped.
 */
export const WORKFLOW_ORDER: readonly string[] = [
  'Docs Received - UNASSIGNED',
  'Docs Received - Assigned',
  'Special Projects',
  'Report / Takeoff Development',
  'Quality Control',
  'Draft Delivered',
  'Needs Revision -  Schedule TBD',
  'Needs Revision - Schedule Confirmed',
  'Pending Final Response',
  'Complete',
];

export function workflowRank(state: string | null): number {
  if (state === null) return WORKFLOW_ORDER.length + 1;
  const i = WORKFLOW_ORDER.indexOf(state);
  return i === -1 ? WORKFLOW_ORDER.length : i;
}

/** Unknown or absent values fall back to due/descending, matching Airtable. */
export function parseTaskSort(
  sort: string | null,
  dir: string | null,
): { sort: TaskSortKey; dir: SortDir } {
  const key = TASK_SORT_KEYS.find((k) => k === sort) ?? 'due';
  // Airtable sorts this view latest-first, and a work list reads that way:
  // the thing that just finished is the thing you are looking for.
  const fallback: SortDir = key === 'due' ? 'desc' : 'asc';
  return { sort: key, dir: dir === 'desc' ? 'desc' : dir === 'asc' ? 'asc' : fallback };
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * A task with no due date sorts last in BOTH directions, rather than first in
 * one of them. 2,718 of 5,560 have none — flipping the sort would otherwise
 * bury every dated row under a wall of blanks, which looks like the page
 * broke.
 */
function compareDue(a: TaskRow, b: TaskRow, dir: SortDir): number {
  if (a.dueDate === b.dueDate) return 0;
  if (a.dueDate === null) return 1;
  if (b.dueDate === null) return -1;
  const cmp = a.dueDate < b.dueDate ? -1 : 1;
  return dir === 'asc' ? cmp : -cmp;
}

const TEXT: Record<Exclude<TaskSortKey, 'due' | 'workflow' | 'file'>, (t: TaskRow) => string> = {
  title: (t) => t.title,
  project: (t) => t.projectName ?? '',
  client: (t) => t.clients.join(', '),
  pm: (t) => t.projectManagers.join(', '),
};

/** Sorted copy; the input is never mutated. */
export function sortTasks(rows: TaskRow[], sort: TaskSortKey, dir: SortDir): TaskRow[] {
  const out = [...rows];
  const flip = dir === 'asc' ? 1 : -1;

  out.sort((a, b) => {
    if (sort === 'due') return compareDue(a, b, dir);
    if (sort === 'workflow') {
      const d = workflowRank(a.workflow) - workflowRank(b.workflow);
      if (d !== 0) return d * flip;
    } else if (sort === 'file') {
      const d = Number(a.hasFile) - Number(b.hasFile);
      if (d !== 0) return d * flip;
    } else {
      const d = collator.compare(TEXT[sort](a), TEXT[sort](b));
      if (d !== 0) return d * flip;
    }
    // Ties break on title then id, so paging and re-renders are stable. Several
    // tasks on one project share a workflow state and a due date, and an
    // unstable order among them makes the list appear to shuffle on reload.
    return collator.compare(a.title, b.title) || collator.compare(a.id, b.id);
  });

  return out;
}

/**
 * Case-insensitive substring across everything a person might type: title,
 * project, client, PM, both fee proposal numbers, task type and task number.
 *
 * Substring rather than exact match because the fee proposal format is not
 * uniform — 1,272 of 1,661 are `FP-XX-YYYY-NNNN` and the rest are not, so
 * typing `2025-0088` has to find `FP-OR-2025-0088`. No fuzzy matching: these
 * project names have enough near-duplicates that a confident wrong suggestion
 * is worse than none.
 */
export function filterTasks(rows: TaskRow[], query: string): TaskRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((t) =>
    [
      t.title,
      t.projectName ?? '',
      t.projectFeeProposal ?? '',
      t.taskFeeProposal ?? '',
      ...t.clients,
      ...t.projectManagers,
      ...t.taskType,
      ...t.taskNumber,
    ]
      .join(' \u0000 ')
      .toLowerCase()
      .includes(q),
  );
}
