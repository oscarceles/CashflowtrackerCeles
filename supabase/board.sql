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

-- ===================== Local entities: documents ==============================

create table if not exists public.board_entity_documents (
  id uuid primary key default gen_random_uuid(),
  entity text not null check (entity in ('celes-us', 'biai-colombia', 'xeles-mexico', 'celes-chile', 'group')),
  category text not null,
  folder text,
  name text not null,
  path text not null unique,
  size bigint,
  content_type text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text
);
create index if not exists board_entity_documents_entity_idx on public.board_entity_documents (entity);
drop trigger if exists board_entity_documents_touch on public.board_entity_documents;
create trigger board_entity_documents_touch before insert or update on public.board_entity_documents
  for each row execute function public.board_cap_table_touch_row();

alter table public.board_entity_documents enable row level security;
drop policy if exists "Board viewers read entity documents" on public.board_entity_documents;
drop policy if exists "Board editors write entity documents" on public.board_entity_documents;
create policy "Board viewers read entity documents" on public.board_entity_documents for select to authenticated
  using (public.module_access('board') is not null);
create policy "Board editors write entity documents" on public.board_entity_documents for all to authenticated
  using (public.module_access('board') = 'edit')
  with check (public.module_access('board') = 'edit');
revoke all on table public.board_entity_documents from anon;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('board-entity-docs', 'board-entity-docs', false, 26214400, array[
  'application/pdf', 'image/png', 'image/jpeg',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Board viewers read entity files" on storage.objects;
drop policy if exists "Board editors upload entity files" on storage.objects;
drop policy if exists "Board editors delete entity files" on storage.objects;
create policy "Board viewers read entity files" on storage.objects for select to authenticated
  using (bucket_id = 'board-entity-docs' and public.module_access('board') is not null);
create policy "Board editors upload entity files" on storage.objects for insert to authenticated
  with check (bucket_id = 'board-entity-docs' and public.module_access('board') = 'edit');
create policy "Board editors delete entity files" on storage.objects for delete to authenticated
  using (bucket_id = 'board-entity-docs' and public.module_access('board') = 'edit');

-- ===================== Consolidation (Consolidated Data → Financials) ==========
-- Monthly consolidation of the local entities into USD. Each period stores FX rates
-- (local currency per USD: month average for P&L, month-end closing for the balance sheet).
-- Each entity row stores what the accountants deliver, in local currency: balance sheet at
-- month end and P&L accumulated year-to-date (plus the YTD of the previous month, to derive
-- the month). 'eliminations' rows hold intercompany eliminations in USD. 'history' rows hold
-- figures imported from the previous Excel consolidation (already in USD).

create table if not exists public.consolidation_entities (
  id text primary key,
  name text not null,
  country text,
  currency text not null,
  is_holding boolean not null default false,
  included boolean not null default true,
  sort_order int not null default 0
);
insert into public.consolidation_entities (id, name, country, currency, is_holding, included, sort_order) values
  ('celes-us', 'Celes Technologies, Inc.', 'Estados Unidos', 'USD', true, true, 1),
  ('biai-colombia', 'Biai Technologies S.A.S.', 'Colombia', 'COP', false, true, 2),
  ('xeles-mexico', 'Xeles S.A. de C.V.', 'México', 'MXN', false, true, 3),
  ('celes-chile', 'Celes (Chile)', 'Chile', 'CLP', false, false, 4)
on conflict (id) do nothing;

create table if not exists public.consolidation_periods (
  id text primary key check (id ~ '^\d{4}-\d{2}$'),
  status text not null default 'draft' check (status in ('draft', 'closed')),
  fx jsonb not null default '{}'::jsonb check (jsonb_typeof(fx) = 'object'),
  notes text,
  closed_at timestamptz,
  closed_by text,
  updated_at timestamptz not null default now(),
  updated_by text
);

create table if not exists public.consolidation_entries (
  id uuid primary key default gen_random_uuid(),
  period_id text not null references public.consolidation_periods (id) on delete cascade,
  entity_id text not null,                 -- consolidation_entities.id, 'eliminations' or 'consolidated'
  kind text not null default 'input' check (kind in ('input', 'history')),
  status text not null default 'pending' check (status in ('pending', 'loaded')),
  values jsonb not null default '{}'::jsonb check (jsonb_typeof(values) = 'object'),
  notes text,
  updated_at timestamptz not null default now(),
  updated_by text,
  unique (period_id, entity_id, kind)
);

drop trigger if exists consolidation_entries_touch on public.consolidation_entries;
create trigger consolidation_entries_touch before insert or update on public.consolidation_entries
  for each row execute function public.board_cap_table_touch_row();

create or replace function public.consolidation_period_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.status = 'closed' then
    if new.status = 'draft' and public.is_super_admin() then
      new.closed_at := null;
      new.closed_by := null;
    elsif auth.role() = 'authenticated' then
      raise exception 'Este mes está cerrado; solo un Super Admin puede reabrirlo.';
    end if;
  end if;
  if tg_op = 'UPDATE' and old.status = 'draft' and new.status = 'closed' then
    new.closed_at := now();
    new.closed_by := nullif(public.current_member_email(), '');
  end if;
  new.updated_at := now();
  new.updated_by := lower(coalesce(auth.jwt() ->> 'email', new.updated_by));
  return new;
end;
$$;
drop trigger if exists consolidation_period_guard on public.consolidation_periods;
create trigger consolidation_period_guard before insert or update on public.consolidation_periods
  for each row execute function public.consolidation_period_guard();

create or replace function public.consolidation_period_is_draft(period text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.consolidation_periods p where p.id = period and p.status = 'draft');
$$;
revoke all on function public.consolidation_period_is_draft(text) from public, anon;
grant execute on function public.consolidation_period_is_draft(text) to authenticated;

alter table public.consolidation_entities enable row level security;
alter table public.consolidation_periods enable row level security;
alter table public.consolidation_entries enable row level security;

do $$
declare p record;
begin
  for p in
    select policyname, tablename from pg_policies
    where schemaname = 'public' and tablename in ('consolidation_entities', 'consolidation_periods', 'consolidation_entries')
  loop
    execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

create policy "Board viewers read entities" on public.consolidation_entities for select to authenticated
  using (public.module_access('board') is not null);
create policy "Board viewers read consolidation periods" on public.consolidation_periods for select to authenticated
  using (public.module_access('board') is not null);
create policy "Board editors create consolidation periods" on public.consolidation_periods for insert to authenticated
  with check (public.module_access('board') = 'edit' and status = 'draft');
create policy "Board editors update consolidation periods" on public.consolidation_periods for update to authenticated
  using (public.module_access('board') = 'edit')
  with check (public.module_access('board') = 'edit');
create policy "Board viewers read consolidation entries" on public.consolidation_entries for select to authenticated
  using (public.module_access('board') is not null);
create policy "Board editors write draft consolidation entries" on public.consolidation_entries for all to authenticated
  using (public.module_access('board') = 'edit' and kind = 'input' and public.consolidation_period_is_draft(period_id))
  with check (public.module_access('board') = 'edit' and kind = 'input' and public.consolidation_period_is_draft(period_id));

revoke all on table public.consolidation_entities, public.consolidation_periods, public.consolidation_entries from anon;
revoke insert, update, delete on table public.consolidation_entities from authenticated;
