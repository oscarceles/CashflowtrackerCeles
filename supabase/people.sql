-- People module: employees and monthly payroll. Run after security-hardening.sql
-- (uses public.module_access / public.is_super_admin). Safe to re-run.
--
-- Access (same roles as the rest of the platform):
--   read  : module_access('people') is 'view' or 'edit'
--   write : module_access('people') = 'edit', and only while the period is a draft
--   reopen a closed payroll: Super Admin only
-- Salary data never lives in the repository; it is loaded into these tables.

create table if not exists public.people_employees (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  area text,
  cost_type text not null default 'OPEX' check (cost_type in ('CAPEX', 'OPEX')),
  role_title text,
  start_date date,
  end_date date,
  base_salary numeric(12, 2) not null default 0,
  allowance numeric(12, 2) not null default 60,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text
);
create unique index if not exists people_employees_name_key on public.people_employees (lower(name));

create table if not exists public.payroll_periods (
  id text primary key check (id ~ '^\d{4}-\d{2}$'),          -- 'YYYY-MM'
  year int not null,
  month int not null check (month between 1 and 12),
  pay_date date,
  status text not null default 'draft' check (status in ('draft', 'closed')),
  fx_rate numeric(12, 2),                                   -- COP per USD for novedades in COP
  platform_fee numeric(12, 2) not null default 10,          -- per-person provider fee (Deel)
  notes text,
  closed_at timestamptz,
  closed_by text,
  updated_at timestamptz not null default now(),
  updated_by text
);

create table if not exists public.payroll_lines (
  id uuid primary key default gen_random_uuid(),
  period_id text not null references public.payroll_periods (id) on delete cascade,
  employee_id uuid references public.people_employees (id) on delete set null,
  name text not null,
  area text,
  cost_type text not null default 'OPEX' check (cost_type in ('CAPEX', 'OPEX')),
  role_title text,
  base_salary numeric(12, 2),
  allowance numeric(12, 2),
  days numeric(6, 2),
  prima numeric(12, 2) not null default 0,
  platform_fee numeric(12, 2) not null default 0,
  adjustments jsonb not null default '[]'::jsonb check (jsonb_typeof(adjustments) = 'array'),
  total numeric(12, 2) not null default 0,
  source text not null default 'app' check (source in ('app', 'import')),
  updated_at timestamptz not null default now(),
  updated_by text
);
create index if not exists payroll_lines_period_idx on public.payroll_lines (period_id);
create unique index if not exists payroll_lines_period_employee_key
  on public.payroll_lines (period_id, employee_id) where employee_id is not null;

-- Total is always computed by the database for lines entered in the app:
-- (base + allowance) / 30 * days + prima + platform fee + novedades (USD).
create or replace function public.payroll_line_compute()
returns trigger
language plpgsql
set search_path = ''
as $$
declare adj numeric := 0;
begin
  if new.source = 'app' then
    select coalesce(sum((a ->> 'usd')::numeric), 0) into adj
    from jsonb_array_elements(new.adjustments) a;
    new.total := round(
      (coalesce(new.base_salary, 0) + coalesce(new.allowance, 0)) / 30 * coalesce(new.days, 0)
      + coalesce(new.prima, 0) + coalesce(new.platform_fee, 0) + adj, 2);
  end if;
  new.updated_at := now();
  new.updated_by := lower(coalesce(auth.jwt() ->> 'email', new.updated_by));
  return new;
end;
$$;
drop trigger if exists payroll_line_compute on public.payroll_lines;
create trigger payroll_line_compute before insert or update on public.payroll_lines
  for each row execute function public.payroll_line_compute();

-- Closed payrolls are frozen; only a Super Admin can reopen one.
create or replace function public.payroll_period_guard()
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
      raise exception 'Esta nómina está cerrada; solo un Super Admin puede reabrirla.';
    end if;
  end if;
  if tg_op = 'UPDATE' and old.status = 'draft' and new.status = 'closed' then
    new.closed_at := now();
    new.closed_by := lower(coalesce(auth.jwt() ->> 'email', new.closed_by));
  end if;
  new.updated_at := now();
  new.updated_by := lower(coalesce(auth.jwt() ->> 'email', new.updated_by));
  return new;
end;
$$;
drop trigger if exists payroll_period_guard on public.payroll_periods;
create trigger payroll_period_guard before update on public.payroll_periods
  for each row execute function public.payroll_period_guard();

create or replace function public.people_employee_touch()
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
drop trigger if exists people_employee_touch on public.people_employees;
create trigger people_employee_touch before insert or update on public.people_employees
  for each row execute function public.people_employee_touch();

-- Is the period still a draft? (security definer: used inside RLS policies)
create or replace function public.payroll_period_is_draft(period text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.payroll_periods p where p.id = period and p.status = 'draft');
$$;
revoke all on function public.payroll_period_is_draft(text) from public, anon;
grant execute on function public.payroll_period_is_draft(text) to authenticated;

-- Close a draft and open the next month as a new draft with the same people.
create or replace function public.payroll_close_period(period text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.payroll_periods;
  next_id text;
  next_year int;
  next_month int;
  next_pay date;
begin
  if public.module_access('people') is distinct from 'edit' then
    raise exception 'No tienes permiso para cerrar nóminas.';
  end if;
  select * into p from public.payroll_periods where id = period for update;
  if p.id is null or p.status <> 'draft' then
    raise exception 'La nómina % no está en borrador.', period;
  end if;

  update public.payroll_periods
    set status = 'closed', closed_at = now(), closed_by = public.current_member_email(),
        updated_by = public.current_member_email()
    where id = period;

  next_year := case when p.month = 12 then p.year + 1 else p.year end;
  next_month := case when p.month = 12 then 1 else p.month + 1 end;
  next_id := to_char(make_date(next_year, next_month, 1), 'YYYY-MM');
  next_pay := case when p.pay_date is null then make_date(next_year, next_month, 25)
                   else (p.pay_date + interval '1 month')::date end;

  if not exists (select 1 from public.payroll_periods where id = next_id) then
    insert into public.payroll_periods (id, year, month, pay_date, status, fx_rate, platform_fee, updated_by)
    values (next_id, next_year, next_month, next_pay, 'draft', p.fx_rate, p.platform_fee, public.current_member_email());

    insert into public.payroll_lines
      (period_id, employee_id, name, area, cost_type, role_title, base_salary, allowance, days, prima, platform_fee, adjustments, source)
    select next_id, e.id, e.name, e.area, e.cost_type, e.role_title, e.base_salary, e.allowance, 30,
           case when next_month in (6, 12) then
             round(e.base_salary * least(180, greatest(0,
               public.days360(greatest(coalesce(e.start_date, '1900-01-01'::date), (next_pay - interval '6 months')::date), next_pay)
             )) / 180.0, 2)
           else 0 end,
           p.platform_fee, '[]'::jsonb, 'app'
    from public.people_employees e
    where e.active and (e.end_date is null or e.end_date >= make_date(next_year, next_month, 1));
  end if;
  return next_id;
end;
$$;
revoke all on function public.payroll_close_period(text) from public, anon;
grant execute on function public.payroll_close_period(text) to authenticated;

-- Excel DAYS360 (US/NASD method), used for the semester bonus (prima).
create or replace function public.days360(start_date date, end_date date)
returns int
language plpgsql
immutable
set search_path = ''
as $$
declare
  d1 int := extract(day from start_date);
  d2 int := extract(day from end_date);
  last1 boolean := start_date = (date_trunc('month', start_date) + interval '1 month - 1 day')::date;
  last2 boolean := end_date = (date_trunc('month', end_date) + interval '1 month - 1 day')::date;
begin
  if extract(month from start_date) = 2 and last1 then
    if extract(month from end_date) = 2 and last2 then d2 := 30; end if;
    d1 := 30;
  end if;
  if d2 = 31 and d1 >= 30 then d2 := 30; end if;
  if d1 = 31 then d1 := 30; end if;
  return (extract(year from end_date) - extract(year from start_date)) * 360
       + (extract(month from end_date) - extract(month from start_date)) * 30
       + (d2 - d1);
end;
$$;

-- Row-level security ------------------------------------------------------
alter table public.people_employees enable row level security;
alter table public.payroll_periods enable row level security;
alter table public.payroll_lines enable row level security;

do $$
declare p record;
begin
  for p in
    select policyname, tablename from pg_policies
    where schemaname = 'public' and tablename in ('people_employees', 'payroll_periods', 'payroll_lines')
  loop
    execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

create policy "People viewers read employees" on public.people_employees for select to authenticated
  using (public.module_access('people') is not null);
create policy "People editors write employees" on public.people_employees for all to authenticated
  using (public.module_access('people') = 'edit')
  with check (public.module_access('people') = 'edit');

create policy "People viewers read periods" on public.payroll_periods for select to authenticated
  using (public.module_access('people') is not null);
create policy "People editors create periods" on public.payroll_periods for insert to authenticated
  with check (public.module_access('people') = 'edit' and status = 'draft');
create policy "People editors update periods" on public.payroll_periods for update to authenticated
  using (public.module_access('people') = 'edit')
  with check (public.module_access('people') = 'edit');

create policy "People viewers read lines" on public.payroll_lines for select to authenticated
  using (public.module_access('people') is not null);
create policy "People editors write draft lines" on public.payroll_lines for all to authenticated
  using (public.module_access('people') = 'edit' and public.payroll_period_is_draft(period_id))
  with check (public.module_access('people') = 'edit' and public.payroll_period_is_draft(period_id));

revoke all on table public.people_employees, public.payroll_periods, public.payroll_lines from anon;

-- ===================== Directory, equity, exits & Deel ======================

alter table public.people_employees
  add column if not exists legal_name text,
  add column if not exists work_email text,
  add column if not exists personal_email text,
  add column if not exists phone text,
  add column if not exists birth_date date,
  add column if not exists country text,
  add column if not exists city text,
  add column if not exists shirt_size text,
  add column if not exists pants_size text,
  add column if not exists dietary_notes text,
  add column if not exists notes text,
  add column if not exists deel_contract_id text,
  add column if not exists deel_name text,
  add column if not exists deel_email text,
  add column if not exists deel_contract_name text,
  add column if not exists deel_group text;

-- Sensitive personal data: readable and writable only by People editors.
create table if not exists public.people_private (
  employee_id uuid primary key references public.people_employees (id) on delete cascade,
  id_number text,
  address text,
  neighborhood text,
  bank text,
  account_type text,
  account_number text,
  eps text,
  emergency_name text,
  emergency_phone text,
  emergency_relationship text,
  marital_status text,
  children text,
  data_consent boolean,
  updated_at timestamptz not null default now(),
  updated_by text
);
drop trigger if exists people_private_touch on public.people_private;
create trigger people_private_touch before insert or update on public.people_private
  for each row execute function public.people_employee_touch();

create table if not exists public.people_equity_grants (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.people_employees (id) on delete cascade,
  grant_type text not null default 'Stock options',
  units numeric(14, 2) not null default 0,
  vesting_start date,
  cliff_date date,
  expiration_date date,
  status text not null default 'Active',
  signed boolean not null default false,
  notes text,
  updated_at timestamptz not null default now(),
  updated_by text
);
create index if not exists people_equity_grants_employee_idx on public.people_equity_grants (employee_id);
drop trigger if exists people_equity_touch on public.people_equity_grants;
create trigger people_equity_touch before insert or update on public.people_equity_grants
  for each row execute function public.people_employee_touch();

-- Exit and settlement (liquidación) recorded on the person's last payroll line.
alter table public.payroll_lines
  add column if not exists exit_date date,
  add column if not exists liquidation jsonb check (liquidation is null or jsonb_typeof(liquidation) = 'object');

create or replace function public.payroll_line_compute()
returns trigger
language plpgsql
set search_path = ''
as $$
declare adj numeric := 0;
begin
  if new.source = 'app' then
    select coalesce(sum((a ->> 'usd')::numeric), 0) into adj
    from jsonb_array_elements(new.adjustments) a;
    new.total := round(
      (coalesce(new.base_salary, 0) + coalesce(new.allowance, 0)) / 30 * coalesce(new.days, 0)
      + coalesce(new.prima, 0) + coalesce(new.platform_fee, 0) + adj
      + coalesce((new.liquidation ->> 'total')::numeric, 0), 2);
  end if;
  new.updated_at := now();
  new.updated_by := lower(coalesce(auth.jwt() ->> 'email', new.updated_by));
  return new;
end;
$$;

alter table public.people_private enable row level security;
alter table public.people_equity_grants enable row level security;

do $$
declare p record;
begin
  for p in
    select policyname, tablename from pg_policies
    where schemaname = 'public' and tablename in ('people_private', 'people_equity_grants')
  loop
    execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

create policy "People editors manage private data" on public.people_private for all to authenticated
  using (public.module_access('people') = 'edit')
  with check (public.module_access('people') = 'edit');

create policy "People viewers read equity" on public.people_equity_grants for select to authenticated
  using (public.module_access('people') is not null);
create policy "People editors write equity" on public.people_equity_grants for all to authenticated
  using (public.module_access('people') = 'edit')
  with check (public.module_access('people') = 'edit');

revoke all on table public.people_private, public.people_equity_grants from anon;
