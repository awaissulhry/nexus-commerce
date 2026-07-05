/**
 * F1 — Import/Export center: the dry-run-diff idiom live (Party CSV as the
 * reference implementation). Paste → Dry-run → per-row diff → Apply valid
 * rows → per-row results. Editing the CSV resets the diff (the eBay-ads
 * contract). History grid underneath.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/design-system/patterns";
import { Card, DataGrid, useToast } from "@/design-system/components";
import { Button, Pill } from "@/design-system/primitives";
import { apiJson } from "@/lib/api-client";

type DiffRow = { row: number; action: string; target: string; from?: string; to?: string; note?: string; error?: string };
type ImportResponse = {
  dryRun: boolean;
  parseErrors: { row: number; error: string }[];
  diff: DiffRow[];
  applied: { row: number; ok: boolean; detail: string }[] | null;
};
type Job = {
  id: string;
  entity: string;
  mode: string;
  rowsTotal: number;
  rowsOk: number;
  rowsError: number;
  createdAt: string;
  actor: { displayName: string } | null;
};

export default function ImportExportPage() {
  const { toast } = useToast();
  const [csv, setCsv] = useState("");
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);

  const loadJobs = useCallback(() => {
    apiJson<{ items: Job[] }>("/api/imports").then((d) => setJobs(d.items)).catch(() => {});
  }, []);
  useEffect(loadJobs, [loadJobs]);

  const run = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const res = await apiJson<ImportResponse>("/api/imports/parties", {
        method: "POST",
        body: JSON.stringify({ csv, dryRun }),
      });
      setResult(res);
      if (!dryRun) {
        const ok = res.applied?.filter((r) => r.ok).length ?? 0;
        toast(`Applied ${ok} row(s)`, "success");
        loadJobs();
      }
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };

  const validRows = result ? result.diff.filter((d) => !d.error && d.action !== "SKIP").length : 0;

  return (
    <div className="factory-coming" style={{ maxWidth: 980 }}>
      <PageHeader
        eyebrow="Settings"
        title="Import / Export"
        subtitle="Nothing bulk applies without a dry-run diff you approved. Party CSV is live; each page cycle adds its entities."
      />
      <div style={{ display: "grid", gap: 14 }}>
        <Card padded header="Import parties (CSV)">
          <div style={{ display: "grid", gap: 10 }}>
            <div style={{ fontSize: 12.5, color: "var(--h10-text-2)" }}>
              Start from the exact shape:{" "}
              <a href="/api/imports/parties/template" style={{ color: "var(--h10-text-link)" }}>
                download the template
              </a>{" "}
              · columns: kind (BRAND|CUSTOMER|SUPPLIER), name, email, currency, payment_terms, notes.
              The email becomes the Inbox sender-matching key.
            </div>
            <textarea
              value={csv}
              onChange={(e) => {
                setCsv(e.target.value);
                setResult(null); // editing resets diff + applied (the contract)
              }}
              placeholder="Paste CSV here…"
              rows={7}
              style={{
                width: "100%",
                font: "12px var(--font-mono), monospace",
                border: "1px solid var(--h10-border)",
                borderRadius: 8,
                padding: 10,
                background: "var(--h10-surface)",
                color: "var(--h10-text)",
                resize: "vertical",
              }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <Button onClick={() => void run(true)} disabled={!csv.trim() || busy}>
                {busy ? "Working…" : "Dry-run"}
              </Button>
              <Button
                variant="primary"
                onClick={() => void run(false)}
                disabled={!result || result.applied !== null || validRows === 0 || busy}
                title={!result ? "Run the dry-run first" : undefined}
              >
                Apply {validRows > 0 ? `${validRows} valid row(s)` : "valid rows"}
              </Button>
            </div>
            {result && (
              <>
                {result.parseErrors.length > 0 && (
                  <div style={{ fontSize: 12.5, color: "var(--h10-danger)" }}>
                    {result.parseErrors.map((e) => (
                      <div key={e.row}>
                        Row {e.row}: {e.error}
                      </div>
                    ))}
                  </div>
                )}
                <DataGrid
                  columns={[
                    { key: "row", label: "Row", render: (r: DiffRow) => r.row },
                    {
                      key: "action",
                      label: "Action",
                      render: (r: DiffRow) => (
                        <Pill tone={r.error ? "danger" : r.action === "CREATE" ? "success" : r.action === "UPDATE" ? "info" : "neutral"}>
                          {r.error ? "ERROR" : r.action}
                        </Pill>
                      ),
                    },
                    { key: "target", label: "Target", render: (r: DiffRow) => r.target },
                    { key: "from", label: "From", render: (r: DiffRow) => r.from ?? "—" },
                    { key: "to", label: "To", render: (r: DiffRow) => r.to ?? "—" },
                    { key: "note", label: "Note", render: (r: DiffRow) => r.error ?? r.note ?? "" },
                  ]}
                  rows={result.diff}
                  rowKey={(r: DiffRow) => String(r.row)}
                />
                {result.applied && (
                  <div style={{ display: "grid", gap: 3, fontSize: 12.5 }}>
                    {result.applied.map((r) => (
                      <div key={r.row}>
                        <Pill tone={r.ok ? "success" : "danger"}>{r.ok ? "OK" : "FAIL"}</Pill> row {r.row} —{" "}
                        {r.detail}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </Card>

        <Card
          padded
          header="Exports"
        >
          <div style={{ fontSize: 12.5 }}>
            <a href="/api/exports/parties" style={{ color: "var(--h10-text-link)" }}>
              parties.csv
            </a>{" "}
            — round-trips with the import. Financial columns are stripped unless your role holds the
            grain (the exporter calls the filter explicitly).
          </div>
        </Card>

        <Card padded header="Import history">
          <DataGrid
            columns={[
              { key: "createdAt", label: "When", render: (j: Job) => new Date(j.createdAt).toLocaleString() },
              { key: "entity", label: "Entity", render: (j: Job) => j.entity },
              { key: "mode", label: "Mode", render: (j: Job) => <Pill tone={j.mode === "APPLY" ? "info" : "neutral"}>{j.mode}</Pill> },
              { key: "rowsTotal", label: "Rows", align: "right" as const, render: (j: Job) => j.rowsTotal },
              { key: "rowsOk", label: "OK", align: "right" as const, render: (j: Job) => j.rowsOk },
              { key: "rowsError", label: "Errors", align: "right" as const, render: (j: Job) => j.rowsError },
              { key: "actor", label: "By", render: (j: Job) => j.actor?.displayName ?? "—" },
            ]}
            rows={jobs}
            rowKey={(j: Job) => j.id}
            emptyState="No imports yet."
          />
        </Card>
      </div>
    </div>
  );
}
