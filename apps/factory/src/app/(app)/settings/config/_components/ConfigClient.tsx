/**
 * FP11.3 — the factory's configuration: the stage pipeline (add / rename /
 * reorder — new work orders read it), pricing defaults (margin floor, deposit),
 * the VAT display rate, the nightly backups (read-only), and the current RBAC
 * mode. Behind settings.manage; the whole page is pages.settings (worker-invisible).
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowUp, ArrowDown, X, Plus, Shield, Database } from "lucide-react";
import { Card, useToast } from "@/design-system/components";
import { Button, Input, Pill } from "@/design-system/primitives";
import { apiJson } from "@/lib/api-client";

type Config = { stages: string[]; marginFloorPct: number; depositDefaultPct: number; vatRatePct: number; rbacMode: "shadow" | "enforce"; updatedAt: string | null };
type Backup = { name: string; sizeBytes: number; modifiedAt: string };

const kb = (b: number) => (b >= 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const inp: React.CSSProperties = { width: 90 };

export function ConfigClient() {
  const { toast } = useToast();
  const [cfg, setCfg] = useState<Config | null>(null);
  const [stages, setStages] = useState<string[]>([]);
  const [newStage, setNewStage] = useState("");
  const [floor, setFloor] = useState(""); const [deposit, setDeposit] = useState(""); const [vat, setVat] = useState("");
  const [backups, setBackups] = useState<Backup[]>([]);
  const [backupDir, setBackupDir] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const c = await apiJson<Config>("/api/settings/config");
      setCfg(c); setStages(c.stages); setFloor(String(c.marginFloorPct)); setDeposit(String(c.depositDefaultPct)); setVat(String(c.vatRatePct));
      const b = await apiJson<{ backups: Backup[]; dir: string }>("/api/settings/backups");
      setBackups(b.backups); setBackupDir(b.dir);
    } catch (e) { toast((e as Error).message, "danger"); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  const move = (i: number, d: -1 | 1) => setStages((s) => { const n = [...s]; const j = i + d; if (j < 0 || j >= n.length) return n; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const rename = (i: number, v: string) => setStages((s) => s.map((x, j) => (j === i ? v.toUpperCase() : x)));
  const remove = (i: number) => setStages((s) => s.filter((_, j) => j !== i));
  const add = () => { const v = newStage.trim().toUpperCase(); if (v && !stages.includes(v)) { setStages((s) => [...s, v]); setNewStage(""); } };

  // FS4 — both saves echo the read stamp; a 409 ("changed elsewhere") means
  // another Owner saved first — toast it and reload their winning values.
  const saveConfig = async (body: Record<string, unknown>, okMsg: string) => {
    setBusy(true);
    try {
      await apiJson("/api/settings/config", { method: "PATCH", body: JSON.stringify({ ...body, expectedUpdatedAt: cfg?.updatedAt ?? null }) });
      toast(okMsg, "success");
      void load();
    } catch (e) {
      const msg = (e as Error).message;
      toast(msg, "danger");
      if (msg.includes("changed elsewhere")) void load();
    } finally { setBusy(false); }
  };
  const savePipeline = async () => {
    const clean = stages.map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (clean.length === 0) { toast("Keep at least one stage", "danger"); return; }
    await saveConfig({ stages: clean }, "Pipeline saved — new work orders use it");
  };
  const saveDefaults = async () => {
    await saveConfig({ marginFloorPct: +floor || 0, depositDefaultPct: +deposit || 0, vatRatePct: +vat || 0 }, "Defaults saved");
  };

  return (
    <div className="factory-page--centered">
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Configuration</h1>
        <div style={{ fontSize: 12.5, color: "var(--h10-text-2)", marginTop: 2 }}>The stage pipeline, pricing defaults, VAT, and backups.</div>
      </div>

      <div style={{ display: "grid", gap: 14 }}>
        <Card header="Stage pipeline">
          <div style={{ fontSize: 12.5, color: "var(--h10-text-2)", marginBottom: 10 }}>The stages every new work order runs through. Existing work orders keep their stages.</div>
          <div style={{ display: "grid", gap: 6 }}>
            {stages.map((s, i) => (
              <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ width: 20, color: "var(--h10-text-3)", fontSize: 12, textAlign: "right" }}>{i + 1}</span>
                <Input value={s} onChange={(e) => rename(i, e.target.value)} style={{ flex: 1, maxWidth: 260 }} />
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up" style={sbtn(i === 0)}><ArrowUp size={13} /></button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === stages.length - 1} aria-label="Move down" style={sbtn(i === stages.length - 1)}><ArrowDown size={13} /></button>
                <button type="button" onClick={() => remove(i)} aria-label="Remove" style={sbtn(false)}><X size={13} /></button>
              </div>
            ))}
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 2 }}>
              <span style={{ width: 20 }} />
              <Input value={newStage} onChange={(e) => setNewStage(e.target.value)} placeholder="add a stage…" style={{ flex: 1, maxWidth: 260 }} onKeyDown={(e) => e.key === "Enter" && add()} />
              <Button onClick={add}><Plus size={13} /> Add</Button>
            </div>
          </div>
          <div style={{ marginTop: 12 }}><Button variant="primary" onClick={savePipeline} disabled={busy}>Save pipeline</Button></div>
        </Card>

        <Card header="Defaults">
          <div style={{ display: "grid", gap: 12 }}>
            <Row label="Margin floor" hint="quotes below this % ask for an acknowledgement before sending"><Input type="number" min="0" max="100" value={floor} onChange={(e) => setFloor(e.target.value)} style={inp} /> <span style={sfx}>%</span></Row>
            <Row label="Default deposit" hint="the deposit % applied to a new one-off customer order (FD13)"><Input type="number" min="0" max="100" value={deposit} onChange={(e) => setDeposit(e.target.value)} style={inp} /> <span style={sfx}>%</span></Row>
            <Row label="VAT (display)" hint="the IVA rate shown on the Fattura + in the financials export — display only"><Input type="number" min="0" max="100" value={vat} onChange={(e) => setVat(e.target.value)} style={inp} /> <span style={sfx}>%</span></Row>
          </div>
          <div style={{ marginTop: 12 }}><Button variant="primary" onClick={saveDefaults} disabled={busy}>Save defaults</Button></div>
        </Card>

        <Card header="Backups">
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--h10-text-2)", marginBottom: 10 }}><Database size={14} /> Nightly SQLite snapshots (rotated 14). {backupDir && <code style={{ fontSize: 11, color: "var(--h10-text-3)" }}>{backupDir}</code>}</div>
          {backups.length === 0 ? (
            <div style={{ fontSize: 12.5, color: "var(--h10-text-3)" }}>No snapshots yet — the first appears after the next nightly run (03:00).</div>
          ) : (
            <div style={{ display: "grid", gap: 5 }}>
              {backups.map((b) => (
                <div key={b.name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", border: "1px solid var(--h10-border-subtle)", borderRadius: 8, fontSize: 12.5 }}>
                  <span style={{ flex: 1, fontFamily: "ui-monospace, monospace" }}>{b.name}</span>
                  <span style={{ color: "var(--h10-text-3)" }}>{kb(b.sizeBytes)}</span>
                  <span style={{ color: "var(--h10-text-3)", fontSize: 11 }}>{new Date(b.modifiedAt).toLocaleDateString()}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--h10-text-3)" }}>To restore: stop the app, then <code>cp .snapshots/&lt;snapshot&gt;.db data/factory.db</code>.</div>
        </Card>

        <Card header="Access control">
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
            <Shield size={14} style={{ color: "var(--h10-text-3)" }} />
            RBAC mode: {cfg && (cfg.rbacMode === "enforce" ? <Pill tone="success">enforce</Pill> : <Pill tone="warning">shadow</Pill>)}
          </div>
          <div style={{ marginTop: 8, fontSize: 11.5, color: "var(--h10-text-3)" }}>
            {cfg?.rbacMode === "enforce"
              ? "Permissions are enforced — a missing grant is a real 403."
              : "Shadow mode logs would-be denials but allows them. Flip to enforce (FACTORY_RBAC_MODE=enforce + restart) before a second person logs in."}
          </div>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <div style={{ width: 200 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 11, color: "var(--h10-text-3)" }}>{hint}</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>{children}</div>
    </div>
  );
}
const sfx: React.CSSProperties = { fontSize: 12.5, color: "var(--h10-text-3)" };
const sbtn = (disabled: boolean): React.CSSProperties => ({ border: "1px solid var(--h10-border)", borderRadius: 6, background: "var(--h10-surface)", cursor: disabled ? "default" : "pointer", color: "var(--h10-text-3)", padding: 5, display: "grid", placeItems: "center", opacity: disabled ? 0.4 : 1 });
