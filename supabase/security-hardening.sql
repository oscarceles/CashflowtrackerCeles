-- Security hardening + member roles. Run in Supabase -> SQL Editor. Safe to re-run.
--
-- Access model (allowed_users is the member list; nobody outside it gets in):
--   super_admin  : view + edit every module, and manage members.
--   admin        : per-module access chosen in `modules` ("view" or "edit").
--   colaborador  : view-only access to the modules listed in `modules`.
--   board_member : view-only access to Board.
-- Modules: cashflow, board, people.
--
-- Also:
--   * The browser can only touch the Cashflow record in app_state; Board data
--     (board-series-a-tasks) is only reachable through the Netlify functions,
--     which apply the same rules.
--   * Anonymous (not signed-in) requests get no table privileges at all.
--   * Members cannot edit or remove themselves (prevents lockout).
--   * Signup hook: Supabase refuses to create accounts for emails that are not
--     members (enable it in Authentication -> Hooks -> Before User Created).

-- 1. Member columns ------------------------------------------------------
alter table public.allowed_users add column if not exists full_name text;
alter table public.allowed_users add column if not exists modules jsonb not null default '{}'::jsonb;
alter table public.allowed_users add column if not exists updated_at timestamptz default now();
alter table public.allowed_users add column if not exists updated_by text;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'allowed_users' and column_name = 'role'
  ) then
    alter table public.allowed_users add column role text not null default 'colaborador';
    -- One-time migration of existing members, who all had full access before roles.
    update public.allowed_users set role = 'super_admin'
      where email in ('oscar@celes.ai', 'admin@biai.tech');
    update public.allowed_users
      set role = 'admin', modules = '{"cashflow":"edit","board":"edit"}'::jsonb
      where role <> 'super_admin';
  end if;

  if not exists (select 1 from pg_constraint where conname = 'allowed_users_role_check') then
    alter table public.allowed_users add constraint allowed_users_role_check
      check (role in ('super_admin', 'admin', 'colaborador', 'board_member'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'allowed_users_modules_check') then
    alter table public.allowed_users add constraint allowed_users_modules_check
      check (jsonb_typeof(modules) = 'object');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'allowed_users_email_lowercase') then
    alter table public.allowed_users add constraint allowed_users_email_lowercase
      check (email = lower(trim(email))) not valid;
  end if;
end $$;

-- 2. Access helpers (security definer avoids recursive RLS on allowed_users)
create or replace function public.current_member_email()
returns text
language sql
stable
set search_path = ''
as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

create or replace function public.is_allowed_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.allowed_users a where a.email = public.current_member_email()
  );
$$;

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.allowed_users a
    where a.email = public.current_member_email() and a.role = 'super_admin'
  );
$$;

-- Returns 'edit', 'view' or null for the caller on the given module.
create or replace function public.module_access(module text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case a.role
    when 'super_admin' then 'edit'
    when 'board_member' then case when module = 'board' then 'view' end
    when 'admin' then case when a.modules ->> module in ('view', 'edit') then a.modules ->> module end
    when 'colaborador' then case when a.modules ->> module in ('view', 'edit') then 'view' end
  end
  from public.allowed_users a
  where a.email = public.current_member_email();
$$;

revoke all on function public.current_member_email() from public, anon;
revoke all on function public.is_allowed_user() from public, anon;
revoke all on function public.is_super_admin() from public, anon;
revoke all on function public.module_access(text) from public, anon;
grant execute on function public.current_member_email() to authenticated;
grant execute on function public.is_allowed_user() to authenticated;
grant execute on function public.is_super_admin() to authenticated;
grant execute on function public.module_access(text) to authenticated;

-- 3. app_state: Cashflow record only; view to read, edit to write ----------
drop policy if exists "Authenticated users can read app_state" on public.app_state;
drop policy if exists "Authenticated users can insert app_state" on public.app_state;
drop policy if exists "Authenticated users can update app_state" on public.app_state;
drop policy if exists "Authenticated users can delete app_state" on public.app_state;
drop policy if exists "Allowed users can read cashflow state" on public.app_state;
drop policy if exists "Allowed users can insert cashflow state" on public.app_state;
drop policy if exists "Allowed users can update cashflow state" on public.app_state;
drop policy if exists "Allowed users can delete cashflow state" on public.app_state;
drop policy if exists "Cashflow viewers can read cashflow state" on public.app_state;
drop policy if exists "Cashflow editors can insert cashflow state" on public.app_state;
drop policy if exists "Cashflow editors can update cashflow state" on public.app_state;
drop policy if exists "Cashflow editors can delete cashflow state" on public.app_state;

create policy "Cashflow viewers can read cashflow state"
  on public.app_state for select to authenticated
  using (id = 'celes-cashflow-v1' and public.module_access('cashflow') is not null);

create policy "Cashflow editors can insert cashflow state"
  on public.app_state for insert to authenticated
  with check (id = 'celes-cashflow-v1' and public.module_access('cashflow') = 'edit');

create policy "Cashflow editors can update cashflow state"
  on public.app_state for update to authenticated
  using (id = 'celes-cashflow-v1' and public.module_access('cashflow') = 'edit')
  with check (id = 'celes-cashflow-v1' and public.module_access('cashflow') = 'edit');

create policy "Cashflow editors can delete cashflow state"
  on public.app_state for delete to authenticated
  using (id = 'celes-cashflow-v1' and public.module_access('cashflow') = 'edit');

-- 4. allowed_users: own row for everyone; full list and changes for super admins
drop policy if exists "Authenticated users can read allowed_users" on public.allowed_users;
drop policy if exists "Allowed users can add allowed_users" on public.allowed_users;
drop policy if exists "Allowed users can delete allowed_users" on public.allowed_users;
drop policy if exists "Users can read own row or full list if allowed" on public.allowed_users;
drop policy if exists "Allowed users can add lowercase emails" on public.allowed_users;
drop policy if exists "Allowed users can remove others" on public.allowed_users;
drop policy if exists "Members read own row, super admins read all" on public.allowed_users;
drop policy if exists "Super admins add members" on public.allowed_users;
drop policy if exists "Super admins update other members" on public.allowed_users;
drop policy if exists "Super admins remove other members" on public.allowed_users;

create policy "Members read own row, super admins read all"
  on public.allowed_users for select to authenticated
  using (email = public.current_member_email() or public.is_super_admin());

create policy "Super admins add members"
  on public.allowed_users for insert to authenticated
  with check (public.is_super_admin() and email = lower(trim(email)));

create policy "Super admins update other members"
  on public.allowed_users for update to authenticated
  using (public.is_super_admin() and email <> public.current_member_email())
  with check (public.is_super_admin() and email <> public.current_member_email());

create policy "Super admins remove other members"
  on public.allowed_users for delete to authenticated
  using (public.is_super_admin() and email <> public.current_member_email());

revoke all on table public.app_state, public.allowed_users from anon;
-- The primary key (email) cannot be changed; remove and re-add instead.
revoke update on table public.allowed_users from authenticated;
grant update (full_name, role, modules, updated_at, updated_by) on table public.allowed_users to authenticated;

-- 5. Signup hook ("Before User Created"). Enable it in Authentication ->
--    Hooks -> Before User Created -> Postgres -> public.hook_before_user_created.
create or replace function public.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.allowed_users a
    where a.email = lower(coalesce(event -> 'user' ->> 'email', ''))
  ) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message', 'Esta cuenta no tiene acceso a Celes.'
    )
  );
end;
$$;
revoke all on function public.hook_before_user_created(jsonb) from public, anon, authenticated;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;

-- 6. Review: Storage policies. The board-legal-docs bucket must stay private
--    and should have NO policies for anon/authenticated (all access goes
--    through signed URLs created by the Netlify functions). This query should
--    return zero rows mentioning board-legal-docs:
-- select policyname, cmd, roles, qual, with_check
-- from pg_policies where schemaname = 'storage';
