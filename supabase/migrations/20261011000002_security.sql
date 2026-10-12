-- Row-level security, grants and policies.
-- Client roles get only what the browser genuinely needs; everything else goes
-- through the Edge Functions, which use the service role.

alter table public.conversations   enable row level security;
alter table public.messages        enable row level security;
alter table public.user_memories   enable row level security;
alter table public.user_settings   enable row level security;
alter table public.usage_events    enable row level security;
alter table public.guest_sessions  enable row level security;
alter table public.chat_tickets    enable row level security;
alter table public.rate_limits     enable row level security;

-- Start from nothing, then grant narrowly (Supabase's default privileges would
-- otherwise hand anon/authenticated full table access).
revoke all on public.conversations, public.messages, public.user_memories,
  public.user_settings, public.usage_events, public.guest_sessions,
  public.chat_tickets, public.rate_limits from anon, authenticated;

-- conversations: the owner can read, create and delete; only the title can be edited
grant select, insert, delete on public.conversations to authenticated;
grant update (title, title_source) on public.conversations to authenticated;

create policy conversations_select on public.conversations
  for select to authenticated using (user_id = (select auth.uid()));
create policy conversations_insert on public.conversations
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy conversations_update on public.conversations
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy conversations_delete on public.conversations
  for delete to authenticated using (user_id = (select auth.uid()));

-- messages: read, add (guest-history import) and delete; never edited.
-- The composite foreign key additionally forces the conversation to be the owner's.
grant select, insert, delete on public.messages to authenticated;

create policy messages_select on public.messages
  for select to authenticated using (user_id = (select auth.uid()));
create policy messages_insert on public.messages
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy messages_delete on public.messages
  for delete to authenticated using (user_id = (select auth.uid()));

-- user_memories
grant select, insert, delete on public.user_memories to authenticated;
grant update (content, category, enabled) on public.user_memories to authenticated;

create policy memories_select on public.user_memories
  for select to authenticated using (user_id = (select auth.uid()));
create policy memories_insert on public.user_memories
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy memories_update on public.user_memories
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy memories_delete on public.user_memories
  for delete to authenticated using (user_id = (select auth.uid()));

-- user_settings
grant select, insert on public.user_settings to authenticated;
grant update (response_depth, memory_enabled, auto_memory) on public.user_settings to authenticated;

create policy settings_select on public.user_settings
  for select to authenticated using (user_id = (select auth.uid()));
create policy settings_insert on public.user_settings
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy settings_update on public.user_settings
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- usage_events: read-only for the owner (so the UI could show history); written by the relay only
grant select on public.usage_events to authenticated;
create policy usage_select on public.usage_events
  for select to authenticated using (user_id = (select auth.uid()));

-- guest_sessions, chat_tickets, rate_limits: no grants and no policies for client roles.
