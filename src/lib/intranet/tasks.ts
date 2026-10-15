/**
 * The work list — tasks from the mirror, and the one task an upload is for.
 *
 * This deliberately does NOT go through the `DataProvider` seam, for the same
 * reason the wishlist does not: that seam exists so the cost library can run
 * on fixtures while no real cost data is loaded. The mirror has 5,560 real
 * tasks and needs no such indirection. PORTAL-BRIEF.md §2 says so directly —
 * "DataProvider is for the cost library only" — and the first draft of this
 * page ignored it.
 *
 * It was not a style problem. `INTRANET_DATA=fixtures` on this deployment, so
 * going through the seam served three invented tasks, and the Upload link from
 * a real row carried an id that matched none of them. The page reported "that
 * task could not be found" and fell back to the project picker it was built to
 * replace.
 *
 * Every call runs as the signed-in person through their own cookie session, so
 * row-level security is what enforces access — not the code below.
 */
import type { AstroCookies } from 'astro';
import { serverClient } from './auth.ts';

type Row = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const strOrNull = (v: unknown): string | null => (v == null ? null : str(v) || null);
const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(str).filter(Boolean) : [];

/**
 * One row of the work list — a task, which is what a cost report attaches to.
 *
 * THE GRAIN IS THE TASK, NOT THE PROJECT, AND THAT IS THE WHOLE POINT.
 *
 * A document belongs to one task. One project may carry many: the Bond
 * Planning job is a single project with nine tasks — three schools across
 * schematic design, design development and construction documents — and four
 * of the pilot reports belong to it. Asked to pick a project for those four,
 * there is no answer that distinguishes them.
 */
export interface TaskRow {
  /** deliverables.id — what an upload attaches to. */
  id: string;
  title: string;
  /** Multi-valued: a task may be both 'Concept' and 'Option Study'. */
  taskType: string[];
  /**
   * Also multi-valued, and NOT only a number: the same Airtable field carries
   * the billing arrangement, so 'On-Call', 'Hourly', 'Pro Bono', 'No Bill' and
   * 'Split Task' appear beside 'Task 1' and 'Task 2b'. Render as chips; never
   * parse it for an ordinal.
   */
  taskNumber: string[];
  projectManagers: string[];
  clients: string[];
  dueDate: string | null;
  /** 'Phase II: On the Table (Workflow)' — ten states, 'Complete' last. */
  workflow: string | null;
  folderLink: string | null;
  projectId: string | null;
  projectName: string | null;
  /**
   * The project's fee proposal, e.g. 'FP-OR-2025-0088' — what DCW uses as a
   * project number. 89% of projects have one, and the format varies enough
   * (`FPSEA-2019-0086c`) that it is matched by substring, never parsed.
   */
  projectFeeProposal: string | null;
  /** The task's own: the project's plus a suffix, 'FP-WA-2026-0106-2'. */
  taskFeeProposal: string | null;
  /** True once a cost report has been attached to this task. */
  hasFile: boolean;
  uploadedAt: string | null;
  /** deliverables.status — where the reader has got to with it. */
  ingestStatus: string;
}

export interface TaskFilters {
  /** Airtable's default view is 'Complete'. null means every state. */
  workflow?: string | null;
  /** Due within this many days. null for no date bound. */
  dueWithinDays?: number | null;
  /** true: only tasks that already have a file. false: only those without. */
  hasFile?: boolean | null;
}

const SELECT = `id, project_task_title, task_name, task_type, task_number, due_date,
   phase_ii_workflow, project_folder_link, fee_proposal, status,
   storage_path, uploaded_at,
   projects(id, name, fee_proposal),
   deliverable_project_managers(people(name))`;

/**
 * PostgREST caps an unbounded select at 1,000 rows and says nothing about it.
 * Unfiltered this table is 5,560 tasks, so the cap is not hypothetical — it
 * would drop 4,560 of them and still render a page that looks complete.
 */
async function allRows(
  label: string,
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<Row[]> {
  const PAGE = 1000;
  const MAX = 50_000;
  const out: Row[] = [];
  for (let from = 0; from < MAX; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(`${label}: ${(error as { message?: string }).message ?? error}`);
    const page = Array.isArray(data) ? (data as Row[]) : [];
    out.push(...page);
    if (page.length < PAGE) return out;
  }
  throw new Error(`${label}: more than ${MAX} rows; refusing to return a truncated list`);
}

/**
 * Clients come from a second query rather than a third level of embedding.
 * Two levels is proven in this codebase; three is not, and a nested embed that
 * silently returns nothing would show every task with no client — wrong in the
 * direction nobody questions.
 *
 * CHUNKED, because `in()` goes into the URL. 1,800 project ids at 37 characters
 * each is a 66 KB query string, well past what the edge will accept, and the
 * whole lookup fails — which is how the unfiltered case broke.
 */
async function clientsFor(
  db: NonNullable<ReturnType<typeof serverClient>>,
  projectIds: string[],
): Promise<Map<string, string[]>> {
  const byProject = new Map<string, string[]>();
  const CHUNK = 150;

  for (let i = 0; i < projectIds.length; i += CHUNK) {
    const slice = projectIds.slice(i, i + CHUNK);
    const links = await allRows('work list clients', (from, to) =>
      db
        .from('project_client_companies')
        .select('project_id, client_companies(company_name)')
        .in('project_id', slice)
        .range(from, to),
    );
    for (const link of links) {
      const pid = str(link.project_id);
      const company = str(((link.client_companies ?? {}) as Row).company_name);
      if (!pid || !company) continue;
      const list = byProject.get(pid) ?? [];
      if (!list.includes(company)) list.push(company);
      byProject.set(pid, list);
    }
  }

  for (const list of byProject.values()) list.sort();
  return byProject;
}

function toTask(r: Row, clients: Map<string, string[]>): TaskRow {
  const project = (r.projects ?? {}) as Row;

  const pmLinks = Array.isArray(r.deliverable_project_managers)
    ? (r.deliverable_project_managers as Row[])
    : [];
  const projectManagers: string[] = [];
  for (const link of pmLinks) {
    // `people` has no table-level SELECT for `authenticated` — only column
    // grants, which cover `name` and deliberately do not cover
    // hourly_profit_rate. Selecting the one column keeps that intact.
    const name = str(((link?.people ?? {}) as Row).name);
    if (name && !projectManagers.includes(name)) projectManagers.push(name);
  }
  projectManagers.sort();

  return {
    id: str(r.id),
    // project_task_title is filled on 5,559 of 5,560; task_name is the
    // fallback and the id the last resort, so a row is never blank and
    // therefore never invisible in the list.
    title: str(r.project_task_title) || str(r.task_name) || str(r.id),
    taskType: strArray(r.task_type),
    taskNumber: strArray(r.task_number),
    projectManagers,
    clients: clients.get(str(project.id)) ?? [],
    dueDate: strOrNull(r.due_date),
    workflow: strOrNull(r.phase_ii_workflow),
    folderLink: strOrNull(r.project_folder_link),
    projectId: strOrNull(project.id),
    projectName: strOrNull(project.name),
    projectFeeProposal: strOrNull(project.fee_proposal),
    taskFeeProposal: strOrNull(r.fee_proposal),
    hasFile: r.storage_path != null,
    uploadedAt: strOrNull(r.uploaded_at),
    ingestStatus: str(r.status),
  };
}

export async function listTasks(
  cookies: AstroCookies,
  request: Request,
  filters: TaskFilters,
): Promise<TaskRow[]> {
  const db = serverClient(cookies, request);
  if (!db) return [];

  const found = await allRows('work list', (from, to) => {
    let q = db.from('deliverables').select(SELECT).range(from, to);

    if (filters.workflow != null) q = q.eq('phase_ii_workflow', filters.workflow);

    if (filters.dueWithinDays != null) {
      const since = new Date();
      since.setUTCDate(since.getUTCDate() - filters.dueWithinDays);
      // A task with no due date is excluded by this bound rather than included
      // as "infinitely old" — 2,718 have none, and sweeping them in would make
      // the date filter look broken.
      q = q.gte('due_date', since.toISOString().slice(0, 10));
    }

    // storage_path is what makes a file real; uploaded_at is set beside it but
    // is not the column the reader checks, so this matches the reader.
    if (filters.hasFile === true) q = q.not('storage_path', 'is', null);
    if (filters.hasFile === false) q = q.is('storage_path', null);

    return q;
  });

  const projectIds = [
    ...new Set(found.map((r) => str(((r.projects ?? {}) as Row).id)).filter(Boolean)),
  ];
  const clients = await clientsFor(db, projectIds);
  return found.map((r) => toTask(r, clients));
}

/**
 * One task, by id — for the upload page arriving as ?task=<id>.
 *
 * A single query rather than listing everything and searching it. The first
 * draft did the latter, which pulled 5,560 rows and then asked for the clients
 * of ~1,800 projects in one `in()` — a query string long enough to be rejected
 * outright. Fetching thousands of rows to find one was the actual bug; the URL
 * length was how it announced itself.
 *
 * Returns null when the id is unknown, which the page shows as a stale link
 * rather than an error.
 */
export async function getTask(
  cookies: AstroCookies,
  request: Request,
  id: string,
): Promise<TaskRow | null> {
  const db = serverClient(cookies, request);
  if (!db) return null;

  const { data, error } = await db.from('deliverables').select(SELECT).eq('id', id).maybeSingle();
  if (error) throw new Error(`task lookup: ${error.message}`);
  if (!data) return null;

  const row = data as Row;
  const projectId = str(((row.projects ?? {}) as Row).id);
  const clients = projectId ? await clientsFor(db, [projectId]) : new Map<string, string[]>();
  return toTask(row, clients);
}
