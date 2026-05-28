"use client";

import React, { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const result = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });

      if (result?.error) {
        setError("Invalid email or password.");
      } else {
        window.location.href = "/dashboard";
      }
    } catch {
      setError("An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "var(--color-mg-bg)",
        padding: "1rem",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "400px",
          backgroundColor: "var(--color-mg-bg-secondary)",
          border: "1px solid var(--color-mg-border)",
          borderRadius: "12px",
          padding: "2.5rem 2rem",
        }}
      >
        {/* Logo */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "0.75rem",
            marginBottom: "2rem",
          }}
        >
          <div
            style={{
              width: "40px",
              height: "40px",
              borderRadius: "10px",
              backgroundColor:
                "color-mix(in srgb, var(--color-mg-accent) 20%, transparent)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg
              width="24"
              height="24"
              fill="none"
              viewBox="0 0 24 24"
              stroke="var(--color-mg-accent)"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
          </div>
          <span
            style={{
              fontSize: "1.5rem",
              fontWeight: 700,
              color: "var(--color-mg-text)",
              letterSpacing: "-0.025em",
            }}
          >
            ManageT
          </span>
        </div>

        <p
          style={{
            textAlign: "center",
            color: "var(--color-mg-text-secondary)",
            fontSize: "0.875rem",
            marginBottom: "1.5rem",
          }}
        >
          Sign in to your account
        </p>

        {error && (
          <div
            style={{
              backgroundColor: "color-mix(in srgb, var(--color-mg-danger) 12%, transparent)",
              border: "1px solid color-mix(in srgb, var(--color-mg-danger) 35%, transparent)",
              borderRadius: "8px",
              padding: "0.75rem 1rem",
              marginBottom: "1rem",
              color: "var(--color-mg-danger)",
              fontSize: "0.875rem",
            }}
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: "1rem" }}>
            <label
              style={{
                display: "block",
                fontSize: "0.875rem",
                fontWeight: 500,
                color: "var(--color-mg-text-secondary)",
                marginBottom: "0.375rem",
              }}
            >
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@managet.local"
              required
              style={{
                width: "100%",
                padding: "0.625rem 0.75rem",
                backgroundColor: "var(--color-mg-bg-tertiary)",
                border: "1px solid var(--color-mg-border)",
                borderRadius: "8px",
                color: "var(--color-mg-text)",
                fontSize: "0.875rem",
                outline: "none",
                boxSizing: "border-box",
              }}
              onFocus={(e) =>
                (e.currentTarget.style.borderColor = "var(--color-mg-accent)")
              }
              onBlur={(e) =>
                (e.currentTarget.style.borderColor = "var(--color-mg-border)")
              }
            />
          </div>

          <div style={{ marginBottom: "1.5rem" }}>
            <label
              style={{
                display: "block",
                fontSize: "0.875rem",
                fontWeight: 500,
                color: "var(--color-mg-text-secondary)",
                marginBottom: "0.375rem",
              }}
            >
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              required
              style={{
                width: "100%",
                padding: "0.625rem 0.75rem",
                backgroundColor: "var(--color-mg-bg-tertiary)",
                border: "1px solid var(--color-mg-border)",
                borderRadius: "8px",
                color: "var(--color-mg-text)",
                fontSize: "0.875rem",
                outline: "none",
                boxSizing: "border-box",
              }}
              onFocus={(e) =>
                (e.currentTarget.style.borderColor = "var(--color-mg-accent)")
              }
              onBlur={(e) =>
                (e.currentTarget.style.borderColor = "var(--color-mg-border)")
              }
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            style={{
              width: "100%",
              padding: "0.625rem",
              backgroundColor: loading ? "var(--color-mg-accent-dim)" : "var(--color-mg-accent)",
              color: "#fff",
              fontWeight: 600,
              fontSize: "0.875rem",
              border: "none",
              borderRadius: "8px",
              cursor: loading ? "not-allowed" : "pointer",
              opacity: loading ? 0.7 : 1,
              transition: "background-color 0.2s, opacity 0.2s",
            }}
            onMouseEnter={(e) => {
              if (!loading) e.currentTarget.style.backgroundColor = "var(--color-mg-accent-bright)";
            }}
            onMouseLeave={(e) => {
              if (!loading) e.currentTarget.style.backgroundColor = "var(--color-mg-accent)";
            }}
          >
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
}
