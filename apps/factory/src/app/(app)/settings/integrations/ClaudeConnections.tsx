/**
 * P11 — Settings › Integrations › Claude: the OWNER creates a connection for Claude Code or Claude Desktop on THIS
 * machine (decision P-1 = A), names the person it acts as (their roles decide what Claude sees: a worker's connection
 * sees no money) and whether it may also draft; the token is shown once, with the configuration to paste. Existing
 * connections are listed (never their token) and can be revoked at once.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Banner, Card, Field, Listbox, useToast } from "@/design-system/components";
import { Button, Input, Pill } from "@/design-system/primitives";
import { apiJson } from "@/lib/api-client";
import { claudeServerConfig } from "@/lib/claude/setup";

type Connection = {
  id: string;
  label: string;
  scopes: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  runsAs: { id: string; displayName: string };
};
type Loaded = { tokens: Connection[]; people: { id: string; displayName: string }[]; maxDays: number };

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "never");
const stateOf = (c: Connection): { label: string; tone: "success" | "warning" | "neutral" } =>
  c.revokedAt ? { label: "Revoked", tone: "neutral" } : new Date(c.expiresAt) <= new Date() ? { label: "Expired", tone: "warning" } : { label: "Active", tone: "success" };


export function ClaudeConnections() {
  const toast = useToast();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("Claude on this machine");
  const [userId, setUserId] = useState("");
  const [scopes, setScopes] = useState("read");
  const [days, setDays] = useState("30");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ raw: string; label: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiJson<Loaded>("/api/integrations/claude");
      setLoaded(data);
      setUserId((current) => current || data.people[0]?.id || "");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    try {
      const out = await apiJson<{ raw: string; token: Connection }>("/api/integrations/claude", {
        method: "POST",
        body: JSON.stringify({ label, userId, scopes, days: Number(days) }),
      });
      setCreated({ raw: out.raw, label: out.token.label });
      await load();
    } catch (e) {
      toast.toast(e instanceof Error ? e.message : String(e), "danger");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (c: Connection) => {
    try {
      await apiJson(`/api/integrations/claude/${c.id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      toast.toast(e instanceof Error ? e.message : String(e), "danger");
    }
  };

  return (
    <Card padded header="Claude — the factory, from Claude on this machine">
      <div style={{ display: "grid", gap: 12 }}>
        <div style={{ fontSize: 12.5, color: "var(--nds-text-2)" }}>
          A connection lets Claude Code or Claude Desktop <b>on this computer</b> read the factory as one person — what
          that person may see, and no more (a worker&apos;s connection sees no money). With &ldquo;read and draft&rdquo;
          it can also draft quotes and purchase orders, add internal comments and move a work order one stage. Nothing
          is ever sent, converted, labelled, invoiced or paid from Claude: you do that here. It refuses to start unless
          the factory runs with FACTORY_RBAC_MODE=enforce.
        </div>

        {error && <Banner tone="danger">{error}</Banner>}

        {created && (
          <Banner tone="success" title={`“${created.label}” is ready — copy the token now: it is shown only once`} onDismiss={() => setCreated(null)}>
            <div style={{ display: "grid", gap: 8 }}>
              <code style={{ wordBreak: "break-all", fontSize: 12 }}>{created.raw}</code>
              <div style={{ fontSize: 12.5 }}>
                Add this to the Claude configuration on this machine (Claude Desktop: Settings › Developer; Claude Code:{" "}
                <code>.mcp.json</code> in the Nexus folder), then restart Claude:
              </div>
              <pre style={{ fontSize: 11.5, margin: 0, whiteSpace: "pre-wrap" }}>{claudeServerConfig(created.raw)}</pre>
            </div>
          </Banner>
        )}

        {loaded && loaded.tokens.length > 0 && (
          <div style={{ display: "grid", gap: 6 }}>
            {loaded.tokens.map((c) => {
              const state = stateOf(c);
              return (
                <div key={c.id} style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 13, flexWrap: "wrap" }}>
                  <Pill tone={state.tone}>{state.label}</Pill>
                  <b>{c.label}</b>
                  <span style={{ color: "var(--nds-text-2)" }}>
                    as {c.runsAs.displayName} · {c.scopes === "read" ? "reads" : "reads and drafts"} · expires {day(c.expiresAt)} · last used {day(c.lastUsedAt)}
                  </span>
                  {!c.revokedAt && (
                    <span style={{ marginLeft: "auto" }}>
                      <Button size="sm" onClick={() => void revoke(c)}>Revoke</Button>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {loaded && (
          <div style={{ display: "grid", gap: 10, maxWidth: 480 }}>
            <Field label="Name">
              <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
            </Field>
            <Field label="Acts as" hint="Claude sees and drafts what this person may see and do.">
              <Listbox
                value={userId}
                onChange={setUserId}
                ariaLabel="Acts as"
                options={loaded.people.map((p) => ({ value: p.id, label: p.displayName }))}
              />
            </Field>
            <Field label="Claude may">
              <Listbox
                value={scopes}
                onChange={setScopes}
                ariaLabel="Claude may"
                options={[
                  { value: "read", label: "Read" },
                  { value: "read,draft", label: "Read and draft (up to 100 drafts a day)" },
                ]}
              />
            </Field>
            <Field label="Valid for" hint={`At most ${loaded.maxDays} days.`}>
              <Listbox
                value={days}
                onChange={setDays}
                ariaLabel="Valid for"
                options={["7", "30", "60", "90"].map((d) => ({ value: d, label: `${d} days` }))}
              />
            </Field>
            <div>
              <Button variant="primary" onClick={() => void create()} disabled={busy || !label.trim() || !userId}>
                {busy ? "Creating…" : "Create connection"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
