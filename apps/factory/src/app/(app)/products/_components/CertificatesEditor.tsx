/**
 * FP2.3 — EN 17092 certificates on this template (FD14). Attached certs with
 * expiry chips, attach-from-registry, and create-new. FP6's QC stage blocks
 * PACKING when a garment's cert is missing or expired — no apparel vertical
 * models this (our differentiator).
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { DateField, Listbox, Modal, useToast } from "@/design-system/components";
import { Button, Input, Pill } from "@/design-system/primitives";
import { apiFetch, apiJson } from "@/lib/api-client";
import type { Certificate, TemplateDetail } from "./types";

const CLASSES = ["AAA", "AA", "A", "B", "C"].map((c) => ({ value: c, label: `Class ${c}` }));

function expiryChip(expiresAt: string | null) {
  if (!expiresAt) return <Pill tone="neutral">no expiry set</Pill>;
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms < 0) return <Pill tone="danger">expired {new Date(expiresAt).toLocaleDateString()}</Pill>;
  if (ms < 60 * 86400000) return <Pill tone="warning">expiring {new Date(expiresAt).toLocaleDateString()}</Pill>;
  return <Pill tone="success">valid to {new Date(expiresAt).toLocaleDateString()}</Pill>;
}

export function CertificatesEditor({ template, onChanged }: { template: TemplateDetail; onChanged: () => void }) {
  const { toast } = useToast();
  const [registry, setRegistry] = useState<Certificate[]>([]);
  const [attachId, setAttachId] = useState("");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ class: "AA", certNumber: "", notifiedBody: "", expiresAt: "" });

  const loadRegistry = useCallback(async () => {
    try {
      setRegistry((await apiJson<{ certificates: Certificate[] }>("/api/certificates")).certificates);
    } catch { /* keep */ }
  }, []);
  useEffect(() => { void loadRegistry(); }, [loadRegistry]);

  const attachedIds = new Set(template.certCoverage.map((c) => c.certificateId));
  const attachable = registry.filter((c) => !attachedIds.has(c.id));

  const attach = async (certificateId: string) => {
    if (!certificateId) return;
    setBusy(true);
    try {
      await apiJson(`/api/products/templates/${template.id}/certs`, { method: "POST", body: JSON.stringify({ certificateId }) });
      setAttachId("");
      onChanged();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };

  const detach = async (certificateId: string) => {
    setBusy(true);
    try {
      await apiFetch(`/api/products/templates/${template.id}/certs?certificateId=${certificateId}`, { method: "DELETE" });
      onChanged();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };

  const createAndAttach = async () => {
    setBusy(true);
    try {
      const d = await apiJson<{ certificate: { id: string } }>("/api/certificates", {
        method: "POST",
        body: JSON.stringify({
          class: form.class,
          certNumber: form.certNumber.trim(),
          notifiedBody: form.notifiedBody.trim() || null,
          expiresAt: form.expiresAt ? new Date(`${form.expiresAt}T00:00:00`).toISOString() : null,
        }),
      });
      await apiJson(`/api/products/templates/${template.id}/certs`, { method: "POST", body: JSON.stringify({ certificateId: d.certificate.id }) });
      setCreating(false);
      setForm({ class: "AA", certNumber: "", notifiedBody: "", expiresAt: "" });
      await loadRegistry();
      onChanged();
      toast("Certificate created and attached", "success");
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ fontSize: 12, color: "var(--h10-text-2)" }}>
        EN 17092 impact-protection certificates covering this garment. FP6 will block shipping a unit
        whose class certificate is missing or expired.
      </div>

      {template.certCoverage.length === 0 && <div style={{ fontSize: 12.5, color: "var(--h10-text-3)" }}>No certificate attached yet.</div>}
      <div style={{ display: "grid", gap: 6 }}>
        {template.certCoverage.map((cov) => (
          <div key={cov.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", border: "1px solid var(--h10-border-subtle)", borderRadius: 8, padding: "8px 10px", fontSize: 12.5 }}>
            <Pill tone="info">{cov.certificate.standard} · {cov.certificate.class}</Pill>
            <b>#{cov.certificate.certNumber}</b>
            {cov.certificate.notifiedBody && <span style={{ color: "var(--h10-text-2)" }}>{cov.certificate.notifiedBody}</span>}
            {expiryChip(cov.certificate.expiresAt)}
            <button type="button" disabled={busy} title="Detach" onClick={() => void detach(cov.certificateId)} style={{ marginLeft: "auto", border: "none", background: "none", cursor: "pointer", color: "var(--h10-danger)", display: "inline-flex", padding: 2 }}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {attachable.length > 0 && (
          <>
            <Listbox ariaLabel="Attach existing certificate" options={[{ value: "", label: "Attach existing…" }, ...attachable.map((c) => ({ value: c.id, label: `${c.class} · #${c.certNumber}` }))]} value={attachId} onChange={(v) => { setAttachId(v); void attach(v); }} />
          </>
        )}
        <Button onClick={() => setCreating(true)}><Plus size={13} /> New certificate</Button>
      </div>

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="New EN 17092 certificate"
        size="sm"
        footer={<><Button onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" onClick={createAndAttach} disabled={!form.certNumber.trim() || busy}>Create & attach</Button></>}
      >
        <div style={{ display: "grid", gap: 10 }}>
          <Listbox ariaLabel="Class" options={CLASSES} value={form.class} onChange={(v) => setForm((f) => ({ ...f, class: v }))} />
          <Input placeholder="Certificate number" value={form.certNumber} onChange={(e) => setForm((f) => ({ ...f, certNumber: e.target.value }))} />
          <Input placeholder="Notified body (optional)" value={form.notifiedBody} onChange={(e) => setForm((f) => ({ ...f, notifiedBody: e.target.value }))} />
          <label style={{ fontSize: 12, color: "var(--h10-text-2)", display: "grid", gap: 4 }}>
            Expiry date
            <DateField ariaLabel="Expiry date" value={form.expiresAt} onChange={(v) => setForm((f) => ({ ...f, expiresAt: v }))} placeholder="no expiry" />
          </label>
        </div>
      </Modal>
    </div>
  );
}
