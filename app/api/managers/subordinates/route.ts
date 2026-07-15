import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

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

  // Verify the caller's session
  const { data: { user }, error: authError } = await client.auth.getUser(bearerToken);
  if (authError || !user) return NextResponse.json({ error: "Invalid session." }, { status: 401 });

  // Return profiles of managers who list this user as their supervisor
  const { data, error } = await client
    .from("manager_profiles")
    .select("id, role, departments, locations, linked_employee_name, supervisor_id, company_goals_grant")
    .eq("supervisor_id", user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Also walk the full reporting chain below this user (direct reports, their reports, etc.) so
  // callers can tell "is this reviewer somewhere under me" — used to let a manager approve/return
  // a subordinate's assigned scorecard when that subordinate (the direct reviewer) is unavailable.
  // Capped at 10 levels as a defensive guard against a cyclic supervisor_id graph.
  const descendantIds = new Set<string>();
  let frontier = [user.id];
  for (let depth = 0; depth < 10 && frontier.length > 0; depth++) {
    const { data: children, error: childError } = await client
      .from("manager_profiles")
      .select("id")
      .in("supervisor_id", frontier);
    if (childError) break;
    const newIds = (children || []).map((c) => String(c.id)).filter((id) => !descendantIds.has(id));
    newIds.forEach((id) => descendantIds.add(id));
    frontier = newIds;
  }

  return NextResponse.json({ profiles: data || [], descendantIds: Array.from(descendantIds) });
}
