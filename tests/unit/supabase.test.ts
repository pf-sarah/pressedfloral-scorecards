import { describe, expect, it } from "vitest";
import { fixtureGoals, fixtureScorecards } from "../../lib/fixtures";
import { actualsFromRows, goalFromRow, goalToRow, scorecardFromRow, scorecardToRow } from "../../lib/supabase";

describe("supabase mappers", () => {
  it("round trips goals through legacy table columns", () => {
    const row = goalToRow(fixtureGoals[0]);
    expect(row.goal_tier).toBe("company");
    expect(goalFromRow(row)).toMatchObject({
      goalTier: fixtureGoals[0].goalTier,
      name: fixtureGoals[0].name,
      goalValue: fixtureGoals[0].goalValue
    });
  });

  it("maps actual rows to legacy actual keys", () => {
    expect(actualsFromRows([{ goal_tier: "department", location: "Utah", department: "Design", goal_name: "Rework", actual_value: 4 }]))
      .toEqual({ "department|Utah|Design|Rework": 4 });
  });

  it("round trips scorecards through legacy table columns", () => {
    const row = scorecardToRow(fixtureScorecards[0]);
    expect(row.employee_name).toBe("Ava Jensen");
    expect(scorecardFromRow({ ...row, id: "row-1", submitted_at: "now" })).toMatchObject({
      id: "row-1",
      employeeName: "Ava Jensen",
      goals: fixtureScorecards[0].goals
    });
  });
});
