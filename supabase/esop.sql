-- ESOP: pool status (Board) and stock option purchase requests (People).
-- Run after people.sql, board.sql and security-hardening.sql. Safe to re-run.
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

-- Vesting: nothing before the cliff; from the cliff date on, 1/48 of the grant per month for
-- 4 years (the first portion on the cliff date, one more on the same day of each following month).
-- Whole shares only. Only active stock options vest for purchase.
create or replace function public.esop_vested_units(g public.people_equity_grants, on_date date default current_date)
returns numeric
language sql
stable
set search_path = ''
as $$
  select case
    when g.grant_type <> 'Stock options' or g.status <> 'Active' or g.cliff_date is null or on_date < g.cliff_date then 0
    else floor(g.units * least(48, (extract(year from age(on_date, g.cliff_date)) * 12
                                    + extract(month from age(on_date, g.cliff_date)))::int + 1) / 48.0)
  end;
$$;

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
    select coalesce(sum(units), 0) into used from public.esop_requests
      where grant_id = new.grant_id and status in ('requested', 'approved', 'paid');
    if used + new.units > public.esop_vested_units(g) then
      raise exception 'Hoy hay % acciones vestidas disponibles para comprar en esta asignación.', greatest(0, public.esop_vested_units(g) - used);
    end if;
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

-- Status changes (People editors only). The price per share is set on each purchase when it is approved.
drop function if exists public.esop_request_action(uuid, text, text, date, text);
create or replace function public.esop_request_action(req uuid, action text, note text default null, paid_on date default null, reference text default null, price_in numeric default null)
returns public.esop_requests
language plpgsql
security definer
set search_path = ''
as $$
declare r public.esop_requests; v_price numeric; v_amt numeric; part numeric; k int;
  me text := public.current_member_email();
begin
  if public.module_access('people') is distinct from 'edit' then raise exception 'No tienes permiso para gestionar compras del ESOP.'; end if;
  select * into r from public.esop_requests where id = req for update;
  if r.id is null then raise exception 'La solicitud no existe.'; end if;

  if action = 'approve' then
    if r.status <> 'requested' then raise exception 'Solo se puede aprobar una solicitud pendiente.'; end if;
    v_price := price_in;
    if v_price is null or v_price <= 0 then raise exception 'Indica el precio por acción de esta compra.'; end if;
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
revoke all on function public.esop_request_action(uuid, text, text, date, text, numeric) from public, anon;
grant execute on function public.esop_request_action(uuid, text, text, date, text, numeric) to authenticated;

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
        'id', g.id, 'employee_id', g.employee_id, 'holder', e.name, 'active', e.active, 'vested', public.esop_vested_units(g), 'grant_type', g.grant_type, 'units', g.units,
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

-- ===================== Signed request form and self-service portal =====================
-- Every request carries the form the collaborator filled in and signed electronically:
-- the exact text shown, a drawn signature (PNG data URL), the typed name and ID, and audit data
-- (signer account, time, IP and browser) plus a SHA-256 of the text, so later changes are detectable.
alter table public.esop_requests
  add column if not exists channel text not null default 'people' check (channel in ('people', 'self')),
  add column if not exists signer_name text,
  add column if not exists signer_id_number text,
  add column if not exists form_text text,
  add column if not exists form_hash text,
  add column if not exists signature text check (signature is null or (signature like 'data:image/png;base64,%' and length(signature) < 400000)),
  add column if not exists signed_at timestamptz,
  add column if not exists signed_by text,
  add column if not exists signed_ip text,
  add column if not exists signed_user_agent text;

-- Members whose role is only the self-service portal ("Empleado").
alter table public.allowed_users drop constraint if exists allowed_users_role_check;
alter table public.allowed_users add constraint allowed_users_role_check
  check (role in ('super_admin', 'admin', 'colaborador', 'board_member', 'empleado'));

-- The People record (active) of the signed-in member, matched by any of its emails.
create or replace function public.self_employee_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.id from public.people_employees e
  where e.active and public.current_member_email() <> ''
    and exists (select 1 from public.allowed_users a where a.email = public.current_member_email())
    and public.current_member_email() in (lower(trim(coalesce(e.work_email, ''))), lower(trim(coalesce(e.personal_email, ''))), lower(trim(coalesce(e.deel_email, ''))))
  order by e.start_date desc nulls last
  limit 1;
$$;
revoke all on function public.self_employee_id() from public, anon;
grant execute on function public.self_employee_id() to authenticated;

-- Portal data: my profile, my grants (with vesting) and my requests. Nothing about anyone else.
create or replace function public.esop_self()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with me as (select public.self_employee_id() as id)
  select case when (select id from me) is null then null else jsonb_build_object(
    'employee', (select jsonb_build_object('id', e.id, 'name', e.name, 'legal_name', e.legal_name, 'role_title', e.role_title,
                   'id_number', (select p.id_number from public.people_private p where p.employee_id = e.id))
                 from public.people_employees e where e.id = (select id from me)),
    'settings', (select jsonb_build_object('max_installments', s.max_installments, 'payment_instructions', s.payment_instructions) from public.esop_settings s where id = 1),
    'grants', coalesce((select jsonb_agg(jsonb_build_object(
        'id', g.id, 'grant_type', g.grant_type, 'units', g.units, 'vesting_start', g.vesting_start, 'cliff_date', g.cliff_date,
        'expiration_date', g.expiration_date, 'status', g.status, 'signed', g.signed, 'vested', public.esop_vested_units(g),
        'used', coalesce((select sum(units) from public.esop_requests r where r.grant_id = g.id and r.status in ('requested', 'approved', 'paid')), 0),
        'bought', coalesce((select sum(units) from public.esop_requests r where r.grant_id = g.id and r.status = 'paid'), 0)
      ) order by g.vesting_start) from public.people_equity_grants g where g.employee_id = (select id from me)), '[]'::jsonb),
    'requests', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'grant_id', r.grant_id, 'units', r.units, 'price', r.price, 'amount', r.amount, 'payment_method', r.payment_method,
        'installments', r.installments, 'status', r.status, 'requested_at', r.requested_at, 'decision_note', r.decision_note,
        'paid_at', r.paid_at, 'signed_at', r.signed_at,
        'installments_paid', (select count(*) from public.esop_installments i where i.request_id = r.id and i.paid)
      ) order by r.requested_at desc) from public.esop_requests r where r.employee_id = (select id from me)), '[]'::jsonb)
  ) end;
$$;
revoke all on function public.esop_self() from public, anon;
grant execute on function public.esop_self() to authenticated;

-- Creates a signed request. Allowed for the collaborator on their own grant (portal) or for a
-- People editor on behalf of a collaborator who signs on the editor's device.
create or replace function public.esop_submit_request(
  p_grant uuid, p_units numeric, p_method text, p_installments int,
  p_signer_name text, p_signer_id text, p_form_text text, p_signature text, p_notes text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare g public.people_equity_grants; mine uuid := public.self_employee_id(); is_editor boolean := public.module_access('people') = 'edit';
  hdr jsonb := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb); new_id uuid;
begin
  select * into g from public.people_equity_grants where id = p_grant;
  if g.id is null then raise exception 'La asignación no existe.'; end if;
  if not is_editor and (mine is null or g.employee_id <> mine) then raise exception 'Solo puedes solicitar la compra de tus propias opciones.'; end if;
  if coalesce(trim(p_signer_name), '') = '' or coalesce(trim(p_signer_id), '') = '' then raise exception 'Escribe tu nombre completo y tu documento de identidad.'; end if;
  if coalesce(p_signature, '') not like 'data:image/png;base64,%' or length(p_signature) < 1500 then raise exception 'Falta la firma.'; end if;
  if coalesce(trim(p_form_text), '') = '' then raise exception 'Falta el texto del formato.'; end if;
  insert into public.esop_requests (grant_id, employee_id, units, payment_method, installments, notes, channel,
    signer_name, signer_id_number, form_text, form_hash, signature, signed_at, signed_by, signed_ip, signed_user_agent)
  values (g.id, g.employee_id, p_units, p_method, coalesce(p_installments, 1), nullif(trim(p_notes), ''),
    case when mine is not null and g.employee_id = mine then 'self' else 'people' end,
    trim(p_signer_name), trim(p_signer_id), p_form_text,
    encode(extensions.digest(convert_to(p_form_text, 'UTF8'), 'sha256'), 'hex'), p_signature, now(),
    public.current_member_email(), split_part(coalesce(hdr ->> 'x-forwarded-for', hdr ->> 'x-real-ip', ''), ',', 1), left(hdr ->> 'user-agent', 300))
  returning id into new_id;
  return new_id;
end;
$$;
revoke all on function public.esop_submit_request(uuid, numeric, text, int, text, text, text, text, text) from public, anon;
grant execute on function public.esop_submit_request(uuid, numeric, text, int, text, text, text, text, text) to authenticated;

-- The signed form of one request (People viewers, or the collaborator who owns it).
create or replace function public.esop_request_document(req uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('id', r.id, 'employee', e.name, 'units', r.units, 'payment_method', r.payment_method, 'installments', r.installments,
    'status', r.status, 'price', r.price, 'amount', r.amount, 'signer_name', r.signer_name, 'signer_id_number', r.signer_id_number,
    'form_text', r.form_text, 'form_hash', r.form_hash, 'signature', r.signature, 'signed_at', r.signed_at, 'signed_by', r.signed_by,
    'signed_ip', r.signed_ip, 'signed_user_agent', r.signed_user_agent, 'channel', r.channel,
    'hash_ok', r.form_text is not null and r.form_hash = encode(extensions.digest(convert_to(r.form_text, 'UTF8'), 'sha256'), 'hex'))
  from public.esop_requests r join public.people_employees e on e.id = r.employee_id
  where r.id = req and (public.module_access('people') is not null or r.employee_id = public.self_employee_id());
$$;
revoke all on function public.esop_request_document(uuid) from public, anon;
grant execute on function public.esop_request_document(uuid) to authenticated;

-- Requests are created only through esop_submit_request (signed form), and the signature and
-- form are only read through esop_request_document.
drop policy if exists "People editors create ESOP requests" on public.esop_requests;
revoke insert on table public.esop_requests from authenticated;
revoke select on table public.esop_requests from authenticated;
grant select (id, grant_id, employee_id, units, price, amount, payment_method, installments, status, notes, requested_at, requested_by,
  decided_at, decided_by, decision_note, paid_at, payment_reference, updated_at, updated_by, channel, signer_name, signed_at, signed_by)
  on table public.esop_requests to authenticated;
