/**
 * EPQ.2 — the "Needs follow-up" queue at the top of the quotes pipeline: the
 * worker's cadence engine flags SENT quotes (not viewed / viewed-but-silent /
 * expiring) and the Owner acts from here — [Send nudge] opens a
 * preview-before-send modal (editable Italian text, threaded into the same
 * Gmail conversation), [Snooze 3d] hides the row, [Dismiss] drops the flag.
 * The gear popover edits the three cadence numbers (AppSetting
 * quotes.followup via /api/quotes/followup-config) — config lives HERE, on
 * the page that uses it. Owner task queue, never auto-send (decision D-2).
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { BellRing, ChevronDown, ChevronRight, Settings2 } from "lucide-react";
import { Card, Modal, useClickAway, useToast } from "@/design-system/components";
import { Button, Pill, Textarea } from "@/design-system/primitives";
import { eur } from "@/design-system/lib/format";
import { apiJson } from "@/lib/api-client";
import { FOLLOW_UP_RULE_LABEL, type FollowUpRule } from "@/lib/quotes/followup";
import type { FollowUpRow, PipelineResponse } from "./types";

const RULE_TONE: Record<FollowUpRule, "warning" | "info" | "danger"> = {
  unviewed: "warning",
  "viewed-silent": "info",
  "pre-expiry": "danger",
};

const daysCopy = (r: FollowUpRow): string =>
  r.rule === "unviewed" ? `${r.days}d since send` : r.rule === "viewed-silent" ? `${r.days}d since last view` : `expires in ${r.days}d`;

export function FollowUpQueue({ rows, config, canSend, onOpen, onChanged }: {
  rows: FollowUpRow[];
  config: PipelineResponse["followupConfig"];
  canSend: boolean;
  onOpen: (id: string) => void;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [collapsed, setCollapsed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [nudging, setNudging] = useState<FollowUpRow | null>(null);

  if (rows.length === 0) return null;

  const act = async (row: FollowUpRow, action: "snooze" | "dismiss") => {
    setBusyId(row.id);
    try {
      await apiJson(`/api/quotes/${row.id}/followup`, { method: "POST", body: JSON.stringify({ action }) });
      toast(action === "snooze" ? `${row.number} snoozed for 3 days` : `${row.number} dismissed from the queue`, "success");
      onChanged();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div style={{ marginBottom: 14 }}>
      <Card
        header={
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
            style={{ display: "inline-flex", gap: 7, alignItems: "center", background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", color: "var(--h10-text)", fontWeight: 700 }}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            <BellRing size={14} style={{ color: "var(--h10-warning, #b45309)" }} />
            Needs follow-up
            <span style={{ fontWeight: 600, fontSize: 11.5, color: "var(--h10-text-3)" }}>{rows.length} quote{rows.length === 1 ? "" : "s"}</span>
          </button>
        }
        headerAction={canSend ? <CadenceGear config={config} onSaved={onChanged} /> : undefined}
      >
        {!collapsed && (
          <div style={{ display: "grid" }}>
            {rows.map((r, i) => (
              <div key={r.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "7px 0", borderTop: i === 0 ? "none" : "1px solid var(--h10-border-subtle)", fontSize: 12.5 }}>
                <button type="button" onClick={() => onOpen(r.id)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", fontWeight: 700, color: "var(--h10-text-link)" }}>{r.number}</button>
                <span style={{ color: "var(--h10-text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>{r.party.name}</span>
                <Pill tone={RULE_TONE[r.rule]}>{FOLLOW_UP_RULE_LABEL[r.rule]}</Pill>
                <span style={{ color: "var(--h10-text-3)", fontSize: 11.5 }}>{daysCopy(r)}</span>
                <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontWeight: 600 }}>{r.netCents ? eur(r.netCents) : "—"}</span>
                {canSend && (
                  <span style={{ display: "inline-flex", gap: 6 }}>
                    <Button variant="primary" onClick={() => setNudging(r)} disabled={busyId === r.id}>Send nudge</Button>
                    <Button onClick={() => act(r, "snooze")} disabled={busyId === r.id}>Snooze 3d</Button>
                    <Button onClick={() => act(r, "dismiss")} disabled={busyId === r.id}>Dismiss</Button>
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
      {nudging && (
        <NudgeModal
          row={nudging}
          onClose={() => setNudging(null)}
          onSent={() => { setNudging(null); onChanged(); }}
        />
      )}
    </div>
  );
}

/** EPQ.2 — gear popover: the three cadence numbers, PATCHed to the AppSetting. */
function CadenceGear({ config, onSaved }: { config: PipelineResponse["followupConfig"]; onSaved: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unviewed, setUnviewed] = useState(String(config.unviewedDays));
  const [viewed, setViewed] = useState(String(config.viewedDays));
  const [preExpiry, setPreExpiry] = useState(String(config.preExpiryDays));
  const ref = useRef<HTMLDivElement>(null);
  useClickAway(ref, () => setOpen(false));

  useEffect(() => {
    setUnviewed(String(config.unviewedDays));
    setViewed(String(config.viewedDays));
    setPreExpiry(String(config.preExpiryDays));
  }, [config.unviewedDays, config.viewedDays, config.preExpiryDays]);

  const save = async () => {
    setBusy(true);
    try {
      await apiJson("/api/quotes/followup-config", {
        method: "PATCH",
        body: JSON.stringify({ unviewedDays: Number(unviewed), viewedDays: Number(viewed), preExpiryDays: Number(preExpiry) }),
      });
      toast("Follow-up cadence saved", "success");
      setOpen(false);
      onSaved();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };

  const numRow = (label: string, value: string, set: (v: string) => void) => (
    <label style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", fontSize: 12, color: "var(--h10-text-2)" }}>
      {label}
      <input
        type="number" min={1} max={90} value={value} onChange={(e) => set(e.target.value)}
        style={{ width: 58, border: "1px solid var(--h10-border)", borderRadius: 7, padding: "3px 6px", font: "12.5px var(--font-mono)", textAlign: "center", background: "var(--h10-surface)", color: "var(--h10-text)" }}
      />
    </label>
  );

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button" aria-label="Follow-up cadence settings" onClick={() => setOpen((o) => !o)}
        style={{ display: "inline-flex", padding: 4, border: "none", background: "none", cursor: "pointer", color: "var(--h10-text-3)", borderRadius: 6 }}
      >
        <Settings2 size={15} />
      </button>
      {open && (
        <div style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 30, width: 260, background: "var(--h10-surface)", border: "1px solid var(--h10-border)", borderRadius: 10, boxShadow: "0 8px 24px rgb(20 28 38 / 0.14)", padding: 12, display: "grid", gap: 9 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--h10-text-3)" }}>Follow-up cadence (days)</div>
          {numRow("Nudge when unviewed for", unviewed, setUnviewed)}
          {numRow("Nudge when viewed, silent for", viewed, setViewed)}
          {numRow("Alert before expiry", preExpiry, setPreExpiry)}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button variant="primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * EPQ.2 — preview-before-send: the rendered Italian follow-up in an editable
 * textarea; nothing goes out until the Owner presses Send. No PDF attached —
 * the nudge references the original email.
 */
function NudgeModal({ row, onClose, onSent }: { row: FollowUpRow; onClose: () => void; onSent: () => void }) {
  const { toast } = useToast();
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiJson<{ text: string }>(`/api/quotes/${row.id}/nudge?rule=${row.rule}`)
      .then((d) => setText(d.text))
      .catch((e) => { toast((e as Error).message, "danger"); onClose(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id, row.rule]);

  const send = async () => {
    setBusy(true);
    try {
      await apiJson(`/api/quotes/${row.id}/nudge`, { method: "POST", body: JSON.stringify({ rule: row.rule, text: text ?? undefined }) });
      toast("Follow-up sent into the thread", "success");
      onSent();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Send a follow-up for ${row.number}`}
      size="sm"
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={send} disabled={busy || text === null}>{busy ? "Sending…" : "Send"}</Button></>}
    >
      <div style={{ display: "grid", gap: 8, fontSize: 12.5 }}>
        <div style={{ color: "var(--h10-text-2)" }}>
          To <b>{row.party.name}</b> — threads into the original conversation. The PDF isn't re-attached; the message references the offer already sent.
        </div>
        {text === null ? (
          <div style={{ fontSize: 12, color: "var(--h10-text-3)" }}>Rendering…</div>
        ) : (
          <Textarea aria-label="Follow-up message" value={text} onChange={(e) => setText(e.target.value)} rows={8} />
        )}
      </div>
    </Modal>
  );
}
