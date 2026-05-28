"use client";

import { useEffect, useRef, useState } from "react";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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

  // ── Styles shared with the main auth card ─────────────────────────────────
  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "10px 12px",
    border: "1.5px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    fontSize: "14px",
    fontFamily: "var(--sans)",
    background: "var(--surface)",
    color: "var(--text)",
    outline: "none",
  };
  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: "11px",
    fontWeight: 700,
    color: "var(--text-muted)",
    marginBottom: "6px",
    letterSpacing: "0.05em",
    textTransform: "uppercase",
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        width: "100%",
        background: "var(--bg)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--sans)",
      }}
    >
      <div className="auth-card">
        {/* Brand */}
        <div style={{ marginBottom: "24px", textAlign: "center" }}>
          <div
            style={{
              fontSize: "22px",
              fontWeight: 700,
              color: "var(--brick)",
              lineHeight: 1.1,
            }}
          >
            Pressed Floral
          </div>
          <div
            style={{
              fontSize: "12px",
              color: "var(--text-muted)",
              fontFamily: "var(--mono)",
              marginTop: "2px",
            }}
          >
            Scorecards
          </div>
        </div>

        {/* Loading */}
        {stage === "loading" && (
          <p
            style={{
              fontSize: "13px",
              color: "var(--text-muted)",
              textAlign: "center",
            }}
          >
            Verifying your invite…
          </p>
        )}

        {/* Error */}
        {stage === "error" && (
          <>
            <div id="auth-error" style={{ marginBottom: "16px" }}>
              {error}
            </div>
            <a
              href="/"
              style={{
                display: "block",
                textAlign: "center",
                fontSize: "13px",
                color: "var(--brick)",
                textDecoration: "underline",
              }}
            >
              Back to sign in
            </a>
          </>
        )}

        {/* Password setup form */}
        {stage === "form" && (
          <>
            <div className="auth-title">Welcome to Scorecards</div>
            <div className="auth-subtitle">
              {email
                ? `Creating account for ${email}`
                : "Set up your account to get started."}
            </div>

            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: "14px" }}>
                <label style={labelStyle}>Password</label>
                <input
                  type="password"
                  autoFocus
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  required
                  style={inputStyle}
                />
              </div>

              <div style={{ marginBottom: "8px" }}>
                <label style={labelStyle}>Confirm Password</label>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Re-enter your password"
                  required
                  style={inputStyle}
                />
              </div>

              {error && (
                <div id="auth-error" style={{ marginBottom: "4px" }}>
                  {error}
                </div>
              )}

              <button
                type="submit"
                className="submit-btn"
                disabled={submitting || !password || !confirm}
              >
                {submitting ? "Setting up…" : "Set Password & Sign In"}
              </button>
            </form>
          </>
        )}

        {/* Success */}
        {stage === "success" && (
          <div style={{ textAlign: "center" }}>
            <div
              style={{
                fontSize: "36px",
                marginBottom: "12px",
                color: "var(--sage-dark)",
              }}
            >
              ✓
            </div>
            <div className="auth-title" style={{ color: "var(--sage-dark)" }}>
              You&apos;re all set!
            </div>
            <div
              style={{
                fontSize: "13px",
                color: "var(--text-muted)",
                marginTop: "8px",
              }}
            >
              Taking you to the app…
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
