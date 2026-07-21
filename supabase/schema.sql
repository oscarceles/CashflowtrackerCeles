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
