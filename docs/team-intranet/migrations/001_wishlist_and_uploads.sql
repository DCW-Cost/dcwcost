-- ============================================================================
-- Migration 001 — the wishlist board, and documents that arrive by hand
--
-- Additive only. Safe to run on the live project; it creates new objects and
-- relaxes two constraints on `deliverables`. It does not touch existing data.
--
-- Run it in Supabase → SQL Editor → New query → paste → Run.
-- Expected result: "Success. No rows returned."
--
-- Depends on schema.sql having been applied first (it uses is_active_user()
-- and is_admin() from there).
-- ============================================================================

-- ============================================================================
-- 1. The wishlist
--
-- Anyone active can file an idea or a bug, and vote for anyone else's. The
-- whole team sees the whole queue — that is the point of it. Only admins set
-- status, priority and target date, because a shared queue where everyone can
-- mark their own item "in progress" is not a queue.
-- ============================================================================

create type wishlist_kind as enum ('idea', 'bug');

create type wishlist_status as enum
  ('submitted', 'under_review', 'planned', 'in_progress', 'shipped', 'declined');

create table wishlist_items (
  id            uuid primary key default gen_random_uuid(),
  kind          wishlist_kind   not null default 'idea',
  title         text            not null check (length(trim(title)) between 3 and 140),
  body          text            check (length(body) <= 4000),

  -- Admin-controlled. See the policies below: an ordinary member can insert a
  -- row but cannot move it along, and cannot edit these after the fact.
  status        wishlist_status not null default 'submitted',
  priority      smallint        check (priority between 1 and 4),  -- 1 = highest
  target_date   date,
  admin_note    text            check (length(admin_note) <= 2000),

  created_by    uuid            not null references profiles(id) on delete cascade,
  created_at    timestamptz     not null default now(),
  updated_at    timestamptz     not null default now()
);

create index on wishlist_items (status);
create index on wishlist_items (kind);
create index on wishlist_items (created_by);
create index on wishlist_items (created_at desc);

-- One vote per person per item. The primary key enforces it, so a double-click
-- cannot inflate a count.
create table wishlist_votes (
  item_id     uuid        not null references wishlist_items(id) on delete cascade,
  profile_id  uuid        not null references profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (item_id, profile_id)
);

create index on wishlist_votes (profile_id);

create table wishlist_comments (
  id          uuid        primary key default gen_random_uuid(),
  item_id     uuid        not null references wishlist_items(id) on delete cascade,
  body        text        not null check (length(trim(body)) between 1 and 4000),
  created_by  uuid        not null references profiles(id) on delete cascade,
  created_at  timestamptz not null default now()
);

create index on wishlist_comments (item_id, created_at);

-- Keep updated_at honest without the app having to remember.
create or replace function touch_wishlist_item() returns trigger
  language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger wishlist_items_touch
  before update on wishlist_items
  for each row execute function touch_wishlist_item();

-- ----------------------------------------------------------------------------
-- Read model: an item with its vote count and its author's name, so the board
-- is one query rather than N+1. security_invoker is mandatory — without it this
-- view would run as its owner and read straight past every policy below.
-- ----------------------------------------------------------------------------
create view v_wishlist with (security_invoker = true) as
  select
    i.id,
    i.kind,
    i.title,
    i.body,
    i.status,
    i.priority,
    i.target_date,
    i.admin_note,
    i.created_at,
    i.updated_at,
    i.created_by,
    p.full_name                          as created_by_name,
    coalesce(v.vote_count, 0)::int       as vote_count,
    coalesce(c.comment_count, 0)::int    as comment_count,
    exists (
      select 1 from wishlist_votes mv
      where mv.item_id = i.id and mv.profile_id = auth.uid()
    )                                    as viewer_has_voted
  from wishlist_items i
  join profiles p on p.id = i.created_by
  left join (
    select item_id, count(*) as vote_count
    from wishlist_votes group by item_id
  ) v on v.item_id = i.id
  left join (
    select item_id, count(*) as comment_count
    from wishlist_comments group by item_id
  ) c on c.item_id = i.id;

-- ----------------------------------------------------------------------------
-- Policies
-- ----------------------------------------------------------------------------
alter table wishlist_items    enable row level security;
alter table wishlist_votes    enable row level security;
alter table wishlist_comments enable row level security;

-- Everyone active reads the whole board. That is deliberate: a wishlist nobody
-- can see is a suggestion box.
create policy wishlist_items_read on wishlist_items
  for select using (is_active_user());

-- You may file an item, as yourself. `created_by` is forced to your own id, so
-- nobody can file something under a colleague's name.
create policy wishlist_items_insert on wishlist_items
  for insert with check (is_active_user() and created_by = auth.uid());

-- Authors may fix their own wording. They may NOT move their own item along the
-- board.
--
-- The obvious way to write that is a WITH CHECK comparing each triage column
-- against a sub-select of the same row — but a self-referencing subquery inside
-- a policy on the table being updated depends on statement snapshot rules and
-- is not reliable. A BEFORE UPDATE trigger sees OLD and NEW directly, so it is
-- both deterministic and readable. The policy grants the row; the trigger
-- decides which columns actually moved.
create policy wishlist_items_author_update on wishlist_items
  for update
  using (is_active_user() and created_by = auth.uid())
  with check (created_by = auth.uid());

create or replace function guard_wishlist_triage() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if is_admin() then
    return new;                       -- admins may move anything
  end if;
  -- Silently hold the triage columns at their existing values rather than
  -- raising: an author editing their own title should not hit an error because
  -- the form round-tripped a status they never touched.
  new.status      := old.status;
  new.priority    := old.priority;
  new.target_date := old.target_date;
  new.admin_note  := old.admin_note;
  new.created_by  := old.created_by;  -- authorship is never reassigned
  return new;
end;
$$;

create trigger wishlist_items_guard_triage
  before update on wishlist_items
  for each row execute function guard_wishlist_triage();

-- Admins triage: status, priority, target date, note.
create policy wishlist_items_admin_update on wishlist_items
  for update using (is_admin()) with check (is_admin());

-- Authors may withdraw their own; admins may remove anything.
create policy wishlist_items_delete on wishlist_items
  for delete using (is_admin() or (is_active_user() and created_by = auth.uid()));

-- Votes: read all, cast and withdraw only your own.
create policy wishlist_votes_read on wishlist_votes
  for select using (is_active_user());

create policy wishlist_votes_insert on wishlist_votes
  for insert with check (is_active_user() and profile_id = auth.uid());

create policy wishlist_votes_delete on wishlist_votes
  for delete using (is_active_user() and profile_id = auth.uid());

-- Comments: read all, write as yourself, edit/remove your own (admins, any).
create policy wishlist_comments_read on wishlist_comments
  for select using (is_active_user());

create policy wishlist_comments_insert on wishlist_comments
  for insert with check (is_active_user() and created_by = auth.uid());

create policy wishlist_comments_update on wishlist_comments
  for update
  using (is_active_user() and created_by = auth.uid())
  with check (created_by = auth.uid());

create policy wishlist_comments_delete on wishlist_comments
  for delete using (is_admin() or (is_active_user() and created_by = auth.uid()));

-- ============================================================================
-- 2. Documents that arrive by hand
--
-- schema.sql assumed every deliverable comes from Airtable, so it required an
-- `airtable_record_id`. Documents will now also arrive two other ways: dragged
-- into the browser, and pulled from an Airtable attachment field. Both need a
-- row here before the reader has anything to read.
-- ============================================================================

create type deliverable_source as enum ('airtable', 'upload', 'box');

-- A deliverable hangs off a project, and `projects` is empty until the Airtable
-- sync runs. Without this, nobody can upload anything at all: there would be no
-- project to attach a document to. So a project may also be created by hand,
-- and reconciled with its Airtable record later by name.
alter table projects alter column airtable_record_id drop not null;

alter table projects
  add column if not exists created_by uuid references profiles(id),
  add column if not exists created_at timestamptz not null default now();

create policy projects_insert on projects
  for insert with check (
    is_active_user() and (created_by is null or created_by = auth.uid())
  );

-- Admins fix up a hand-made project once the real Airtable record turns up.
create policy projects_admin_update on projects
  for update using (is_admin()) with check (is_admin());

alter table deliverables
  add column if not exists source deliverable_source not null default 'airtable';

-- A hand-uploaded document has no Airtable record. Drop NOT NULL; the unique
-- constraint already tolerates multiple NULLs in Postgres, so Airtable-sourced
-- rows stay protected against double-ingest.
alter table deliverables alter column airtable_record_id drop not null;

-- Where the file itself sits. For 'upload' this is a Supabase Storage object
-- path; for 'airtable' the attachment URL it was fetched from. The document
-- itself is never stored in a column — only a pointer and the extracted values.
alter table deliverables
  add column if not exists storage_path text,
  add column if not exists original_filename text,
  add column if not exists uploaded_by uuid references profiles(id),
  add column if not exists uploaded_at timestamptz,
  add column if not exists byte_size bigint;

-- A row must be reachable somehow: from Airtable, from storage, or from Box.
-- `add constraint` has no IF NOT EXISTS, so guard it — this migration should
-- survive being run twice by someone who is not sure whether it took.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'deliverables_has_a_source'
      and conrelid = 'public.deliverables'::regclass
  ) then
    alter table deliverables
      add constraint deliverables_has_a_source check (
        airtable_record_id is not null
        or storage_path is not null
        or box_file_url is not null
      ) not valid;

    -- `not valid` skips existing rows so the migration cannot fail on data
    -- already in the table; validating separately takes a weaker lock.
    alter table deliverables validate constraint deliverables_has_a_source;
  end if;
end;
$$;

create index if not exists deliverables_source_idx on deliverables (source);
create index if not exists deliverables_uploaded_by_idx on deliverables (uploaded_by);

-- An estimator may add a document. Only admins may delete one, because a
-- deleted deliverable takes its extracted line items with it.
create policy deliverables_insert on deliverables
  for insert with check (
    is_active_user() and (uploaded_by is null or uploaded_by = auth.uid())
  );

-- ----------------------------------------------------------------------------
-- Storage bucket for hand-uploaded cost plans.
--
-- PRIVATE. A public bucket would put client cost plans on a guessable URL with
-- no sign-in at all, which is the single worst thing that could happen here.
-- Files are reached through short-lived signed URLs instead.
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'deliverables',
  'deliverables',
  false,
  52428800,                              -- 50 MB; cost plans are rarely bigger
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'text/csv'
  ]
)
on conflict (id) do nothing;

-- Any active member may add a document and read what is in the bucket. Only
-- admins may delete, for the same reason as deliverables: a removed file
-- orphans everything the reader extracted from it.
create policy deliverables_bucket_read on storage.objects
  for select using (bucket_id = 'deliverables' and is_active_user());

create policy deliverables_bucket_insert on storage.objects
  for insert with check (bucket_id = 'deliverables' and is_active_user());

create policy deliverables_bucket_delete on storage.objects
  for delete using (bucket_id = 'deliverables' and is_admin());

-- ============================================================================
-- 3. Verification
--
-- Run `001_verify.sql` (next to this file) in a NEW query once this succeeds.
-- It returns six rows; two of them — "v_wishlist invoker" and "bucket is
-- private" — must both read `true`. Either one false means data is reachable
-- that should not be.
-- ============================================================================
