-- Mitra AI: user profiles and avatar storage
-- Additive migration: creates public.profiles, auto-creation triggers, RLS, and avatar storage policies.

-- --------------------------------------------------------------- profiles table
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or (char_length(trim(display_name)) between 1 and 60)),
  avatar_url text check (avatar_url is null or char_length(avatar_url) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists profiles_id_idx on public.profiles (id);

-- Guard against changing profile id
create or replace function public.prevent_profile_id_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.id is distinct from old.id then
    raise exception 'profile id cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_updated on public.profiles;
create trigger profiles_updated before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists profiles_id_guard on public.profiles;
create trigger profiles_id_guard before update on public.profiles
  for each row execute function public.prevent_profile_id_change();

-- --------------------------------------------------------------- RLS & grants
alter table public.profiles enable row level security;

revoke all on public.profiles from anon, authenticated;
grant select, insert on public.profiles to authenticated;
grant update (display_name, avatar_url) on public.profiles to authenticated;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated using (id = (select auth.uid()));

drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert to authenticated with check (id = (select auth.uid()));

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- --------------------------------------------------------------- auto-create trigger
-- Automatically create profile row when a new user registers in auth.users
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
begin
  v_name := coalesce(
    trim(new.raw_user_meta_data->>'display_name'),
    trim(new.raw_user_meta_data->>'name'),
    split_part(new.email, '@', 1)
  );
  if char_length(v_name) > 60 then
    v_name := substr(v_name, 1, 60);
  end if;
  if char_length(v_name) = 0 then
    v_name := 'User';
  end if;

  insert into public.profiles (id, display_name)
  values (new.id, v_name)
  on conflict (id) do nothing;

  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Safe backfill for any existing users
insert into public.profiles (id, display_name)
select
  u.id,
  case
    when char_length(coalesce(u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1))) between 1 and 60
    then coalesce(u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1))
    else 'User'
  end
from auth.users u
on conflict (id) do nothing;

-- --------------------------------------------------------------- storage configuration
-- Configure private avatars storage bucket and RLS policies if storage schema exists
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    -- Ensure avatars bucket exists and is private
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'avatars',
      'avatars',
      false,
      2097152, -- 2 MB
      array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
    )
    on conflict (id) do update set
      public = false,
      file_size_limit = 2097152,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

    -- Policies on storage.objects scoped strictly to the authenticated user's folder (<user_id>/<file>)
    drop policy if exists "Users can upload their own avatar" on storage.objects;
    create policy "Users can upload their own avatar"
      on storage.objects for insert to authenticated
      with check (
        bucket_id = 'avatars'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      );

    drop policy if exists "Users can update their own avatar" on storage.objects;
    create policy "Users can update their own avatar"
      on storage.objects for update to authenticated
      using (
        bucket_id = 'avatars'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      );

    drop policy if exists "Users can read their own avatar" on storage.objects;
    create policy "Users can read their own avatar"
      on storage.objects for select to authenticated
      using (
        bucket_id = 'avatars'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      );

    drop policy if exists "Users can delete their own avatar" on storage.objects;
    create policy "Users can delete their own avatar"
      on storage.objects for delete to authenticated
      using (
        bucket_id = 'avatars'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      );
  end if;
end;
$$;
