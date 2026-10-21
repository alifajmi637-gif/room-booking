-- Meeting room booking schema.
-- Run once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
--
-- Security model: the browser only ever holds the public anon key, so EVERY rule
-- that matters is enforced here in Postgres (RLS + constraints + triggers), never
-- in the frontend.

create extension if not exists btree_gist;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.rooms (
  id        smallint generated always as identity primary key,
  name      text not null unique check (char_length(name) between 1 and 60),
  capacity  smallint not null check (capacity between 1 and 500),
  is_active boolean not null default true
);

create table if not exists public.bookings (
  id         uuid primary key default gen_random_uuid(),
  room_id    smallint not null references public.rooms(id) on delete restrict,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title      text not null check (char_length(btrim(title)) between 1 and 100
                                  and title !~ '[[:cntrl:]]'),
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  created_at timestamptz not null default now(),

  constraint ends_after_start   check (ends_at > starts_at),
  constraint max_8_hours        check (ends_at - starts_at <= interval '8 hours'),
  constraint min_15_minutes     check (ends_at - starts_at >= interval '15 minutes'),
  constraint quarter_hour_slots check (
    extract(epoch from starts_at) % 900 = 0 and extract(epoch from ends_at) % 900 = 0
  ),
  -- Race-proof double-booking prevention: two concurrent inserts can't both win.
  constraint no_overlap exclude using gist (
    room_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  )
);

create index if not exists bookings_user_idx on public.bookings (user_id);
create index if not exists bookings_starts_idx on public.bookings (starts_at);

-- ---------------------------------------------------------------------------
-- Business rules that need "now()" or counting (can't be CHECK constraints)
-- ---------------------------------------------------------------------------

create or replace function public.enforce_booking_rules()
returns trigger
language plpgsql
security invoker  -- runs as the signed-in user, so RLS still applies inside
set search_path = ''
as $$
declare
  active_count int;
begin
  -- Never trust a client-supplied owner or timestamp.
  new.user_id    := auth.uid();
  new.created_at := now();

  if new.user_id is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  if new.starts_at < now() then
    raise exception 'Cannot book in the past' using errcode = '22023';
  end if;

  if new.starts_at > now() + interval '90 days' then
    raise exception 'Bookings can be made at most 90 days ahead' using errcode = '22023';
  end if;

  if not exists (select 1 from public.rooms r where r.id = new.room_id and r.is_active) then
    raise exception 'Room is not available' using errcode = '22023';
  end if;

  -- Per-user cap to stop one account hoarding rooms or spamming the table.
  -- Serialise this user's inserts so parallel requests can't sneak past the count.
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));
  select count(*) into active_count
    from public.bookings b
   where b.user_id = new.user_id and b.ends_at > now();
  if active_count >= 20 then
    raise exception 'You already have 20 upcoming bookings' using errcode = '22023';
  end if;

  return new;
end;
$$;

drop trigger if exists bookings_rules on public.bookings;
create trigger bookings_rules
  before insert on public.bookings
  for each row execute function public.enforce_booking_rules();

-- ---------------------------------------------------------------------------
-- Privileges: start from zero, grant only what the app needs.
-- ---------------------------------------------------------------------------

revoke all on public.rooms    from anon, authenticated, public;
revoke all on public.bookings from anon, authenticated, public;
revoke all on function public.enforce_booking_rules() from anon, public;

grant select on public.rooms to authenticated;
-- Column-level grants: clients can only write these columns; user_id/created_at
-- are set by the trigger. No UPDATE at all - to change a booking, cancel and rebook.
grant select (id, room_id, user_id, title, starts_at, ends_at) on public.bookings to authenticated;
grant insert (room_id, title, starts_at, ends_at)              on public.bookings to authenticated;
grant delete                                                   on public.bookings to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security (FORCE so even the table owner path is checked)
-- ---------------------------------------------------------------------------

alter table public.rooms    enable row level security;
alter table public.rooms    force  row level security;
alter table public.bookings enable row level security;
alter table public.bookings force  row level security;

drop policy if exists rooms_read on public.rooms;
create policy rooms_read on public.rooms
  for select to authenticated
  using (is_active);

drop policy if exists bookings_read on public.bookings;
create policy bookings_read on public.bookings
  for select to authenticated
  using (true);  -- everyone signed in can see the schedule

drop policy if exists bookings_insert_own on public.bookings;
create policy bookings_insert_own on public.bookings
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists bookings_delete_own_future on public.bookings;
create policy bookings_delete_own_future on public.bookings
  for delete to authenticated
  using (user_id = (select auth.uid()) and ends_at > now());

-- ---------------------------------------------------------------------------
-- OPTIONAL: lock to your company email domain. Uncomment and edit the domain.
-- Restrictive policies are AND-ed with the ones above.
-- ---------------------------------------------------------------------------
-- create policy company_only_rooms on public.rooms as restrictive
--   for all to authenticated
--   using ((select auth.jwt() ->> 'email') ilike '%@yourcompany.com');
-- create policy company_only_bookings on public.bookings as restrictive
--   for all to authenticated
--   using ((select auth.jwt() ->> 'email') ilike '%@yourcompany.com')
--   with check ((select auth.jwt() ->> 'email') ilike '%@yourcompany.com');

-- ---------------------------------------------------------------------------
-- Seed rooms (edit to taste; only an admin in the dashboard can change rooms)
-- ---------------------------------------------------------------------------
insert into public.rooms (name, capacity) values
  ('Boardroom', 12),
  ('Focus Room A', 4),
  ('Focus Room B', 4),
  ('Training Room', 20)
on conflict (name) do nothing;
