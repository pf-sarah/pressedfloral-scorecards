-- Migration: make department goal targets/minimums location-specific
--
-- Previously, metaKey() stripped location for department goals so that
-- one target entry covered all locations in a department. This caused
-- Design-Utah and Design-Georgia (for example) to share the same targets,
-- meaning editing one silently changed the other.
--
-- The new behaviour mirrors actualKey(): every goal's target/min is keyed
-- by (goalTier, location, department, name), so same-named goals in
-- different locations are fully independent.
--
-- This migration:
--   1. Finds every stored target/min with a locationless department key
--      (old format: __target__department||<dept>|<name>)
--   2. Looks up the goal's location(s) in goals_bank
--   3. Inserts a location-specific copy for each matching location
--   4. Deletes the old locationless key

DO $$
DECLARE
  r         RECORD;
  goal_rec  RECORD;
  stripped  TEXT;   -- the "<dept>|<name>" part after the prefix
  dept_part TEXT;
  name_part TEXT;
  new_key   TEXT;
BEGIN
  FOR r IN
    SELECT period, goal_name, actual_value
    FROM actuals
    WHERE goal_tier = '__meta__'
      AND (
        goal_name LIKE '__target__department||%'
        OR goal_name LIKE '__min__department||%'
      )
  LOOP
    -- Strip known prefix to get "<dept>|<name>"
    IF r.goal_name LIKE '__target__department||%' THEN
      stripped := substring(r.goal_name FROM length('__target__department||') + 1);
    ELSE
      stripped := substring(r.goal_name FROM length('__min__department||') + 1);
    END IF;

    dept_part := split_part(stripped, '|', 1);
    -- Goal name is everything after the first pipe (handles names that contain pipes)
    name_part := substring(stripped FROM length(dept_part) + 2);

    -- Insert a location-specific entry for every matching goal that has a location
    FOR goal_rec IN
      SELECT DISTINCT location
      FROM goals_bank
      WHERE goal_tier = 'department'
        AND department = dept_part
        AND name = name_part
        AND location IS NOT NULL
        AND location <> ''
    LOOP
      IF r.goal_name LIKE '__target__%' THEN
        new_key := '__target__department|' || goal_rec.location || '|' || stripped;
      ELSE
        new_key := '__min__department|' || goal_rec.location || '|' || stripped;
      END IF;

      INSERT INTO actuals (period, goal_tier, location, department, goal_name, actual_value)
      VALUES (r.period, '__meta__', NULL, NULL, new_key, r.actual_value)
      ON CONFLICT (period, goal_tier, location, department, goal_name) DO NOTHING;
    END LOOP;

    -- Remove the old locationless key
    DELETE FROM actuals
    WHERE period   = r.period
      AND goal_tier = '__meta__'
      AND goal_name = r.goal_name;
  END LOOP;
END $$;
