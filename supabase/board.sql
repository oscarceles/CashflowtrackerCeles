-- Board tables accessed directly from the app (RLS by Board access). Run after
-- security-hardening.sql (uses public.module_access / public.current_member_email). Safe to re-run.

-- Cap Table: one row per holder and share class. "Last updated" is kept by the database
-- in board_cap_table_meta on every insert, update or delete, so it is always current.
create table if not exists public.board_cap_table (
  id uuid primary key default gen_random_uuid(),
  holder text not null,
  share_class text not null default 'Common',
  shares numeric(20, 4) not null default 0 check (shares >= 0),
  notes text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text
);

create table if not exists public.board_cap_table_meta (
  id int primary key default 1 check (id = 1),
  updated_at timestamptz,
  updated_by text
);
insert into public.board_cap_table_meta (id) values (1) on conflict (id) do nothing;

create or replace function public.board_cap_table_touch_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := lower(coalesce(auth.jwt() ->> 'email', new.updated_by));
  return new;
end;
$$;
drop trigger if exists board_cap_table_touch_row on public.board_cap_table;
create trigger board_cap_table_touch_row before insert or update on public.board_cap_table
  for each row execute function public.board_cap_table_touch_row();

create or replace function public.board_cap_table_touch_meta()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.board_cap_table_meta
    set updated_at = now(), updated_by = nullif(public.current_member_email(), '')
    where id = 1;
  return null;
end;
$$;
drop trigger if exists board_cap_table_touch_meta on public.board_cap_table;
create trigger board_cap_table_touch_meta after insert or update or delete on public.board_cap_table
  for each statement execute function public.board_cap_table_touch_meta();

alter table public.board_cap_table enable row level security;
alter table public.board_cap_table_meta enable row level security;

do $$
declare p record;
begin
  for p in
    select policyname, tablename from pg_policies
    where schemaname = 'public' and tablename in ('board_cap_table', 'board_cap_table_meta')
  loop
    execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

create policy "Board viewers read cap table" on public.board_cap_table for select to authenticated
  using (public.module_access('board') is not null);
create policy "Board editors write cap table" on public.board_cap_table for all to authenticated
  using (public.module_access('board') = 'edit')
  with check (public.module_access('board') = 'edit');
-- Meta is read-only for users; only the trigger (security definer) writes it.
create policy "Board viewers read cap table meta" on public.board_cap_table_meta for select to authenticated
  using (public.module_access('board') is not null);

revoke all on table public.board_cap_table, public.board_cap_table_meta from anon;
revoke insert, update, delete on table public.board_cap_table_meta from authenticated;
