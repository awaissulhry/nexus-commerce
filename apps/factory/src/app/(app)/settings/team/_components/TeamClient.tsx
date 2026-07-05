/**
 * FP11.1 — team & roles: the members list (reassign a role, deactivate) and
 * invitations (invite → one-time join link → revoke). Every write goes through
 * the guardrail-checked team routes; a refused change surfaces its message.
 * The role matrix (custom roles) lands in FP11.2 under this same page.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { UserPlus, Copy, X } from "lucide-react";
import { DataGrid, Listbox, useToast } from "@/design-system/components";
import { Button, Input, Pill } from "@/design-system/primitives";
import { apiJson } from "@/lib/api-client";
import { type Invitation, type Member, type MembersResponse, type RoleLite } from "./types";

const dmy = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "never");

export function TeamClient() {
  const { toast } = useToast();
  const [members, setMembers] = useState<Member[]>([]);
  const [roles, setRoles] = useState<RoleLite[]>([]);
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("");
  const [joinUrl, setJoinUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const m = await apiJson<MembersResponse>("/api/team/members");
      setMembers(m.members); setRoles(m.roles);
      if (!inviteRole) setInviteRole(m.roles.find((r) => r.key === "WORKER")?.id ?? m.roles[0]?.id ?? "");
      setInvites((await apiJson<{ invitations: Invitation[] }>("/api/team/invitations")).invitations);
    } catch (e) { toast((e as Error).message, "danger"); }
  }, [toast, inviteRole]);
  useEffect(() => { void load(); }, [load]);

  const reassign = async (userId: string, roleId: string) => {
    try { await apiJson("/api/team/members", { method: "PATCH", body: JSON.stringify({ userId, roleId }) }); toast("Role updated", "success"); void load(); }
    catch (e) { toast((e as Error).message, "danger"); }
  };
  const setStatus = async (userId: string, status: "active" | "deactivated") => {
    try { await apiJson("/api/team/members", { method: "PATCH", body: JSON.stringify({ userId, status }) }); toast(status === "active" ? "Reactivated" : "Deactivated", "success"); void load(); }
    catch (e) { toast((e as Error).message, "danger"); }
  };
  const sendInvite = async () => {
    if (!email.trim() || !inviteRole) { toast("Enter an email and pick a role", "danger"); return; }
    setBusy(true);
    try {
      const r = await apiJson<{ joinUrl: string }>("/api/team/invitations", { method: "POST", body: JSON.stringify({ email: email.trim(), roleId: inviteRole }) });
      setJoinUrl(r.joinUrl); setEmail(""); toast("Invitation created — share the link", "success"); void load();
    } catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(false); }
  };
  const revoke = async (id: string) => {
    try { await apiJson(`/api/team/invitations?id=${id}`, { method: "DELETE" }); void load(); }
    catch (e) { toast((e as Error).message, "danger"); }
  };
  const copy = () => { if (joinUrl && navigator.clipboard) { void navigator.clipboard.writeText(joinUrl); toast("Link copied", "success"); } };

  const roleOpts = roles.map((r) => ({ value: r.id, label: r.name }));

  return (
    <div className="factory-page factory-grid-grow-1">
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Team &amp; roles</h1>
        <div style={{ fontSize: 12.5, color: "var(--h10-text-2)", marginTop: 2 }}>Invite people, set who can do what. The last owner is protected; system roles are locked.</div>
      </div>

      <section style={{ marginBottom: 24 }}>
        <SectionHead title="Members" count={members.length} />
        <DataGrid
          columns={[
            { key: "name", label: "Name", render: (m: Member) => <span><b>{m.displayName}</b>{m.isYou && <span style={{ color: "var(--h10-text-3)" }}> · you</span>}</span> },
            { key: "email", label: "Email", render: (m: Member) => m.email },
            { key: "role", label: "Role", render: (m: Member) => <div style={{ maxWidth: 180 }}><Listbox ariaLabel="Role" options={roleOpts} value={m.roleId ?? ""} onChange={(v) => void reassign(m.id, v)} /></div> },
            { key: "last", label: "Last login", render: (m: Member) => <span style={{ fontSize: 12, color: "var(--h10-text-3)" }}>{dmy(m.lastLoginAt)}</span> },
            { key: "status", label: "Status", render: (m: Member) => (m.status === "active" ? <Pill tone="success">active</Pill> : <Pill tone="neutral">deactivated</Pill>) },
            { key: "act", label: "", align: "right" as const, render: (m: Member) => (m.isYou ? null : m.status === "active" ? <Button onClick={() => void setStatus(m.id, "deactivated")} style={{ color: "var(--h10-danger)", borderColor: "var(--h10-danger)" }}>Deactivate</Button> : <Button onClick={() => void setStatus(m.id, "active")}>Reactivate</Button>) },
          ]}
          rows={members}
          rowKey={(m: Member) => m.id}
          emptyState="No members yet."
        />
      </section>

      <section>
        <SectionHead title="Invitations" count={invites.length} />
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@example.com" style={{ width: 240 }} />
          <div style={{ width: 160 }}><Listbox ariaLabel="Invite role" options={roleOpts} value={inviteRole} onChange={setInviteRole} /></div>
          <Button variant="primary" onClick={sendInvite} disabled={busy}><UserPlus size={13} /> Invite</Button>
        </div>
        {joinUrl && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 10px", border: "1px solid var(--h10-primary)", borderRadius: 8, background: "var(--h10-primary-subtle, #eff4ff)", marginBottom: 10, fontSize: 12.5 }}>
            <span style={{ color: "var(--h10-text-2)" }}>Share this one-time link:</span>
            <code style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "ui-monospace, monospace" }}>{joinUrl}</code>
            <button type="button" onClick={copy} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--h10-text-link)", display: "inline-flex", gap: 4, alignItems: "center" }}><Copy size={13} /> Copy</button>
          </div>
        )}
        {invites.length === 0 ? (
          <div style={{ fontSize: 12.5, color: "var(--h10-text-3)" }}>No pending invitations.</div>
        ) : (
          <div style={{ display: "grid", gap: 5 }}>
            {invites.map((iv) => (
              <div key={iv.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", border: "1px solid var(--h10-border-subtle)", borderRadius: 8, fontSize: 12.5 }}>
                <span style={{ flex: 1 }}><b>{iv.email}</b> · {iv.roleName}</span>
                <span style={{ color: "var(--h10-text-3)", fontSize: 11 }}>expires {dmy(iv.expiresAt)}</span>
                <button type="button" onClick={() => void revoke(iv.id)} aria-label="Revoke" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--h10-text-3)", display: "grid", placeItems: "center" }}><X size={14} /></button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function SectionHead({ title, count }: { title: string; count: number }) {
  return <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8, fontSize: 13, fontWeight: 700 }}><span>{title}</span><span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--h10-text-3)", background: "var(--h10-surface-2)", borderRadius: 20, padding: "1px 8px" }}>{count}</span></div>;
}
