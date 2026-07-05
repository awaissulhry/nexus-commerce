/**
 * FP6 — the QC checklist + cert status. Ticking an item stamps who/when
 * (server-side). The live cert banner warns before Finish is even tried — the
 * hard block (FD14) is enforced when the QC stage is finished.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, ShieldAlert } from "lucide-react";
import { Checkbox } from "@/design-system/primitives";
import { useToast } from "@/design-system/components";
import { apiJson } from "@/lib/api-client";

type QC = { checklist: { item: string; checked: boolean }[]; certCheckPassed: boolean; cert: "ok" | "missing" | "expired" | "no_template" };
const CERT_MSG: Record<string, string> = { missing: "No EN 17092 certificate covers this garment — it can't be packed.", expired: "The EN 17092 certificate has expired — it can't be packed." };

export function QCChecklist({ stageId, canEdit, onChanged }: { stageId: string; canEdit: boolean; onChanged: () => void }) {
  const { toast } = useToast();
  const [qc, setQc] = useState<QC | null>(null);
  const load = useCallback(async () => { try { setQc(await apiJson<QC>(`/api/production/stages/${stageId}/qc`)); } catch { /* ignore */ } }, [stageId]);
  useEffect(() => { void load(); }, [load]);

  const save = async (checklist: { item: string; checked: boolean }[], certCheckPassed: boolean) => {
    try { await apiJson(`/api/production/stages/${stageId}/qc`, { method: "POST", body: JSON.stringify({ checklist: checklist.map((c) => ({ item: c.item, checked: c.checked })), certCheckPassed }) }); await load(); onChanged(); }
    catch (e) { toast((e as Error).message, "danger"); }
  };
  if (!qc) return null;
  const blocked = qc.cert === "missing" || qc.cert === "expired";

  return (
    <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", padding: 8, borderRadius: 8, fontSize: 12, background: blocked ? "var(--h10-wash-danger, #fdecec)" : "var(--h10-wash-success, #eaf7ee)", color: blocked ? "var(--h10-danger)" : "var(--h10-success)" }}>
        {blocked ? <ShieldAlert size={14} /> : <ShieldCheck size={14} />}
        {blocked ? CERT_MSG[qc.cert] : qc.cert === "ok" ? "EN 17092 certificate valid." : "No cert requirement resolved for this garment."}
      </div>
      <div style={{ display: "grid", gap: 5 }}>
        {qc.checklist.map((c) => (
          <label key={c.item} style={{ display: "inline-flex", gap: 8, alignItems: "center", fontSize: 12.5, cursor: canEdit ? "pointer" : "default", color: c.checked ? "var(--h10-text)" : "var(--h10-text-2)" }}>
            <Checkbox checked={c.checked} disabled={!canEdit} onChange={() => void save(qc.checklist.map((x) => (x.item === c.item ? { ...x, checked: !x.checked } : x)), qc.certCheckPassed)} aria-label={c.item} />
            {c.item}
          </label>
        ))}
      </div>
      <label style={{ display: "inline-flex", gap: 8, alignItems: "center", fontSize: 12.5, fontWeight: 600, cursor: canEdit ? "pointer" : "default" }}>
        <Checkbox checked={qc.certCheckPassed} disabled={!canEdit} onChange={() => void save(qc.checklist, !qc.certCheckPassed)} aria-label="Cert checked" />
        I verified the certificate
      </label>
    </div>
  );
}
