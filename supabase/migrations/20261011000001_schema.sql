-- Mitra AI: core schema. Row-level security and grants are in the next migration.

-- ---------------------------------------------------------------- helpers
create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.prevent_owner_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'user_id cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------- conversations
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null default 'New chat' check (char_length(title) between 1 and 120),
  title_source text not null default 'default' check (title_source in ('default', 'auto', 'user')),
  -- id of the guest-side conversation this one was imported from (idempotent imports)
  import_key text check (import_key is null or char_length(import_key) <= 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz,
  unique (id, user_id),
  unique (user_id, import_key)
);
create index conversations_user_recent_idx on public.conversations (user_id, updated_at desc);

create trigger conversations_owner_guard before update on public.conversations
  for each row execute function public.prevent_owner_change();

-- --------------------------------------------------------------- messages
-- seq gives a stable total order even when created_at values tie or are imported.
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  conversation_id uuid not null,
  user_id uuid not null,
  -- id chosen by the client (or relay) so retries and imports are idempotent
  client_id uuid,
  role text not null check (role in ('user', 'assistant')),
  content text not null default '' check (char_length(content) <= 60000),
  status text not null default 'complete' check (status in ('complete', 'error', 'stopped')),
  error text check (error is null or char_length(error) <= 300),
  created_at timestamptz not null default now(),
  -- the message owner must be the conversation owner, whatever the policies say
  foreign key (conversation_id, user_id)
    references public.conversations (id, user_id) on delete cascade,
  unique (conversation_id, client_id),
  check (role = 'assistant' or status = 'complete')
);
create index messages_conversation_seq_idx on public.messages (conversation_id, seq desc);

create or replace function public.touch_conversation_on_message()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.conversations
     set updated_at = now(), last_message_at = now()
   where id = new.conversation_id;
  return new;
end;
$$;
revoke all on function public.touch_conversation_on_message() from public, anon, authenticated;

create trigger messages_touch_conversation after insert on public.messages
  for each row execute function public.touch_conversation_on_message();

-- ---------------------------------------------------------------- memory
create table public.user_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  content text not null check (char_length(content) between 1 and 500),
  category text not null default 'other'
    check (category in ('preference', 'project', 'tool', 'fact', 'other')),
  source text not null default 'user' check (source in ('user', 'explicit', 'suggested')),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index user_memories_user_idx on public.user_memories (user_id, created_at desc);

create trigger user_memories_updated before update on public.user_memories
  for each row execute function public.set_updated_at();
create trigger user_memories_owner_guard before update on public.user_memories
  for each row execute function public.prevent_owner_change();

create or replace function public.enforce_memory_limit()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (select count(*) from public.user_memories where user_id = new.user_id) >= 200 then
    raise exception 'memory limit reached (200 items)' using errcode = '54000';
  end if;
  return new;
end;
$$;
create trigger user_memories_limit before insert on public.user_memories
  for each row execute function public.enforce_memory_limit();

-- --------------------------------------------------------------- settings
create table public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  response_depth text not null default 'balanced'
    check (response_depth in ('concise', 'balanced', 'detailed')),
  memory_enabled boolean not null default true,
  auto_memory boolean not null default true,
  updated_at timestamptz not null default now()
);
create trigger user_settings_updated before update on public.user_settings
  for each row execute function public.set_updated_at();

-- ------------------------------------------- guests, tickets, usage, limits
-- Server-only tables: RLS is enabled and NO policy is created for client roles.
create table public.guest_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now()
);

create table public.chat_tickets (
  token_hash text primary key,
  user_id uuid references auth.users (id) on delete cascade,
  guest_session_id uuid references public.guest_sessions (id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  check ((user_id is not null) <> (guest_session_id is not null))
);
create index chat_tickets_expiry_idx on public.chat_tickets (expires_at);

create table public.usage_events (
  request_id uuid primary key,
  user_id uuid references auth.users (id) on delete cascade,
  guest_session_id uuid references public.guest_sessions (id) on delete cascade,
  -- reserved = in flight; completed/partial = counted; failed/cancelled = released
  status text not null check (status in ('reserved', 'completed', 'partial', 'failed', 'cancelled')),
  usage_day date not null default ((now() at time zone 'utc')::date),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((user_id is not null) <> (guest_session_id is not null))
);
create index usage_events_user_day_idx on public.usage_events (user_id, usage_day)
  where user_id is not null;
create index usage_events_guest_idx on public.usage_events (guest_session_id)
  where guest_session_id is not null;

create table public.rate_limits (
  subject text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (subject, window_start)
);
