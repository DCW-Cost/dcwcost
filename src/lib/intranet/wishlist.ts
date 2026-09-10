/**
 * The wishlist board — ideas and bugs, filed and voted on by the whole team.
 *
 * This deliberately does NOT go through the `DataProvider` seam that the cost
 * library uses. The library is still served from fixtures because no real cost
 * data has been loaded yet; the wishlist has no such problem, so it talks to
 * Supabase directly and genuinely persists from day one.
 *
 * That split is the point. A suggestion box that forgets what you typed is
 * worse than no suggestion box, and the first thing the team will do with this
 * tool is tell us what is wrong with it.
 *
 * Every call runs as the signed-in person through their own cookie session, so
 * row-level security is what actually enforces "authors edit wording, admins
 * triage" — not the code below. See migrations/001_wishlist_and_uploads.sql.
 */
import type { AstroCookies } from 'astro';
import { serverClient, authConfigured } from './auth.ts';

export type WishlistKind = 'idea' | 'bug';

export type WishlistStatus =
  | 'submitted'
  | 'under_review'
  | 'planned'
  | 'in_progress'
  | 'shipped'
  | 'declined';

export interface WishlistItem {
  id: string;
  kind: WishlistKind;
  title: string;
  body: string | null;
  status: WishlistStatus;
  /** 1 = highest. Null until an admin triages it. */
  priority: number | null;
  targetDate: string | null;
  adminNote: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  createdByName: string;
  voteCount: number;
  commentCount: number;
  viewerHasVoted: boolean;
}

export const KIND_LABEL: Record<WishlistKind, string> = {
  idea: 'Idea',
  bug: 'Bug',
};

export const STATUS_LABEL: Record<WishlistStatus, string> = {
  submitted: 'Submitted',
  under_review: 'Under review',
  planned: 'Planned',
  in_progress: 'In progress',
  shipped: 'Shipped',
  declined: 'Not doing',
};

/**
 * Reuses the chip variants already defined in intranet.css (green/amber/red/
 * excluded) rather than inventing a parallel set, so the board inherits dark
 * mode and the confidence-gate palette for free.
 */
export const STATUS_TONE: Record<WishlistStatus, 'green' | 'amber' | 'red' | 'excluded'> = {
  submitted: 'excluded',
  under_review: 'excluded',
  planned: 'amber',
  in_progress: 'amber',
  shipped: 'green',
  declined: 'red',
};

export const PRIORITY_LABEL: Record<number, string> = {
  1: 'P1 · Now',
  2: 'P2 · Next',
  3: 'P3 · Later',
  4: 'P4 · Someday',
};

export const STATUSES = Object.keys(STATUS_LABEL) as WishlistStatus[];

/** Open items sort by votes; closed ones by when they closed. */
const OPEN: WishlistStatus[] = ['submitted', 'under_review', 'planned', 'in_progress'];

export function isOpen(item: WishlistItem): boolean {
  return OPEN.includes(item.status);
}

/** True when the board can actually store anything. */
export const wishlistEnabled = authConfigured;

interface Row {
  id: string;
  kind: WishlistKind;
  title: string;
  body: string | null;
  status: WishlistStatus;
  priority: number | null;
  target_date: string | null;
  admin_note: string | null;
  created_at: string;
  updated_at: string;
  created_by: string;
  created_by_name: string | null;
  vote_count: number | null;
  comment_count: number | null;
  viewer_has_voted: boolean | null;
}

function toItem(r: Row): WishlistItem {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    status: r.status,
    priority: r.priority,
    targetDate: r.target_date,
    adminNote: r.admin_note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    createdBy: r.created_by,
    createdByName: r.created_by_name ?? 'Someone',
    voteCount: r.vote_count ?? 0,
    commentCount: r.comment_count ?? 0,
    viewerHasVoted: Boolean(r.viewer_has_voted),
  };
}

export interface WishlistResult {
  items: WishlistItem[];
  /** Set when the board could not be read, so the page can say why. */
  error: string | null;
}

export async function listWishlist(
  cookies: AstroCookies,
  request: Request
): Promise<WishlistResult> {
  const supabase = serverClient(cookies, request);
  if (!supabase) {
    return {
      items: [],
      error: 'The wishlist needs a database. Set SUPABASE_URL and SUPABASE_ANON_KEY.',
    };
  }

  const { data, error } = await supabase
    .from('v_wishlist')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    // The most likely cause by far is that migration 001 has not been run yet.
    // Say that rather than surfacing a bare Postgres error to an estimator.
    const missing = /relation .* does not exist|schema cache/i.test(error.message);
    return {
      items: [],
      error: missing
        ? 'The wishlist tables are not there yet — run migrations/001_wishlist_and_uploads.sql in Supabase.'
        : error.message,
    };
  }

  const items = (data as Row[]).map(toItem);

  // Open items ranked by demand, then recency. Closed items fall below, newest
  // first, so "what shipped lately" reads top-down.
  items.sort((a, b) => {
    const ao = isOpen(a), bo = isOpen(b);
    if (ao !== bo) return ao ? -1 : 1;
    if (ao) {
      if (b.voteCount !== a.voteCount) return b.voteCount - a.voteCount;
      return b.createdAt.localeCompare(a.createdAt);
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  });

  return { items, error: null };
}

/** Field limits mirror the CHECK constraints, so the form fails before the DB does. */
export const LIMITS = { title: 140, body: 4000, adminNote: 2000 } as const;

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export async function createItem(
  cookies: AstroCookies,
  request: Request,
  input: { kind: WishlistKind; title: string; body: string }
): Promise<ActionResult> {
  const supabase = serverClient(cookies, request);
  if (!supabase) return { ok: false, error: 'No database configured.' };

  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return { ok: false, error: 'Not signed in.' };

  const title = input.title.trim();
  if (title.length < 3) return { ok: false, error: 'Give it a title of at least 3 characters.' };
  if (title.length > LIMITS.title) return { ok: false, error: `Title is over ${LIMITS.title} characters.` };
  const body = input.body.trim().slice(0, LIMITS.body);

  const { error } = await supabase.from('wishlist_items').insert({
    kind: input.kind,
    title,
    body: body || null,
    created_by: auth.user.id,
  });

  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Votes toggle: pressing it twice takes your vote back. */
export async function toggleVote(
  cookies: AstroCookies,
  request: Request,
  itemId: string
): Promise<ActionResult> {
  const supabase = serverClient(cookies, request);
  if (!supabase) return { ok: false, error: 'No database configured.' };

  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return { ok: false, error: 'Not signed in.' };

  const { data: existing } = await supabase
    .from('wishlist_votes')
    .select('item_id')
    .eq('item_id', itemId)
    .eq('profile_id', auth.user.id)
    .maybeSingle();

  const { error } = existing
    ? await supabase
        .from('wishlist_votes')
        .delete()
        .eq('item_id', itemId)
        .eq('profile_id', auth.user.id)
    : await supabase
        .from('wishlist_votes')
        .insert({ item_id: itemId, profile_id: auth.user.id });

  return error ? { ok: false, error: error.message } : { ok: true };
}

/**
 * Triage. Only admins can make this stick — the database trigger silently holds
 * these columns for everyone else, so a non-admin posting this form gets a
 * successful-looking write that changes nothing. That is the correct outcome:
 * the UI never offers it, and forging the request is not rewarded.
 */
export async function triageItem(
  cookies: AstroCookies,
  request: Request,
  input: {
    id: string;
    status?: WishlistStatus;
    priority?: number | null;
    targetDate?: string | null;
    adminNote?: string | null;
  }
): Promise<ActionResult> {
  const supabase = serverClient(cookies, request);
  if (!supabase) return { ok: false, error: 'No database configured.' };

  const patch: Record<string, unknown> = {};
  if (input.status) patch.status = input.status;
  if (input.priority !== undefined) patch.priority = input.priority;
  if (input.targetDate !== undefined) patch.target_date = input.targetDate || null;
  if (input.adminNote !== undefined) {
    patch.admin_note = input.adminNote ? input.adminNote.slice(0, LIMITS.adminNote) : null;
  }
  if (Object.keys(patch).length === 0) return { ok: true };

  const { error } = await supabase.from('wishlist_items').update(patch).eq('id', input.id);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Authors withdraw their own; admins remove anything. RLS decides which. */
export async function deleteItem(
  cookies: AstroCookies,
  request: Request,
  itemId: string
): Promise<ActionResult> {
  const supabase = serverClient(cookies, request);
  if (!supabase) return { ok: false, error: 'No database configured.' };
  const { error } = await supabase.from('wishlist_items').delete().eq('id', itemId);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Rough grouping for the board's summary strip. */
export function summarise(items: WishlistItem[]) {
  return {
    total: items.length,
    ideas: items.filter((i) => i.kind === 'idea').length,
    bugs: items.filter((i) => i.kind === 'bug').length,
    open: items.filter(isOpen).length,
    shipped: items.filter((i) => i.status === 'shipped').length,
    votes: items.reduce((n, i) => n + i.voteCount, 0),
  };
}
