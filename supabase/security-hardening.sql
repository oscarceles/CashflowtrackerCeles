-- Security hardening. Run once in Supabase -> SQL Editor. Safe to re-run.
--
-- What it does:
--   1. Database access requires being on allowed_users (not just "signed in").
--   2. The browser can only touch the Cashflow record; Board data
--      (board-series-a-tasks) is only reachable through the Netlify functions.
--   3. Anonymous (not signed-in) requests get no table privileges at all.
--   4. Team members cannot remove themselves; emails are stored lowercase.
--   5. Optional signup hook: Supabase refuses to create accounts for emails
--      that are not on allowed_users (enable it in Authentication -> Hooks).

-- 1. Helper: is the caller on the allowlist? security definer avoids
--    recursive RLS evaluation on allowed_users.
create or replace function public.is_allowed_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.allowed_users a
    where a.email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke all on function public.is_allowed_user() from public, anon;
grant execute on function public.is_allowed_user() to authenticated;

-- 2. app_state: only allowlisted users, only the Cashflow record.
drop policy if exists "Authenticated users can read app_state" on public.app_state;
drop policy if exists "Authenticated users can insert app_state" on public.app_state;
drop policy if exists "Authenticated users can update app_state" on public.app_state;
drop policy if exists "Authenticated users can delete app_state" on public.app_state;
drop policy if exists "Allowed users can read cashflow state" on public.app_state;
drop policy if exists "Allowed users can insert cashflow state" on public.app_state;
drop policy if exists "Allowed users can update cashflow state" on public.app_state;
drop policy if exists "Allowed users can delete cashflow state" on public.app_state;

create policy "Allowed users can read cashflow state"
  on public.app_state for select to authenticated
  using (id = 'celes-cashflow-v1' and public.is_allowed_user());

create policy "Allowed users can insert cashflow state"
  on public.app_state for insert to authenticated
  with check (id = 'celes-cashflow-v1' and public.is_allowed_user());

create policy "Allowed users can update cashflow state"
  on public.app_state for update to authenticated
  using (id = 'celes-cashflow-v1' and public.is_allowed_user())
  with check (id = 'celes-cashflow-v1' and public.is_allowed_user());

create policy "Allowed users can delete cashflow state"
  on public.app_state for delete to authenticated
  using (id = 'celes-cashflow-v1' and public.is_allowed_user());

-- 3. allowed_users: a signed-in user can only see their own row unless they
--    are on the list; only listed users can add/remove; nobody removes
--    themselves.
drop policy if exists "Authenticated users can read allowed_users" on public.allowed_users;
drop policy if exists "Allowed users can add allowed_users" on public.allowed_users;
drop policy if exists "Allowed users can delete allowed_users" on public.allowed_users;
drop policy if exists "Users can read own row or full list if allowed" on public.allowed_users;
drop policy if exists "Allowed users can add lowercase emails" on public.allowed_users;
drop policy if exists "Allowed users can remove others" on public.allowed_users;

create policy "Users can read own row or full list if allowed"
  on public.allowed_users for select to authenticated
  using (
    email = lower(coalesce(auth.jwt() ->> 'email', ''))
    or public.is_allowed_user()
  );

create policy "Allowed users can add lowercase emails"
  on public.allowed_users for insert to authenticated
  with check (public.is_allowed_user() and email = lower(trim(email)));

create policy "Allowed users can remove others"
  on public.allowed_users for delete to authenticated
  using (
    public.is_allowed_user()
    and email <> lower(coalesce(auth.jwt() ->> 'email', ''))
  );

-- Anonymous visitors get nothing; signed-in users get only what RLS allows.
revoke all on table public.app_state, public.allowed_users from anon;
revoke update on table public.allowed_users from authenticated;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'allowed_users_email_lowercase'
  ) then
    alter table public.allowed_users
      add constraint allowed_users_email_lowercase
      check (email = lower(trim(email))) not valid;
  end if;
end $$;

-- 4. Signup hook ("Before User Created"). After running this file, enable it
--    in Authentication -> Hooks -> Before User Created -> Postgres function
--    public.hook_before_user_created. New accounts (Google, magic link or
--    password) are then only created for emails on allowed_users.
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

-- 5. Review: Storage policies. The board-legal-docs bucket must stay private
--    and should have NO policies for anon/authenticated (all access goes
--    through signed URLs created by the Netlify functions). This query should
--    return zero rows mentioning board-legal-docs:
-- select policyname, cmd, roles, qual, with_check
-- from pg_policies where schemaname = 'storage';
