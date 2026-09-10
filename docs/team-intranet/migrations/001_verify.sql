-- ============================================================================
-- Verification for migration 001 — run this AFTER the migration.
--
-- Supabase → SQL Editor → New query → paste all of this → Run.
-- Unlike the migration, this one returns rows. Read them.
--
-- Expected:
--
--   item                  value
--   --------------------  -----
--   wishlist tables       3
--   wishlist policies     12    (5 items + 3 votes + 4 comments)
--   v_wishlist invoker    true      <-- this one is not optional
--   deliverables columns  6
--   storage bucket        1
--   bucket is private     true      <-- nor is this one
--
-- If "v_wishlist invoker" is false, or "bucket is private" is false, STOP and
-- say so. Either one means data is reachable that should not be.
-- ============================================================================

select 'wishlist tables' as item, count(*)::text as value
  from information_schema.tables
 where table_schema = 'public'
   and table_name in ('wishlist_items', 'wishlist_votes', 'wishlist_comments')

union all
select 'wishlist policies', count(*)::text
  from pg_policies
 where schemaname = 'public' and tablename like 'wishlist%'

union all
-- A view without security_invoker runs with its OWNER's privileges, which means
-- it reads straight past every row-level security policy underneath it. This is
-- the single most important line in this file.
select 'v_wishlist invoker',
       coalesce(
         (select (c.reloptions::text like '%security_invoker=true%')::text
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname = 'v_wishlist'),
         'VIEW MISSING'
       )

union all
select 'deliverables columns', count(*)::text
  from information_schema.columns
 where table_schema = 'public' and table_name = 'deliverables'
   and column_name in ('source', 'storage_path', 'original_filename',
                       'uploaded_by', 'uploaded_at', 'byte_size')

union all
select 'storage bucket', count(*)::text
  from storage.buckets where id = 'deliverables'

union all
-- A public bucket would put client cost plans on a guessable URL with no
-- sign-in at all. This must be true.
select 'bucket is private',
       coalesce((select (not public)::text from storage.buckets where id = 'deliverables'),
                'BUCKET MISSING');
