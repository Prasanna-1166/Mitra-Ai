-- Server-side accounting and helpers. Everything here except search_conversations
-- is callable ONLY by the service role (used by the Edge Functions).

-- Prompts that count right now: finished or partially answered ones, plus
-- reservations younger than 5 minutes (a crashed relay cannot lock a user out).
create or replace function public.usage_count(p_user_id uuid, p_guest_session_id uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select count(*)::integer
    from public.usage_events e
   where (
           (p_user_id is not null and e.user_id = p_user_id
              and e.usage_day = (now() at time zone 'utc')::date)
        or (p_guest_session_id is not null and e.guest_session_id = p_guest_session_id)
         )
     and (e.status in ('completed', 'partial')
          or (e.status = 'reserved' and e.created_at > now() - interval '5 minutes'));
$$;

create or replace function public.get_usage(p_user_id uuid, p_guest_session_id uuid, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_used integer := public.usage_count(p_user_id, p_guest_session_id);
begin
  return jsonb_build_object(
    'used', v_used,
    'limit', p_limit,
    'remaining', greatest(p_limit - v_used, 0),
    -- daily allowances reset at the next UTC midnight; guest allowances do not reset
    'resetsAt', case when p_user_id is not null
      then to_jsonb((((now() at time zone 'utc')::date + 1)::timestamp at time zone 'utc'))
      else 'null'::jsonb end
  );
end;
$$;

-- Atomically check the allowance and reserve one prompt. The advisory lock
-- serialises concurrent requests of the same user / guest session, so two
-- simultaneous requests cannot both take the last unit.
create or replace function public.reserve_usage(
  p_request_id uuid, p_user_id uuid, p_guest_session_id uuid, p_limit integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_subject text;
begin
  if (p_user_id is null) = (p_guest_session_id is null) then
    raise exception 'exactly one of user or guest session is required';
  end if;
  if p_limit is null or p_limit < 0 then
    raise exception 'invalid limit';
  end if;
  v_subject := coalesce(p_user_id::text, 'guest:' || p_guest_session_id::text);
  perform pg_advisory_xact_lock(hashtextextended(v_subject, 0));

  if exists (select 1 from public.usage_events where request_id = p_request_id) then
    return jsonb_build_object('allowed', false, 'duplicate', true,
      'usage', public.get_usage(p_user_id, p_guest_session_id, p_limit));
  end if;

  if public.usage_count(p_user_id, p_guest_session_id) >= p_limit then
    return jsonb_build_object('allowed', false,
      'usage', public.get_usage(p_user_id, p_guest_session_id, p_limit));
  end if;

  insert into public.usage_events (request_id, user_id, guest_session_id, status)
  values (p_request_id, p_user_id, p_guest_session_id, 'reserved');

  return jsonb_build_object('allowed', true,
    'usage', public.get_usage(p_user_id, p_guest_session_id, p_limit));
end;
$$;

-- reserved -> completed | partial (charged) or failed | cancelled (released)
create or replace function public.finalize_usage(p_request_id uuid, p_status text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('completed', 'partial', 'failed', 'cancelled') then
    raise exception 'invalid status';
  end if;
  update public.usage_events
     set status = p_status, updated_at = now()
   where request_id = p_request_id and status = 'reserved';
  return found;
end;
$$;

-- Fixed-window rate limiter. Returns true while the subject is within p_max hits.
create or replace function public.rate_limit_hit(p_subject text, p_window_seconds integer, p_max integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_start timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_hits integer;
begin
  insert into public.rate_limits as r (subject, window_start, hits)
  values (p_subject, v_start, 1)
  on conflict (subject, window_start) do update set hits = r.hits + 1
  returning r.hits into v_hits;
  return v_hits <= p_max;
end;
$$;

-- Housekeeping. Call from pg_cron or let the ticket function call it opportunistically.
create or replace function public.purge_expired()
returns void language sql security definer set search_path = '' as $$
  delete from public.chat_tickets where expires_at < now() - interval '1 hour';
  delete from public.rate_limits where window_start < now() - interval '2 days';
  delete from public.guest_sessions where expires_at < now();
$$;

revoke all on function public.usage_count(uuid, uuid) from public, anon, authenticated;
revoke all on function public.get_usage(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.reserve_usage(uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.finalize_usage(uuid, text) from public, anon, authenticated;
revoke all on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
revoke all on function public.purge_expired() from public, anon, authenticated;
grant execute on function public.usage_count(uuid, uuid) to service_role;
grant execute on function public.get_usage(uuid, uuid, integer) to service_role;
grant execute on function public.reserve_usage(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.finalize_usage(uuid, text) to service_role;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;
grant execute on function public.purge_expired() to service_role;

-- Search the caller's own conversations by title or message text.
-- SECURITY INVOKER: row-level security applies, so only the caller's rows match.
create or replace function public.search_conversations(p_query text, p_limit integer default 50)
returns setof uuid language sql stable security invoker set search_path = '' as $$
  with q as (
    select '%' || replace(replace(replace(trim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat
  )
  select c.id
    from public.conversations c, q
   where char_length(trim(p_query)) > 0
     and (c.title ilike q.pat
          or exists (select 1 from public.messages m
                      where m.conversation_id = c.id and m.content ilike q.pat))
   order by c.updated_at desc
   limit least(greatest(p_limit, 1), 100);
$$;
revoke all on function public.search_conversations(text, integer) from public, anon;
grant execute on function public.search_conversations(text, integer) to authenticated;
