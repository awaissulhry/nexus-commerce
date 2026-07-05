/**
 * FP2.2 — template detail: header (name, base cost/price, archive) + sub-tabs.
 * Options + Constraints are live now; BOM & draws + Certificates fill in FP2.3,
 * Preview in FP2.4 (their panels state which cycle delivers them until then).
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Trash2 } from "lucide-react";
import { DetailHeader } from "@/design-system/patterns";
import { Card, Tabs, useToast } from "@/design-system/components";
import { Button } from "@/design-system/primitives";
import { apiFetch, apiJson } from "@/lib/api-client";
import { usePermission } from "@/lib/auth/client";
import { EuroInput } from "./money";
import { OptionsEditor } from "./OptionsEditor";
import { ConstraintsEditor } from "./ConstraintsEditor";
import { BomEditor } from "./BomEditor";
import { CertificatesEditor } from "./CertificatesEditor";
import { PreviewPanel } from "./PreviewPanel";
import type { TemplateDetail as TDetail } from "./types";

export function TemplateDetail({ templateId, onBack, onChanged }: { templateId: string; onBack: () => void; onChanged: () => void }) {
  const { toast } = useToast();
  const canCost = usePermission("financials.costs.view");
  const [tpl, setTpl] = useState<TDetail | null>(null);
  const [tab, setTab] = useState("options");

  const load = useCallback(async () => {
    try {
      const d = await apiJson<{ template: TDetail }>(`/api/products/templates/${templateId}`);
      setTpl(d.template);
    } catch (e) {
      toast((e as Error).message, "danger");
    }
  }, [templateId, toast]);

  useEffect(() => { void load(); }, [load]);

  const refresh = useCallback(() => { void load(); onChanged(); }, [load, onChanged]);

  const patchTemplate = async (data: Record<string, unknown>) => {
    try {
      await apiJson(`/api/products/templates/${templateId}`, { method: "PATCH", body: JSON.stringify(data) });
      refresh();
    } catch (e) {
      toast((e as Error).message, "danger");
    }
  };

  const remove = async () => {
    try {
      const res = await apiJson<{ archived: boolean; reason?: string }>(`/api/products/templates/${templateId}`, { method: "DELETE" });
      toast(res.archived ? res.reason ?? "Archived" : "Template deleted", res.archived ? "info" : "success");
      onBack();
      onChanged();
    } catch (e) {
      toast((e as Error).message, "danger");
    }
  };

  if (!tpl) return <div style={{ padding: 16 }}><Button onClick={onBack}><ArrowLeft size={13} /> Back</Button></div>;

  const tabs = [
    { id: "options", label: `Options (${tpl.optionGroups.reduce((n, g) => n + g.options.length, 0)})` },
    { id: "constraints", label: `Constraints (${tpl.constraints.length})` },
    { id: "bom", label: `BOM & draws (${tpl.bomLines.length})` },
    { id: "certs", label: `Certificates (${tpl.certCoverage.length})` },
    { id: "preview", label: "Preview" },
  ];

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <DetailHeader
        backLabel="All templates"
        onBack={onBack}
        title={
          <input
            defaultValue={tpl.name}
            key={tpl.name}
            onBlur={(e) => e.target.value.trim() && e.target.value !== tpl.name && patchTemplate({ name: e.target.value.trim() })}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            style={{ fontSize: 20, fontWeight: 700, border: "none", outline: "none", background: "transparent", color: "var(--h10-text)", minWidth: 280 }}
          />
        }
        actions={
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            {canCost && (
              <label style={{ display: "inline-flex", gap: 5, alignItems: "center", fontSize: 12, color: "var(--h10-text-2)" }}>
                Base cost
                <EuroInput cents={tpl.baseCostCents} onCommit={(c) => patchTemplate({ baseCostCents: c })} ariaLabel="Base cost" />
              </label>
            )}
            <label style={{ display: "inline-flex", gap: 5, alignItems: "center", fontSize: 12, color: "var(--h10-text-2)" }}>
              Base price
              <EuroInput cents={tpl.basePriceCents} onCommit={(c) => patchTemplate({ basePriceCents: c })} ariaLabel="Base price" />
            </label>
            <Button onClick={remove} title="Archive or delete"><Trash2 size={13} /> Delete</Button>
          </div>
        }
      />
      {tpl.archivedAt && (
        <div style={{ fontSize: 12.5, color: "var(--h10-warning, #b87503)" }}>
          Archived {new Date(tpl.archivedAt).toLocaleDateString()} — still referenced by history.{" "}
          <button type="button" onClick={() => patchTemplate({ archived: false })} style={{ background: "none", border: "none", color: "var(--h10-text-link)", cursor: "pointer", padding: 0 }}>Restore</button>
        </div>
      )}
      <Tabs tabs={tabs} active={tab} onChange={setTab} />
      <Card padded>
        {tab === "options" && <OptionsEditor template={tpl} baseCostCents={tpl.baseCostCents} basePriceCents={tpl.basePriceCents} onChanged={refresh} />}
        {tab === "constraints" && <ConstraintsEditor template={tpl} onChanged={refresh} />}
        {tab === "bom" && <BomEditor template={tpl} onChanged={refresh} />}
        {tab === "certs" && <CertificatesEditor template={tpl} onChanged={refresh} />}
        {tab === "preview" && <PreviewPanel template={tpl} />}
      </Card>
    </div>
  );
}
