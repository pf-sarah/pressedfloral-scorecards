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
  loadSetting,
  saveSetting,
  scorecardFromRow,
  scorecardToRow,
  supabaseClient
} from "../lib/supabase";
import type { ActualsByKey, AppData, Employee, Goal, GoalTier, HistoryFilters, ManagerProfile, ProfileRole, Scorecard } from "../lib/types";
import { AppShell, type NavGroup } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  ArrowDownUp,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Download,
  FileText,
  History,
  Info,
  LayoutDashboard,
  LayoutGrid,
  ListChecks,
  MoreHorizontal,
  Search,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
  Upload,
  UserCog,
  Users as UsersIcon,
  Wrench,
  X,
} from "lucide-react";

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

/** Is this goal visible and active for a given ISO month (YYYY-MM)? */
function goalActiveForMonth(goal: Goal, month: string): boolean {
  if (goal.startMonth && goal.startMonth > month) return false;
  if (goal.endMonth && goal.endMonth <= month) return false;
  return true;
}

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

function quarterToIsoMonth(quarter: string): string {
  const match = quarter.match(/^Q(\d) (\d{4})$/);
  if (!match) return currentMonthValue();
  const q = parseInt(match[1]);
  const y = parseInt(match[2]);
  return `${y}-${String((q - 1) * 3 + 1).padStart(2, "0")}`;
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
  const [viewAsProfile, setViewAsProfile] = useState<ManagerProfile | null>(null);
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [maintenanceLoading, setMaintenanceLoading] = useState(false);

  // When viewing as another user, all display/scoping uses this instead of the real profile.
  // Write operations always use the real `profile` so data is never saved under the wrong user.
  const effectiveProfile = viewAsProfile ?? profile;

  const [bankMonth, setBankMonth] = useState(currentMonthValue);
  const [bankFilters, setBankFilters] = useState({ types: ["company", "department", "individual"] as string[], location: "", departments: [...departments] as string[], sort: "goalTier", showInactive: false });
  const [editingGoal, setEditingGoal] = useState<Goal | null>(null);

  // Rippling uploads always target the previous (completed) month

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
      // PKCE flow: token arrives as ?code= query param
      const search = new URLSearchParams(window.location.search);
      const code = search.get("code");
      if (code) {
        window.location.replace("/accept-invite" + window.location.search);
        return;
      }
      // Implicit flow: token arrives as #access_token=...&type=invite|recovery
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

  // Load maintenance mode on startup (and whenever sb becomes available)
  useEffect(() => {
    if (isFixture) return;
    const client = sb ?? (() => { try { return supabaseClient(); } catch { return null; } })();
    if (!client) return;
    loadSetting(client, "maintenance_mode").then((val) => {
      if (val !== null) setMaintenanceMode(val === "true");
    });
  }, [sb, isFixture]);

  async function toggleMaintenanceMode(enabled: boolean) {
    setMaintenanceLoading(true);
    try {
      const client = sb ?? supabaseClient();
      await saveSetting(client, "maintenance_mode", enabled ? "true" : "false");
      setMaintenanceMode(enabled);
      showToast(enabled ? "Maintenance mode ON — non-admins will see a maintenance page" : "Maintenance mode OFF — app is live");
    } catch {
      showToast("Could not update maintenance mode", "error");
    } finally {
      setMaintenanceLoading(false);
    }
  }

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
    const periodActualsForBank = appData.actuals[formatMonthLabel(bankMonth)] || {};
    let goals = appData.goals;
    // Scope goals to the manager's team — individual goals by employee name, others by dept/location
    if (effectiveProfile && effectiveProfile.role !== "admin") {
      const teamNames = new Set(
        scopedEmployeesForProfile(Object.values(appData.rippling).flat(), effectiveProfile, Object.values(appData.rippling).flat()).map((e) => e.name)
      );
      goals = goals.filter((g) => {
        if (g.goalTier === "company") return false; // non-admins never see company goals
        if (g.goalTier === "individual" && g.employeeName) return teamNames.has(g.employeeName);
        // dept/individual-with-role: use dept/location scoping
        return scopedForProfile([g], effectiveProfile).length > 0;
      });
    } else if (effectiveProfile && effectiveProfile.role === "admin") {
      // admins see everything
    }
    goals = goals.filter((goal) => {
      const activeThisMonth = goalActiveForMonth(goal, bankMonth);
      if (!activeThisMonth) {
        // endMonth has passed — show as inactive only when showInactive is on
        return bankFilters.showInactive;
      }
      // Legacy global-inactive goals
      if (!goal.active) return bankFilters.showInactive;
      // Active this month — respect the single-month inactive flag
      if (!bankFilters.showInactive) {
        return !periodActualsForBank["__monthly_inactive__" + actualKey(goal)];
      }
      return true;
    });
    if (bankFilters.types.length > 0 && bankFilters.types.length < 3) goals = goals.filter((goal) => bankFilters.types.includes(goal.goalTier));
    if (bankFilters.location) goals = goals.filter((goal) => !goal.location || goal.location === bankFilters.location);
    if (bankFilters.departments.length < departments.length) goals = goals.filter((goal) => !goal.department || bankFilters.departments.includes(goal.department));
    return [...goals].sort((a, b) => {
      const field = bankFilters.sort as keyof Goal;
      return String(a[field] || "").localeCompare(String(b[field] || "")) || a.name.localeCompare(b.name);
    });
  }, [appData.goals, appData.actuals, appData.rippling, bankFilters, bankMonth, effectiveProfile]);

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

  // Employee record for the logged-in user (for the Personal Scorecard panel).
  // Falls back to the most recent submitted scorecard if the employee isn't in Rippling,
  // so the personal scorecard always shows applicable goals even before payroll data is uploaded.
  const myEmployee = useMemo(() => {
    if (!effectiveProfile?.linkedEmployeeName) return null;
    const fromRippling = latestRipplingEmployees.find((e) => e.name === effectiveProfile.linkedEmployeeName);
    if (fromRippling) return fromRippling;
    // Fall back to most recent submitted scorecard for role/dept/location
    const latestSc = [...appData.scorecards]
      .filter((sc) => sc.employeeName === effectiveProfile.linkedEmployeeName)
      .sort((a, b) => b.scorecardMonth.localeCompare(a.scorecardMonth))[0];
    if (latestSc) {
      return {
        id: latestSc.employeeName,
        name: latestSc.employeeName,
        role: latestSc.role,
        department: latestSc.department,
        location: latestSc.location,
        manager: "",
        payType: latestSc.payType,
        hourlyRate: latestSc.hourlyRate,
        annualPay: latestSc.annualPay,
        grossEarnings: undefined,
        hoursWorked: undefined,
        isExempt: undefined,
        employmentType: undefined,
      } as Employee;
    }
    return null;
  }, [effectiveProfile, latestRipplingEmployees, appData.scorecards]);

  // Scorecards belonging to the effective user (for the Personal Scorecard panel)
  const myOwnScorecards = useMemo(() => {
    if (!effectiveProfile?.linkedEmployeeName) return [];
    return [...appData.scorecards.filter((sc) => sc.employeeName === effectiveProfile.linkedEmployeeName)]
      .sort((a, b) => {
        function key(period: string) {
          const qm = period.match(/^Q(\d) (\d{4})$/);
          if (qm) return `${qm[2]}-${String((parseInt(qm[1]) - 1) * 3 + 1).padStart(2, "0")}`;
          const d = new Date(`${period} 1`);
          return isNaN(d.getTime()) ? period : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        }
        return key(a.scorecardMonth).localeCompare(key(b.scorecardMonth));
      });
  }, [effectiveProfile, appData.scorecards]);

  const filteredHistory = useMemo(() => {
    return scopedScorecardsForProfile(appData.scorecards, effectiveProfile, allRipplingEmployees).filter((scorecard) => {
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
  }, [appData.scorecards, historyFilters, effectiveProfile, allRipplingEmployees]);

  // workMonth = the most recently completed month (always previous calendar month)
  const workMonth = useMemo(() => {
    const d = new Date();
    const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
  }, []);



  const missingActuals = useMemo(() => {
    const actuals = appData.actuals[formatMonthLabel(workMonth)] || {};
    const isAdmin = roleAtLeast(effectiveProfile, "admin");
    return appData.goals.filter((goal) =>
      goalActiveForMonth(goal, workMonth) &&
      (goal.goalTier === "company" || goal.goalTier === "department") &&
      (isAdmin || goal.goalTier !== "company") &&
      scopedForProfile([goal], effectiveProfile).length > 0 &&
      actuals[metaKey("target", goal)] != null &&
      actuals[metaKey("min", goal)] != null &&
      actuals[actualKey(goal)] == null
    );
  }, [appData.goals, appData.actuals, workMonth, effectiveProfile]);

  const missingScorecards = useMemo(() => {
    const employees = appData.rippling[workMonth] || [];
    return employees.filter((employee) => !appData.scorecards.some((sc) => sc.employeeName === employee.name && sc.scorecardMonth === formatMonthLabel(workMonth)));
  }, [appData.rippling, appData.scorecards, workMonth]);

  const missingCurrentTargets = useMemo(() => {
    const today = new Date();
    const currentMonthVal = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
    const currentLabel = formatMonthLabel(currentMonthVal);
    const currentActuals = appData.actuals[currentLabel] || {};
    const isAdmin = roleAtLeast(effectiveProfile, "admin");
    return appData.goals.filter((g) =>
      goalActiveForMonth(g, currentMonthVal) &&
      (isAdmin ? true : g.goalTier !== "company") &&
      (g.goalTier === "company" || g.goalTier === "department") &&
      scopedForProfile([g], effectiveProfile).length > 0 &&
      currentActuals[metaKey("target", g)] == null
    );
  }, [appData.goals, appData.actuals, effectiveProfile]);

  const missingNextTargets = useMemo(() => {
    const today = new Date();
    const next = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const nextVal = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
    const nextLabel = formatMonthLabel(nextVal);
    const nextActuals = appData.actuals[nextLabel] || {};
    const isAdmin = roleAtLeast(effectiveProfile, "admin");
    return appData.goals.filter((g) =>
      goalActiveForMonth(g, nextVal) &&
      (isAdmin ? true : g.goalTier !== "company") &&
      (g.goalTier === "company" || g.goalTier === "department") &&
      scopedForProfile([g], effectiveProfile).length > 0 &&
      nextActuals[metaKey("target", g)] == null
    );
  }, [appData.goals, appData.actuals, effectiveProfile]);

  const todos = useMemo(() => {
    const tasks: { label: string; detail: string; action: Screen }[] = [];
    if (roleAtLeast(effectiveProfile, "admin") && !appData.rippling[workMonth]?.length) tasks.push({ label: "Upload Rippling data", detail: `${formatMonthLabel(workMonth)} data not uploaded yet.`, action: "rippling" });
    if (missingActuals.length) tasks.push({ label: "Enter shared actuals", detail: `${missingActuals.length} company or department goals need actuals.`, action: "setup" });
    if (missingCurrentTargets.length) tasks.push({ label: "Set current month targets", detail: `${missingCurrentTargets.length} goals need targets for this month.`, action: "todos" });
    return tasks;
  }, [appData.rippling, workMonth, missingActuals, missingCurrentTargets, effectiveProfile]);

  const todoBadgeCount = useMemo(() => {
    const ripplingPending = roleAtLeast(effectiveProfile, "admin") && !appData.rippling[workMonth]?.length ? 1 : 0;
    return ripplingPending + missingActuals.length + missingCurrentTargets.length + missingNextTargets.length;
  }, [effectiveProfile, appData.rippling, workMonth, missingActuals, missingCurrentTargets, missingNextTargets]);

  // Aggregated data backing the Dashboard (home) screen. Everything here is derived
  // from existing app state — no new data sources.
  const dashboard = useMemo(() => {
    const workMonthLabel = formatMonthLabel(workMonth);
    const isManagerRole = roleAtLeast(effectiveProfile, "manager");

    // Team / org rollup (manager + admin)
    const scopedScorecards = scopedScorecardsForProfile(appData.scorecards, effectiveProfile, allRipplingEmployees);
    const submittedThisMonth = scopedScorecards.filter((sc) => sc.scorecardMonth === workMonthLabel);
    const scopedEmployees = scopedEmployeesForProfile(appData.rippling[workMonth] || [], effectiveProfile, allRipplingEmployees);
    const expected = scopedEmployees.length;
    const submittedCount = submittedThisMonth.length;
    const totalBonus = submittedThisMonth.reduce((sum, sc) => sum + (sc.bonusAmount || 0), 0);
    const avgAchievement = submittedThisMonth.length
      ? submittedThisMonth.reduce((sum, sc) => sum + (sc.weightedAchievement || 0), 0) / submittedThisMonth.length
      : 0;
    const flags = submittedThisMonth.filter((sc) => sc.flag120).length;
    const recent = [...scopedScorecards]
      .sort((a, b) => (b.submittedAt || "").localeCompare(a.submittedAt || ""))
      .slice(0, 5);
    const missingScorecardsScoped = scopedEmployees.filter(
      (emp) => !submittedThisMonth.some((sc) => sc.employeeName === emp.name)
    );

    // Prioritized, deep-linked action items
    const actions: { key: string; label: string; detail: string; action: Screen; count?: number }[] = [];
    if (roleAtLeast(effectiveProfile, "admin") && !appData.rippling[workMonth]?.length)
      actions.push({ key: "rippling", label: "Upload Rippling data", detail: `${workMonthLabel} payroll hasn’t been uploaded yet`, action: "rippling" });
    if (missingActuals.length)
      actions.push({ key: "actuals", label: "Enter shared actuals", detail: `${missingActuals.length} company/department goal${missingActuals.length > 1 ? "s" : ""} awaiting actuals`, action: "setup", count: missingActuals.length });
    if (missingCurrentTargets.length)
      actions.push({ key: "targets", label: "Set this month’s targets", detail: `${missingCurrentTargets.length} goal${missingCurrentTargets.length > 1 ? "s" : ""} still need a target`, action: "todos", count: missingCurrentTargets.length });
    if (isManagerRole && expected > 0 && missingScorecardsScoped.length)
      actions.push({ key: "scorecards", label: "Submit team scorecards", detail: `${missingScorecardsScoped.length} of ${expected} not submitted for ${workMonthLabel}`, action: "scorecard", count: missingScorecardsScoped.length });

    // Review actions — scorecards waiting for this user's approval
    const pendingReviews = appData.scorecards.filter((sc) => sc.reviewStatus === "pending_review" && sc.reviewerId === effectiveProfile?.id);
    if (pendingReviews.length)
      actions.push({ key: "pending_reviews", label: "Review submitted scorecards", detail: `${pendingReviews.length} scorecard${pendingReviews.length > 1 ? "s" : ""} waiting for your approval`, action: "scorecard", count: pendingReviews.length });

    // Returned scorecards — scorecards this manager submitted that were returned
    const returnedScorecards = appData.scorecards.filter((sc) => sc.reviewStatus === "returned" && sc.submittedBy === currentUserEmail);
    if (returnedScorecards.length)
      actions.push({ key: "returned", label: "Revise returned scorecards", detail: `${returnedScorecards.length} scorecard${returnedScorecards.length > 1 ? "s" : ""} returned for revision`, action: "scorecard", count: returnedScorecards.length });

    // Personal view (user)
    const myLatest = myOwnScorecards.length ? myOwnScorecards[myOwnScorecards.length - 1] : null;
    const myPrev = myOwnScorecards.length > 1 ? myOwnScorecards[myOwnScorecards.length - 2] : null;
    const myRecent = [...myOwnScorecards].reverse().slice(0, 5);

    return {
      workMonthLabel, isManagerRole,
      expected, submittedCount, totalBonus, avgAchievement, flags, recent,
      actions,
      myLatest, myPrev, myRecent,
    };
  }, [appData.scorecards, appData.rippling, workMonth, effectiveProfile, allRipplingEmployees, missingActuals, missingCurrentTargets, myOwnScorecards]);

  async function saveGoal(goal: Goal): Promise<Goal | null> {
    let savedGoal = goal;
    if (!isFixture && sb) {
      const result = isSupabaseUuid(goal.id)
        ? await sb.from("goals_bank").upsert(goalToRow(goal), { onConflict: "id" }).select().single()
        : await sb.from("goals_bank").insert(goalToRow(goal, { includeId: false, createdBy: currentUserEmail || undefined })).select().single();
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

  async function deleteGoal(id: string, month: string) {
    const goal = appData.goals.find((g) => g.id === id);
    if (!goal) return;
    // Soft-delete: hide from this month forward while preserving past-month history
    const deleted = { ...goal, endMonth: month };
    if (!isFixture && sb) {
      const result = await sb.from("goals_bank").update({ end_month: month, updated_at: new Date().toISOString() }).eq("id", id);
      if (result.error) {
        showSupabaseError(result.error, "Goal could not be deleted.");
        return;
      }
    }
    const nextGoals = appData.goals.map((g) => g.id === id ? deleted : g);
    setAppData((current) => ({ ...current, goals: nextGoals }));
    persistGoals(nextGoals);
    showToast(`Goal removed from ${formatMonthLabel(month)} forward`);
  }

  async function toggleGoal(goal: Goal, month: string) {
    if (goalActiveForMonth(goal, month)) {
      // Deactivate from this month forward
      await saveGoal({ ...goal, endMonth: month });
    } else {
      // Reactivate — clear endMonth
      await saveGoal({ ...goal, endMonth: undefined });
    }
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
    if (!ripplingPreview.length) {
      showToast("Upload a CSV before saving", "error");
      return;
    }
    if (!isFixture && sb) {
      const deleteResult = await sb.from("rippling_employees").delete().eq("period", workMonth);
      if (deleteResult.error) {
        showSupabaseError(deleteResult.error, "Existing Rippling data could not be cleared.");
        return;
      }
      const insertResult = await sb.from("rippling_employees").insert(ripplingPreview.map((employee) => employeeToRow(workMonth, employee)));
      if (insertResult.error) {
        showSupabaseError(insertResult.error, "Rippling data could not be saved.");
        return;
      }
    }
    setAppData((current) => ({ ...current, rippling: { ...current.rippling, [workMonth]: ripplingPreview } }));
    persistRippling(workMonth, ripplingPreview);
    setRipplingPreview([]);
    showToast("Rippling data saved");
  }

  async function submitScorecardDirect(scorecard: Scorecard) {
    // Look up the submitting manager's supervisor to determine review routing
    const submittingProfile = profile; // the currently logged-in manager
    const supervisorId = submittingProfile?.supervisorId;
    const withReview: Scorecard = supervisorId
      ? { ...scorecard, reviewStatus: "pending_review", reviewerId: supervisorId }
      : scorecard;

    let savedScorecard = withReview;
    if (!isFixture && sb) {
      const result = await sb
        .from("scorecards")
        .upsert(scorecardToRow(withReview), { onConflict: "employee_name,scorecard_month" })
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
    showToast(supervisorId ? "Scorecard submitted — sent to supervisor for review" : "Scorecard submitted");
  }

  async function approveScorecard(scorecardId: string) {
    const now = new Date().toISOString();
    if (!isFixture && sb) {
      const result = await sb.from("scorecards")
        .update({ review_status: "approved", reviewed_at: now, reviewed_by: currentUserEmail })
        .eq("id", scorecardId);
      if (result.error) { showSupabaseError(result.error, "Could not approve scorecard."); return; }
    }
    setAppData((current) => ({
      ...current,
      scorecards: current.scorecards.map((sc) =>
        sc.id === scorecardId ? { ...sc, reviewStatus: "approved", reviewedAt: now, reviewedBy: currentUserEmail } : sc
      )
    }));
    showToast("Scorecard approved");
  }

  async function returnScorecard(scorecardId: string, note: string) {
    const now = new Date().toISOString();
    if (!isFixture && sb) {
      const result = await sb.from("scorecards")
        .update({ review_status: "returned", reviewed_at: now, reviewed_by: currentUserEmail, review_note: note || null })
        .eq("id", scorecardId);
      if (result.error) { showSupabaseError(result.error, "Could not return scorecard."); return; }
    }
    setAppData((current) => ({
      ...current,
      scorecards: current.scorecards.map((sc) =>
        sc.id === scorecardId ? { ...sc, reviewStatus: "returned", reviewedAt: now, reviewedBy: currentUserEmail, reviewNote: note || undefined } : sc
      )
    }));
    showToast("Scorecard returned for revision");
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

  // Non-admins see the maintenance screen when maintenance mode is on
  if (maintenanceMode && profile?.role !== "admin") {
    return <MaintenanceScreen />;
  }

  const role = effectiveProfile?.role ?? "user";
  const isAdmin = role === "admin";
  const isManager = role === "manager" || isAdmin;
  const hasLinkedEmployee = !!effectiveProfile?.linkedEmployeeName;
  const navGroups: NavGroup<Screen>[] = [
    {
      items: [
        { key: "landing", label: "Dashboard", icon: LayoutDashboard, testId: "nav-landing" },
        { key: "todos", label: "To Do", icon: ListChecks, badge: todoBadgeCount, hidden: !isManager, testId: "nav-todos" },
        { key: "personal", label: "My Scorecard", icon: Target, hidden: !hasLinkedEmployee, testId: "nav-personal" },
      ],
    },
    {
      label: "Manage",
      items: [
        { key: "setup", label: "Goals & Actuals", icon: LayoutGrid, hidden: !isManager, testId: "nav-setup" },
        { key: "scorecard", label: "Team Scorecards", icon: UsersIcon, hidden: !isManager, testId: "nav-scorecard" },
      ],
    },
    {
      label: "Review",
      items: [
        { key: "history", label: "Historical Data", icon: History, testId: "nav-history" },
        { key: "whatif", label: "What If Scorecard", icon: Sparkles, testId: "nav-whatif" },
        { key: "rippling", label: "Rippling Data", icon: ArrowDownUp, hidden: !isAdmin, testId: "nav-rippling" },
        { key: "users", label: "Users", icon: UserCog, hidden: !isAdmin, testId: "nav-users" },
      ],
    },
    {
      items: [
        { key: "guide", label: "How To Use", icon: Info, testId: "nav-guide" },
        { key: "migrate", label: "Migrate Data", icon: Upload, hidden: !isAdmin, testId: "nav-migrate" },
      ],
    },
  ];
  const userSecondary = role === "admin"
    ? "Admin · full access"
    : role === "manager"
    ? (effectiveProfile?.linkedEmployeeName
        ? `Manager · ${effectiveProfile.linkedEmployeeName}'s team`
        : `Manager · ${(effectiveProfile?.departments || []).join(", ") || "all depts"}`)
    : `Viewer · ${effectiveProfile?.linkedEmployeeName || currentUserEmail}`;
  const viewAsBanner = viewAsProfile ? (
    <div style={{ background: "#703c2e", color: "#fff", padding: "8px 20px", display: "flex", alignItems: "center", gap: "12px", fontSize: "13px", fontWeight: 500 }}>
      <span style={{ fontSize: "15px" }}>👁</span>
      <span>Viewing as <strong>{viewAsProfile.email}</strong> — {viewAsProfile.role === "admin" ? "Admin" : viewAsProfile.role === "manager" ? "Manager" : "Viewer"}{viewAsProfile.linkedEmployeeName ? ` · ${viewAsProfile.linkedEmployeeName}` : ""}</span>
      <button
        onClick={() => { setViewAsProfile(null); setMode("users"); }}
        style={{ marginLeft: "auto", background: "rgba(255,255,255,0.2)", border: "1px solid rgba(255,255,255,0.4)", color: "#fff", borderRadius: "4px", padding: "3px 12px", fontSize: "12px", fontWeight: 600, cursor: "pointer", fontFamily: "var(--sans)" }}
      >
        Exit View
      </button>
    </div>
  ) : null;

  return (
    <>
      <AppShell
        brand={{ title: "Pressed Floral", subtitle: "Scorecards" }}
        groups={navGroups}
        activeKey={mode}
        onNavigate={setMode}
        user={{ primary: currentUserEmail || "Not signed in", secondary: userSecondary }}
        onSignOut={signOut}
        pageTitle={pageLabel(mode)}
        banner={viewAsBanner}
      >
        <main>
          {mode === "landing" && <DashboardScreen data={dashboard} profile={effectiveProfile} onMode={setMode} />}
          {mode === "personal" && (
            <div className="screen active">
              <div style={{ maxWidth: "680px", margin: "0 auto", padding: "16px" }}>
                <PersonalScorecardPanel
                  scorecards={myOwnScorecards}
                  employeeName={effectiveProfile?.linkedEmployeeName || ""}
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
              teamEmployees={scopedEmployeesForProfile(latestRipplingEmployees, effectiveProfile, allRipplingEmployees)}
              onMonth={setBankMonth}
              onFilters={setBankFilters}
              onActual={saveActual}
              onEdit={setEditingGoal}
              onSave={saveGoal}
              onSaveTargetPair={(goal, target, min, period) => saveMonthTargetPair(goal, period ?? formatMonthLabel(bankMonth), target, min)}
              onDelete={(id) => deleteGoal(id, bankMonth)}
              onToggle={(goal) => toggleGoal(goal, bankMonth)}
              onToggleMonth={toggleGoalForMonth}
              isAdmin={effectiveProfile?.role === "admin"}
              allowedDepartments={effectiveProfile?.role === "admin" ? undefined : (effectiveProfile?.departments || [])}
              allowedLocations={effectiveProfile?.role === "admin" ? undefined : (effectiveProfile?.locations || [])}
            />
          )}

          {mode === "scorecard" && (
            <ScorecardsScreen
              selectedMonths={scorecardMonths}
              months={months}
              profile={effectiveProfile}
              rippling={appData.rippling}
              allEmployees={allRipplingEmployees}
              scorecards={scopedScorecardsForProfile(appData.scorecards, effectiveProfile, allRipplingEmployees)}
              allGoals={appData.goals.filter((g) => g.active)}
              allActuals={appData.actuals}
              onMonths={setScorecardMonths}
              onSubmitScorecard={submitScorecardDirect}
              onDeleteGoal={setDeleteModal}
              onApproveScorecard={approveScorecard}
              onReturnScorecard={returnScorecard}
              currentUserEmail={currentUserEmail}
              currentUserProfileId={effectiveProfile?.id}
            />
          )}
          {mode === "history" && (
            <HistoryScreen
              filters={historyFilters}
              view={historyView}
              scorecards={filteredHistory}
              allScorecards={scopedScorecardsForProfile(appData.scorecards, effectiveProfile, allRipplingEmployees)}
              readonly={effectiveProfile?.role === "user"}
              onFilters={setHistoryFilters}
              onView={setHistoryView}
            />
          )}
          {mode === "rippling" && (
            <RipplingScreen
              month={workMonth}
              preview={ripplingPreview}
              saved={appData.rippling}
              onPreview={setRipplingPreview}
              onSave={saveRippling}
              onClear={() => {
                setAppData((current) => ({ ...current, rippling: {} }));
                showToast("Rippling data cleared");
              }}
            />
          )}
          {mode === "guide" && <GuideScreen profile={effectiveProfile} />}
          {mode === "whatif" && (
            <WhatIfScreen
              allGoals={appData.goals.filter((g) => g.active)}
              profile={effectiveProfile}
              latestEmployees={latestRipplingEmployees}
              allEmployees={allRipplingEmployees}
              periodActuals={appData.actuals[formatMonthLabel(workMonth)] || {}}
              workMonth={workMonth}
            />
          )}
          {mode === "users" && (
            <UsersScreen
              users={adminUsers}
              loading={adminUsersLoading}
              employees={latestRipplingEmployees}
              fixtureMode={isFixture}
              currentUserId={profile?.id || ""}
              maintenanceMode={maintenanceMode}
              maintenanceLoading={maintenanceLoading}
              onToggleMaintenance={toggleMaintenanceMode}
              onRefresh={loadAdminUsers}
              onInvite={inviteAdminUser}
              onUpdate={updateAdminUser}
              onResendInvite={resendAdminInvite}
              onViewAs={(user) => {
                setViewAsProfile({ id: user.id, email: user.email, role: user.role, departments: user.departments, locations: user.locations, linkedEmployeeName: user.linkedEmployeeName });
                setMode("landing");
              }}
            />
          )}
          {mode === "todos" && (
            <TodosScreen
              workMonth={workMonth}
              bankMonth={bankMonth}
              profile={effectiveProfile}
              hasRippling={!!appData.rippling[workMonth]?.length}
              missingActuals={missingActuals}
              goals={appData.goals.filter((g) => g.active && (roleAtLeast(effectiveProfile, "admin") || g.goalTier !== "company") && scopedForProfile([g], effectiveProfile).length > 0)}
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
            />
          )}
          {mode === "migrate" && <MigrateScreen />}
        </main>
      </AppShell>
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
    landing: "Dashboard",
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
    <div className="flex min-h-screen w-full items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm shadow-xl">
        <CardHeader className="items-center gap-1 text-center">
          <div className="text-[20px] font-semibold tracking-tight text-primary">Pressed Floral</div>
          <div className="text-[12px] text-muted-foreground" style={{ fontFamily: "var(--mono)" }}>Scorecards</div>
        </CardHeader>
        <CardContent className="space-y-4">
          {props.fixtureMode && (
            <div className="rounded-md border border-border bg-muted/50 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
              Fixture mode signs in automatically. Reload if you were signed out.
            </div>
          )}
          {props.error && (
            <div className="rounded-md border border-[#9B2C2C]/20 bg-[#9B2C2C]/10 px-3 py-2 text-[12.5px] text-[#9B2C2C]">
              {props.error}
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="auth-email">Email</Label>
            <Input
              id="auth-email"
              type="email"
              value={props.email}
              onChange={(event) => props.onEmail(event.target.value)}
              placeholder="you@pressedfloral.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="auth-password">Password</Label>
            <Input
              id="auth-password"
              type="password"
              value={props.password}
              onChange={(event) => props.onPassword(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && props.onSignIn()}
              placeholder="••••••••"
            />
          </div>
          <Button className="w-full" onClick={props.onSignIn}>Sign in</Button>
        </CardContent>
      </Card>
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
      if (g.goalTier === "company") return false;
      const deptMatch = g.department === myEmployee.department && (!g.location || g.location === myEmployee.location);
      if (g.goalTier === "department") return deptMatch;
      // Individual goals: match by employeeName if set (new), else fall back to role match (legacy)
      if (g.employeeName) return g.employeeName === myEmployee.name;
      return deptMatch && (!g.role || !myEmployee.role || g.role === myEmployee.role);
    });
    const n = applicable.length;
    // If all goals have a stored default weight, use those; otherwise equal-distribute
    const allHaveWeight = applicable.every((g) => g.weight != null && g.weight > 0);
    const eq = n > 0 ? Number((100 / n).toFixed(2)) : 0;
    return applicable.map((g, i) => {
      const defaultWeight = allHaveWeight
        ? g.weight!
        : (i === n - 1 ? Number((100 - eq * (n - 1)).toFixed(2)) : eq);
      return {
        ...g,
        scTarget: periodActuals[metaKey("target", g)] != null ? Number(periodActuals[metaKey("target", g)]) : g.goalValue,
        scMin: periodActuals[metaKey("min", g)] != null ? Number(periodActuals[metaKey("min", g)]) : g.minValue,
        scActual: g.goalTier === "individual" ? null : (periodActuals[actualKey(g)] != null ? Number(periodActuals[actualKey(g)]) : null),
        scWeight: defaultWeight,
      };
    });
  }, [myEmployee, allGoals, periodActuals, isQuarterly]);

  const liveComputed = useMemo(() =>
    empWithEarnings && liveGoals.length > 0
      ? buildScorecard({ employee: empWithEarnings, month: currentPeriod, periodType: isQuarterly ? "quarterly" : "monthly", goals: liveGoals })
      : null,
  [empWithEarnings, liveGoals, currentPeriod, isQuarterly]);

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

  const dash = <span className="text-muted-foreground/40">—</span>;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      {/* Period navigator */}
      <div className="flex items-center gap-1 border-b border-border bg-muted/30 px-3 py-2">
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          disabled={safeIdx === 0}
          onClick={() => setIdx(safeIdx - 1)}
          aria-label="Previous period"
        >
          <ChevronLeft className="size-4" />
        </Button>
        <div className="flex-1 text-center text-[13px] font-semibold tabular-nums text-foreground">{currentPeriod}</div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          disabled={safeIdx === sortedPeriods.length - 1}
          onClick={() => setIdx(safeIdx + 1)}
          aria-label="Next period"
        >
          <ChevronRight className="size-4" />
        </Button>
        <Badge
          variant={submitted ? "secondary" : "outline"}
          className={cn(
            "ml-1.5 font-medium",
            submitted && "border-transparent bg-[#2D6B1A]/10 text-[#2D6B1A]"
          )}
        >
          {submitted ? "Submitted" : "Pending"}
        </Badge>
      </div>

      {/* Employee info */}
      {displayEmp && (
        <div className="border-b border-border px-4 py-3">
          <div className="text-[14px] font-semibold text-foreground">{displayEmp.name}</div>
          <div className="mt-0.5 text-[12px] text-muted-foreground">
            {displayEmp.role}{displayEmp.department ? ` · ${displayEmp.department}` : ""}{displayEmp.location ? ` · ${displayEmp.location}` : ""}
          </div>
        </div>
      )}

      {/* Pay & metrics strip */}
      <div className="flex flex-wrap items-start gap-x-7 gap-y-3 border-b border-border bg-muted/30 px-4 py-3">
        {displayEmp?.payType === "hourly" && displayEmp.hourlyRate ? (
          <PersonalStat label="Hourly rate" value={formatCurrency(displayEmp.hourlyRate)} />
        ) : null}
        {displayEmp?.payType === "salary" && displayEmp.annualPay ? (
          <PersonalStat label="Annual pay" value={formatCurrency(displayEmp.annualPay)} />
        ) : null}
        {displayMetrics ? (
          <>
            <PersonalStat label="Base earnings" value={formatCurrency(displayMetrics.earnings)} />
            {displayMetrics.hours ? (
              <PersonalStat label="Hours" value={(displayMetrics.hours as number).toFixed(2)} />
            ) : null}
            <PersonalStat
              label="Achievement"
              value={`${displayMetrics.achievement.toFixed(1)}%${displayMetrics.capped ? " cap" : ""}`}
              valueClassName={displayMetrics.achievement >= 100 ? "text-[#2D6B1A]" : "text-primary"}
            />
            <PersonalStat label="Bonus" value={formatCurrency(displayMetrics.bonus)} valueClassName="text-primary" />
          </>
        ) : (
          <div className="self-center text-[12px] text-muted-foreground">Earnings not available for this period yet.</div>
        )}
      </div>

      {/* Goals table */}
      {displayGoals.length > 0 ? (
        <Table className="text-[12px]">
          <TableHeader className="bg-muted/40 [&_th]:h-9 [&_th]:px-2.5 [&_th]:text-[10px] [&_th]:font-medium [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted-foreground">
            <TableRow className="hover:bg-transparent">
              <TableHead>Type</TableHead>
              <TableHead>Goal</TableHead>
              <TableHead className="text-right">Target</TableHead>
              <TableHead className="text-right">Min</TableHead>
              <TableHead className="text-right">Actual</TableHead>
              <TableHead className="text-right">Weight</TableHead>
              <TableHead className="text-right">Achieve</TableHead>
              <TableHead className="text-right">Bonus</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="[&_td]:px-2.5 [&_td]:py-1.5">
            {displayGoals.map((g) => (
              <TableRow key={g.id}>
                <TableCell><TierBadge tier={g.goalTier} /></TableCell>
                <TableCell className="font-medium text-foreground">
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    {g.name}
                    <GoalScopeTags location={g.location} department={g.department} />
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">{g.target != null ? formatNumber(g.target) : dash}</TableCell>
                <TableCell className="text-right tabular-nums">{g.min != null ? formatNumber(g.min) : dash}</TableCell>
                <TableCell className="text-right tabular-nums">{g.actual != null ? formatNumber(g.actual) : dash}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{g.weight.toFixed(1)}%</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">
                  {g.achievement != null && g.actual != null
                    ? (g.metMin
                        ? <span className={g.achievement >= 100 ? "text-[#2D6B1A]" : "text-primary"}>{g.achievement.toFixed(1)}%</span>
                        : <span className="text-[#9B2C2C]">Below min</span>)
                    : dash}
                </TableCell>
                <TableCell className="text-right tabular-nums">{g.bonusContribution != null ? formatCurrency(g.bonusContribution) : dash}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <div className="px-4 py-6 text-center text-[12.5px] text-muted-foreground">
          No goals assigned for this period yet.
        </div>
      )}
    </div>
  );
}

function PersonalStat({ label, value, valueClassName }: { label: string; value: string; valueClassName?: string }) {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 text-[13px] font-semibold tabular-nums text-foreground", valueClassName)}>{value}</div>
    </div>
  );
}


function MaintenanceScreen() {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background p-6">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-6 flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
          <Wrench className="size-6" />
        </div>
        <h1 className="text-[20px] font-semibold tracking-tight text-foreground">Down for maintenance</h1>
        <p className="mx-auto mt-2 max-w-xs text-[13.5px] leading-relaxed text-muted-foreground">
          We&rsquo;re making some updates. The app will be back shortly.
        </p>
        <div className="mt-8 text-[12px] text-muted-foreground/70" style={{ fontFamily: "var(--mono)" }}>
          Pressed Floral Scorecards
        </div>
      </div>
    </div>
  );
}

type DashboardData = {
  workMonthLabel: string;
  isManagerRole: boolean;
  expected: number;
  submittedCount: number;
  totalBonus: number;
  avgAchievement: number;
  flags: number;
  recent: Scorecard[];
  actions: { key: string; label: string; detail: string; action: Screen; count?: number }[];
  myLatest: Scorecard | null;
  myPrev: Scorecard | null;
  myRecent: Scorecard[];
};

const DASH_ACTION_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  rippling: ArrowDownUp,
  actuals: LayoutGrid,
  targets: ListChecks,
  scorecards: UsersIcon,
};

function dashInitials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?"
  );
}

function KpiTile({ label, value, sub, accent, onClick, children }: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  accent?: boolean;
  onClick?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <Card
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onClick(); } } : undefined}
      className={`flex flex-col p-4 transition-colors ${onClick ? "cursor-pointer hover:border-primary/40" : ""} ${accent ? "border-primary/40" : ""}`}
    >
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="mt-1.5 text-[24px] font-semibold leading-none tracking-tight text-foreground">{value}</span>
      {sub != null ? <span className="mt-1.5 text-[11.5px] text-muted-foreground">{sub}</span> : null}
      {children}
    </Card>
  );
}

function RecentScorecards({ title, items, onMode, emptyText, hideName }: {
  title: string;
  items: Scorecard[];
  onMode: (mode: Screen) => void;
  emptyText: string;
  hideName?: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between pb-3">
        <CardTitle className="text-[11px] uppercase tracking-wider text-primary">{title}</CardTitle>
        <button onClick={() => onMode("history")} className="text-[12px] font-medium text-primary transition-colors hover:underline">View all</button>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{emptyText}</p>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((sc) => {
              const goalsMet = sc.goals.filter((goal) => goal.metMin).length;
              return (
                <li key={sc.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                  {!hideName && (
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-[11px] font-semibold text-foreground">{dashInitials(sc.employeeName)}</span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium text-foreground">{hideName ? sc.scorecardMonth : sc.employeeName}</span>
                    <span className="block truncate text-[12px] text-muted-foreground">{hideName ? `${goalsMet}/${sc.goals.length} goals met` : `${sc.scorecardMonth} · ${sc.role}`}</span>
                  </span>
                  {sc.flag120 && (
                    <Badge variant="accent" className="hidden sm:inline-flex">
                      <AlertTriangle />120%+
                    </Badge>
                  )}
                  <span className="text-right">
                    <span className="block text-[13.5px] font-semibold text-foreground">{formatCurrency(sc.bonusAmount)}</span>
                    <span className="block text-[11px] text-muted-foreground">{Math.round(sc.weightedAchievement)}% achieved</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ManagerDashboard({ data, onMode }: { data: DashboardData; onMode: (mode: Screen) => void }) {
  const submittedPct = data.expected > 0 ? Math.round((data.submittedCount / data.expected) * 100) : 0;
  return (
    <>
      {/* Action center */}
      <Card>
        <CardHeader className="flex-row items-center gap-2 pb-3">
          <CardTitle className="text-[11px] uppercase tracking-wider text-primary">Needs your attention</CardTitle>
          {data.actions.length > 0 && <Badge>{data.actions.length}</Badge>}
        </CardHeader>
        <CardContent>
          {data.actions.length === 0 ? (
            <div className="flex items-center gap-2.5 text-[14px] text-foreground">
              <CheckCircle2 className="size-5 text-[var(--sage-dark)]" />
              You’re all caught up for {data.workMonthLabel}.
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {data.actions.map((action) => {
                const Icon = DASH_ACTION_ICONS[action.key] || ListChecks;
                return (
                  <li key={action.key}>
                    <button onClick={() => onMode(action.action)} className="group flex w-full items-center gap-3 rounded-md border border-border bg-background px-3.5 py-3 text-left transition-colors hover:border-primary/30 hover:bg-accent">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
                        <Icon className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13.5px] font-medium text-foreground">{action.label}</span>
                        <span className="block truncate text-[12px] text-muted-foreground">{action.detail}</span>
                      </span>
                      {action.count ? <Badge variant="secondary">{action.count}</Badge> : null}
                      <ChevronRight className="size-4 shrink-0 text-[var(--text-faint)] transition-colors group-hover:text-primary" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiTile label="Submitted" value={`${data.submittedCount}/${data.expected || 0}`} sub={`${data.workMonthLabel} scorecards`}>
          <Progress value={submittedPct} className="mt-2.5" />
        </KpiTile>
        <KpiTile label="Total bonus" value={formatCurrency(data.totalBonus)} sub={data.workMonthLabel} />
        <KpiTile label="Avg achievement" value={`${Math.round(data.avgAchievement)}%`} sub="weighted, submitted" />
        <KpiTile label="Flags to review" value={data.flags} sub="over 120% achieved" accent={data.flags > 0} onClick={() => onMode("history")} />
      </div>

      <RecentScorecards title="Recent scorecards" items={data.recent} onMode={onMode} emptyText="No scorecards submitted yet." />
    </>
  );
}

function PersonalDashboard({ data, onMode }: { data: DashboardData; onMode: (mode: Screen) => void }) {
  const latest = data.myLatest;
  if (!latest) {
    return (
      <Card className="p-8 text-center">
        <FileText className="mx-auto size-7 text-[var(--text-faint)]" />
        <p className="mt-3 text-[14px] font-medium text-foreground">No scorecard yet</p>
        <p className="mt-1 text-[12.5px] text-muted-foreground">Your scorecard will show up here once it’s submitted for the month.</p>
      </Card>
    );
  }
  const goalsMet = latest.goals.filter((goal) => goal.metMin).length;
  const achievementDelta = data.myPrev ? latest.weightedAchievement - data.myPrev.weightedAchievement : null;
  return (
    <>
      {/* Hero: latest scorecard */}
      <Card className="overflow-hidden border-transparent bg-[var(--forest)] p-6 text-white">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <span className="text-[11px] font-medium uppercase tracking-wider text-white/60">{latest.scorecardMonth} bonus</span>
            <div className="mt-1 text-[34px] font-semibold leading-none tracking-tight">{formatCurrency(latest.bonusAmount)}</div>
            <div className="mt-2 text-[12.5px] text-white/70">{Math.round(latest.weightedAchievement)}% weighted achievement · {goalsMet}/{latest.goals.length} goals met</div>
          </div>
          <button onClick={() => onMode("personal")} className="flex shrink-0 items-center gap-1.5 rounded-md bg-white/15 px-3 py-2 text-[12.5px] font-medium text-white transition-colors hover:bg-white/25">
            View full scorecard <ChevronRight className="size-4" />
          </button>
        </div>
      </Card>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <KpiTile label="Latest bonus" value={formatCurrency(latest.bonusAmount)} sub={latest.scorecardMonth} />
        <KpiTile
          label="Achievement"
          value={`${Math.round(latest.weightedAchievement)}%`}
          sub={achievementDelta == null ? "this period" : (
            <span className={`inline-flex items-center gap-0.5 ${achievementDelta >= 0 ? "text-[var(--sage-dark)]" : "text-primary"}`}>
              {achievementDelta >= 0 ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
              {Math.abs(Math.round(achievementDelta))}% vs last
            </span>
          )}
        />
        <KpiTile label="Goals met" value={`${goalsMet}/${latest.goals.length}`} sub="hit the minimum" />
      </div>

      <RecentScorecards title="Your scorecard history" items={data.myRecent} onMode={onMode} emptyText="No past scorecards yet." hideName />
    </>
  );
}

function DashboardScreen({ data, profile, onMode }: {
  data: DashboardData;
  profile: ManagerProfile | null;
  onMode: (mode: Screen) => void;
}) {
  const isUser = profile?.role === "user";
  const displayName = profile?.linkedEmployeeName || profile?.email?.split("@")[0] || "there";
  const todayLabel = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  return (
    <div className="screen active">
      <div className="flex flex-col gap-5">
        <div>
          <h2 className="text-[22px] font-semibold tracking-tight text-foreground">
            {isUser ? `Welcome, ${displayName}` : `Welcome back, ${displayName}`}
          </h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {todayLabel} ·{" "}
            {isUser ? (
              "Here’s your latest scorecard"
            ) : (
              <>Working on <span className="font-medium text-foreground">{data.workMonthLabel}</span> scorecards</>
            )}
          </p>
        </div>

        {isUser ? <PersonalDashboard data={data} onMode={onMode} /> : <ManagerDashboard data={data} onMode={onMode} />}

        <button onClick={() => onMode("guide")} className="flex items-center gap-2 self-start text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-primary">
          <Info className="size-4" /> New here? Read the How-To guide
        </button>
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
  maintenanceMode: boolean;
  maintenanceLoading: boolean;
  onToggleMaintenance: (enabled: boolean) => void;
  onRefresh: () => void;
  onInvite: (payload: AdminUserPayload) => Promise<boolean>;
  onUpdate: (payload: AdminUserPayload) => Promise<boolean>;
  onResendInvite: (user: AdminManagedUser) => void;
  onViewAs: (user: AdminManagedUser) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const sortedUsers = [...props.users].sort((a, b) => a.email.localeCompare(b.email));
  const editingUser = editingId ? sortedUsers.find((u) => u.id === editingId) : undefined;

  return (
    <div className="screen active">
      {props.fixtureMode && (
        <div className="mb-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-[12px] text-muted-foreground">
          Fixture mode simulates invites and permission updates locally.
        </div>
      )}

      <section>
        <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-primary">Maintenance mode</div>
        <div className={`flex items-center gap-4 rounded-lg border p-4 transition-colors ${props.maintenanceMode ? "border-destructive/40 bg-destructive/5" : "border-border bg-muted/30"}`}>
          <span className={`size-2.5 shrink-0 rounded-full ${props.maintenanceMode ? "bg-destructive" : "bg-[var(--sage-dark)]"}`} />
          <div className="flex-1">
            <div className="text-[14px] font-semibold text-foreground">{props.maintenanceMode ? "Maintenance mode is on" : "App is live"}</div>
            <div className="mt-0.5 text-[12px] text-muted-foreground">
              {props.maintenanceMode
                ? "All non-admin users see a maintenance page. Admins can still access the app normally."
                : "All users can access the app. Turn this on before making changes that could break things mid-session."}
            </div>
          </div>
          <Switch checked={props.maintenanceMode} onCheckedChange={(c) => props.onToggleMaintenance(c)} disabled={props.maintenanceLoading} aria-label="Toggle maintenance mode" />
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-primary">Invite user</div>
          <Button variant="outline" size="sm" className="text-[12px]" disabled={props.loading} onClick={props.onRefresh}>{props.loading ? "Refreshing…" : "Refresh"}</Button>
        </div>
        <UserPermissionForm
          mode="invite"
          employees={props.employees}
          submitLabel="Send invite"
          onSubmit={props.onInvite}
        />
      </section>

      <section style={{ padding: 0 }} className="overflow-hidden">
        <div className="px-4 pb-2.5 pt-4 text-[11px] font-semibold uppercase tracking-wider text-primary">Current users</div>
        <Table className="text-[12.5px]">
          <TableHeader className="bg-muted/40 [&_th]:h-9 [&_th]:px-4 [&_th]:text-[10px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted-foreground">
            <TableRow className="hover:bg-transparent">
              <TableHead>Email</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Last activity</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody className="[&_td]:px-4 [&_td]:py-3">
            {!sortedUsers.length && (
              <TableRow><TableCell colSpan={6} className="py-6 text-center text-muted-foreground">{props.loading ? "Loading users…" : "No users found."}</TableCell></TableRow>
            )}
            {sortedUsers.map((user) => (
              <React.Fragment key={user.id}>
                <TableRow>
                  <TableCell>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-foreground">{user.email}</span>
                      {user.id === props.currentUserId && <Badge variant="secondary" className="font-medium">You</Badge>}
                      {!user.hasProfile && <Badge variant="outline" className="font-medium text-[#9B2C2C]">No profile</Badge>}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={user.status === "active" ? "success" : user.status === "invited" ? "secondary" : "outline"} className="font-medium">
                      {user.status === "active" ? "Active" : user.status === "invited" ? "Invited" : "Unconfirmed"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{roleLabel(user.role)}</TableCell>
                  <TableCell className="max-w-[200px] truncate text-muted-foreground">{scopeSummary(user)}</TableCell>
                  <TableCell className="whitespace-nowrap text-[11.5px] text-muted-foreground">
                    {user.lastSignInAt
                      ? <>Last sign in<br />{formatTimestamp(user.lastSignInAt)}</>
                      : user.invitedAt
                      ? <>Invited<br />{formatTimestamp(user.invitedAt)}</>
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger aria-label="User actions" className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:bg-accent data-[state=open]:text-foreground">
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuItem onSelect={() => props.onViewAs(user)}>View as user</DropdownMenuItem>
                        <DropdownMenuItem disabled={resendingId === user.id} onSelect={async () => { setResendingId(user.id); await props.onResendInvite(user); setResendingId(null); }}>
                          {resendingId === user.id ? "Sending…" : "Resend invite"}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setEditingId(user.id)}>Edit user</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              </React.Fragment>
            ))}
          </TableBody>
        </Table>
      </section>

      <Sheet open={!!editingUser} onOpenChange={(o) => { if (!o) setEditingId(null); }}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
          <SheetHeader>
            <div className="flex items-start justify-between gap-3">
              <div className="grid gap-1">
                <SheetTitle>Edit user</SheetTitle>
                <SheetDescription>{editingUser?.email}</SheetDescription>
              </div>
              <SheetClose className="-mr-1 -mt-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
                <X className="size-4" />
                <span className="sr-only">Close</span>
              </SheetClose>
            </div>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto p-5">
            {editingUser && (
              <UserPermissionForm
                key={editingUser.id}
                mode="edit"
                user={editingUser}
                employees={props.employees}
                allUsers={props.users}
                submitLabel="Save changes"
                onCancel={() => setEditingId(null)}
                onSubmit={async (payload) => {
                  const saved = await props.onUpdate(payload);
                  if (saved) setEditingId(null);
                  return saved;
                }}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function UserPermissionForm(props: {
  mode: "invite" | "edit";
  user?: AdminManagedUser;
  employees: Employee[];
  allUsers?: AdminManagedUser[];
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
      departments: role === "manager" ? (current.allDepartments ? [...departments] : current.departments) : [],
      locations: role === "manager" ? (current.allLocations ? [...locations] : current.locations) : [],
      linkedEmployeeName: role === "admin" ? "" : current.linkedEmployeeName,
      allDepartments: role === "manager" ? current.allDepartments : true,
      allLocations: role === "manager" ? current.allLocations : true
    }));
  }

  async function handleSubmit() {
    const isManager = draft.role === "manager";
    // "Select all" (every option chosen) maps back to the all-access wire format (empty array + allX flag).
    const allDepts = isManager && departments.length > 0 && draft.departments.length === departments.length;
    const allLocs = isManager && locations.length > 0 && draft.locations.length === locations.length;
    const saved = await props.onSubmit({
      id: draft.id,
      email: draft.email,
      role: draft.role,
      departments: isManager ? (allDepts ? [] : draft.departments) : [],
      locations: isManager ? (allLocs ? [] : draft.locations) : [],
      linkedEmployeeName: draft.linkedEmployeeName || undefined,
      supervisorId: (draft as AdminUserPayload & { supervisorId?: string }).supervisorId || undefined,
      allDepartments: !isManager || allDepts,
      allLocations: !isManager || allLocs
    });
    if (saved && props.mode === "invite") setDraft(userDraftFromUser());
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        {props.mode === "invite" && (
          <DrawerField label="Email" htmlFor="user-email" className="min-w-[14rem] flex-1">
            <Input id="user-email" aria-label="Invite email" type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} placeholder="name@pressedfloral.com" />
          </DrawerField>
        )}
        <DrawerField label="Role" className="w-[160px]">
          <Select value={draft.role} onValueChange={(v) => setRole(v as ProfileRole)}>
            <SelectTrigger className="w-full" aria-label="User role"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="manager">Manager</SelectItem>
              <SelectItem value="user">User</SelectItem>
              <SelectItem value="admin">Admin</SelectItem>
            </SelectContent>
          </Select>
        </DrawerField>
      </div>

      {draft.role === "manager" && (
        <div className="flex flex-wrap items-end gap-3">
          <DrawerField label="Departments" className="min-w-[12rem] flex-1">
            <MultiSelectDropdown label="All departments" emptyLabel="No departments" triggerClassName="w-full" options={departmentOptions} selected={draft.departments} onChange={(values) => setDraft({ ...draft, departments: values })} />
          </DrawerField>
          <DrawerField label="Locations" className="min-w-[12rem] flex-1">
            <MultiSelectDropdown label="All locations" emptyLabel="No locations" triggerClassName="w-full" options={locationOptions} selected={draft.locations} onChange={(values) => setDraft({ ...draft, locations: values })} />
          </DrawerField>
          <DrawerField label="Reporting tree root" className="min-w-[12rem] flex-1">
            <Select value={draft.linkedEmployeeName || ALL_LOCATIONS} onValueChange={(v) => setDraft({ ...draft, linkedEmployeeName: v === ALL_LOCATIONS ? "" : v })}>
              <SelectTrigger className="w-full" aria-label="Reporting tree root"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_LOCATIONS}>No linked employee</SelectItem>
                {employeeNames.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
              </SelectContent>
            </Select>
          </DrawerField>
          <DrawerField label="Supervisor" className="min-w-[12rem] flex-1">
            <Select
              value={(draft as AdminUserPayload & { supervisorId?: string }).supervisorId || "__none__"}
              onValueChange={(v) => setDraft({ ...draft, supervisorId: v === "__none__" ? "" : v } as typeof draft)}
            >
              <SelectTrigger className="w-full" aria-label="Supervisor"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No supervisor</SelectItem>
                {(props.allUsers || []).filter((u) => u.id !== draft.id && (u.role === "manager" || u.role === "admin")).map((u) => (
                  <SelectItem key={u.id} value={u.id}>{u.email}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </DrawerField>
        </div>
      )}

      {draft.role === "user" && (
        <div className="flex flex-wrap items-end gap-3">
          <DrawerField label="Linked employee" className="min-w-[12rem] flex-1">
            <Select value={draft.linkedEmployeeName || undefined} onValueChange={(v) => setDraft({ ...draft, linkedEmployeeName: v })}>
              <SelectTrigger className="w-full" aria-label="Linked employee"><SelectValue placeholder="Choose employee" /></SelectTrigger>
              <SelectContent>
                {employeeNames.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
              </SelectContent>
            </Select>
          </DrawerField>
        </div>
      )}

      <div className="flex items-center gap-2">
        {props.onCancel && <Button variant="outline" size="sm" onClick={props.onCancel}>Cancel</Button>}
        <Button size="sm" onClick={handleSubmit}>{props.submitLabel}</Button>
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
  const isManager = user.role === "manager";
  const allDepts = !isManager || user.departments.length === 0;
  const allLocs = !isManager || user.locations.length === 0;
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    // Expand "all access" (empty array) to every option selected so the multi-select shows it.
    departments: isManager ? (allDepts ? [...departments] : user.departments) : [],
    locations: isManager ? (allLocs ? [...locations] : user.locations) : [],
    linkedEmployeeName: user.linkedEmployeeName || "",
    supervisorId: user.supervisorId || "",
    allDepartments: allDepts,
    allLocations: allLocs
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

// Radix Select forbids empty-string item values, so the "all" filter option uses a sentinel.
const ALL_LOCATIONS = "__all__";

function GoalsScreen(props: {
  month: string;
  months: string[];
  filters: { types: string[]; location: string; departments: string[]; sort: string; showInactive: boolean };
  goals: Goal[];
  actuals: ActualsByKey;
  allActuals: Record<string, ActualsByKey>;
  editingGoal: Goal | null;
  teamEmployees?: Employee[];
  readonly?: boolean;
  onMonth: (value: string) => void;
  onFilters: (value: { types: string[]; location: string; departments: string[]; sort: string; showInactive: boolean }) => void;
  onActual: (goal: Goal, value: string, period?: string) => void;
  onEdit: (goal: Goal | null) => void;
  onSave: (goal: Goal) => Goal | null | void | Promise<Goal | null | void>;
  onSaveTargetPair: (goal: Goal, target: string, min: string, period?: string) => void;
  onDelete: (id: string) => void;
  onToggle: (goal: Goal) => void;
  onToggleMonth: (goal: Goal) => void;
  isAdmin?: boolean;
  allowedDepartments?: string[];
  allowedLocations?: string[];
}) {
  const [actualEditId, setActualEditId] = useState<string | null>(null);
  const [periodTab, setPeriodTab] = useState<"monthly" | "quarterly">("monthly");

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

  const renderGoalRow = (goal: Goal) => {
    const a = goal.periodType === "quarterly" ? quarterActuals : props.actuals;
    const isQuarterly = goal.periodType === "quarterly";
    const activeInMonth = goalActiveForMonth(goal, props.month);
    const on = goal.active && activeInMonth && !isMonthlyInactive(goal);
    const dimmed = !goal.active || !activeInMonth || isMonthlyInactive(goal);
    const canEdit = !effectiveReadonly && (props.isAdmin || goal.goalTier !== "company");
    const canActual = !actualsReadonly && (props.isAdmin || goal.goalTier !== "company");
    const hasTargets = goalHasTargets(goal);
    const targetVal = a[metaKey("target", goal)];
    const minVal = a[metaKey("min", goal)];
    const actualVal = a[actualKey(goal)];
    const dash = <span className="text-[var(--text-faint)]">—</span>;
    return (
      <React.Fragment key={goal.id}>
        <TableRow className={dimmed ? "opacity-50" : undefined}>
          <TableCell><TierBadge tier={goal.goalTier} /></TableCell>
          <TableCell className="text-muted-foreground">{locLabel(goal.location)}</TableCell>
          <TableCell className="truncate text-muted-foreground">{goal.department || "—"}</TableCell>
          <TableCell className="overflow-hidden font-medium text-foreground">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate" title={goal.name}>{goal.name}</span>
              {goal.goalTier === "individual" && (goal.employeeName || goal.role) ? (
                <Badge variant="secondary" className="shrink-0 font-normal">{goal.employeeName || goal.role}</Badge>
              ) : null}
            </span>
          </TableCell>
          <TableCell className="text-muted-foreground">{goal.lowerBetter ? "Yes" : "No"}</TableCell>
          <TableCell className="text-muted-foreground">{cappedLabel(goal)}</TableCell>
          <TableCell className="text-right tabular-nums">{targetVal != null ? formatNumber(targetVal as number) : dash}</TableCell>
          <TableCell className="text-right tabular-nums">{minVal != null ? formatNumber(minVal as number) : dash}</TableCell>
          <TableCell className="text-right tabular-nums" onClick={(e) => e.stopPropagation()}>
            {canActual && hasTargets && actualEditId === goal.id ? (
              <Input
                autoFocus
                aria-label={`Actual for ${goal.name}`}
                type="number"
                className="h-7 w-full text-right text-[12.5px] tabular-nums"
                defaultValue={actualVal ?? ""}
                onBlur={(e) => { const period = isQuarterly ? quarterKey : undefined; props.onActual(goal, e.target.value, period); setActualEditId(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setActualEditId(null); }}
              />
            ) : (
              <span title={!hasTargets ? "Set a target and minimum first" : undefined} className={canActual && !hasTargets ? "text-[11px] text-[var(--text-faint)]" : undefined}>
                {actualVal != null ? formatNumber(actualVal as number) : (canActual && !hasTargets ? "no target" : dash)}
              </span>
            )}
          </TableCell>
          <TableCell>
            <Badge variant={on ? "success" : "secondary"} className="font-medium">{on ? "Active" : "Inactive"}</Badge>
          </TableCell>
          <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
            {canEdit ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label="Goal actions"
                  className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:bg-accent data-[state=open]:text-foreground"
                >
                  <MoreHorizontal className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuItem onClick={() => props.onEdit(goal)}>Edit goal</DropdownMenuItem>
                  {canActual && hasTargets ? (
                    <DropdownMenuItem onClick={() => setActualEditId(goal.id)}>Enter actual</DropdownMenuItem>
                  ) : canActual ? (
                    <DropdownMenuItem disabled>Set target first</DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem onClick={() => props.onToggle(goal)}>
                    {activeInMonth ? "Deactivate goal" : "Reactivate goal"}
                  </DropdownMenuItem>
                  {activeInMonth && (
                    <DropdownMenuItem onClick={() => props.onToggleMonth(goal)}>
                      {isMonthlyInactive(goal) ? "Include this month" : "Skip this month only"}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => props.onDelete(goal.id)}>Delete from this month forward</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </TableCell>
        </TableRow>
      </React.Fragment>
    );
  };

  // ── Month/quarter navigation helpers ──────────────────────────────────────
  const curVal = now.getFullYear() * 12 + now.getMonth();
  const minVal = curVal - 12;
  const maxVal = curVal + 3;

  const monthVal = (() => {
    const [y, m] = props.month.split("-").map(Number);
    return y * 12 + (m - 1);
  })();

  function shiftMonth(delta: number) {
    const [y, m] = props.month.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    props.onMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }

  function shiftQuarter(delta: number) {
    const curQ = quarterKeyForMonth(props.month);
    const iso = quarterToIsoMonth(curQ);
    const [y, m] = iso.split("-").map(Number);
    const d = new Date(y, m - 1 + delta * 3, 1);
    props.onMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }

  const canGoPrev = periodTab === "monthly" ? monthVal > minVal : true;
  const canGoNext = periodTab === "monthly" ? monthVal < maxVal : true;

  const displayLabel = periodTab === "quarterly"
    ? quarterKeyForMonth(props.month)
    : formatMonthLabel(props.month);

  return (
    <div className="screen active" onClick={() => setActualEditId(null)}>
      {/* ── Month navigation hero ── */}
      <section style={{ padding: 0, borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", padding: "18px 20px 14px", gap: "12px" }}>
          {/* Monthly / Quarterly toggle */}
          <Tabs value={periodTab} onValueChange={(v) => setPeriodTab(v as "monthly" | "quarterly")}>
            <TabsList className="h-8">
              <TabsTrigger value="monthly" className="px-3 text-[12px] data-[state=active]:bg-card data-[state=active]:text-foreground">Monthly</TabsTrigger>
              <TabsTrigger value="quarterly" className="px-3 text-[12px] data-[state=active]:bg-card data-[state=active]:text-foreground">Quarterly</TabsTrigger>
            </TabsList>
          </Tabs>

          {/* Centered arrow navigator */}
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: "16px" }}>
            <button
              onClick={() => periodTab === "monthly" ? shiftMonth(-1) : shiftQuarter(-1)}
              disabled={!canGoPrev}
              style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "32px", height: "32px", border: "1px solid var(--border)", borderRadius: "6px", background: "none", cursor: canGoPrev ? "pointer" : "not-allowed", opacity: canGoPrev ? 1 : 0.3, color: "var(--text-primary)", transition: "background 0.15s" }}
              onMouseEnter={(e) => { if (canGoPrev) (e.currentTarget as HTMLElement).style.background = "var(--hover)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "none"; }}
            >
              <ChevronLeft className="size-4" />
            </button>

            <span style={{ fontSize: "22px", fontWeight: 700, minWidth: "180px", textAlign: "center", letterSpacing: "-0.4px", fontFamily: "var(--sans)" }}>
              {displayLabel}
            </span>

            <button
              onClick={() => periodTab === "monthly" ? shiftMonth(1) : shiftQuarter(1)}
              disabled={!canGoNext}
              style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "32px", height: "32px", border: "1px solid var(--border)", borderRadius: "6px", background: "none", cursor: canGoNext ? "pointer" : "not-allowed", opacity: canGoNext ? 1 : 0.3, color: "var(--text-primary)", transition: "background 0.15s" }}
              onMouseEnter={(e) => { if (canGoNext) (e.currentTarget as HTMLElement).style.background = "var(--hover)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "none"; }}
            >
              <ChevronRight className="size-4" />
            </button>
          </div>

          {/* Right spacer to balance tabs */}
          <div style={{ width: "120px" }} />
        </div>

        {monthStatus && periodTab === "monthly" && (
          <div className="border-t border-border bg-muted/30 px-5 py-1.5 text-[11.5px] text-muted-foreground">{monthStatus}</div>
        )}
      </section>

      {/* ── Filter bar ── */}
      <section style={{ padding: 0, borderBottom: "1px solid var(--border)" }}>
        <div className="flex flex-wrap items-center gap-2 px-4 py-2">
          <MultiSelectDropdown
            label="All types"
            triggerClassName="w-auto min-w-[7rem]"
            options={[
              ...(props.isAdmin ? [{ value: "company", label: "Company" }] : []),
              { value: "department", label: "Department" },
              { value: "individual", label: "Individual" }
            ]}
            selected={props.filters.types.filter((t) => props.isAdmin || t !== "company")}
            onChange={(types) => props.onFilters({ ...props.filters, types: props.isAdmin ? types : types.filter((t) => t !== "company") })}
          />
          <Select value={props.filters.location || ALL_LOCATIONS} onValueChange={(v) => props.onFilters({ ...props.filters, location: v === ALL_LOCATIONS ? "" : v })}>
            <SelectTrigger size="sm" className="min-w-[8rem] text-[12px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_LOCATIONS}>All locations</SelectItem>
              <SelectItem value="Utah">Utah</SelectItem>
              <SelectItem value="Georgia">Georgia</SelectItem>
              <SelectItem value="Remote">Remote</SelectItem>
            </SelectContent>
          </Select>
          <MultiSelectDropdown
            label="All departments"
            triggerClassName="w-auto min-w-[8rem]"
            options={departments.map((d) => ({ value: d, label: d }))}
            selected={props.filters.departments}
            onChange={(depts) => props.onFilters({ ...props.filters, departments: depts })}
          />
          <Select value={props.filters.sort} onValueChange={(v) => props.onFilters({ ...props.filters, sort: v })}>
            <SelectTrigger size="sm" className="min-w-[8rem] text-[12px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="goalTier">Sort: Type</SelectItem>
              <SelectItem value="department">Sort: Dept</SelectItem>
              <SelectItem value="location">Sort: Location</SelectItem>
              <SelectItem value="name">Sort: Name</SelectItem>
            </SelectContent>
          </Select>
          <div className="ml-auto flex items-center gap-3 pl-1">
            <div className="flex items-center gap-2 whitespace-nowrap">
              <Checkbox id="goal-show-inactive" checked={props.filters.showInactive} onCheckedChange={(c) => props.onFilters({ ...props.filters, showInactive: c === true })} />
              <Label htmlFor="goal-show-inactive" className="cursor-pointer text-[12px] font-normal text-muted-foreground">Show inactive</Label>
            </div>
            <Button variant="ghost" size="sm" className="text-[12px] font-normal text-muted-foreground" onClick={() => props.onFilters({ types: props.isAdmin ? ["company", "department", "individual"] : ["department", "individual"], location: "", departments: [...departments], sort: "goalTier", showInactive: false })}>Reset</Button>
          </div>
        </div>
      </section>
      <section style={{ padding: 0 }} className="overflow-hidden">
        <Table className="table-fixed text-[12.5px]">
          <colgroup>
            <col style={{ width: "44px" }} />
            <col style={{ width: "38px" }} />
            <col style={{ width: "68px" }} />
            <col />
            <col style={{ width: "42px" }} />
            <col style={{ width: "68px" }} />
            <col style={{ width: "52px" }} />
            <col style={{ width: "46px" }} />
            <col style={{ width: "72px" }} />
            <col style={{ width: "66px" }} />
            <col style={{ width: "46px" }} />
          </colgroup>
          <TableHeader className="bg-muted/40 [&_th]:h-9 [&_th]:px-2 [&_th]:text-[10px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
            <TableRow className="hover:bg-transparent">
              <TableHead>Type</TableHead>
              <TableHead>Loc</TableHead>
              <TableHead>Dept</TableHead>
              <TableHead>Goal</TableHead>
              <TableHead>Lower</TableHead>
              <TableHead>Cap</TableHead>
              <TableHead className="text-right">Target</TableHead>
              <TableHead className="text-right">Min</TableHead>
              <TableHead className="text-right">Actual</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody className="[&_td]:px-2 [&_td]:py-2">
            {(periodTab === "monthly" ? monthlyGoals : quarterlyGoals).map(renderGoalRow)}
          </TableBody>
        </Table>
        {(periodTab === "monthly" ? monthlyGoals : quarterlyGoals).length === 0 && <div className="no-goals-msg" style={{ display: "block" }}>No {periodTab} goals match the current filter</div>}
        {!effectiveReadonly && props.month >= currentMonthVal && (
          <div style={{ padding: "12px 16px" }}>
            <button className="add-goal-btn" onClick={() => props.onEdit({ ...emptyGoal, id: `goal-${Date.now()}`, periodType: periodTab, startMonth: props.month })}>+ Add {periodTab === "quarterly" ? "Quarterly" : "Monthly"} Goal to Bank</button>
          </div>
        )}
      </section>

      <Sheet open={!!props.editingGoal} onOpenChange={(open) => { if (!open) props.onEdit(null); }}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
          {props.editingGoal ? (
            <GoalEditor
              key={props.editingGoal.id}
              goal={props.editingGoal}
              actuals={mergedActuals}
              isAdmin={props.isAdmin}
              allowedDepartments={props.allowedDepartments}
              allowedLocations={props.allowedLocations}
              teamEmployees={props.teamEmployees}
              onCancel={() => props.onEdit(null)}
              onSave={props.onSave}
              onSaveTargetPair={handleSaveTargetPair}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function MultiSelectDropdown({ label, options, selected, onChange, emptyLabel, triggerClassName }: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (values: string[]) => void;
  emptyLabel?: string;
  triggerClassName?: string;
}) {
  const allChecked = selected.length === options.length && options.length > 0;
  const noneChecked = selected.length === 0;

  let displayLabel = label;
  if (noneChecked) displayLabel = emptyLabel ?? "None";
  else if (!allChecked) displayLabel = selected.length === 1 ? (options.find((o) => o.value === selected[0])?.label ?? label) : `${selected.length} selected`;

  function toggleAll() {
    onChange(allChecked ? [] : options.map((o) => o.value));
  }

  function toggleOne(value: string) {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={`flex h-8 items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 text-[12px] text-foreground shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:border-ring ${triggerClassName ?? "w-full"}`}>
        <span className="truncate">{displayLabel}</span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground opacity-50" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[var(--radix-dropdown-menu-trigger-width)]">
        <DropdownMenuCheckboxItem checked={allChecked} onCheckedChange={toggleAll} onSelect={(e) => e.preventDefault()} className="text-[13px] font-medium">
          Select all
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {options.map((opt) => (
          <DropdownMenuCheckboxItem
            key={opt.value}
            checked={selected.includes(opt.value)}
            onCheckedChange={() => toggleOne(opt.value)}
            onSelect={(e) => e.preventDefault()}
            className="text-[13px]"
          >
            {opt.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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

// Sentinel for the "all locations / all departments" Select option (Radix forbids empty values).
const GOAL_ALL = "__all__";

function DrawerField({ label, required, htmlFor, className, children }: {
  label: string;
  required?: boolean;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`grid gap-1.5 ${className ?? ""}`}>
      <Label htmlFor={htmlFor} className="text-[12px] font-medium text-muted-foreground">
        {label}{required ? <span className="text-primary"> *</span> : null}
      </Label>
      {children}
    </div>
  );
}

function GoalEditor({ goal, actuals, isAdmin, allowedDepartments, allowedLocations, teamEmployees, onSave, onSaveTargetPair, onCancel }: { goal: Goal; actuals: ActualsByKey; isAdmin?: boolean; allowedDepartments?: string[]; allowedLocations?: string[]; teamEmployees?: Employee[]; onSave: (goal: Goal) => Goal | null | void | Promise<Goal | null | void>; onSaveTargetPair: (goal: Goal, target: string, min: string) => void | Promise<void>; onCancel: () => void }) {
  const isNew = goal.name === "";
  const [draft, setDraft] = useState(goal);
  const [target, setTarget] = useState(actuals[metaKey("target", goal)] != null ? String(actuals[metaKey("target", goal)]) : String(goal.goalValue || ""));
  const [min, setMin] = useState(actuals[metaKey("min", goal)] != null ? String(actuals[metaKey("min", goal)]) : String(goal.minValue || ""));
  const [weightVal, setWeightVal] = useState(goal.weight != null ? String(goal.weight) : "");

  // Required fields that must be explicitly chosen — blank ("" or "__unset__") on new goals
  const [tierVal, setTierVal] = useState<string>(isNew ? "" : goal.goalTier);
  const [locVal, setLocVal] = useState<string>(isNew ? "__unset__" : (goal.location ?? ""));
  const [deptVal, setDeptVal] = useState<string>(isNew ? "__unset__" : (goal.department ?? ""));
  const [empVal, setEmpVal] = useState<string>(isNew ? "__unset__" : (goal.employeeName ?? "__unset__"));
  const [lowerVal, setLowerVal] = useState<string>(isNew ? "" : String(goal.lowerBetter));
  const [cappedVal, setCappedVal] = useState<string>(isNew ? "" : goal.capped);
  const [periodVal, setPeriodVal] = useState<string>(isNew ? "" : (goal.periodType || "monthly"));

  const visibleDepartments = allowedDepartments?.length ? allowedDepartments : departments;
  const allLocations = ["Utah", "Georgia", "Remote"];
  const visibleLocations = allowedLocations?.length ? allowedLocations : allLocations;

  const isIndividual = tierVal === "individual";
  const isDepartment = tierVal === "department";

  // For individual goals: filter team employees by selected dept/location when available
  const filteredEmployees = (teamEmployees || []).filter((e) => {
    if (deptVal && deptVal !== "__unset__" && deptVal !== "" && e.department !== deptVal) return false;
    if (locVal && locVal !== "__unset__" && locVal !== "" && e.location !== locVal) return false;
    return true;
  }).sort((a, b) => a.name.localeCompare(b.name));

  const missing: string[] = [];
  if (!draft.name.trim()) missing.push("Goal Name");
  if (!tierVal) missing.push("Type");
  if (!isDepartment && locVal === "__unset__") missing.push("Location");
  if (deptVal === "__unset__") missing.push("Department");
  if (isIndividual && empVal === "__unset__") missing.push("Employee");
  if (!lowerVal) missing.push("Lower is Better");
  if (!cappedVal) missing.push("Capped");
  if (!periodVal) missing.push("Period Type");
  if (!weightVal || isNaN(Number(weightVal)) || Number(weightVal) <= 0) missing.push("Weight");
  const canSave = missing.length === 0;

  async function handleSave() {
    if (!canSave) return;
    const finalGoal: Goal = {
      ...draft,
      goalTier: tierVal as GoalTier,
      location: locVal === "" || locVal === GOAL_ALL ? undefined : locVal,
      department: deptVal === "" ? undefined : deptVal,
      employeeName: isIndividual && empVal !== "__unset__" ? empVal : undefined,
      role: undefined, // no longer used for new goals
      lowerBetter: lowerVal === "true",
      capped: cappedVal as "yes" | "no",
      periodType: periodVal as "monthly" | "quarterly",
      weight: Number(weightVal) || undefined,
    };
    const savedGoal = await onSave(finalGoal);
    if (savedGoal === null) return;
    await onSaveTargetPair(savedGoal || finalGoal, target, min);
    onCancel(); // close the drawer on success
  }

  return (
    <>
      <SheetHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="grid gap-1">
            <SheetTitle>{isNew ? "New goal" : "Edit goal"}</SheetTitle>
            <SheetDescription>
              {isNew ? "Add a goal to the bank." : (draft.name || "Edit this goal’s details.")}
            </SheetDescription>
          </div>
          <SheetClose className="-mr-1 -mt-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </SheetClose>
        </div>
      </SheetHeader>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="grid gap-4">
          <DrawerField label="Goal name" required htmlFor="goal-name">
            <Input id="goal-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Monthly Revenue" />
          </DrawerField>

          <DrawerField label="Type" required>
            <Select value={tierVal || undefined} onValueChange={(v) => { setTierVal(v); setEmpVal("__unset__"); }}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Select type…" /></SelectTrigger>
              <SelectContent>
                {isAdmin && <SelectItem value="company">Company</SelectItem>}
                <SelectItem value="department">Department</SelectItem>
                <SelectItem value="individual">Individual</SelectItem>
              </SelectContent>
            </Select>
          </DrawerField>

          <DrawerField label="Location" required>
            <Select value={locVal === "__unset__" ? undefined : (locVal === "" ? GOAL_ALL : locVal)} onValueChange={(v) => setLocVal(v === GOAL_ALL ? "" : v)}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Select location…" /></SelectTrigger>
              <SelectContent>
                {!allowedLocations?.length && !isIndividual && <SelectItem value={GOAL_ALL}>All locations</SelectItem>}
                {visibleLocations.map((loc) => <SelectItem key={loc} value={loc}>{loc}</SelectItem>)}
              </SelectContent>
            </Select>
          </DrawerField>

          <DrawerField label="Department" required>
            <Select value={deptVal === "__unset__" ? undefined : (deptVal === "" ? GOAL_ALL : deptVal)} onValueChange={(v) => { setDeptVal(v === GOAL_ALL ? "" : v); setEmpVal("__unset__"); }}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Select department…" /></SelectTrigger>
              <SelectContent>
                {isAdmin && !isIndividual && <SelectItem value={GOAL_ALL}>All departments</SelectItem>}
                {visibleDepartments.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
              </SelectContent>
            </Select>
          </DrawerField>

          {isIndividual && (
            <DrawerField label="Employee" required>
              <Select value={empVal === "__unset__" ? undefined : empVal} onValueChange={(v) => setEmpVal(v)}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Select employee…" /></SelectTrigger>
                <SelectContent>
                  {(filteredEmployees.length > 0 ? filteredEmployees : (teamEmployees || []).slice().sort((a, b) => a.name.localeCompare(b.name))).map((e) => (
                    <SelectItem key={e.name} value={e.name}>{e.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </DrawerField>
          )}

          <DrawerField label="Period" required>
            <Select value={periodVal || undefined} onValueChange={(v) => setPeriodVal(v)}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Select period…" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="monthly">Monthly</SelectItem>
                <SelectItem value="quarterly">Quarterly</SelectItem>
              </SelectContent>
            </Select>
          </DrawerField>

          <div className="grid grid-cols-2 gap-3">
            <DrawerField label="Target" htmlFor="goal-target">
              <Input id="goal-target" type="number" value={target} onChange={(e) => setTarget(e.target.value)} />
            </DrawerField>
            <DrawerField label="Minimum" htmlFor="goal-min">
              <Input id="goal-min" type="number" value={min} onChange={(e) => setMin(e.target.value)} />
            </DrawerField>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <DrawerField label="Lower is better" required>
              <Select value={lowerVal || undefined} onValueChange={(v) => setLowerVal(v)}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Select…" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="false">No</SelectItem>
                  <SelectItem value="true">Yes</SelectItem>
                </SelectContent>
              </Select>
            </DrawerField>
            <DrawerField label="Capped" required>
              <Select value={cappedVal || undefined} onValueChange={(v) => setCappedVal(v)}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Select…" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="no">No</SelectItem>
                  <SelectItem value="yes">Yes</SelectItem>
                </SelectContent>
              </Select>
            </DrawerField>
          </div>

          {cappedVal === "yes" && (
            <DrawerField label="Cap %" htmlFor="goal-cap">
              <Input id="goal-cap" type="number" value={draft.capPct} onChange={(e) => setDraft({ ...draft, capPct: Number(e.target.value) })} />
            </DrawerField>
          )}

          <DrawerField label="Weight %" required htmlFor="goal-weight">
            <Input id="goal-weight" type="number" min="0" max="100" step="0.1" value={weightVal} onChange={(e) => setWeightVal(e.target.value)} placeholder="e.g. 25" />
          </DrawerField>

          {!isNew && (
            <div style={{ paddingTop: "8px", borderTop: "1px solid #e2ddd8", display: "flex", flexDirection: "column", gap: "3px" }}>
              <p style={{ margin: 0, fontSize: "11px", color: "#6b6560", fontFamily: "monospace" }}>
                <span style={{ fontWeight: 600 }}>Created by:</span>{" "}
                {goal.createdBy
                  ? <>
                      {goal.createdBy}
                      {goal.createdAt && <> &middot; {new Date(goal.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</>}
                    </>
                  : <span style={{ color: "#aaa" }}>not recorded</span>
                }
              </p>
              <p style={{ margin: 0, fontSize: "11px", color: "#6b6560", fontFamily: "monospace" }}>
                <span style={{ fontWeight: 600 }}>Last updated:</span>{" "}
                {goal.updatedAt
                  ? new Date(goal.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
                  : <span style={{ color: "#aaa" }}>not recorded</span>
                }
              </p>
            </div>
          )}
        </div>
      </div>

      <SheetFooter>
        {!canSave && missing.length > 0 && (
          <p className="mr-auto text-[11.5px] text-muted-foreground sm:self-center">Required: {missing.join(", ")}</p>
        )}
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button onClick={handleSave} disabled={!canSave} title={!canSave ? `Complete required fields: ${missing.join(", ")}` : undefined}>
          {isNew ? "Create goal" : "Save changes"}
        </Button>
      </SheetFooter>
    </>
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
  onApproveScorecard: (scorecardId: string) => void;
  onReturnScorecard: (scorecardId: string, note: string) => void;
  currentUserEmail: string;
  currentUserProfileId?: string;
}) {
  const [filterEmployees, setFilterEmployees] = useState<string[]>([]);
  const [filterDepts, setFilterDepts] = useState<string[]>([]);
  const [filterLocations, setFilterLocations] = useState<string[]>([]);
  const [globalPeriodType, setGlobalPeriodType] = useState<"monthly" | "quarterly">("monthly");

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

  // Earnings (hours + gross pay) come from the upload tagged to the same month being scored
  const earningsUpload = props.rippling[selectedMonth] || [];
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
      if (goal.goalTier === "company") return false;
      if (goal.goalTier === "department") return goal.department === employee.department && (!goal.location || goal.location === employee.location);
      return goal.role === employee.role && goal.department === employee.department && (!goal.location || goal.location === employee.location);
    });
  }

  const sortedTeam = [...teamEmployees].sort((a, b) => a.name.localeCompare(b.name));
  const filteredEmployees = sortedTeam.filter((e) =>
    (filterEmployees.length === 0 || filterEmployees.includes(e.name)) &&
    (filterDepts.length === 0 || filterDepts.includes(e.department)) &&
    (filterLocations.length === 0 || filterLocations.includes(e.location)) &&
    (globalPeriodType !== "quarterly" || goalsForEmployee(e).some((g) => g.periodType === "quarterly"))
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

  // Limit month picker to 12 months back through last completed month (no current or future months)
  const relevantMonths = (() => {
    const now = new Date();
    const cur = now.getFullYear() * 12 + now.getMonth(); // months since year 0
    const prev = cur - 1; // last completed month
    return props.months.filter((m) => {
      if (!/^\d{4}-\d{2}$/.test(m)) return false;
      const [y, mo] = m.split("-").map(Number);
      const val = y * 12 + (mo - 1);
      return val >= cur - 12 && val <= prev;
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

  return (
    <div className="screen active">
      <section style={{ padding: 0 }} className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 p-2.5">
          <Tabs value={globalPeriodType} onValueChange={(v) => setGlobalPeriodType(v as "monthly" | "quarterly")}>
            <TabsList className="h-8">
              <TabsTrigger value="monthly" className="px-3 text-[12px] data-[state=active]:bg-card data-[state=active]:text-foreground">Monthly</TabsTrigger>
              <TabsTrigger value="quarterly" className="px-3 text-[12px] data-[state=active]:bg-card data-[state=active]:text-foreground">Quarterly</TabsTrigger>
            </TabsList>
          </Tabs>

          <DropdownMenu>
            <DropdownMenuTrigger className="flex h-8 w-auto min-w-[9rem] items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 text-[12px] text-foreground shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:border-ring">
              <span className="truncate">{monthPickerLabel}</span>
              <ChevronDown className="size-4 shrink-0 text-muted-foreground opacity-50" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-[320px] overflow-y-auto">
              <DropdownMenuCheckboxItem
                checked={props.selectedMonths.length === 0}
                onCheckedChange={() => { props.onMonths([]); setFilterEmployees([]); }}
                onSelect={(e) => e.preventDefault()}
                className="text-[13px] font-medium"
              >All months</DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              {relevantMonths.map((m) => (
                <DropdownMenuCheckboxItem
                  key={m}
                  checked={props.selectedMonths.includes(m)}
                  onCheckedChange={(checked) => {
                    const next = checked
                      ? [...props.selectedMonths, m].sort().reverse()
                      : props.selectedMonths.filter((x) => x !== m);
                    props.onMonths(next);
                    setFilterEmployees([]);
                  }}
                  onSelect={(e) => e.preventDefault()}
                  className="text-[13px]"
                >{formatMonthLabel(m)}</DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <Separator orientation="vertical" className="mx-0.5 hidden h-5 sm:block" />

          {showLocationFilter && (
            <MultiSelectDropdown
              label="All locations"
              emptyLabel="All locations"
              triggerClassName="w-auto min-w-[8rem]"
              options={teamLocations.map((l) => ({ value: l, label: l }))}
              selected={filterLocations}
              onChange={(v) => { setFilterLocations(v); setFilterEmployees([]); }}
            />
          )}
          {showDeptFilter && (
            <MultiSelectDropdown
              label="All departments"
              emptyLabel="All departments"
              triggerClassName="w-auto min-w-[8rem]"
              options={teamDepts.map((d) => ({ value: d, label: d }))}
              selected={filterDepts}
              onChange={(v) => { setFilterDepts(v); setFilterEmployees([]); }}
            />
          )}
          <MultiSelectDropdown
            label="All employees"
            emptyLabel="All employees"
            triggerClassName="w-auto min-w-[9rem]"
            options={employeeOptions.map((name) => ({ value: name, label: name }))}
            selected={filterEmployees}
            onChange={setFilterEmployees}
          />
        </div>
      </section>

      {singleMonthMode ? (
        <section style={{ background: "transparent", border: "none", boxShadow: "none", padding: 0 }}>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-0.5 pb-3 pt-1">
            <h2 className="text-[13px] font-semibold text-foreground">{filteredEmployees.length} team member{filteredEmployees.length !== 1 ? "s" : ""}</h2>
            <span className="text-[12px] text-muted-foreground">
              {filterEmployees.length === 1
                ? filterEmployees[0]
                : [
                    filterLocations.length > 0 && filterLocations.length < teamLocations.length ? filterLocations.join(", ") : "",
                    filterDepts.length > 0 && filterDepts.length < teamDepts.length ? filterDepts.join(", ") : "",
                  ].filter(Boolean).join(" · ") || periodLabel}
            </span>
          </div>
          <div className="scorecard-list" style={{ padding: 0 }}>
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
                  globalPeriodType={globalPeriodType}
                  onSubmit={props.onSubmitScorecard}
                  onDeleteGoal={props.onDeleteGoal}
                  onApprove={props.onApproveScorecard}
                  onReturn={props.onReturnScorecard}
                  currentUserEmail={props.currentUserEmail}
                  currentUserProfileId={props.currentUserProfileId}
                />
              );
            })}
            {!noRippling && filteredEmployees.length === 0 && (
              <div className="no-goals-msg" style={{ display: "block" }}>No employees match the current filter.</div>
            )}
          </div>
        </section>
      ) : (
        <section style={{ background: "transparent", border: "none", boxShadow: "none", padding: 0 }}>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-0.5 pb-3 pt-1">
            <h2 className="text-[13px] font-semibold text-foreground">{displayMonths.length} month{displayMonths.length !== 1 ? "s" : ""}</h2>
            <span className="text-[12px] text-muted-foreground">
              {filterEmployees.length === 1
                ? filterEmployees[0]
                : [
                    filterLocations.length > 0 && filterLocations.length < teamLocations.length ? filterLocations.join(", ") : "",
                    filterDepts.length > 0 && filterDepts.length < teamDepts.length ? filterDepts.join(", ") : "",
                  ].filter(Boolean).join(" · ") || monthPickerLabel.toLowerCase()}
            </span>
          </div>
          <div className="scorecard-list" style={{ padding: 0 }}>
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
              const mEarningsUpload = props.rippling[m] || [];
              const mActuals = {
                ...(props.allActuals[mLabel] || {}),
                ...(props.allActuals[quarterKeyForMonth(m)] || {}),
              };
              return (
                <div key={m} className="flex flex-col gap-2.5">
                  <div className="px-0.5 pb-0 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
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
                        globalPeriodType={globalPeriodType}
                        onSubmit={props.onSubmitScorecard}
                        onDeleteGoal={props.onDeleteGoal}
                        onApprove={props.onApproveScorecard}
                        onReturn={props.onReturnScorecard}
                        currentUserEmail={props.currentUserEmail}
                        currentUserProfileId={props.currentUserProfileId}
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

function GoalRowMenu({ goalName, currentWeight, onApplyWeight, onRemove }: {
  goalName: string;
  currentWeight: string;
  onApplyWeight: (weight: string) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [weight, setWeight] = useState(currentWeight);
  return (
    <DropdownMenu open={open} onOpenChange={(o) => { setOpen(o); if (o) setWeight(currentWeight); }}>
      <DropdownMenuTrigger
        aria-label="Goal options"
        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:bg-accent data-[state=open]:text-foreground"
      >
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuLabel className="truncate">{goalName}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5">
          <Label className="mb-1.5 block text-[11px] font-medium text-muted-foreground">Weight %</Label>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min="0"
              max="100"
              step="0.1"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") { onApplyWeight(weight); setOpen(false); } }}
              className="h-7 w-20 text-[12px] tabular-nums"
            />
            <Button size="sm" className="h-7 text-[12px]" onClick={() => { onApplyWeight(weight); setOpen(false); }}>Apply</Button>
          </div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onRemove}>Remove goal</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LiveScorecardCard({
  employee, isoMonth, month, baseGoals, allGoals, periodActuals, allRippling, submittedScorecard, globalPeriodType, onSubmit, onDeleteGoal, onApprove, onReturn, currentUserEmail, currentUserProfileId
}: {
  employee: Employee;
  isoMonth: string;
  month: string;
  baseGoals: Goal[];
  allGoals: Goal[];
  periodActuals: ActualsByKey;
  allRippling: Record<string, Employee[]>;
  submittedScorecard: Scorecard | undefined;
  globalPeriodType: "monthly" | "quarterly";
  onSubmit: (scorecard: Scorecard) => void;
  onDeleteGoal: (value: { scorecardId: string; goalName: string }) => void;
  onApprove: (scorecardId: string) => void;
  onReturn: (scorecardId: string, note: string) => void;
  currentUserEmail: string;
  currentUserProfileId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [cardPeriodType, setCardPeriodType] = useState<"monthly" | "quarterly">(globalPeriodType);
  const [goalIds, setGoalIds] = useState<string[]>(() => baseGoals.filter((g) => globalPeriodType === "quarterly" ? g.periodType === "quarterly" : g.periodType !== "quarterly").map((g) => g.id));
  const [indActuals, setIndActuals] = useState<Record<string, string>>({});
  const [weightOverrides, setWeightOverrides] = useState<Record<string, string>>({});

  // Sync period type when the global toggle changes
  useEffect(() => {
    handlePeriodTypeChange(globalPeriodType);
  }, [globalPeriodType]); // eslint-disable-line react-hooks/exhaustive-deps


  // Actuals can only be entered for past months, not the current month
  const isCurrentMonth = isoMonth === currentMonthValue();
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
    if (goal.goalTier === "company") return false;
    if (goal.goalTier === "department") return goal.department === employee.department && (!goal.location || goal.location === employee.location);
    // Individual: match by employeeName if set (new), else fall back to role match (legacy)
    if (goal.employeeName) return goal.employeeName === employee.name;
    return (!goal.role || goal.role === employee.role) && goal.department === employee.department && (!goal.location || goal.location === employee.location);
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
    return <ScorecardCard scorecard={displayedSubmitted} onDeleteGoal={onDeleteGoal} onApprove={onApprove} onReturn={onReturn} currentUserProfileId={currentUserProfileId} />;
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
      const defaultWeight = i === n - 1 ? Number((100 - equalWeight * (n - 1)).toFixed(2)) : equalWeight;
      const scWeight = weightOverrides[g.name] !== undefined
        ? (weightOverrides[g.name] === "" ? 0 : Number(weightOverrides[g.name]))
        : defaultWeight;
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
  const totalWeight = Number(currentGoals.reduce((sum, g) => sum + g.scWeight, 0).toFixed(1));
  const weightsValid = currentGoals.length === 0 || totalWeight === 100;
  const availableToAdd = allGoals.filter((g) => {
    if (goalIds.includes(g.id)) return false;
    if (!isGoalApplicable(g)) return false;
    return cardPeriodType === "quarterly" ? g.periodType === "quarterly" : g.periodType !== "quarterly";
  });
  const achColor = liveScorecard.weightedAchievement >= 100 ? "#2D6B1A" : "var(--brick)";
  const hasAnyActual = liveScorecard.goals.some((g) => g.actual != null);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40">
        <ChevronRight className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-[11px] font-semibold text-foreground">{dashInitials(employee.name)}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium text-foreground">{employee.name}</span>
          <span className="block truncate text-[11.5px] text-muted-foreground">
            {employee.role}{employee.department ? ` · ${employee.department}` : ""}{employee.location ? ` · ${employee.location}` : ""}
          </span>
        </span>
        {currentGoals.length > 0 ? (
          <>
            <span className="hidden text-right sm:block">
              <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">Achievement</span>
              {hasAnyActual
                ? <span className="block text-[15px] font-semibold tabular-nums" style={{ color: achColor }}>{liveScorecard.weightedAchievement.toFixed(1)}%</span>
                : <span className="block text-[13px] font-medium text-muted-foreground">Pending</span>}
            </span>
            <span className="min-w-[5rem] text-right">
              <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">Est. Bonus</span>
              {hasAnyActual
                ? <span className="block text-[15px] font-semibold tabular-nums text-primary">{formatCurrency(liveScorecard.bonusAmount)}</span>
                : <span className="block text-[13px] font-medium text-muted-foreground">Pending</span>}
            </span>
          </>
        ) : null}
        <Badge variant="secondary" title="This scorecard hasn't been submitted yet" className="shrink-0 font-medium">Not Submitted</Badge>
      </button>

      {open && (
        <>
          <div className="flex flex-wrap gap-6 border-t border-border bg-muted/30 px-4 py-2.5">
            <div>
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{cardPeriodType === "quarterly" ? `Quarterly earnings · ${quarterKey}` : "Base earnings"}</div>
              <div className="text-[13px] font-semibold tabular-nums">{formatCurrency(liveScorecard.baseEarnings)}</div>
            </div>
            {activeEmployee.hoursWorked ? (
              <div>
                <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Hours worked{cardPeriodType === "quarterly" ? " (qtr)" : ""}</div>
                <div className="text-[13px] font-semibold tabular-nums">{activeEmployee.hoursWorked.toFixed(2)}</div>
              </div>
            ) : null}
          </div>

          {hasNoTarget && (
            <div className="flex items-start gap-2 border-t border-[#f0e0a0] bg-[#fffbf0] px-4 py-2 text-[11.5px] text-[#7a5c00]">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>Some goals are missing targets or minimums for {activeMonth}. Set them in Goals &amp; Actuals before submitting.</span>
            </div>
          )}

          {currentGoals.length > 0 ? (
            <Table className="border-t border-border text-[12px]">
              <TableHeader className="bg-muted/40 [&_th]:h-8 [&_th]:px-2.5 [&_th]:text-[10px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted-foreground">
                <TableRow className="hover:bg-transparent">
                  <TableHead>Type</TableHead>
                  <TableHead>Goal</TableHead>
                  <TableHead className="text-center">Target</TableHead>
                  <TableHead className="text-center">Min</TableHead>
                  <TableHead className="text-center">Actual</TableHead>
                  <TableHead className="text-center">Weight</TableHead>
                  <TableHead className="text-center">Achieve</TableHead>
                  <TableHead className="text-right">Est. Bonus</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody className="[&_td]:px-2.5 [&_td]:py-2">
                {currentGoals.map((goal) => {
                  const sc = liveScorecard.goals.find((g) => g.name === goal.name);
                  const noTarget = periodActuals[metaKey("target", goal)] == null || periodActuals[metaKey("min", goal)] == null;
                  const isInd = goal.goalTier === "individual";
                  return (
                    <TableRow key={goal.id}>
                      <TableCell><TierBadge tier={goal.goalTier} /></TableCell>
                      <TableCell className="font-medium text-foreground">
                        <span className="flex items-center gap-1.5">{goal.name}<GoalScopeTags location={goal.location} department={goal.department} /></span>
                      </TableCell>
                      <TableCell className="text-center tabular-nums">{noTarget ? <span className="text-[10px] text-[var(--text-faint)]">not set</span> : formatNumber(goal.scTarget)}</TableCell>
                      <TableCell className="text-center tabular-nums">{noTarget ? <span className="text-[10px] text-[var(--text-faint)]">not set</span> : formatNumber(goal.scMin)}</TableCell>
                      <TableCell className="text-center tabular-nums" onClick={(e) => e.stopPropagation()}>
                        {isInd && !isCurrentMonth ? (
                          <Input
                            aria-label={`Actual for ${goal.name}`}
                            type="number"
                            value={indActuals[goal.name] ?? ""}
                            onChange={(e) => setIndActuals((prev) => ({ ...prev, [goal.name]: e.target.value }))}
                            className="h-7 w-[72px] text-center text-[12px] tabular-nums"
                          />
                        ) : (
                          <span className={goal.scActual == null ? "text-[var(--text-faint)]" : undefined}>{goal.scActual != null ? formatNumber(goal.scActual) : "—"}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-center tabular-nums">{(weightOverrides[goal.name] != null ? Number(weightOverrides[goal.name]) : goal.scWeight).toFixed(1)}%</TableCell>
                      <TableCell className="text-center font-semibold tabular-nums">
                        {sc?.actual != null
                          ? (sc.metMin
                            ? <span style={{ color: sc.achievement >= 100 ? "#2D6B1A" : "var(--brick)" }}>{sc.achievement.toFixed(1)}%</span>
                            : <span className="text-[#9B2C2C]">Below min</span>)
                          : <span className="text-[var(--text-faint)]">—</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(sc?.bonusContribution ?? 0)}</TableCell>
                      <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                        <GoalRowMenu
                          goalName={goal.name}
                          currentWeight={weightOverrides[goal.name] ?? goal.scWeight.toFixed(1)}
                          onApplyWeight={(w) => setWeightOverrides((prev) => ({ ...prev, [goal.name]: w }))}
                          onRemove={() => setGoalIds((prev) => prev.filter((id) => id !== goal.id))}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <div className="border-t border-border px-4 py-4 text-center text-[12.5px] text-muted-foreground">
              {cardPeriodType === "quarterly" ? `No quarterly goals assigned for ${employee.name}.` : "No goals assigned for this employee and month."}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2.5 border-t border-border px-4 py-3" onClick={(e) => e.stopPropagation()}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="text-[12px]">+ Add goal</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top" className="max-h-[240px] w-56 overflow-y-auto">
                {availableToAdd.length === 0 ? (
                  <div className="px-2 py-2 text-[11px] text-muted-foreground">No more goals available</div>
                ) : availableToAdd.map((g) => (
                  <DropdownMenuItem key={g.id} onSelect={() => setGoalIds((prev) => [...prev, g.id])} className="text-[12.5px]">
                    <span className="flex items-center gap-1.5">{g.name}<GoalScopeTags location={g.location} department={g.department} /></span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {isCurrentMonth && (
              <span className="text-[11.5px] italic text-muted-foreground">Actuals can only be entered for past months</span>
            )}
            {currentGoals.length > 0 && (
              <span className={`text-[11.5px] tabular-nums ${weightsValid ? "text-muted-foreground" : "font-semibold text-primary"}`}>
                Weights: {totalWeight.toFixed(1)}%{!weightsValid ? " — must equal 100" : ""}
              </span>
            )}
            <Button
              size="sm"
              className="ml-auto"
              disabled={isCurrentMonth || hasNoTarget || currentGoals.length === 0 || !weightsValid}
              title={isCurrentMonth ? "Scorecards can only be submitted for past months" : hasNoTarget ? "Set targets and minimums first" : !weightsValid ? "Weights must add up to 100%" : undefined}
              onClick={() => { onSubmit(liveScorecard); setLastSubmitted(liveScorecard); }}
            >
              Submit scorecard
            </Button>
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

function ScorecardCard({ scorecard, onDeleteGoal, onApprove, onReturn, currentUserProfileId }: {
  scorecard: Scorecard;
  onDeleteGoal: (value: { scorecardId: string; goalName: string }) => void;
  onApprove: (scorecardId: string) => void;
  onReturn: (scorecardId: string, note: string) => void;
  currentUserProfileId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [returning, setReturning] = useState(false);
  const [returnNote, setReturnNote] = useState("");
  const achColor = scorecard.weightedAchievement >= 100 ? "#2D6B1A" : "var(--brick)";
  const effectiveHourly = scorecard.hours && scorecard.hours > 0
    ? ((scorecard.baseEarnings + scorecard.bonusAmount) / scorecard.hours).toFixed(2)
    : null;
  const weight = scorecard.goals.length ? (100 / scorecard.goals.length).toFixed(1) : "0";
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <button
        type="button"
        data-testid={`scorecard-card-${scorecard.id}`}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40"
      >
        <ChevronRight className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-[11px] font-semibold text-foreground">{dashInitials(scorecard.employeeName)}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium text-foreground">{scorecard.employeeName}</span>
          <span className="block truncate text-[11.5px] text-muted-foreground">
            {scorecard.role}{scorecard.department ? ` · ${scorecard.department}` : ""}{scorecard.location ? ` · ${scorecard.location}` : ""}
          </span>
        </span>
        <span className="hidden text-right sm:block">
          <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">Achievement</span>
          <span className="block text-[15px] font-semibold tabular-nums" style={{ color: achColor }}>{scorecard.weightedAchievement.toFixed(1)}%{scorecard.scorecardCapped ? " cap" : ""}</span>
        </span>
        <span className="min-w-[5rem] text-right">
          <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">Bonus</span>
          <span className="block text-[15px] font-semibold tabular-nums text-primary">{formatCurrency(scorecard.bonusAmount)}</span>
        </span>
        {scorecard.reviewStatus === "pending_review" ? (
          <Badge variant="secondary" className="shrink-0 font-medium" style={{ background: "#FEF3C7", color: "#92400E", borderColor: "#FDE68A" }}>Pending Review</Badge>
        ) : scorecard.reviewStatus === "approved" ? (
          <Badge variant="success" className="shrink-0 font-medium">Approved</Badge>
        ) : scorecard.reviewStatus === "returned" ? (
          <Badge variant="secondary" className="shrink-0 font-medium" style={{ background: "#FEE2E2", color: "#991B1B", borderColor: "#FECACA" }}>Returned</Badge>
        ) : (
          <Badge variant="success" className="shrink-0 font-medium">Submitted</Badge>
        )}
      </button>

      {/* Reviewer actions — only shown to the assigned reviewer */}
      {scorecard.reviewStatus === "pending_review" && currentUserProfileId && scorecard.reviewerId === currentUserProfileId && (
        <div style={{ borderTop: "1px solid var(--border)", background: "var(--muted)", padding: "10px 16px", display: "flex", flexDirection: "column", gap: "8px" }}>
          {!returning ? (
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <span style={{ fontSize: "12px", color: "var(--text-muted)", flex: 1 }}>
                Submitted by {scorecard.submittedBy} · awaiting your review
              </span>
              <button
                onClick={() => onApprove(scorecard.id)}
                style={{ padding: "5px 14px", fontSize: "12px", fontWeight: 600, background: "#166534", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontFamily: "var(--sans)" }}
              >Approve</button>
              <button
                onClick={() => setReturning(true)}
                style={{ padding: "5px 14px", fontSize: "12px", fontWeight: 600, background: "none", color: "var(--brick)", border: "1.5px solid var(--brick)", borderRadius: "6px", cursor: "pointer", fontFamily: "var(--sans)" }}
              >Return</button>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <textarea
                autoFocus
                placeholder="Note for the manager (optional)…"
                value={returnNote}
                onChange={(e) => setReturnNote(e.target.value)}
                style={{ width: "100%", fontSize: "12px", padding: "6px 8px", border: "1px solid var(--border)", borderRadius: "6px", fontFamily: "var(--sans)", resize: "vertical", minHeight: "60px" }}
              />
              <div style={{ display: "flex", gap: "6px" }}>
                <button
                  onClick={() => { onReturn(scorecard.id, returnNote); setReturning(false); setReturnNote(""); }}
                  style={{ padding: "5px 14px", fontSize: "12px", fontWeight: 600, background: "var(--brick)", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontFamily: "var(--sans)" }}
                >Confirm Return</button>
                <button
                  onClick={() => { setReturning(false); setReturnNote(""); }}
                  style={{ padding: "5px 14px", fontSize: "12px", fontWeight: 600, background: "none", color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: "6px", cursor: "pointer", fontFamily: "var(--sans)" }}
                >Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Return note — shown to the submitting manager */}
      {scorecard.reviewStatus === "returned" && scorecard.reviewNote && (
        <div style={{ borderTop: "1px solid #FECACA", background: "#FEF2F2", padding: "8px 16px" }}>
          <span style={{ fontSize: "11.5px", fontWeight: 600, color: "#991B1B" }}>Returned</span>
          {scorecard.reviewedBy && <span style={{ fontSize: "11.5px", color: "#991B1B" }}> by {scorecard.reviewedBy}</span>}
          <span style={{ fontSize: "11.5px", color: "#7F1D1D" }}>: {scorecard.reviewNote}</span>
        </div>
      )}

      {open && (
        <>
          <div className="flex flex-wrap gap-6 border-t border-border bg-muted/30 px-4 py-2.5">
            {[
              { label: "Monthly earnings", value: formatCurrency(scorecard.baseEarnings) },
              scorecard.hours ? { label: "Hours worked", value: scorecard.hours.toFixed(2) } : null,
              scorecard.hourlyRate ? { label: "Hourly rate", value: formatCurrency(scorecard.hourlyRate) } : null,
              effectiveHourly ? { label: "Effective hourly", value: `$${effectiveHourly}` } : null,
              { label: "Bonus amount", value: formatCurrency(scorecard.bonusAmount), color: "var(--brick)" }
            ].filter(Boolean).map((item) => item && (
              <div key={item.label}>
                <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{item.label}</div>
                <div className="text-[13px] font-semibold tabular-nums" style={item.color ? { color: item.color } : undefined}>{item.value}</div>
              </div>
            ))}
          </div>
          <Table className="border-t border-border text-[12px]">
            <TableHeader className="bg-muted/40 [&_th]:h-8 [&_th]:px-2.5 [&_th]:text-[10px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted-foreground">
              <TableRow className="hover:bg-transparent">
                <TableHead>Type</TableHead>
                <TableHead>Goal</TableHead>
                <TableHead className="text-center">Target</TableHead>
                <TableHead className="text-center">Min</TableHead>
                <TableHead className="text-center">Weight</TableHead>
                <TableHead className="text-center">Actual</TableHead>
                <TableHead className="text-center">Achieve</TableHead>
                <TableHead className="text-right">Bonus</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody className="[&_td]:px-2.5 [&_td]:py-2">
              {scorecard.goals.map((goal) => (
                <TableRow key={goal.name} className="group">
                  <TableCell><TierBadge tier={goal.goalTier} /></TableCell>
                  <TableCell className="font-medium text-foreground">
                    <span className="flex items-center gap-1.5">{goal.name}<GoalScopeTags location={goal.location} department={goal.department} /></span>
                  </TableCell>
                  <TableCell className="text-center tabular-nums">{goal.target ?? "—"}</TableCell>
                  <TableCell className="text-center tabular-nums">{goal.min ?? "—"}</TableCell>
                  <TableCell className="text-center tabular-nums">{weight}%</TableCell>
                  <TableCell className="text-center tabular-nums">{goal.actual ?? "—"}</TableCell>
                  <TableCell className="text-center font-semibold tabular-nums" style={{ color: goal.metMin ? (goal.achievement >= 100 ? "#2D6B1A" : "var(--brick)") : "#9B2C2C" }}>
                    {goal.metMin ? `${goal.achievement.toFixed(1)}%` : "Below min"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(goal.bonusContribution)}</TableCell>
                  <TableCell className="text-right">
                    <button
                      type="button"
                      title="Remove goal"
                      onClick={() => onDeleteGoal({ scorecardId: scorecard.id, goalName: goal.name })}
                      className="inline-flex size-6 items-center justify-center rounded-md text-[#9B2C2C] opacity-0 transition-opacity hover:bg-[#9B2C2C]/10 focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <X className="size-3.5" />
                    </button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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

function ReportControl({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="px-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      {children}
    </div>
  );
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


  const VIEW_BTNS: { key: HistoryView; label: string }[] = [
    { key: "table", label: "Table" },
    { key: "grid", label: "Grid" },
    { key: "chart", label: "Chart" },
    { key: "scorecard", label: "Cards" },
  ];

  return (
    <div className="screen active">
      {/* View toggle header */}
      <section style={{ background: "transparent", border: "none", boxShadow: "none", padding: 0, marginBottom: 12 }}>
        <Tabs value={props.view} onValueChange={(v) => props.onView(v as HistoryView)}>
          <TabsList className="h-8">
            {VIEW_BTNS.map(({ key, label }) => (
              <TabsTrigger
                key={key}
                value={key}
                data-testid={key === "scorecard" ? "history-scorecard-view" : undefined}
                className="px-3 text-[12px] data-[state=active]:bg-card data-[state=active]:text-foreground"
              >{label}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </section>

      {/* TABLE view — existing filter + flat list */}
      {props.view === "table" && (
        <>
          {!props.readonly && (
            <section style={{ padding: 0 }} className="overflow-hidden">
              <div className="flex flex-wrap items-center gap-2 p-2.5">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input value={props.filters.search} onChange={(e) => props.onFilters({ ...props.filters, search: e.target.value })} placeholder="Search employee, location…" className="h-8 w-[220px] pl-8 text-[12px]" />
                </div>
                <Separator orientation="vertical" className="mx-0.5 hidden h-5 sm:block" />
                <Select value={props.filters.period || ALL_LOCATIONS} onValueChange={(v) => props.onFilters({ ...props.filters, period: v === ALL_LOCATIONS ? "" : v })}>
                  <SelectTrigger size="sm" className="min-w-[8rem] text-[12px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_LOCATIONS}>All periods</SelectItem>
                    {Array.from(new Set(props.allScorecards.map((sc) => sc.scorecardMonth))).map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={props.filters.location || ALL_LOCATIONS} onValueChange={(v) => props.onFilters({ ...props.filters, location: v === ALL_LOCATIONS ? "" : v })}>
                  <SelectTrigger size="sm" className="min-w-[8rem] text-[12px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_LOCATIONS}>All locations</SelectItem>
                    <SelectItem value="Utah">Utah</SelectItem>
                    <SelectItem value="Georgia">Georgia</SelectItem>
                    <SelectItem value="Remote">Remote</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={props.filters.department || ALL_LOCATIONS} onValueChange={(v) => props.onFilters({ ...props.filters, department: v === ALL_LOCATIONS ? "" : v })}>
                  <SelectTrigger size="sm" className="min-w-[8rem] text-[12px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_LOCATIONS}>All departments</SelectItem>
                    {departments.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={props.filters.goal || ALL_LOCATIONS} onValueChange={(v) => props.onFilters({ ...props.filters, goal: v === ALL_LOCATIONS ? "" : v })}>
                  <SelectTrigger size="sm" className="min-w-[8rem] text-[12px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_LOCATIONS}>All goals</SelectItem>
                    {allGoalNames.map((g) => <SelectItem key={g} value={g}>{g}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </section>
          )}
          <section style={{ padding: 0 }} className="overflow-hidden">
            <Table className="text-[12.5px]">
              <TableHeader className="bg-muted/40 [&_th]:h-9 [&_th]:px-3 [&_th]:text-[10px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted-foreground">
                <TableRow className="hover:bg-transparent">
                  <TableHead>Employee</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead className="text-right">Achievement</TableHead>
                  <TableHead className="text-right">Bonus</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_td]:px-3 [&_td]:py-2.5">
                {props.scorecards.map((sc) => (
                  <TableRow key={sc.id}>
                    <TableCell className="font-medium text-foreground">{sc.employeeName}</TableCell>
                    <TableCell className="text-muted-foreground">{sc.scorecardMonth}</TableCell>
                    <TableCell className="text-muted-foreground">{sc.department}</TableCell>
                    <TableCell className="text-muted-foreground">{sc.location}</TableCell>
                    <TableCell className="text-right font-semibold tabular-nums" style={{ color: sc.weightedAchievement >= 100 ? "#2D6B1A" : "var(--brick)" }}>{sc.weightedAchievement.toFixed(1)}%</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(sc.bonusAmount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {!props.scorecards.length && <div className="px-4 py-6 text-center text-[13px] text-muted-foreground">No scorecards match the current filters.</div>}
          </section>
          {!props.readonly && (
            <div className="mt-3 flex justify-end">
              <Button variant="outline" size="sm" className="text-[12px]" onClick={() => downloadCsv(scorecardsToCsv(props.scorecards), "scorecards-history.csv")}>
                <Download className="size-3.5" /> Export filtered results CSV
              </Button>
            </div>
          )}
        </>
      )}

      {/* CARDS view */}
      {props.view === "scorecard" && (
        <>
          {!props.readonly && (
            <section style={{ padding: 0 }} className="overflow-hidden">
              <div className="flex flex-wrap items-center gap-2 p-2.5">
                <Select value={props.filters.period || ALL_LOCATIONS} onValueChange={(v) => props.onFilters({ ...props.filters, period: v === ALL_LOCATIONS ? "" : v })}>
                  <SelectTrigger size="sm" className="min-w-[8rem] text-[12px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_LOCATIONS}>All periods</SelectItem>
                    {Array.from(new Set(props.allScorecards.map((sc) => sc.scorecardMonth))).map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={props.filters.location || ALL_LOCATIONS} onValueChange={(v) => props.onFilters({ ...props.filters, location: v === ALL_LOCATIONS ? "" : v })}>
                  <SelectTrigger size="sm" className="min-w-[8rem] text-[12px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_LOCATIONS}>All locations</SelectItem>
                    <SelectItem value="Utah">Utah</SelectItem>
                    <SelectItem value="Georgia">Georgia</SelectItem>
                    <SelectItem value="Remote">Remote</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={props.filters.department || ALL_LOCATIONS} onValueChange={(v) => props.onFilters({ ...props.filters, department: v === ALL_LOCATIONS ? "" : v })}>
                  <SelectTrigger size="sm" className="min-w-[8rem] text-[12px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_LOCATIONS}>All departments</SelectItem>
                    {departments.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </section>
          )}
          <section style={{ background: "transparent", border: "none", boxShadow: "none", padding: 0 }}>
            <div className="scorecard-list" style={{ padding: 0 }}>{props.scorecards.map((sc) => <ScorecardCard key={sc.id} scorecard={sc} onDeleteGoal={() => {}} onApprove={() => {}} onReturn={() => {}} />)}</div>
            {!props.scorecards.length && <div className="px-4 py-6 text-center text-[13px] text-muted-foreground">No scorecards match the current filters.</div>}
          </section>
        </>
      )}

      {/* REPORT BUILDER — Grid & Chart */}
      {(props.view === "grid" || props.view === "chart") && (
        <>
          {/* Config bar */}
          <section style={{ padding: 0 }} className="overflow-hidden">
            <div className="flex flex-wrap items-end gap-x-3 gap-y-2 p-3">
              <ReportControl label="From">
                <Select value={fromMonth || ALL_LOCATIONS} onValueChange={(v) => setFromMonth(v === ALL_LOCATIONS ? "" : v)}>
                  <SelectTrigger size="sm" className="min-w-[8rem] text-[12px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_LOCATIONS}>Earliest</SelectItem>
                    {allMonthIsos.map((m) => <SelectItem key={m} value={m}>{formatMonthLabel(m)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </ReportControl>
              <ReportControl label="To">
                <Select value={toMonth || ALL_LOCATIONS} onValueChange={(v) => setToMonth(v === ALL_LOCATIONS ? "" : v)}>
                  <SelectTrigger size="sm" className="min-w-[8rem] text-[12px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_LOCATIONS}>Latest</SelectItem>
                    {allMonthIsos.map((m) => <SelectItem key={m} value={m}>{formatMonthLabel(m)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </ReportControl>
              <ReportControl label="Location">
                <Select value={selLocation || ALL_LOCATIONS} onValueChange={(v) => setSelLocation(v === ALL_LOCATIONS ? "" : v)}>
                  <SelectTrigger size="sm" className="min-w-[8rem] text-[12px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_LOCATIONS}>All locations</SelectItem>
                    {allLocations.map((l) => <SelectItem key={l} value={l}>{l}</SelectItem>)}
                  </SelectContent>
                </Select>
              </ReportControl>
              <ReportControl label="Department">
                <Select value={selDept || ALL_LOCATIONS} onValueChange={(v) => setSelDept(v === ALL_LOCATIONS ? "" : v)}>
                  <SelectTrigger size="sm" className="min-w-[8rem] text-[12px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_LOCATIONS}>All departments</SelectItem>
                    {allDepts.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                  </SelectContent>
                </Select>
              </ReportControl>
              <ReportControl label="Employee">
                <Select value={selEmployee || ALL_LOCATIONS} onValueChange={(v) => setSelEmployee(v === ALL_LOCATIONS ? "" : v)}>
                  <SelectTrigger size="sm" className="min-w-[9rem] text-[12px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_LOCATIONS}>All employees</SelectItem>
                    {allEmployeeNames.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                  </SelectContent>
                </Select>
              </ReportControl>
              <ReportControl label="Group by">
                <Select value={groupBy} onValueChange={(v) => setGroupBy(v as "employee" | "department" | "location")}>
                  <SelectTrigger size="sm" className="min-w-[8rem] text-[12px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="employee">Employee</SelectItem>
                    <SelectItem value="department">Department</SelectItem>
                    <SelectItem value="location">Location</SelectItem>
                  </SelectContent>
                </Select>
              </ReportControl>
              <ReportControl label="Metric">
                <Select value={metric} onValueChange={(v) => { setMetric(v as "achievement" | "bonus" | "goal"); setMetricGoal(""); }}>
                  <SelectTrigger size="sm" className="min-w-[9rem] text-[12px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="achievement">Achievement %</SelectItem>
                    <SelectItem value="bonus">Bonus Amount</SelectItem>
                    <SelectItem value="goal">Goal Achievement</SelectItem>
                  </SelectContent>
                </Select>
              </ReportControl>
              {metric === "goal" && (
                <ReportControl label="Goal">
                  <Select value={metricGoal || undefined} onValueChange={(v) => setMetricGoal(v)}>
                    <SelectTrigger size="sm" className="min-w-[9rem] text-[12px]"><SelectValue placeholder="Select a goal…" /></SelectTrigger>
                    <SelectContent>
                      {allGoalNames.map((g) => <SelectItem key={g} value={g}>{g}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </ReportControl>
              )}
            </div>
          </section>

          {/* GRID — pivot table */}
          {props.view === "grid" && (
            <section style={{ padding: 0 }} className="overflow-hidden">
              <div className="flex items-baseline gap-2 border-b border-border px-3 py-2.5">
                <h2 className="text-[13px] font-semibold text-foreground">{metricLabel}</h2>
                <span className="text-[11.5px] text-muted-foreground">by {groupBy} × month</span>
              </div>
              {reportMonths.length === 0 ? (
                <div className="px-4 py-6 text-center text-[13px] text-muted-foreground">No submitted scorecards in this range.</div>
              ) : (
                <Table style={{ minWidth: `${160 + reportMonths.length * 110}px` }} className="text-[12px]">
                  <TableHeader className="bg-muted/40 [&_th]:h-8 [&_th]:px-3 [&_th]:text-[10px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted-foreground">
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="sticky left-0 z-20 bg-[var(--surface2)]" style={{ minWidth: 150 }}>{groupBy.charAt(0).toUpperCase() + groupBy.slice(1)}</TableHead>
                      {reportMonths.map((m) => <TableHead key={m} className="text-right tabular-nums">{shortMonthLabel(m)}</TableHead>)}
                      <TableHead className="border-l border-border text-right tabular-nums">AVG</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody className="[&_td]:px-3 [&_td]:py-2">
                    {groupKeys.map((key) => {
                      const vals = reportMonths.map((m) => getGroupMonthValue(key, m));
                      const defined = vals.filter((v): v is number => v !== null);
                      const avg = defined.length ? defined.reduce((a, b) => a + b, 0) / defined.length : null;
                      return (
                        <TableRow key={key} className="hover:bg-transparent">
                          <TableCell className="sticky left-0 z-10 bg-card font-medium text-foreground">{key}</TableCell>
                          {vals.map((v, i) => (
                            <TableCell key={i} className="text-right tabular-nums" style={{ background: cellBg(v), color: cellFg(v), fontWeight: v !== null ? 600 : 400 }}>
                              {formatMetric(v)}
                            </TableCell>
                          ))}
                          <TableCell className="border-l border-border text-right font-bold tabular-nums" style={{ background: cellBg(avg), color: cellFg(avg) }}>
                            {formatMetric(avg)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </section>
          )}

          {/* CHART — SVG line graph */}
          {props.view === "chart" && (
            <section>
              <div className="mb-3 flex items-baseline gap-2">
                <h2 className="text-[13px] font-semibold text-foreground">{metricLabel}</h2>
                <span className="text-[11.5px] text-muted-foreground">over time · by {groupBy}</span>
              </div>
              {reportMonths.length < 2 || groupKeys.length === 0 ? (
                <div className="px-4 py-8 text-center text-[13px] text-muted-foreground">Select a range with at least 2 months of submitted scorecards to draw a chart.</div>
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
  onPreview: (employees: Employee[]) => void;
  onSave: () => void;
  onClear: () => void;
}) {
  async function handleFile(file: File | undefined) {
    if (!file) return;
    props.onPreview(parseRipplingEmployees(await file.text()));
  }

  const savedEmployees = props.saved[props.month] || [];
  return (
    <div className="screen active">
      <section>
        <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-primary">Upload Rippling CSV</div>
        <div className="mb-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-[12.5px] text-muted-foreground">
          Uploading employee data for <strong className="font-semibold text-foreground">{formatMonthLabel(props.month)}</strong>. Export the previous month's completed payroll from Rippling and drop it below.
        </div>
        <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border bg-muted/20 px-6 py-10 text-center tracking-normal transition-colors [&_span]:normal-case hover:border-primary/40 hover:bg-accent/40">
          <Upload className="size-7 text-muted-foreground" />
          <span className="text-[14px] font-semibold text-foreground">Drop your Rippling CSV here</span>
          <span className="text-[12px] text-muted-foreground">or click to browse — Active_Employees_with_Hourly_and_Annual_Base_Pay.csv</span>
          <input type="file" accept=".csv" hidden onChange={(event) => handleFile(event.target.files?.[0])} />
        </label>
      </section>
      {!!props.preview.length && <EmployeeTable title="Imported employees" employees={props.preview} action={<Button size="sm" onClick={props.onSave}>Save to app</Button>} />}
      <EmployeeTable title="Saved employee data" employees={savedEmployees} action={savedEmployees.length ? <Button variant="outline" size="sm" className="text-[12px]" onClick={props.onClear}>Clear all</Button> : undefined} />
    </div>
  );
}

function EmployeeTable({ title, employees, action }: { title: string; employees: Employee[]; action?: React.ReactNode }) {
  return (
    <section style={{ padding: 0 }} className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 pb-2.5 pt-4">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-primary">{title}</div>
        {action}
      </div>
      {employees.length === 0 ? (
        <div className="px-4 pb-6 pt-2 text-center text-[13px] text-muted-foreground">No saved employees for this month</div>
      ) : (
        <Table className="text-[12.5px]">
          <TableHeader className="bg-muted/40 [&_th]:h-9 [&_th]:px-4 [&_th]:text-[10px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted-foreground">
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Department</TableHead>
              <TableHead>Location</TableHead>
              <TableHead className="text-right">Pay</TableHead>
              <TableHead className="text-right">Hours</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="[&_td]:px-4 [&_td]:py-2.5">
            {employees.map((employee) => (
              <TableRow key={employee.id || employee.name}>
                <TableCell className="font-medium text-foreground">{employee.name}</TableCell>
                <TableCell className="text-muted-foreground">{employee.role}</TableCell>
                <TableCell className="text-muted-foreground">{employee.department}</TableCell>
                <TableCell className="text-muted-foreground">{employee.location}</TableCell>
                <TableCell className="text-right tabular-nums">{employee.payType === "salary" ? formatCurrency(employee.annualPay || 0) : formatCurrency(employee.hourlyRate || 0)}</TableCell>
                <TableCell className="text-right tabular-nums">{employee.hoursWorked || "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

function TodoGroupCard({ title, meta, done, total, showCompleted, onToggleCompleted, children }: {
  title: string;
  meta: React.ReactNode;
  done: number;
  total: number;
  showCompleted: boolean;
  onToggleCompleted: () => void;
  children: React.ReactNode;
}) {
  return (
    <section style={{ padding: 0 }} className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 p-4 pb-3">
        <div className="flex flex-col">
          <span className="text-[14px] font-semibold text-foreground">{title}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">{meta}</span>
        </div>
        <Button variant="ghost" size="sm" className="h-7 text-[11px] font-medium text-muted-foreground" onClick={onToggleCompleted}>
          {showCompleted ? "Hide completed" : "Show completed"}
        </Button>
      </div>
      <Progress value={total > 0 ? (done / total) * 100 : 0} className="h-1 rounded-none" />
      <div className="px-4">{children}</div>
    </section>
  );
}

function TodoRow({ name, goalTier, location, department, saved, children }: {
  name: string;
  goalTier: string;
  location?: string;
  department?: string;
  saved: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className={`flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border py-2.5 last:border-b-0 ${saved ? "opacity-55" : ""}`}>
      {saved ? <CheckCircle2 className="size-4 shrink-0 text-[var(--sage-dark)]" /> : <Circle className="size-4 shrink-0 text-[var(--text-faint)]" />}
      <span className="text-[13px] font-medium text-foreground">{name}</span>
      <TierBadge tier={goalTier} />
      <GoalScopeTags location={location} department={department} />
      {!saved && children}
    </div>
  );
}

function TodoNumberField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <Input type="number" value={value} onChange={(e) => onChange(e.target.value)} className="h-8 w-[88px] text-[12px] tabular-nums" />
    </label>
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
  onRipplingUpload
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
    if (diffDays < 0) return <Badge className="border-transparent bg-[#9B2C2C]/10 font-medium text-[#9B2C2C]">{Math.abs(diffDays)}d overdue</Badge>;
    if (diffDays === 0) return <Badge variant="secondary" className="font-medium">Today</Badge>;
    return <Badge variant="outline" className="font-normal text-muted-foreground">{diffDays}d</Badge>;
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
      <div className={`flex flex-col gap-2 border-b border-border py-2.5 last:border-b-0 ${ripplingDone ? "opacity-55" : ""}`}>
        <div className="flex items-start gap-2">
          {ripplingDone ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--sage-dark)]" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[#b8860b]" />}
          <div className="flex min-w-0 flex-col">
            <span className="text-[13px] font-medium text-foreground">Upload Rippling data</span>
            <span className="text-[12px] text-muted-foreground">{ripplingDone ? `${currentMonthLabel} data loaded — provides ${workMonthLabel} earnings` : `${currentMonthLabel} not uploaded — needed for ${workMonthLabel} earnings.`}</span>
          </div>
        </div>
        {!ripplingDone && (
          <div className="pl-6">
            <input ref={fileInputRef} type="file" accept=".csv" onChange={handleFileChange} className="block text-[12px] text-muted-foreground file:mr-2 file:rounded-md file:border file:border-input file:bg-transparent file:px-2.5 file:py-1 file:text-[12px] file:font-medium file:text-foreground" />
            {ripplingParsed && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-[12px] text-muted-foreground">{ripplingParsed.length} employees parsed from {ripplingFile?.name}</span>
                <Button size="sm" onClick={handleRipplingSave}>Save to app</Button>
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
        <TodoRow name={goal.name} goalTier={goal.goalTier} location={goal.location} department={goal.department} saved={done}>
          <div className="ml-auto flex items-end gap-2">
            <TodoNumberField label="Actual" value={draft} onChange={(v) => setDraftActuals((prev) => ({ ...prev, [goal.id]: v }))} />
            <Button size="sm" className="h-8" disabled={draft === ""} onClick={() => onSaveActual(goal, draft)}>Set</Button>
          </div>
        </TodoRow>
      )
    };
  });

  const allAdminRows: AdminRow[] = [...(ripplingRow ? [ripplingRow] : []), ...actualRows];
  const visibleAdminRows = showCompletedAdmin ? allAdminRows : allAdminRows.filter((r) => !r.done);

  return (
    <div className="screen active">
      <TodoGroupCard
        title={`Monthly tasks · ${workMonthLabel}`}
        meta={<>{adminDoneCount}/{adminTotal} done · Due {adminDue.label} <DaysBadge diffDays={adminDue.diffDays} /></>}
        done={adminDoneCount}
        total={adminTotal}
        showCompleted={showCompletedAdmin}
        onToggleCompleted={() => setShowCompletedAdmin((v) => !v)}
      >
        {visibleAdminRows.length === 0 ? (
          <div className="flex items-center gap-2 py-3 text-[13px] text-muted-foreground"><CheckCircle2 className="size-4 text-[var(--sage-dark)]" /> All monthly tasks complete</div>
        ) : (
          visibleAdminRows.map((row) => <React.Fragment key={row.key}>{row.node}</React.Fragment>)
        )}
      </TodoGroupCard>

      {/* Current month targets — shown only when any are missing (always overdue) */}
      {currentTargetTotal > 0 && !allCurrentTargetsDone && (
        <TodoGroupCard
          title={`${currentMonthLabel} targets`}
          meta={<>{currentTargetDoneCount}/{currentTargetTotal} set · Due {currentTargetDue.label} <DaysBadge diffDays={currentTargetDue.diffDays} /></>}
          done={currentTargetDoneCount}
          total={currentTargetTotal}
          showCompleted={showCompletedCurrentTargets}
          onToggleCompleted={() => setShowCompletedCurrentTargets((v) => !v)}
        >
          {currentTargetGoals
            .filter((g) => showCompletedCurrentTargets || currentActuals[metaKey("target", g)] == null)
            .map((goal) => {
              const saved = currentActuals[metaKey("target", goal)] != null;
              const draft = draftCurrentTargets[goal.id] ?? {
                target: String(currentActuals[metaKey("target", goal)] ?? ""),
                min: String(currentActuals[metaKey("min", goal)] ?? "")
              };
              return (
                <TodoRow key={goal.id} name={goal.name} goalTier={goal.goalTier} department={goal.department} saved={saved}>
                  <div className="ml-auto flex items-end gap-2">
                    <TodoNumberField label="Target" value={draft.target} onChange={(v) => setDraftCurrentTargets((prev) => ({ ...prev, [goal.id]: { ...draft, target: v } }))} />
                    <TodoNumberField label="Min" value={draft.min} onChange={(v) => setDraftCurrentTargets((prev) => ({ ...prev, [goal.id]: { ...draft, min: v } }))} />
                    <Button size="sm" className="h-8" disabled={draft.target === ""} onClick={() => onSaveCurrentTargetPair(goal, draft.target, draft.min)}>Set</Button>
                  </div>
                </TodoRow>
              );
            })}
        </TodoGroupCard>
      )}

      <TodoGroupCard
        title={`${nextMonthLabel} targets`}
        meta={<>{targetDoneCount}/{targetTotal} set · Due {targetDue.label} <DaysBadge diffDays={targetDue.diffDays} /></>}
        done={targetDoneCount}
        total={targetTotal}
        showCompleted={showCompletedTargets}
        onToggleCompleted={() => setShowCompletedTargets((v) => !v)}
      >
        {targetGoals.length === 0 ? (
          <div className="py-3 text-[13px] text-muted-foreground">No company or department goals in bank</div>
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
                <TodoRow key={goal.id} name={goal.name} goalTier={goal.goalTier} department={goal.department} saved={saved}>
                  <div className="ml-auto flex items-end gap-2">
                    <TodoNumberField label="Target" value={draft.target} onChange={(v) => setDraftTargets((prev) => ({ ...prev, [goal.id]: { ...draft, target: v } }))} />
                    <TodoNumberField label="Min" value={draft.min} onChange={(v) => setDraftTargets((prev) => ({ ...prev, [goal.id]: { ...draft, min: v } }))} />
                    <Button size="sm" className="h-8" disabled={draft.target === ""} onClick={() => onSaveTargetPair(goal, draft.target, draft.min)}>Set</Button>
                  </div>
                </TodoRow>
              );
            })
        )}
      </TodoGroupCard>
    </div>
  );
}

type GuideStep = { title: string; bg: string; border: string; numBg: string; body: string; bullets: string[] };

const guideStepsByRole: Record<"user" | "manager" | "admin", GuideStep[]> = {
  user: [
    {
      title: "View Your Scorecard",
      bg: "#eef5ec", border: "#aacfa5", numBg: "#1a5c1a",
      body: "My Scorecard shows all the scorecards that have been submitted for you. Each card includes your goals, actuals, achievement percentages, and final bonus amount.",
      bullets: [
        "Click My Scorecard in the sidebar",
        "Expand any card to see goal-by-goal detail",
        "Scorecards are submitted by your manager — reach out to them if one is missing"
      ]
    },
    {
      title: "Explore What If Scenarios",
      bg: "#f0f7fa", border: "#b8d4e0", numBg: "#185FA5",
      body: "The What If Scorecard lets you model how different actuals would affect your bonus — without saving anything. Great for understanding how close you are to hitting your targets.",
      bullets: [
        "Click What If Scorecard in the sidebar",
        "Your name and goals are pre-loaded",
        "Enter your base earnings and adjust actuals to see live bonus estimates",
        "Nothing here is saved — experiment freely"
      ]
    }
  ],
  manager: [
    {
      title: "Enter Department Actuals",
      bg: "var(--brick-light)", border: "var(--taupe)", numBg: "var(--brick)",
      body: "At the end of each month, enter the actual results for department goals. These are shared across everyone in the department — enter them once and they'll pre-fill on all scorecards.",
      bullets: [
        "Go to Goals & Actuals in the sidebar",
        "Select the month from the filter at the top",
        "Use the ⋮ menu on each department goal row and choose Enter actual",
        "Individual goal actuals are entered directly on each employee's scorecard"
      ]
    },
    {
      title: "Build & Submit Team Scorecards",
      bg: "#eef5ec", border: "#aacfa5", numBg: "#1a5c1a",
      body: "For each employee, open their scorecard card, review goals and weights, enter individual actuals, and submit. Department actuals you already entered will pre-fill automatically.",
      bullets: [
        "Go to Team Scorecards in the sidebar",
        "Select the scorecard month at the top",
        "Expand an employee's card to see their goals",
        "Enter actuals for individual goals — department actuals are pre-filled",
        "Use the ⋮ menu on any goal row to adjust its weight",
        "All weights must total 100% before you can submit",
        "Click Submit Scorecard to save"
      ]
    },
    {
      title: "Review Historical Scorecards",
      bg: "#eef5ec", border: "#aacfa5", numBg: "#1a5c1a",
      body: "Search and review all submitted scorecards for your team. Filter by period, employee, department, or location.",
      bullets: [
        "Go to Historical Data in the sidebar",
        "Select a period and optionally filter by name or department",
        "Each card shows goal-level detail — achievement, actuals, and bonus contribution",
        "Click ↓ Export filtered results CSV to download a spreadsheet"
      ]
    },
    {
      title: "Explore What If Scenarios",
      bg: "#f0f7fa", border: "#b8d4e0", numBg: "#185FA5",
      body: "Model how different actuals, targets, or weights affect bonus calculations for any employee on your team — without saving anything.",
      bullets: [
        "Click What If Scorecard in the sidebar",
        "Select an employee from your team",
        "Adjust actuals, weights, and earnings to explore scenarios",
        "Nothing here is saved — experiment freely"
      ]
    }
  ],
  admin: [
    {
      title: "Upload Rippling Data",
      bg: "var(--brick-light)", border: "var(--taupe)", numBg: "var(--brick)",
      body: "At the start of each month, upload the previous month's Rippling CSV. This pre-loads employee names, roles, departments, locations, pay rates, and hours so scorecards calculate correctly.",
      bullets: [
        "Go to Rippling Data in the sidebar",
        "Export Active_Employees_with_Hourly_and_Annual_Base_Pay.csv from Rippling for the previous (completed) month",
        "Drop the file onto the upload area and review the preview",
        "Click Save to App — this becomes the active employee bank"
      ]
    },
    {
      title: "Manage the Goal Bank",
      bg: "#f0f7fa", border: "#b8d4e0", numBg: "#185FA5",
      body: "The Goal Bank is your permanent library of goals. Goals are reused month to month and pulled into scorecards automatically. Set it up once and update as needed.",
      bullets: [
        "Go to Goals & Actuals in the sidebar",
        "Click + Add Goal to Bank to create a new goal",
        "Set the type: Department (dept-wide) or Individual (specific employee)",
        "Set a Weight % so it pre-fills on scorecards",
        "Goals can be deactivated without being deleted — history stays intact"
      ]
    },
    {
      title: "Enter Company & Department Actuals",
      bg: "#f0f7fa", border: "#b8d4e0", numBg: "#185FA5",
      body: "At month end, enter actual results for company and department goals. These are shared across all employees — enter them once and they'll be available on every scorecard.",
      bullets: [
        "Go to Goals & Actuals in the sidebar",
        "Select the month from the filter at the top",
        "Use the ⋮ menu on each goal row and choose Enter actual",
        "Individual goal actuals are entered directly on each employee's scorecard"
      ]
    },
    {
      title: "Build & Submit Team Scorecards",
      bg: "#eef5ec", border: "#aacfa5", numBg: "#1a5c1a",
      body: "For each employee, open their scorecard card, review goals and weights, enter individual actuals, and submit. Company and department actuals you already entered will pre-fill automatically.",
      bullets: [
        "Go to Team Scorecards in the sidebar",
        "Select the scorecard month at the top",
        "Expand an employee's card to see their goals",
        "Enter actuals for individual goals — company and dept actuals are pre-filled",
        "Use the ⋮ menu on any goal row to adjust its weight",
        "All weights must total 100% before you can submit",
        "Click Submit Scorecard to save"
      ]
    },
    {
      title: "Review Historical Scorecards",
      bg: "#eef5ec", border: "#aacfa5", numBg: "#1a5c1a",
      body: "Search and review all submitted scorecards. Filter by period, employee, department, or location. Export to CSV for payroll or further analysis.",
      bullets: [
        "Go to Historical Data in the sidebar",
        "Select a period and optionally filter by location or department",
        "Each card shows goal-level detail — achievement, actuals, and bonus contribution",
        "Click ↓ Export filtered results CSV to download a full spreadsheet"
      ]
    },
    {
      title: "Manage Users & Permissions",
      bg: "var(--brick-light)", border: "var(--taupe)", numBg: "var(--brick)",
      body: "Invite new users, configure their role and department scope, and manage existing accounts from the Users screen.",
      bullets: [
        "Go to Users in the sidebar",
        "Use Invite User to send a signup link — set their role (Admin / Manager / User) and scope",
        "Managers are scoped to specific departments and locations",
        "Users should be linked to an employee record so they can see their own scorecard",
        "Use 👁 View as to see exactly what any user sees in the app"
      ]
    }
  ]
};

const guideTipsByRole: Record<"user" | "manager" | "admin", string[]> = {
  user: [
    "Your scorecard is submitted by your manager — you can't edit it directly",
    "Scorecards are capped at <strong>200%</strong> total weighted achievement",
    "If a goal's actual doesn't meet the minimum threshold, that goal contributes $0 to your bonus",
    "Use <strong>What If Scorecard</strong> to understand what actuals you'd need to hit a target bonus"
  ],
  manager: [
    "All goal weights on a scorecard must total exactly <strong>100%</strong> — the builder warns you if they don't",
    "Scorecards are <strong>capped at 200%</strong> total weighted achievement",
    "Achievements of <strong>120%+</strong> are flagged for review but not capped",
    "If a goal's actual doesn't meet the minimum threshold, that goal contributes $0 to the bonus",
    "Department actuals only need to be entered once — they apply to all scorecards in that department for the month"
  ],
  admin: [
    "Upload Rippling data for the <strong>previous completed month</strong> — e.g. upload May's data in June once payroll is finalized",
    "All goal weights on a scorecard must total exactly <strong>100%</strong> — the builder warns you if they don't",
    "Scorecards are <strong>capped at 200%</strong> total weighted achievement",
    "Achievements of <strong>120%+</strong> are flagged for review but not capped",
    "If a goal's actual doesn't meet the minimum threshold, that goal contributes $0 to the bonus",
    "Goals can be <strong>deactivated</strong> in the Goal Bank without deleting them, keeping history intact",
    "Use <strong>Maintenance Mode</strong> (under Users) to lock out non-admin users while making bulk changes"
  ]
};

function GuideScreen({ profile }: { profile: ManagerProfile | null }) {
  const userRole = profile?.role ?? "user";
  const canSwitchView = userRole === "admin" || userRole === "manager";
  const availableTabs: Array<"user" | "manager" | "admin"> =
    userRole === "admin" ? ["admin", "manager", "user"] :
    userRole === "manager" ? ["manager", "user"] : ["user"];
  const [viewAs, setViewAs] = useState<"user" | "manager" | "admin">(
    userRole === "admin" ? "admin" : userRole === "manager" ? "manager" : "user"
  );

  const steps = guideStepsByRole[viewAs];
  const tips = guideTipsByRole[viewAs];
  const tabLabel: Record<string, string> = { admin: "Admin", manager: "Manager", user: "Employee" };

  return (
    <div className="screen active">
      <section>
        <div className="section-title">How to use this app</div>
        <p style={{ fontSize: "13px", color: "var(--text-muted)", lineHeight: 1.7, marginTop: "4px" }}>
          {viewAs === "user" && "As an employee, you can view your submitted scorecards and use the What If tool to model bonus scenarios."}
          {viewAs === "manager" && "As a manager, you enter actuals, build and submit scorecards for your team, and review historical data."}
          {viewAs === "admin" && "As an admin, you manage the full monthly workflow — from uploading payroll data to submitting scorecards and managing users."}
        </p>
        {canSwitchView && (
          <div style={{ display: "flex", gap: "6px", marginTop: "14px" }}>
            {availableTabs.map((tab) => (
              <button
                key={tab}
                onClick={() => setViewAs(tab)}
                style={{
                  padding: "5px 14px", fontSize: "12px", fontFamily: "var(--sans)", fontWeight: 600,
                  border: "1.5px solid var(--border)", borderRadius: "99px", cursor: "pointer",
                  background: viewAs === tab ? "var(--brick)" : "var(--surface2)",
                  color: viewAs === tab ? "#fff" : "var(--text-muted)",
                  transition: "background 0.15s, color 0.15s"
                }}
              >
                {tabLabel[tab]}
              </button>
            ))}
          </div>
        )}
      </section>
      {steps.map((step, index) => (
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
          {tips.map((t) => <li key={t} dangerouslySetInnerHTML={{ __html: t }} />)}
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
  periodActuals: ActualsByKey;
  workMonth: string;
}) {
  const isUser = props.profile?.role === "user";
  const defaultEmpName = isUser ? (props.profile?.linkedEmployeeName || "") : "";
  const [selectedEmpName, setSelectedEmpName] = useState(defaultEmpName);
  const [earningsInput, setEarningsInput] = useState("");
  const [hourlyRateInput, setHourlyRateInput] = useState("");
  const [playGoals, setPlayGoals] = useState<PlayGoal[]>([]);
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
      if (g.goalTier === "company") return false; // company goals must be added manually
      if (g.goalTier === "department") return !g.department || g.department === emp?.department;
      if (g.goalTier === "individual") {
        if (g.employeeName) return g.employeeName === emp?.name; // new: match by name
        return !g.role || g.role === emp?.role; // legacy: match by role
      }
      return false;
    });
    setPlayGoals(applicable.map((g) => ({
      id: g.id, name: g.name, goalTier: g.goalTier, location: g.location, department: g.department,
      role: g.role, lowerBetter: g.lowerBetter, capped: g.capped, capPct: g.capPct,
      target: String(g.goalValue || ""), min: String(g.minValue || ""), actual: "",
      weight: "0"
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

  function updateGoal(id: string, field: keyof PlayGoal, value: string) {
    setPlayGoals((prev) => prev.map((pg) => pg.id === id ? { ...pg, [field]: value } : pg));
  }

  function loadCurrentScorecard() {
    const emp = props.latestEmployees.find((e) => e.name === selectedEmpName);
    if (!emp) return;
    // Pre-fill earnings from Rippling data
    const earnings = baseEarnings({ payType: emp.payType, hourlyRate: emp.hourlyRate, hours: emp.hoursWorked, annualPay: emp.annualPay, grossEarnings: emp.grossEarnings });
    if (earnings > 0) setEarningsInput(earnings.toFixed(2));
    if (emp.hourlyRate) setHourlyRateInput(String(emp.hourlyRate));
    // Load goals with targets/mins/actuals from the current period actuals
    const applicable = props.allGoals.filter((g) => {
      if (g.goalTier === "company") return false;
      if (g.goalTier === "department") return !g.department || g.department === emp.department;
      if (g.goalTier === "individual") {
        if (g.employeeName) return g.employeeName === emp.name;
        return !g.role || g.role === emp.role;
      }
      return false;
    });
    const n = applicable.length;
    const allHaveWeight = applicable.every((g) => g.weight != null && g.weight > 0);
    const eq = n > 0 ? Number((100 / n).toFixed(2)) : 0;
    setPlayGoals(applicable.map((g, i) => {
      const tVal = props.periodActuals[metaKey("target", g)];
      const mVal = props.periodActuals[metaKey("min", g)];
      const aVal = g.goalTier !== "individual" ? props.periodActuals[actualKey(g)] : null;
      const defaultWeight = allHaveWeight ? g.weight! : (i === n - 1 ? Number((100 - eq * (n - 1)).toFixed(2)) : eq);
      return {
        id: g.id, name: g.name, goalTier: g.goalTier, location: g.location, department: g.department,
        role: g.role, lowerBetter: g.lowerBetter, capped: g.capped, capPct: g.capPct,
        target: tVal != null ? String(tVal) : String(g.goalValue || ""),
        min: mVal != null ? String(mVal) : String(g.minValue || ""),
        actual: aVal != null ? String(aVal) : "",
        weight: String(defaultWeight)
      };
    }));
  }

  return (
    <div className="screen active">
      <p className="mb-1 text-[13px] text-muted-foreground">
        Explore how changes to targets, actuals, and weights affect bonus calculations. Nothing here is saved.
      </p>

      <section>
        <div className="flex flex-wrap items-end gap-3">
          {!isUser && (
            <DrawerField label="Employee" className="min-w-[12rem] flex-1">
              <Select value={selectedEmpName || undefined} onValueChange={(v) => setSelectedEmpName(v)}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Select employee…" /></SelectTrigger>
                <SelectContent>
                  {employeeOptions.map((emp) => <SelectItem key={emp.id} value={emp.name}>{emp.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </DrawerField>
          )}
          {isUser && props.profile?.linkedEmployeeName && (
            <DrawerField label="Employee" className="min-w-[12rem] flex-1">
              <div className="flex h-9 items-center rounded-md border border-input bg-muted/50 px-3 text-[13px] text-foreground">{props.profile.linkedEmployeeName}</div>
            </DrawerField>
          )}
          <DrawerField label="Base earnings" htmlFor="wi-earnings" className="w-[140px]">
            <Input id="wi-earnings" type="number" value={earningsInput} onChange={(e) => setEarningsInput(e.target.value)} placeholder="0.00" className="tabular-nums" />
          </DrawerField>
          <DrawerField label="Hourly rate" htmlFor="wi-hourly" className="w-[130px]">
            <Input id="wi-hourly" type="number" value={hourlyRateInput} onChange={(e) => setHourlyRateInput(e.target.value)} placeholder="0.00" className="tabular-nums" />
          </DrawerField>
          {selectedEmpName && (
            <div className="flex flex-col gap-1 pb-1">
              <button
                onClick={loadCurrentScorecard}
                style={{ padding: "6px 14px", fontSize: "12px", fontFamily: "var(--sans)", fontWeight: 600, border: "1.5px solid var(--brick)", borderRadius: "var(--radius-sm)", background: "var(--brick-light)", color: "var(--brick)", cursor: "pointer", whiteSpace: "nowrap" }}
                title={`Load goals, targets, actuals, and earnings from ${formatMonthLabel(props.workMonth)}`}
              >
                ↓ Use current scorecard
              </button>
              {selectedEmp && (
                <div className="text-[11px] text-muted-foreground">
                  {selectedEmp.role}{selectedEmp.department ? ` · ${selectedEmp.department}` : ""}{selectedEmp.location ? ` · ${selectedEmp.location}` : ""}
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {selectedEmpName && (
        <section style={{ padding: 0 }} className="overflow-hidden">
          {playGoals.length > 0 ? (
            <Table className="text-[12px]">
              <TableHeader className="bg-muted/40 [&_th]:h-8 [&_th]:px-2 [&_th]:text-[10px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted-foreground">
                <TableRow className="hover:bg-transparent">
                  <TableHead>Type</TableHead>
                  <TableHead>Goal</TableHead>
                  <TableHead className="text-center">Target</TableHead>
                  <TableHead className="text-center">Min</TableHead>
                  <TableHead className="text-center">Actual</TableHead>
                  <TableHead className="text-center">Lower</TableHead>
                  <TableHead className="text-center">Weight</TableHead>
                  <TableHead className="text-center">Achieve</TableHead>
                  <TableHead className="text-right">Bonus</TableHead>
                  <TableHead className="w-8" />
                </TableRow>
              </TableHeader>
              <TableBody className="[&_td]:px-2 [&_td]:py-1.5">
                {playGoals.map((pg, i) => {
                  const sc = liveGoals[i];
                  const isCustom = pg.id.startsWith("custom-");
                  return (
                    <TableRow key={pg.id} className="group hover:bg-transparent">
                      <TableCell>
                        {isCustom ? (
                          <Select value={pg.goalTier} onValueChange={(v) => updateGoal(pg.id, "goalTier", v)}>
                            <SelectTrigger size="sm" className="h-7 w-[112px] text-[11px]"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="company">Company</SelectItem>
                              <SelectItem value="department">Department</SelectItem>
                              <SelectItem value="individual">Individual</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : <TierBadge tier={pg.goalTier} />}
                      </TableCell>
                      <TableCell className="font-medium text-foreground">
                        {isCustom ? (
                          <Input type="text" value={pg.name} onChange={(e) => updateGoal(pg.id, "name", e.target.value)} placeholder="Goal name" className="h-7 w-[150px] text-[12px]" />
                        ) : <span className="flex items-center gap-1.5">{pg.name}<GoalScopeTags location={pg.location} department={pg.department} /></span>}
                      </TableCell>
                      <TableCell className="text-center"><Input type="number" value={pg.target} onChange={(e) => updateGoal(pg.id, "target", e.target.value)} className="h-7 w-[72px] text-center text-[12px] tabular-nums" /></TableCell>
                      <TableCell className="text-center"><Input type="number" value={pg.min} onChange={(e) => updateGoal(pg.id, "min", e.target.value)} className="h-7 w-[72px] text-center text-[12px] tabular-nums" /></TableCell>
                      <TableCell className="text-center"><Input type="number" value={pg.actual} onChange={(e) => updateGoal(pg.id, "actual", e.target.value)} placeholder="—" className="h-7 w-[72px] text-center text-[12px] tabular-nums" /></TableCell>
                      <TableCell className="text-center">
                        <Button type="button" variant={pg.lowerBetter ? "default" : "outline"} size="sm" className="h-7 px-2.5 text-[11px]" title={pg.lowerBetter ? "Lower is better (click to toggle)" : "Higher is better (click to toggle)"} onClick={() => setPlayGoals((prev) => prev.map((g) => g.id === pg.id ? { ...g, lowerBetter: !g.lowerBetter } : g))}>
                          {pg.lowerBetter ? "Yes" : "No"}
                        </Button>
                      </TableCell>
                      <TableCell className="text-center"><Input type="number" value={pg.weight} onChange={(e) => updateGoal(pg.id, "weight", e.target.value)} className="h-7 w-[64px] text-center text-[12px] tabular-nums" /></TableCell>
                      <TableCell className="text-center font-semibold tabular-nums">
                        {sc.actual != null
                          ? (sc.metMin
                            ? <span style={{ color: sc.achievement >= 100 ? "#2D6B1A" : "var(--brick)" }}>{sc.achievement.toFixed(1)}%</span>
                            : <span className="text-[#9B2C2C]">Below min</span>)
                          : <span className="text-[var(--text-faint)]">—</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(sc.bonusContribution)}</TableCell>
                      <TableCell className="text-right">
                        <button type="button" title="Remove goal" onClick={() => setPlayGoals((prev) => prev.filter((g) => g.id !== pg.id))} className="inline-flex size-6 items-center justify-center rounded-md text-[#9B2C2C] opacity-0 transition-opacity hover:bg-[#9B2C2C]/10 focus-visible:opacity-100 group-hover:opacity-100">
                          <X className="size-3.5" />
                        </button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <div className="px-4 py-6 text-center text-[13px] text-muted-foreground">No goals found for this employee. Add one below.</div>
          )}

          <div className="flex flex-wrap items-center gap-2.5 border-t border-border px-3 py-3">
            <Button variant="outline" size="sm" className="text-[12px]" onClick={() => {
              setPlayGoals((prev) => [
                ...prev.map((g) => ({ ...g, weight: "0" })),
                { id: `custom-${Date.now()}`, name: "", goalTier: "individual" as const, lowerBetter: false, capped: "no" as const, capPct: 100, target: "", min: "", actual: "", weight: "0" }
              ]);
            }}>+ Add goal</Button>
            <span className={`ml-auto text-[11.5px] tabular-nums ${totalWeight !== 100 ? "font-semibold text-primary" : "text-muted-foreground"}`}>
              Total weight: {totalWeight.toFixed(1)}%{totalWeight !== 100 ? " — must equal 100" : ""}
            </span>
          </div>
        </section>
      )}

      {selectedEmpName && playGoals.length > 0 && (
        <div>
          <h2 className="mb-3 text-[13px] font-semibold text-foreground">Live results</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <KpiTile label="Base earnings" value={formatCurrency(earnings)} />
            <KpiTile label="Weighted achievement" value={`${weightedAchievement.toFixed(1)}%`} sub={weightedAchievement > 200 ? "capped at 200%" : undefined} accent />
            <KpiTile label="Estimated bonus" value={formatCurrency(bonusAmount)} accent />
            <KpiTile label="Total pay" value={formatCurrency(earnings + bonusAmount)} />
            {effectiveHourly !== null && <KpiTile label="Effective hourly" value={`$${effectiveHourly.toFixed(2)}/hr`} />}
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
