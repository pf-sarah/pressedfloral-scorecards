import type { AppData, Employee, Goal, ManagerProfile, Scorecard } from "./types";
import { buildScorecard } from "./score";

export const fixtureAdmin: ManagerProfile = {
  id: "fixture-admin",
  email: "local-dev@pressedfloral.com",
  role: "admin",
  departments: [],
  locations: []
};

export const fixtureManager: ManagerProfile = {
  id: "fixture-manager",
  email: "manager@pressedfloral.com",
  role: "manager",
  departments: ["Design", "Client Care"],
  locations: ["Utah", "Georgia"]
};

export const fixtureMonth = "2026-05";
export const fixturePeriod = "May 2026";

export const fixtureGoals: Goal[] = [
  {
    id: "goal-company-revenue",
    goalTier: "company",
    location: "",
    department: "",
    role: "",
    name: "Company Revenue",
    goalValue: 120000,
    minValue: 90000,
    lowerBetter: false,
    capped: "yes",
    capPct: 150,
    active: true
  },
  {
    id: "goal-client-care-response",
    goalTier: "department",
    location: "Utah",
    department: "Client Care",
    role: "",
    name: "Average First Response Hours",
    goalValue: 2,
    minValue: 4,
    lowerBetter: true,
    capped: "yes",
    capPct: 125,
    active: true
  },
  {
    id: "goal-design-output",
    goalTier: "individual",
    location: "Utah",
    department: "Design",
    role: "Design Specialist",
    name: "Completed Designs",
    goalValue: 42,
    minValue: 30,
    lowerBetter: false,
    capped: "no",
    capPct: 100,
    active: true
  },
  {
    id: "goal-design-rework",
    goalTier: "department",
    location: "Utah",
    department: "Design",
    role: "",
    name: "Design Rework Rate",
    goalValue: 5,
    minValue: 8,
    lowerBetter: true,
    capped: "yes",
    capPct: 120,
    active: true
  }
];

export const fixtureEmployees: Employee[] = [
  {
    id: "emp-ava",
    name: "Ava Jensen",
    role: "Design Specialist",
    department: "Design",
    location: "Utah",
    manager: "Sarah Miller",
    payType: "hourly",
    hourlyRate: 24,
    grossEarnings: 4160,
    hoursWorked: 173.33,
    employmentType: "Full-time"
  },
  {
    id: "emp-mia",
    name: "Mia Carter",
    role: "Client Care Specialist",
    department: "Client Care",
    location: "Utah",
    manager: "Sarah Miller",
    payType: "salary",
    annualPay: 62000,
    grossEarnings: 5166.67,
    hoursWorked: 0,
    employmentType: "Full-time"
  }
];

export const fixtureActuals = {
  [fixturePeriod]: {
    "company|||Company Revenue": 132000,
    "department|Utah|Client Care|Average First Response Hours": 1.8,
    "department|Utah|Design|Design Rework Rate": 4.7,
    "__target__company|||Company Revenue": 120000,
    "__min__company|||Company Revenue": 90000,
    "__target__department||Client Care|Average First Response Hours": 2,
    "__min__department||Client Care|Average First Response Hours": 4,
    "__target__department||Design|Design Rework Rate": 5,
    "__min__department||Design|Design Rework Rate": 8,
    "__target__individual|Utah|Design|Completed Designs": 42,
    "__min__individual|Utah|Design|Completed Designs": 30
  }
};

const scorecardSeed = buildScorecard({
  employee: fixtureEmployees[0],
  month: fixturePeriod,
  periodType: "monthly",
  goals: [
    { ...fixtureGoals[0], scTarget: 120000, scMin: 90000, scActual: 132000, scWeight: 30 },
    { ...fixtureGoals[3], scTarget: 5, scMin: 8, scActual: 4.7, scWeight: 25 },
    { ...fixtureGoals[2], scTarget: 42, scMin: 30, scActual: 47, scWeight: 45 }
  ],
  submittedBy: fixtureAdmin.email
});

export const fixtureScorecards: Scorecard[] = [
  {
    ...scorecardSeed,
    id: "scorecard-ava-may",
    submittedAt: "2026-05-31T18:00:00.000Z"
  }
];

export const fixtureData: AppData = {
  profile: fixtureAdmin,
  goals: fixtureGoals,
  actuals: fixtureActuals,
  rippling: {
    [fixtureMonth]: fixtureEmployees
  },
  scorecards: fixtureScorecards,
  goalAssignments: [],
  employeeScorecardSettings: []
};
