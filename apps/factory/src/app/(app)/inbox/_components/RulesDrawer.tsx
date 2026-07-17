/**
 * EPI3.4 — the routing-rules drawer (§5.9): ordered WHEN/IF/THEN rows with
 * explicit ↑↓ priority + stop-processing (never alphabetical — Missive's
 * wart), enable toggles, and Run-now with the dry-run diff idiom (only rows
 * the action would actually change; apply the checked subset).
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Play, Plus } from "lucide-react";
import { Drawer, Modal, useToast } from "@/design-system/components";
import { Button, Checkbox, Input, Skeleton } from "@/design-system/primitives";
import { Listbox } from "@/design-system/components";
import { apiJson } from "@/lib/api-client";
import { CriteriaRows, defaultDraft, draftsValid, type Draft } from "./ViewBuilder";
import type { UserLite } from "./types";

type Rule = {
  id: string;
  name: string;
  sortOrder: number;
  enabled: boolean;
  stopProcessing: boolean;
  criteria: { all: Draft[]; any: Draft[] };
  actions: { type: "assign" | "close"; assigneeId?: string }[];
};

type RunRow = {
  id: string;
  subject: string | null;
  partyName: string | null;
  current: { assigneeId: string | null; state: string };
  after: Record<string, unknown>;
};

export function RulesDrawer({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => void }) {
  const { toast } = useToast();
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [users, setUsers] = useState<UserLite[]>([]);
  const [editing, setEditing] = useState<Partial<Rule> | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [run, setRun] = useState<{ rule: Rule; rows: RunRow[]; checked: Set<string> } | null>(null);

  const load = useCallback(() => {
    apiJson<{ rules: Rule[] }>("/api/inbox/rules")
      .then((d) => setRules(d.rules))
      .catch((e: Error) => toast(e.message, "danger"));
  }, [toast]);

  useEffect(() => {
    if (!open) return;
    setEditing(null);
    setRun(null);
    setConfirmDeleteId(null);
    load();
    apiJson<{ users: UserLite[] }>("/api/users-lite")
      .then((d) => setUsers(d.users))
      .catch(() => {});
  }, [open, load]);

  const patch = async (id: string, data: Record<string, unknown>) => {
    try {
      await apiJson(`/api/inbox/rules/${id}`, { method: "PATCH", body: JSON.stringify(data) });
      load();
      onChanged();
    } catch (e) {
      toast((e as Error).message, "danger");
    }
  };

  const move = async (rule: Rule, dir: -1 | 1) => {
    const list = rules ?? [];
    const i = list.findIndex((r) => r.id === rule.id);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    await patch(rule.id, { sortOrder: list[j].sortOrder });
    await patch(list[j].id, { sortOrder: rule.sortOrder });
  };

  const save = async () => {
    if (!editing || busy) return;
    const all = editing.criteria?.all ?? [];
    const any = editing.criteria?.any ?? [];
    const actions = editing.actions ?? [];
    if (!editing.name?.trim() || (all.length === 0 && any.length === 0) || !draftsValid(all) || !draftsValid(any) || actions.length === 0) {
      toast("Name, at least one condition, and an action are required", "warning");
      return;
    }
    setBusy(true);
    try {
      const body = JSON.stringify({
        name: editing.name.trim(),
        criteria: { all, any },
        actions,
        stopProcessing: editing.stopProcessing ?? true,
      });
      if (editing.id) await apiJson(`/api/inbox/rules/${editing.id}`, { method: "PATCH", body });
      else await apiJson("/api/inbox/rules", { method: "POST", body });
      toast(editing.id ? "Rule updated" : "Rule created — applies to NEW mail; use Run now for existing", "success");
      setEditing(null);
      load();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };

  const runNow = async (rule: Rule) => {
    setBusy(true);
    try {
      const d = await apiJson<{ rows: RunRow[] }>("/api/inbox/rules/run", {
        method: "POST",
        body: JSON.stringify({ ruleId: rule.id, dryRun: true }),
      });
      setRun({ rule, rows: d.rows, checked: new Set(d.rows.map((r) => r.id)) });
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };

  const applyRun = async () => {
    if (!run || busy) return;
    setBusy(true);
    try {
      const d = await apiJson<{ applied: number }>("/api/inbox/rules/run", {
        method: "POST",
        body: JSON.stringify({ ruleId: run.rule.id, dryRun: false, ids: [...run.checked] }),
      });
      toast(`${d.applied} conversation${d.applied === 1 ? "" : "s"} updated`, "success");
      setRun(null);
      onChanged();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };

  const actionSummary = (r: Rule) =>
    r.actions
      .map((a) => (a.type === "close" ? "close" : `assign ${users.find((u) => u.id === a.assigneeId)?.displayName ?? "…"}`))
      .join(" + ");

  return (
    <Drawer open={open} onClose={onClose} title="Routing rules" subtitle="Applied once when a conversation is born, top to bottom" width={560}>
      <div style={{ display: "grid", gap: 10, fontSize: 12.5 }}>
        {rules == null ? (
          <Skeleton />
        ) : rules.length === 0 && !editing ? (
          <div style={{ color: "var(--h10-text-3)" }}>No rules yet — new mail lands untouched. Add one below.</div>
        ) : (
          rules.map((r, i) => (
            <div key={r.id} style={{ border: "1px solid var(--h10-border-subtle)", borderRadius: 10, padding: "8px 10px", display: "grid", gap: 4 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <Checkbox checked={r.enabled} onChange={(e) => void patch(r.id, { enabled: e.target.checked })} aria-label="Enabled" />
                <b style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</b>
                <button type="button" aria-label="Move up" onClick={() => void move(r, -1)} disabled={i === 0} style={{ background: "none", border: "none", cursor: i === 0 ? "default" : "pointer", color: "var(--h10-text-3)", display: "inline-flex", padding: 2, opacity: i === 0 ? 0.4 : 1 }}>
                  <ArrowUp size={13} />
                </button>
                <button type="button" aria-label="Move down" onClick={() => void move(r, 1)} disabled={i === rules.length - 1} style={{ background: "none", border: "none", cursor: i === rules.length - 1 ? "default" : "pointer", color: "var(--h10-text-3)", display: "inline-flex", padding: 2, opacity: i === rules.length - 1 ? 0.4 : 1 }}>
                  <ArrowDown size={13} />
                </button>
                <Button onClick={() => void runNow(r)} disabled={busy}>
                  <Play size={12} /> Run now
                </Button>
                <Button onClick={() => setEditing(r)}>Edit</Button>
                <Button onClick={() => (confirmDeleteId === r.id ? void patchDelete(r.id) : setConfirmDeleteId(r.id))}>
                  {confirmDeleteId === r.id ? "Confirm" : "Delete"}
                </Button>
              </div>
              <span style={{ fontSize: 11.5, color: "var(--h10-text-3)" }}>
                {r.criteria.all.length + r.criteria.any.length} condition{r.criteria.all.length + r.criteria.any.length === 1 ? "" : "s"} → {actionSummary(r)}
                {r.stopProcessing ? " · stops here" : ""}
                {r.enabled ? "" : " · disabled"}
              </span>
            </div>
          ))
        )}

        {editing ? (
          <div style={{ border: "1px solid var(--h10-border)", borderRadius: 10, padding: 10, display: "grid", gap: 10 }}>
            <Input placeholder="Rule name" value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            <b>IF — all of</b>
            <CriteriaRows rows={editing.criteria?.all ?? []} setRows={(all) => setEditing({ ...editing, criteria: { all, any: editing.criteria?.any ?? [] } })} users={users} />
            <b>…and any of</b>
            <CriteriaRows rows={editing.criteria?.any ?? []} setRows={(any) => setEditing({ ...editing, criteria: { all: editing.criteria?.all ?? [], any } })} users={users} />
            <b>THEN</b>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <Listbox
                ariaLabel="Action"
                options={[
                  { value: "assign", label: "Assign to…" },
                  { value: "close", label: "Close (newsletters etc.)" },
                ]}
                value={editing.actions?.[0]?.type ?? "assign"}
                onChange={(t) =>
                  setEditing({ ...editing, actions: t === "close" ? [{ type: "close" }] : [{ type: "assign", assigneeId: users[0]?.id }] })
                }
              />
              {editing.actions?.[0]?.type !== "close" && (
                <Listbox
                  ariaLabel="Assignee"
                  options={users.map((u) => ({ value: u.id, label: u.displayName }))}
                  value={editing.actions?.[0]?.assigneeId ?? users[0]?.id ?? ""}
                  onChange={(id) => setEditing({ ...editing, actions: [{ type: "assign", assigneeId: id }] })}
                />
              )}
            </div>
            <label style={{ display: "flex", gap: 7, alignItems: "center" }}>
              <Checkbox
                checked={editing.stopProcessing ?? true}
                onChange={(e) => setEditing({ ...editing, stopProcessing: e.target.checked })}
                aria-label="Stop processing"
              />
              Stop processing more rules when this one matches
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <Button variant="primary" onClick={() => void save()} disabled={busy}>
                {busy ? "Saving…" : editing.id ? "Save rule" : "Create rule"}
              </Button>
              <Button onClick={() => setEditing(null)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <div>
            <Button onClick={() => setEditing({ criteria: { all: [], any: [defaultDraft("senderDomain")] }, actions: [{ type: "assign", assigneeId: users[0]?.id }] })}>
              <Plus size={13} /> New rule
            </Button>
          </div>
        )}
      </div>

      <Modal
        open={run != null}
        onClose={() => setRun(null)}
        title={run ? `Run "${run.rule.name}" on existing mail` : ""}
        footer={
          <>
            <Button onClick={() => setRun(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => void applyRun()} disabled={busy || (run?.checked.size ?? 0) === 0}>
              Apply to {run?.checked.size ?? 0}
            </Button>
          </>
        }
      >
        {run && (
          <div style={{ display: "grid", gap: 6, fontSize: 12.5, maxHeight: 360, overflowY: "auto" }}>
            {run.rows.length === 0 ? (
              <span style={{ color: "var(--h10-text-3)" }}>Nothing to change — every match already looks like the rule wants.</span>
            ) : (
              run.rows.map((row) => (
                <label key={row.id} style={{ display: "flex", gap: 8, alignItems: "baseline", minWidth: 0 }}>
                  <Checkbox
                    checked={run.checked.has(row.id)}
                    onChange={(e) => {
                      const next = new Set(run.checked);
                      if (e.target.checked) next.add(row.id);
                      else next.delete(row.id);
                      setRun({ ...run, checked: next });
                    }}
                    aria-label="Include"
                  />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {row.subject ?? "(no subject)"}
                  </span>
                  <span style={{ fontSize: 11.5, color: "var(--h10-text-3)", flexShrink: 0 }}>
                    {row.partyName ?? ""} · {row.current.state}
                    {"state" in row.after ? " → CLOSED" : ""}
                    {"assigneeId" in row.after ? ` → ${users.find((u) => u.id === row.after.assigneeId)?.displayName ?? "assigned"}` : ""}
                  </span>
                </label>
              ))
            )}
          </div>
        )}
      </Modal>
    </Drawer>
  );

  async function patchDelete(id: string) {
    setConfirmDeleteId(null);
    try {
      await apiJson(`/api/inbox/rules/${id}`, { method: "DELETE" });
      toast("Rule deleted", "success");
      load();
    } catch (e) {
      toast((e as Error).message, "danger");
    }
  }
}
