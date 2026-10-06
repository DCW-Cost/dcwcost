/**
 * Ordering the projects table.
 *
 * In a module rather than in the page, because logic inside an .astro file
 * cannot be called by a test — the same property that let a shadowed
 * variable take the sync down for an hour, and that made the data layer
 * worth a seam in the first place. Sorting is small, and small is exactly
 * when "it's obviously fine" gets said.
 */
import type { ProjectSummary } from './data/types.ts';

export const SORT_KEYS = ['name', 'client', 'sector', 'location', 'tasks'] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = 'asc' | 'desc';

const VALUE: Record<SortKey, (p: ProjectSummary) => string | number> = {
  name: (p) => p.name,
  client: (p) => p.clients.join(', '),
  sector: (p) => p.sector.join(', '),
  location: (p) => p.city.join(', '),
  tasks: (p) => p.taskCount,
};

/** Unknown or absent values fall back to name/ascending rather than erroring. */
export function parseSort(sort: string | null, dir: string | null): { sort: SortKey; dir: SortDir } {
  const key = SORT_KEYS.find((k) => k === sort) ?? 'name';
  return { sort: key, dir: dir === 'desc' ? 'desc' : 'asc' };
}

/**
 * numeric: true so "Phase 2" sorts before "Phase 10", which is how project
 * names are actually written. sensitivity: 'base' so case and accents do not
 * split what a person reads as one group.
 */
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * Sorted copy. The input is never mutated — the caller holds the filtered
 * list and the unfiltered count, and reordering theirs underneath them would
 * be a bug nobody looks for.
 *
 * BLANKS SORT TO THE TOP ASCENDING, and that is deliberate rather than a
 * side effect of comparing empty strings. The projects with no client or no
 * sector are the ones worth finding, and sorting by that column should bring
 * them to you. Pushing them to the end "because they aren't data" would hide
 * precisely what this page exists to surface.
 */
export function sortProjects(
  projects: readonly ProjectSummary[],
  sort: SortKey,
  dir: SortDir,
): ProjectSummary[] {
  const read = VALUE[sort];
  return [...projects].sort((a, b) => {
    const av = read(a);
    const bv = read(b);
    const cmp =
      typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : collator.compare(String(av), String(bv));
    // Ties fall back to name so the order is stable: the same URL must give
    // the same rows in the same order, or a row appears to move on reload.
    return (dir === 'desc' ? -cmp : cmp) || collator.compare(a.name, b.name);
  });
}

/** The link for a header: same column flips direction, a new column starts ascending. */
export function sortHref(current: SortKey, dir: SortDir, key: SortKey, q: string): string {
  const next: SortDir = current === key && dir === 'asc' ? 'desc' : 'asc';
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  params.set('sort', key);
  params.set('dir', next);
  return `?${params.toString()}`;
}
