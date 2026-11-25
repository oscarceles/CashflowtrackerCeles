-- ESOP: pool status (Board) and stock option purchase requests (People).
-- Run after people.sql and board.sql. Safe to re-run.
--
-- Flow: a People editor registers a request for a collaborator's vested grant (cliff reached,
-- not expired) -> approve (fixes price and amount) -> payment:
--   * payroll deduction: N installments, added automatically as "Deducción" adjustments to the
--     draft payrolls; an installment counts as paid when the payroll that carries it is closed.
--   * transfer to Celes' account: a People editor records the payment (date + reference).
-- When the full amount is paid the request becomes "paid" and Board > ESOP shows the shares as bought.

create table if not exists public.esop_settings (
  id int primary key default 1 check (id = 1),
  pool_size numeric(14, 2) not null default 50000,       -- shares reserved for the ESOP
  exercise_price numeric(14, 6),                           -- USD per share (default for every grant)
  payment_instructions text,                               -- Celes account details for transfers
  max_installments int not null default 12 check (max_installments between 1 and 36),
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into public.esop_settings (id) values (1) on conflict (id) do nothing;

alter table public.people_equity_grants add column if not exists exercise_price numeric(14, 6);

create table if not exists public.esop_requests (
  id uuid primary key default gen_random_uuid(),
  grant_id uuid not null references public.people_equity_grants (id) on delete restrict,
  employee_id uuid not null references public.people_employees (id) on delete restrict,
  units numeric(14, 2) not null check (units > 0),
  price numeric(14, 6),                                    -- fixed when approved
  amount numeric(14, 2),                                   -- units x price, fixed when approved
  payment_method text not null check (payment_method in ('payroll', 'transfer')),
  installments int not null default 1 check (installments between 1 and 36),
  status text not null default 'requested' check (status in ('requested', 'approved', 'paid', 'rejected', 'cancelled')),
  notes text,
  requested_at timestamptz not null default now(),
  requested_by text,
  decided_at timestamptz,
  decided_by text,
  decision_note text,
  paid_at date,
  payment_reference text,
  updated_at timestamptz not null default now(),
  updated_by text
);
create index if not exists esop_requests_grant_idx on public.esop_requests (grant_id);
create index if not exists esop_requests_employee_idx on public.esop_requests (employee_id);

create table if not exists public.esop_installments (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.esop_requests (id) on delete cascade,
  n int not null,
  amount numeric(14, 2) not null,
  period_id text references public.payroll_periods (id) on update cascade on delete set null,
  paid boolean not null default false,
  paid_period text,
  unique (request_id, n)
);

-- Validation: only vested, active stock options, never more units than are left on the grant.
create or replace function public.esop_request_validate()
returns trigger
language plpgsql
set search_path = ''
as $$
declare g public.people_equity_grants; used numeric; s public.esop_settings;
begin
  select * into g from public.people_equity_grants where id = new.grant_id;
  if g.id is null then raise exception 'La asignación de opciones no existe.'; end if;
  new.employee_id := g.employee_id;
  select * into s from public.esop_settings where id = 1;
  if tg_op = 'INSERT' then
    if g.grant_type <> 'Stock options' then raise exception 'Solo se pueden comprar stock options (esta asignación es %).', g.grant_type; end if;
    if g.status <> 'Active' then raise exception 'La asignación no está activa.'; end if;
    if g.cliff_date is null or g.cliff_date > current_date then raise exception 'Las opciones aún no cumplen el cliff (%).', coalesce(to_char(g.cliff_date, 'YYYY-MM-DD'), 'sin fecha'); end if;
    if g.expiration_date is not null and g.expiration_date < current_date then raise exception 'Las opciones vencieron el %.', g.expiration_date; end if;
    if new.payment_method = 'transfer' then new.installments := 1; end if;
    if new.installments > s.max_installments then raise exception 'Máximo % cuotas.', s.max_installments; end if;
    new.status := 'requested';
    new.price := null; new.amount := null;
    new.requested_at := now();
    new.requested_by := lower(coalesce(auth.jwt() ->> 'email', new.requested_by));
  end if;
  select coalesce(sum(units), 0) into used from public.esop_requests
    where grant_id = new.grant_id and id <> new.id and status in ('requested', 'approved', 'paid');
  if new.status in ('requested', 'approved', 'paid') and used + new.units > g.units then
    raise exception 'Solo quedan % opciones disponibles en esta asignación.', g.units - used;
  end if;
  new.updated_at := now();
  new.updated_by := lower(coalesce(auth.jwt() ->> 'email', new.updated_by));
  return new;
end;
$$;
drop trigger if exists esop_request_validate on public.esop_requests;
create trigger esop_request_validate before insert or update on public.esop_requests
  for each row execute function public.esop_request_validate();

drop trigger if exists esop_settings_touch on public.esop_settings;
create trigger esop_settings_touch before update on public.esop_settings
  for each row execute function public.people_employee_touch();

-- Puts the next pending installment of every approved payroll request into each draft payroll
-- where the person has a line (one installment per payroll), as a "Deducción" adjustment.
create or replace function public.esop_sync_payroll()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare r record; p record; i public.esop_installments; ln public.payroll_lines;
begin
  for r in select * from public.esop_requests where status = 'approved' and payment_method = 'payroll' order by requested_at loop
    for p in select * from public.payroll_periods where status = 'draft' order by id loop
      continue when exists (select 1 from public.esop_installments where request_id = r.id and period_id = p.id);
      select * into ln from public.payroll_lines where period_id = p.id and employee_id = r.employee_id limit 1;
      continue when ln.id is null;
      select * into i from public.esop_installments where request_id = r.id and not paid and period_id is null order by n limit 1;
      exit when i.id is null;
      update public.esop_installments set period_id = p.id where id = i.id;
      update public.payroll_lines
        set adjustments = adjustments || jsonb_build_array(jsonb_build_object(
          'id', gen_random_uuid(), 'type', 'Deducción', 'amount', i.amount, 'usd', -i.amount, 'currency', 'USD',
          'note', format('Compra ESOP: cuota %s de %s (%s acciones)', i.n, r.installments, r.units::int), 'esop_installment', i.id))
        where id = ln.id;
    end loop;
  end loop;
end;
$$;
revoke all on function public.esop_sync_payroll() from public, anon, authenticated;

-- Called by payroll_close_period: installments still present in the closed payroll are paid;
-- the ones removed from it go back to pending. Fully paid requests become "paid".
create or replace function public.esop_payroll_on_close(period text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare pay date;
begin
  select pay_date into pay from public.payroll_periods where id = period;
  update public.esop_installments i
    set paid = exists (
          select 1 from public.payroll_lines l, jsonb_array_elements(l.adjustments) a
          where l.period_id = period and a ->> 'esop_installment' = i.id::text),
        paid_period = period
    where i.period_id = period and not i.paid;
  update public.esop_installments set period_id = null, paid_period = null where period_id = period and not paid;
  update public.esop_requests r
    set status = 'paid', paid_at = coalesce(pay, current_date), payment_reference = 'Deducción de nómina'
    where r.status = 'approved' and r.payment_method = 'payroll'
      and not exists (select 1 from public.esop_installments i where i.request_id = r.id and not i.paid);
  perform public.esop_sync_payroll();
end;
$$;
revoke all on function public.esop_payroll_on_close(text) from public, anon, authenticated;

-- Removes the unpaid installment adjustments of a request from the draft payrolls.
create or replace function public.esop_remove_from_drafts(req uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.payroll_lines l
    set adjustments = coalesce((
      select jsonb_agg(a) from jsonb_array_elements(l.adjustments) a
      where coalesce(a ->> 'esop_installment', '') not in (select id::text from public.esop_installments where request_id = req and not paid)), '[]'::jsonb)
    where l.period_id in (select id from public.payroll_periods where status = 'draft')
      and exists (select 1 from jsonb_array_elements(l.adjustments) a
                  where a ->> 'esop_installment' in (select id::text from public.esop_installments where request_id = req and not paid));
  delete from public.esop_installments where request_id = req and not paid;
end;
$$;
revoke all on function public.esop_remove_from_drafts(uuid) from public, anon, authenticated;

-- Status changes (People editors only).
create or replace function public.esop_request_action(req uuid, action text, note text default null, paid_on date default null, reference text default null)
returns public.esop_requests
language plpgsql
security definer
set search_path = ''
as $$
declare r public.esop_requests; g public.people_equity_grants; s public.esop_settings; v_price numeric; v_amt numeric; part numeric; k int;
  me text := public.current_member_email();
begin
  if public.module_access('people') is distinct from 'edit' then raise exception 'No tienes permiso para gestionar compras del ESOP.'; end if;
  select * into r from public.esop_requests where id = req for update;
  if r.id is null then raise exception 'La solicitud no existe.'; end if;

  if action = 'approve' then
    if r.status <> 'requested' then raise exception 'Solo se puede aprobar una solicitud pendiente.'; end if;
    select * into g from public.people_equity_grants where id = r.grant_id;
    select * into s from public.esop_settings where id = 1;
    v_price := coalesce(g.exercise_price, s.exercise_price);
    if v_price is null then raise exception 'Define el precio de ejercicio en Board > ESOP antes de aprobar.'; end if;
    v_amt := round(r.units * v_price, 2);
    update public.esop_requests set status = 'approved', price = v_price, amount = v_amt, decided_at = now(), decided_by = me,
      decision_note = note, updated_by = me where id = req returning * into r;
    if r.payment_method = 'payroll' then
      part := floor(v_amt / r.installments * 100) / 100;
      for k in 1 .. r.installments loop
        insert into public.esop_installments (request_id, n, amount)
        values (req, k, case when k = r.installments then v_amt - part * (r.installments - 1) else part end);
      end loop;
      perform public.esop_sync_payroll();
    end if;
  elsif action = 'reject' then
    if r.status <> 'requested' then raise exception 'Solo se puede rechazar una solicitud pendiente.'; end if;
    update public.esop_requests set status = 'rejected', decided_at = now(), decided_by = me, decision_note = note, updated_by = me
      where id = req returning * into r;
  elsif action = 'cancel' then
    if r.status not in ('requested', 'approved') then raise exception 'Esta solicitud ya no se puede cancelar.'; end if;
    if exists (select 1 from public.esop_installments where request_id = req and paid) then
      raise exception 'Ya hay cuotas descontadas en nóminas cerradas; no se puede cancelar.';
    end if;
    perform public.esop_remove_from_drafts(req);
    update public.esop_requests set status = 'cancelled', decided_at = now(), decided_by = me,
      decision_note = coalesce(note, decision_note), updated_by = me where id = req returning * into r;
  elsif action = 'mark_paid' then
    if r.status <> 'approved' or r.payment_method <> 'transfer' then raise exception 'Solo se registra pago de solicitudes aprobadas por transferencia.'; end if;
    if paid_on is null then raise exception 'Indica la fecha del pago.'; end if;
    update public.esop_requests set status = 'paid', paid_at = paid_on, payment_reference = nullif(trim(reference), ''),
      updated_by = me where id = req returning * into r;
  else
    raise exception 'Acción no válida: %', action;
  end if;
  return r;
end;
$$;
revoke all on function public.esop_request_action(uuid, text, text, date, text) from public, anon;
grant execute on function public.esop_request_action(uuid, text, text, date, text) to authenticated;

-- Board > ESOP: pool status and one row per grant (readable with Board or People access).
create or replace function public.esop_overview()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.module_access('board') is null and public.module_access('people') is null then null else jsonb_build_object(
    'settings', (select to_jsonb(s) from public.esop_settings s where id = 1),
    'grants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', g.id, 'holder', e.name, 'active', e.active, 'grant_type', g.grant_type, 'units', g.units,
        'vesting_start', g.vesting_start, 'cliff_date', g.cliff_date, 'expiration_date', g.expiration_date,
        'status', g.status, 'signed', g.signed, 'exercise_price', g.exercise_price,
        'bought', coalesce((select sum(units) from public.esop_requests r where r.grant_id = g.id and r.status = 'paid'), 0),
        'in_process', coalesce((select sum(units) from public.esop_requests r where r.grant_id = g.id and r.status in ('requested', 'approved')), 0),
        'paid_amount', coalesce((select sum(amount) from public.esop_requests r where r.grant_id = g.id and r.status = 'paid'), 0)
      ) order by g.units desc, e.name)
      from public.people_equity_grants g join public.people_employees e on e.id = g.employee_id), '[]'::jsonb)
  ) end;
$$;
revoke all on function public.esop_overview() from public, anon;
grant execute on function public.esop_overview() to authenticated;

-- RLS
alter table public.esop_settings enable row level security;
alter table public.esop_requests enable row level security;
alter table public.esop_installments enable row level security;
do $$
declare p record;
begin
  for p in select policyname, tablename from pg_policies
    where schemaname = 'public' and tablename in ('esop_settings', 'esop_requests', 'esop_installments')
  loop
    execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;
create policy "ESOP settings readable" on public.esop_settings for select to authenticated
  using (public.module_access('board') is not null or public.module_access('people') is not null);
create policy "Board editors update ESOP settings" on public.esop_settings for update to authenticated
  using (public.module_access('board') = 'edit') with check (public.module_access('board') = 'edit');
create policy "People viewers read ESOP requests" on public.esop_requests for select to authenticated
  using (public.module_access('people') is not null);
create policy "People editors create ESOP requests" on public.esop_requests for insert to authenticated
  with check (public.module_access('people') = 'edit');
create policy "People viewers read ESOP installments" on public.esop_installments for select to authenticated
  using (public.module_access('people') is not null);
revoke all on table public.esop_settings, public.esop_requests, public.esop_installments from anon;
revoke insert, delete on table public.esop_settings from authenticated;
revoke update, delete on table public.esop_requests from authenticated;
revoke insert, update, delete on table public.esop_installments from authenticated;
