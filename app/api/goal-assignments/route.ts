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

// POST /api/goal-assignments — insert a new goal assignment
export async function POST(request: NextRequest) {
  let client;
  try { client = await verifySession(request); } catch { return NextResponse.json({ error: "Server not configured." }, { status: 500 }); }
  if (!client) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const body = await request.json();
  const { goalId, employeeName, startMonth, createdBy, createdAt } = body;

  if (!goalId || !employeeName || !startMonth) return NextResponse.json({ error: "Missing required fields." }, { status: 400 });

  const { data, error } = await client
    .from("goal_assignments")
    .insert({
      goal_id: goalId,
      employee_name: employeeName,
      start_month: startMonth,
      end_month: null,
      created_by: createdBy,
      created_at: createdAt,
    })
    .select("id")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ id: data.id });
}
