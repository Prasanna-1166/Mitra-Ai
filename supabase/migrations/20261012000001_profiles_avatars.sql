-- Profiles and private avatar storage. Additive: nothing existing is altered.
-- Source of truth: public.profiles holds display name + avatar for the app UI.
-- Authentication data (email, confirmation, created_at) stays in auth.users and is
-- never copied here; app preferences stay in public.user_settings.

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (
    display_name is null
    or (char_length(display_name) between 1 and 50 and display_name !~ '[[:cntrl:]]')
  ),
  -- storage object path inside the private "avatars" bucket: <user_id>/<uuid>.<ext>
  avatar_path text check (
    avatar_path is null
    or (avatar_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$'
        and split_part(avatar_path, '/', 1) = user_id::text)
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_updated before update on public.profiles
  for each row execute function public.set_updated_at();
create trigger profiles_owner_guard before update on public.profiles
  for each row execute function public.prevent_owner_change();

-- Create a profile for every new account. Idempotent, and it must never make
-- sign-up fail: any problem is logged as a warning and the client recovers by
-- creating the row itself (row-level security allows exactly that).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
begin
  begin
    v_name := nullif(btrim(regexp_replace(coalesce(new.raw_user_meta_data ->> 'display_name', ''), '[[:cntrl:]]+', ' ', 'g')), '');
    if v_name is not null then
      v_name := left(v_name, 50);
    end if;
    insert into public.profiles (user_id, display_name)
    values (new.id, v_name)
    on conflict (user_id) do nothing;
  exception when others then
    raise warning 'profile creation skipped for new user: %', sqlerrm;
  end;
  return new;
end;
$$;
revoke all on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill accounts that existed before this migration.
insert into public.profiles (user_id)
select id from auth.users
on conflict (user_id) do nothing;

-- Row-level security: owner only. No DELETE for clients (rows go away with the account).
alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;
grant select, insert (user_id, display_name, avatar_path) on public.profiles to authenticated;
grant update (display_name, avatar_path) on public.profiles to authenticated;

create policy profiles_select on public.profiles
  for select to authenticated using (user_id = (select auth.uid()));
create policy profiles_insert on public.profiles
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy profiles_update on public.profiles
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ------------------------------------------------------------------ storage
-- Private bucket (no public URLs; the app uses short-lived signed URLs),
-- 2 MB per file, images only. The browser also re-encodes images before upload.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 2097152, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Users may only touch objects inside their own folder: avatars/<their user id>/...
create policy avatars_select_own on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy avatars_insert_own on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy avatars_update_own on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy avatars_delete_own on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
