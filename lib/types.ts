export type GoalTier = "company" | "department" | "individual";
export type PayType = "hourly" | "salary";
export type ProfileRole = "admin" | "manager";

export type ManagerProfile = {
  id: string;
  email: string;
  role: ProfileRole;
  departments: string[];
  locations: string[];
};

export type Goal = {
  id: string;
  goalTier: GoalTier;
  location?: string;
  department?: string;
  role?: string;
  name: string;
  goalValue: number;
  minValue: number;
  lowerBetter: boolean;
  capped: "yes" | "no";
  capPct: number;
  active: boolean;
};

export type ActualsByKey = Record<string, number | null>;

export type Employee = {
  id: string;
  name: string;
  role: string;
  department: string;
  location: string;
  manager?: string;
  payType: PayType;
  hourlyRate?: number;
  annualPay?: number;
  grossEarnings?: number;
  hoursWorked?: number;
  isExempt?: boolean;
  employmentType?: string;
};

export type ScorecardGoal = {
  name: string;
  goalTier: GoalTier;
  location?: string;
  department?: string;
  role?: string;
  target: number;
  min: number;
  actual: number | null;
  weight: number;
  lowerBetter: boolean;
  capped: "yes" | "no";
  capPct: number;
  achievement: number;
  weighted: number;
  bonusContribution: number;
  metMin: boolean;
};

export type Scorecard = {
  id: string;
  employeeName: string;
  role: string;
  department: string;
  location: string;
  manager?: string;
  payType: PayType;
  hourlyRate?: number;
  hours?: number;
  annualPay?: number;
  baseEarnings: number;
  bonusPotentialPct: number;
  scorecardMonth: string;
  periodType: "monthly" | "quarterly";
  weightedAchievement: number;
  bonusAmount: number;
  scorecardCapped: boolean;
  flag120: boolean;
  goals: ScorecardGoal[];
  submittedAt?: string;
  submittedBy?: string;
};

export type AppData = {
  profile: ManagerProfile;
  goals: Goal[];
  actuals: Record<string, ActualsByKey>;
  rippling: Record<string, Employee[]>;
  scorecards: Scorecard[];
};

export type HistoryFilters = {
  period: string;
  search: string;
  location: string;
  department: string;
  goal: string;
};

