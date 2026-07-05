/**
 * F1 — standalone login (outside the shell). Server-side sessions; five
 * failures lock the account for 15 minutes.
 */
"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Input } from "@/design-system/primitives";
import { apiFetch } from "@/lib/api-client";
import { useAuth } from "@/lib/auth/client";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { refresh } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(body?.error ?? "Sign-in failed");
        return;
      }
      await refresh();
      router.replace(params.get("next") || "/inbox");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="factory-login">
      <form className="card" onSubmit={submit}>
        <div className="brandrow">
          <span className="mark">N</span>
          <span className="word">
            Nexus <b>Factory</b>
          </span>
        </div>
        <Input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          required
        />
        <Input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
        {error && <div className="err">{error}</div>}
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
