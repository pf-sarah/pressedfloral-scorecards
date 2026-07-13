-- Let an admin grant a manager (and everyone under them in the Rippling
-- reporting tree) read/write access to company-tier goals, without making
-- them a full admin. Company goals carry no department/location/employee of
-- their own, so this can't be scoped the way department/individual goals
-- are — it needs its own grant + reporting-tree check.

alter table public.manager_profiles
  add column if not exists company_goals_grant boolean not null default false;

create or replace function private.scorecards_has_company_goal_access()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  with recursive me as (
    select
      role,
      linked_employee_name,
      coalesce(company_goals_grant, false) as own_grant
    from public.manager_profiles
    where id = auth.uid()
  ),
  latest_period as (
    select max(period) as period from public.rippling_employees
  ),
  granted_managers as (
    select linked_employee_name
    from public.manager_profiles
    where company_goals_grant = true
      and linked_employee_name is not null
      and linked_employee_name <> ''
  ),
  ancestors as (
    select re.full_name, re.manager
    from public.rippling_employees re, latest_period lp, me
    where re.period = lp.period
      and re.full_name = me.linked_employee_name
    union
    select re.full_name, re.manager
    from public.rippling_employees re, latest_period lp, ancestors a
    where re.period = lp.period
      and re.full_name = a.manager
  )
  select
    coalesce((select role from me), '') = 'admin'
    or coalesce((select own_grant from me), false)
    or exists (
      select 1
      from ancestors a
      join granted_managers g on g.linked_employee_name = a.manager
    );
$$;

revoke execute on function private.scorecards_has_company_goal_access() from public, anon;
grant execute on function private.scorecards_has_company_goal_access() to authenticated;

create or replace function private.scorecards_can_manage_scope(
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
    when private.scorecards_current_role() = 'admin' then true
    when target_goal_tier = 'company' then private.scorecards_has_company_goal_access()
    when private.scorecards_current_role() = 'manager'
      and target_goal_tier = any (array['department'::text, 'individual'::text])
      and (
        cardinality(private.scorecards_current_departments()) = 0
        or target_department is null
        or target_department = ''
        or target_department = any (private.scorecards_current_departments())
      )
      and (
        cardinality(private.scorecards_current_locations()) = 0
        or target_location is null
        or target_location = ''
        or target_location = any (private.scorecards_current_locations())
      )
      then true
    else false
  end;
$$;

revoke execute on function private.scorecards_can_manage_scope(text, text, text) from public, anon;
grant execute on function private.scorecards_can_manage_scope(text, text, text) to authenticated;

-- scorecards_can_manage_actual and scorecards_meta_part still called their
-- sibling helpers as "public.*" from before the 20260521134843 migration
-- moved those helpers into the private schema. LANGUAGE SQL bodies re-resolve
-- schema-qualified names against the live catalog on every call (unlike RLS
-- policy expressions, which bind by OID at creation time), so those calls
-- were pointing at functions that no longer exist in public. Repointing them
-- at private.* here — this is on the same call chain actuals writes for
-- company goals depend on.
create or replace function private.scorecards_meta_part(goal_name text, part_index integer)
returns text
language sql
stable
set search_path = public
as $$
  select nullif(split_part(private.scorecards_meta_payload(goal_name), '|', part_index), '');
$$;

create or replace function private.scorecards_can_manage_actual(
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
    when actual_goal_tier = '__meta__' then private.scorecards_can_manage_scope(
      private.scorecards_meta_part(actual_goal_name, 1),
      private.scorecards_meta_part(actual_goal_name, 2),
      private.scorecards_meta_part(actual_goal_name, 3)
    )
    else private.scorecards_can_manage_scope(actual_goal_tier, actual_location, actual_department)
  end;
$$;
