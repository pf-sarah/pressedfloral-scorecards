"use client";

import { useEffect, useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { downloadCsv, parseRipplingEmployees, scorecardsToCsv, toCsv } from "../lib/csv";
import { fixtureData, fixtureMonth, fixturePeriod } from "../lib/fixtures";
import { currentMonthValue, formatMonthLabel } from "../lib/periods";
import { buildScorecard, formatCurrency, formatNumber, type EditableGoal } from "../lib/score";
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
  dataMode,
  employeeFromRow,
  employeeToRow,
  goalFromRow,
  goalToRow,
  profileFromRow,
  scorecardFromRow,
  scorecardToRow,
  supabaseClient
} from "../lib/supabase";
import type { ActualsByKey, AppData, Employee, Goal, GoalTier, HistoryFilters, ManagerProfile, Scorecard } from "../lib/types";

type Screen = "landing" | "setup" | "scorecard" | "history" | "rippling" | "guide" | "todos" | "migrate";
type HistoryView = "spreadsheet" | "scorecard";

const departments = [
  "Client Care",
  "Design",
  "Experience",
  "Fulfillment",
  "General & Administrative",
  "Growth",
  "Marketing",
  "Operations",
  "Preservation",
  "Recreation",
  "Resin"
];

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

function actualKey(goal: Pick<Goal, "goalTier" | "location" | "department" | "name">) {
  return [goal.goalTier, goal.location || "", goal.department || "", goal.name].join("|");
}

function cloneData(data: AppData): AppData {
  return JSON.parse(JSON.stringify(data)) as AppData;
}

function scopedForProfile<T extends { department?: string; location?: string }>(items: T[], profile: ManagerProfile | null) {
  if (!profile || profile.role === "admin") return items;
  return items.filter((item) => {
    const deptOk = !profile.departments.length || profile.departments.includes(item.department || "");
    const locOk = !profile.locations.length || profile.locations.includes(item.location || "");
    return deptOk && locOk;
  });
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

  const [bankMonth, setBankMonth] = useState(fixtureMonth);
  const [bankFilters, setBankFilters] = useState({ type: "all", location: "", department: "", sort: "type", showInactive: false });
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
  const [historyView, setHistoryView] = useState<HistoryView>("spreadsheet");

  const [scorecardMonth, setScorecardMonth] = useState(fixturePeriod);
  const [scorecardDept, setScorecardDept] = useState("");
  const [selectedEmployeeId, setSelectedEmployeeId] = useState("");
  const [scoreGoals, setScoreGoals] = useState<EditableGoal[]>([]);
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

    const client = supabaseClient();
    setSb(client);
    client.auth.getSession().then(async ({ data }) => {
      if (data.session?.user) await loadSupabaseProfile(client, data.session.user.id, data.session.user.email || "");
    });
    const { data: listener } = client.auth.onAuthStateChange(async (event, session) => {
      if (event === "SIGNED_IN" && session?.user) await loadSupabaseProfile(client, session.user.id, session.user.email || "");
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
    if (mode === "rippling" && profile?.role !== "admin") setMode("landing");
  }, [authenticated, mode, profile]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(timer);
  }, [toast]);

  async function loadSupabaseProfile(client: SupabaseClient, userId: string, email: string) {
    setCurrentUserEmail(email);
    localStorage.setItem(PROFILE_EMAIL_KEY, email);
    const { data } = await client.from("manager_profiles").select("*").eq("id", userId).maybeSingle();
    const loadedProfile = data ? profileFromRow(email, data) : { id: userId, email, role: "manager" as const, departments: [], locations: [] };
    setProfile(loadedProfile);
    localStorage.setItem(PROFILE_ROLE_KEY, JSON.stringify(loadedProfile));
    setAuthenticated(true);
    await loadSupabaseData(client, loadedProfile);
  }

  async function loadSupabaseData(client: SupabaseClient, loadedProfile: ManagerProfile) {
    const [goalsResult, scorecardsResult, ripplingResult] = await Promise.all([
      client.from("goals_bank").select("*").order("goal_tier").order("department").order("name"),
      client.from("scorecards").select("*").order("scorecard_month", { ascending: false }).order("employee_name"),
      client.from("rippling_employees").select("*").order("period", { ascending: false })
    ]);

    const goals = scopedForProfile((goalsResult.data || []).map(goalFromRow), loadedProfile);
    const scorecards = scopedForProfile((scorecardsResult.data || []).map(scorecardFromRow), loadedProfile);
    const rippling: Record<string, Employee[]> = {};
    for (const row of ripplingResult.data || []) {
      const period = row.period || fixtureMonth;
      rippling[period] = [...(rippling[period] || []), employeeFromRow(row)];
    }
    setAppData((current) => ({ ...current, goals, scorecards, rippling }));
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

  const months = useMemo(() => {
    const values = new Set<string>([fixtureMonth, ...Object.keys(appData.rippling), ...appData.scorecards.map((sc) => sc.scorecardMonth)]);
    return Array.from(values).sort().reverse();
  }, [appData.rippling, appData.scorecards]);

  const visibleGoals = useMemo(() => {
    let goals = scopedForProfile(appData.goals, profile);
    if (!bankFilters.showInactive) goals = goals.filter((goal) => goal.active);
    if (bankFilters.type !== "all") goals = goals.filter((goal) => goal.goalTier === bankFilters.type);
    if (bankFilters.location) goals = goals.filter((goal) => !goal.location || goal.location === bankFilters.location);
    if (bankFilters.department) goals = goals.filter((goal) => goal.department === bankFilters.department);
    return [...goals].sort((a, b) => {
      const field = bankFilters.sort as keyof Goal;
      return String(a[field] || "").localeCompare(String(b[field] || "")) || a.name.localeCompare(b.name);
    });
  }, [appData.goals, bankFilters, profile]);

  const selectedEmployee = useMemo(() => {
    const employees = Object.values(appData.rippling).flat();
    return employees.find((employee) => employee.id === selectedEmployeeId || employee.name === selectedEmployeeId) || null;
  }, [appData.rippling, selectedEmployeeId]);

  const scorecardPreview = useMemo(() => {
    if (!selectedEmployee || !scoreGoals.length) return null;
    return buildScorecard({
      employee: selectedEmployee,
      month: scorecardMonth,
      periodType: scorecardMonth.startsWith("Q") ? "quarterly" : "monthly",
      goals: scoreGoals,
      submittedBy: currentUserEmail
    });
  }, [currentUserEmail, scoreGoals, scorecardMonth, selectedEmployee]);

  const filteredHistory = useMemo(() => {
    return appData.scorecards.filter((scorecard) => {
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
  }, [appData.scorecards, historyFilters]);

  const todos = useMemo(() => {
    const tasks: { label: string; detail: string; action: Screen }[] = [];
    if (!appData.rippling[bankMonth]?.length) tasks.push({ label: "Upload Rippling data", detail: `${formatMonthLabel(bankMonth)} has no saved employee data.`, action: "rippling" });
    const actuals = appData.actuals[formatMonthLabel(bankMonth)] || {};
    const missingActuals = appData.goals.filter((goal) => goal.active && (goal.goalTier === "company" || goal.goalTier === "department") && actuals[actualKey(goal)] == null);
    if (missingActuals.length) tasks.push({ label: "Enter shared actuals", detail: `${missingActuals.length} company or department goals need actuals.`, action: "setup" });
    const employees = appData.rippling[bankMonth] || [];
    const missingScorecards = employees.filter((employee) => !appData.scorecards.some((scorecard) => scorecard.employeeName === employee.name && scorecard.scorecardMonth === formatMonthLabel(bankMonth)));
    if (missingScorecards.length) tasks.push({ label: "Build team scorecards", detail: `${missingScorecards.length} employees need scorecards.`, action: "scorecard" });
    return tasks;
  }, [appData, bankMonth]);

  async function saveGoal(goal: Goal) {
    const nextGoals = appData.goals.some((item) => item.id === goal.id)
      ? appData.goals.map((item) => item.id === goal.id ? goal : item)
      : [...appData.goals, goal];
    setAppData((current) => ({ ...current, goals: nextGoals }));
    persistGoals(nextGoals);
    if (!isFixture && sb) await sb.from("goals_bank").upsert(goalToRow(goal));
    setEditingGoal(null);
    showToast("Goal saved");
  }

  async function deleteGoal(id: string) {
    const nextGoals = appData.goals.filter((goal) => goal.id !== id);
    setAppData((current) => ({ ...current, goals: nextGoals }));
    persistGoals(nextGoals);
    if (!isFixture && sb) await sb.from("goals_bank").delete().eq("id", id);
    showToast("Goal deleted");
  }

  async function toggleGoal(id: string) {
    const goal = appData.goals.find((item) => item.id === id);
    if (!goal) return;
    await saveGoal({ ...goal, active: !goal.active });
  }

  async function saveActual(goal: Goal, value: string) {
    const period = formatMonthLabel(bankMonth);
    const key = actualKey(goal);
    const nextActuals = { ...(appData.actuals[period] || {}), [key]: value === "" ? null : Number(value) };
    setAppData((current) => ({ ...current, actuals: { ...current.actuals, [period]: nextActuals } }));
    persistActuals(period, nextActuals);
    if (!isFixture && sb) {
      const [goalTier, location, department, goalName] = key.split("|");
      await sb.from("actuals").upsert({
        period,
        goal_tier: goalTier,
        location: location || null,
        department: department || null,
        goal_name: goalName,
        actual_value: value === "" ? null : Number(value)
      }, { onConflict: "period,goal_tier,location,department,goal_name" });
    }
    showToast("Actual saved");
  }

  async function saveRippling() {
    if (!ripplingMonth || !ripplingPreview.length) {
      showToast("Upload a CSV before saving", "error");
      return;
    }
    setAppData((current) => ({ ...current, rippling: { ...current.rippling, [ripplingMonth]: ripplingPreview } }));
    persistRippling(ripplingMonth, ripplingPreview);
    if (!isFixture && sb) {
      await sb.from("rippling_employees").delete().eq("period", ripplingMonth);
      await sb.from("rippling_employees").insert(ripplingPreview.map((employee) => employeeToRow(ripplingMonth, employee)));
    }
    setRipplingPreview([]);
    showToast("Rippling data saved");
  }

  function loadGoalsForEmployee(employee: Employee) {
    const period = scorecardMonth;
    const actuals = appData.actuals[period] || {};
    const applicable = appData.goals.filter((goal) => {
      if (!goal.active) return false;
      if (goal.goalTier === "company") return true;
      if (goal.goalTier === "department") return goal.department === employee.department && (!goal.location || goal.location === employee.location);
      return goal.role === employee.role && goal.department === employee.department && (!goal.location || goal.location === employee.location);
    });
    const defaultWeight = applicable.length ? Math.floor((100 / applicable.length) * 100) / 100 : 0;
    setScoreGoals(applicable.map((goal, index) => ({
      ...goal,
      scTarget: goal.goalValue,
      scMin: goal.minValue,
      scActual: actuals[actualKey(goal)] ?? null,
      scWeight: index === applicable.length - 1
        ? Number((100 - defaultWeight * (applicable.length - 1)).toFixed(2))
        : defaultWeight
    })));
  }

  async function submitScorecard() {
    if (!scorecardPreview) {
      showToast("Select an employee and goals first", "error");
      return;
    }
    const totalWeight = scoreGoals.reduce((sum, goal) => sum + Number(goal.scWeight || 0), 0);
    if (Math.abs(totalWeight - 100) > 0.01) {
      showToast("Goal weights must total 100%", "error");
      return;
    }
    const missingActuals = scoreGoals.filter((goal) => goal.scActual === null || goal.scActual === undefined || Number.isNaN(Number(goal.scActual)));
    if (missingActuals.length) {
      showToast("Enter actuals for every goal", "error");
      return;
    }
    setAppData((current) => ({
      ...current,
      scorecards: [...current.scorecards.filter((item) => item.id !== scorecardPreview.id), scorecardPreview]
    }));
    persistScorecard(scorecardPreview);
    if (!isFixture && sb) await sb.from("scorecards").insert(scorecardToRow(scorecardPreview));
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
        todoCount={todos.length}
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
          {mode === "setup" && (
            <GoalsScreen
              month={bankMonth}
              months={months}
              filters={bankFilters}
              goals={visibleGoals}
              actuals={appData.actuals[formatMonthLabel(bankMonth)] || {}}
              editingGoal={editingGoal}
              onMonth={setBankMonth}
              onFilters={setBankFilters}
              onActual={saveActual}
              onEdit={setEditingGoal}
              onSave={saveGoal}
              onDelete={deleteGoal}
              onToggle={toggleGoal}
            />
          )}
          {mode === "scorecard" && (
            <ScorecardsScreen
              month={scorecardMonth}
              dept={scorecardDept}
              profile={profile}
              employees={Object.values(appData.rippling).flat()}
              scorecards={scopedForProfile(appData.scorecards, profile)}
              selectedEmployeeId={selectedEmployeeId}
              selectedEmployee={selectedEmployee}
              goals={scoreGoals}
              preview={scorecardPreview}
              onMonth={setScorecardMonth}
              onDept={setScorecardDept}
              onEmployee={(value) => {
                setSelectedEmployeeId(value);
                const employee = Object.values(appData.rippling).flat().find((item) => item.id === value || item.name === value);
                if (employee) loadGoalsForEmployee(employee);
              }}
              onGoals={setScoreGoals}
              onSubmit={submitScorecard}
              onDeleteGoal={setDeleteModal}
            />
          )}
          {mode === "history" && (
            <HistoryScreen
              filters={historyFilters}
              view={historyView}
              scorecards={filteredHistory}
              allScorecards={appData.scorecards}
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
          {mode === "todos" && <TodosScreen tasks={todos} onMode={setMode} />}
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
    migrate: "Migrate Data"
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
  const isAdmin = props.profile?.role === "admin";
  const nav: { mode: Screen; label: string; icon: string; adminOnly?: boolean }[] = [
    { mode: "landing", label: "Home", icon: "⌂" },
    { mode: "setup", label: "Goals & Actuals", icon: "☰" },
    { mode: "scorecard", label: "Team Scorecards", icon: "👥" },
    { mode: "history", label: "Historical Data", icon: "◷" },
    { mode: "rippling", label: "Rippling Data", icon: "⇅", adminOnly: true },
    { mode: "guide", label: "How To Use", icon: "ⓘ" },
    { mode: "todos", label: "To Do", icon: "☐" },
    { mode: "migrate", label: "Migrate Data", icon: "↑" }
  ];
  return (
    <div id="sidebar">
      <div id="sidebar-header">
        <h1>Pressed Floral</h1>
        <p>Scorecards</p>
      </div>
      <nav id="sidebar-nav">
        {nav.map((item, index) => {
          if (item.adminOnly && !isAdmin) return null;
          const sectionBreak = index === 1 || index === 3 || index === 5;
          return (
            <div key={item.mode}>
              {sectionBreak && <div className="nav-section">{index === 1 ? "MANAGE" : index === 3 ? "REVIEW" : ""}</div>}
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
          {props.profile?.role === "admin" ? "Admin - full access" : `Manager - ${(props.profile?.departments || []).join(", ")}`}
        </div>
        <button onClick={props.onSignOut}>Sign out</button>
      </div>
    </div>
  );
}

function LandingScreen({ onMode, profile }: { onMode: (mode: Screen) => void; profile: ManagerProfile | null }) {
  const cards: { mode: Screen; label: string; text: string; icon: string; adminOnly?: boolean }[] = [
    { mode: "setup", label: "Goals & Actuals", text: "Manage goals and enter monthly actuals in one place.", icon: "☰" },
    { mode: "scorecard", label: "Team Scorecards", text: "View live scorecards for your team based on goals, targets, and actuals.", icon: "✎" },
    { mode: "history", label: "Historical Data", text: "Search and review submitted scorecards across all employees and time periods.", icon: "◷" },
    { mode: "rippling", label: "Rippling Data", text: "Upload monthly CSV exports to auto-fill employee pay, title, and location data.", icon: "⇅", adminOnly: true }
  ];
  return (
    <div className="screen active">
      <div className="landing-wrap">
        <div className="landing-kicker">Where would you like to go?</div>
        <div className="landing-grid">
          {cards.filter((card) => !card.adminOnly || profile?.role === "admin").map((card) => (
            <button key={card.mode} className="landing-card" onClick={() => onMode(card.mode)}>
              <span>{card.icon}</span>
              <strong>{card.label}</strong>
              <small>{card.text}</small>
            </button>
          ))}
        </div>
        <button className="guide-callout" onClick={() => onMode("guide")}>
          <span>ⓘ</span>
          <span><strong>How To Use</strong><small>Step-by-step guide to setting up and using the app.</small></span>
        </button>
      </div>
    </div>
  );
}

function GoalsScreen(props: {
  month: string;
  months: string[];
  filters: { type: string; location: string; department: string; sort: string; showInactive: boolean };
  goals: Goal[];
  actuals: ActualsByKey;
  editingGoal: Goal | null;
  onMonth: (value: string) => void;
  onFilters: (value: { type: string; location: string; department: string; sort: string; showInactive: boolean }) => void;
  onActual: (goal: Goal, value: string) => void;
  onEdit: (goal: Goal | null) => void;
  onSave: (goal: Goal) => void;
  onDelete: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="screen active">
      <section>
        <div className="toolbar-row">
          <div className="section-title">Goals & Actuals</div>
          <select value={props.month} onChange={(event) => props.onMonth(event.target.value)}>
            {props.months.map((month) => <option key={month} value={month}>{formatMonthLabel(month)}</option>)}
          </select>
          <label className="check-label"><input type="checkbox" checked={props.filters.showInactive} onChange={(event) => props.onFilters({ ...props.filters, showInactive: event.target.checked })} /> Show inactive</label>
        </div>
        <div className="filter-row">
          <select value={props.filters.type} onChange={(event) => props.onFilters({ ...props.filters, type: event.target.value })}>
            <option value="all">All types</option>
            <option value="company">Company</option>
            <option value="department">Department</option>
            <option value="individual">Individual</option>
          </select>
          <select value={props.filters.location} onChange={(event) => props.onFilters({ ...props.filters, location: event.target.value })}>
            <option value="">All locations</option>
            <option value="Utah">Utah</option>
            <option value="Georgia">Georgia</option>
            <option value="Remote">Remote</option>
          </select>
          <select value={props.filters.department} onChange={(event) => props.onFilters({ ...props.filters, department: event.target.value })}>
            <option value="">All departments</option>
            {departments.map((department) => <option key={department}>{department}</option>)}
          </select>
          <select value={props.filters.sort} onChange={(event) => props.onFilters({ ...props.filters, sort: event.target.value })}>
            <option value="goalTier">Sort: Type</option>
            <option value="department">Sort: Department</option>
            <option value="location">Sort: Location</option>
            <option value="role">Sort: Role</option>
            <option value="name">Sort: Goal Name</option>
          </select>
        </div>
      </section>
      <section>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Type</th><th>Location</th><th>Department</th><th>Role</th><th>Goal</th><th>Target</th><th>Min</th><th>Actual</th><th>Status</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {props.goals.map((goal) => (
                <tr key={goal.id} className={!goal.active ? "muted-row" : ""}>
                  <td>{goal.goalTier}</td>
                  <td>{goal.location || "-"}</td>
                  <td>{goal.department || "-"}</td>
                  <td>{goal.role || "-"}</td>
                  <td>{goal.name}</td>
                  <td>{formatNumber(goal.goalValue)}</td>
                  <td>{formatNumber(goal.minValue)}</td>
                  <td>
                    <input
                      aria-label={`Actual for ${goal.name}`}
                      type="number"
                      defaultValue={props.actuals[actualKey(goal)] ?? ""}
                      onBlur={(event) => props.onActual(goal, event.target.value)}
                    />
                  </td>
                  <td><span className={`badge ${goal.active ? "met" : "unmet"}`}>{goal.active ? "Active" : "Inactive"}</span></td>
                  <td className="actions">
                    <button onClick={() => props.onEdit(goal)}>Edit</button>
                    <button onClick={() => props.onToggle(goal.id)}>{goal.active ? "Deactivate" : "Activate"}</button>
                    <button onClick={() => props.onDelete(goal.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!props.goals.length && <div className="no-goals-msg" style={{ display: "block" }}>No goals match the current filter</div>}
        <button className="add-goal-btn" onClick={() => props.onEdit({ ...emptyGoal, id: `goal-${Date.now()}` })}>+ Add Goal to Bank</button>
      </section>
      {props.editingGoal && <GoalEditor goal={props.editingGoal} onCancel={() => props.onEdit(null)} onSave={props.onSave} />}
    </div>
  );
}

function GoalEditor({ goal, onSave, onCancel }: { goal: Goal; onSave: (goal: Goal) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(goal);
  const roles = draft.department ? rolesByDepartment[draft.department] || [] : [];
  return (
    <section className="modal-section">
      <div className="section-title">{goal.name ? "Edit Goal" : "Add Goal"}</div>
      <div className="fields-grid">
        <div className="field"><label>Type</label><select value={draft.goalTier} onChange={(event) => setDraft({ ...draft, goalTier: event.target.value as GoalTier })}><option value="company">Company</option><option value="department">Department</option><option value="individual">Individual</option></select></div>
        <div className="field"><label>Location</label><select value={draft.location || ""} onChange={(event) => setDraft({ ...draft, location: event.target.value })}><option value="">All</option><option>Utah</option><option>Georgia</option><option>Remote</option></select></div>
        <div className="field"><label>Department</label><select value={draft.department || ""} onChange={(event) => setDraft({ ...draft, department: event.target.value, role: "" })}><option value="">All</option>{departments.map((department) => <option key={department}>{department}</option>)}</select></div>
        <div className="field"><label>Role</label><select value={draft.role || ""} onChange={(event) => setDraft({ ...draft, role: event.target.value })}><option value="">All</option>{roles.map((role) => <option key={role}>{role}</option>)}</select></div>
        <div className="field half"><label>Goal Name</label><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></div>
        <div className="field"><label>Target</label><input type="number" value={draft.goalValue} onChange={(event) => setDraft({ ...draft, goalValue: Number(event.target.value) })} /></div>
        <div className="field"><label>Minimum</label><input type="number" value={draft.minValue} onChange={(event) => setDraft({ ...draft, minValue: Number(event.target.value) })} /></div>
        <div className="field"><label>Lower is Better</label><select value={String(draft.lowerBetter)} onChange={(event) => setDraft({ ...draft, lowerBetter: event.target.value === "true" })}><option value="false">No</option><option value="true">Yes</option></select></div>
        <div className="field"><label>Capped</label><select value={draft.capped} onChange={(event) => setDraft({ ...draft, capped: event.target.value as "yes" | "no" })}><option value="no">No</option><option value="yes">Yes</option></select></div>
        <div className="field"><label>Cap %</label><input type="number" value={draft.capPct} onChange={(event) => setDraft({ ...draft, capPct: Number(event.target.value) })} /></div>
      </div>
      <div className="button-row">
        <button className="submit-btn" onClick={() => onSave(draft)} disabled={!draft.name}>Save Goal</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}

function ScorecardsScreen(props: {
  month: string;
  dept: string;
  profile: ManagerProfile | null;
  employees: Employee[];
  scorecards: Scorecard[];
  selectedEmployeeId: string;
  selectedEmployee: Employee | null;
  goals: EditableGoal[];
  preview: Scorecard | null;
  onMonth: (value: string) => void;
  onDept: (value: string) => void;
  onEmployee: (value: string) => void;
  onGoals: (goals: EditableGoal[]) => void;
  onSubmit: () => void;
  onDeleteGoal: (value: { scorecardId: string; goalName: string }) => void;
}) {
  const employees = scopedForProfile(props.employees, props.profile).filter((employee) => !props.dept || employee.department === props.dept);
  const scorecards = props.scorecards.filter((scorecard) => (!props.dept || scorecard.department === props.dept) && scorecard.scorecardMonth === props.month);
  const totalWeight = props.goals.reduce((sum, goal) => sum + Number(goal.scWeight || 0), 0);
  return (
    <div className="screen active">
      <section>
        <div className="toolbar-row">
          <div className="section-title">Team Scorecards</div>
          <input type="month" value={props.month.startsWith("Q") ? currentMonthValue() : props.month.includes("-") ? props.month : fixtureMonth} onChange={(event) => props.onMonth(formatMonthLabel(event.target.value))} />
          <select value={props.dept} onChange={(event) => props.onDept(event.target.value)}>
            <option value="">All departments</option>
            {departments.map((department) => <option key={department}>{department}</option>)}
          </select>
        </div>
      </section>
      <section>
        <div className="section-title">Build scorecard</div>
        <div className="fields-grid">
          <div className="field half">
            <label>Employee</label>
            <select aria-label="Employee" value={props.selectedEmployeeId} onChange={(event) => props.onEmployee(event.target.value)}>
              <option value="">Select employee...</option>
              {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} - {employee.role}</option>)}
            </select>
          </div>
          {props.selectedEmployee && (
            <>
              <div className="field"><label>Location</label><input value={props.selectedEmployee.location} readOnly /></div>
              <div className="field"><label>Department</label><input value={props.selectedEmployee.department} readOnly /></div>
              <div className="field"><label>Base Earnings</label><input value={formatCurrency(props.selectedEmployee.grossEarnings || 0)} readOnly /></div>
            </>
          )}
        </div>
        {props.goals.length > 0 && (
          <>
            <div className="weight-bar-wrap">
              <div className="weight-bar-track"><div className="weight-bar-fill" style={{ width: `${Math.min(totalWeight, 100)}%`, background: Math.abs(totalWeight - 100) < 0.01 ? "var(--sage-dark)" : "var(--brick)" }} /></div>
              <span className="weight-label">{totalWeight.toFixed(1)}% total</span>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th>Goal</th><th>Type</th><th>Target</th><th>Min</th><th>Actual</th><th>Weight</th><th></th></tr></thead>
                <tbody>
                  {props.goals.map((goal, index) => (
                    <tr key={`${goal.id}-${index}`}>
                      <td>{goal.name}</td>
                      <td>{goal.goalTier}</td>
                      <td><input type="number" value={goal.scTarget} onChange={(event) => props.onGoals(props.goals.map((item, i) => i === index ? { ...item, scTarget: Number(event.target.value) } : item))} /></td>
                      <td><input type="number" value={goal.scMin} onChange={(event) => props.onGoals(props.goals.map((item, i) => i === index ? { ...item, scMin: Number(event.target.value) } : item))} /></td>
                      <td><input aria-label={`Scorecard actual for ${goal.name}`} type="number" value={goal.scActual ?? ""} onChange={(event) => props.onGoals(props.goals.map((item, i) => i === index ? { ...item, scActual: event.target.value === "" ? null : Number(event.target.value) } : item))} /></td>
                      <td><input type="number" value={goal.scWeight} onChange={(event) => props.onGoals(props.goals.map((item, i) => i === index ? { ...item, scWeight: Number(event.target.value) } : item))} /></td>
                      <td><button onClick={() => props.onGoals(props.goals.filter((_, i) => i !== index))}>Remove</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {props.preview && <ScorecardSummary scorecard={props.preview} />}
            <button className="submit-btn" onClick={props.onSubmit}>Submit Scorecard</button>
          </>
        )}
      </section>
      <section>
        <div className="section-title">Submitted scorecards</div>
        <div className="scorecard-list">
          {scorecards.map((scorecard) => <ScorecardCard key={scorecard.id} scorecard={scorecard} onDeleteGoal={props.onDeleteGoal} />)}
          {!scorecards.length && <div className="no-goals-msg" style={{ display: "block" }}>No scorecards found for this month</div>}
        </div>
      </section>
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
  return (
    <div className="scorecard-card">
      <button data-testid={`scorecard-card-${scorecard.id}`} className="scorecard-card-head" onClick={() => setOpen(!open)}>
        <strong>{scorecard.employeeName}</strong>
        <span>{scorecard.department} - {scorecard.scorecardMonth} - {formatCurrency(scorecard.bonusAmount)}</span>
      </button>
      {open && (
        <table className="breakdown-table">
          <thead><tr><th>Goal</th><th>Actual</th><th>Achievement</th><th>Bonus</th><th></th></tr></thead>
          <tbody>
            {scorecard.goals.map((goal) => (
              <tr key={goal.name}>
                <td>{goal.name}</td>
                <td>{goal.actual ?? "-"}</td>
                <td>{goal.metMin ? `${goal.achievement.toFixed(1)}%` : "Below min"}</td>
                <td>{formatCurrency(goal.bonusContribution)}</td>
                <td><button onClick={() => onDeleteGoal({ scorecardId: scorecard.id, goalName: goal.name })}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function HistoryScreen(props: {
  filters: HistoryFilters;
  view: HistoryView;
  scorecards: Scorecard[];
  allScorecards: Scorecard[];
  onFilters: (filters: HistoryFilters) => void;
  onView: (view: HistoryView) => void;
}) {
  const goals = Array.from(new Set(props.allScorecards.flatMap((scorecard) => scorecard.goals.map((goal) => goal.name)))).sort();
  return (
    <div className="screen active">
      <section>
        <div className="section-title">Search scorecards</div>
        <div className="fields-grid">
          <div className="field"><label>Period</label><select value={props.filters.period} onChange={(event) => props.onFilters({ ...props.filters, period: event.target.value })}><option value="">All periods</option>{Array.from(new Set(props.allScorecards.map((sc) => sc.scorecardMonth))).map((period) => <option key={period}>{period}</option>)}</select></div>
          <div className="field"><label>Search</label><input value={props.filters.search} onChange={(event) => props.onFilters({ ...props.filters, search: event.target.value })} placeholder="e.g. Jane Smith, Utah" /></div>
          <div className="field"><label>Location</label><select value={props.filters.location} onChange={(event) => props.onFilters({ ...props.filters, location: event.target.value })}><option value="">All locations</option><option>Utah</option><option>Georgia</option><option>Remote</option></select></div>
          <div className="field"><label>Department</label><select value={props.filters.department} onChange={(event) => props.onFilters({ ...props.filters, department: event.target.value })}><option value="">All departments</option>{departments.map((department) => <option key={department}>{department}</option>)}</select></div>
          <div className="field"><label>Goal</label><select value={props.filters.goal} onChange={(event) => props.onFilters({ ...props.filters, goal: event.target.value })}><option value="">All goals</option>{goals.map((goal) => <option key={goal}>{goal}</option>)}</select></div>
        </div>
      </section>
      <section>
        <div className="toolbar-row"><div className="section-title">Results</div><div><button onClick={() => props.onView("spreadsheet")}>Spreadsheet</button><button data-testid="history-scorecard-view" onClick={() => props.onView("scorecard")}>Scorecard</button></div></div>
        {props.view === "spreadsheet" ? (
          <div className="table-wrap"><table className="data-table"><thead><tr><th>Employee</th><th>Department</th><th>Location</th><th>Achievement</th><th>Bonus</th></tr></thead><tbody>{props.scorecards.map((scorecard) => <tr key={scorecard.id}><td>{scorecard.employeeName}</td><td>{scorecard.department}</td><td>{scorecard.location}</td><td>{scorecard.weightedAchievement.toFixed(1)}%</td><td>{formatCurrency(scorecard.bonusAmount)}</td></tr>)}</tbody></table></div>
        ) : (
          <div className="scorecard-list">{props.scorecards.map((scorecard) => <ScorecardCard key={scorecard.id} scorecard={scorecard} onDeleteGoal={() => {}} />)}</div>
        )}
        {!props.scorecards.length && <div className="no-goals-msg" style={{ display: "block" }}>No scorecards found for this search</div>}
      </section>
      <section className="export-section">
        <div className="section-title">Export</div>
        <button onClick={() => downloadCsv(scorecardsToCsv(props.scorecards), "scorecards-history.csv")}>Export filtered results CSV</button>
      </section>
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
  const savedEmployees = props.saved[props.month] || [];
  return (
    <div className="screen active">
      <section>
        <div className="section-title">Upload Rippling CSV</div>
        <div className="field"><label>Period</label><input type="month" value={props.month} onChange={(event) => props.onMonth(event.target.value)} /></div>
        <label id="rippling-drop-zone">
          <span className="drop-icon">CSV</span>
          <strong>Drop your Rippling CSV here</strong>
          <small>or click to browse - Active_Employees_with_Hourly_and_Annual_Base_Pay.csv</small>
          <input type="file" accept=".csv" hidden onChange={(event) => handleFile(event.target.files?.[0])} />
        </label>
      </section>
      {!!props.preview.length && <EmployeeTable title="Imported employees" employees={props.preview} action={<button className="submit-btn" onClick={props.onSave}>Save to App</button>} />}
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

function TodosScreen({ tasks, onMode }: { tasks: { label: string; detail: string; action: Screen }[]; onMode: (mode: Screen) => void }) {
  return (
    <div className="screen active"><section><div className="section-title">To Do</div>{tasks.map((task) => <div key={task.label} className="todo-card"><strong>{task.label}</strong><span>{task.detail}</span><button onClick={() => onMode(task.action)}>Open</button></div>)}{!tasks.length && <div className="no-goals-msg" style={{ display: "block" }}>No open tasks</div>}</section></div>
  );
}

function GuideScreen() {
  const steps = ["Upload Rippling Data", "Build Your Goal Bank", "Enter Company & Department Actuals", "Build Individual Scorecards", "Review Historical Data"];
  return (
    <div className="screen active">
      <section><div className="section-title">How to use this app</div><p>Follow these steps each month to set up goals, enter actuals, and build employee scorecards.</p></section>
      {steps.map((step, index) => <section key={step} className="guide-step"><div className="step-number">{index + 1}</div><div><div className="section-title">{step}</div><p>Use the matching sidebar area to complete this monthly scorecard workflow while preserving historical data.</p></div></section>)}
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
