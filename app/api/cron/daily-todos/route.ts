/**
 * Daily to-do reminder emails for Pressed Floral Scorecards.
 *
 * Triggered by Vercel Cron (see vercel.json → 0 14 * * * = 8 AM MDT / 9 AM MST).
 * Vercel automatically adds `Authorization: Bearer $CRON_SECRET` to the request.
 *
 * Required env vars:
 *   CRON_SECRET          — random string, also set in Vercel project settings
 *   RESEND_API_KEY       — from resend.com dashboard
 *   FROM_EMAIL           — verified sender, e.g. scorecards@pressedfloral.com
 *   NEXT_PUBLIC_APP_URL  — e.g. https://pressedfloralscorecards.com
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── Inline helpers (can't import from ScorecardsApp — client component) ────────

type GoalTier = "company" | "department" | "individual";

interface Goal {
  id: string;
  goalTier: GoalTier;
  location?: string;
  department?: string;
  name: string;
  active: boolean;
}

interface Profile {
  id: string;
  email: string;
  role: "admin" | "manager" | "user";
  departments: string[];
  locations: string[];
}

type ActualsByKey = Record<string, number | null>;

function actualKey(goal: Pick<Goal, "goalTier" | "location" | "department" | "name">) {
  return [goal.goalTier, goal.location || "", goal.department || "", goal.name].join("|");
}

function metaKey(
  type: "target" | "min",
  goal: Pick<Goal, "goalTier" | "location" | "department" | "name">
) {
  const loc = goal.goalTier === "department" ? "" : (goal.location || "");
  return `__${type}__${[goal.goalTier, loc, goal.department || "", goal.name].join("|")}`;
}

function formatMonthLabel(iso: string) {
  if (/^[A-Za-z]+ \d{4}$/.test(iso)) return iso;
  const [year, month] = iso.split("-").map(Number);
  if (!year || !month) return iso;
  return new Date(year, month - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
}

function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function prevMonthIso(iso: string) {
  const [y, m] = iso.split("-").map(Number);
  const prev = new Date(y, m - 2, 1);
  return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
}

function nextMonthIso(iso: string) {
  const [y, m] = iso.split("-").map(Number);
  const next = new Date(y, m, 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
}

function shortDate(d: Date) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Filter goals to what a manager can see based on their dept/location scope. */
function scopeGoals(goals: Goal[], profile: Profile): Goal[] {
  if (profile.role === "admin") return goals;
  if (profile.role === "user") return [];
  return goals.filter((g) => {
    const deptOk =
      !profile.departments.length || !g.department || profile.departments.includes(g.department);
    const locOk =
      !profile.locations.length || !g.location || profile.locations.includes(g.location);
    return deptOk && locOk;
  });
}

interface TodoItem {
  label: string;
  count: number;
  dueDate: Date;
  overdue: boolean;
}

/** Compute pending to-do items for one manager given shared app data. */
function computeTodos(
  profile: Profile,
  allGoals: Goal[],
  currentActuals: ActualsByKey,
  workActuals: ActualsByKey,
  hasRipplingThisMonth: boolean
): TodoItem[] {
  const today = new Date();
  const isAdmin = profile.role === "admin";

  // Goals visible to this manager (admins see company goals too)
  const visibleGoals = scopeGoals(allGoals, profile).filter((g) => g.active);

  // Goals eligible for targets/actuals computation (company/dept only)
  const sharedGoals = visibleGoals.filter(
    (g) =>
      g.goalTier === "department" ||
      (isAdmin && g.goalTier === "company")
  );

  const items: TodoItem[] = [];

  // ── 1. Upload Rippling data (admin only) ──────────────────────────────────
  if (isAdmin && !hasRipplingThisMonth) {
    const due = new Date(today.getFullYear(), today.getMonth(), 17);
    items.push({
      label: "Upload Rippling payroll data",
      count: 1,
      dueDate: due,
      overdue: today > due,
    });
  }

  // ── 2. Enter actuals for last month ───────────────────────────────────────
  const missingActuals = sharedGoals.filter(
    (g) =>
      workActuals[metaKey("target", g)] != null &&
      workActuals[metaKey("min", g)] != null &&
      workActuals[actualKey(g)] == null
  );
  if (missingActuals.length) {
    const due = new Date(today.getFullYear(), today.getMonth(), 17);
    items.push({
      label: `Enter actuals for ${missingActuals.length} goal${missingActuals.length > 1 ? "s" : ""}`,
      count: missingActuals.length,
      dueDate: due,
      overdue: today > due,
    });
  }

  // ── 3. Set targets for the current month ─────────────────────────────────
  const missingCurrentTargets = sharedGoals.filter(
    (g) => currentActuals[metaKey("target", g)] == null
  );
  if (missingCurrentTargets.length) {
    // "due on 1st of current month" — so always overdue once the month has started
    const due = new Date(today.getFullYear(), today.getMonth(), 1);
    items.push({
      label: `Set targets for ${missingCurrentTargets.length} goal${missingCurrentTargets.length > 1 ? "s" : ""} this month`,
      count: missingCurrentTargets.length,
      dueDate: due,
      overdue: true,
    });
  }

  return items;
}

// ── Email template ────────────────────────────────────────────────────────────

function buildEmail(profile: Profile, items: TodoItem[], appUrl: string): string {
  const total = items.reduce((sum, i) => sum + i.count, 0);

  const itemRows = items
    .map((item) => {
      const dueTxt = item.overdue
        ? `<span style="color:#b04020;font-weight:600;">overdue</span>`
        : `due ${shortDate(item.dueDate)}`;
      return `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #ede9e4;">
          <span style="font-size:14px;color:#8B3A2A;margin-right:8px;">●</span>
          <span style="font-size:14px;color:#2a2319;font-weight:500;">${item.label}</span>
          &nbsp;&nbsp;<span style="font-size:12px;color:#7a7268;">${dueTxt}</span>
        </td>
      </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Pending To-Dos — Pressed Floral Scorecards</title>
</head>
<body style="margin:0;padding:0;background:#f5f2ef;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f2ef;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;border:1px solid #ddd8d0;overflow:hidden;max-width:520px;">

          <!-- Header -->
          <tr>
            <td style="background:#8B3A2A;padding:22px 32px;">
              <div style="font-size:18px;font-weight:700;color:#fff;letter-spacing:-0.3px;">Pressed Floral</div>
              <div style="font-size:11px;color:rgba(255,255,255,0.7);font-family:monospace;margin-top:2px;">Scorecards</div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:28px 32px;">
              <p style="font-size:15px;color:#2a2319;margin:0 0 6px;">
                You have <strong>${total} pending to-do${total > 1 ? "s" : ""}</strong> in Scorecards:
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;">
                ${itemRows}
              </table>

              <!-- CTA -->
              <div style="margin-top:28px;text-align:center;">
                <a href="${appUrl}" style="display:inline-block;background:#8B3A2A;color:#fff;font-size:14px;font-weight:600;text-decoration:none;padding:12px 28px;border-radius:6px;letter-spacing:0.01em;">View My To-Do List →</a>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#faf8f5;border-top:1px solid #ede9e4;padding:16px 32px;text-align:center;">
              <p style="font-size:11px;color:#9a9080;margin:0;">
                You're receiving this because you have a manager account in Pressed Floral Scorecards.<br/>
                These reminders stop automatically once your to-do list is clear.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  // ── Auth: verify Vercel cron secret ────────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  // ── Config ─────────────────────────────────────────────────────────────────
  const resendKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.FROM_EMAIL ?? "Scorecards <onboarding@resend.dev>";
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://pressedfloralscorecards.com";

  if (!resendKey) {
    return NextResponse.json({ error: "RESEND_API_KEY not set" }, { status: 500 });
  }

  // ── Supabase service client ────────────────────────────────────────────────
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json({ error: "Supabase env vars missing" }, { status: 500 });
  }
  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Date math ──────────────────────────────────────────────────────────────
  const currentIso = isoToday();           // e.g. "2026-05"
  const workIso = prevMonthIso(currentIso); // e.g. "2026-04"
  const currentLabel = formatMonthLabel(currentIso); // e.g. "May 2026"
  const workLabel = formatMonthLabel(workIso);        // e.g. "April 2026"

  // ── Fetch data ─────────────────────────────────────────────────────────────
  const [goalsRes, actualsRes, ripplingRes, usersRes] = await Promise.all([
    sb.from("goals_bank").select("id,goal_tier,location,department,name,active"),
    sb
      .from("actuals")
      .select("period,goal_tier,location,department,goal_name,actual_value")
      .in("period", [currentLabel, workLabel]),
    sb
      .from("rippling_employees")
      .select("id", { count: "exact", head: true })
      .eq("period", currentLabel),
    sb.auth.admin.listUsers({ page: 1, perPage: 1000 }),
  ]);

  if (goalsRes.error) return NextResponse.json({ error: goalsRes.error.message }, { status: 500 });
  if (actualsRes.error) return NextResponse.json({ error: actualsRes.error.message }, { status: 500 });

  const profilesRes = await sb.from("manager_profiles").select("*");
  if (profilesRes.error) return NextResponse.json({ error: profilesRes.error.message }, { status: 500 });

  // ── Build lookup maps ──────────────────────────────────────────────────────
  const goals: Goal[] = (goalsRes.data ?? []).map((r) => ({
    id: String(r.id),
    goalTier: r.goal_tier as GoalTier,
    location: r.location || "",
    department: r.department || "",
    name: r.name,
    active: r.active !== false,
  }));

  // Bucket actuals by period
  const currentActuals: ActualsByKey = {};
  const workActuals: ActualsByKey = {};
  for (const row of actualsRes.data ?? []) {
    const gn: string = row.goal_name || "";
    const key =
      gn.startsWith("__target__") || gn.startsWith("__min__") || gn.startsWith("__monthly_inactive__")
        ? gn
        : [row.goal_tier, row.location || "", row.department || "", gn].join("|");
    if (row.period === currentLabel) currentActuals[key] = row.actual_value;
    else if (row.period === workLabel) workActuals[key] = row.actual_value;
  }

  const hasRippling = (ripplingRes.count ?? 0) > 0;

  // Build email → id map
  const authEmailById: Record<string, string> = {};
  for (const u of usersRes.data?.users ?? []) {
    if (u.email) authEmailById[u.id] = u.email;
  }

  // Build profile list (admins + managers only — users have no todos)
  const profiles: Profile[] = (profilesRes.data ?? [])
    .filter((r) => r.role === "admin" || r.role === "manager")
    .map((r) => ({
      id: String(r.id),
      email: authEmailById[r.id] ?? "",
      role: r.role as "admin" | "manager",
      departments: Array.isArray(r.departments) ? r.departments : [],
      locations: Array.isArray(r.locations) ? r.locations : [],
    }))
    .filter((p) => !!p.email);

  // ── Send emails ────────────────────────────────────────────────────────────
  const resend = new Resend(resendKey);
  const results: { email: string; status: string; todoCount: number }[] = [];

  for (const profile of profiles) {
    const items = computeTodos(profile, goals, currentActuals, workActuals, hasRippling);
    if (!items.length) {
      results.push({ email: profile.email, status: "skipped (no todos)", todoCount: 0 });
      continue;
    }

    const total = items.reduce((s, i) => s + i.count, 0);
    const html = buildEmail(profile, items, appUrl);

    try {
      await resend.emails.send({
        from: fromEmail,
        to: profile.email,
        subject: `📋 You have ${total} pending to-do${total > 1 ? "s" : ""} in Scorecards`,
        html,
      });
      results.push({ email: profile.email, status: "sent", todoCount: total });
    } catch (err) {
      results.push({
        email: profile.email,
        status: `error: ${err instanceof Error ? err.message : String(err)}`,
        todoCount: total,
      });
    }
  }

  return NextResponse.json({ ok: true, date: currentLabel, results });
}
