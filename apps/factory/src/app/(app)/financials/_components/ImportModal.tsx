/**
 * EPF2 (P2 + D-09/D-10 surfaces) — the bank-CSV import at design law. Input
 * accepts BOTH a FileDropzone and paste (the reference dry-run idiom); the
 * diff keeps confidence pills and adds EPF.1's duplicate / already-settled
 * annotations; Apply goes through a consequence confirm, then a RESULT step
 * reports created / skipped(duplicate) / errored per the transactional apply.
 * A note explains the identical-rows fingerprint edge (importKey collapses
 * two genuinely identical statement rows). Nothing is written until Apply.
 */
"use client";

import { useEffect, useState } from "react";
import { FileDropzone, Modal, useToast } from "@/design-system/components";
import { Button, Pill, Textarea } from "@/design-system/primitives";
import { eur } from "@/design-system/lib/format";
import { apiJson } from "@/lib/api-client";
import type { BankProposal, ImportApplyResponse, ImportResponse } from "./types";

const CONF_TONE: Record<string, "success" | "info" | "neutral"> = { high: "success", medium: "info", none: "neutral" };
const note: React.CSSProperties = { fontSize: 12, color: "var(--h10-text-3)", lineHeight: 1.5 };

type Phase = "input" | "review" | "confirm" | "result";

export function ImportModal({ open, canPay, onClose, onApplied }: { open: boolean; canPay: boolean; onClose: () => void; onApplied: () => void }) {
  const { toast } = useToast();
  const [phase, setPhase] = useState<Phase>("input");
  const [csv, setCsv] = useState("");
  const [proposals, setProposals] = useState<BankProposal[] | null>(null);
  const [pick, setPick] = useState<Record<number, boolean>>({});
  const [result, setResult] = useState<ImportApplyResponse | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) { setPhase("input"); setCsv(""); setProposals(null); setPick({}); setResult(null); }
  }, [open]);

  const dryRun = async () => {
    setBusy(true);
    try {
      const r = await apiJson<ImportResponse>("/api/imports/payments", { method: "POST", body: JSON.stringify({ rawCsv: csv }) });
      setProposals(r.proposals);
      const p: Record<number, boolean> = {};
      // EPF1 (D-10): settled-order references (zeroBalance) start UNCHECKED
      r.proposals.forEach((x, i) => { if (x.orderId && !x.zeroBalance) p[i] = true; });
      setPick(p);
      if (r.proposals.length === 0) toast(r.note ?? "No rows parsed", "danger");
      else setPhase("review");
    } catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(false); }
  };

  const selected = (proposals ?? []).filter((p, i) => pick[i] && p.orderId && p.amountCents);
  const apply = async () => {
    if (!proposals) return;
    // EPF1 (D-10): the statement row's date + description travel with the apply —
    // they form the idempotency key and the payment's receivedAt.
    const applyList = proposals.flatMap((p, i) =>
      pick[i] && p.orderId && p.amountCents
        ? [{ orderId: p.orderId, amountCents: p.amountCents, date: p.row.date, description: p.row.description, note: `Bank: ${p.row.description}`.slice(0, 200) }]
        : [],
    );
    if (applyList.length === 0) { toast("Select at least one matched row", "danger"); return; }
    setBusy(true);
    try {
      const r = await apiJson<ImportApplyResponse>("/api/imports/payments", { method: "POST", body: JSON.stringify({ apply: applyList }) });
      setResult(r);
      setPhase("result");
    } catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(false); }
  };

  const footer =
    phase === "input" ? (
      <><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => void dryRun()} disabled={busy || !csv.trim()}>Match</Button></>
    ) : phase === "review" ? (
      <><Button onClick={() => setPhase("input")}>Back</Button>{canPay && <Button variant="primary" onClick={() => setPhase("confirm")} disabled={busy || selected.length === 0}>Apply {selected.length || ""} selected…</Button>}</>
    ) : phase === "confirm" ? (
      <><Button onClick={() => setPhase("review")} disabled={busy}>Back</Button><Button variant="primary" onClick={() => void apply()} disabled={busy}>{busy ? "Recording…" : `Record ${selected.length} payment(s)`}</Button></>
    ) : (
      <Button variant="primary" onClick={onApplied}>Done</Button>
    );

  return (
    <Modal open={open} onClose={phase === "result" ? onApplied : onClose} title="Import bank CSV" size="md" footer={footer}>
      {phase === "input" && (
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ fontSize: 12.5, color: "var(--h10-text-2)" }}>
            Drop a statement file or paste rows — a header naming <b>date</b>, <b>amount</b>, <b>description</b> columns.
            We propose matches by reference or amount; <b>nothing is recorded until you apply</b>.
          </div>
          <FileDropzone accept=".csv,.txt" maxBytes={2 * 1024 * 1024} onFiles={(files) => { void files[0]?.text().then((t) => setCsv(t)); }} hint="CSV or TXT · max 2MB · stays on this machine until you apply" />
          <Textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={7} placeholder={"date,amount,description\n2026-07-01,500.00,Bonifico ORD-1"} style={{ fontFamily: "ui-monospace, monospace" }} aria-label="Bank statement rows" />
        </div>
      )}

      {phase === "review" && proposals && (
        <div style={{ display: "grid", gap: 6 }}>
          {proposals.map((p, i) => (
            <label key={i} style={{ display: "flex", gap: 8, alignItems: "center", padding: "7px 8px", border: "1px solid var(--h10-border-subtle)", borderRadius: 8, fontSize: 12.5, opacity: p.orderId ? 1 : 0.6 }}>
              <input type="checkbox" disabled={!p.orderId} checked={!!pick[i]} onChange={(e) => setPick((s) => ({ ...s, [i]: e.target.checked }))} style={{ accentColor: "var(--h10-primary)" }} />
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.row.description || "(no description)"}</span>
              <span style={{ color: "var(--h10-text-3)", whiteSpace: "nowrap" }}>{p.row.date || "no date"} · {eur(p.row.amountCents ?? 0)}</span>
              {p.number ? <span style={{ color: "var(--h10-text-link)", fontWeight: 600 }}>{p.number}</span> : <span style={{ color: "var(--h10-text-3)", fontSize: 11.5 }}>{p.reason}</span>}
              {/* EPF1 (D-10) — settled-order references are flagged, not silently re-proposed */}
              {p.zeroBalance && <Pill tone="warning">already settled</Pill>}
              <Pill tone={CONF_TONE[p.confidence]}>{p.confidence === "none" ? "no match" : p.confidence}</Pill>
            </label>
          ))}
          <div style={note}>
            Re-running the same statement is safe: each row is fingerprinted (date + amount + description), so duplicates are skipped on apply.
            The edge: two <i>genuinely identical</i> rows count as one — split them by hand if they are separate payments.
          </div>
        </div>
      )}

      {phase === "confirm" && (
        <div style={{ display: "grid", gap: 8 }} data-testid="import-confirm">
          <div style={{ fontSize: 12.5, color: "var(--h10-text-2)", lineHeight: 1.5 }}>
            Records <b>{selected.length} payment(s)</b> totalling <b>{eur(selected.reduce((s, p) => s + (p.amountCents ?? 0), 0))}</b> against their matched orders — bank dates become the payment dates,
            deposits that complete a gate unblock the floor, and every row is audited. Rows already imported (same fingerprint) are skipped, over-balance rows are refused per row.
          </div>
        </div>
      )}

      {phase === "result" && result && (
        <div style={{ display: "grid", gap: 8 }} data-testid="import-result">
          <div style={{ display: "flex", gap: 8 }}>
            <Pill tone="success">{result.created} created</Pill>
            <Pill tone={result.skipped > 0 ? "warning" : "neutral"}>{result.skipped} skipped (duplicate)</Pill>
            <Pill tone={result.errors.length > 0 ? "danger" : "neutral"}>{result.errors.length} errored</Pill>
          </div>
          {result.errors.length > 0 && (
            <div style={{ display: "grid", gap: 4 }}>
              {result.errors.map((e) => (
                <div key={e.index} style={{ fontSize: 12, color: "var(--h10-danger)" }}>Row {e.index + 1}: {e.reason}</div>
              ))}
            </div>
          )}
          <div style={note}>Skipped rows are this statement's fingerprints that already exist — the import is safe to re-run.</div>
        </div>
      )}
    </Modal>
  );
}
