/**
 * FP2.2 — the Templates grid: list, create, one-click starter structure, open
 * detail. Cert status chip + counts per row; money grain-gated.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Sparkles } from "lucide-react";
import { Card, DataGrid, Modal, useToast } from "@/design-system/components";
import { Button, Input, Pill } from "@/design-system/primitives";
import { eur } from "@/design-system/lib/format";
import { apiJson } from "@/lib/api-client";
import { usePermission } from "@/lib/auth/client";
import { TemplateDetail } from "./TemplateDetail";
import { CERT_TONE, type TemplateRow } from "./types";

const CERT_LABEL: Record<TemplateRow["certStatus"], string> = { ok: "cert OK", expiring: "cert expiring", expired: "cert expired", none: "no cert" };

export function TemplatesTab() {
  const { toast } = useToast();
  const canManage = usePermission("products.manage");
  const canPrice = usePermission("financials.prices.view");
  const [rows, setRows] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await apiJson<{ templates: TemplateRow[] }>("/api/products/templates");
      setRows(d.templates);
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setLoading(false);
    }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    setBusy(true);
    try {
      const d = await apiJson<{ template: { id: string } }>("/api/products/templates", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      setCreating(false); setName("");
      await load();
      setOpenId(d.template.id);
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };

  const starter = async () => {
    setBusy(true);
    try {
      const d = await apiJson<{ template: { id: string } }>("/api/products/templates/starter", { method: "POST" });
      await load();
      setOpenId(d.template.id);
      toast("Starter Cowhide Suit created — set your real prices", "success");
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };

  if (openId) return <TemplateDetail templateId={openId} onBack={() => setOpenId(null)} onChanged={load} />;

  return (
    <Card padded>
      <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
        <div style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>Product templates</div>
        {canPrice && <a href="/api/exports/pricing-model" style={{ fontSize: 12, color: "var(--h10-text-link)" }}>Export model CSV</a>}
        {canManage && (
          <>
            <Button onClick={starter} disabled={busy}><Sparkles size={13} /> Starter structure</Button>
            <Button variant="primary" onClick={() => setCreating(true)}><Plus size={13} /> New template</Button>
          </>
        )}
      </div>
      {loading ? (
        <div style={{ fontSize: 13, color: "var(--h10-text-3)" }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 20, textAlign: "center", fontSize: 13, color: "var(--h10-text-3)" }}>
          No templates yet. Start from the <b>Starter structure</b> (Custom Cowhide Suit, zero-priced) or create a blank one.
        </div>
      ) : (
        <DataGrid
          columns={[
            { key: "name", label: "Template", render: (r: TemplateRow) => (
              <button type="button" onClick={() => setOpenId(r.id)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", fontWeight: 700, color: "var(--h10-text-link)", textAlign: "left" }}>{r.name}</button>
            ) },
            { key: "groups", label: "Groups", align: "right" as const, render: (r: TemplateRow) => r.groupCount },
            { key: "options", label: "Options", align: "right" as const, render: (r: TemplateRow) => r.optionCount },
            { key: "constraints", label: "Rules", align: "right" as const, render: (r: TemplateRow) => r.constraintCount },
            { key: "cert", label: "Certificate", render: (r: TemplateRow) => <Pill tone={CERT_TONE[r.certStatus]}>{CERT_LABEL[r.certStatus]}{r.certClasses.length ? ` (${r.certClasses.join("/")})` : ""}</Pill> },
            ...(canPrice ? [{ key: "price", label: "Base price", align: "right" as const, render: (r: TemplateRow) => eur(r.basePriceCents) }] : []),
            { key: "updated", label: "Updated", render: (r: TemplateRow) => new Date(r.updatedAt).toLocaleDateString() },
          ]}
          rows={rows}
          rowKey={(r: TemplateRow) => r.id}
        />
      )}

      <Modal open={creating} onClose={() => setCreating(false)} title="New template" size="sm" footer={<><Button onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" onClick={create} disabled={!name.trim() || busy}>Create</Button></>}>
        <Input placeholder="Template name (e.g. Custom Cowhide Suit)" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Modal>
    </Card>
  );
}
