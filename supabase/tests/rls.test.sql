-- pgTAP tests: cross-account isolation, column locks and usage accounting.
-- Run with:  supabase test db        (requires the local Supabase stack)
-- NOT executed in the environment this repository was authored in.
begin;
create extension if not exists pgtap with schema extensions;
select plan(46);

-- two users and one guest session
insert into auth.users (id, email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a@example.test'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'b@example.test');
insert into public.guest_sessions (id, token_hash, expires_at)
  values ('99999999-9999-4999-8999-999999999999', 'hash-g', now() + interval '1 day');

-- ---------------------------------------------------------------- user A
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}', true);

select lives_ok($$insert into public.conversations (id, user_id, title) values ('c1111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'A secret plan')$$, 'A can create a conversation');
select lives_ok($$insert into public.messages (conversation_id, user_id, client_id, role, content) values ('c1111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'd1111111-1111-4111-8111-111111111111', 'user', 'hello from A')$$, 'A can add a message');
select lives_ok($$insert into public.user_memories (id, user_id, content) values ('e1111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'A prefers Python')$$, 'A can create a memory');
select lives_ok($$insert into public.user_settings (user_id, response_depth) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'detailed')$$, 'A can create settings');

select throws_ok($$update public.conversations set user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' where id = 'c1111111-1111-4111-8111-111111111111'$$, '42501', null, 'A cannot transfer ownership of a conversation (column grant)');
select throws_ok($$update public.conversations set updated_at = now() where id = 'c1111111-1111-4111-8111-111111111111'$$, '42501', null, 'A cannot edit server-managed conversation columns');
select throws_ok($$update public.messages set content = 'edited' where conversation_id = 'c1111111-1111-4111-8111-111111111111'$$, '42501', null, 'messages are not editable by clients');
select lives_ok($$update public.conversations set title = 'Renamed', title_source = 'user' where id = 'c1111111-1111-4111-8111-111111111111'$$, 'A can rename their conversation');
select throws_ok($$insert into public.user_memories (user_id, content) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', repeat('x', 501))$$, '23514', null, 'memory length is bounded');
select throws_ok($$insert into public.messages (conversation_id, user_id, role, content) values ('c1111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'system', 'x')$$, '23514', null, 'only user/assistant roles are allowed');
select is((select count(*)::int from public.search_conversations('secret')), 1, 'A finds their own conversation by title');
select is((select count(*)::int from public.search_conversations('hello from')), 1, 'A finds their own conversation by message text');
select is((select count(*)::int from public.search_conversations('%')), 0, 'LIKE wildcards in the query are escaped');

-- ---------------------------------------------------------------- user B
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated"}', true);

select is((select count(*)::int from public.conversations), 0, 'B sees none of A''s conversations');
select is((select count(*)::int from public.messages), 0, 'B sees none of A''s messages');
select is((select count(*)::int from public.user_memories), 0, 'B sees none of A''s memories');
select is((select count(*)::int from public.user_settings), 0, 'B sees none of A''s settings');
select is((select count(*)::int from public.search_conversations('secret')), 0, 'B cannot find A''s conversation by searching');

select throws_ok($$insert into public.conversations (user_id, title) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'forged')$$, '42501', null, 'B cannot create a conversation owned by A');
select throws_ok($$insert into public.messages (conversation_id, user_id, role, content) values ('c1111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'user', 'forged')$$, '42501', null, 'B cannot add a message as A');
select throws_ok($$insert into public.messages (conversation_id, user_id, role, content) values ('c1111111-1111-4111-8111-111111111111', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'user', 'injected')$$, '23503', null, 'B cannot add a message to A''s conversation under their own id (composite FK)');
select throws_ok($$insert into public.user_memories (user_id, content) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'forged memory')$$, '42501', null, 'B cannot create a memory for A');

with u as (update public.conversations set title = 'hacked' where id = 'c1111111-1111-4111-8111-111111111111' returning 1)
select is((select count(*)::int from u), 0, 'B''s update of A''s conversation affects no rows');
with d as (delete from public.conversations where id = 'c1111111-1111-4111-8111-111111111111' returning 1)
select is((select count(*)::int from d), 0, 'B''s delete of A''s conversation affects no rows');
with d as (delete from public.messages where conversation_id = 'c1111111-1111-4111-8111-111111111111' returning 1)
select is((select count(*)::int from d), 0, 'B''s delete of A''s messages affects no rows');
with u as (update public.user_memories set enabled = false where id = 'e1111111-1111-4111-8111-111111111111' returning 1)
select is((select count(*)::int from u), 0, 'B cannot change A''s memory');
with d as (delete from public.user_memories where id = 'e1111111-1111-4111-8111-111111111111' returning 1)
select is((select count(*)::int from d), 0, 'B cannot delete A''s memory');

-- server-only objects are unreachable for signed-in users
select throws_ok($$select * from public.guest_sessions$$, '42501', null, 'authenticated cannot read guest_sessions');
select throws_ok($$select * from public.chat_tickets$$, '42501', null, 'authenticated cannot read chat_tickets');
select throws_ok($$insert into public.usage_events (request_id, user_id, status) values (gen_random_uuid(), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'completed')$$, '42501', null, 'authenticated cannot write usage records');
select throws_ok($$select public.reserve_usage(gen_random_uuid(), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', null, 1000000)$$, '42501', null, 'authenticated cannot call reserve_usage');

-- ------------------------------------------------------------------ anon
reset role;
set local role anon;
select throws_ok($$select * from public.conversations$$, '42501', null, 'anon cannot read conversations');
select throws_ok($$select * from public.user_memories$$, '42501', null, 'anon cannot read memories');

-- ------------------------------------------------- A still has their data
reset role;
select is((select count(*)::int from public.conversations where id = 'c1111111-1111-4111-8111-111111111111' and title = 'Renamed'), 1, 'A''s conversation survived B''s attempts unchanged');
select is((select count(*)::int from public.messages where conversation_id = 'c1111111-1111-4111-8111-111111111111'), 1, 'A''s message survived');

-- ------------------------------------------- usage accounting (service role)
select is((select (public.reserve_usage('10000000-0000-4000-8000-000000000001', null, '99999999-9999-4999-8999-999999999999', 5))->>'allowed'), 'true', 'guest: first reservation is allowed');
select public.finalize_usage('10000000-0000-4000-8000-000000000001', 'completed');
select is((public.get_usage(null, '99999999-9999-4999-8999-999999999999', 5))->>'remaining', '4', 'guest: one prompt used, four remain');

select is((public.reserve_usage('10000000-0000-4000-8000-000000000001', null, '99999999-9999-4999-8999-999999999999', 5))->>'duplicate', 'true', 'a repeated request id is rejected as a duplicate');

-- a failed request is released and does not use the allowance
select public.reserve_usage('10000000-0000-4000-8000-000000000002', null, '99999999-9999-4999-8999-999999999999', 5);
select public.finalize_usage('10000000-0000-4000-8000-000000000002', 'failed');
select is((public.get_usage(null, '99999999-9999-4999-8999-999999999999', 5))->>'used', '1', 'a failed request does not consume allowance');

-- fill the allowance: the sixth prompt is refused
select public.reserve_usage(('10000000-0000-4000-8000-00000000001' || g)::uuid, null, '99999999-9999-4999-8999-999999999999', 5) from generate_series(1, 4) g;
select is((public.reserve_usage('10000000-0000-4000-8000-000000000099', null, '99999999-9999-4999-8999-999999999999', 5))->>'allowed', 'false', 'guest: the sixth reservation is refused');

-- an authenticated user has an independent daily allowance
select is((public.reserve_usage('20000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', null, 100))->>'allowed', 'true', 'user: reservation allowed');
select is((public.get_usage('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', null, 100))->>'limit', '100', 'user: daily limit is the configured value');

-- deleting the user removes everything they own
delete from auth.users where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
select is((select count(*)::int from public.conversations where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 0, 'account deletion cascades to conversations');
select is((select count(*)::int from public.messages where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 0, 'account deletion cascades to messages');
select is((select count(*)::int from public.user_memories where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 0, 'account deletion cascades to memories');
select is((select count(*)::int from public.usage_events where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 0, 'account deletion cascades to usage records');

select * from finish();
rollback;
