"use client";

import { useEffect, useRef, useState } from "react";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  "https://mwwqeakjxmpticvbpinc.supabase.co";
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im13d3FlYWtqeG1wdGljdmJwaW5jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5NjIxMjUsImV4cCI6MjA5MjUzODEyNX0.sqOElnGDRM2X2-TT1iMrnPBa_HK0ndDZ_31iP40jsiE";

/** A Supabase client that won't auto-process or strip the URL tokens. */
function makeClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      // Turn off auto-detection so we can handle the token ourselves
      // and keep it in the URL until we're done.
      detectSessionInUrl: false,
      persistSession: true,
    },
  });
}

type Stage = "loading" | "form" | "success" | "error";

export default function AcceptInvitePage() {
  const [stage, setStage] = useState<Stage>("loading");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const clientRef = useRef<SupabaseClient | null>(null);

  useEffect(() => {
    const client = makeClient();
    clientRef.current = client;

    // Supabase delivers tokens in several ways depending on flow type:
    //   1. PKCE (modern default):   ?code=AUTHORIZATION_CODE
    //   2. OTP hash:                ?token_hash=...&type=invite|recovery
    //   3. Implicit (legacy):       #access_token=...&type=invite|recovery
    const searchParams = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));

    const code = searchParams.get("code");
    const tokenHash = searchParams.get("token_hash");
    const queryType = searchParams.get("type"); // "invite" or "recovery"
    const accessToken = hashParams.get("access_token");
    const refreshToken = hashParams.get("refresh_token") ?? "";
    const hashType = hashParams.get("type");

    async function processInvite() {
      try {
        if (code) {
          // ── PKCE flow ──────────────────────────────────────────────────────
          const { data, error: err } = await client.auth.exchangeCodeForSession(code);
          if (err || !data.session) {
            showExpiredError();
            return;
          }
          setEmail(data.session.user.email ?? "");
          setStage("form");
        } else if (tokenHash && (queryType === "invite" || queryType === "recovery")) {
          // ── OTP / token_hash flow (invite or password reset) ───────────────
          const { data, error: err } = await client.auth.verifyOtp({
            token_hash: tokenHash,
            type: queryType as "invite" | "recovery",
          });
          if (err || !data.user) {
            showExpiredError();
            return;
          }
          setEmail(data.user.email ?? "");
          setStage("form");
        } else if (accessToken && (hashType === "invite" || hashType === "recovery")) {
          // ── Implicit / hash flow (invite or password reset) ────────────────
          const { data, error: err } = await client.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          });
          if (err || !data.user) {
            showExpiredError();
            return;
          }
          setEmail(data.user.email ?? "");
          setStage("form");
        } else {
          // No recognisable token in the URL
          setError(
            "This invite link is invalid or has already been used. Ask your admin to send a new one."
          );
          setStage("error");
        }
      } catch {
        showExpiredError();
      }
    }

    processInvite();
  }, []);

  function showExpiredError() {
    setError(
      "This invite link has expired or is no longer valid. Ask your admin to send a new invite."
    );
    setStage("error");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }

    setSubmitting(true);
    const client = clientRef.current ?? makeClient();
    const { error: updateError } = await client.auth.updateUser({ password });
    setSubmitting(false);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    setStage("success");
    setTimeout(() => {
      window.location.replace("/");
    }, 1600);
  }

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm shadow-xl">
        <CardHeader className="items-center gap-1 text-center">
          <div className="text-[20px] font-semibold tracking-tight text-primary">Pressed Floral</div>
          <div className="text-[12px] text-muted-foreground" style={{ fontFamily: "var(--mono)" }}>Scorecards</div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Loading */}
          {stage === "loading" && (
            <div className="flex items-center justify-center gap-2 py-2 text-[13px] text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Verifying your invite…
            </div>
          )}

          {/* Error */}
          {stage === "error" && (
            <>
              <div className="rounded-md border border-[#9B2C2C]/20 bg-[#9B2C2C]/10 px-3 py-2 text-[12.5px] leading-relaxed text-[#9B2C2C]">
                {error}
              </div>
              <a href="/" className="block text-center text-[13px] font-medium text-primary hover:underline">
                Back to sign in
              </a>
            </>
          )}

          {/* Password setup form */}
          {stage === "form" && (
            <>
              <div className="space-y-1 text-center">
                <div className="text-[15px] font-semibold text-foreground">Welcome to Scorecards</div>
                <div className="text-[12.5px] text-muted-foreground">
                  {email
                    ? `Creating account for ${email}`
                    : "Set up your account to get started."}
                </div>
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="invite-password">Password</Label>
                  <Input
                    id="invite-password"
                    type="password"
                    autoFocus
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 8 characters"
                    required
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="invite-confirm">Confirm password</Label>
                  <Input
                    id="invite-confirm"
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="Re-enter your password"
                    required
                  />
                </div>

                {error && (
                  <div className="rounded-md border border-[#9B2C2C]/20 bg-[#9B2C2C]/10 px-3 py-2 text-[12.5px] text-[#9B2C2C]">
                    {error}
                  </div>
                )}

                <Button type="submit" className="w-full" disabled={submitting || !password || !confirm}>
                  {submitting ? "Setting up…" : "Set password & sign in"}
                </Button>
              </form>
            </>
          )}

          {/* Success */}
          {stage === "success" && (
            <div className="space-y-2 py-2 text-center">
              <CheckCircle2 className="mx-auto size-9 text-[var(--sage-dark)]" />
              <div className="text-[15px] font-semibold text-[var(--sage-dark)]">You&apos;re all set!</div>
              <div className="text-[13px] text-muted-foreground">Taking you to the app…</div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
