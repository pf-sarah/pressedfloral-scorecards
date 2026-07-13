-- Fix employee_scorecard_settings: add unique constraint so upserts work correctly.
-- Without this, every save created a new row; on refresh the app found the oldest
-- row (no exclusions) and goal removals/additions appeared to reset.

-- Create the table if it was never formally migrated
create table if not exists public.employee_scorecard_settings (
  id          bigint generated always as identity primary key,
  employee_name  text not null,
  period_type    text not null default 'monthly',
  excluded_goal_ids text[] not null default '{}',
  added_goal_ids    text[] not null default '{}',
  weight_overrides  jsonb not null default '{}',
  updated_at  timestamptz,
  updated_by  text
);

-- De-duplicate: for each (employee_name, period_type) group, keep only the
-- most recently updated row and delete the rest.
delete from public.employee_scorecard_settings
where id not in (
  select distinct on (employee_name, period_type) id
  from public.employee_scorecard_settings
  order by employee_name, period_type, updated_at desc nulls last, id desc
);

-- Now add the unique constraint so future upserts update in place.
alter table public.employee_scorecard_settings
  drop constraint if exists employee_scorecard_settings_employee_period_key;

alter table public.employee_scorecard_settings
  add constraint employee_scorecard_settings_employee_period_key
  unique (employee_name, period_type);

-- goal_assignments: create if missing and ensure no infinite-duplicate accumulation.
create table if not exists public.goal_assignments (
  id           bigint generated always as identity primary key,
  goal_id      text not null,
  employee_name text not null,
  start_month  text not null,
  end_month    text,
  created_by   text,
  created_at   timestamptz
);

-- Remove exact duplicates on (goal_id, employee_name, start_month) keeping the newest.
delete from public.goal_assignments
where id not in (
  select distinct on (goal_id, employee_name, start_month) id
  from public.goal_assignments
  order by goal_id, employee_name, start_month, created_at desc nulls last, id desc
);

-- RLS for employee_scorecard_settings — reads/writes go through service-role API,
-- but enable RLS so the table is not publicly accessible.
alter table public.employee_scorecard_settings enable row level security;

drop policy if exists "Service role manages scorecard settings" on public.employee_scorecard_settings;
create policy "Service role manages scorecard settings"
  on public.employee_scorecard_settings
  for all
  to service_role
  using (true)
  with check (true);

-- RLS for goal_assignments — same pattern.
alter table public.goal_assignments enable row level security;

drop policy if exists "Authenticated users read goal assignments" on public.goal_assignments;
create policy "Authenticated users read goal assignments"
  on public.goal_assignments
  for select
  to authenticated
  using (true);

drop policy if exists "Service role manages goal assignments" on public.goal_assignments;
create policy "Service role manages goal assignments"
  on public.goal_assignments
  for all
  to service_role
  using (true)
  with check (true);

-- Grant read access so the client anon queries can load assignments on startup.
grant select on table public.employee_scorecard_settings to authenticated;
grant select on table public.goal_assignments to authenticated;
