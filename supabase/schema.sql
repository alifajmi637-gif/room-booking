-- Meeting room booking schema.
-- Run once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
--
-- Security model: the browser only ever holds the public anon key, so EVERY rule
-- that matters is enforced here in Postgres (RLS + grants + constraints + triggers),
-- never in the frontend. Admin status lives in a table clients can't read or write;
-- admin actions go through functions that re-check it on every call.

create extension if not exists btree_gist;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.admins (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now(),
  added_by uuid references auth.users(id) on delete set null
);

-- Single-row table of booking rules that admins can tune from the app.
create table if not exists public.settings (
  id                    boolean primary key default true check (id),
  timezone              text     not null default 'Asia/Kuala_Lumpur',
  open_hour             smallint not null default 7  check (open_hour between 0 and 23),
  close_hour            smallint not null default 21 check (close_hour between 1 and 24),
  max_duration_minutes  int      not null default 480
                          check (max_duration_minutes between 15 and 1440 and max_duration_minutes % 15 = 0),
  max_days_ahead        int      not null default 90  check (max_days_ahead between 1 and 365),
  max_upcoming_per_user int      not null default 20  check (max_upcoming_per_user between 1 and 500),
  constraint open_before_close check (close_hour > open_hour)
);
insert into public.settings default values on conflict do nothing;

create table if not exists public.rooms (
  id         smallint generated always as identity primary key,
  name       text not null unique check (char_length(btrim(name)) between 1 and 60
                                         and name !~ '[[:cntrl:]]'),
  capacity   smallint not null check (capacity between 1 and 500),
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.bookings (
  id         uuid primary key default gen_random_uuid(),
  -- restrict: a room with booking history can't be deleted, only deactivated.
  room_id    smallint not null references public.rooms(id) on delete restrict,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title      text not null check (char_length(btrim(title)) between 1 and 100
                                  and title !~ '[[:cntrl:]]'),
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  created_at timestamptz not null default now(),

  constraint ends_after_start   check (ends_at > starts_at),
  constraint max_24_hours       check (ends_at - starts_at <= interval '24 hours'),
  constraint min_5_minutes      check (ends_at - starts_at >= interval '5 minutes'),
  constraint whole_minutes      check (
    extract(epoch from starts_at) % 60 = 0 and extract(epoch from ends_at) % 60 = 0
  ),
  -- Race-proof double-booking prevention: two concurrent inserts can't both win.
  constraint no_overlap exclude using gist (
    room_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  )
);

create index if not exists bookings_user_idx   on public.bookings (user_id);
create index if not exists bookings_starts_idx on public.bookings (starts_at);

-- Append-only record of every change. Only written by triggers, only read by admins.
create table if not exists public.audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor      uuid,  -- no FK: keep history even after the user is deleted
  action     text not null,
  table_name text not null,
  row_id     text,
  old_data   jsonb,
  new_data   jsonb
);
create index if not exists audit_log_at_idx on public.audit_log (at desc);

-- Upgrade databases created from the first version of this file. Harmless on a
-- fresh install, so the whole file can always be re-run.
alter table public.rooms add column if not exists created_at timestamptz not null default now();
alter table public.rooms drop constraint if exists rooms_name_check;
alter table public.rooms add constraint rooms_name_check
  check (char_length(btrim(name)) between 1 and 60 and name !~ '[[:cntrl:]]');
alter table public.bookings drop constraint if exists max_8_hours;
alter table public.bookings drop constraint if exists max_24_hours;
alter table public.bookings add constraint max_24_hours
  check (ends_at - starts_at <= interval '24 hours');
alter table public.rooms    no force row level security;
alter table public.bookings no force row level security;
drop policy if exists bookings_delete_own_future on public.bookings;
-- Minute-precision bookings (was: 15-minute slots, 15-minute minimum).
alter table public.bookings drop constraint if exists quarter_hour_slots;
alter table public.bookings drop constraint if exists min_15_minutes;
alter table public.bookings drop constraint if exists whole_minutes;
alter table public.bookings drop constraint if exists min_5_minutes;
alter table public.bookings add constraint whole_minutes
  check (extract(epoch from starts_at) % 60 = 0 and extract(epoch from ends_at) % 60 = 0);
alter table public.bookings add constraint min_5_minutes
  check (ends_at - starts_at >= interval '5 minutes');

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Definer so it can read admins, which clients have no access to.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;

create or replace function public.require_admin()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Booking rules that need now(), settings or counting (can't be CHECK constraints)
-- ---------------------------------------------------------------------------

create or replace function public.enforce_booking_rules()
returns trigger
language plpgsql
security invoker  -- runs as the signed-in user, so RLS still applies inside
set search_path = ''
as $$
declare
  s            public.settings;
  admin        boolean := public.is_admin();
  local_start  timestamp;
  local_end    timestamp;
  active_count int;
begin
  -- Never trust a client-supplied owner or timestamp.
  new.user_id    := auth.uid();
  new.created_at := now();

  if new.user_id is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  -- Named columns only: clients can't read display_key_hash (and don't need to).
  select st.timezone, st.open_hour, st.close_hour, st.max_duration_minutes, st.max_days_ahead,
         st.max_upcoming_per_user
    into strict s.timezone, s.open_hour, s.close_hour, s.max_duration_minutes, s.max_days_ahead,
         s.max_upcoming_per_user
    from public.settings st;

  if new.starts_at < now() then
    raise exception 'Cannot book in the past' using errcode = '22023';
  end if;

  if not exists (select 1 from public.rooms r where r.id = new.room_id and r.is_active) then
    raise exception 'Room is not available' using errcode = '22023';
  end if;

  -- Opening hours apply to everyone, in the organisation's timezone.
  local_start := new.starts_at at time zone s.timezone;
  local_end   := new.ends_at   at time zone s.timezone;
  if local_start < local_start::date + make_interval(hours => s.open_hour)
     or local_end > local_start::date + make_interval(hours => s.close_hour) then
    raise exception 'Bookings must be between %:00 and %:00', s.open_hour, s.close_hour
      using errcode = '22023';
  end if;

  -- Admins can override the remaining limits (e.g. block a room for a long event).
  if admin then
    return new;
  end if;

  if new.ends_at - new.starts_at > make_interval(mins => s.max_duration_minutes) then
    raise exception 'Bookings can be at most % minutes', s.max_duration_minutes using errcode = '22023';
  end if;

  if new.starts_at > now() + make_interval(days => s.max_days_ahead) then
    raise exception 'Bookings can be made at most % days ahead', s.max_days_ahead using errcode = '22023';
  end if;

  -- Per-user cap. Serialise this user's inserts so parallel requests can't sneak past it.
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));
  select count(*) into active_count
    from public.bookings b
   where b.user_id = new.user_id and b.ends_at > now();
  if active_count >= s.max_upcoming_per_user then
    raise exception 'You already have % upcoming bookings', active_count using errcode = '22023';
  end if;

  return new;
end;
$$;

drop trigger if exists bookings_rules on public.bookings;
create trigger bookings_rules
  before insert on public.bookings
  for each row execute function public.enforce_booking_rules();

create or replace function public.validate_settings()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform now() at time zone new.timezone;  -- raises on an unknown timezone
  return new;
exception when others then
  raise exception 'Unknown timezone: %', new.timezone using errcode = '22023';
end;
$$;

drop trigger if exists settings_validate on public.settings;
create trigger settings_validate
  before update on public.settings
  for each row execute function public.validate_settings();

-- ---------------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------------

create or replace function public.audit()
returns trigger
language plpgsql
security definer  -- clients have no access to audit_log
set search_path = ''
as $$
declare
  r jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
  insert into public.audit_log (actor, action, table_name, row_id, old_data, new_data)
  values (
    auth.uid(), tg_op, tg_table_name, coalesce(r ->> 'id', r ->> 'user_id'),
    case when tg_op <> 'INSERT' then to_jsonb(old) end,
    case when tg_op <> 'DELETE' then to_jsonb(new) end
  );
  return null;
end;
$$;

drop trigger if exists audit_bookings on public.bookings;
create trigger audit_bookings after insert or delete on public.bookings
  for each row execute function public.audit();
drop trigger if exists audit_rooms on public.rooms;
create trigger audit_rooms after insert or update or delete on public.rooms
  for each row execute function public.audit();
drop trigger if exists audit_settings on public.settings;
create trigger audit_settings after update on public.settings
  for each row execute function public.audit();
drop trigger if exists audit_admins on public.admins;
create trigger audit_admins after insert or delete on public.admins
  for each row execute function public.audit();

-- ---------------------------------------------------------------------------
-- Admin functions (each one re-checks admin status itself)
-- ---------------------------------------------------------------------------

create or replace function public.admin_list_admins()
returns table (user_id uuid, email text, added_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_admin();
  return query
    select a.user_id, u.email::text, a.added_at
      from public.admins a join auth.users u on u.id = a.user_id
     order by a.added_at;
end;
$$;

create or replace function public.admin_add(p_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target uuid;
begin
  perform public.require_admin();
  select u.id into target from auth.users u where lower(u.email) = lower(btrim(p_email));
  if target is null then
    raise exception 'No user with that email. They need to sign in once first.' using errcode = '22023';
  end if;
  insert into public.admins (user_id, added_by) values (target, auth.uid())
  on conflict (user_id) do nothing;
end;
$$;

create or replace function public.admin_remove(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_admin();
  -- Serialise removals so two admins can't remove each other at the same moment.
  perform pg_advisory_xact_lock(hashtextextended('admins', 0));
  if (select count(*) from public.admins) <= 1 then
    raise exception 'Cannot remove the last admin' using errcode = '22023';
  end if;
  delete from public.admins where user_id = p_user_id;
end;
$$;

-- Who made each booking (emails are private, so admins only).
create or replace function public.admin_booking_owners(p_ids uuid[])
returns table (id uuid, email text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_admin();
  if cardinality(p_ids) > 500 then
    raise exception 'Too many ids' using errcode = '22023';
  end if;
  return query
    select b.id, u.email::text
      from public.bookings b join auth.users u on u.id = b.user_id
     where b.id = any (p_ids);
end;
$$;

create or replace function public.admin_audit_log(p_limit int default 50)
returns table (at timestamptz, email text, action text, table_name text, row_id text,
               old_data jsonb, new_data jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_admin();
  return query
    select l.at, u.email::text, l.action, l.table_name, l.row_id, l.old_data, l.new_data
      from public.audit_log l left join auth.users u on u.id = l.actor
     order by l.at desc
     limit least(greatest(p_limit, 1), 200);
end;
$$;

-- ---------------------------------------------------------------------------
-- Lobby display: a no-login page showing today's occupancy. It works only with
-- a secret key (in the link after #, so it never reaches GitHub). Only the key's
-- SHA-256 hash is stored. It returns rooms and busy times, never titles or people.
-- ---------------------------------------------------------------------------

alter table public.settings add column if not exists display_key_hash text;

create or replace function public.display_today(p_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s         public.settings;
  day_start timestamptz;
begin
  select * into strict s from public.settings;
  if s.display_key_hash is null or p_key is null or length(p_key) < 32
     or encode(extensions.digest(p_key, 'sha256'), 'hex') <> s.display_key_hash then
    raise exception 'Invalid display link' using errcode = '42501';
  end if;

  -- Midnight today in the organisation's timezone.
  day_start := ((now() at time zone s.timezone)::date)::timestamp at time zone s.timezone;

  return jsonb_build_object(
    'timezone', s.timezone,
    'open_hour', s.open_hour,
    'close_hour', s.close_hour,
    'rooms', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'capacity', r.capacity) order by r.name)
        from public.rooms r where r.is_active), '[]'::jsonb),
    'bookings', coalesce((
      select jsonb_agg(jsonb_build_object('room_id', b.room_id, 'starts_at', b.starts_at, 'ends_at', b.ends_at)
                       order by b.starts_at)
        from public.bookings b join public.rooms r on r.id = b.room_id and r.is_active
       where b.starts_at < day_start + interval '1 day' and b.ends_at > day_start), '[]'::jsonb)
  );
end;
$$;

-- Makes a new display key (the old link stops working) and returns it once.
create or replace function public.admin_rotate_display_key()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  k text;
begin
  perform public.require_admin();
  k := encode(extensions.gen_random_bytes(24), 'hex');
  update public.settings set display_key_hash = encode(extensions.digest(k, 'sha256'), 'hex') where id;
  return k;
end;
$$;

create or replace function public.admin_disable_display()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_admin();
  update public.settings set display_key_hash = null where id;  -- Supabase requires a WHERE
end;
$$;

create or replace function public.admin_display_enabled()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_admin();
  return (select display_key_hash is not null from public.settings);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: start from zero, grant only what the app needs.
-- ---------------------------------------------------------------------------

revoke all on public.admins    from anon, authenticated, public;
revoke all on public.settings  from anon, authenticated, public;
revoke all on public.rooms     from anon, authenticated, public;
revoke all on public.bookings  from anon, authenticated, public;
revoke all on public.audit_log from anon, authenticated, public;

revoke all on function public.is_admin()                    from anon, public;
revoke all on function public.require_admin()               from anon, authenticated, public;
revoke all on function public.enforce_booking_rules()       from anon, authenticated, public;
revoke all on function public.validate_settings()           from anon, authenticated, public;
revoke all on function public.audit()                       from anon, authenticated, public;
revoke all on function public.admin_list_admins()           from anon, public;
revoke all on function public.admin_add(text)               from anon, public;
revoke all on function public.admin_remove(uuid)            from anon, public;
revoke all on function public.admin_booking_owners(uuid[])  from anon, public;
revoke all on function public.admin_audit_log(int)          from anon, public;

grant execute on function public.is_admin()                   to authenticated;
grant execute on function public.admin_list_admins()          to authenticated;
grant execute on function public.admin_add(text)              to authenticated;
grant execute on function public.admin_remove(uuid)           to authenticated;
grant execute on function public.admin_booking_owners(uuid[]) to authenticated;
grant execute on function public.admin_audit_log(int)         to authenticated;

-- admins, audit_log: no table grants at all. Only reachable via the functions above.

revoke all on function public.display_today(text)          from public;
revoke all on function public.admin_rotate_display_key()     from anon, public;
revoke all on function public.admin_disable_display()        from anon, public;
revoke all on function public.admin_display_enabled()        from anon, public;
grant execute on function public.display_today(text)         to anon, authenticated;
grant execute on function public.admin_rotate_display_key()  to authenticated;
grant execute on function public.admin_disable_display()     to authenticated;
grant execute on function public.admin_display_enabled()     to authenticated;

-- Column-level, so nobody can read display_key_hash.
grant select (id, timezone, open_hour, close_hour, max_duration_minutes, max_days_ahead,
              max_upcoming_per_user) on public.settings to authenticated;
grant update (timezone, open_hour, close_hour, max_duration_minutes, max_days_ahead,
              max_upcoming_per_user) on public.settings to authenticated;  -- RLS: admins only

grant select                          on public.rooms to authenticated;
grant insert (name, capacity, is_active),
      update (name, capacity, is_active),
      delete                          on public.rooms to authenticated;  -- RLS: admins only

-- user_id/created_at are set by the trigger. No UPDATE: to change a booking, cancel and rebook.
grant select (id, room_id, user_id, title, starts_at, ends_at) on public.bookings to authenticated;
grant insert (room_id, title, starts_at, ends_at)              on public.bookings to authenticated;
grant delete                                                   on public.bookings to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.admins    enable row level security;  -- no policies: clients see nothing
alter table public.audit_log enable row level security;  -- no policies: clients see nothing
alter table public.settings  enable row level security;
alter table public.rooms     enable row level security;
alter table public.bookings  enable row level security;

drop policy if exists settings_read on public.settings;
create policy settings_read on public.settings
  for select to authenticated using (true);

drop policy if exists settings_admin_update on public.settings;
create policy settings_admin_update on public.settings
  for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists rooms_read on public.rooms;
create policy rooms_read on public.rooms
  for select to authenticated
  using (is_active or (select public.is_admin()));  -- admins also see deactivated rooms

drop policy if exists rooms_admin_insert on public.rooms;
create policy rooms_admin_insert on public.rooms
  for insert to authenticated with check ((select public.is_admin()));

drop policy if exists rooms_admin_update on public.rooms;
create policy rooms_admin_update on public.rooms
  for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists rooms_admin_delete on public.rooms;
create policy rooms_admin_delete on public.rooms
  for delete to authenticated using ((select public.is_admin()));

drop policy if exists bookings_read on public.bookings;
create policy bookings_read on public.bookings
  for select to authenticated
  using (true);  -- everyone signed in can see the schedule

drop policy if exists bookings_insert_own on public.bookings;
create policy bookings_insert_own on public.bookings
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists bookings_delete on public.bookings;
create policy bookings_delete on public.bookings
  for delete to authenticated
  using ((user_id = (select auth.uid()) and ends_at > now()) or (select public.is_admin()));

-- ---------------------------------------------------------------------------
-- OPTIONAL: lock to your company email domain. Uncomment and edit the domain.
-- Restrictive policies are AND-ed with the ones above.
-- ---------------------------------------------------------------------------
-- drop policy if exists company_only_rooms on public.rooms;
-- create policy company_only_rooms on public.rooms as restrictive
--   for all to authenticated
--   using ((select auth.jwt() ->> 'email') ilike '%@yourcompany.com');
-- drop policy if exists company_only_bookings on public.bookings;
-- create policy company_only_bookings on public.bookings as restrictive
--   for all to authenticated
--   using ((select auth.jwt() ->> 'email') ilike '%@yourcompany.com')
--   with check ((select auth.jwt() ->> 'email') ilike '%@yourcompany.com');

-- ---------------------------------------------------------------------------
-- Seed rooms (admins can add/edit/remove rooms from the app afterwards)
-- ---------------------------------------------------------------------------
insert into public.rooms (name, capacity) values
  ('Boardroom', 12),
  ('Focus Room A', 4),
  ('Focus Room B', 4),
  ('Training Room', 20)
on conflict (name) do nothing;

-- ---------------------------------------------------------------------------
-- FIRST ADMIN: sign in to the app once, then run this (with your email) on its own:
--
--   insert into public.admins (user_id)
--   select id from auth.users where email = 'you@example.com';
-- ---------------------------------------------------------------------------
