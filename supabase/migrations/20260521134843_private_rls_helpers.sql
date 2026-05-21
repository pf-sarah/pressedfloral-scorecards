-- Keep RLS helper functions out of the exposed public API schema.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

alter function public.scorecards_current_role() set schema private;
alter function public.scorecards_current_departments() set schema private;
alter function public.scorecards_current_locations() set schema private;
alter function public.scorecards_current_linked_employee() set schema private;
alter function public.scorecards_can_manage_scope(text, text, text) set schema private;
alter function public.scorecards_meta_payload(text) set schema private;
alter function public.scorecards_meta_part(text, integer) set schema private;
alter function public.scorecards_can_manage_actual(text, text, text, text) set schema private;
alter function public.scorecards_can_read_scorecard(text, text, text) set schema private;

revoke execute on function private.scorecards_current_role() from public, anon;
revoke execute on function private.scorecards_current_departments() from public, anon;
revoke execute on function private.scorecards_current_locations() from public, anon;
revoke execute on function private.scorecards_current_linked_employee() from public, anon;
revoke execute on function private.scorecards_can_manage_scope(text, text, text) from public, anon;
revoke execute on function private.scorecards_meta_payload(text) from public, anon;
revoke execute on function private.scorecards_meta_part(text, integer) from public, anon;
revoke execute on function private.scorecards_can_manage_actual(text, text, text, text) from public, anon;
revoke execute on function private.scorecards_can_read_scorecard(text, text, text) from public, anon;

grant execute on function private.scorecards_current_role() to authenticated;
grant execute on function private.scorecards_current_departments() to authenticated;
grant execute on function private.scorecards_current_locations() to authenticated;
grant execute on function private.scorecards_current_linked_employee() to authenticated;
grant execute on function private.scorecards_can_manage_scope(text, text, text) to authenticated;
grant execute on function private.scorecards_meta_payload(text) to authenticated;
grant execute on function private.scorecards_meta_part(text, integer) to authenticated;
grant execute on function private.scorecards_can_manage_actual(text, text, text, text) to authenticated;
grant execute on function private.scorecards_can_read_scorecard(text, text, text) to authenticated;

create or replace function public.update_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
