/**
 * FP11.1 — PUBLIC join page: an invitee opens the link, sees their email + role,
 * sets a display name + password, and lands in the app. No app chrome, no session
 * until they accept. Operator-facing → English.
 */
"use client";

import { use, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";

type Invite = { email: string; roleName: string };

export default function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch(`/api/team/accept/${token}`)
      .then(async (r) => (r.ok ? (setInvite(await r.json())) : Promise.reject((await r.json()).error)))
      .catch((e) => setError(typeof e === "string" ? e : "This invitation could not be loaded."));
  }, [token]);

  const accept = async () => {
    if (!name.trim() || pw.length < 8) { setError("Enter a name and a password of at least 8 characters."); return; }
    setBusy(true); setError(null);
    const r = await apiFetch(`/api/team/accept/${token}`, { method: "POST", body: JSON.stringify({ displayName: name.trim(), password: pw }) });
    if (r.ok) { window.location.href = "/"; return; }
    setError((await r.json().catch(() => ({}))).error ?? "Could not accept the invitation."); setBusy(false);
  };

  return (
    <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", background: "var(--h10-bg, #f4f6fa)", padding: 20 }}>
      <div className="h10-ds-card" style={{ width: "100%", maxWidth: 420, padding: "28px 30px" }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--h10-primary, #2f6fed)", marginBottom: 4 }}>Nexus Factory</div>
        {!invite && !error && <div style={{ fontSize: 13, color: "var(--h10-text-3)" }}>Loading your invitation…</div>}
        {error && !invite && <div style={{ fontSize: 13, color: "var(--h10-danger)" }}>{error}</div>}
        {invite && (
          <>
            <h1 style={{ fontSize: 20, fontWeight: 700, margin: "2px 0 6px" }}>You&apos;re invited</h1>
            <div style={{ fontSize: 13, color: "var(--h10-text-2)", marginBottom: 18 }}>Joining as <b>{invite.roleName}</b> · {invite.email}</div>
            <div style={{ display: "grid", gap: 10 }}>
              <label style={{ display: "grid", gap: 4 }}>
                <span style={lbl}>Your name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} style={inp} placeholder="e.g. Marco Rossi" autoFocus />
              </label>
              <label style={{ display: "grid", gap: 4 }}>
                <span style={lbl}>Choose a password</span>
                <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} style={inp} placeholder="at least 8 characters" onKeyDown={(e) => e.key === "Enter" && void accept()} />
              </label>
              {error && <div style={{ fontSize: 12.5, color: "var(--h10-danger)" }}>{error}</div>}
              <button type="button" onClick={() => void accept()} disabled={busy} style={{ marginTop: 4, background: "var(--h10-primary, #2f6fed)", color: "#fff", border: "none", borderRadius: 8, padding: "10px 14px", fontSize: 13.5, fontWeight: 600, cursor: busy ? "default" : "pointer", opacity: busy ? 0.7 : 1 }}>{busy ? "Setting up…" : "Accept & sign in"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const lbl: React.CSSProperties = { fontSize: 11.5, color: "var(--h10-text-3)" };
const inp: React.CSSProperties = { width: "100%", border: "1px solid var(--h10-border)", borderRadius: 8, padding: "9px 11px", fontSize: 13, background: "var(--h10-surface)", color: "var(--h10-text)" };
