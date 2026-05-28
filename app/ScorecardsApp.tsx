"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  normalizeAdminUserPayload,
  scopeSummary,
  SCORECARD_DEPARTMENTS,
  SCORECARD_LOCATIONS,
  type AdminManagedUser,
  type AdminUserPayload
} from "../lib/adminUsers";
import { downloadCsv, parseRipplingEmployees, scorecardsToCsv, toCsv } from "../lib/csv";
import { fixtureData, fixtureManager, fixtureMonth, fixturePeriod } from "../lib/fixtures";
import { currentMonthValue, formatMonthLabel } from "../lib/periods";
import { baseEarnings, buildScorecard, calculateGoal, formatCurrency, formatNumber, type EditableGoal } from "../lib/score";
import {
  hydrateFromLocalStorage,
  persistActuals,
  persistGoals,
  persistRippling,
  persistScorecard,
  PROFILE_EMAIL_KEY,
  PROFILE_ROLE_KEY
} from "../lib/storage";
import {
  actualsFromRows,
  configuredProfileFromRow,
  dataMode,
  employeeFromRow,
  employeeToRow,
  goalFromRow,
  goalToRow,
  isSupabaseUuid,
  scorecardFromRow,
  scorecardToRow,
  supabaseClient
} from "../lib/supabase";
import type { ActualsByKey, AppData, Employee, Goal, GoalTier, HistoryFilters, ManagerProfile, ProfileRole, Scorecard } from "../lib/types";

type Screen = "landing" | "setup" | "scorecard" | "history" | "rippling" | "guide" | "todos" | "migrate" | "whatif" | "personal" | "users";
type HistoryView = "table" | "scorecard" | "grid" | "chart";

/** Derive a "First Last" candidate name from an email like kanon.foote@domain.com */
function nameFromEmail(email: string): string {
  const local = (email || "").split("@")[0];
  const parts = local.split(/[._-]/);
  if (parts.length < 2) return "";
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(" ");
}

const departments = SCORECARD_DEPARTMENTS;
const locations = SCORECARD_LOCATIONS;

const rolesByDepartment: Record<string, string[]> = {
  "Client Care": ["Client Care Manager", "Client Care Specialist", "Client Experience Manager", "Senior Client Care Specialist"],
  Design: ["Design Specialist", "Design Team Manager", "Senior Design Specialist"],
  Experience: ["Director of Product & Client Experience", "Product & Design Lead", "UX Design Specialist"],
  Fulfillment: ["Fulfillment Specialist", "Fulfillment Team Manager", "Senior Fulfillment Specialist"],
  "General & Administrative": ["Human Resources Manager"],
  Growth: ["Business Development Manager"],
  Marketing: ["Community Specialist", "Head of Marketing", "Social Media Manager", "Social Media Specialist"],
  Operations: ["Director of Operations", "General Manager", "Head of Preservation & Design"],
  Preservation: ["Preservation Specialist", "Preservation Team Manager", "Senior Preservation Specialist"],
  Resin: ["Resin Design Specialist", "Resin Team Manager", "Senior Resin Design Specialist"]
};

const emptyGoal: Omit<Goal, "id"> = {
  goalTier: "individual",
  periodType: "monthly",
  location: "Utah",
  department: "Design",
  role: "Design Specialist",
  name: "",
  goalValue: 0,
  minValue: 0,
  lowerBetter: false,
  capped: "no",
  capPct: 100,
  active: true
};

const fixtureManagedUsers: AdminManagedUser[] = [
  {
    ...fixtureData.profile,
    hasProfile: true,
    status: "active",
    confirmedAt: "2026-05-01T12:00:00.000Z",
    createdAt: "2026-05-01T12:00:00.000Z"
  },
  {
    ...fixtureManager,
    hasProfile: true,
    status: "active",
    confirmedAt: "2026-05-02T12:00:00.000Z",
    createdAt: "2026-05-02T12:00:00.000Z"
  },
  {
    id: "fixture-viewer",
    email: "viewer@pressedfloral.com",
    role: "user",
    departments: [],
    locations: [],
    linkedEmployeeName: "Ava Jensen",
    hasProfile: true,
    status: "invited",
    invitedAt: "2026-05-03T12:00:00.000Z",
    createdAt: "2026-05-03T12:00:00.000Z"
  }
];

function actualKey(goal: Pick<Goal, "goalTier" | "location" | "department" | "name">) {
  return [goal.goalTier, goal.location || "", goal.department || "", goal.name].join("|");
}

function metaKey(type: "target" | "min", goal: Pick<Goal, "goalTier" | "location" | "department" | "name">) {
  // Department goal targets are shared across all locations within a department —
  // strip location so that setting a target once covers all employees in that dept.
  const loc = goal.goalTier === "department" ? "" : (goal.location || "");
  return `__${type}__${[goal.goalTier, loc, goal.department || "", goal.name].join("|")}`;
}

function quarterKeyForMonth(isoMonth: string): string {
  const [y, m] = isoMonth.split("-").map(Number);
  if (!y || !m) return "";
  return `Q${Math.ceil(m / 3)} ${y}`;
}

function quarterRangeLabel(isoMonth: string): string {
  const [y, m] = isoMonth.split("-").map(Number);
  if (!y || !m) return "";
  const q = Math.ceil(m / 3);
  const ranges = [["Jan","Mar"],["Apr","Jun"],["Jul","Sep"],["Oct","Dec"]];
  const [s, e] = ranges[q - 1];
  return `Q${q} ${y} · ${s} – ${e}`;
}

function cloneData(data: AppData): AppData {
  return JSON.parse(JSON.stringify(data)) as AppData;
}

const ROLE_RANK: Record<string, number> = { admin: 3, manager: 2, user: 1 };
function roleAtLeast(profile: ManagerProfile | null, minRole: "admin" | "manager" | "user") {
  return (ROLE_RANK[profile?.role ?? "user"] ?? 1) >= ROLE_RANK[minRole];
}

function getReportingTree(managerName: string, employees: Employee[]): Set<string> {
  const result = new Set<string>();
  const queue = [managerName];
  const visited = new Set<string>();
  while (queue.length) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const emp of employees) {
      if (emp.manager === current && !visited.has(emp.name)) {
        result.add(emp.name);
        queue.push(emp.name);
      }
    }
  }
  return result;
}

function scopedForProfile<T extends { department?: string; location?: string }>(items: T[], profile: ManagerProfile | null) {
  if (!profile || profile.role === "admin") return items;
  if (profile.role === "user") return items; // user filtering is done separately by employee name
  return items.filter((item) => {
    const deptOk = !profile.departments.length || !item.department || profile.departments.includes(item.department);
    const locOk = !profile.locations.length || !item.location || profile.locations.includes(item.location);
    return deptOk && locOk;
  });
}

function scopedScorecardsForProfile(scorecards: import("../lib/types").Scorecard[], profile: ManagerProfile | null, allEmployees: Employee[] = []) {
  if (!profile || profile.role === "admin") return scorecards;
  if (profile.role === "user") {
    if (!profile.linkedEmployeeName) return [];
    return scorecards.filter((sc) => sc.employeeName === profile.linkedEmployeeName);
  }
  if (profile.linkedEmployeeName) {
    const tree = getReportingTree(profile.linkedEmployeeName, allEmployees);
    return scorecards.filter((sc) => tree.has(sc.employeeName));
  }
  return scorecards.filter((sc) => {
    const deptOk = !profile.departments.length || profile.departments.includes(sc.department || "");
    const locOk = !profile.locations.length || profile.locations.includes(sc.location || "");
    return deptOk && locOk;
  });
}

function scopedEmployeesForProfile(employees: Employee[], profile: ManagerProfile | null, allEmployees: Employee[] = []) {
  if (!profile || profile.role === "admin") return employees;
  if (profile.role === "user") return [];
  if (profile.linkedEmployeeName) {
    const tree = getReportingTree(profile.linkedEmployeeName, allEmployees);
    const treeFiltered = employees.filter((e) => tree.has(e.name));
    // If the manager also has explicit department restrictions, intersect them
    if (profile.departments.length > 0) {
      return treeFiltered.filter((e) => profile.departments.includes(e.department || ""));
    }
    return treeFiltered;
  }
  return scopedForProfile(employees, profile);
}

export default function ScorecardsApp() {
  const [mode, setMode] = useState<Screen>("landing");
  const [profile, setProfile] = useState<ManagerProfile | null>(null);
  const [currentUserEmail, setCurrentUserEmail] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [sb, setSb] = useState<SupabaseClient | null>(null);
  const [appData, setAppData] = useState<AppData>(() => cloneData(fixtureData));
  const [toast, setToast] = useState<{ message: string; type?: "success" | "error" } | null>(null);
  const [adminUsers, setAdminUsers] = useState<AdminManagedUser[]>([]);
  const [adminUsersLoading, setAdminUsersLoading] = useState(false);

  const [bankMonth, setBankMonth] = useState(fixtureMonth);
  const [bankFilters, setBankFilters] = useState({ types: ["company", "department", "individual"] as string[], location: "", departments: [...departments] as string[], sort: "goalTier", showInactive: false });
  const [editingGoal, setEditingGoal] = useState<Goal | null>(null);

  const [ripplingMonth, setRipplingMonth] = useState(fixtureMonth);
  const [ripplingPreview, setRipplingPreview] = useState<Employee[]>([]);

  const [historyFilters, setHistoryFilters] = useState<HistoryFilters>({
    period: fixturePeriod,
    search: "",
    location: "",
    department: "",
    goal: ""
  });
  const [historyView, setHistoryView] = useState<HistoryView>("table");

  const [scorecardMonths, setScorecardMonths] = useState<string[]>([currentMonthValue()]);
  const [deleteModal, setDeleteModal] = useState<{ scorecardId: string; goalName: string } | null>(null);

  const isFixture = dataMode === "fixture";

  useEffect(() => {
    if (isFixture) {
      const hydrated = hydrateFromLocalStorage(cloneData(fixtureData));
      setAppData(hydrated);
      setProfile(hydrated.profile);
      setCurrentUserEmail(hydrated.profile.email);
      setAuthenticated(true);
      localStorage.setItem(PROFILE_EMAIL_KEY, hydrated.profile.email);
      localStorage.setItem(PROFILE_ROLE_KEY, JSON.stringify(hydrated.profile));
      return;
    }

    // If Supabase drops an invite or recovery token on the root page (because redirectTo
    // was ignored), forward to /accept-invite so the password-setup page handles it.
    if (typeof window !== "undefined") {
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const hashType = hash.get("type");
      if (hashType === "invite" || hashType === "recovery") {
        window.location.replace("/accept-invite" + window.location.hash);
        return;
      }
      // Surface any error Supabase drops into the URL hash (e.g. expired invite link).
      const hashError = hash.get("error_description") || hash.get("error");
      if (hashError) {
        const msg = decodeURIComponent(hashError).replace(/\+/g, " ");
        setAuthError(msg.includes("expired") || msg.includes("invalid")
          ? "This invite or reset link has expired. Ask an admin to send a new one."
          : msg);
        window.history.replaceState(null, "", window.location.pathname);
      }
    }

    let client: SupabaseClient;
    try {
      client = supabaseClient();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Supabase is not configured.");
      return;
    }
    setSb(client);
    client.auth.getSession().then(async ({ data }) => {
      if (data.session?.user) await loadSupabaseProfile(client, data.session.user.id, data.session.user.email || "");
    });
    const { data: listener } = client.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" && session?.user) setTimeout(() => loadSupabaseProfile(client, session.user.id, session.user.email || ""), 0);
      if (event === "SIGNED_OUT") {
        setAuthenticated(false);
        setProfile(null);
        setCurrentUserEmail("");
        localStorage.removeItem(PROFILE_EMAIL_KEY);
        localStorage.removeItem(PROFILE_ROLE_KEY);
      }
    });
    return () => listener.subscription.unsubscribe();
  }, [isFixture]);

  useEffect(() => {
    if (!authenticated) return;
    const managerScreens: Screen[] = ["setup", "scorecard", "todos", "rippling", "migrate", "users"];
    const adminScreens: Screen[] = ["rippling", "migrate", "users"];
    if (profile?.role === "user" && managerScreens.includes(mode)) setMode("history");
    else if (profile?.role === "manager" && adminScreens.includes(mode)) setMode("landing");
  }, [authenticated, mode, profile]);

  useEffect(() => {
    if (!authenticated || profile?.role !== "admin" || mode !== "users") return;
    void loadAdminUsers();
  }, [authenticated, profile?.role, mode, isFixture, sb]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(timer);
  }, [toast]);

  async function loadSupabaseProfile(client: SupabaseClient, userId: string, email: string) {
    setCurrentUserEmail(email);
    localStorage.setItem(PROFILE_EMAIL_KEY, email);
    const { data, error } = await client.from("manager_profiles").select("*").eq("id", userId).maybeSingle();
    if (error) {
      setAuthError("Could not load your access profile. Try again or ask an admin to check your role.");
      await client.auth.signOut();
      return;
    }
    let loadedProfile = configuredProfileFromRow(email, data);
    if (!loadedProfile) {
      setProfile(null);
      setAuthenticated(false);
      setCurrentUserEmail("");
      localStorage.removeItem(PROFILE_EMAIL_KEY);
      localStorage.removeItem(PROFILE_ROLE_KEY);
      setAuthError("Your account exists but has not been assigned access. Ask an admin to assign your role.");
      await client.auth.signOut();
      return;
    }

    // Auto-link valid profiles when email matches an employee name.
    if (!loadedProfile.linkedEmployeeName) {
      const candidateName = nameFromEmail(email);
      if (candidateName) {
        const { data: ripplingRows } = await client.from("rippling_employees").select("full_name").limit(1000);
        const match = (ripplingRows || []).find((r: Record<string, any>) =>
          (r.full_name || "").toLowerCase() === candidateName.toLowerCase()
        );
        if (match?.full_name) {
          const updateResult = await client.from("manager_profiles").update({ linked_employee_name: match.full_name }).eq("id", userId);
          if (!updateResult.error) loadedProfile = { ...loadedProfile, linkedEmployeeName: match.full_name };
        }
      }
    }

    setProfile(loadedProfile);
    localStorage.setItem(PROFILE_ROLE_KEY, JSON.stringify(loadedProfile));
    setAuthenticated(true);
    await loadSupabaseData(client, loadedProfile);
  }

  async function loadSupabaseData(client: SupabaseClient, loadedProfile: ManagerProfile) {
    const isUser = loadedProfile.role === "user";

    if (isUser) {
      const scQuery = loadedProfile.linkedEmployeeName
        ? client.from("scorecards").select("*").eq("employee_name", loadedProfile.linkedEmployeeName).order("scorecard_month", { ascending: false })
        : client.from("scorecards").select("*").order("scorecard_month", { ascending: false });
      const { data } = await scQuery;
      const scorecards = (data || []).map(scorecardFromRow);
      setAppData((current) => ({ ...current, goals: [] as Goal[], scorecards, rippling: {} }));
      return;
    }

    const [goalsResult, scorecardsResult, ripplingResult, actualsResult] = await Promise.all([
      client.from("goals_bank").select("*").order("goal_tier").order("department").order("name"),
      client.from("scorecards").select("*").order("scorecard_month", { ascending: false }).order("employee_name"),
      client.from("rippling_employees").select("*").order("period", { ascending: false }),
      client.from("actuals").select("*")
    ]);

    const rippling: Record<string, Employee[]> = {};
    const allEmployees: Employee[] = [];
    for (const row of ripplingResult.data || []) {
      const period = row.period || fixtureMonth;
      const emp = employeeFromRow(row);
      rippling[period] = [...(rippling[period] || []), emp];
      allEmployees.push(emp);
    }

    // Group actuals rows by period and convert to ActualsByKey maps
    const actualsByPeriod: Record<string, Record<string, any>[]> = {};
    for (const row of actualsResult.data || []) {
      const period = row.period || "";
      if (!actualsByPeriod[period]) actualsByPeriod[period] = [];
      actualsByPeriod[period].push(row);
    }
    const actuals: Record<string, ActualsByKey> = {};
    for (const [period, rows] of Object.entries(actualsByPeriod)) {
      actuals[period] = actualsFromRows(rows);
    }

    const goals = scopedForProfile((goalsResult.data || []).map(goalFromRow), loadedProfile);
    const scorecards = scopedScorecardsForProfile((scorecardsResult.data || []).map(scorecardFromRow), loadedProfile, allEmployees);
    setAppData((current) => ({ ...current, goals, scorecards, rippling, actuals: { ...current.actuals, ...actuals } }));
  }

  async function signIn() {
    setAuthError("");
    if (!authEmail || !authPassword) {
      setAuthError("Enter email and password");
      return;
    }
    if (!sb) {
      setAuthError("Connection error. Reload the page and try again.");
      return;
    }
    const result = await sb.auth.signInWithPassword({ email: authEmail, password: authPassword });
    if (result.error) {
      setAuthError(result.error.message.includes("Invalid login") ? "Incorrect email or password." : result.error.message);
      return;
    }
    setAuthPassword("");
  }

  async function signOut() {
    if (sb) await sb.auth.signOut();
    if (isFixture) {
      setAuthenticated(false);
      setProfile(null);
      setCurrentUserEmail("");
    }
    setMode("landing");
  }

  function showToast(message: string, type: "success" | "error" = "success") {
    setToast({ message, type });
  }

  function showSupabaseError(error: unknown, fallback: string) {
    const message = error && typeof error === "object" && "message" in error && typeof error.message === "string"
      ? error.message
      : fallback;
    showToast(message, "error");
  }

  async function linkEmployeeProfile(name: string) {
    if (!profile || !sb) return;
    const { error } = await sb.from("manager_profiles").update({ linked_employee_name: name }).eq("id", profile.id);
    if (error) {
      showSupabaseError(error, "Could not save. Check Supabase RLS policies.");
      return;
    }
    const updated = { ...profile, linkedEmployeeName: name };
    setProfile(updated);
    localStorage.setItem(PROFILE_ROLE_KEY, JSON.stringify(updated));
    showToast(`Linked to ${name}`);
  }

  async function adminUsersRequest(method: "GET" | "POST" | "PATCH", payload?: unknown) {
    if (!sb) {
      showToast("Supabase is not connected.", "error");
      return null;
    }
    const sessionResult = await sb.auth.getSession();
    const token = sessionResult.data.session?.access_token;
    if (sessionResult.error || !token) {
      showToast("Sign in again to manage users.", "error");
      return null;
    }
    let response: Response;
    try {
      response = await fetch("/api/admin/users", {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload ? { "Content-Type": "application/json" } : {})
        },
        body: payload ? JSON.stringify(payload) : undefined
      });
    } catch {
      showToast("User management request failed.", "error");
      return null;
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      showToast(typeof body.error === "string" ? body.error : "User management request failed.", "error");
      return null;
    }
    return body;
  }

  async function loadAdminUsers() {
    if (isFixture) {
      setAdminUsers(fixtureManagedUsers);
      return;
    }
    setAdminUsersLoading(true);
    try {
      const body = await adminUsersRequest("GET");
      if (body?.users) setAdminUsers(body.users);
    } finally {
      setAdminUsersLoading(false);
    }
  }

  async function inviteAdminUser(payload: AdminUserPayload) {
    const normalized = normalizeAdminUserPayload(payload, { requireEmail: true });
    if (!normalized.ok) {
      showToast(normalized.error, "error");
      return false;
    }
    if (isFixture) {
      const invited: AdminManagedUser = {
        id: `fixture-${normalized.value.email}`,
        email: normalized.value.email!,
        role: normalized.value.role,
        departments: normalized.value.departments,
        locations: normalized.value.locations,
        linkedEmployeeName: normalized.value.linkedEmployeeName,
        hasProfile: true,
        status: "invited",
        invitedAt: new Date().toISOString(),
        createdAt: new Date().toISOString()
      };
      setAdminUsers((current) => [invited, ...current.filter((user) => user.email !== invited.email)]);
      showToast("Invite simulated");
      return true;
    }
    const body = await adminUsersRequest("POST", normalized.value);
    if (!body?.user) return false;
    setAdminUsers((current) => [body.user, ...current.filter((user) => user.id !== body.user.id)]);
    showToast("Invite sent");
    return true;
  }

  async function resendAdminInvite(user: AdminManagedUser) {
    if (isFixture) {
      showToast(`Invite resent to ${user.email}`);
      return;
    }
    if (!sb) { showToast("Supabase is not connected.", "error"); return; }
    const sessionResult = await sb.auth.getSession();
    const token = sessionResult.data.session?.access_token;
    if (!token) { showToast("Sign in again to manage users.", "error"); return; }
    let response: Response;
    try {
      response = await fetch("/api/admin/users?resend=true", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, role: user.role, departments: user.departments, locations: user.locations, linkedEmployeeName: user.linkedEmployeeName, allDepartments: user.departments.length === 0, allLocations: user.locations.length === 0 })
      });
    } catch {
      showToast("Failed to resend invite.", "error");
      return;
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      showToast(typeof body.error === "string" ? body.error : "Failed to resend invite.", "error");
      return;
    }
    showToast(`Invite resent to ${user.email}`);
  }

  async function updateAdminUser(payload: AdminUserPayload) {
    const normalized = normalizeAdminUserPayload(payload, { requireId: true });
    if (!normalized.ok) {
      showToast(normalized.error, "error");
      return false;
    }
    if (isFixture) {
      setAdminUsers((current) => current.map((user) => user.id === normalized.value.id ? { ...user, ...normalized.value, hasProfile: true } : user));
      showToast("User updated");
      return true;
    }
    const body = await adminUsersRequest("PATCH", normalized.value);
    if (!body?.user) return false;
    setAdminUsers((current) => current.map((user) => user.id === body.user.id ? body.user : user));
    showToast("User updated");
    return true;
  }

  const months = useMemo(() => {
    const values = new Set<string>([fixtureMonth, ...Object.keys(appData.rippling)]);
    // include 24 months back through 12 months forward so every month is always selectable
    const today = new Date();
    for (let offset = -24; offset <= 12; offset++) {
      const d = new Date(today.getFullYear(), today.getMonth() + offset, 1);
      values.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    }
    return Array.from(values).sort().reverse();
  }, [appData.rippling, appData.scorecards]);

  const visibleGoals = useMemo(() => {
    let goals = scopedForProfile(appData.goals, profile);
    // Only admins see company goals on the Goals & Actuals page
    if (!roleAtLeast(profile, "admin")) goals = goals.filter((g) => g.goalTier !== "company");
    if (!bankFilters.showInactive) goals = goals.filter((goal) => goal.active);
    if (bankFilters.types.length > 0 && bankFilters.types.length < 3) goals = goals.filter((goal) => bankFilters.types.includes(goal.goalTier));
    if (bankFilters.location) goals = goals.filter((goal) => !goal.location || goal.location === bankFilters.location);
    if (bankFilters.departments.length < departments.length) goals = goals.filter((goal) => !goal.department || bankFilters.departments.includes(goal.department));
    return [...goals].sort((a, b) => {
      const field = bankFilters.sort as keyof Goal;
      return String(a[field] || "").localeCompare(String(b[field] || "")) || a.name.localeCompare(b.name);
    });
  }, [appData.goals, bankFilters, profile]);

  const allRipplingEmployees = useMemo(() => Object.values(appData.rippling).flat(), [appData.rippling]);

  // Deduplicated employees: most recent period wins when the same name appears in multiple uploads
  const latestRipplingEmployees = useMemo(() => {
    const periods = Object.keys(appData.rippling).sort().reverse();
    const seen = new Set<string>();
    const result: Employee[] = [];
    for (const period of periods) {
      for (const emp of appData.rippling[period] || []) {
        if (!seen.has(emp.name)) {
          seen.add(emp.name);
          result.push(emp);
        }
      }
    }
    return result;
  }, [appData.rippling]);

  // Employee record for the logged-in user (for the Personal Scorecard panel)
  const myEmployee = useMemo(() => {
    if (!profile?.linkedEmployeeName) return null;
    return latestRipplingEmployees.find((e) => e.name === profile.linkedEmployeeName) || null;
  }, [profile, latestRipplingEmployees]);

  // Scorecards belonging to the logged-in user (for the Personal Scorecard panel on the landing page)
  const myOwnScorecards = useMemo(() => {
    if (!profile?.linkedEmployeeName) return [];
    return [...appData.scorecards.filter((sc) => sc.employeeName === profile.linkedEmployeeName)]
      .sort((a, b) => {
        function key(period: string) {
          const qm = period.match(/^Q(\d) (\d{4})$/);
          if (qm) return `${qm[2]}-${String((parseInt(qm[1]) - 1) * 3 + 1).padStart(2, "0")}`;
          const d = new Date(`${period} 1`);
          return isNaN(d.getTime()) ? period : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        }
        return key(a.scorecardMonth).localeCompare(key(b.scorecardMonth));
      });
  }, [profile, appData.scorecards]);

  const filteredHistory = useMemo(() => {
    return scopedScorecardsForProfile(appData.scorecards, profile, allRipplingEmployees).filter((scorecard) => {
      if (historyFilters.period && scorecard.scorecardMonth !== historyFilters.period) return false;
      if (historyFilters.location && scorecard.location !== historyFilters.location) return false;
      if (historyFilters.department && scorecard.department !== historyFilters.department) return false;
      if (historyFilters.goal && !scorecard.goals.some((goal) => goal.name === historyFilters.goal)) return false;
      if (historyFilters.search) {
        const haystack = [scorecard.employeeName, scorecard.role, scorecard.department, scorecard.location, scorecard.manager].join(" ").toLowerCase();
        if (!haystack.includes(historyFilters.search.toLowerCase())) return false;
      }
      return true;
    });
  }, [appData.scorecards, historyFilters, profile, allRipplingEmployees]);

  // workMonth = the most recently completed month (always previous calendar month)
  const workMonth = useMemo(() => {
    const d = new Date();
    const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
  }, []);

  // currentMonth = this calendar month — the Rippling upload for this month contains last month's earnings
  const currentMonth = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }, []);

  const missingActuals = useMemo(() => {
    const actuals = appData.actuals[formatMonthLabel(workMonth)] || {};
    return appData.goals.filter((goal) =>
      goal.active &&
      (goal.goalTier === "company" || goal.goalTier === "department") &&
      actuals[metaKey("target", goal)] != null &&
      actuals[metaKey("min", goal)] != null &&
      actuals[actualKey(goal)] == null
    );
  }, [appData.goals, appData.actuals, workMonth]);

  const missingScorecards = useMemo(() => {
    const employees = appData.rippling[workMonth] || [];
    return employees.filter((employee) => !appData.scorecards.some((sc) => sc.employeeName === employee.name && sc.scorecardMonth === formatMonthLabel(workMonth)));
  }, [appData.rippling, appData.scorecards, workMonth]);

  const missingCurrentTargets = useMemo(() => {
    const today = new Date();
    const currentMonthVal = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
    const currentLabel = formatMonthLabel(currentMonthVal);
    const currentActuals = appData.actuals[currentLabel] || {};
    const isAdmin = roleAtLeast(profile, "admin");
    return appData.goals.filter((g) => g.active && (isAdmin ? true : g.goalTier !== "company") && (g.goalTier === "company" || g.goalTier === "department") && currentActuals[metaKey("target", g)] == null);
  }, [appData.goals, appData.actuals, profile]);

  const missingNextTargets = useMemo(() => {
    const today = new Date();
    const next = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const nextVal = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
    const nextLabel = formatMonthLabel(nextVal);
    const nextActuals = appData.actuals[nextLabel] || {};
    const isAdmin = roleAtLeast(profile, "admin");
    return appData.goals.filter((g) => g.active && (isAdmin ? true : g.goalTier !== "company") && (g.goalTier === "company" || g.goalTier === "department") && nextActuals[metaKey("target", g)] == null);
  }, [appData.goals, appData.actuals, profile]);

  const todos = useMemo(() => {
    const tasks: { label: string; detail: string; action: Screen }[] = [];
    if (roleAtLeast(profile, "admin") && !appData.rippling[currentMonth]?.length) tasks.push({ label: "Upload Rippling data", detail: `${formatMonthLabel(currentMonth)} data not uploaded yet.`, action: "rippling" });
    if (missingActuals.length) tasks.push({ label: "Enter shared actuals", detail: `${missingActuals.length} company or department goals need actuals.`, action: "setup" });
    if (missingCurrentTargets.length) tasks.push({ label: "Set current month targets", detail: `${missingCurrentTargets.length} goals need targets for this month.`, action: "todos" });
    return tasks;
  }, [appData.rippling, currentMonth, workMonth, missingActuals, missingCurrentTargets, profile]);

  const todoBadgeCount = useMemo(() => {
    const ripplingPending = roleAtLeast(profile, "admin") && !appData.rippling[currentMonth]?.length ? 1 : 0;
    return ripplingPending + missingActuals.length + missingCurrentTargets.length + missingNextTargets.length;
  }, [profile, appData.rippling, currentMonth, missingActuals, missingCurrentTargets, missingNextTargets]);

  async function saveGoal(goal: Goal): Promise<Goal | null> {
    let savedGoal = goal;
    if (!isFixture && sb) {
      const result = isSupabaseUuid(goal.id)
        ? await sb.from("goals_bank").upsert(goalToRow(goal), { onConflict: "id" }).select().single()
        : await sb.from("goals_bank").insert(goalToRow(goal, { includeId: false })).select().single();
      if (result.error || !result.data) {
        showSupabaseError(result.error, "Goal could not be saved.");
        return null;
      }
      savedGoal = goalFromRow(result.data);
    }

    const nextGoals = appData.goals.some((item) => item.id === goal.id)
      ? appData.goals.map((item) => item.id === goal.id ? savedGoal : item)
      : [...appData.goals, savedGoal];
    setAppData((current) => ({ ...current, goals: nextGoals }));
    persistGoals(nextGoals);
    setEditingGoal(null);
    showToast("Goal saved");
    return savedGoal;
  }

  async function deleteGoal(id: string) {
    if (!isFixture && sb) {
      const result = await sb.from("goals_bank").delete().eq("id", id);
      if (result.error) {
        showSupabaseError(result.error, "Goal could not be deleted.");
        return;
      }
    }
    const nextGoals = appData.goals.filter((goal) => goal.id !== id);
    setAppData((current) => ({ ...current, goals: nextGoals }));
    persistGoals(nextGoals);
    showToast("Goal deleted");
  }

  async function toggleGoal(id: string) {
    const goal = appData.goals.find((item) => item.id === id);
    if (!goal) return;
    await saveGoal({ ...goal, active: !goal.active });
  }

  async function toggleGoalForMonth(goal: Goal) {
    const period = formatMonthLabel(bankMonth);
    const key = "__monthly_inactive__" + actualKey(goal);
    const currentPeriodActuals = appData.actuals[period] || {};
    const isCurrentlyInactive = !!currentPeriodActuals[key];
    const nextVal = isCurrentlyInactive ? null : 1;
    const nextPeriodActuals = { ...currentPeriodActuals, [key]: nextVal };
    if (!isFixture && sb) {
      const result = await sb.from("actuals").upsert({
        period,
        goal_tier: "__meta__",
        location: null,
        department: null,
        goal_name: key,
        actual_value: nextVal
      }, { onConflict: "period,goal_tier,location,department,goal_name" });
      if (result.error) {
        showSupabaseError(result.error, "Monthly goal status could not be saved.");
        return;
      }
    }
    setAppData((prev) => ({ ...prev, actuals: { ...prev.actuals, [period]: nextPeriodActuals } }));
    persistActuals(period, nextPeriodActuals);
    showToast(isCurrentlyInactive ? "Goal activated for this month" : "Goal deactivated for this month");
  }

  async function saveActual(goal: Goal, value: string, periodOverride?: string) {
    const period = periodOverride ?? formatMonthLabel(bankMonth);
    const key = actualKey(goal);
    const nextActuals = { ...(appData.actuals[period] || {}), [key]: value === "" ? null : Number(value) };
    if (!isFixture && sb) {
      const [goalTier, location, department, goalName] = key.split("|");
      const result = await sb.from("actuals").upsert({
        period,
        goal_tier: goalTier,
        location: location || null,
        department: department || null,
        goal_name: goalName,
        actual_value: value === "" ? null : Number(value)
      }, { onConflict: "period,goal_tier,location,department,goal_name" });
      if (result.error) {
        showSupabaseError(result.error, "Actual could not be saved.");
        return;
      }
    }
    setAppData((current) => ({ ...current, actuals: { ...current.actuals, [period]: nextActuals } }));
    persistActuals(period, nextActuals);
    showToast("Actual saved");
  }

  async function saveMonthTarget(goal: Goal, period: string, type: "target" | "min", value: string) {
    const key = metaKey(type, goal);
    const nextActuals = { ...(appData.actuals[period] || {}), [key]: value === "" ? null : Number(value) };
    if (!isFixture && sb) {
      const result = await sb.from("actuals").upsert({
        period,
        goal_tier: "__meta__",
        location: null,
        department: null,
        goal_name: key,
        actual_value: value === "" ? null : Number(value)
      }, { onConflict: "period,goal_tier,location,department,goal_name" });
      if (result.error) {
        showSupabaseError(result.error, "Target could not be saved.");
        return;
      }
    }
    setAppData((current) => ({ ...current, actuals: { ...current.actuals, [period]: nextActuals } }));
    persistActuals(period, nextActuals);
  }

  async function saveMonthTargetPair(goal: Goal, period: string, target: string, min: string) {
    const targetKey = metaKey("target", goal);
    const minKey = metaKey("min", goal);
    const nextActuals = {
      ...(appData.actuals[period] || {}),
      [targetKey]: target === "" ? null : Number(target),
      [minKey]: min === "" ? null : Number(min)
    };
    if (!isFixture && sb) {
      const result = await sb.from("actuals").upsert([
        { period, goal_tier: "__meta__", location: null, department: null, goal_name: targetKey, actual_value: target === "" ? null : Number(target) },
        { period, goal_tier: "__meta__", location: null, department: null, goal_name: minKey, actual_value: min === "" ? null : Number(min) }
      ], { onConflict: "period,goal_tier,location,department,goal_name" });
      if (result.error) {
        showSupabaseError(result.error, "Target and minimum could not be saved.");
        return;
      }
    }
    setAppData((current) => ({ ...current, actuals: { ...current.actuals, [period]: nextActuals } }));
    persistActuals(period, nextActuals);
  }

  async function saveRipplingForMonth(month: string, employees: Employee[]) {
    if (!isFixture && sb) {
      const deleteResult = await sb.from("rippling_employees").delete().eq("period", month);
      if (deleteResult.error) {
        showSupabaseError(deleteResult.error, "Existing Rippling data could not be cleared.");
        return;
      }
      const insertResult = await sb.from("rippling_employees").insert(employees.map((employee) => employeeToRow(month, employee)));
      if (insertResult.error) {
        showSupabaseError(insertResult.error, "Rippling data could not be saved.");
        return;
      }
    }
    setAppData((current) => ({ ...current, rippling: { ...current.rippling, [month]: employees } }));
    persistRippling(month, employees);
    showToast("Rippling data saved");
  }

  async function saveRippling() {
    if (!ripplingMonth || !ripplingPreview.length) {
      showToast("Upload a CSV before saving", "error");
      return;
    }
    if (!isFixture && sb) {
      const deleteResult = await sb.from("rippling_employees").delete().eq("period", ripplingMonth);
      if (deleteResult.error) {
        showSupabaseError(deleteResult.error, "Existing Rippling data could not be cleared.");
        return;
      }
      const insertResult = await sb.from("rippling_employees").insert(ripplingPreview.map((employee) => employeeToRow(ripplingMonth, employee)));
      if (insertResult.error) {
        showSupabaseError(insertResult.error, "Rippling data could not be saved.");
        return;
      }
    }
    setAppData((current) => ({ ...current, rippling: { ...current.rippling, [ripplingMonth]: ripplingPreview } }));
    persistRippling(ripplingMonth, ripplingPreview);
    setRipplingPreview([]);
    showToast("Rippling data saved");
  }

  async function submitScorecardDirect(scorecard: Scorecard) {
    let savedScorecard = scorecard;
    if (!isFixture && sb) {
      const result = await sb
        .from("scorecards")
        .upsert(scorecardToRow(scorecard), { onConflict: "employee_name,scorecard_month" })
        .select()
        .single();
      if (result.error || !result.data) {
        showSupabaseError(result.error, "Scorecard could not be submitted.");
        return;
      }
      savedScorecard = scorecardFromRow(result.data);
    }
    setAppData((current) => ({
      ...current,
      scorecards: [
        ...current.scorecards.filter((item) => !(item.employeeName === savedScorecard.employeeName && item.scorecardMonth === savedScorecard.scorecardMonth)),
        savedScorecard
      ]
    }));
    persistScorecard(savedScorecard);
    showToast("Scorecard submitted");
  }

  function removeGoalFromScorecard(allEmployees: boolean) {
    if (!deleteModal) return;
    setAppData((current) => ({
      ...current,
      scorecards: current.scorecards.map((scorecard) => {
        if (!allEmployees && scorecard.id !== deleteModal.scorecardId) return scorecard;
        return {
          ...scorecard,
          goals: scorecard.goals.filter((goal) => goal.name !== deleteModal.goalName)
        };
      })
    }));
    setDeleteModal(null);
    showToast("Goal removed from scorecard");
  }

  if (!authenticated) {
    return (
      <AuthScreen
        email={authEmail}
        password={authPassword}
        error={authError}
        fixtureMode={isFixture}
        onEmail={setAuthEmail}
        onPassword={setAuthPassword}
        onSignIn={signIn}
      />
    );
  }

  return (
    <>
      <Sidebar
        mode={mode}
        profile={profile}
        email={currentUserEmail}
        todoCount={todoBadgeCount}
        onMode={setMode}
        onSignOut={signOut}
      />
      <div id="app-main">
        <header>
          <div className="header-left">
            <h1>{pageLabel(mode)}</h1>
          </div>
        </header>
        <main>
          {mode === "landing" && <LandingScreen onMode={setMode} profile={profile} />}
          {mode === "personal" && (
            <div className="screen active">
              <div style={{ maxWidth: "680px", margin: "0 auto", padding: "16px" }}>
                <PersonalScorecardPanel
                  scorecards={myOwnScorecards}
                  employeeName={profile?.linkedEmployeeName || ""}
                  myEmployee={myEmployee}
                  allGoals={appData.goals.filter((g) => g.active)}
                  allActuals={appData.actuals}
                  rippling={appData.rippling}
                />
              </div>
            </div>
          )}
          {mode === "setup" && (
            <GoalsScreen
              month={bankMonth}
              months={months}
              filters={bankFilters}
              goals={visibleGoals}
              actuals={appData.actuals[formatMonthLabel(bankMonth)] || {}}
              allActuals={appData.actuals}
              editingGoal={editingGoal}
              onMonth={setBankMonth}
              onFilters={setBankFilters}
              onActual={saveActual}
              onEdit={setEditingGoal}
              onSave={saveGoal}
              onSaveTargetPair={(goal, target, min, period) => saveMonthTargetPair(goal, period ?? formatMonthLabel(bankMonth), target, min)}
              onDelete={deleteGoal}
              onToggle={toggleGoal}
              onToggleMonth={toggleGoalForMonth}
              isAdmin={profile?.role === "admin"}
              allowedDepartments={profile?.role === "admin" ? undefined : (profile?.departments || [])}
            />
          )}
          {mode === "scorecard" && (
            <ScorecardsScreen
              selectedMonths={scorecardMonths}
              months={months}
              profile={profile}
              rippling={appData.rippling}
              allEmployees={allRipplingEmployees}
              scorecards={scopedScorecardsForProfile(appData.scorecards, profile, allRipplingEmployees)}
              allGoals={appData.goals.filter((g) => g.active)}
              allActuals={appData.actuals}
              onMonths={setScorecardMonths}
              onSubmitScorecard={submitScorecardDirect}
              onDeleteGoal={setDeleteModal}
              currentUserEmail={currentUserEmail}
            />
          )}
          {mode === "history" && (
            <HistoryScreen
              filters={historyFilters}
              view={historyView}
              scorecards={filteredHistory}
              allScorecards={scopedScorecardsForProfile(appData.scorecards, profile, allRipplingEmployees)}
              readonly={profile?.role === "user"}
              onFilters={setHistoryFilters}
              onView={setHistoryView}
            />
          )}
          {mode === "rippling" && (
            <RipplingScreen
              month={ripplingMonth}
              preview={ripplingPreview}
              saved={appData.rippling}
              onMonth={setRipplingMonth}
              onPreview={setRipplingPreview}
              onSave={saveRippling}
              onClear={() => {
                setAppData((current) => ({ ...current, rippling: {} }));
                showToast("Rippling data cleared");
              }}
            />
          )}
          {mode === "guide" && <GuideScreen />}
          {mode === "whatif" && (
            <WhatIfScreen
              allGoals={appData.goals.filter((g) => g.active)}
              profile={profile}
              latestEmployees={latestRipplingEmployees}
              allEmployees={allRipplingEmployees}
            />
          )}
          {mode === "users" && (
            <UsersScreen
              users={adminUsers}
              loading={adminUsersLoading}
              employees={latestRipplingEmployees}
              fixtureMode={isFixture}
              currentUserId={profile?.id || ""}
              onRefresh={loadAdminUsers}
              onInvite={inviteAdminUser}
              onUpdate={updateAdminUser}
              onResendInvite={resendAdminInvite}
            />
          )}
          {mode === "todos" && (
            <TodosScreen
              workMonth={workMonth}
              bankMonth={bankMonth}
              profile={profile}
              hasRippling={!!appData.rippling[currentMonth]?.length}
              missingActuals={missingActuals}
              goals={appData.goals.filter((g) => g.active)}
              allActuals={appData.actuals}
              onSaveTarget={saveMonthTarget}
              onSaveCurrentTargetPair={(goal, target, min) => {
                const today = new Date();
                const period = formatMonthLabel(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`);
                return saveMonthTargetPair(goal, period, target, min);
              }}
              onSaveTargetPair={(goal, target, min) => {
                const today = new Date();
                const next = new Date(today.getFullYear(), today.getMonth() + 1, 1);
                const period = formatMonthLabel(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`);
                return saveMonthTargetPair(goal, period, target, min);
              }}
              onSaveActual={(goal, value) => saveActual(goal, value, formatMonthLabel(workMonth))}
              onRipplingUpload={(employees) => saveRipplingForMonth(workMonth, employees)}
              onBuildEmployee={() => {
                setScorecardMonths([workMonth]);
                setMode("scorecard");
              }}
            />
          )}
          {mode === "migrate" && <MigrateScreen />}
        </main>
      </div>
      <div className={`toast ${toast ? `show ${toast.type || ""}` : ""}`}>{toast?.message}</div>
      {deleteModal && (
        <DeleteScorecardGoalModal
          goalName={deleteModal.goalName}
          onSingle={() => removeGoalFromScorecard(false)}
          onAll={() => removeGoalFromScorecard(true)}
          onCancel={() => setDeleteModal(null)}
        />
      )}
    </>
  );
}

function pageLabel(mode: Screen) {
  return {
    landing: "Home",
    setup: "Goals & Actuals",
    scorecard: "Team Scorecards",
    history: "Historical Data",
    rippling: "Rippling Data",
    guide: "How To Use",
    todos: "To Do",
    migrate: "Migrate Data",
    whatif: "What If Scorecard",
    personal: "My Scorecard",
    users: "Users"
  }[mode];
}

function AuthScreen(props: {
  email: string;
  password: string;
  error: string;
  fixtureMode: boolean;
  onEmail: (value: string) => void;
  onPassword: (value: string) => void;
  onSignIn: () => void;
}) {
  return (
    <div id="auth-overlay">
      <div className="auth-card">
        <div className="auth-title">Pressed Floral</div>
        <div className="auth-subtitle">Scorecards</div>
        {props.fixtureMode && <div className="info-banner" style={{ display: "block" }}>Fixture mode signs in automatically. Reload if you were signed out.</div>}
        {props.error && <div id="auth-error">{props.error}</div>}
        <div className="field">
          <label>Email</label>
          <input value={props.email} onChange={(event) => props.onEmail(event.target.value)} placeholder="you@pressedfloral.com" type="email" />
        </div>
        <div className="field">
          <label>Password</label>
          <input value={props.password} onChange={(event) => props.onPassword(event.target.value)} onKeyDown={(event) => event.key === "Enter" && props.onSignIn()} placeholder="Password" type="password" />
        </div>
        <button className="submit-btn" onClick={props.onSignIn}>Sign In</button>
      </div>
    </div>
  );
}

function Sidebar(props: {
  mode: Screen;
  profile: ManagerProfile | null;
  email: string;
  todoCount: number;
  onMode: (mode: Screen) => void;
  onSignOut: () => void;
}) {
  const role = props.profile?.role ?? "user";
  const isAdmin = role === "admin";
  const isManager = role === "manager" || isAdmin;
  const hasLinkedEmployee = !!props.profile?.linkedEmployeeName;
  const nav: { mode: Screen; label: string; icon: string; minRole?: "manager" | "admin"; hidden?: boolean }[] = [
    { mode: "landing", label: "Home", icon: "⌂" },
    { mode: "personal", label: "My Scorecard", icon: "◉", hidden: !hasLinkedEmployee },
    { mode: "setup", label: "Goals & Actuals", icon: "☰", minRole: "manager" },
    { mode: "scorecard", label: "Team Scorecards", icon: "👥", minRole: "manager" },
    { mode: "history", label: "Historical Data", icon: "◷" },
    { mode: "whatif", label: "What If Scorecard", icon: "◆" },
    { mode: "rippling", label: "Rippling Data", icon: "⇅", minRole: "admin" },
    { mode: "users", label: "Users", icon: "◇", minRole: "admin" },
    { mode: "guide", label: "How To Use", icon: "ⓘ" },
    { mode: "todos", label: "To Do", icon: "☐", minRole: "manager" },
    { mode: "migrate", label: "Migrate Data", icon: "↑", minRole: "admin" }
  ];
  return (
    <div id="sidebar">
      <div id="sidebar-header">
        <h1>Pressed Floral</h1>
        <p>Scorecards</p>
      </div>
      <nav id="sidebar-nav">
        {nav.map((item) => {
          if (item.hidden) return null;
          if (item.minRole === "admin" && !isAdmin) return null;
          if (item.minRole === "manager" && !isManager) return null;
          const sectionBreak = item.mode === "setup" || item.mode === "history" || item.mode === "rippling";
          const sectionLabel = item.mode === "setup" ? "MANAGE" : item.mode === "history" ? "REVIEW" : "";
          return (
            <div key={item.mode}>
              {sectionBreak && <div className="nav-section">{sectionLabel}</div>}
              <button data-testid={`nav-${item.mode}`} className={`nav-item ${props.mode === item.mode ? "active" : ""}`} onClick={() => props.onMode(item.mode)}>
                <span className="nav-icon">{item.icon}</span>
                {item.label}
                {item.mode === "todos" && props.todoCount > 0 && <span id="todo-badge">{props.todoCount}</span>}
              </button>
            </div>
          );
        })}
      </nav>
      <div id="user-badge">
        <div id="user-email-display">{props.email || "Not signed in"}</div>
        <div id="user-role-display">
          {role === "admin" ? "Admin · full access" : role === "manager" ? (props.profile?.linkedEmployeeName ? `Manager · ${props.profile.linkedEmployeeName}'s team` : `Manager · ${(props.profile?.departments || []).join(", ") || "all depts"}`) : `Viewer · ${props.profile?.linkedEmployeeName || props.email}`}
        </div>
        <button onClick={props.onSignOut}>Sign out</button>
      </div>
    </div>
  );
}

function PersonalScorecardPanel({
  scorecards, employeeName, myEmployee, allGoals, allActuals, rippling
}: {
  scorecards: Scorecard[];
  employeeName: string;
  myEmployee: Employee | null;
  allGoals: Goal[];
  allActuals: Record<string, ActualsByKey>;
  rippling: Record<string, Employee[]>;
}) {
  function periodSortKey(period: string): string {
    const qm = period.match(/^Q(\d) (\d{4})$/);
    if (qm) return `${qm[2]}-${String((parseInt(qm[1]) - 1) * 3 + 1).padStart(2, "0")}`;
    const d = new Date(`${period} 1`);
    if (!isNaN(d.getTime())) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    return period;
  }

  function periodToISO(period: string): string {
    const qm = period.match(/^Q(\d) (\d{4})$/);
    if (qm) return `${qm[2]}-${String((parseInt(qm[1]) - 1) * 3 + 1).padStart(2, "0")}`;
    const d = new Date(`${period} 1`);
    if (!isNaN(d.getTime())) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    return "";
  }

  const today = new Date();
  const curISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  const nextISO = (() => { const d = new Date(today.getFullYear(), today.getMonth() + 1, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; })();
  const currentLabel = formatMonthLabel(curISO);
  const nextLabel = formatMonthLabel(nextISO);

  // Navigation: all submitted months + current + next month
  const submittedSet = new Set(scorecards.map((sc) => sc.scorecardMonth));
  const allPeriods = new Set([...submittedSet, currentLabel, nextLabel]);
  const sortedPeriods = [...allPeriods].sort((a, b) => periodSortKey(a).localeCompare(periodSortKey(b)));

  const [idx, setIdx] = useState(() => {
    // Default to current month
    const ci = sortedPeriods.indexOf(currentLabel);
    return ci >= 0 ? ci : sortedPeriods.length - 1;
  });
  const safeIdx = Math.min(Math.max(0, idx), sortedPeriods.length - 1);
  const currentPeriod = sortedPeriods[safeIdx] || currentLabel;

  // Submitted scorecard for this period (if any)
  const submitted = scorecards.find((sc) => sc.scorecardMonth === currentPeriod) || null;

  // Live draft data — computed from goals+actuals+rippling even when not submitted
  const periodISO = periodToISO(currentPeriod);
  const isQuarterly = /^Q\d /.test(currentPeriod);
  const quarterKey = periodISO ? quarterKeyForMonth(periodISO) : "";

  const periodActuals = useMemo(() => ({
    ...(allActuals[currentPeriod] || {}),
    ...(quarterKey ? allActuals[quarterKey] || {} : {}),
  }), [allActuals, currentPeriod, quarterKey]);

  // Employee with earnings for this period's Rippling upload (next month's file)
  const empWithEarnings = useMemo((): Employee | null => {
    if (!myEmployee || !periodISO) return myEmployee;
    const [py, pm] = periodISO.split("-").map(Number);
    const eKey = pm && py ? `${pm === 12 ? py + 1 : py}-${String(pm === 12 ? 1 : pm + 1).padStart(2, "0")}` : "";
    const src = eKey ? (rippling[eKey] || []).find((e) => e.name === myEmployee.name) : null;
    return src ? { ...myEmployee, grossEarnings: src.grossEarnings, hoursWorked: src.hoursWorked } : myEmployee;
  }, [myEmployee, periodISO, rippling]);

  // Goals applicable to this employee for this period type
  const liveGoals: EditableGoal[] = useMemo(() => {
    if (!myEmployee) return [];
    const applicable = allGoals.filter((g) => {
      if (!g.active) return false;
      if (isQuarterly ? g.periodType !== "quarterly" : g.periodType === "quarterly") return false;
      if (periodActuals["__monthly_inactive__" + actualKey(g)]) return false;
      if (g.goalTier === "company") return true;
      if (g.goalTier === "department") return g.department === myEmployee.department && (!g.location || g.location === myEmployee.location);
      return g.role === myEmployee.role && g.department === myEmployee.department && (!g.location || g.location === myEmployee.location);
    });
    const n = applicable.length;
    return applicable.map((g, i) => {
      const eq = n > 0 ? Number((100 / n).toFixed(2)) : 0;
      return {
        ...g,
        scTarget: periodActuals[metaKey("target", g)] != null ? Number(periodActuals[metaKey("target", g)]) : g.goalValue,
        scMin: periodActuals[metaKey("min", g)] != null ? Number(periodActuals[metaKey("min", g)]) : g.minValue,
        scActual: g.goalTier === "individual" ? null : (periodActuals[actualKey(g)] != null ? Number(periodActuals[actualKey(g)]) : null),
        scWeight: i === n - 1 ? Number((100 - eq * (n - 1)).toFixed(2)) : eq,
      };
    });
  }, [myEmployee, allGoals, periodActuals, isQuarterly]);

  const liveComputed = useMemo(() =>
    empWithEarnings && liveGoals.length > 0
      ? buildScorecard({ employee: empWithEarnings, month: currentPeriod, periodType: isQuarterly ? "quarterly" : "monthly", goals: liveGoals })
      : null,
  [empWithEarnings, liveGoals, currentPeriod, isQuarterly]);

  const thS: React.CSSProperties = { padding: "5px 10px", fontSize: "9px", fontWeight: 700, color: "var(--text-muted)", textAlign: "left", borderBottom: "1.5px solid var(--border)", whiteSpace: "nowrap", background: "var(--surface2)" };
  const thC: React.CSSProperties = { ...thS, textAlign: "center" };
  const faint = { color: "var(--text-faint)" } as React.CSSProperties;
  const navBtn = (off: boolean): React.CSSProperties => ({ border: "none", background: "none", cursor: off ? "default" : "pointer", color: off ? "var(--text-faint)" : "var(--text)", fontSize: "18px", padding: "0 6px", lineHeight: 1, flexShrink: 0 });

  // What employee/goals/metrics to render
  const displayEmp = submitted
    ? { name: submitted.employeeName, role: submitted.role, department: submitted.department, location: submitted.location, payType: submitted.payType, hourlyRate: submitted.hourlyRate, hours: submitted.hours, annualPay: submitted.annualPay }
    : myEmployee ? { name: myEmployee.name, role: myEmployee.role, department: myEmployee.department, location: myEmployee.location, payType: myEmployee.payType, hourlyRate: empWithEarnings?.hourlyRate ?? myEmployee.hourlyRate, hours: empWithEarnings?.hoursWorked, annualPay: myEmployee.annualPay } : null;

  const displayMetrics = submitted
    ? { earnings: submitted.baseEarnings, hours: submitted.hours, achievement: submitted.weightedAchievement, bonus: submitted.bonusAmount, capped: submitted.scorecardCapped }
    : liveComputed
      ? { earnings: liveComputed.baseEarnings, hours: empWithEarnings?.hoursWorked ?? null, achievement: liveComputed.weightedAchievement, bonus: liveComputed.bonusAmount, capped: liveComputed.scorecardCapped }
      : null;

  type DisplayGoalRow = { id: string; name: string; goalTier: GoalTier; location?: string; department?: string; target: number | null; min: number | null; actual: number | null; weight: number; achievement: number | null; bonusContribution: number | null; metMin: boolean | null; hasTarget: boolean; };
  const displayGoals: DisplayGoalRow[] = submitted
    ? submitted.goals.map((g) => ({ id: g.name, name: g.name, goalTier: g.goalTier, location: g.location, department: g.department, target: g.target, min: g.min, actual: g.actual, weight: g.weight, achievement: g.achievement, bonusContribution: g.bonusContribution, metMin: g.metMin, hasTarget: true }))
    : liveGoals.map((g) => {
        const hasTarget = periodActuals[metaKey("target", g)] != null && periodActuals[metaKey("min", g)] != null;
        const calc = liveComputed?.goals.find((sg) => sg.name === g.name);
        return { id: g.id, name: g.name, goalTier: g.goalTier, location: g.location, department: g.department, target: hasTarget ? g.scTarget : null, min: hasTarget ? g.scMin : null, actual: g.scActual, weight: g.scWeight, achievement: calc?.achievement ?? null, bonusContribution: calc?.bonusContribution ?? null, metMin: calc?.metMin ?? null, hasTarget };
      });

  return (
    <div style={{ border: "1.5px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden", background: "var(--surface)" }}>
      {/* Navigation bar */}
      <div style={{ display: "flex", alignItems: "center", gap: "4px", padding: "10px 14px", background: "var(--surface2)", borderBottom: "1px solid var(--border)" }}>
        <button style={navBtn(safeIdx === 0)} disabled={safeIdx === 0} onClick={() => setIdx(safeIdx - 1)}>◀</button>
        <div style={{ flex: 1, textAlign: "center", fontWeight: 700, fontSize: "13px" }}>{currentPeriod}</div>
        <button style={navBtn(safeIdx === sortedPeriods.length - 1)} disabled={safeIdx === sortedPeriods.length - 1} onClick={() => setIdx(safeIdx + 1)}>▶</button>
        <span style={{ fontSize: "10px", padding: "2px 8px", borderRadius: "99px", fontWeight: 700, fontFamily: "var(--mono)", background: submitted ? "#e8f5e2" : "#f0ece6", color: submitted ? "#2D6B1A" : "#7a7268", flexShrink: 0, marginLeft: "6px" }}>
          {submitted ? "SUBMITTED" : "PENDING"}
        </span>
      </div>

      {/* Employee info */}
      {displayEmp && (
        <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontSize: "13px", fontWeight: 700 }}>{displayEmp.name}</div>
          <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "2px" }}>
            {displayEmp.role}{displayEmp.department ? ` · ${displayEmp.department}` : ""}{displayEmp.location ? ` · ${displayEmp.location}` : ""}
          </div>
        </div>
      )}

      {/* Pay & metrics strip */}
      <div style={{ display: "flex", gap: "20px", padding: "10px 16px", background: "var(--surface2)", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
        {displayEmp?.payType === "hourly" && displayEmp.hourlyRate && (
          <div><div style={{ fontSize: "9px", color: "var(--text-muted)", fontWeight: 700, fontFamily: "var(--mono)" }}>HOURLY RATE</div><div style={{ fontSize: "13px", fontWeight: 700 }}>{formatCurrency(displayEmp.hourlyRate)}</div></div>
        )}
        {displayEmp?.payType === "salary" && displayEmp.annualPay && (
          <div><div style={{ fontSize: "9px", color: "var(--text-muted)", fontWeight: 700, fontFamily: "var(--mono)" }}>ANNUAL PAY</div><div style={{ fontSize: "13px", fontWeight: 700 }}>{formatCurrency(displayEmp.annualPay)}</div></div>
        )}
        {displayMetrics ? (
          <>
            <div><div style={{ fontSize: "9px", color: "var(--text-muted)", fontWeight: 700, fontFamily: "var(--mono)" }}>BASE EARNINGS</div><div style={{ fontSize: "13px", fontWeight: 700 }}>{formatCurrency(displayMetrics.earnings)}</div></div>
            {displayMetrics.hours ? <div><div style={{ fontSize: "9px", color: "var(--text-muted)", fontWeight: 700, fontFamily: "var(--mono)" }}>HOURS</div><div style={{ fontSize: "13px", fontWeight: 700 }}>{(displayMetrics.hours as number).toFixed(2)}</div></div> : null}
            <div><div style={{ fontSize: "9px", color: "var(--text-muted)", fontWeight: 700, fontFamily: "var(--mono)" }}>ACHIEVEMENT</div><div style={{ fontSize: "13px", fontWeight: 700, color: displayMetrics.achievement >= 100 ? "#2D6B1A" : "var(--brick)" }}>{displayMetrics.achievement.toFixed(1)}%{displayMetrics.capped ? " cap" : ""}</div></div>
            <div><div style={{ fontSize: "9px", color: "var(--text-muted)", fontWeight: 700, fontFamily: "var(--mono)" }}>BONUS</div><div style={{ fontSize: "13px", fontWeight: 700, color: "var(--brick)" }}>{formatCurrency(displayMetrics.bonus)}</div></div>
          </>
        ) : (
          <div style={{ fontSize: "11px", color: "var(--text-muted)", alignSelf: "center" }}>Earnings not available for this period yet.</div>
        )}
      </div>

      {/* Goals table */}
      {displayGoals.length > 0 ? (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
            <thead>
              <tr>
                <th style={thS}>Type</th>
                <th style={thS}>Goal</th>
                <th style={thC}>Target</th>
                <th style={thC}>Min</th>
                <th style={thC}>Actual</th>
                <th style={thC}>Weight</th>
                <th style={thC}>Achieve%</th>
                <th style={thC}>Bonus $</th>
              </tr>
            </thead>
            <tbody>
              {displayGoals.map((g) => (
                <tr key={g.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "5px 10px" }}><TierBadge tier={g.goalTier} /></td>
                  <td style={{ padding: "5px 10px", fontWeight: 600, minWidth: "140px" }}>{g.name}<GoalScopeTags location={g.location} department={g.department} /></td>
                  <td style={{ padding: "5px 10px", fontFamily: "var(--mono)", textAlign: "center" }}>{g.target != null ? formatNumber(g.target) : <span style={faint}>—</span>}</td>
                  <td style={{ padding: "5px 10px", fontFamily: "var(--mono)", textAlign: "center" }}>{g.min != null ? formatNumber(g.min) : <span style={faint}>—</span>}</td>
                  <td style={{ padding: "5px 10px", fontFamily: "var(--mono)", textAlign: "center" }}>{g.actual != null ? formatNumber(g.actual) : <span style={faint}>—</span>}</td>
                  <td style={{ padding: "5px 10px", fontFamily: "var(--mono)", textAlign: "center" }}>{g.weight.toFixed(1)}%</td>
                  <td style={{ padding: "5px 10px", fontFamily: "var(--mono)", textAlign: "center", fontWeight: 700 }}>
                    {g.achievement != null && g.actual != null
                      ? (g.metMin ? <span style={{ color: g.achievement >= 100 ? "#2D6B1A" : "var(--brick)" }}>{g.achievement.toFixed(1)}%</span> : <span style={{ color: "#9B2C2C" }}>Below min</span>)
                      : <span style={faint}>—</span>}
                  </td>
                  <td style={{ padding: "5px 10px", fontFamily: "var(--mono)", textAlign: "center" }}>{g.bonusContribution != null ? formatCurrency(g.bonusContribution) : <span style={faint}>—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ padding: "20px 16px", textAlign: "center", fontSize: "12px", color: "var(--text-muted)" }}>
          No goals assigned for this period yet.
        </div>
      )}
    </div>
  );
}

function LandingScreen({ onMode, profile }: {
  onMode: (mode: Screen) => void;
  profile: ManagerProfile | null;
}) {
  const isUser = profile?.role === "user";
  const isAdmin = profile?.role === "admin";
  const manageCards: { mode: Screen; label: string; text: string; icon: string }[] = [
    { mode: "setup", label: "Goals & Actuals", text: "Manage goals and enter monthly actuals in one place.", icon: "☰" },
    { mode: "scorecard", label: "Team Scorecards", text: "View live scorecards for your team based on goals, targets, and actuals.", icon: "✎" },
  ];
  const reviewCards: { mode: Screen; label: string; text: string; icon: string; adminOnly?: boolean }[] = [
    { mode: "history", label: "Historical Data", text: isUser ? "View your submitted scorecards." : "Search and review submitted scorecards across all employees and time periods.", icon: "◷" },
    { mode: "whatif", label: "What If Scorecard", text: "Explore how targets, actuals, and weights affect bonus calculations. Nothing here is saved.", icon: "◆" },
    { mode: "rippling", label: "Rippling Data", text: "Upload monthly CSV exports to auto-fill employee pay, title, and location data.", icon: "⇅", adminOnly: true },
    { mode: "users", label: "Users", text: "Invite users and assign scorecard access.", icon: "◇", adminOnly: true }
  ];
  const visibleReview = reviewCards.filter((card) => !card.adminOnly || isAdmin);
  return (
    <div className="screen active">
      <div className="landing-wrap">
        <div className="landing-kicker">{isUser ? `Welcome, ${profile?.linkedEmployeeName || ""}` : "Where would you like to go?"}</div>
        {/* Personal Scorecard card */}
        {profile && (
          <>
            <div className="landing-section-label">My Scorecard</div>
            <div className="landing-grid">
              <button className="landing-card" onClick={() => onMode("personal")}>
                <span>◉</span>
                <strong>My Scorecard</strong>
                <small>{profile.linkedEmployeeName ? `View your scorecard — ${profile.linkedEmployeeName}` : "View your personal scorecard and past submissions."}</small>
              </button>
            </div>
          </>
        )}
        {!isUser && (
          <>
            <div className="landing-section-label" style={{ marginTop: "18px" }}>Manage</div>
            <div className="landing-grid">
              {manageCards.map((card) => (
                <button key={card.mode} className="landing-card" onClick={() => onMode(card.mode)}>
                  <span>{card.icon}</span>
                  <strong>{card.label}</strong>
                  <small>{card.text}</small>
                </button>
              ))}
            </div>
          </>
        )}
        <div className="landing-section-label" style={{ marginTop: "18px" }}>Review</div>
        <div className="landing-grid landing-grid-review">
          {visibleReview.map((card) => (
            <button key={card.mode} className="landing-card" onClick={() => onMode(card.mode)}>
              <span>{card.icon}</span>
              <strong>{card.label}</strong>
              <small>{card.text}</small>
            </button>
          ))}
        </div>
        <div className="guide-callout-wrap">
          <button className="guide-callout" onClick={() => onMode("guide")}>
            <span>ⓘ</span>
            <div>
              <strong>How To Use</strong>
              <small>Step-by-step guide to setting up and using the app.</small>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

function UsersScreen(props: {
  users: AdminManagedUser[];
  loading: boolean;
  employees: Employee[];
  fixtureMode: boolean;
  currentUserId: string;
  onRefresh: () => void;
  onInvite: (payload: AdminUserPayload) => Promise<boolean>;
  onUpdate: (payload: AdminUserPayload) => Promise<boolean>;
  onResendInvite: (user: AdminManagedUser) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const sortedUsers = [...props.users].sort((a, b) => a.email.localeCompare(b.email));

  return (
    <div className="screen active users-screen">
      {props.fixtureMode && <div className="info-banner" style={{ display: "block" }}>Fixture mode simulates invites and permission updates locally.</div>}
      <section>
        <div className="toolbar-row">
          <div className="section-title" style={{ margin: 0, borderBottom: "none", paddingBottom: 0 }}>Invite User</div>
          <button onClick={props.onRefresh} disabled={props.loading}>{props.loading ? "Refreshing..." : "Refresh"}</button>
        </div>
        <UserPermissionForm
          mode="invite"
          employees={props.employees}
          submitLabel="Send Invite"
          onSubmit={props.onInvite}
        />
      </section>

      <section>
        <div className="section-title">Current Users</div>
        <div className="table-wrap">
          <table className="data-table users-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Status</th>
                <th>Role</th>
                <th>Scope</th>
                <th>Last Activity</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {!sortedUsers.length && (
                <tr><td colSpan={6}>{props.loading ? "Loading users..." : "No users found."}</td></tr>
              )}
              {sortedUsers.map((user) => (
                <React.Fragment key={user.id}>
                  <tr>
                    <td>
                      <strong>{user.email}</strong>
                      {user.id === props.currentUserId && <span className="user-self-badge">You</span>}
                      {!user.hasProfile && <span className="user-warning">No profile</span>}
                    </td>
                    <td><span className={`user-status ${user.status}`}>{statusLabel(user)}</span></td>
                    <td>{roleLabel(user.role)}</td>
                    <td>{scopeSummary(user)}</td>
                    <td style={{ fontSize: "12px", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                      {user.lastSignInAt
                        ? <>Last sign in<br />{formatTimestamp(user.lastSignInAt)}</>
                        : user.invitedAt
                        ? <>Invited<br />{formatTimestamp(user.invitedAt)}</>
                        : "—"}
                    </td>
                    <td className="row-menu-cell" style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                      <button
                        disabled={resendingId === user.id}
                        onClick={async () => {
                          setResendingId(user.id);
                          await props.onResendInvite(user);
                          setResendingId(null);
                        }}
                      >
                        {resendingId === user.id ? "Sending…" : "Resend Invite"}
                      </button>
                      <button onClick={() => setEditingId(editingId === user.id ? null : user.id)}>{editingId === user.id ? "Close" : "Edit"}</button>
                    </td>
                  </tr>
                  {editingId === user.id && (
                    <tr className="user-edit-row">
                      <td colSpan={6}>
                        <UserPermissionForm
                          mode="edit"
                          user={user}
                          employees={props.employees}
                          submitLabel="Save User"
                          onCancel={() => setEditingId(null)}
                          onSubmit={async (payload) => {
                            const saved = await props.onUpdate(payload);
                            if (saved) setEditingId(null);
                            return saved;
                          }}
                        />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function UserPermissionForm(props: {
  mode: "invite" | "edit";
  user?: AdminManagedUser;
  employees: Employee[];
  submitLabel: string;
  onSubmit: (payload: AdminUserPayload) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState(() => userDraftFromUser(props.user));

  useEffect(() => {
    setDraft(userDraftFromUser(props.user));
  }, [props.user?.id]);

  const employeeNames = useMemo(() => Array.from(new Set(props.employees.map((employee) => employee.name))).sort(), [props.employees]);
  const departmentOptions = departments.map((department) => ({ value: department, label: department }));
  const locationOptions = locations.map((location) => ({ value: location, label: location }));

  function setRole(role: ProfileRole) {
    setDraft((current) => ({
      ...current,
      role,
      departments: role === "manager" ? current.departments : [],
      locations: role === "manager" ? current.locations : [],
      linkedEmployeeName: role === "admin" ? "" : current.linkedEmployeeName,
      allDepartments: role === "manager" ? current.allDepartments : true,
      allLocations: role === "manager" ? current.allLocations : true
    }));
  }

  async function handleSubmit() {
    const saved = await props.onSubmit({
      id: draft.id,
      email: draft.email,
      role: draft.role,
      departments: draft.departments,
      locations: draft.locations,
      linkedEmployeeName: draft.linkedEmployeeName || undefined,
      allDepartments: draft.allDepartments,
      allLocations: draft.allLocations
    });
    if (saved && props.mode === "invite") setDraft(userDraftFromUser());
  }

  return (
    <div className="user-form">
      {/* Row 1: Email + Role */}
      <div className="user-form-row">
        {props.mode === "invite" && (
          <div className="field" style={{ flex: "1 1 0" }}>
            <label>Email</label>
            <input aria-label="Invite email" type="email" value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} placeholder="name@pressedfloral.com" />
          </div>
        )}
        <div className="field" style={{ flex: "0 0 180px" }}>
          <label>Role</label>
          <select aria-label="User role" value={draft.role} onChange={(event) => setRole(event.target.value as ProfileRole)}>
            <option value="manager">Manager</option>
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </div>
      </div>
      {/* Row 2: Manager scope fields */}
      {draft.role === "manager" && (
        <div className="user-form-row">
          <div className="field" style={{ flex: "1 1 0" }}>
            <div className="user-field-header">
              <label>Departments</label>
              <label className="check-label user-check">
                <input type="checkbox" checked={draft.allDepartments} onChange={(event) => setDraft({ ...draft, allDepartments: event.target.checked, departments: event.target.checked ? [] : draft.departments })} />
                All
              </label>
            </div>
            {!draft.allDepartments && (
              <MultiSelectDropdown label="Choose departments" options={departmentOptions} selected={draft.departments} onChange={(values) => setDraft({ ...draft, departments: values })} emptyLabel="No departments" />
            )}
          </div>
          <div className="field" style={{ flex: "1 1 0" }}>
            <div className="user-field-header">
              <label>Locations</label>
              <label className="check-label user-check">
                <input type="checkbox" checked={draft.allLocations} onChange={(event) => setDraft({ ...draft, allLocations: event.target.checked, locations: event.target.checked ? [] : draft.locations })} />
                All
              </label>
            </div>
            {!draft.allLocations && (
              <MultiSelectDropdown label="Choose locations" options={locationOptions} selected={draft.locations} onChange={(values) => setDraft({ ...draft, locations: values })} emptyLabel="No locations" />
            )}
          </div>
          <div className="field" style={{ flex: "1 1 0" }}>
            <label>Reporting Tree Root</label>
            <select aria-label="Reporting tree root" value={draft.linkedEmployeeName} onChange={(event) => setDraft({ ...draft, linkedEmployeeName: event.target.value })}>
              <option value="">No linked employee</option>
              {employeeNames.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>
        </div>
      )}
      {/* Row 2: User linked employee */}
      {draft.role === "user" && (
        <div className="user-form-row">
          <div className="field" style={{ flex: "1 1 0" }}>
            <label>Linked Employee</label>
            <select aria-label="Linked employee" value={draft.linkedEmployeeName} onChange={(event) => setDraft({ ...draft, linkedEmployeeName: event.target.value })}>
              <option value="">Choose employee</option>
              {employeeNames.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>
        </div>
      )}
      <div className="button-row user-form-actions">
        {props.onCancel && <button onClick={props.onCancel}>Cancel</button>}
        <button className="submit-btn user-submit" onClick={handleSubmit}>{props.submitLabel}</button>
      </div>
    </div>
  );
}

function userDraftFromUser(user?: AdminManagedUser): AdminUserPayload & { email: string; linkedEmployeeName: string; allDepartments: boolean; allLocations: boolean } {
  if (!user) {
    return {
      email: "",
      role: "manager",
      departments: ["Design"],
      locations: ["Utah"],
      linkedEmployeeName: "",
      allDepartments: false,
      allLocations: false
    };
  }
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    departments: user.departments,
    locations: user.locations,
    linkedEmployeeName: user.linkedEmployeeName || "",
    allDepartments: user.role !== "manager" || user.departments.length === 0,
    allLocations: user.role !== "manager" || user.locations.length === 0
  };
}

function roleLabel(role: ProfileRole) {
  return role === "admin" ? "Admin" : role === "manager" ? "Manager" : "User";
}

function statusLabel(user: AdminManagedUser) {
  if (user.status === "active") return user.lastSignInAt ? `Active · ${shortDate(user.lastSignInAt)}` : "Active";
  if (user.status === "invited") return user.invitedAt ? `Invited · ${shortDate(user.invitedAt)}` : "Invited";
  return "Unconfirmed";
}

function shortDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatTimestamp(value: string) {
  const d = new Date(value);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
    " " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function GoalsScreen(props: {
  month: string;
  months: string[];
  filters: { types: string[]; location: string; departments: string[]; sort: string; showInactive: boolean };
  goals: Goal[];
  actuals: ActualsByKey;
  allActuals: Record<string, ActualsByKey>;
  editingGoal: Goal | null;
  readonly?: boolean;
  onMonth: (value: string) => void;
  onFilters: (value: { types: string[]; location: string; departments: string[]; sort: string; showInactive: boolean }) => void;
  onActual: (goal: Goal, value: string, period?: string) => void;
  onEdit: (goal: Goal | null) => void;
  onSave: (goal: Goal) => Goal | null | void | Promise<Goal | null | void>;
  onSaveTargetPair: (goal: Goal, target: string, min: string, period?: string) => void;
  onDelete: (id: string) => void;
  onToggle: (id: string) => void;
  onToggleMonth: (goal: Goal) => void;
  isAdmin?: boolean;
  allowedDepartments?: string[];
}) {
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const [actualEditId, setActualEditId] = useState<string | null>(null);

  const now = new Date();
  const currentMonthVal = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
  let monthStatus = "";
  let isGoalLocked = false;   // goals can't be edited (past > 21 days)
  let isActualLocked = true;  // actuals can only be entered for past months within 21 days
  if (props.month) {
    if (props.month < currentMonthVal) {
      const [y, m] = props.month.split("-");
      const monthEnd = new Date(parseInt(y), parseInt(m), 0);
      const daysSince = Math.floor((now.getTime() - monthEnd.getTime()) / (1000 * 60 * 60 * 24));
      isGoalLocked = daysSince > 21;
      isActualLocked = daysSince > 21;
      monthStatus = isGoalLocked
        ? "🔒 Past month — locked"
        : `⚠️ Past month — actuals & goals editable for ${21 - daysSince} more days`;
    } else if (props.month === currentMonthVal) {
      monthStatus = "● Current month — actuals entered after month ends";
    } else {
      monthStatus = "○ Future month — plan goals ahead";
    }
  }
  const effectiveReadonly = props.readonly || isGoalLocked;
  const actualsReadonly = props.readonly || isActualLocked;

  const quarterKey = quarterKeyForMonth(props.month);
  const quarterActuals = props.allActuals[quarterKey] || {};
  const monthlyGoals = props.goals.filter((g) => g.periodType !== "quarterly");
  const quarterlyGoals = props.goals.filter((g) => g.periodType === "quarterly");

  const goalHasTargets = (goal: Goal) => {
    const a = goal.periodType === "quarterly" ? quarterActuals : props.actuals;
    return a[metaKey("target", goal)] != null && a[metaKey("min", goal)] != null;
  };

  const isMonthlyInactive = (goal: Goal) => !!props.actuals["__monthly_inactive__" + actualKey(goal)];

  const handleSaveTargetPair = (goal: Goal, target: string, min: string) => {
    const period = goal.periodType === "quarterly" ? quarterKey : undefined;
    props.onSaveTargetPair(goal, target, min, period);
  };

  const mergedActuals = { ...props.actuals, ...quarterActuals };

  function locLabel(loc?: string) {
    if (!loc) return "—";
    if (loc === "Utah") return "UT";
    if (loc === "Georgia") return "GA";
    if (loc === "Remote") return "Rem";
    return loc.slice(0, 3);
  }

  function cappedLabel(goal: Goal) {
    if (goal.capped !== "yes") return "No";
    return `Yes (${goal.capPct}%)`;
  }

  const thCtx = { background: "#faf8f5" } as React.CSSProperties;
  const thGoal = { background: "#f2f7fa" } as React.CSSProperties;
  const thTarget = { background: "#f5f8f3" } as React.CSSProperties;
  const thActual = { background: "#eef5ec" } as React.CSSProperties;
  const thStatus = { background: "#fff" } as React.CSSProperties;

  return (
    <div className="screen active" onClick={() => { setMenuOpenId(null); setMenuPos(null); setActualEditId(null); }}>
      <section style={{ padding: "12px 16px 10px" }}>
        {/* Toolbar: title + month + status | Show inactive */}
        <div className="toolbar-row" style={{ marginBottom: 10, gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", minWidth: 0 }}>
            <div className="section-title" style={{ margin: 0, borderBottom: "none", paddingBottom: 0 }}>Goals & Actuals</div>
            <select className="bank-filter-select" style={{ flex: "none" }} value={props.month} onChange={(e) => props.onMonth(e.target.value)}>
              {props.months.filter((m) => {
                if (!/^\d{4}-\d{2}$/.test(m)) return false;
                const now = new Date();
                const cur = now.getFullYear() * 12 + now.getMonth();
                const [y, mo] = m.split("-").map(Number);
                const val = y * 12 + (mo - 1);
                return val >= cur - 12 && val <= cur + 3;
              }).map((month) => <option key={month} value={month}>{formatMonthLabel(month)}</option>)}
            </select>
            {monthStatus && <span className="current-month-tag" style={{ whiteSpace: "nowrap" }}>{monthStatus}</span>}
          </div>
          <label className="check-label" style={{ fontSize: "12px", whiteSpace: "nowrap", flexShrink: 0 }}>
            <input type="checkbox" checked={props.filters.showInactive} onChange={(e) => props.onFilters({ ...props.filters, showInactive: e.target.checked })} style={{ accentColor: "var(--brick)" }} />
            Show inactive
          </label>
        </div>
        {/* Filter row */}
        <div className="filter-row" style={{ gap: 8 }}>
          <MultiSelectDropdown
            label="All types"
            options={[
              ...(props.isAdmin ? [{ value: "company", label: "Company" }] : []),
              { value: "department", label: "Department" },
              { value: "individual", label: "Individual" }
            ]}
            selected={props.filters.types.filter((t) => props.isAdmin || t !== "company")}
            onChange={(types) => props.onFilters({ ...props.filters, types: props.isAdmin ? types : types.filter((t) => t !== "company") })}
          />
          <select className="bank-filter-select" value={props.filters.location} onChange={(e) => props.onFilters({ ...props.filters, location: e.target.value })}>
            <option value="">All locations</option>
            <option value="Utah">Utah</option>
            <option value="Georgia">Georgia</option>
            <option value="Remote">Remote</option>
          </select>
          <MultiSelectDropdown
            label="All departments"
            options={departments.map((d) => ({ value: d, label: d }))}
            selected={props.filters.departments}
            onChange={(depts) => props.onFilters({ ...props.filters, departments: depts })}
          />
          <select className="bank-filter-select" value={props.filters.sort} onChange={(e) => props.onFilters({ ...props.filters, sort: e.target.value })}>
            <option value="goalTier">Sort: Type</option>
            <option value="department">Sort: Dept</option>
            <option value="location">Sort: Location</option>
            <option value="name">Sort: Name</option>
          </select>
          <button className="reset-filters-btn" onClick={() => props.onFilters({ types: props.isAdmin ? ["company", "department", "individual"] : ["department", "individual"], location: "", departments: [...departments], sort: "goalTier", showInactive: false })}>Reset</button>
        </div>
      </section>
      <section style={{ padding: 0 }}>
        <div style={{ overflowX: "auto" }}>
          <table className="data-table bank-table">
            <colgroup>
              <col style={{ width: "44px" }} />
              <col style={{ width: "46px" }} />
              <col style={{ width: "78px" }} />
              <col />
              <col style={{ width: "38px" }} />
              <col style={{ width: "46px" }} />
              <col style={{ width: "60px" }} />
              <col style={{ width: "58px" }} />
              <col style={{ width: "52px" }} />
              <col style={{ width: "70px" }} />
              <col style={{ width: "58px" }} />
              <col style={{ width: "36px" }} />
            </colgroup>
            <thead>
              <tr>
                <th style={thCtx}>Type</th>
                <th style={thCtx}>Loc</th>
                <th style={thCtx}>Dept</th>
                <th style={thGoal}>Goal Name</th>
                <th style={{ ...thGoal, textAlign: "center" }}>Per.</th>
                <th style={thGoal}>Lower</th>
                <th style={thGoal}>Cap</th>
                <th style={thTarget}>Target</th>
                <th style={thTarget}>Min</th>
                <th style={thActual}>Actual</th>
                <th style={thStatus}>Status</th>
                <th style={thStatus}></th>
              </tr>
            </thead>
            <tbody>
              {monthlyGoals.map((goal) => {
                const a = props.actuals;
                return (
                <React.Fragment key={goal.id}>
                <tr style={(!goal.active || isMonthlyInactive(goal)) ? { opacity: 0.45 } : undefined}>
                  <td style={thCtx}><TierBadge tier={goal.goalTier} /></td>
                  <td style={{ ...thCtx, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{locLabel(goal.location)}</td>
                  <td style={{ ...thCtx, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{goal.department || "—"}</td>
                  <td style={{ ...thGoal, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {goal.name}{goal.goalTier === "individual" && goal.role && <span style={{ fontSize: "9px", padding: "1px 5px", borderRadius: "99px", background: "#e9e9e9", color: "#555", fontWeight: 600, fontFamily: "var(--mono)", whiteSpace: "nowrap", marginLeft: "4px" }}>{goal.role}</span>}
                  </td>
                  <td style={{ ...thGoal, textAlign: "center" }}><span style={{ fontSize: "9px", fontWeight: 700, fontFamily: "var(--mono)", color: "var(--text-muted)" }}>M</span></td>
                  <td style={thGoal}>{goal.lowerBetter ? "Yes" : "No"}</td>
                  <td style={thGoal}>{cappedLabel(goal)}</td>
                  <td style={thTarget}>{a[metaKey("target", goal)] != null ? formatNumber(a[metaKey("target", goal)] as number) : "—"}</td>
                  <td style={thTarget}>{a[metaKey("min", goal)] != null ? formatNumber(a[metaKey("min", goal)] as number) : "—"}</td>
                  <td style={thActual} onClick={(e) => e.stopPropagation()}>
                    {!actualsReadonly && (props.isAdmin || goal.goalTier !== "company") && goalHasTargets(goal) && actualEditId === goal.id ? (
                      <input
                        autoFocus
                        aria-label={`Actual for ${goal.name}`}
                        type="number"
                        className="actual-inline-input"
                        defaultValue={a[actualKey(goal)] ?? ""}
                        onBlur={(e) => { const period = goal.periodType === "quarterly" ? quarterKey : undefined; props.onActual(goal, e.target.value, period); setActualEditId(null); }}
                        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setActualEditId(null); }}
                      />
                    ) : (
                      <span className="actual-value" title={!goalHasTargets(goal) ? "Set a target and minimum first" : undefined} style={!actualsReadonly && (props.isAdmin || goal.goalTier !== "company") && !goalHasTargets(goal) ? { color: "var(--text-faint)", fontSize: "11px" } : undefined}>
                        {a[actualKey(goal)] != null ? formatNumber(a[actualKey(goal)] as number) : ((!actualsReadonly && (props.isAdmin || goal.goalTier !== "company") && !goalHasTargets(goal)) ? "no target set" : "—")}
                      </span>
                    )}
                  </td>
                  <td style={thStatus}>
                    {(() => { const on = goal.active && !isMonthlyInactive(goal); return (
                      <span style={{ fontSize: "9px", padding: "1px 6px", borderRadius: "99px", fontWeight: 600, background: on ? "#eef5ec" : "#f0ece6", color: on ? "#1a5c1a" : "#7a7268" }}>
                        {on ? "Active" : "Inactive"}
                      </span>
                    ); })()}
                  </td>
                  {!effectiveReadonly && (props.isAdmin || goal.goalTier !== "company") && (
                    <td style={{ ...thStatus, textAlign: "center" }} className="row-menu-cell" onClick={(e) => e.stopPropagation()}>
                      <button
                        className="row-menu-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (menuOpenId === goal.id) {
                            setMenuOpenId(null);
                            setMenuPos(null);
                          } else {
                            const rect = e.currentTarget.getBoundingClientRect();
                            setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
                            setMenuOpenId(goal.id);
                          }
                        }}
                      >⋮</button>
                    </td>
                  )}
                  {(effectiveReadonly || (!props.isAdmin && goal.goalTier === "company")) && <td style={thStatus} />}
                </tr>
                {!effectiveReadonly && (props.isAdmin || goal.goalTier !== "company") && props.editingGoal?.id === goal.id && (
                  <tr className="goal-editor-row">
                    <td colSpan={12}>
                      <GoalEditor goal={props.editingGoal} actuals={mergedActuals} isAdmin={props.isAdmin} allowedDepartments={props.allowedDepartments} onCancel={() => props.onEdit(null)} onSave={props.onSave} onSaveTargetPair={handleSaveTargetPair} />
                    </td>
                  </tr>
                )}
                </React.Fragment>
                );
              })}
              {quarterlyGoals.length > 0 && (
                <tr>
                  <td colSpan={12} style={{ background: "var(--surface2)", padding: "6px 10px", fontSize: "10px", fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.5px", fontFamily: "var(--mono)", textTransform: "uppercase", borderTop: "2px solid var(--border)" }}>
                    Quarterly Goals — {quarterRangeLabel(props.month)}
                  </td>
                </tr>
              )}
              {quarterlyGoals.map((goal) => {
                const a = quarterActuals;
                return (
                <React.Fragment key={goal.id}>
                <tr style={(!goal.active || isMonthlyInactive(goal)) ? { opacity: 0.45 } : undefined}>
                  <td style={thCtx}><TierBadge tier={goal.goalTier} /></td>
                  <td style={{ ...thCtx, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{locLabel(goal.location)}</td>
                  <td style={{ ...thCtx, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{goal.department || "—"}</td>
                  <td style={{ ...thGoal, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {goal.name}{goal.goalTier === "individual" && goal.role && <span style={{ fontSize: "9px", padding: "1px 5px", borderRadius: "99px", background: "#e9e9e9", color: "#555", fontWeight: 600, fontFamily: "var(--mono)", whiteSpace: "nowrap", marginLeft: "4px" }}>{goal.role}</span>}
                  </td>
                  <td style={{ ...thGoal, textAlign: "center" }}><span style={{ fontSize: "9px", fontWeight: 700, fontFamily: "var(--mono)", color: "#7a4400", background: "#fdf0e0", padding: "1px 4px", borderRadius: "3px" }}>Q</span></td>
                  <td style={thGoal}>{goal.lowerBetter ? "Yes" : "No"}</td>
                  <td style={thGoal}>{cappedLabel(goal)}</td>
                  <td style={thTarget}>{a[metaKey("target", goal)] != null ? formatNumber(a[metaKey("target", goal)] as number) : "—"}</td>
                  <td style={thTarget}>{a[metaKey("min", goal)] != null ? formatNumber(a[metaKey("min", goal)] as number) : "—"}</td>
                  <td style={thActual} onClick={(e) => e.stopPropagation()}>
                    {!actualsReadonly && (props.isAdmin || goal.goalTier !== "company") && goalHasTargets(goal) && actualEditId === goal.id ? (
                      <input
                        autoFocus
                        aria-label={`Actual for ${goal.name}`}
                        type="number"
                        className="actual-inline-input"
                        defaultValue={a[actualKey(goal)] ?? ""}
                        onBlur={(e) => { const period = goal.periodType === "quarterly" ? quarterKey : undefined; props.onActual(goal, e.target.value, period); setActualEditId(null); }}
                        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setActualEditId(null); }}
                      />
                    ) : (
                      <span className="actual-value" title={!goalHasTargets(goal) ? "Set a target and minimum first" : undefined} style={!actualsReadonly && (props.isAdmin || goal.goalTier !== "company") && !goalHasTargets(goal) ? { color: "var(--text-faint)", fontSize: "11px" } : undefined}>
                        {a[actualKey(goal)] != null ? formatNumber(a[actualKey(goal)] as number) : ((!actualsReadonly && (props.isAdmin || goal.goalTier !== "company") && !goalHasTargets(goal)) ? "no target set" : "—")}
                      </span>
                    )}
                  </td>
                  <td style={thStatus}>
                    {(() => { const on = goal.active && !isMonthlyInactive(goal); return (
                      <span style={{ fontSize: "9px", padding: "1px 6px", borderRadius: "99px", fontWeight: 600, background: on ? "#eef5ec" : "#f0ece6", color: on ? "#1a5c1a" : "#7a7268" }}>
                        {on ? "Active" : "Inactive"}
                      </span>
                    ); })()}
                  </td>
                  {!effectiveReadonly && (props.isAdmin || goal.goalTier !== "company") && (
                    <td style={{ ...thStatus, textAlign: "center" }} className="row-menu-cell" onClick={(e) => e.stopPropagation()}>
                      <button
                        className="row-menu-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (menuOpenId === goal.id) {
                            setMenuOpenId(null);
                            setMenuPos(null);
                          } else {
                            const rect = e.currentTarget.getBoundingClientRect();
                            setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
                            setMenuOpenId(goal.id);
                          }
                        }}
                      >⋮</button>
                    </td>
                  )}
                  {(effectiveReadonly || (!props.isAdmin && goal.goalTier === "company")) && <td style={thStatus} />}
                </tr>
                {!effectiveReadonly && (props.isAdmin || goal.goalTier !== "company") && props.editingGoal?.id === goal.id && (
                  <tr className="goal-editor-row">
                    <td colSpan={12}>
                      <GoalEditor goal={props.editingGoal} actuals={mergedActuals} isAdmin={props.isAdmin} allowedDepartments={props.allowedDepartments} onCancel={() => props.onEdit(null)} onSave={props.onSave} onSaveTargetPair={handleSaveTargetPair} />
                    </td>
                  </tr>
                )}
                </React.Fragment>
                );
              })}
              {!effectiveReadonly && props.editingGoal && !props.goals.find((g) => g.id === props.editingGoal!.id) && (
                <tr className="goal-editor-row">
                  <td colSpan={12}>
                    <GoalEditor goal={props.editingGoal} actuals={mergedActuals} isAdmin={props.isAdmin} allowedDepartments={props.allowedDepartments} onCancel={() => props.onEdit(null)} onSave={props.onSave} onSaveTargetPair={handleSaveTargetPair} />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {!props.goals.length && <div className="no-goals-msg" style={{ display: "block" }}>No goals match the current filter</div>}
        {!effectiveReadonly && (
          <div style={{ padding: "12px 16px" }}>
            <button className="add-goal-btn" onClick={() => props.onEdit({ ...emptyGoal, id: `goal-${Date.now()}` })}>+ Add Goal to Bank</button>
          </div>
        )}
      </section>
      {menuOpenId && menuPos && (() => {
        const goal = props.goals.find((g) => g.id === menuOpenId);
        if (!goal) return null;
        return (
          <div
            className="row-menu"
            style={{ position: "fixed", top: menuPos.top, right: menuPos.right, zIndex: 1000 }}
            onClick={(e) => e.stopPropagation()}
          >
            {!effectiveReadonly && (props.isAdmin || goal.goalTier !== "company") && <button onClick={() => { props.onEdit(goal); setMenuOpenId(null); setMenuPos(null); }}>Edit goal</button>}
            {!actualsReadonly && (props.isAdmin || goal.goalTier !== "company") && goalHasTargets(goal) && <button onClick={() => { setActualEditId(goal.id); setMenuOpenId(null); setMenuPos(null); }}>Enter actual</button>}
            {!actualsReadonly && (props.isAdmin || goal.goalTier !== "company") && !goalHasTargets(goal) && <span style={{ display: "block", padding: "8px 12px", fontSize: "12px", color: "var(--text-faint)" }}>Set target first</span>}
            {!effectiveReadonly && (props.isAdmin || goal.goalTier !== "company") && <button onClick={() => { props.onToggleMonth(goal); setMenuOpenId(null); setMenuPos(null); }}>{isMonthlyInactive(goal) ? "Activate for this month" : "Deactivate for this month"}</button>}
            {(!props.isAdmin && goal.goalTier === "company") && <span style={{ display: "block", padding: "8px 12px", fontSize: "12px", color: "var(--text-faint)" }}>No edits allowed</span>}
          </div>
        );
      })()}
    </div>
  );
}

function MultiSelectDropdown({ label, options, selected, onChange, emptyLabel }: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (values: string[]) => void;
  emptyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function close(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const allChecked = selected.length === options.length;
  const noneChecked = selected.length === 0;

  let displayLabel = label;
  if (noneChecked) displayLabel = emptyLabel ?? "None";
  else if (!allChecked) displayLabel = selected.length === 1 ? (options.find((o) => o.value === selected[0])?.label ?? label) : `${selected.length} selected`;

  function toggleAll() {
    onChange(allChecked ? [] : options.map((o) => o.value));
  }

  function toggleOne(value: string) {
    const next = selected.includes(value)
      ? selected.filter((v) => v !== value)
      : [...selected, value];
    onChange(next);
  }

  return (
    <div ref={ref} className={`multi-select-dropdown${open ? " open" : ""}`} onClick={(e) => e.stopPropagation()}>
      <div className="multi-select-trigger" onClick={() => setOpen(!open)}>
        <span>{displayLabel}</span>
        <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>&#9660;</span>
      </div>
      <div className="multi-select-menu">
        <label className="multi-select-item" style={{ borderBottom: "1px solid var(--border)", marginBottom: "4px", paddingBottom: "6px" }}>
          <input type="checkbox" checked={allChecked} onChange={toggleAll} style={{ accentColor: "var(--brick)" }} />
          <em>{label}</em>
        </label>
        {options.map((opt) => (
          <label key={opt.value} className="multi-select-item">
            <input type="checkbox" value={opt.value} checked={selected.includes(opt.value)} onChange={() => toggleOne(opt.value)} style={{ accentColor: "var(--brick)" }} />
            {opt.label}
          </label>
        ))}
      </div>
    </div>
  );
}

const tierColors: Record<string, { bg: string; color: string }> = {
  company: { bg: "#f5e6d3", color: "#7a3010" },
  department: { bg: "#d6e8d6", color: "#1a5c1a" },
  individual: { bg: "#d3e4f5", color: "#0a3d6b" }
};

function TierBadge({ tier }: { tier: string }) {
  const c = tierColors[tier] || { bg: "#eee", color: "#333" };
  const label = tier === "individual" ? "Indiv" : tier === "department" ? "Dept" : "Co";
  return <span style={{ fontSize: "9px", padding: "1px 5px", borderRadius: "99px", background: c.bg, color: c.color, fontWeight: 700, fontFamily: "var(--mono)", whiteSpace: "nowrap" }}>{label}</span>;
}

function GoalScopeTags({ location, department }: { location?: string; department?: string }) {
  if (!location && !department) return null;
  const tagStyle: React.CSSProperties = { fontSize: "9px", padding: "1px 5px", borderRadius: "99px", background: "#e9e9e9", color: "#555", fontWeight: 600, fontFamily: "var(--mono)", whiteSpace: "nowrap", marginLeft: "4px" };
  return (
    <>
      {location && <span style={tagStyle}>{location}</span>}
      {department && <span style={tagStyle}>{department}</span>}
    </>
  );
}

function GoalEditor({ goal, actuals, isAdmin, allowedDepartments, onSave, onSaveTargetPair, onCancel }: { goal: Goal; actuals: ActualsByKey; isAdmin?: boolean; allowedDepartments?: string[]; onSave: (goal: Goal) => Goal | null | void | Promise<Goal | null | void>; onSaveTargetPair: (goal: Goal, target: string, min: string) => void | Promise<void>; onCancel: () => void }) {
  const isNew = goal.name === "";
  const [draft, setDraft] = useState(goal);
  const [target, setTarget] = useState(actuals[metaKey("target", goal)] != null ? String(actuals[metaKey("target", goal)]) : String(goal.goalValue || ""));
  const [min, setMin] = useState(actuals[metaKey("min", goal)] != null ? String(actuals[metaKey("min", goal)]) : String(goal.minValue || ""));

  // Required fields that must be explicitly chosen — blank ("" or "__unset__") on new goals
  const [tierVal, setTierVal] = useState<string>(isNew ? "" : goal.goalTier);
  const [locVal, setLocVal] = useState<string>(isNew ? "__unset__" : (goal.location ?? ""));
  const [deptVal, setDeptVal] = useState<string>(isNew ? "__unset__" : (goal.department ?? ""));
  const [roleVal, setRoleVal] = useState<string>(isNew ? "__unset__" : (goal.role ?? ""));
  const [lowerVal, setLowerVal] = useState<string>(isNew ? "" : String(goal.lowerBetter));
  const [cappedVal, setCappedVal] = useState<string>(isNew ? "" : goal.capped);
  const [periodVal, setPeriodVal] = useState<string>(isNew ? "" : (goal.periodType || "monthly"));

  const visibleDepartments = allowedDepartments?.length ? allowedDepartments : departments;
  const roles = (deptVal && deptVal !== "__unset__") ? (rolesByDepartment[deptVal] || []) : [];

  const isIndividual = tierVal === "individual";

  const missing: string[] = [];
  if (!draft.name.trim()) missing.push("Goal Name");
  if (!tierVal) missing.push("Type");
  if (locVal === "__unset__") missing.push("Location");
  if (deptVal === "__unset__") missing.push("Department");
  if (isIndividual && roleVal === "__unset__") missing.push("Role");
  if (!lowerVal) missing.push("Lower is Better");
  if (!cappedVal) missing.push("Capped");
  if (!periodVal) missing.push("Period Type");
  const canSave = missing.length === 0;

  async function handleSave() {
    if (!canSave) return;
    const finalGoal: Goal = {
      ...draft,
      goalTier: tierVal as GoalTier,
      location: locVal === "" ? undefined : locVal,
      department: deptVal === "" ? undefined : deptVal,
      role: roleVal === "" ? undefined : roleVal,
      lowerBetter: lowerVal === "true",
      capped: cappedVal as "yes" | "no",
      periodType: periodVal as "monthly" | "quarterly",
    };
    const savedGoal = await onSave(finalGoal);
    if (savedGoal === null) return;
    await onSaveTargetPair(savedGoal || finalGoal, target, min);
  }

  const reqStyle: React.CSSProperties = { color: "var(--brick)", marginLeft: 2 };

  return (
    <div className="goal-editor-inline">
      <div className="section-title" style={{ marginBottom: 12 }}>{goal.name ? "Edit Goal" : "Add Goal"}</div>
      <div className="fields-grid">
        <div className="field">
          <label>Type<span style={reqStyle}>*</span></label>
          <select value={tierVal} onChange={(e) => { setTierVal(e.target.value); if (e.target.value !== "individual") setRoleVal(""); }} style={!tierVal ? { color: "var(--text-muted)" } : undefined}>
            <option value="" disabled hidden>— select —</option>
            {isAdmin && <option value="company">Company</option>}
            <option value="department">Department</option>
            <option value="individual">Individual</option>
          </select>
        </div>
        <div className="field">
          <label>Location<span style={reqStyle}>*</span></label>
          <select value={locVal} onChange={(e) => setLocVal(e.target.value)} style={locVal === "__unset__" ? { color: "var(--text-muted)" } : undefined}>
            <option value="__unset__" disabled hidden>— select —</option>
            <option value="">All locations</option>
            <option>Utah</option>
            <option>Georgia</option>
            <option>Remote</option>
          </select>
        </div>
        <div className="field">
          <label>Department<span style={reqStyle}>*</span></label>
          <select value={deptVal} onChange={(e) => { setDeptVal(e.target.value); setRoleVal("__unset__"); }} style={deptVal === "__unset__" ? { color: "var(--text-muted)" } : undefined}>
            <option value="__unset__" disabled hidden>— select —</option>
            {isAdmin && <option value="">All departments</option>}
            {visibleDepartments.map((d) => <option key={d}>{d}</option>)}
          </select>
        </div>
        {isIndividual && (
          <div className="field">
            <label>Role<span style={reqStyle}>*</span></label>
            <select value={roleVal} onChange={(e) => setRoleVal(e.target.value)} style={roleVal === "__unset__" ? { color: "var(--text-muted)" } : undefined}>
              <option value="__unset__" disabled hidden>— select —</option>
              <option value="">All roles</option>
              {roles.map((r) => <option key={r}>{r}</option>)}
            </select>
          </div>
        )}
        <div className="field half"><label>Goal Name<span style={reqStyle}>*</span></label><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Monthly Revenue" /></div>
        <div className="field"><label>Target</label><input type="number" value={target} onChange={(e) => setTarget(e.target.value)} /></div>
        <div className="field"><label>Minimum</label><input type="number" value={min} onChange={(e) => setMin(e.target.value)} /></div>
        <div className="field">
          <label>Lower is Better<span style={reqStyle}>*</span></label>
          <select value={lowerVal} onChange={(e) => setLowerVal(e.target.value)} style={!lowerVal ? { color: "var(--text-muted)" } : undefined}>
            <option value="" disabled hidden>— select —</option>
            <option value="false">No</option>
            <option value="true">Yes</option>
          </select>
        </div>
        <div className="field">
          <label>Capped<span style={reqStyle}>*</span></label>
          <select value={cappedVal} onChange={(e) => setCappedVal(e.target.value)} style={!cappedVal ? { color: "var(--text-muted)" } : undefined}>
            <option value="" disabled hidden>— select —</option>
            <option value="no">No</option>
            <option value="yes">Yes</option>
          </select>
        </div>
        {cappedVal === "yes" && (
          <div className="field"><label>Cap %</label><input type="number" value={draft.capPct} onChange={(e) => setDraft({ ...draft, capPct: Number(e.target.value) })} /></div>
        )}
        <div className="field">
          <label>Period Type<span style={reqStyle}>*</span></label>
          <select value={periodVal} onChange={(e) => setPeriodVal(e.target.value)} style={!periodVal ? { color: "var(--text-muted)" } : undefined}>
            <option value="" disabled hidden>— select —</option>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
          </select>
        </div>
      </div>
      {!canSave && missing.length > 0 && (
        <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: 8, fontFamily: "var(--sans)" }}>
          Required: {missing.join(", ")}
        </div>
      )}
      <div className="button-row">
        <button className="submit-btn" onClick={handleSave} disabled={!canSave} title={!canSave ? `Complete required fields: ${missing.join(", ")}` : undefined}>Save Goal</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function ScorecardsScreen(props: {
  selectedMonths: string[];
  months: string[];
  profile: ManagerProfile | null;
  rippling: Record<string, Employee[]>;
  allEmployees: Employee[];
  scorecards: Scorecard[];
  allGoals: Goal[];
  allActuals: Record<string, ActualsByKey>;
  onMonths: (months: string[]) => void;
  onSubmitScorecard: (scorecard: Scorecard) => void;
  onDeleteGoal: (value: { scorecardId: string; goalName: string }) => void;
  currentUserEmail: string;
}) {
  const [filterEmployees, setFilterEmployees] = useState<string[]>([]);
  const [filterDepts, setFilterDepts] = useState<string[]>([]);
  const [filterLocations, setFilterLocations] = useState<string[]>([]);
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);

  // Single-month mode = exactly one month selected → live draft cards
  // Multi/all mode = 0 or 2+ months → live draft cards per month, grouped by month
  const singleMonthMode = props.selectedMonths.length === 1;
  const selectedMonth = singleMonthMode ? props.selectedMonths[0] : "";
  const periodLabel = formatMonthLabel(selectedMonth);

  // Deduplicated latest employees — fallback when selected month has no Rippling upload
  const latestEmployees = useMemo(() => {
    const periods = Object.keys(props.rippling).sort().reverse();
    const seen = new Set<string>();
    const result: Employee[] = [];
    for (const period of periods) {
      for (const emp of props.rippling[period] || []) {
        if (!seen.has(emp.name)) { seen.add(emp.name); result.push(emp); }
      }
    }
    return result;
  }, [props.rippling]);

  // Use selected month's data if available, otherwise fall back to latest employees
  const monthRaw = singleMonthMode ? (props.rippling[selectedMonth] || []) : [];
  const monthEmployees = monthRaw.length > 0 ? monthRaw : (singleMonthMode ? latestEmployees : []);
  const teamEmployees = scopedEmployeesForProfile(monthEmployees, props.profile, props.allEmployees);

  const earningsPeriodKey = (() => {
    if (!selectedMonth) return "";
    const [y, m] = selectedMonth.split("-").map(Number);
    if (!y || !m) return "";
    return `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}`;
  })();
  const earningsUpload = props.rippling[earningsPeriodKey] || [];
  function withActualEarnings(emp: Employee): Employee {
    const src = earningsUpload.find((e) => e.name === emp.name);
    return { ...emp, grossEarnings: src?.grossEarnings, hoursWorked: src?.hoursWorked };
  }
  const periodActuals = {
    ...(props.allActuals[periodLabel] || {}),
    ...(props.allActuals[quarterKeyForMonth(selectedMonth)] || {}),
  };

  // Latest employees scoped to profile — used for multi-month mode filters
  const multiMonthTeam = scopedEmployeesForProfile(latestEmployees, props.profile, props.allEmployees);

  // Filter options from team employees (single) or latest scoped team (multi/all)
  const teamDepts = singleMonthMode
    ? Array.from(new Set(teamEmployees.map((e) => e.department).filter(Boolean))).sort()
    : Array.from(new Set(multiMonthTeam.map((e) => e.department).filter(Boolean))).sort();
  const teamLocations = singleMonthMode
    ? Array.from(new Set(teamEmployees.map((e) => e.location).filter(Boolean))).sort()
    : Array.from(new Set(multiMonthTeam.map((e) => e.location).filter(Boolean))).sort();
  const showDeptFilter = teamDepts.length > 1;
  const showLocationFilter = teamLocations.length > 1;

  function goalsForEmployee(employee: Employee, actuals: Record<string, number | null> = periodActuals): Goal[] {
    return props.allGoals.filter((goal) => {
      if (actuals["__monthly_inactive__" + actualKey(goal)]) return false;
      if (goal.goalTier === "company") return true;
      if (goal.goalTier === "department") return goal.department === employee.department && (!goal.location || goal.location === employee.location);
      return goal.role === employee.role && goal.department === employee.department && (!goal.location || goal.location === employee.location);
    });
  }

  const sortedTeam = [...teamEmployees].sort((a, b) => a.name.localeCompare(b.name));
  const filteredEmployees = sortedTeam.filter((e) =>
    (filterEmployees.length === 0 || filterEmployees.includes(e.name)) &&
    (filterDepts.length === 0 || filterDepts.includes(e.department)) &&
    (filterLocations.length === 0 || filterLocations.includes(e.location))
  );
  const noRippling = singleMonthMode && latestEmployees.length === 0;

  const employeeOptions = singleMonthMode
    ? sortedTeam.filter((e) =>
        (filterLocations.length === 0 || filterLocations.includes(e.location)) &&
        (filterDepts.length === 0 || filterDepts.includes(e.department))
      ).map((e) => e.name)
    : [...multiMonthTeam]
        .filter((e) =>
          (filterDepts.length === 0 || filterDepts.includes(e.department)) &&
          (filterLocations.length === 0 || filterLocations.includes(e.location))
        )
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => e.name);

  // Limit month picker to 12 months back through 3 months forward
  const relevantMonths = (() => {
    const now = new Date();
    const cur = now.getFullYear() * 12 + now.getMonth(); // months since year 0
    return props.months.filter((m) => {
      if (!/^\d{4}-\d{2}$/.test(m)) return false;
      const [y, mo] = m.split("-").map(Number);
      const val = y * 12 + (mo - 1);
      return val >= cur - 12 && val <= cur + 3;
    });
  })();

  // Display months for multi-month mode:
  //   "All months" (0 selected) → only months with rippling data or submitted scorecards (avoid showing 36 empty months)
  //   Specific months selected → exactly those months, descending
  const displayMonths = !singleMonthMode
    ? (props.selectedMonths.length === 0
        ? props.months.filter((m) =>
            /^\d{4}-\d{2}$/.test(m) &&
            ((props.rippling[m]?.length ?? 0) > 0 || props.scorecards.some((sc) => sc.scorecardMonth === formatMonthLabel(m)))
          )
        : [...props.selectedMonths].sort().reverse()
      )
    : [];

  const monthPickerLabel = props.selectedMonths.length === 0
    ? "All months"
    : props.selectedMonths.length === 1
    ? formatMonthLabel(props.selectedMonths[0])
    : `${props.selectedMonths.length} months selected`;

  const filterStyle: React.CSSProperties = { display: "block", padding: "7px 10px", border: "1.5px solid var(--border)", borderRadius: "var(--radius-sm)", fontFamily: "var(--sans)", fontSize: "12px", background: "var(--surface)" };
  const filterLabelStyle: React.CSSProperties = { fontSize: "9px", fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.5px", fontFamily: "var(--mono)", marginBottom: "4px" };

  return (
    <div className="screen active" onClick={() => setMonthPickerOpen(false)}>
      <section style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: "12px", flexWrap: "wrap" }}>
          {/* Month multi-select */}
          <div onClick={(e) => e.stopPropagation()}>
            <div style={filterLabelStyle}>MONTH</div>
            <div style={{ position: "relative" }}>
              <button
                style={{ ...filterStyle, cursor: "pointer", display: "flex", alignItems: "center", gap: "8px", minWidth: 180 }}
                onClick={() => setMonthPickerOpen(!monthPickerOpen)}
              >
                <span style={{ flex: 1, textAlign: "left" }}>{monthPickerLabel}</span>
                <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>▾</span>
              </button>
              {monthPickerOpen && (
                <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, background: "var(--surface)", border: "1.5px solid var(--border)", borderRadius: "var(--radius-sm)", boxShadow: "0 4px 16px rgba(0,0,0,0.12)", zIndex: 200, minWidth: "200px", maxHeight: "300px", overflowY: "auto" }}>
                  <button
                    style={{ display: "block", width: "100%", padding: "8px 14px", border: "none", borderBottom: "1px solid var(--border)", background: props.selectedMonths.length === 0 ? "var(--surface2)" : "none", textAlign: "left", cursor: "pointer", fontFamily: "var(--sans)", fontSize: "12px", fontWeight: 600, color: "var(--text)" }}
                    onClick={() => { props.onMonths([]); setFilterEmployees([]); setMonthPickerOpen(false); }}
                  >All months</button>
                  {relevantMonths.map((m) => (
                    <label key={m} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "7px 14px", cursor: "pointer", fontSize: "12px", fontFamily: "var(--sans)", color: "var(--text)", whiteSpace: "nowrap", userSelect: "none" }}>
                      <input
                        type="checkbox"
                        checked={props.selectedMonths.includes(m)}
                        onChange={(e) => {
                          const next = e.target.checked
                            ? [...props.selectedMonths, m].sort().reverse()
                            : props.selectedMonths.filter((x) => x !== m);
                          props.onMonths(next);
                          setFilterEmployees([]);
                        }}
                        style={{ cursor: "pointer", accentColor: "var(--brick)", width: 14, height: 14, flexShrink: 0, margin: 0 }}
                      />
                      <span>{formatMonthLabel(m)}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>

          {showLocationFilter && (
            <div>
              <div style={filterLabelStyle}>LOCATION</div>
              <MultiSelectDropdown
                label="All locations"
                emptyLabel="All locations"
                options={teamLocations.map((l) => ({ value: l, label: l }))}
                selected={filterLocations}
                onChange={(v) => { setFilterLocations(v); setFilterEmployees([]); }}
              />
            </div>
          )}
          {showDeptFilter && (
            <div>
              <div style={filterLabelStyle}>DEPARTMENT</div>
              <MultiSelectDropdown
                label="All departments"
                emptyLabel="All departments"
                options={teamDepts.map((d) => ({ value: d, label: d }))}
                selected={filterDepts}
                onChange={(v) => { setFilterDepts(v); setFilterEmployees([]); }}
              />
            </div>
          )}
          <div>
            <div style={filterLabelStyle}>EMPLOYEE</div>
            <MultiSelectDropdown
              label="All employees"
              emptyLabel="All employees"
              options={employeeOptions.map((name) => ({ value: name, label: name }))}
              selected={filterEmployees}
              onChange={setFilterEmployees}
            />
          </div>
        </div>
      </section>

      {singleMonthMode ? (
        <section>
          <div style={{ padding: "14px 16px 6px" }}>
            <div className="section-title" style={{ margin: 0 }}>
              {filteredEmployees.length} team member{filteredEmployees.length !== 1 ? "s" : ""}
              <span style={{ fontWeight: 400, color: "var(--text-muted)", marginLeft: 6, fontSize: "12px" }}>
                {filterEmployees.length === 1
                  ? filterEmployees[0]
                  : [
                      filterLocations.length > 0 && filterLocations.length < teamLocations.length ? filterLocations.join(", ") : "",
                      filterDepts.length > 0 && filterDepts.length < teamDepts.length ? filterDepts.join(", ") : "",
                    ].filter(Boolean).join(" · ") || periodLabel}
              </span>
            </div>
          </div>
          <div className="scorecard-list" style={{ padding: "8px 16px 16px" }}>
            {noRippling && (
              <div className="no-goals-msg" style={{ display: "block" }}>No employee data available. Upload a Rippling CSV first.</div>
            )}
            {filteredEmployees.map((emp) => {
              const submitted = props.scorecards.find((sc) => sc.employeeName === emp.name && sc.scorecardMonth === periodLabel);
              return (
                <LiveScorecardCard
                  key={emp.id || emp.name}
                  employee={withActualEarnings(emp)}
                  isoMonth={selectedMonth}
                  month={periodLabel}
                  baseGoals={goalsForEmployee(emp)}
                  allGoals={props.allGoals}
                  periodActuals={periodActuals}
                  allRippling={props.rippling}
                  submittedScorecard={submitted}
                  onSubmit={props.onSubmitScorecard}
                  onDeleteGoal={props.onDeleteGoal}
                  currentUserEmail={props.currentUserEmail}
                />
              );
            })}
            {!noRippling && filteredEmployees.length === 0 && (
              <div className="no-goals-msg" style={{ display: "block" }}>No employees match the current filter.</div>
            )}
          </div>
        </section>
      ) : (
        <section>
          <div style={{ padding: "14px 16px 6px" }}>
            <div className="section-title" style={{ margin: 0 }}>
              {displayMonths.length} month{displayMonths.length !== 1 ? "s" : ""}
              <span style={{ fontWeight: 400, color: "var(--text-muted)", marginLeft: 6, fontSize: "12px" }}>
                {filterEmployees.length === 1
                  ? filterEmployees[0]
                  : [
                      filterLocations.length > 0 && filterLocations.length < teamLocations.length ? filterLocations.join(", ") : "",
                      filterDepts.length > 0 && filterDepts.length < teamDepts.length ? filterDepts.join(", ") : "",
                    ].filter(Boolean).join(" · ") || monthPickerLabel.toLowerCase()}
              </span>
            </div>
          </div>
          <div className="scorecard-list" style={{ padding: "8px 16px 16px" }}>
            {displayMonths.length === 0 ? (
              <div className="no-goals-msg" style={{ display: "block" }}>No data available. Upload a Rippling CSV to get started.</div>
            ) : displayMonths.map((m) => {
              const mLabel = formatMonthLabel(m);
              const mRaw = (props.rippling[m]?.length ?? 0) > 0 ? props.rippling[m] : latestEmployees;
              const mTeam = scopedEmployeesForProfile(mRaw, props.profile, props.allEmployees);
              const mFiltered = mTeam
                .filter((e) =>
                  (filterEmployees.length === 0 || filterEmployees.includes(e.name)) &&
                  (filterDepts.length === 0 || filterDepts.includes(e.department)) &&
                  (filterLocations.length === 0 || filterLocations.includes(e.location))
                )
                .sort((a, b) => a.name.localeCompare(b.name));
              const [my, mm] = m.split("-").map(Number);
              const earningsKey = my && mm ? `${mm === 12 ? my + 1 : my}-${String(mm === 12 ? 1 : mm + 1).padStart(2, "0")}` : "";
              const mEarningsUpload = props.rippling[earningsKey] || [];
              const mActuals = {
                ...(props.allActuals[mLabel] || {}),
                ...(props.allActuals[quarterKeyForMonth(m)] || {}),
              };
              return (
                <div key={m}>
                  <div style={{ fontSize: "11px", fontWeight: 700, color: "var(--text-muted)", fontFamily: "var(--mono)", letterSpacing: "0.5px", padding: "10px 0 6px", textTransform: "uppercase" }}>
                    {mLabel}
                  </div>
                  {mFiltered.length === 0 ? (
                    <div className="no-goals-msg" style={{ display: "block" }}>No employees match the current filter.</div>
                  ) : mFiltered.map((emp) => {
                    const src = mEarningsUpload.find((e) => e.name === emp.name);
                    const empWithEarnings = src ? { ...emp, grossEarnings: src.grossEarnings, hoursWorked: src.hoursWorked } : emp;
                    const submitted = props.scorecards.find((sc) => sc.employeeName === emp.name && sc.scorecardMonth === mLabel);
                    return (
                      <LiveScorecardCard
                        key={`${m}-${emp.id || emp.name}`}
                        employee={empWithEarnings}
                        isoMonth={m}
                        month={mLabel}
                        baseGoals={goalsForEmployee(emp, mActuals)}
                        allGoals={props.allGoals}
                        periodActuals={mActuals}
                        allRippling={props.rippling}
                        submittedScorecard={submitted}
                        onSubmit={props.onSubmitScorecard}
                        onDeleteGoal={props.onDeleteGoal}
                        currentUserEmail={props.currentUserEmail}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function LiveScorecardCard({
  employee, isoMonth, month, baseGoals, allGoals, periodActuals, allRippling, submittedScorecard, onSubmit, onDeleteGoal, currentUserEmail
}: {
  employee: Employee;
  isoMonth: string;
  month: string;
  baseGoals: Goal[];
  allGoals: Goal[];
  periodActuals: ActualsByKey;
  allRippling: Record<string, Employee[]>;
  submittedScorecard: Scorecard | undefined;
  onSubmit: (scorecard: Scorecard) => void;
  onDeleteGoal: (value: { scorecardId: string; goalName: string }) => void;
  currentUserEmail: string;
}) {
  const [open, setOpen] = useState(false);
  const [cardPeriodType, setCardPeriodType] = useState<"monthly" | "quarterly">("monthly");
  const [goalIds, setGoalIds] = useState<string[]>(() => baseGoals.filter((g) => g.periodType !== "quarterly").map((g) => g.id));
  const [indActuals, setIndActuals] = useState<Record<string, string>>({});
  const [addGoalOpen, setAddGoalOpen] = useState(false);
  const [lastSubmitted, setLastSubmitted] = useState<Scorecard | null>(null);

  const quarterKey = quarterKeyForMonth(isoMonth);

  // Sum earnings across all 3 months of the quarter from Rippling uploads
  const quarterlyEmployee = useMemo(() => {
    const [y, m] = isoMonth.split("-").map(Number);
    if (!y || !m) return employee;
    const q = Math.ceil(m / 3);
    const start = (q - 1) * 3 + 1;
    const qMonths = [0, 1, 2].map((i) => `${y}-${String(start + i).padStart(2, "0")}`);
    let totalGross = 0;
    let totalHours = 0;
    for (const qm of qMonths) {
      const [qy, qmm] = qm.split("-").map(Number);
      const earningsKey = `${qmm === 12 ? qy + 1 : qy}-${String(qmm === 12 ? 1 : qmm + 1).padStart(2, "0")}`;
      const src = (allRippling[earningsKey] || []).find((e) => e.name === employee.name);
      if (src?.grossEarnings) totalGross += src.grossEarnings;
      if (src?.hoursWorked) totalHours += src.hoursWorked;
    }
    return { ...employee, grossEarnings: totalGross > 0 ? totalGross : undefined, hoursWorked: totalHours > 0 ? totalHours : undefined };
  }, [isoMonth, employee, allRippling]);

  function isGoalApplicable(goal: Goal): boolean {
    if (goal.goalTier === "company") return true;
    if (goal.goalTier === "department") return goal.department === employee.department && (!goal.location || goal.location === employee.location);
    return goal.role === employee.role && goal.department === employee.department && (!goal.location || goal.location === employee.location);
  }

  const hasQuarterlyGoals = allGoals.some((g) => g.periodType === "quarterly" && isGoalApplicable(g));

  function handlePeriodTypeChange(newType: "monthly" | "quarterly") {
    setCardPeriodType(newType);
    setIndActuals({});
    if (newType === "monthly") {
      setGoalIds(baseGoals.filter((g) => g.periodType !== "quarterly").map((g) => g.id));
    } else {
      setGoalIds(baseGoals.filter((g) => g.periodType === "quarterly").map((g) => g.id));
    }
  }

  const displayedSubmitted = submittedScorecard || lastSubmitted;
  if (displayedSubmitted) {
    return <ScorecardCard scorecard={displayedSubmitted} onDeleteGoal={onDeleteGoal} />;
  }

  const activeEmployee = cardPeriodType === "quarterly" ? quarterlyEmployee : employee;
  const activeMonth = cardPeriodType === "quarterly" ? quarterKey : month;

  const currentGoals: EditableGoal[] = (() => {
    const goals = goalIds
      .map((id) => allGoals.find((g) => g.id === id))
      .filter((g): g is Goal => !!g);
    const n = goals.length;
    return goals.map((g, i) => {
      const equalWeight = n > 0 ? Number((100 / n).toFixed(2)) : 0;
      const scWeight = i === n - 1 ? Number((100 - equalWeight * (n - 1)).toFixed(2)) : equalWeight;
      return {
        ...g,
        scTarget: periodActuals[metaKey("target", g)] != null ? Number(periodActuals[metaKey("target", g)]) : g.goalValue,
        scMin: periodActuals[metaKey("min", g)] != null ? Number(periodActuals[metaKey("min", g)]) : g.minValue,
        scActual: g.goalTier === "individual"
          ? (indActuals[g.name] !== undefined ? (indActuals[g.name] === "" ? null : Number(indActuals[g.name])) : null)
          : (periodActuals[actualKey(g)] != null ? Number(periodActuals[actualKey(g)]) : null),
        scWeight
      };
    });
  })();

  const liveScorecard = buildScorecard({ employee: activeEmployee, month: activeMonth, periodType: cardPeriodType, goals: currentGoals, submittedBy: currentUserEmail });

  const hasNoTarget = currentGoals.some((g) => periodActuals[metaKey("target", g)] == null || periodActuals[metaKey("min", g)] == null);
  const availableToAdd = allGoals.filter((g) => {
    if (goalIds.includes(g.id)) return false;
    if (!isGoalApplicable(g)) return false;
    return cardPeriodType === "quarterly" ? g.periodType === "quarterly" : g.periodType !== "quarterly";
  });
  const achColor = liveScorecard.weightedAchievement >= 100 ? "#2D6B1A" : "var(--brick)";

  const thS: React.CSSProperties = { padding: "6px 10px", fontSize: "9px", fontWeight: 700, color: "var(--text-muted)", textAlign: "left", borderBottom: "1.5px solid var(--border)", whiteSpace: "nowrap", background: "var(--surface2)" };
  const thC: React.CSSProperties = { ...thS, textAlign: "center" };

  return (
    <div style={{ border: "1.5px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden", background: "var(--surface)" }}>
      <div onClick={() => setOpen(!open)} style={{ display: "flex", alignItems: "center", gap: "12px", padding: "13px 16px", cursor: "pointer" }} className="sc-card-head">
        <div style={{ fontSize: "12px", color: "var(--text-muted)", transition: "transform 0.2s", flexShrink: 0, transform: open ? "rotate(90deg)" : "none" }}>▶</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--text)" }}>{employee.name}</div>
          <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "1px" }}>
            {employee.role}{employee.department ? ` · ${employee.department}` : ""}{employee.location ? ` · ${employee.location}` : ""}
          </div>
        </div>
        {currentGoals.length > 0 && (
          <>
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <div style={{ fontSize: "11px", color: "var(--text-muted)", fontFamily: "var(--mono)" }}>Achievement</div>
              <div style={{ fontSize: "17px", fontWeight: 700, color: achColor }}>{liveScorecard.weightedAchievement.toFixed(1)}%</div>
            </div>
            <div style={{ textAlign: "right", flexShrink: 0, minWidth: "80px" }}>
              <div style={{ fontSize: "11px", color: "var(--text-muted)", fontFamily: "var(--mono)" }}>Est. Bonus</div>
              <div style={{ fontSize: "17px", fontWeight: 700, color: "var(--brick)" }}>{formatCurrency(liveScorecard.bonusAmount)}</div>
            </div>
          </>
        )}
        {hasQuarterlyGoals && (
          <div style={{ display: "flex", borderRadius: "99px", border: "1.5px solid var(--border)", overflow: "hidden", flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
            <button style={{ padding: "2px 8px", fontSize: "10px", fontWeight: 700, fontFamily: "var(--mono)", border: "none", cursor: "pointer", background: cardPeriodType === "monthly" ? "var(--brick)" : "transparent", color: cardPeriodType === "monthly" ? "#fff" : "var(--text-muted)", transition: "background 0.15s" }} onClick={() => handlePeriodTypeChange("monthly")}>MO</button>
            <button style={{ padding: "2px 8px", fontSize: "10px", fontWeight: 700, fontFamily: "var(--mono)", border: "none", cursor: "pointer", background: cardPeriodType === "quarterly" ? "var(--brick)" : "transparent", color: cardPeriodType === "quarterly" ? "#fff" : "var(--text-muted)", transition: "background 0.15s" }} onClick={() => handlePeriodTypeChange("quarterly")}>QTR</button>
          </div>
        )}
        <span style={{ fontSize: "10px", padding: "2px 8px", borderRadius: "99px", background: "#f0ece6", color: "#7a7268", fontWeight: 700, fontFamily: "var(--mono)", flexShrink: 0 }}>DRAFT</span>
      </div>

      {open && (
        <>
          <div style={{ display: "flex", gap: "24px", padding: "10px 16px", background: "var(--surface2)", borderTop: "1px solid var(--border)", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: "9px", color: "var(--text-muted)", fontWeight: 700, fontFamily: "var(--mono)" }}>{cardPeriodType === "quarterly" ? `QUARTERLY EARNINGS · ${quarterKey}` : "BASE EARNINGS"}</div>
              <div style={{ fontSize: "13px", fontWeight: 700 }}>{formatCurrency(liveScorecard.baseEarnings)}</div>
            </div>
            {activeEmployee.hoursWorked ? (
              <div>
                <div style={{ fontSize: "9px", color: "var(--text-muted)", fontWeight: 700, fontFamily: "var(--mono)" }}>HOURS WORKED{cardPeriodType === "quarterly" ? " (QTR)" : ""}</div>
                <div style={{ fontSize: "13px", fontWeight: 700 }}>{activeEmployee.hoursWorked.toFixed(2)}</div>
              </div>
            ) : null}
          </div>

          {hasNoTarget && (
            <div style={{ padding: "8px 16px", background: "#fffbf0", borderTop: "1px solid #f0e0a0", fontSize: "11px", color: "#7a5c00" }}>
              ⚠ Some goals are missing targets or minimums for {activeMonth}. Set them in Goals & Actuals before submitting.
            </div>
          )}

          {currentGoals.length > 0 ? (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
                <thead>
                  <tr>
                    <th style={thS}>Type</th>
                    <th style={thS}>Goal</th>
                    <th style={thC}>Target</th>
                    <th style={thC}>Min</th>
                    <th style={thC}>Actual</th>
                    <th style={thC}>Weight</th>
                    <th style={thC}>Achieve%</th>
                    <th style={thC}>Est. Bonus $</th>
                    <th style={{ ...thC, width: "28px" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {currentGoals.map((goal) => {
                    const sc = liveScorecard.goals.find((g) => g.name === goal.name);
                    const noTarget = periodActuals[metaKey("target", goal)] == null || periodActuals[metaKey("min", goal)] == null;
                    const isInd = goal.goalTier === "individual";
                    return (
                      <tr key={goal.id} style={{ borderBottom: "1px solid var(--border)" }}>
                        <td style={{ padding: "6px 10px" }}><TierBadge tier={goal.goalTier} /></td>
                        <td style={{ padding: "6px 10px", fontWeight: 600, minWidth: "140px" }}>
                          {goal.name}<GoalScopeTags location={goal.location} department={goal.department} />
                        </td>
                        <td style={{ padding: "6px 10px", fontFamily: "var(--mono)", textAlign: "center" }}>
                          {noTarget ? <span style={{ color: "var(--text-faint)", fontSize: "10px" }}>not set</span> : formatNumber(goal.scTarget)}
                        </td>
                        <td style={{ padding: "6px 10px", fontFamily: "var(--mono)", textAlign: "center" }}>
                          {noTarget ? <span style={{ color: "var(--text-faint)", fontSize: "10px" }}>not set</span> : formatNumber(goal.scMin)}
                        </td>
                        <td style={{ padding: "6px 10px", fontFamily: "var(--mono)", textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                          {isInd ? (
                            <input
                              aria-label={`Actual for ${goal.name}`}
                              type="number"
                              className="actual-inline-input"
                              value={indActuals[goal.name] ?? ""}
                              onChange={(e) => setIndActuals((prev) => ({ ...prev, [goal.name]: e.target.value }))}
                              style={{ width: "68px" }}
                            />
                          ) : (
                            <span style={{ color: goal.scActual == null ? "var(--text-faint)" : undefined }}>
                              {goal.scActual != null ? formatNumber(goal.scActual) : "—"}
                            </span>
                          )}
                        </td>
                        <td style={{ padding: "6px 10px", fontFamily: "var(--mono)", textAlign: "center" }}>{goal.scWeight.toFixed(1)}%</td>
                        <td style={{ padding: "6px 10px", fontFamily: "var(--mono)", textAlign: "center", fontWeight: 700 }}>
                          {sc?.actual != null
                            ? (sc.metMin
                              ? <span style={{ color: sc.achievement >= 100 ? "#2D6B1A" : "var(--brick)" }}>{sc.achievement.toFixed(1)}%</span>
                              : <span style={{ color: "#9B2C2C" }}>Below min</span>)
                            : <span style={{ color: "var(--text-faint)" }}>—</span>}
                        </td>
                        <td style={{ padding: "6px 10px", fontFamily: "var(--mono)", textAlign: "center" }}>{formatCurrency(sc?.bonusContribution ?? 0)}</td>
                        <td style={{ padding: "4px 6px", textAlign: "center" }}>
                          <button
                            className="sc-del-btn"
                            title="Remove goal"
                            onClick={(e) => { e.stopPropagation(); setGoalIds((prev) => prev.filter((id) => id !== goal.id)); }}
                            style={{ border: "none", background: "none", color: "#9B2C2C", fontSize: "14px", cursor: "pointer", padding: 0, lineHeight: 1, opacity: 0.6 }}
                          >✕</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="no-goals-msg" style={{ display: "block", margin: "12px 16px" }}>
              {cardPeriodType === "quarterly" ? `No quarterly goals assigned for ${employee.name}.` : "No goals assigned for this employee and month."}
            </div>
          )}

          <div style={{ padding: "10px 16px", display: "flex", alignItems: "center", gap: "10px", borderTop: "1px solid var(--border)", flexWrap: "wrap" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ position: "relative" }}>
              <button
                style={{ fontSize: "12px", padding: "5px 10px", border: "1.5px solid var(--border)", borderRadius: "var(--radius-sm)", background: "none", cursor: "pointer", fontFamily: "var(--sans)" }}
                onClick={() => setAddGoalOpen(!addGoalOpen)}
              >+ Add Goal</button>
              {addGoalOpen && (
                <div style={{ position: "absolute", bottom: "calc(100% + 4px)", left: 0, background: "var(--surface)", border: "1.5px solid var(--border)", borderRadius: "var(--radius-sm)", boxShadow: "0 4px 12px rgba(0,0,0,0.12)", zIndex: 100, minWidth: "220px", maxHeight: "220px", overflowY: "auto" }}>
                  {availableToAdd.length === 0 ? (
                    <div style={{ padding: "10px 12px", fontSize: "11px", color: "var(--text-muted)" }}>No more goals available</div>
                  ) : availableToAdd.map((g) => (
                    <button key={g.id}
                      style={{ display: "block", width: "100%", padding: "7px 12px", border: "none", background: "none", textAlign: "left", cursor: "pointer", fontFamily: "var(--sans)", fontSize: "12px" }}
                      onClick={() => { setGoalIds((prev) => [...prev, g.id]); setAddGoalOpen(false); }}>
                      {g.name}<GoalScopeTags location={g.location} department={g.department} />
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              className="submit-btn"
              style={{ marginLeft: "auto", padding: "6px 18px", fontSize: "12px" }}
              disabled={hasNoTarget || currentGoals.length === 0}
              title={hasNoTarget ? "Set targets and minimums first" : undefined}
              onClick={() => {
                onSubmit(liveScorecard);
                setLastSubmitted(liveScorecard);
              }}
            >
              Submit Scorecard
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ScorecardSummary({ scorecard }: { scorecard: Scorecard }) {
  return (
    <div className="results-section">
      <div className="section-title">Calculated Bonus</div>
      <div className="metrics-grid">
        <Metric label="Base Earnings" value={formatCurrency(scorecard.baseEarnings)} />
        <Metric label="Weighted Achievement" value={`${scorecard.weightedAchievement.toFixed(1)}%${scorecard.scorecardCapped ? " cap 200%" : ""}`} highlight />
        <Metric label="Bonus Amount" value={formatCurrency(scorecard.bonusAmount)} highlight />
        <Metric label="Total Pay" value={formatCurrency(scorecard.baseEarnings + scorecard.bonusAmount)} />
      </div>
    </div>
  );
}

function Metric({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return <div className="metric-card"><div className="mlabel">{label}</div><div className={`mval ${highlight ? "highlight" : ""}`}>{value}</div></div>;
}

function ScorecardCard({ scorecard, onDeleteGoal }: { scorecard: Scorecard; onDeleteGoal: (value: { scorecardId: string; goalName: string }) => void }) {
  const [open, setOpen] = useState(false);
  const achColor = scorecard.weightedAchievement >= 100 ? "#2D6B1A" : "var(--brick)";
  const effectiveHourly = scorecard.hours && scorecard.hours > 0
    ? ((scorecard.baseEarnings + scorecard.bonusAmount) / scorecard.hours).toFixed(2)
    : null;
  const weight = scorecard.goals.length ? (100 / scorecard.goals.length).toFixed(1) : "0";
  const thS: React.CSSProperties = { padding: "6px 10px", fontSize: "9px", fontWeight: 700, color: "var(--text-muted)", textAlign: "left", borderBottom: "1.5px solid var(--border)", whiteSpace: "nowrap", background: "var(--surface2)" };
  const thC: React.CSSProperties = { ...thS, textAlign: "center" };
  return (
    <div style={{ border: "1.5px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden", background: "var(--surface)" }}>
      <div
        data-testid={`scorecard-card-${scorecard.id}`}
        onClick={() => setOpen(!open)}
        style={{ display: "flex", alignItems: "center", gap: "12px", padding: "13px 16px", cursor: "pointer", background: "var(--surface)" }}
        className="sc-card-head"
      >
        <div style={{ fontSize: "12px", color: "var(--text-muted)", transition: "transform 0.2s", flexShrink: 0, transform: open ? "rotate(90deg)" : "none" }}>▶</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--text)" }}>{scorecard.employeeName}</div>
          <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "1px" }}>
            {scorecard.role}{scorecard.department ? ` · ${scorecard.department}` : ""}{scorecard.location ? ` · ${scorecard.location}` : ""}
          </div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontSize: "11px", color: "var(--text-muted)", fontFamily: "var(--mono)" }}>Achievement</div>
          <div style={{ fontSize: "17px", fontWeight: 700, color: achColor }}>{scorecard.weightedAchievement.toFixed(1)}%{scorecard.scorecardCapped ? " cap" : ""}</div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0, minWidth: "80px" }}>
          <div style={{ fontSize: "11px", color: "var(--text-muted)", fontFamily: "var(--mono)" }}>Bonus</div>
          <div style={{ fontSize: "17px", fontWeight: 700, color: "var(--brick)" }}>{formatCurrency(scorecard.bonusAmount)}</div>
        </div>
      </div>
      {open && (
        <>
          <div style={{ display: "flex", gap: "24px", padding: "10px 16px", background: "var(--surface2)", borderTop: "1px solid var(--border)", flexWrap: "wrap" }}>
            {[
              { label: "MONTHLY EARNINGS", value: formatCurrency(scorecard.baseEarnings) },
              scorecard.hours ? { label: "HOURS WORKED", value: scorecard.hours.toFixed(2) } : null,
              scorecard.hourlyRate ? { label: "HOURLY RATE", value: formatCurrency(scorecard.hourlyRate) } : null,
              effectiveHourly ? { label: "EFFECTIVE HOURLY", value: `$${effectiveHourly}` } : null,
              { label: "BONUS AMOUNT", value: formatCurrency(scorecard.bonusAmount), color: "var(--brick)" }
            ].filter(Boolean).map((item) => item && (
              <div key={item.label}>
                <div style={{ fontSize: "9px", color: "var(--text-muted)", fontWeight: 700, fontFamily: "var(--mono)" }}>{item.label}</div>
                <div style={{ fontSize: "13px", fontWeight: 700, color: item.color || "var(--text)" }}>{item.value}</div>
              </div>
            ))}
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
              <thead>
                <tr>
                  <th style={thS}>Type</th>
                  <th style={thS}>Goal</th>
                  <th style={thC}>Target</th>
                  <th style={thC}>Min</th>
                  <th style={thC}>Weight</th>
                  <th style={thC}>Actual</th>
                  <th style={thC}>Achieve%</th>
                  <th style={thC}>Bonus $</th>
                  <th style={{ ...thC, width: "28px" }}></th>
                </tr>
              </thead>
              <tbody>
                {scorecard.goals.map((goal) => (
                  <tr key={goal.name} className="sc-goal-row" style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "6px 10px" }}><TierBadge tier={goal.goalTier} /></td>
                    <td style={{ padding: "6px 10px", fontWeight: 600, minWidth: "140px" }}>
                      {goal.name}<GoalScopeTags location={goal.location} department={goal.department} />
                    </td>
                    <td style={{ padding: "6px 10px", fontFamily: "var(--mono)", textAlign: "center" }}>{goal.target ?? "—"}</td>
                    <td style={{ padding: "6px 10px", fontFamily: "var(--mono)", textAlign: "center" }}>{goal.min ?? "—"}</td>
                    <td style={{ padding: "6px 10px", fontFamily: "var(--mono)", textAlign: "center" }}>{weight}%</td>
                    <td style={{ padding: "6px 10px", fontFamily: "var(--mono)", textAlign: "center" }}>{goal.actual ?? "—"}</td>
                    <td style={{ padding: "6px 10px", fontFamily: "var(--mono)", textAlign: "center", fontWeight: 700, color: goal.metMin ? (goal.achievement >= 100 ? "#2D6B1A" : "var(--brick)") : "#9B2C2C" }}>
                      {goal.metMin ? `${goal.achievement.toFixed(1)}%` : <span style={{ color: "#9B2C2C", fontWeight: 700 }}>Below min</span>}
                    </td>
                    <td style={{ padding: "6px 10px", fontFamily: "var(--mono)", textAlign: "center" }}>{formatCurrency(goal.bonusContribution)}</td>
                    <td style={{ padding: "4px 6px", textAlign: "center", width: "28px" }}>
                      <button className="sc-del-btn" title="Remove goal" onClick={() => onDeleteGoal({ scorecardId: scorecard.id, goalName: goal.name })} style={{ border: "none", background: "none", color: "#9B2C2C", fontSize: "14px", cursor: "pointer", padding: 0, lineHeight: 1, opacity: 0, transition: "opacity 0.15s" }}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

const CHART_COLORS = ["#C0392B","#2980B9","#27AE60","#8E44AD","#E67E22","#16A085","#D35400","#1A5276","#7B241C","#1B4F72"];

// Converts "April 2026" → "2026-04" reliably (no Date constructor parsing)
const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function parseMonthLabel(label: string): string {
  if (!label) return "";
  if (/^\d{4}-\d{2}$/.test(label)) return label; // already ISO
  const [name, yearStr] = label.trim().split(" ");
  const m = MONTH_NAMES.indexOf(name);
  const y = parseInt(yearStr ?? "");
  if (m === -1 || isNaN(y)) return "";
  return `${y}-${String(m + 1).padStart(2, "0")}`;
}

function shortMonthLabel(iso: string): string {
  const names = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const [y, m] = iso.split("-").map(Number);
  if (!y || !m) return iso;
  return `${names[m - 1]} '${String(y).slice(2)}`;
}

function niceYTicks(min: number, max: number): number[] {
  const range = max - min || 1;
  const rawStep = range / 5;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / magnitude;
  const step = norm <= 1 ? magnitude : norm <= 2 ? 2 * magnitude : norm <= 5 ? 5 * magnitude : 10 * magnitude;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let t = start; t <= end + step * 0.001; t += step) ticks.push(Math.round(t * 1000) / 1000);
  return ticks;
}

function HistoryScreen(props: {
  filters: HistoryFilters;
  view: HistoryView;
  scorecards: Scorecard[];
  allScorecards: Scorecard[];
  readonly?: boolean;
  onFilters: (filters: HistoryFilters) => void;
  onView: (view: HistoryView) => void;
}) {
  // Report builder local state
  const [fromMonth, setFromMonth] = useState("");
  const [toMonth, setToMonth] = useState("");
  const [selLocation, setSelLocation] = useState("");
  const [selDept, setSelDept] = useState("");
  const [selEmployee, setSelEmployee] = useState("");
  const [metric, setMetric] = useState<"achievement" | "bonus" | "goal">("achievement");
  const [metricGoal, setMetricGoal] = useState("");
  const [groupBy, setGroupBy] = useState<"employee" | "department" | "location">("employee");

  // Options derived from all scorecards
  const allMonthIsos = useMemo(() =>
    Array.from(new Set(props.allScorecards.map((sc) => parseMonthLabel(sc.scorecardMonth)))).filter(Boolean).sort(),
    [props.allScorecards]
  );
  const allLocations = useMemo(() =>
    Array.from(new Set(props.allScorecards.map((sc) => sc.location).filter(Boolean))).sort(),
    [props.allScorecards]
  );
  const allDepts = useMemo(() =>
    Array.from(new Set(props.allScorecards.map((sc) => sc.department).filter(Boolean))).sort(),
    [props.allScorecards]
  );
  const allEmployeeNames = useMemo(() =>
    Array.from(new Set(props.allScorecards.map((sc) => sc.employeeName))).sort(),
    [props.allScorecards]
  );
  const allGoalNames = useMemo(() =>
    Array.from(new Set(props.allScorecards.flatMap((sc) => sc.goals.map((g) => g.name)))).sort(),
    [props.allScorecards]
  );

  // Filtered scorecards for report views
  const reportScorecards = useMemo(() =>
    props.allScorecards.filter((sc) => {
      const iso = parseMonthLabel(sc.scorecardMonth);
      if (fromMonth && iso < fromMonth) return false;
      if (toMonth && iso > toMonth) return false;
      if (selLocation && sc.location !== selLocation) return false;
      if (selDept && sc.department !== selDept) return false;
      if (selEmployee && sc.employeeName !== selEmployee) return false;
      return true;
    }),
    [props.allScorecards, fromMonth, toMonth, selLocation, selDept, selEmployee]
  );

  const reportMonths = useMemo(() =>
    Array.from(new Set(reportScorecards.map((sc) => parseMonthLabel(sc.scorecardMonth)))).filter(Boolean).sort(),
    [reportScorecards]
  );

  const groupKeys = useMemo(() => {
    if (groupBy === "employee") return Array.from(new Set(reportScorecards.map((sc) => sc.employeeName))).sort();
    if (groupBy === "department") return Array.from(new Set(reportScorecards.map((sc) => sc.department).filter(Boolean))).sort();
    return Array.from(new Set(reportScorecards.map((sc) => sc.location).filter(Boolean))).sort();
  }, [reportScorecards, groupBy]);

  function getMetricValue(sc: Scorecard): number | null {
    if (metric === "achievement") return sc.weightedAchievement;
    if (metric === "bonus") return sc.bonusAmount;
    if (metric === "goal" && metricGoal) {
      const g = sc.goals.find((g) => g.name === metricGoal);
      return g ? g.achievement : null;
    }
    return null;
  }

  function getGroupMonthValue(groupKey: string, isoMonth: string): number | null {
    const scs = reportScorecards.filter((sc) => {
      if (parseMonthLabel(sc.scorecardMonth) !== isoMonth) return false;
      if (groupBy === "employee") return sc.employeeName === groupKey;
      if (groupBy === "department") return sc.department === groupKey;
      return sc.location === groupKey;
    });
    const vals = scs.map(getMetricValue).filter((v): v is number => v !== null);
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  const isPercent = metric === "achievement" || metric === "goal";
  const isCurrency = metric === "bonus";
  const metricLabel = metric === "achievement" ? "Achievement %" : metric === "bonus" ? "Bonus Amount" : (metricGoal || "Goal Achievement") + " %";

  function formatMetric(v: number | null): string {
    if (v === null) return "—";
    if (isPercent) return v.toFixed(1) + "%";
    if (isCurrency) return formatCurrency(v);
    return v.toFixed(1);
  }

  function cellBg(v: number | null): string {
    if (v === null) return "transparent";
    if (isPercent) {
      if (v >= 100) return "rgba(45,107,26,0.13)";
      if (v >= 80) return "rgba(230,126,34,0.10)";
      return "rgba(192,57,43,0.08)";
    }
    return v > 0 ? "rgba(45,107,26,0.08)" : "transparent";
  }
  function cellFg(v: number | null): string {
    if (v === null) return "var(--text-muted)";
    if (isPercent) {
      if (v >= 100) return "#2D6B1A";
      if (v >= 80) return "#7A4400";
      return "var(--brick)";
    }
    return "var(--text)";
  }

  const fLabel: React.CSSProperties = { fontSize: "9px", fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.5px", fontFamily: "var(--mono)", marginBottom: "4px" };
  const fSelect: React.CSSProperties = { display: "block", padding: "7px 10px", border: "1.5px solid var(--border)", borderRadius: "var(--radius-sm)", fontFamily: "var(--sans)", fontSize: "12px", background: "var(--surface)" };

  const VIEW_BTNS: { key: HistoryView; label: string }[] = [
    { key: "table", label: "Table" },
    { key: "grid", label: "Grid" },
    { key: "chart", label: "Chart" },
    { key: "scorecard", label: "Cards" },
  ];

  return (
    <div className="screen active">
      {/* View toggle header */}
      <section style={{ borderBottom: "1px solid var(--border)", paddingBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "8px" }}>
          <div className="section-title" style={{ margin: 0 }}>Historical Data</div>
          <div style={{ display: "flex", gap: "6px" }}>
            {VIEW_BTNS.map(({ key, label }) => (
              <button
                key={key}
                data-testid={key === "scorecard" ? "history-scorecard-view" : undefined}
                onClick={() => props.onView(key)}
                style={{ padding: "6px 14px", border: `1.5px solid ${props.view === key ? "var(--brick)" : "var(--border)"}`, borderRadius: "var(--radius-sm)", background: props.view === key ? "var(--brick)" : "none", color: props.view === key ? "#fff" : "var(--text-muted)", fontFamily: "var(--sans)", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}
              >{label}</button>
            ))}
          </div>
        </div>
      </section>

      {/* TABLE view — existing filter + flat list */}
      {props.view === "table" && (
        <>
          {!props.readonly && (
            <section>
              <div className="section-title">Filters</div>
              <div className="fields-grid">
                <div className="field"><label>Period</label><select value={props.filters.period} onChange={(e) => props.onFilters({ ...props.filters, period: e.target.value })}><option value="">All periods</option>{Array.from(new Set(props.allScorecards.map((sc) => sc.scorecardMonth))).map((p) => <option key={p}>{p}</option>)}</select></div>
                <div className="field"><label>Search</label><input value={props.filters.search} onChange={(e) => props.onFilters({ ...props.filters, search: e.target.value })} placeholder="e.g. Jane Smith, Utah" /></div>
                <div className="field"><label>Location</label><select value={props.filters.location} onChange={(e) => props.onFilters({ ...props.filters, location: e.target.value })}><option value="">All locations</option><option>Utah</option><option>Georgia</option><option>Remote</option></select></div>
                <div className="field"><label>Department</label><select value={props.filters.department} onChange={(e) => props.onFilters({ ...props.filters, department: e.target.value })}><option value="">All departments</option>{departments.map((d) => <option key={d}>{d}</option>)}</select></div>
                <div className="field"><label>Goal</label><select value={props.filters.goal} onChange={(e) => props.onFilters({ ...props.filters, goal: e.target.value })}><option value="">All goals</option>{allGoalNames.map((g) => <option key={g}>{g}</option>)}</select></div>
              </div>
            </section>
          )}
          <section>
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th>Employee</th><th>Period</th><th>Department</th><th>Location</th><th style={{ textAlign: "right" }}>Achievement</th><th style={{ textAlign: "right" }}>Bonus</th></tr></thead>
                <tbody>
                  {props.scorecards.map((sc) => (
                    <tr key={sc.id}>
                      <td>{sc.employeeName}</td>
                      <td style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: "11px" }}>{sc.scorecardMonth}</td>
                      <td>{sc.department}</td>
                      <td>{sc.location}</td>
                      <td style={{ textAlign: "right", fontFamily: "var(--mono)", fontWeight: 600, color: sc.weightedAchievement >= 100 ? "#2D6B1A" : "var(--brick)" }}>{sc.weightedAchievement.toFixed(1)}%</td>
                      <td style={{ textAlign: "right", fontFamily: "var(--mono)" }}>{formatCurrency(sc.bonusAmount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!props.scorecards.length && <div className="no-goals-msg" style={{ display: "block" }}>No scorecards match the current filters.</div>}
          </section>
          {!props.readonly && (
            <section style={{ background: "var(--surface2)", borderStyle: "dashed" }}>
              <div className="section-title">Export</div>
              <button style={{ width: "100%", padding: "10px", border: "1.5px solid var(--border-strong)", borderRadius: "var(--radius-sm)", background: "none", fontFamily: "var(--sans)", fontSize: "13px", fontWeight: 500, cursor: "pointer", color: "var(--text)" }} onClick={() => downloadCsv(scorecardsToCsv(props.scorecards), "scorecards-history.csv")}>↓ Export filtered results CSV</button>
            </section>
          )}
        </>
      )}

      {/* CARDS view */}
      {props.view === "scorecard" && (
        <>
          {!props.readonly && (
            <section>
              <div className="fields-grid">
                <div className="field"><label>Period</label><select value={props.filters.period} onChange={(e) => props.onFilters({ ...props.filters, period: e.target.value })}><option value="">All periods</option>{Array.from(new Set(props.allScorecards.map((sc) => sc.scorecardMonth))).map((p) => <option key={p}>{p}</option>)}</select></div>
                <div className="field"><label>Location</label><select value={props.filters.location} onChange={(e) => props.onFilters({ ...props.filters, location: e.target.value })}><option value="">All locations</option><option>Utah</option><option>Georgia</option><option>Remote</option></select></div>
                <div className="field"><label>Department</label><select value={props.filters.department} onChange={(e) => props.onFilters({ ...props.filters, department: e.target.value })}><option value="">All departments</option>{departments.map((d) => <option key={d}>{d}</option>)}</select></div>
              </div>
            </section>
          )}
          <section>
            <div className="scorecard-list">{props.scorecards.map((sc) => <ScorecardCard key={sc.id} scorecard={sc} onDeleteGoal={() => {}} />)}</div>
            {!props.scorecards.length && <div className="no-goals-msg" style={{ display: "block" }}>No scorecards match the current filters.</div>}
          </section>
        </>
      )}

      {/* REPORT BUILDER — Grid & Chart */}
      {(props.view === "grid" || props.view === "chart") && (
        <>
          {/* Config bar */}
          <section style={{ borderBottom: "1px solid var(--border)" }}>
            <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", alignItems: "flex-end" }}>
              <div>
                <div style={fLabel}>FROM</div>
                <select style={fSelect} value={fromMonth} onChange={(e) => setFromMonth(e.target.value)}>
                  <option value="">Earliest</option>
                  {allMonthIsos.map((m) => <option key={m} value={m}>{formatMonthLabel(m)}</option>)}
                </select>
              </div>
              <div>
                <div style={fLabel}>TO</div>
                <select style={fSelect} value={toMonth} onChange={(e) => setToMonth(e.target.value)}>
                  <option value="">Latest</option>
                  {allMonthIsos.map((m) => <option key={m} value={m}>{formatMonthLabel(m)}</option>)}
                </select>
              </div>
              <div>
                <div style={fLabel}>LOCATION</div>
                <select style={fSelect} value={selLocation} onChange={(e) => setSelLocation(e.target.value)}>
                  <option value="">All locations</option>
                  {allLocations.map((l) => <option key={l}>{l}</option>)}
                </select>
              </div>
              <div>
                <div style={fLabel}>DEPARTMENT</div>
                <select style={fSelect} value={selDept} onChange={(e) => setSelDept(e.target.value)}>
                  <option value="">All departments</option>
                  {allDepts.map((d) => <option key={d}>{d}</option>)}
                </select>
              </div>
              <div>
                <div style={fLabel}>EMPLOYEE</div>
                <select style={fSelect} value={selEmployee} onChange={(e) => setSelEmployee(e.target.value)}>
                  <option value="">All employees</option>
                  {allEmployeeNames.map((n) => <option key={n}>{n}</option>)}
                </select>
              </div>
              <div>
                <div style={fLabel}>GROUP BY</div>
                <select style={fSelect} value={groupBy} onChange={(e) => setGroupBy(e.target.value as "employee" | "department" | "location")}>
                  <option value="employee">Employee</option>
                  <option value="department">Department</option>
                  <option value="location">Location</option>
                </select>
              </div>
              <div>
                <div style={fLabel}>METRIC</div>
                <select style={fSelect} value={metric} onChange={(e) => { setMetric(e.target.value as "achievement" | "bonus" | "goal"); setMetricGoal(""); }}>
                  <option value="achievement">Achievement %</option>
                  <option value="bonus">Bonus Amount</option>
                  <option value="goal">Goal Achievement</option>
                </select>
              </div>
              {metric === "goal" && (
                <div>
                  <div style={fLabel}>GOAL</div>
                  <select style={fSelect} value={metricGoal} onChange={(e) => setMetricGoal(e.target.value)}>
                    <option value="">Select a goal…</option>
                    {allGoalNames.map((g) => <option key={g}>{g}</option>)}
                  </select>
                </div>
              )}
            </div>
          </section>

          {/* GRID — pivot table */}
          {props.view === "grid" && (
            <section>
              <div style={{ display: "flex", alignItems: "baseline", gap: "8px", marginBottom: "12px" }}>
                <div className="section-title" style={{ margin: 0 }}>{metricLabel}</div>
                <span style={{ fontSize: "11px", color: "var(--text-muted)", fontFamily: "var(--mono)" }}>by {groupBy} × month</span>
              </div>
              {reportMonths.length === 0 ? (
                <div className="no-goals-msg" style={{ display: "block" }}>No submitted scorecards in this range.</div>
              ) : (
                <div className="table-wrap" style={{ overflowX: "auto" }}>
                  <table className="data-table" style={{ minWidth: `${160 + reportMonths.length * 110}px` }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left", minWidth: 150, position: "sticky", left: 0, background: "var(--surface)", zIndex: 2 }}>{groupBy.charAt(0).toUpperCase() + groupBy.slice(1)}</th>
                        {reportMonths.map((m) => <th key={m} style={{ textAlign: "right", whiteSpace: "nowrap", fontFamily: "var(--mono)", fontSize: "11px" }}>{shortMonthLabel(m)}</th>)}
                        <th style={{ textAlign: "right", borderLeft: "2px solid var(--border)", fontFamily: "var(--mono)", fontSize: "11px" }}>AVG</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groupKeys.map((key) => {
                        const vals = reportMonths.map((m) => getGroupMonthValue(key, m));
                        const defined = vals.filter((v): v is number => v !== null);
                        const avg = defined.length ? defined.reduce((a, b) => a + b, 0) / defined.length : null;
                        return (
                          <tr key={key}>
                            <td style={{ fontWeight: 600, position: "sticky", left: 0, background: "var(--surface)", zIndex: 1 }}>{key}</td>
                            {vals.map((v, i) => (
                              <td key={i} style={{ textAlign: "right", background: cellBg(v), color: cellFg(v), fontWeight: v !== null ? 600 : 400, fontFamily: "var(--mono)", fontSize: "12px", transition: "background 0.15s" }}>
                                {formatMetric(v)}
                              </td>
                            ))}
                            <td style={{ textAlign: "right", borderLeft: "2px solid var(--border)", background: cellBg(avg), color: cellFg(avg), fontWeight: 700, fontFamily: "var(--mono)", fontSize: "12px" }}>
                              {formatMetric(avg)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {/* CHART — SVG line graph */}
          {props.view === "chart" && (
            <section>
              <div style={{ display: "flex", alignItems: "baseline", gap: "8px", marginBottom: "12px" }}>
                <div className="section-title" style={{ margin: 0 }}>{metricLabel}</div>
                <span style={{ fontSize: "11px", color: "var(--text-muted)", fontFamily: "var(--mono)" }}>over time · by {groupBy}</span>
              </div>
              {reportMonths.length < 2 || groupKeys.length === 0 ? (
                <div className="no-goals-msg" style={{ display: "block" }}>Select a range with at least 2 months of submitted scorecards to draw a chart.</div>
              ) : (
                <ReportLineChart
                  months={reportMonths}
                  groupKeys={groupKeys}
                  getValue={getGroupMonthValue}
                  formatValue={formatMetric}
                  isPercent={isPercent}
                  isCurrency={isCurrency}
                />
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

function ReportLineChart({
  months, groupKeys, getValue, formatValue, isPercent, isCurrency,
}: {
  months: string[];
  groupKeys: string[];
  getValue: (groupKey: string, isoMonth: string) => number | null;
  formatValue: (v: number | null) => string;
  isPercent: boolean;
  isCurrency: boolean;
}) {
  const series = groupKeys.map((key, i) => ({
    key,
    color: CHART_COLORS[i % CHART_COLORS.length],
    values: months.map((m) => getValue(key, m)),
  }));

  const allVals = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  if (!allVals.length) return <div className="no-goals-msg" style={{ display: "block" }}>No data to chart.</div>;

  const dataMax = Math.max(...allVals);
  const dataMin = Math.min(0, ...allVals);
  const ticks = niceYTicks(dataMin, dataMax * 1.08);
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];

  const W = 760, H = 300;
  const pad = { top: 18, right: 24, bottom: 52, left: 62 };
  const cW = W - pad.left - pad.right;
  const cH = H - pad.top - pad.bottom;

  function xPos(i: number) { return pad.left + (months.length > 1 ? (i / (months.length - 1)) * cW : cW / 2); }
  function yPos(v: number) { return pad.top + cH - ((v - yMin) / (yMax - yMin)) * cH; }

  function yLabel(t: number): string {
    if (isPercent) return t.toFixed(0) + "%";
    if (isCurrency) return t >= 1000 ? "$" + (t / 1000).toFixed(0) + "k" : "$" + t;
    return t.toFixed(0);
  }

  return (
    <div>
      <div style={{ overflowX: "auto" }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", minWidth: 400, display: "block" }}>
          {/* Horizontal grid lines + Y labels */}
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.left} x2={W - pad.right} y1={yPos(t)} y2={yPos(t)} stroke="var(--border)" strokeWidth={1} />
              <text x={pad.left - 8} y={yPos(t) + 4} textAnchor="end" fontSize={10} fontFamily="monospace" fill="#999">{yLabel(t)}</text>
            </g>
          ))}
          {/* X labels */}
          {months.map((m, i) => (
            <text key={m} x={xPos(i)} y={H - pad.bottom + 16} textAnchor="middle" fontSize={10} fontFamily="monospace" fill="#999">{shortMonthLabel(m)}</text>
          ))}
          {/* Axes */}
          <line x1={pad.left} x2={pad.left} y1={pad.top} y2={H - pad.bottom} stroke="#ccc" strokeWidth={1.5} />
          <line x1={pad.left} x2={W - pad.right} y1={H - pad.bottom} y2={H - pad.bottom} stroke="#ccc" strokeWidth={1.5} />
          {/* Series */}
          {series.map((s) => {
            let d = "";
            let open = false;
            s.values.forEach((v, i) => {
              if (v === null) { open = false; return; }
              const x = xPos(i), y = yPos(v);
              d += open ? ` L ${x} ${y}` : `M ${x} ${y}`;
              open = true;
            });
            return (
              <g key={s.key}>
                {d && <path d={d} fill="none" stroke={s.color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />}
                {s.values.map((v, i) => v !== null && (
                  <g key={i}>
                    <circle cx={xPos(i)} cy={yPos(v)} r={5} fill="#fff" stroke={s.color} strokeWidth={2} />
                    <title>{s.key} · {shortMonthLabel(months[i])}: {formatValue(v)}</title>
                  </g>
                ))}
              </g>
            );
          })}
        </svg>
      </div>
      {/* Legend */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "14px", justifyContent: "center", paddingTop: "8px", paddingBottom: "4px" }}>
        {series.map((s) => (
          <div key={s.key} style={{ display: "flex", alignItems: "center", gap: "7px", fontSize: "12px", fontFamily: "var(--sans)", color: "var(--text)" }}>
            <svg width={20} height={3} style={{ flexShrink: 0 }}>
              <line x1={0} y1={1.5} x2={20} y2={1.5} stroke={s.color} strokeWidth={2.5} />
              <circle cx={10} cy={1.5} r={3} fill="#fff" stroke={s.color} strokeWidth={2} />
            </svg>
            {s.key}
          </div>
        ))}
      </div>
    </div>
  );
}

function RipplingScreen(props: {
  month: string;
  preview: Employee[];
  saved: Record<string, Employee[]>;
  onMonth: (value: string) => void;
  onPreview: (employees: Employee[]) => void;
  onSave: () => void;
  onClear: () => void;
}) {
  async function handleFile(file: File | undefined) {
    if (!file) return;
    props.onPreview(parseRipplingEmployees(await file.text()));
  }

  const today = new Date();
  const currentMonthVal = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;

  function uploadBlocked(month: string): string | null {
    if (!month) return null;
    const [y, m] = month.split("-").map(Number);
    const monthStart = new Date(y, m - 1, 1);
    const monthEnd = new Date(y, m, 0);
    if (monthStart > today) return "Cannot upload data for a future month.";
    if (monthEnd < today) {
      const daysSince = Math.floor((today.getTime() - monthEnd.getTime()) / 86400000);
      if (daysSince > 7) return `Upload window closed — ${formatMonthLabel(month)} ended ${daysSince} days ago (limit is 7).`;
    }
    return null;
  }

  const blockReason = uploadBlocked(props.month);
  const savedEmployees = props.saved[props.month] || [];
  return (
    <div className="screen active">
      <section>
        <div className="section-title">Upload Rippling CSV</div>
        <div className="field">
          <label>Period</label>
          <input type="month" value={props.month} max={currentMonthVal} onChange={(event) => props.onMonth(event.target.value)} />
        </div>
        {blockReason && (
          <div className="info-banner" style={{ display: "block", background: "#fff3f3", borderColor: "#f5c0c0", color: "#9B2C2C" }}>{blockReason}</div>
        )}
        {!blockReason && (
          <label id="rippling-drop-zone">
            <span className="drop-icon">CSV</span>
            <strong>Drop your Rippling CSV here</strong>
            <small>or click to browse - Active_Employees_with_Hourly_and_Annual_Base_Pay.csv</small>
            <input type="file" accept=".csv" hidden onChange={(event) => handleFile(event.target.files?.[0])} />
          </label>
        )}
      </section>
      {!!props.preview.length && !blockReason && <EmployeeTable title="Imported employees" employees={props.preview} action={<button className="submit-btn" onClick={props.onSave}>Save to App</button>} />}
      <EmployeeTable title="Saved employee data" employees={savedEmployees} action={<button onClick={props.onClear}>Clear all</button>} />
    </div>
  );
}

function EmployeeTable({ title, employees, action }: { title: string; employees: Employee[]; action?: React.ReactNode }) {
  return (
    <section>
      <div className="toolbar-row"><div className="section-title">{title}</div>{action}</div>
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>Name</th><th>Role</th><th>Department</th><th>Location</th><th>Pay</th><th>Hours</th></tr></thead>
          <tbody>{employees.map((employee) => <tr key={employee.id || employee.name}><td>{employee.name}</td><td>{employee.role}</td><td>{employee.department}</td><td>{employee.location}</td><td>{employee.payType === "salary" ? formatCurrency(employee.annualPay || 0) : formatCurrency(employee.hourlyRate || 0)}</td><td>{employee.hoursWorked || "-"}</td></tr>)}</tbody>
        </table>
      </div>
      {!employees.length && <div className="no-goals-msg" style={{ display: "block" }}>No saved employees for this month</div>}
    </section>
  );
}

function TodosScreen({
  workMonth,
  bankMonth,
  profile,
  hasRippling,
  missingActuals,
  goals,
  allActuals,
  onSaveTarget,
  onSaveTargetPair,
  onSaveCurrentTargetPair,
  onSaveActual,
  onRipplingUpload,
  onBuildEmployee
}: {
  workMonth: string;
  bankMonth: string;
  profile: ManagerProfile | null;
  hasRippling: boolean;
  missingActuals: Goal[];
  goals: Goal[];
  allActuals: Record<string, ActualsByKey>;
  onSaveTarget: (goal: Goal, period: string, type: "target" | "min", value: string) => void;
  onSaveTargetPair: (goal: Goal, target: string, min: string) => void;
  onSaveCurrentTargetPair: (goal: Goal, target: string, min: string) => void;
  onSaveActual: (goal: Goal, value: string) => void;
  onRipplingUpload: (employees: Employee[]) => void;
  onBuildEmployee: () => void;
}) {
  const [showCompletedAdmin, setShowCompletedAdmin] = useState(false);
  const [showCompletedTargets, setShowCompletedTargets] = useState(false);
  const [ripplingFile, setRipplingFile] = useState<File | null>(null);
  const [ripplingParsed, setRipplingParsed] = useState<Employee[] | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [draftTargets, setDraftTargets] = useState<Record<string, { target: string; min: string }>>({});
  const [draftCurrentTargets, setDraftCurrentTargets] = useState<Record<string, { target: string; min: string }>>({});
  const [draftActuals, setDraftActuals] = useState<Record<string, string>>({});
  const [showCompletedCurrentTargets, setShowCompletedCurrentTargets] = useState(false);

  const workMonthLabel = formatMonthLabel(workMonth);
  const workActuals = allActuals[workMonthLabel] || {};

  const currentMonthValue = useMemo(() => {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  }, []);
  const currentMonthLabel = useMemo(() => formatMonthLabel(currentMonthValue), [currentMonthValue]);
  const currentActuals = allActuals[currentMonthLabel] || {};

  const nextMonthValue = useMemo(() => {
    const today = new Date();
    const next = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
  }, []);
  const nextMonthLabel = useMemo(() => formatMonthLabel(nextMonthValue), [nextMonthValue]);
  const nextActuals = allActuals[nextMonthLabel] || {};

  const isAdmin = roleAtLeast(profile, "admin");
  const ripplingDone = hasRippling && !ripplingParsed;

  // All company/dept goals that have targets set for workMonth — each is its own actuals item
  const actualsGoals = goals.filter((g) =>
    (isAdmin ? true : g.goalTier !== "company") &&
    (g.goalTier === "company" || g.goalTier === "department") &&
    workActuals[metaKey("target", g)] != null &&
    workActuals[metaKey("min", g)] != null
  );
  const actualsDoneCount = actualsGoals.filter((g) => workActuals[actualKey(g)] != null).length;

  const adminTotal = (isAdmin ? 1 : 0) + actualsGoals.length;
  const adminDoneCount = (isAdmin ? (ripplingDone ? 1 : 0) : 0) + actualsDoneCount;

  const targetGoals = goals.filter((g) => (isAdmin ? true : g.goalTier !== "company") && (g.goalTier === "company" || g.goalTier === "department"));

  // Current month targets (overdue if not set — month already started)
  const currentTargetGoals = targetGoals;
  const currentTargetDoneCount = currentTargetGoals.filter((g) => currentActuals[metaKey("target", g)] != null).length;
  const currentTargetTotal = currentTargetGoals.length;
  const allCurrentTargetsDone = currentTargetDoneCount === currentTargetTotal && currentTargetTotal > 0;

  // Next month targets
  const targetDoneCount = targetGoals.filter((g) => nextActuals[metaKey("target", g)] != null).length;
  const targetTotal = targetGoals.length;

  function dueDate(year: number, month: number, day: number) {
    const due = new Date(year, month - 1, day);
    const now = new Date();
    const diffDays = Math.ceil((due.getTime() - now.getTime()) / 86400000);
    return { label: due.toLocaleDateString("default", { month: "short", day: "numeric" }), diffDays };
  }

  const today = new Date();
  const adminDue = dueDate(today.getFullYear(), today.getMonth() + 1, 17);
  const [cYear, cMonth] = currentMonthValue.split("-").map(Number);
  const currentTargetDue = dueDate(cYear, cMonth, 1); // due on the 1st of the current month → always overdue
  const [nYear, nMonth] = nextMonthValue.split("-").map(Number);
  const targetDue = dueDate(nYear, nMonth, 1);

  function DaysBadge({ diffDays }: { diffDays: number }) {
    if (diffDays < 0) return <span className="todo-days-badge overdue">{Math.abs(diffDays)}d overdue</span>;
    if (diffDays === 0) return <span className="todo-days-badge today">Today</span>;
    return <span className="todo-days-badge">{diffDays}d</span>;
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setRipplingFile(file);
    const text = await file.text();
    setRipplingParsed(parseRipplingEmployees(text));
  }

  function handleRipplingSave() {
    if (!ripplingParsed?.length) return;
    onRipplingUpload(ripplingParsed);
    setRipplingFile(null);
    setRipplingParsed(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // Build flat list of admin rows: rippling + one row per actual goal
  type AdminRow = { key: string; done: boolean; node: React.ReactNode };

  const ripplingRow: AdminRow | null = isAdmin ? {
    key: "rippling",
    done: ripplingDone,
    node: (
      <div className={`todo-task-section${ripplingDone ? " done" : ""}`}>
        <div className="todo-task-row">
          <span className={`todo-task-icon${ripplingDone ? " done" : ""}`}>{ripplingDone ? "✓" : "⚠"}</span>
          <div className="todo-task-body">
            <span className="todo-task-label">Upload Rippling data</span>
            <span className="todo-task-detail">{ripplingDone ? `${currentMonthLabel} data loaded — provides ${workMonthLabel} earnings` : `${currentMonthLabel} not uploaded — needed for ${workMonthLabel} earnings.`}</span>
          </div>
        </div>
        {!ripplingDone && (
          <div className="todo-inline-form">
            <input ref={fileInputRef} type="file" accept=".csv" className="todo-file-input" onChange={handleFileChange} />
            {ripplingParsed && (
              <div className="todo-inline-form-row">
                <span className="todo-task-detail">{ripplingParsed.length} employees parsed from {ripplingFile?.name}</span>
                <button className="todo-task-action" onClick={handleRipplingSave}>Save to App</button>
              </div>
            )}
          </div>
        )}
      </div>
    )
  } : null;

  const actualRows: AdminRow[] = actualsGoals.map((goal) => {
    const done = workActuals[actualKey(goal)] != null;
    const draft = draftActuals[goal.id] ?? String(workActuals[actualKey(goal)] ?? "");
    return {
      key: `actual-${goal.id}`,
      done,
      node: (
        <div key={goal.id} className={`todo-target-row${done ? " done" : ""}`}>
          <span className="todo-circle">{done ? "●" : "○"}</span>
          <span className="todo-target-name">{goal.name}</span>
          <TierBadge tier={goal.goalTier} />
          {goal.location && <span className="todo-scope-tag">{goal.location}</span>}
          {goal.department && <span className="todo-scope-tag">{goal.department}</span>}
          {!done && (
            <div className="todo-target-inputs">
              <label className="todo-input-label">
                <span>Actual</span>
                <input
                  type="number"
                  className="todo-target-input"
                  value={draft}
                  onChange={(e) => setDraftActuals((prev) => ({ ...prev, [goal.id]: e.target.value }))}
                />
              </label>
              <button
                className="todo-target-submit"
                disabled={draft === ""}
                onClick={() => onSaveActual(goal, draft)}
              >Set</button>
            </div>
          )}
        </div>
      )
    };
  });

  const allAdminRows: AdminRow[] = [...(ripplingRow ? [ripplingRow] : []), ...actualRows];
  const visibleAdminRows = showCompletedAdmin ? allAdminRows : allAdminRows.filter((r) => !r.done);

  return (
    <div className="screen active">
      <div className="todo-group-card">
        <div className="todo-group-header">
          <div className="todo-group-header-left">
            <span className="todo-group-title">Admin Tasks · {workMonthLabel}</span>
            <span className="todo-group-meta">{adminDoneCount}/{adminTotal} done · Due {adminDue.label} <DaysBadge diffDays={adminDue.diffDays} /></span>
          </div>
          <button className="todo-show-completed" onClick={() => setShowCompletedAdmin((v) => !v)}>
            {showCompletedAdmin ? "HIDE COMPLETED" : "SHOW COMPLETED"}
          </button>
        </div>
        <div className="todo-group-bar-wrap">
          <div className="todo-group-bar" style={{ width: `${(adminDoneCount / adminTotal) * 100}%` }} />
        </div>
        {visibleAdminRows.length === 0 ? (
          <div className="todo-empty-row">All admin tasks complete ✓</div>
        ) : (
          visibleAdminRows.map((row) => (
            <React.Fragment key={row.key}>{row.node}</React.Fragment>
          ))
        )}
      </div>

      {/* Current month targets — shown only when any are missing (always overdue) */}
      {currentTargetTotal > 0 && !allCurrentTargetsDone && (
        <div className="todo-group-card">
          <div className="todo-group-header">
            <div className="todo-group-header-left">
              <span className="todo-group-title">{currentMonthLabel} Targets</span>
              <span className="todo-group-meta">{currentTargetDoneCount}/{currentTargetTotal} set · Due {currentTargetDue.label} <DaysBadge diffDays={currentTargetDue.diffDays} /></span>
            </div>
            <button className="todo-show-completed" onClick={() => setShowCompletedCurrentTargets((v) => !v)}>
              {showCompletedCurrentTargets ? "HIDE COMPLETED" : "SHOW COMPLETED"}
            </button>
          </div>
          <div className="todo-group-bar-wrap">
            <div className="todo-group-bar" style={{ width: `${currentTargetTotal ? (currentTargetDoneCount / currentTargetTotal) * 100 : 0}%`, background: "var(--brick)" }} />
          </div>
          {currentTargetGoals
            .filter((g) => showCompletedCurrentTargets || currentActuals[metaKey("target", g)] == null)
            .map((goal) => {
              const saved = currentActuals[metaKey("target", goal)] != null;
              const draft = draftCurrentTargets[goal.id] ?? {
                target: String(currentActuals[metaKey("target", goal)] ?? ""),
                min: String(currentActuals[metaKey("min", goal)] ?? "")
              };
              return (
                <div key={goal.id} className={`todo-target-row${saved ? " done" : ""}`}>
                  <span className="todo-circle">{saved ? "●" : "○"}</span>
                  <span className="todo-target-name">{goal.name}</span>
                  <TierBadge tier={goal.goalTier} />
                  {goal.department && <span className="todo-scope-tag">{goal.department}</span>}
                  {!saved && (
                    <div className="todo-target-inputs">
                      <label className="todo-input-label">
                        <span>Target</span>
                        <input
                          type="number"
                          className="todo-target-input"
                          value={draft.target}
                          onChange={(e) => setDraftCurrentTargets((prev) => ({ ...prev, [goal.id]: { ...draft, target: e.target.value } }))}
                        />
                      </label>
                      <label className="todo-input-label">
                        <span>Min</span>
                        <input
                          type="number"
                          className="todo-target-input"
                          value={draft.min}
                          onChange={(e) => setDraftCurrentTargets((prev) => ({ ...prev, [goal.id]: { ...draft, min: e.target.value } }))}
                        />
                      </label>
                      <button
                        className="todo-target-submit"
                        disabled={draft.target === ""}
                        onClick={() => onSaveCurrentTargetPair(goal, draft.target, draft.min)}
                      >Set</button>
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      )}

      <div className="todo-group-card">
        <div className="todo-group-header">
          <div className="todo-group-header-left">
            <span className="todo-group-title">{nextMonthLabel} Targets</span>
            <span className="todo-group-meta">{targetDoneCount}/{targetTotal} set · Due {targetDue.label} <DaysBadge diffDays={targetDue.diffDays} /></span>
          </div>
          <button className="todo-show-completed" onClick={() => setShowCompletedTargets((v) => !v)}>
            {showCompletedTargets ? "HIDE COMPLETED" : "SHOW COMPLETED"}
          </button>
        </div>
        <div className="todo-group-bar-wrap">
          <div className="todo-group-bar" style={{ width: `${targetTotal ? (targetDoneCount / targetTotal) * 100 : 0}%` }} />
        </div>
        {targetGoals.length === 0 ? (
          <div className="todo-empty-row">No company or department goals in bank</div>
        ) : (
          targetGoals
            .filter((g) => showCompletedTargets || nextActuals[metaKey("target", g)] == null)
            .map((goal) => {
              const saved = nextActuals[metaKey("target", goal)] != null;
              const draft = draftTargets[goal.id] ?? {
                target: String(nextActuals[metaKey("target", goal)] ?? ""),
                min: String(nextActuals[metaKey("min", goal)] ?? "")
              };
              return (
                <div key={goal.id} className={`todo-target-row${saved ? " done" : ""}`}>
                  <span className="todo-circle">{saved ? "●" : "○"}</span>
                  <span className="todo-target-name">{goal.name}</span>
                  <TierBadge tier={goal.goalTier} />
                  {goal.department && <span className="todo-scope-tag">{goal.department}</span>}
                  {!saved && (
                    <div className="todo-target-inputs">
                      <label className="todo-input-label">
                        <span>Target</span>
                        <input
                          type="number"
                          className="todo-target-input"
                          value={draft.target}
                          onChange={(e) => setDraftTargets((prev) => ({ ...prev, [goal.id]: { ...draft, target: e.target.value } }))}
                        />
                      </label>
                      <label className="todo-input-label">
                        <span>Min</span>
                        <input
                          type="number"
                          className="todo-target-input"
                          value={draft.min}
                          onChange={(e) => setDraftTargets((prev) => ({ ...prev, [goal.id]: { ...draft, min: e.target.value } }))}
                        />
                      </label>
                      <button
                        className="todo-target-submit"
                        disabled={draft.target === ""}
                        onClick={() => onSaveTargetPair(goal, draft.target, draft.min)}
                      >Set</button>
                    </div>
                  )}
                </div>
              );
            })
        )}
      </div>
    </div>
  );
}

const guideSteps = [
  {
    title: "Upload Rippling Data",
    bg: "var(--brick-light)", border: "var(--taupe)", numBg: "var(--brick)",
    body: "Start each month by uploading your Rippling CSV. This pre-loads employee names, roles, departments, locations, and pay rates so you don't have to enter them manually.",
    bullets: ["Go to Rippling Data in the sidebar", "Select the payroll month", "Upload the Active_Employees_with_Hourly_and_Annual_Base_Pay.csv file", "Review the preview and click Save to App"]
  },
  {
    title: "Build Your Goal Bank",
    bg: "#f0f7fa", border: "#b8d4e0", numBg: "#185FA5",
    body: "The Goal Bank is your permanent library of goals. Goals don't expire — they're reused month to month and pulled into scorecards. Set this up once and update as needed.",
    bullets: ["Go to Goals & Actuals in the sidebar", "Click + Add Goal to Bank at the bottom", "Set the type: Company (everyone), Department (dept-wide), or Individual (role-specific)", "Goals can be deactivated without being deleted"]
  },
  {
    title: "Enter Company & Department Actuals",
    bg: "#f0f7fa", border: "#b8d4e0", numBg: "#185FA5",
    body: "At month end, enter the actual results for company and department goals. These are shared across all employees — enter them once and they'll be available when building scorecards.",
    bullets: ["Go to Goals & Actuals in the sidebar", "Select the month from the filter at the top", "Use the ⋮ menu on each goal row and choose Enter actual", "Individual goal actuals are entered per-employee in the scorecard builder"]
  },
  {
    title: "Build Individual Scorecards",
    bg: "#eef5ec", border: "#aacfa5", numBg: "#1a5c1a",
    body: "For each employee, build their scorecard by selecting goals, setting weights, entering individual actuals, and submitting. Company and department actuals you already entered will pre-fill automatically.",
    bullets: ["Go to Team Scorecards in the sidebar", "Select the employee and scorecard month", "Goals load automatically based on their role and department", "Set a weight for each goal (all weights must total 100%)", "Enter actuals for individual goals — company and dept actuals are pre-filled", "Review the calculated bonus summary, then click Submit Scorecard"]
  },
  {
    title: "Review Historical Data",
    bg: "#eef5ec", border: "#aacfa5", numBg: "#1a5c1a",
    body: "Search and review all submitted scorecards. Filter by period, employee, department, or location. Export to CSV for payroll or further analysis.",
    bullets: ["Go to Historical Data in the sidebar", "Select a period and optionally filter by location or department", "Each card shows goal-level detail — achievement, actuals, and bonus contribution", "Click ↓ Export filtered results CSV to download a full spreadsheet"]
  }
];

function GuideScreen() {
  return (
    <div className="screen active">
      <section>
        <div className="section-title">How to use this app</div>
        <p style={{ fontSize: "13px", color: "var(--text-muted)", lineHeight: 1.7 }}>Follow these steps each month to set up goals, enter actuals, and build employee scorecards.</p>
      </section>
      {guideSteps.map((step, index) => (
        <section key={step.title} style={{ background: step.bg, borderColor: step.border }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "14px" }}>
            <div style={{ width: "28px", height: "28px", borderRadius: "50%", background: step.numBg, color: "#fff", fontSize: "13px", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{index + 1}</div>
            <div className="section-title" style={{ margin: 0 }}>{step.title}</div>
          </div>
          <p style={{ fontSize: "13px", color: "var(--text)", lineHeight: 1.7, marginBottom: "8px" }}>{step.body}</p>
          <ul style={{ fontSize: "13px", color: "var(--text-muted)", lineHeight: 1.9, paddingLeft: "18px" }}>
            {step.bullets.map((b) => <li key={b}>{b}</li>)}
          </ul>
        </section>
      ))}
      <section style={{ background: "var(--surface2)", borderStyle: "dashed" }}>
        <div className="section-title">Tips</div>
        <ul style={{ fontSize: "13px", color: "var(--text-muted)", lineHeight: 1.9, paddingLeft: "18px" }}>
          <li>All goal weights on a scorecard must total exactly <strong>100%</strong> — the builder warns you if they don't</li>
          <li>Scorecards are <strong>capped at 200%</strong> total weighted achievement</li>
          <li>Achievements of <strong>120%+</strong> are flagged for review but not capped</li>
          <li>If a goal's actual doesn't meet the <strong>minimum threshold</strong>, that goal contributes $0 to the bonus</li>
          <li>Company and department actuals only need to be entered once — they apply to all scorecards for that month</li>
          <li>Goals can be <strong>deactivated</strong> in the Goal Bank without deleting them, keeping history intact</li>
        </ul>
      </section>
    </div>
  );
}

type PlayGoal = {
  id: string;
  name: string;
  goalTier: GoalTier;
  location?: string;
  department?: string;
  role?: string;
  lowerBetter: boolean;
  capped: "yes" | "no";
  capPct: number;
  target: string;
  min: string;
  actual: string;
  weight: string;
};

function WhatIfScreen(props: {
  allGoals: Goal[];
  profile: ManagerProfile | null;
  latestEmployees: Employee[];
  allEmployees: Employee[];
}) {
  const isUser = props.profile?.role === "user";
  const defaultEmpName = isUser ? (props.profile?.linkedEmployeeName || "") : "";
  const [selectedEmpName, setSelectedEmpName] = useState(defaultEmpName);
  const [earningsInput, setEarningsInput] = useState("");
  const [hourlyRateInput, setHourlyRateInput] = useState("");
  const [playGoals, setPlayGoals] = useState<PlayGoal[]>([]);
  const [addGoalOpen, setAddGoalOpen] = useState(false);

  const teamEmployees = useMemo(
    () => scopedEmployeesForProfile(props.latestEmployees, props.profile, props.allEmployees),
    [props.latestEmployees, props.profile, props.allEmployees]
  );
  const employeeOptions = useMemo(() => {
    if (isUser) return props.latestEmployees.filter((e) => e.name === props.profile?.linkedEmployeeName);
    const opts = [...teamEmployees];
    if (props.profile?.linkedEmployeeName) {
      const self = props.latestEmployees.find((e) => e.name === props.profile!.linkedEmployeeName);
      if (self && !opts.some((e) => e.name === self.name)) opts.unshift(self);
    }
    return opts;
  }, [isUser, teamEmployees, props.latestEmployees, props.profile]);
  const selectedEmp = props.latestEmployees.find((e) => e.name === selectedEmpName);

  useEffect(() => {
    if (!selectedEmpName) {
      setPlayGoals([]);
      setEarningsInput("");
      return;
    }
    const emp = props.latestEmployees.find((e) => e.name === selectedEmpName);
    setEarningsInput("");
    setHourlyRateInput(emp?.hourlyRate ? String(emp.hourlyRate) : "");
    const applicable = props.allGoals.filter((g) => {
      if (g.goalTier === "company") return true;
      if (g.goalTier === "department") return !g.department || g.department === emp?.department;
      if (g.goalTier === "individual") return !g.role || g.role === emp?.role;
      return false;
    });
    const n = applicable.length;
    const equalWeight = n > 0 ? Number((100 / n).toFixed(2)) : 0;
    setPlayGoals(applicable.map((g, i) => ({
      id: g.id, name: g.name, goalTier: g.goalTier, location: g.location, department: g.department,
      role: g.role, lowerBetter: g.lowerBetter, capped: g.capped, capPct: g.capPct,
      target: String(g.goalValue || ""), min: String(g.minValue || ""), actual: "",
      weight: i === n - 1 ? String(100 - equalWeight * (n - 1)) : String(equalWeight)
    })));
  }, [selectedEmpName]); // eslint-disable-line react-hooks/exhaustive-deps

  const earnings = Number(earningsInput) || 0;
  const hourlyRate = Number(hourlyRateInput) || 0;
  const impliedHours = hourlyRate > 0 && earnings > 0 ? earnings / hourlyRate : 0;
  const liveGoals = playGoals.map((pg) =>
    calculateGoal({
      goal: { name: pg.name, goalTier: pg.goalTier, location: pg.location, department: pg.department, role: pg.role, lowerBetter: pg.lowerBetter, capped: pg.capped, capPct: pg.capPct },
      target: Number(pg.target) || 0, min: Number(pg.min) || 0,
      actual: pg.actual === "" ? null : Number(pg.actual),
      weight: Number(pg.weight) || 0, baseEarnings: earnings, bonusPotentialPct: 10
    })
  );
  const totalWeight = playGoals.reduce((sum, pg) => sum + (Number(pg.weight) || 0), 0);
  const weightedAchievement = liveGoals.reduce((sum, g) => sum + g.weighted, 0);
  const cappedAch = Math.min(weightedAchievement, 200);
  const bonusAmount = earnings * (cappedAch / 100) * 0.1;
  const effectiveHourly = impliedHours > 0 ? (earnings + bonusAmount) / impliedHours : null;

  const availableToAdd = props.allGoals.filter((g) => {
    if (playGoals.some((pg) => pg.id === g.id)) return false;
    if (g.goalTier === "company") return true;
    if (g.goalTier === "department") return !g.department || g.department === selectedEmp?.department;
    if (g.goalTier === "individual") return !g.role || g.role === selectedEmp?.role;
    return false;
  });

  function updateGoal(id: string, field: keyof PlayGoal, value: string) {
    setPlayGoals((prev) => prev.map((pg) => pg.id === id ? { ...pg, [field]: value } : pg));
  }

  const thS: React.CSSProperties = { padding: "6px 10px", fontSize: "9px", fontWeight: 700, color: "var(--text-muted)", textAlign: "left", borderBottom: "1.5px solid var(--border)", whiteSpace: "nowrap", background: "var(--surface2)" };
  const thC: React.CSSProperties = { ...thS, textAlign: "center" };

  return (
    <div className="screen active">
      <section>
        <div className="section-title">What If Scorecard</div>
        <p style={{ fontSize: "13px", color: "var(--text-muted)", lineHeight: 1.7, marginTop: "4px" }}>
          Explore how changes to targets, actuals, and weights affect bonus calculations. Nothing here is saved.
        </p>
      </section>

      <section>
        <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", alignItems: "flex-end" }}>
          {!isUser && (
            <div className="field" style={{ flex: "1 1 220px", minWidth: 0 }}>
              <label>Employee</label>
              <select value={selectedEmpName} onChange={(e) => setSelectedEmpName(e.target.value)}>
                <option value="">— select employee —</option>
                {employeeOptions.map((emp) => (
                  <option key={emp.id} value={emp.name}>{emp.name}</option>
                ))}
              </select>
            </div>
          )}
          {isUser && props.profile?.linkedEmployeeName && (
            <div className="field" style={{ flex: "1 1 220px", minWidth: 0 }}>
              <label>Employee</label>
              <div style={{ padding: "8px 10px", border: "1.5px solid var(--border)", borderRadius: "var(--radius-sm)", fontSize: "13px", background: "var(--surface2)" }}>
                {props.profile.linkedEmployeeName}
              </div>
            </div>
          )}
          <div className="field" style={{ flex: "1 1 160px", minWidth: 0 }}>
            <label>Base Earnings</label>
            <input
              type="number"
              value={earningsInput}
              onChange={(e) => setEarningsInput(e.target.value)}
              placeholder="0.00"
              style={{ fontFamily: "var(--mono)" }}
            />
          </div>
          <div className="field" style={{ flex: "1 1 140px", minWidth: 0 }}>
            <label>Hourly Rate</label>
            <input
              type="number"
              value={hourlyRateInput}
              onChange={(e) => setHourlyRateInput(e.target.value)}
              placeholder="0.00"
              style={{ fontFamily: "var(--mono)" }}
            />
          </div>
          {selectedEmp && (
            <div style={{ flex: "1 1 auto", fontSize: "12px", color: "var(--text-muted)", paddingBottom: "8px" }}>
              {selectedEmp.role}{selectedEmp.department ? ` · ${selectedEmp.department}` : ""}{selectedEmp.location ? ` · ${selectedEmp.location}` : ""}
            </div>
          )}
        </div>
      </section>

      {selectedEmpName && (
        <section>
          {playGoals.length > 0 ? (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
                <thead>
                  <tr>
                    <th style={thS}>Type</th>
                    <th style={thS}>Goal</th>
                    <th style={thC}>Target</th>
                    <th style={thC}>Min</th>
                    <th style={thC}>Actual</th>
                    <th style={thC}>Weight %</th>
                    <th style={thC}>Achieve %</th>
                    <th style={thC}>Bonus $</th>
                    <th style={{ ...thC, width: "28px" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {playGoals.map((pg, i) => {
                    const sc = liveGoals[i];
                    const isCustom = pg.id.startsWith("custom-");
                    return (
                      <tr key={pg.id} style={{ borderBottom: "1px solid var(--border)" }}>
                        <td style={{ padding: "4px 6px" }}>
                          {isCustom ? (
                            <select
                              value={pg.goalTier}
                              onChange={(e) => updateGoal(pg.id, "goalTier", e.target.value)}
                              style={{ fontSize: "10px", padding: "2px 4px", border: "1.5px solid var(--border)", borderRadius: "var(--radius-sm)", fontFamily: "var(--sans)", background: "var(--surface)", cursor: "pointer" }}
                            >
                              <option value="company">Company</option>
                              <option value="department">Dept</option>
                              <option value="individual">Individual</option>
                            </select>
                          ) : <TierBadge tier={pg.goalTier} />}
                        </td>
                        <td style={{ padding: "4px 6px", fontWeight: 600, minWidth: "140px" }}>
                          {isCustom ? (
                            <input
                              type="text"
                              className="actual-inline-input"
                              value={pg.name}
                              onChange={(e) => updateGoal(pg.id, "name", e.target.value)}
                              placeholder="Goal name"
                              style={{ width: "140px" }}
                            />
                          ) : <>{pg.name}<GoalScopeTags location={pg.location} department={pg.department} /></>}
                        </td>
                        <td style={{ padding: "4px 6px", textAlign: "center" }}>
                          <input type="number" className="actual-inline-input" value={pg.target}
                            onChange={(e) => updateGoal(pg.id, "target", e.target.value)} style={{ width: "68px" }} />
                        </td>
                        <td style={{ padding: "4px 6px", textAlign: "center" }}>
                          <input type="number" className="actual-inline-input" value={pg.min}
                            onChange={(e) => updateGoal(pg.id, "min", e.target.value)} style={{ width: "68px" }} />
                        </td>
                        <td style={{ padding: "4px 6px", textAlign: "center" }}>
                          <input type="number" className="actual-inline-input" value={pg.actual}
                            onChange={(e) => updateGoal(pg.id, "actual", e.target.value)} style={{ width: "68px" }} placeholder="—" />
                        </td>
                        <td style={{ padding: "4px 6px", textAlign: "center" }}>
                          <input type="number" className="actual-inline-input" value={pg.weight}
                            onChange={(e) => updateGoal(pg.id, "weight", e.target.value)} style={{ width: "60px" }} />
                        </td>
                        <td style={{ padding: "6px 10px", fontFamily: "var(--mono)", textAlign: "center", fontWeight: 700 }}>
                          {sc.actual != null
                            ? (sc.metMin
                              ? <span style={{ color: sc.achievement >= 100 ? "#2D6B1A" : "var(--brick)" }}>{sc.achievement.toFixed(1)}%</span>
                              : <span style={{ color: "#9B2C2C" }}>Below min</span>)
                            : <span style={{ color: "var(--text-faint)" }}>—</span>}
                        </td>
                        <td style={{ padding: "6px 10px", fontFamily: "var(--mono)", textAlign: "center" }}>{formatCurrency(sc.bonusContribution)}</td>
                        <td style={{ padding: "4px 6px", textAlign: "center" }}>
                          <button
                            onClick={() => setPlayGoals((prev) => prev.filter((g) => g.id !== pg.id))}
                            style={{ border: "none", background: "none", color: "#9B2C2C", fontSize: "14px", cursor: "pointer", padding: 0, lineHeight: 1, opacity: 0.6 }}
                            title="Remove goal"
                          >✕</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="no-goals-msg" style={{ display: "block" }}>No goals found for this employee. Add one below.</div>
          )}

          <div style={{ padding: "10px 0", display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <div style={{ position: "relative" }}>
              <button
                style={{ fontSize: "12px", padding: "5px 10px", border: "1.5px solid var(--border)", borderRadius: "var(--radius-sm)", background: "none", cursor: "pointer", fontFamily: "var(--sans)" }}
                onClick={() => setAddGoalOpen(!addGoalOpen)}
              >+ Add Goal</button>
              {addGoalOpen && (
                <div style={{ position: "absolute", bottom: "calc(100% + 4px)", left: 0, background: "var(--surface)", border: "1.5px solid var(--border)", borderRadius: "var(--radius-sm)", boxShadow: "0 4px 12px rgba(0,0,0,0.12)", zIndex: 100, minWidth: "220px", maxHeight: "260px", overflowY: "auto" }}>
                  {availableToAdd.map((g) => (
                    <button key={g.id}
                      style={{ display: "block", width: "100%", padding: "7px 12px", border: "none", background: "none", textAlign: "left", cursor: "pointer", fontFamily: "var(--sans)", fontSize: "12px" }}
                      onClick={() => {
                        const n = playGoals.length + 1;
                        const equalWeight = Number((100 / n).toFixed(2));
                        setPlayGoals((prev) => [...prev, {
                          id: g.id, name: g.name, goalTier: g.goalTier, location: g.location, department: g.department,
                          role: g.role, lowerBetter: g.lowerBetter, capped: g.capped, capPct: g.capPct,
                          target: String(g.goalValue || ""), min: String(g.minValue || ""), actual: "", weight: String(equalWeight)
                        }]);
                        setAddGoalOpen(false);
                      }}>
                      {g.name}<GoalScopeTags location={g.location} department={g.department} />
                    </button>
                  ))}
                  {availableToAdd.length > 0 && (
                    <div style={{ borderTop: "1px solid var(--border)", margin: "4px 0" }} />
                  )}
                  <button
                    style={{ display: "block", width: "100%", padding: "7px 12px", border: "none", background: "none", textAlign: "left", cursor: "pointer", fontFamily: "var(--sans)", fontSize: "12px", color: "var(--brick)", fontWeight: 600 }}
                    onClick={() => {
                      const n = playGoals.length + 1;
                      const equalWeight = Number((100 / n).toFixed(2));
                      setPlayGoals((prev) => [...prev, {
                        id: `custom-${Date.now()}`, name: "", goalTier: "individual",
                        lowerBetter: false, capped: "no", capPct: 100,
                        target: "", min: "", actual: "", weight: String(equalWeight)
                      }]);
                      setAddGoalOpen(false);
                    }}>
                    + Custom goal
                  </button>
                </div>
              )}
            </div>
            <div style={{ marginLeft: "auto", fontSize: "12px", color: totalWeight !== 100 ? "var(--brick)" : "var(--text-muted)", fontFamily: "var(--mono)" }}>
              Total weight: {totalWeight.toFixed(1)}%{totalWeight !== 100 ? " ⚠ must equal 100" : ""}
            </div>
          </div>
        </section>
      )}

      {selectedEmpName && playGoals.length > 0 && (
        <div className="results-section">
          <div className="section-title" style={{ marginBottom: "12px" }}>Live Results</div>
          <div className="metrics-grid">
            <Metric label="Base Earnings" value={formatCurrency(earnings)} />
            <Metric label="Weighted Achievement" value={`${weightedAchievement.toFixed(1)}%${weightedAchievement > 200 ? " → capped 200%" : ""}`} highlight />
            <Metric label="Estimated Bonus" value={formatCurrency(bonusAmount)} highlight />
            <Metric label="Total Pay" value={formatCurrency(earnings + bonusAmount)} />
            {effectiveHourly !== null && <Metric label="Effective Hourly Rate" value={`$${effectiveHourly.toFixed(2)}/hr`} />}
          </div>
        </div>
      )}
    </div>
  );
}

function MigrateScreen() {
  return (
    <div className="screen active"><section><div className="section-title">Migrate Local Data to Supabase</div><p>This React version preserves the same legacy localStorage keys. Use this only from a browser that contains the original local data.</p><button className="submit-btn" onClick={() => alert("Migration uses the preserved Supabase table contracts and should be run only after a real Supabase smoke test.")}>Start Migration</button></section></div>
  );
}

function DeleteScorecardGoalModal(props: { goalName: string; onSingle: () => void; onAll: () => void; onCancel: () => void }) {
  return (
    <div id="sc-delete-modal">
      <div>
        <div className="modal-title">Remove goal from scorecard</div>
        <div id="sc-delete-msg">Remove {props.goalName} from this scorecard or all team scorecards this month?</div>
        <div className="modal-actions">
          <button onClick={props.onSingle}>Remove from this employee only</button>
          <button onClick={props.onAll}>Remove from all team scorecards this month</button>
          <button onClick={props.onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
