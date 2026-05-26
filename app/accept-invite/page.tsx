"use client";

import { useEffect, useState } from "react";
import { createClient } from "@supabase/supabase-js";

const DEFAULT_SUPABASE_URL = "https://mwwqeakjxmpticvbpinc.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im13d3FlYWtqeG1wdGljdmJwaW5jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5NjIxMjUsImV4cCI6MjA5MjUzODEyNX0.sqOElnGDRM2X2-TT1iMrnPBa_HK0ndDZ_31iP40jsiE";

function supabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY
  );
}

type Stage = "loading" | "form" | "success" | "error";

export default function AcceptInvitePage() {
  const [stage, setStage] = useState<Stage>("loading");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // On mount: read the invite token from the URL hash and establish a session
  useEffect(() => {
    const hash = window.location.hash.slice(1); // strip leading #
    const params = new URLSearchParams(hash);
    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");
    const type = params.get("type");

    if (!accessToken || type !== "invite") {
      setStage("error");
      setError("This invite link is invalid or has already been used. Please ask your admin to send a new one.");
      return;
    }

    const client = supabase();
    client.auth
      .setSession({ access_token: accessToken, refresh_token: refreshToken || "" })
      .then(({ data, error: sessionError }) => {
        if (sessionError || !data.user) {
          setStage("error");
          setError("This invite link has expired or is no longer valid. Please ask your admin to send a new invite.");
          return;
        }
        setEmail(data.user.email || "");
        setStage("form");
      });
  }, []);

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
    const { error: updateError } = await supabase().auth.updateUser({ password });
    setSubmitting(false);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    setStage("success");
    // Brief pause so the user sees the success message, then go to the app
    setTimeout(() => {
      window.location.href = "/";
    }, 1800);
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--sans)",
      }}
    >
      <div className="auth-card">
        {/* Logo / brand */}
        <div style={{ marginBottom: "24px", textAlign: "center" }}>
          <div style={{ fontSize: "22px", fontWeight: 700, color: "var(--brick)", lineHeight: 1.1 }}>
            Pressed Floral
          </div>
          <div style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "var(--mono)", marginTop: "2px" }}>
            Scorecards
          </div>
        </div>

        {stage === "loading" && (
          <p style={{ fontSize: "13px", color: "var(--text-muted)", textAlign: "center" }}>
            Verifying your invite…
          </p>
        )}

        {stage === "error" && (
          <>
            <div id="auth-error" style={{ marginBottom: "16px" }}>{error}</div>
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

        {stage === "form" && (
          <>
            <div className="auth-title">Welcome to Scorecards</div>
            <div className="auth-subtitle">
              {email ? `Setting up account for ${email}` : "Set up your account to get started"}
            </div>

            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: "14px" }}>
                <label
                  style={{
                    display: "block",
                    fontSize: "11px",
                    fontWeight: 700,
                    color: "var(--text-muted)",
                    marginBottom: "6px",
                    letterSpacing: "0.05em",
                    textTransform: "uppercase",
                  }}
                >
                  Password
                </label>
                <input
                  type="password"
                  autoFocus
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  required
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    border: "1.5px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    fontSize: "14px",
                    fontFamily: "var(--sans)",
                    background: "var(--surface)",
                    color: "var(--text)",
                    outline: "none",
                  }}
                />
              </div>

              <div style={{ marginBottom: "8px" }}>
                <label
                  style={{
                    display: "block",
                    fontSize: "11px",
                    fontWeight: 700,
                    color: "var(--text-muted)",
                    marginBottom: "6px",
                    letterSpacing: "0.05em",
                    textTransform: "uppercase",
                  }}
                >
                  Confirm Password
                </label>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Re-enter your password"
                  required
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    border: "1.5px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    fontSize: "14px",
                    fontFamily: "var(--sans)",
                    background: "var(--surface)",
                    color: "var(--text)",
                    outline: "none",
                  }}
                />
              </div>

              {error && <div id="auth-error">{error}</div>}

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

        {stage === "success" && (
          <div style={{ textAlign: "center" }}>
            <div
              style={{
                fontSize: "32px",
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
