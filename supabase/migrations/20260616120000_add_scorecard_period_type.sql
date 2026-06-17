-- Add per-user scorecard period type preference.
-- Employees linked to a user with scorecardPeriodType = 'quarterly' will
-- only appear in the quarterly scorecard tab and only receive quarterly goals.
alter table public.manager_profiles
  add column if not exists scorecard_period_type text not null default 'monthly';
