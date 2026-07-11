/**
 * FP2.5 — reusable dry-run CSV import (the proven eBay-ads idiom): paste →
 * Dry-run → per-row diff → Apply valid rows → per-row results. Editing the CSV
 * resets the diff. Used for materials and for options-per-template.
 */
"use client";

import { useState } from "react";
import { Modal, useToast } from "@/design-system/components";
import { Button, Pill } from "@/design-system/primitives";
import { VirtualDataGrid } from "@/components/VirtualDataGrid"; // FS3 — a 10k-row dry-run diff stays smooth
import { apiJson } from "@/lib/api-client";

type DiffRow = { row: number; action: string; target: string; from?: string; to?: string; note?: string; error?: string };
type Resp = { dryRun: boolean; parseErrors: { row: number; error: string }[]; diff: DiffRow[]; applied: { row: number; ok: boolean; detail: string }[] | null };

export function CsvImportModal({ open, onClose, title, endpoint, templateUrl, columnsHelp, extraBody, onApplied }: {
  open: boolean;
  onClose: () => void;
  title: string;
  endpoint: string;
  templateUrl: string;
  columnsHelp: string;
  extraBody?: Record<string, unknown>;
  onApplied: () => void;
}) {
  const { toast } = useToast();
  const [csv, setCsv] = useState("");
  const [result, setResult] = useState<Resp | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const res = await apiJson<Resp>(endpoint, { method: "POST", body: JSON.stringify({ ...extraBody, csv, dryRun }) });
      setResult(res);
      if (!dryRun) {
        toast(`Applied ${res.applied?.filter((r) => r.ok).length ?? 0} row(s)`, "success");
        onApplied();
      }
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };

  const validRows = result ? result.diff.filter((d) => !d.error && d.action !== "SKIP").length : 0;

  const close = () => { setCsv(""); setResult(null); onClose(); };

  return (
    <Modal open={open} onClose={close} title={title} size="lg">
      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ fontSize: 12, color: "var(--h10-text-2)" }}>
          <a href={templateUrl} style={{ color: "var(--h10-text-link)" }}>Download the template</a> · columns: {columnsHelp}
        </div>
        <textarea
          value={csv}
          onChange={(e) => { setCsv(e.target.value); setResult(null); }}
          placeholder="Paste CSV here…"
          rows={7}
          style={{ width: "100%", font: "12px var(--font-mono), monospace", border: "1px solid var(--h10-border)", borderRadius: 8, padding: 10, background: "var(--h10-surface)", color: "var(--h10-text)", resize: "vertical" }}
        />
        <div style={{ display: "flex", gap: 8 }}>
          <Button onClick={() => void run(true)} disabled={!csv.trim() || busy}>{busy ? "Working…" : "Dry-run"}</Button>
          <Button variant="primary" onClick={() => void run(false)} disabled={!result || result.applied !== null || validRows === 0 || busy}>Apply {validRows > 0 ? `${validRows} valid row(s)` : "valid rows"}</Button>
        </div>
        {result && (
          <>
            {result.parseErrors.length > 0 && (
              <div style={{ fontSize: 12.5, color: "var(--h10-danger)" }}>
                {result.parseErrors.map((e) => <div key={e.row}>Row {e.row}: {e.error}</div>)}
              </div>
            )}
            <VirtualDataGrid
              height={280}
              columns={[
                { key: "row", label: "Row", render: (r: DiffRow) => r.row },
                { key: "action", label: "Action", render: (r: DiffRow) => <Pill tone={r.error ? "danger" : r.action === "CREATE" ? "success" : r.action === "UPDATE" ? "info" : "neutral"}>{r.error ? "ERROR" : r.action}</Pill> },
                { key: "target", label: "Target", render: (r: DiffRow) => r.target },
                { key: "from", label: "From", render: (r: DiffRow) => r.from ?? "—" },
                { key: "to", label: "To", render: (r: DiffRow) => r.to ?? "—" },
                { key: "note", label: "Note", render: (r: DiffRow) => r.error ?? r.note ?? "" },
              ]}
              rows={result.diff}
              rowKey={(r: DiffRow) => String(r.row)}
              maxHeight={280}
            />
            {result.applied && (
              <div style={{ display: "grid", gap: 3, fontSize: 12.5, maxHeight: 160, overflowY: "auto" }}>
                {result.applied.map((r) => <div key={r.row}><Pill tone={r.ok ? "success" : "danger"}>{r.ok ? "OK" : "FAIL"}</Pill> row {r.row} — {r.detail}</div>)}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
