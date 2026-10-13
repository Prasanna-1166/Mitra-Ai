-- MANUAL rollback for 20261012000001_profiles_avatars.sql (not run automatically).
-- 1. Empty the bucket first with the Storage API or dashboard: Postgres cannot delete
--    stored files, and a bucket that still has objects cannot be dropped.
-- 2. Then run this. Profiles (display names, avatar paths) are lost; auth users,
--    conversations, memories and settings are untouched.
drop policy if exists avatars_select_own on storage.objects;
drop policy if exists avatars_insert_own on storage.objects;
drop policy if exists avatars_update_own on storage.objects;
drop policy if exists avatars_delete_own on storage.objects;
delete from storage.buckets where id = 'avatars';
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();
drop table if exists public.profiles;
