import { createClient } from "@supabase/supabase-js";
import type { ActualsByKey, Employee, Goal, ManagerProfile, Scorecard } from "./types";

const DEFAULT_SUPABASE_URL = "https://mwwqeakjxmpticvbpinc.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im13d3FlYWtqeG1wdGljdmJwaW5jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5NjIxMjUsImV4cCI6MjA5MjUzODEyNX0.sqOElnGDRM2X2-TT1iMrnPBa_HK0ndDZ_31iP40jsiE";

export const dataMode = process.env.NEXT_PUBLIC_SCORECARDS_DATA_MODE === "fixture" ? "fixture" : "supabase";

export function supabaseClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY
  );
}

export function goalFromRow(row: Record<string, any>): Goal {
  return {
    id: String(row.id),
    goalTier: row.goal_tier,
    location: row.location || "",
    department: row.department || "",
    role: row.role || "",
    name: row.name,
    goalValue: Number(row.goal_value) || 0,
    minValue: Number(row.min_value) || 0,
    lowerBetter: row.lower_better !== false,
    capped: row.capped || "no",
    capPct: Number(row.cap_pct) || 100,
    active: row.active !== false
  };
}

export function goalToRow(goal: Goal) {
  return {
    id: goal.id,
    goal_tier: goal.goalTier,
    location: goal.location || null,
    department: goal.department || null,
    role: goal.role || null,
    name: goal.name,
    goal_value: goal.goalValue,
    min_value: goal.minValue,
    lower_better: goal.lowerBetter,
    capped: goal.capped,
    cap_pct: goal.capPct,
    active: goal.active
  };
}

export function employeeFromRow(row: Record<string, any>): Employee {
  return {
    id: String(row.id || row.full_name),
    name: row.full_name,
    role: row.role || "",
    department: row.department || "",
    location: row.location || "",
    manager: row.manager || "",
    payType: row.pay_type || "hourly",
    hourlyRate: row.hourly_rate,
    annualPay: row.annual_pay,
    grossEarnings: row.gross_earnings,
    hoursWorked: row.hours_worked,
    isExempt: row.is_exempt,
    employmentType: row.employment_type
  };
}

export function employeeToRow(period: string, employee: Employee) {
  return {
    period,
    full_name: employee.name,
    role: employee.role,
    department: employee.department,
    location: employee.location,
    manager: employee.manager || null,
    pay_type: employee.payType,
    hourly_rate: employee.hourlyRate || null,
    annual_pay: employee.annualPay || null,
    gross_earnings: employee.grossEarnings || null,
    hours_worked: employee.hoursWorked || null,
    is_exempt: employee.isExempt || false,
    employment_type: employee.employmentType || null
  };
}

export function profileFromRow(email: string, row: Record<string, any>): ManagerProfile {
  return {
    id: String(row.id),
    email,
    role: row.role || "manager",
    departments: row.departments || [],
    locations: row.locations || [],
    linkedEmployeeName: row.linked_employee_name || undefined
  };
}

export function actualsFromRows(rows: Record<string, any>[]): ActualsByKey {
  const map: ActualsByKey = {};
  for (const row of rows) {
    const goalName = row.goal_name || "";
    if (goalName.startsWith("__target__") || goalName.startsWith("__min__")) {
      map[goalName] = row.actual_value;
    } else {
      map[[row.goal_tier, row.location || "", row.department || "", goalName].join("|")] = row.actual_value;
    }
  }
  return map;
}

export function scorecardToRow(scorecard: Scorecard) {
  return {
    employee_name: scorecard.employeeName,
    role: scorecard.role,
    department: scorecard.department,
    location: scorecard.location,
    manager: scorecard.manager || null,
    pay_type: scorecard.payType,
    hourly_rate: scorecard.hourlyRate || null,
    hours_worked: scorecard.hours || null,
    annual_pay: scorecard.annualPay || null,
    base_earnings: scorecard.baseEarnings,
    bonus_potential_pct: scorecard.bonusPotentialPct,
    scorecard_month: scorecard.scorecardMonth,
    period_type: scorecard.periodType,
    weighted_achievement: scorecard.weightedAchievement,
    bonus_amount: scorecard.bonusAmount,
    scorecard_capped: scorecard.scorecardCapped,
    flag_120: scorecard.flag120,
    goals: scorecard.goals,
    submitted_by: scorecard.submittedBy || null
  };
}

export function scorecardFromRow(row: Record<string, any>): Scorecard {
  return {
    id: String(row.id),
    employeeName: row.employee_name,
    role: row.role,
    department: row.department,
    location: row.location,
    manager: row.manager,
    payType: row.pay_type,
    hourlyRate: row.hourly_rate,
    hours: row.hours_worked,
    annualPay: row.annual_pay,
    baseEarnings: row.base_earnings,
    bonusPotentialPct: row.bonus_potential_pct || 10,
    scorecardMonth: row.scorecard_month,
    periodType: row.period_type || "monthly",
    weightedAchievement: row.weighted_achievement,
    bonusAmount: row.bonus_amount,
    scorecardCapped: row.scorecard_capped,
    flag120: row.flag_120,
    goals: row.goals || [],
    submittedAt: row.submitted_at,
    submittedBy: row.submitted_by
  };
}

