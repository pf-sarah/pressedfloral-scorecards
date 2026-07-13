import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("Server not configured.");
  return createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function verifySession(request: NextRequest) {
  const authorization = request.headers.get("authorization") || "";
  const [scheme, token] = authorization.split(" ");
  const bearerToken = scheme?.toLowerCase() === "bearer" && token ? token : "";
  if (!bearerToken) return null;
  const client = serviceClient();
  const { error } = await client.auth.getUser(bearerToken);
  if (error) return null;
  return client;
}

// PUT /api/scorecard-settings — upsert an employee's scorecard settings
export async function PUT(request: NextRequest) {
  let client;
  try { client = await verifySession(request); } catch { return NextResponse.json({ error: "Server not configured." }, { status: 500 }); }
  if (!client) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const body = await request.json();
  const { employeeName, periodType, excludedGoalIds, addedGoalIds, weightOverrides, updatedAt, updatedBy } = body;

  if (!employeeName || !periodType) return NextResponse.json({ error: "Missing required fields." }, { status: 400 });

  const { data, error } = await client
    .from("employee_scorecard_settings")
    .upsert(
      {
        employee_name: employeeName,
        period_type: periodType,
        excluded_goal_ids: excludedGoalIds ?? [],
        added_goal_ids: addedGoalIds ?? [],
        weight_overrides: weightOverrides ?? {},
        updated_at: updatedAt,
        updated_by: updatedBy,
      },
      { onConflict: "employee_name,period_type" }
    )
    .select("id")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ id: data.id });
}
