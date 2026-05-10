import { describe, expect, it } from "vitest";
import { fixtureEmployees, fixtureGoals, fixturePeriod } from "../../lib/fixtures";
import { baseEarnings, buildScorecard, calculateGoal } from "../../lib/score";

describe("score calculations", () => {
  it("calculates higher-is-better goals", () => {
    const result = calculateGoal({
      goal: fixtureGoals[0],
      target: 100,
      min: 80,
      actual: 120,
      weight: 50,
      baseEarnings: 1000
    });
    expect(result.metMin).toBe(true);
    expect(result.achievement).toBe(120);
    expect(result.weighted).toBe(60);
    expect(result.bonusContribution).toBe(60);
  });

  it("calculates lower-is-better goals and applies caps", () => {
    const result = calculateGoal({
      goal: { ...fixtureGoals[1], capPct: 125 },
      target: 2,
      min: 4,
      actual: 1,
      weight: 20,
      baseEarnings: 2000
    });
    expect(result.metMin).toBe(true);
    expect(result.achievement).toBe(125);
    expect(result.weighted).toBe(25);
  });

  it("zeros out goals below minimum", () => {
    const result = calculateGoal({
      goal: fixtureGoals[2],
      target: 40,
      min: 30,
      actual: 20,
      weight: 40,
      baseEarnings: 1000
    });
    expect(result.metMin).toBe(false);
    expect(result.achievement).toBe(0);
    expect(result.bonusContribution).toBe(0);
  });

  it("caps total scorecards at 200 percent", () => {
    const scorecard = buildScorecard({
      employee: { ...fixtureEmployees[0], grossEarnings: 1000 },
      month: fixturePeriod,
      periodType: "monthly",
      goals: [
        { ...fixtureGoals[2], scTarget: 10, scMin: 1, scActual: 50, scWeight: 100 }
      ]
    });
    expect(scorecard.weightedAchievement).toBeGreaterThan(200);
    expect(scorecard.scorecardCapped).toBe(true);
    expect(scorecard.bonusAmount).toBe(200);
  });

  it("handles hourly and salary base earnings", () => {
    expect(baseEarnings({ payType: "hourly", hourlyRate: 20, hours: 10 })).toBe(200);
    expect(baseEarnings({ payType: "salary", annualPay: 120000, periodType: "monthly" })).toBe(10000);
    expect(baseEarnings({ payType: "salary", annualPay: 120000, periodType: "quarterly" })).toBe(30000);
  });
});
