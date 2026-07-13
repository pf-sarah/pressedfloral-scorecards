import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getReportingTree } from "../../../../lib/reportingTree";
import { employeeFromRow } from "../../../../lib/supabase";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return NextResponse.json({ error: "Server not configured." }, { status: 500 });

  const authorization = request.headers.get("authorization") || "";
  const [scheme, token] = authorization.split(" ");
  const bearerToken = scheme?.toLowerCase() === "bearer" && token ? token : "";
  if (!bearerToken) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const client = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: { user }, error: authError } = await client.auth.getUser(bearerToken);
  if (authError || !user) return NextResponse.json({ error: "Invalid session." }, { status: 401 });

  const profileResult = await client
    .from("manager_profiles")
    .select("role, linked_employee_name, company_goals_grant")
    .eq("id", user.id)
    .maybeSingle();
  if (profileResult.error) return NextResponse.json({ error: profileResult.error.message }, { status: 500 });

  const profile = profileResult.data;
  if (!profile) return NextResponse.json({ access: false });
  if (profile.role === "admin" || profile.company_goals_grant === true) return NextResponse.json({ access: true });

  const linkedEmployeeName = typeof profile.linked_employee_name === "string" ? profile.linked_employee_name.trim() : "";
  if (!linkedEmployeeName) return NextResponse.json({ access: false });

  const grantedResult = await client
    .from("manager_profiles")
    .select("linked_employee_name")
    .eq("company_goals_grant", true);
  if (grantedResult.error) return NextResponse.json({ error: grantedResult.error.message }, { status: 500 });

  const grantedManagerNames = (grantedResult.data || [])
    .map((row) => (typeof row.linked_employee_name === "string" ? row.linked_employee_name.trim() : ""))
    .filter(Boolean);
  if (grantedManagerNames.length === 0) return NextResponse.json({ access: false });

  const latestPeriodResult = await client
    .from("rippling_employees")
    .select("period")
    .order("period", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestPeriodResult.error) return NextResponse.json({ error: latestPeriodResult.error.message }, { status: 500 });
  const latestPeriod = latestPeriodResult.data?.period;
  if (!latestPeriod) return NextResponse.json({ access: false });

  const employeesResult = await client.from("rippling_employees").select("*").eq("period", latestPeriod);
  if (employeesResult.error) return NextResponse.json({ error: employeesResult.error.message }, { status: 500 });
  const employees = (employeesResult.data || []).map(employeeFromRow);

  const access = grantedManagerNames.some((managerName) => getReportingTree(managerName, employees).has(linkedEmployeeName));
  return NextResponse.json({ access });
}
