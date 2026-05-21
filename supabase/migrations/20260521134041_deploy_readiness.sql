-- Deploy-readiness hardening for the scorecards app.
-- This migration is intentionally guarded: ambiguous live data cleanup raises
-- an exception instead of deleting or rewriting rows.

create extension if not exists "uuid-ossp";

do $$
begin
  if exists (
    select 1
    from public.rippling_employees legacy
    where legacy.period = 'April 2026'
      and not exists (
        select 1
        from public.rippling_employees iso
        where iso.period = '2026-04'
          and iso.full_name = legacy.full_name
      )
  ) then
    raise exception 'Aborting: found April 2026 Rippling rows without matching 2026-04 employees.';
  end if;

  delete from public.rippling_employees
  where period = 'April 2026';
end $$;

do $$
declare
  invalid_count integer;
  unsafe_count integer;
begin
  select count(*)
    into invalid_count
  from public.scorecards
  where scorecard_month = 'Invalid Date';

  select count(*)
    into unsafe_count
  from public.scorecards
  where scorecard_month = 'Invalid Date'
    and (submitted_at < timestamptz '2026-05-01' or submitted_at >= timestamptz '2026-06-01' or submitted_at is null);

  if invalid_count > 1 then
    raise exception 'Aborting: expected at most one Invalid Date scorecard, found %.', invalid_count;
  end if;

  if unsafe_count > 0 then
    raise exception 'Aborting: Invalid Date scorecard was not submitted during May 2026.';
  end if;

  update public.scorecards
  set scorecard_month = 'April 2026'
  where scorecard_month = 'Invalid Date';
end $$;

do $$
begin
  if exists (
    select 1
    from public.scorecards
    group by employee_name, scorecard_month
    having count(*) > 1
  ) then
    raise exception 'Aborting: duplicate scorecards exist for at least one employee/month.';
  end if;
end $$;

alter table public.manager_profiles
  drop constraint if exists manager_profiles_role_check;

alter table public.manager_profiles
  add constraint manager_profiles_role_check
  check (role = any (array['admin'::text, 'manager'::text, 'user'::text]));

alter table public.scorecards
  add constraint scorecards_employee_month_key
  unique (employee_name, scorecard_month);

create or replace function public.scorecards_current_role()
returns text
language sql
stable
security definer
set search_path = public, auth
as $$
  select coalesce((
    select role
    from public.manager_profiles
    where id = auth.uid()
  ), '');
$$;

create or replace function public.scorecards_current_departments()
returns text[]
language sql
stable
security definer
set search_path = public, auth
as $$
  select coalesce((
    select departments
    from public.manager_profiles
    where id = auth.uid()
  ), array[]::text[]);
$$;

create or replace function public.scorecards_current_locations()
returns text[]
language sql
stable
security definer
set search_path = public, auth
as $$
  select coalesce((
    select locations
    from public.manager_profiles
    where id = auth.uid()
  ), array[]::text[]);
$$;

create or replace function public.scorecards_current_linked_employee()
returns text
language sql
stable
security definer
set search_path = public, auth
as $$
  select coalesce((
    select linked_employee_name
    from public.manager_profiles
    where id = auth.uid()
  ), '');
$$;

create or replace function public.scorecards_can_manage_scope(
  target_goal_tier text,
  target_location text,
  target_department text
)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select case
    when public.scorecards_current_role() = 'admin' then true
    when public.scorecards_current_role() = 'manager'
      and target_goal_tier = any (array['department'::text, 'individual'::text])
      and (
        cardinality(public.scorecards_current_departments()) = 0
        or target_department is null
        or target_department = ''
        or target_department = any (public.scorecards_current_departments())
      )
      and (
        cardinality(public.scorecards_current_locations()) = 0
        or target_location is null
        or target_location = ''
        or target_location = any (public.scorecards_current_locations())
      )
      then true
    else false
  end;
$$;

create or replace function public.scorecards_meta_payload(goal_name text)
returns text
language sql
stable
set search_path = public
as $$
  select regexp_replace(coalesce(goal_name, ''), '^__(target|min|monthly_inactive)__', '');
$$;

create or replace function public.scorecards_meta_part(goal_name text, part_index integer)
returns text
language sql
stable
set search_path = public
as $$
  select nullif(split_part(public.scorecards_meta_payload(goal_name), '|', part_index), '');
$$;

create or replace function public.scorecards_can_manage_actual(
  actual_goal_tier text,
  actual_location text,
  actual_department text,
  actual_goal_name text
)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select case
    when actual_goal_tier = '__meta__' then public.scorecards_can_manage_scope(
      public.scorecards_meta_part(actual_goal_name, 1),
      public.scorecards_meta_part(actual_goal_name, 2),
      public.scorecards_meta_part(actual_goal_name, 3)
    )
    else public.scorecards_can_manage_scope(actual_goal_tier, actual_location, actual_department)
  end;
$$;

create or replace function public.scorecards_can_read_scorecard(
  scorecard_employee_name text,
  scorecard_location text,
  scorecard_department text
)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select case
    when public.scorecards_current_role() = 'admin' then true
    when public.scorecards_current_role() = 'manager'
      and (
        cardinality(public.scorecards_current_departments()) = 0
        or scorecard_department = any (public.scorecards_current_departments())
      )
      and (
        cardinality(public.scorecards_current_locations()) = 0
        or scorecard_location = any (public.scorecards_current_locations())
      )
      then true
    when public.scorecards_current_role() = 'user'
      and scorecard_employee_name = public.scorecards_current_linked_employee()
      then true
    else false
  end;
$$;

alter table public.manager_profiles enable row level security;
alter table public.goals_bank enable row level security;
alter table public.actuals enable row level security;
alter table public.rippling_employees enable row level security;
alter table public.scorecards enable row level security;

drop policy if exists "Admins can write actuals" on public.actuals;
drop policy if exists "Anyone can read actuals" on public.actuals;
drop policy if exists "Admins can delete goals" on public.goals_bank;
drop policy if exists "Anyone can read active goals" on public.goals_bank;
drop policy if exists "Users can insert goals" on public.goals_bank;
drop policy if exists "Users can update goals" on public.goals_bank;
drop policy if exists "Authenticated users can read all profiles" on public.manager_profiles;
drop policy if exists "Service role manages profiles" on public.manager_profiles;
drop policy if exists "Users can read own profile" on public.manager_profiles;
drop policy if exists "Admins can write rippling data" on public.rippling_employees;
drop policy if exists "Authenticated users can read rippling data" on public.rippling_employees;
drop policy if exists "Admins see all scorecards" on public.scorecards;
drop policy if exists "Managers can insert scorecards for their team" on public.scorecards;
drop policy if exists "Managers can update their team scorecards" on public.scorecards;
drop policy if exists "Managers see their team scorecards" on public.scorecards;

create policy "Authenticated users read own profile"
  on public.manager_profiles
  for select
  to authenticated
  using (id = (select auth.uid()) or public.scorecards_current_role() = 'admin');

create policy "Authenticated users read goals"
  on public.goals_bank
  for select
  to authenticated
  using (true);

create policy "Scoped users insert goals"
  on public.goals_bank
  for insert
  to authenticated
  with check (public.scorecards_can_manage_scope(goal_tier, location, department));

create policy "Scoped users update goals"
  on public.goals_bank
  for update
  to authenticated
  using (public.scorecards_can_manage_scope(goal_tier, location, department))
  with check (public.scorecards_can_manage_scope(goal_tier, location, department));

create policy "Scoped users delete goals"
  on public.goals_bank
  for delete
  to authenticated
  using (public.scorecards_can_manage_scope(goal_tier, location, department));

create policy "Authenticated users read actuals"
  on public.actuals
  for select
  to authenticated
  using (true);

create policy "Scoped users insert actuals"
  on public.actuals
  for insert
  to authenticated
  with check (public.scorecards_can_manage_actual(goal_tier, location, department, goal_name));

create policy "Scoped users update actuals"
  on public.actuals
  for update
  to authenticated
  using (public.scorecards_can_manage_actual(goal_tier, location, department, goal_name))
  with check (public.scorecards_can_manage_actual(goal_tier, location, department, goal_name));

create policy "Scoped users delete actuals"
  on public.actuals
  for delete
  to authenticated
  using (public.scorecards_can_manage_actual(goal_tier, location, department, goal_name));

create policy "Authenticated users read rippling data"
  on public.rippling_employees
  for select
  to authenticated
  using (true);

create policy "Admins insert rippling data"
  on public.rippling_employees
  for insert
  to authenticated
  with check (public.scorecards_current_role() = 'admin');

create policy "Admins delete rippling data"
  on public.rippling_employees
  for delete
  to authenticated
  using (public.scorecards_current_role() = 'admin');

create policy "Scoped users read scorecards"
  on public.scorecards
  for select
  to authenticated
  using (public.scorecards_can_read_scorecard(employee_name, location, department));

create policy "Managers insert scorecards"
  on public.scorecards
  for insert
  to authenticated
  with check (
    public.scorecards_current_role() = 'admin'
    or (
      public.scorecards_current_role() = 'manager'
      and public.scorecards_can_read_scorecard(employee_name, location, department)
    )
  );

create policy "Managers update scorecards"
  on public.scorecards
  for update
  to authenticated
  using (
    public.scorecards_current_role() = 'admin'
    or (
      public.scorecards_current_role() = 'manager'
      and public.scorecards_can_read_scorecard(employee_name, location, department)
    )
  )
  with check (
    public.scorecards_current_role() = 'admin'
    or (
      public.scorecards_current_role() = 'manager'
      and public.scorecards_can_read_scorecard(employee_name, location, department)
    )
  );

revoke all on table public.manager_profiles from anon;
revoke all on table public.goals_bank from anon;
revoke all on table public.actuals from anon;
revoke all on table public.rippling_employees from anon;
revoke all on table public.scorecards from anon;

revoke all on table public.manager_profiles from authenticated;
revoke all on table public.goals_bank from authenticated;
revoke all on table public.actuals from authenticated;
revoke all on table public.rippling_employees from authenticated;
revoke all on table public.scorecards from authenticated;

grant select on table public.manager_profiles to authenticated;
grant select, insert, update, delete on table public.goals_bank to authenticated;
grant select, insert, update, delete on table public.actuals to authenticated;
grant select, insert, delete on table public.rippling_employees to authenticated;
grant select, insert, update on table public.scorecards to authenticated;

grant execute on function public.scorecards_current_role() to authenticated;
grant execute on function public.scorecards_current_departments() to authenticated;
grant execute on function public.scorecards_current_locations() to authenticated;
grant execute on function public.scorecards_current_linked_employee() to authenticated;
grant execute on function public.scorecards_can_manage_scope(text, text, text) to authenticated;
grant execute on function public.scorecards_meta_payload(text) to authenticated;
grant execute on function public.scorecards_meta_part(text, integer) to authenticated;
grant execute on function public.scorecards_can_manage_actual(text, text, text, text) to authenticated;
grant execute on function public.scorecards_can_read_scorecard(text, text, text) to authenticated;
