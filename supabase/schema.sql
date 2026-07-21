-- Run this once in the Supabase SQL editor (Project -> SQL Editor -> New query).

create table if not exists app_state (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);

alter table app_state enable row level security;

create policy "Authenticated users can read app_state"
  on app_state for select
  to authenticated
  using (true);

create policy "Authenticated users can insert app_state"
  on app_state for insert
  to authenticated
  with check (true);

create policy "Authenticated users can update app_state"
  on app_state for update
  to authenticated
  using (true)
  with check (true);

create policy "Authenticated users can delete app_state"
  on app_state for delete
  to authenticated
  using (true);

-- Team allowlist, managed from the app's "Team Access" tab instead of code.
create table if not exists allowed_users (
  email text primary key,
  added_at timestamptz default now()
);

alter table allowed_users enable row level security;

-- Any signed-in user can check the list (needed to decide if *they* are on it).
create policy "Authenticated users can read allowed_users"
  on allowed_users for select
  to authenticated
  using (true);

-- Only someone already on the list can add or remove entries.
create policy "Allowed users can add allowed_users"
  on allowed_users for insert
  to authenticated
  with check (
    exists (select 1 from allowed_users a where a.email = auth.jwt() ->> 'email')
  );

create policy "Allowed users can delete allowed_users"
  on allowed_users for delete
  to authenticated
  using (
    exists (select 1 from allowed_users a where a.email = auth.jwt() ->> 'email')
  );

insert into allowed_users (email) values
  ('luis@celes.ai'),
  ('oscar@celes.ai'),
  ('natalie.figueroa@celes.ai')
on conflict (email) do nothing;
