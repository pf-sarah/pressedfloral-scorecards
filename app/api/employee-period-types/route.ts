import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

// Returns a map of employeeName -> "quarterly" for employees whose linked user
// account has scorecardPeriodType = "quarterly". Only quarterly entries are
// returned (everything else defaults to "monthly" on the client).
export async function GET(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return NextResponse.json({ error: "Server not configured." }, { status: 500 });

  const authorization = request.headers.get("authorization") || "";
  const [scheme, token] = authorization.split(" ");
  const bearerToken = scheme?.toLowerCase() === "bearer" && token ? token : "";
  if (!bearerToken) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const client = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { error: authError } = await client.auth.getUser(bearerToken);
  if (authError) return NextResponse.json({ error: "Invalid session." }, { status: 401 });

  const { data, error } = await client
    .from("manager_profiles")
    .select("linked_employee_name")
    .eq("scorecard_period_type", "quarterly")
    .not("linked_employee_name", "is", null);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const result: Record<string, "quarterly"> = {};
  for (const row of data || []) {
    if (row.linked_employee_name) result[row.linked_employee_name] = "quarterly";
  }

  return NextResponse.json({ periodTypes: result });
}
