// Maps pf-dashboard's computed monthly KPIs onto this app's `actuals` table so
// managers don't have to hand-type numbers that already exist upstream.
//
// Scope is deliberately narrow: only goals in departments pf-dashboard actually
// computes (Design, Preservation, Fulfillment, Resin, or the Georgia/Utah
// "Operations" rollup bucket) whose name is ratio/CPO-shaped. Anything else is
// left completely alone — see the mapping table in the implementation plan for
// the full rationale, including the two cases intentionally left unmapped
// ("Team Ratio Attainment" for Resin, and any goal outside the patterns below).

import { actualKey } from "./scorecardCompletion";
import { formatMonthLabel } from "./periods";
import type { Goal } from "./types";

// ── Minimal shapes of pf-dashboard's API responses (can't import cross-repo) ───

interface PfKpiMetrics {
  ratio: number | null;
  cpo: number | null;
  cpoWithGM: number | null;
  production: number;
}

interface PfPeriodKpis {
  design: PfKpiMetrics;
  preservation: PfKpiMetrics;
  fulfillment: PfKpiMetrics;
  resin: PfKpiMetrics;
  ga: PfKpiMetrics;
  combined: PfKpiMetrics;
}

interface PfWindowResult {
  periodStart: string; // "YYYY-MM-DD"
  utah: PfPeriodKpis;
  georgia: PfPeriodKpis;
  combined: PfPeriodKpis;
}

interface PfMemberRatio {
  name: string;
  department: string;
  ratio: number | null;
}

interface PfScorecardMonthData {
  memberRatios: PfMemberRatio[];
}

// ── Public types ─────────────────────────────────────────────────────────────

export interface PfSyncWrite {
  goalId: string;
  period: string;
  goalTier: string;
  location: string;
  department: string;
  goalName: string;
  value: number;
}

export interface PfSyncResult {
  period: string;
  considered: number;
  writes: PfSyncWrite[];
}

// ── Department bucket helpers ───────────────────────────────────────────────

const PF_DEPTS = new Set(["Design", "Preservation", "Fulfillment", "Resin"]);

const DEPT_KEY: Record<string, keyof PfPeriodKpis> = {
  Design: "design",
  Preservation: "preservation",
  Fulfillment: "fulfillment",
  Resin: "resin",
};

const RATIO_RE = /ratio/i;
const CPO_RE = /cost per order|\bcpo\b/i;

function pickLocation(window: PfWindowResult, location: string): PfPeriodKpis {
  if (location === "Utah") return window.utah;
  if (location === "Georgia") return window.georgia;
  return window.combined;
}

// ── Value resolution ─────────────────────────────────────────────────────────

function resolveIndividualValue(goal: Goal, memberRatiosByLoc: Record<string, PfMemberRatio[]>): number | null {
  if (!goal.employeeName) return null; // role-only template — no specific person to attribute a number to
  const dept = goal.department || "";
  if (!PF_DEPTS.has(dept)) return null;
  if (!RATIO_RE.test(goal.name)) return null;

  const pool = memberRatiosByLoc[goal.location || ""] || [];
  const norm = (s: string) => s.trim().toLowerCase();
  const match = pool.find((m) => norm(m.name) === norm(goal.employeeName!) && m.department === dept);
  return match?.ratio ?? null;
}

function resolveDepartmentValue(goal: Goal, window: PfWindowResult): number | null {
  const dept = goal.department || "";
  const name = goal.name;
  const period = pickLocation(window, goal.location || "");

  if (PF_DEPTS.has(dept)) {
    const metrics = period[DEPT_KEY[dept]];
    // Production-count goals — verified against live June actuals: Georgia
    // Design production (317) matched both "Monthly Frame Goal" and
    // "Frames Completed"; Georgia Fulfillment production (261) matched both
    // "Frames Sealed" entries; Utah Design production (488) matched "Monthly
    // Frame Goal". "Boxes Shipped" (Utah/Fulfillment) follows the same
    // Fulfillment-production pattern by analogy — no manual June value existed
    // yet to cross-check it directly.
    if (dept === "Design" && name.trim() === "Monthly Frame Goal") return metrics.production;
    if (dept === "Fulfillment" && /frames sealed|boxes shipped/i.test(name)) return metrics.production;
    if (dept === "Resin") {
      // The only ratio-named goal actually filed under department=Resin today
      // is "Team Ratio Attainment", intentionally left unmapped pending
      // clarification of what it measures relative to "Resin Ratio
      // Attainment" (which lives under department=Operations — see below).
      if (CPO_RE.test(name)) return metrics.cpo;
      return null;
    }
    if (RATIO_RE.test(name)) return metrics.ratio;
    if (CPO_RE.test(name)) return metrics.cpo;
    return null;
  }

  if (dept === "Operations") {
    const suffixMatch = name.match(/-\s*(Design|Fulfillment|Preservation)\s*$/i);
    if (suffixMatch) {
      const subDept = suffixMatch[1][0].toUpperCase() + suffixMatch[1].slice(1).toLowerCase();
      const metrics = period[DEPT_KEY[subDept]];
      if (RATIO_RE.test(name)) return metrics.ratio;
      if (CPO_RE.test(name)) return metrics.cpo;
      return null;
    }
    // Unsuffixed "Frames Completed"/"Frames Sealed" under the Operations
    // rollup are Design's and Fulfillment's own production counts,
    // respectively — confirmed exact-match against live June actuals (see
    // above).
    if (name.trim() === "Frames Completed") return period.design.production;
    if (/frames sealed/i.test(name)) return period.fulfillment.production;
    // "- GM" is the GM's own scorecard slice of the location-wide CPO — the
    // same standard (Excl. GM) figure as Utah's unsuffixed goal below, not the
    // Incl.-GM number. "Incl. GM" on the dashboard is an internal-awareness
    // view only, never what a goal actual should hold (confirmed with the user).
    if (/cost per order\s*-\s*gm/i.test(name)) return period.combined.cpo;
    // Utah's Operations bucket doesn't split into per-sub-department goals the
    // way Georgia's does — its plain, unsuffixed ratio/CPO goal represents the
    // location's own blended figure (confirmed with the user).
    if (goal.location === "Utah" && name.trim() === "Combined Ratio Attainment") return period.combined.ratio;
    if (goal.location === "Utah" && name.trim() === "Cost Per Order") return period.combined.cpo;
    // "Resin Ratio Attainment" is filed under the Operations bucket, not
    // department=Resin (confirmed against live goals_bank data).
    if (goal.location === "Utah" && name.trim() === "Resin Ratio Attainment") return period.resin.ratio;
    return null;
  }

  return null;
}

function resolveCompanyValue(goal: Goal, window: PfWindowResult): number | null {
  if (goal.department !== "Operations") return null;
  if (!/Company Ratio attainment/i.test(goal.name)) return null;
  return pickLocation(window, goal.location || "").combined.ratio;
}

function resolveValue(goal: Goal, window: PfWindowResult, memberRatiosByLoc: Record<string, PfMemberRatio[]>): number | null {
  if (goal.goalTier === "individual") return resolveIndividualValue(goal, memberRatiosByLoc);
  if (goal.goalTier === "department") return resolveDepartmentValue(goal, window);
  if (goal.goalTier === "company") return resolveCompanyValue(goal, window);
  return null;
}

// ── pf-dashboard fetch helpers ──────────────────────────────────────────────

async function fetchPfDashboard(baseUrl: string, syncSecret: string, path: string): Promise<any> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${syncSecret}` },
  });
  if (!res.ok) {
    throw new Error(`pf-dashboard request failed (${res.status}): ${path}`);
  }
  return res.json();
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function computePfDashboardSync(params: {
  targetMonth: string; // "YYYY-MM"
  baseUrl: string;
  syncSecret: string;
  goals: Goal[]; // active goals only
}): Promise<PfSyncResult> {
  const { targetMonth, baseUrl, syncSecret, goals } = params;
  const period = formatMonthLabel(targetMonth);

  const [kpisData, scorecardData] = await Promise.all([
    fetchPfDashboard(baseUrl, syncSecret, `/api/kpis?windows=${encodeURIComponent("monthly-24")}`),
    fetchPfDashboard(
      baseUrl,
      syncSecret,
      `/api/scorecard?location=both&month=${encodeURIComponent(targetMonth)}&months=24`
    ),
  ]);

  const windows: PfWindowResult[] = kpisData.windows ?? [];
  const targetWindow = windows.find((w) => w.periodStart === `${targetMonth}-01`);
  if (!targetWindow) {
    throw new Error(`No pf-dashboard KPI window found for ${targetMonth} — is that month in range?`);
  }

  const byLocation = scorecardData.byLocation ?? {};
  const memberRatiosByLoc: Record<string, PfMemberRatio[]> = {
    Utah: (byLocation.Utah?.[targetMonth] as PfScorecardMonthData | undefined)?.memberRatios ?? [],
    Georgia: (byLocation.Georgia?.[targetMonth] as PfScorecardMonthData | undefined)?.memberRatios ?? [],
  };

  const writes: PfSyncWrite[] = [];

  for (const goal of goals) {
    const value = resolveValue(goal, targetWindow, memberRatiosByLoc);
    if (value === null || value === undefined || Number.isNaN(value)) continue;

    const [goalTier, location, department, goalName] = actualKey(goal).split("|");
    writes.push({ goalId: goal.id, period, goalTier, location, department, goalName, value });
  }

  return { period, considered: goals.length, writes };
}
