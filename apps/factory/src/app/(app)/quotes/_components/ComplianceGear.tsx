/**
 * EPQ.5 — the Legal gear on the Quotes page header (home-page rule: the config
 * lives where it is used). Edits AppSetting quotes.cgv {version, url, text}
 * — the CGV reference the PDF + accept page print and the acceptance evidence
 * records — and AppSetting quotes.bankDetails, the bank-transfer instructions
 * shown as the deposit fallback on the acceptance page. Content is the
 * Owner's input; everything renders empty-safe until it lands.
 */
"use client";

import { useState } from "react";
import { Scale } from "lucide-react";
import { Modal, useToast } from "@/design-system/components";
import { Button, Input, Textarea } from "@/design-system/primitives";
import { apiJson } from "@/lib/api-client";
import type { CgvSetting } from "@/lib/quotes/legal";

export function ComplianceGear() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [cgv, setCgv] = useState<CgvSetting>({ version: "1.0", url: "", text: "" });
  const [bankDetails, setBankDetails] = useState("");

  const openModal = async () => {
    setOpen(true);
    try {
      const d = await apiJson<{ cgv: CgvSetting; bankDetails: string }>("/api/quotes/compliance-config");
      setCgv(d.cgv);
      setBankDetails(d.bankDetails);
      setLoaded(true);
    } catch (e) {
      toast((e as Error).message, "danger");
      setOpen(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      await apiJson("/api/quotes/compliance-config", { method: "PATCH", body: JSON.stringify({ cgv, bankDetails }) });
      toast("Legal settings saved", "success");
      setOpen(false);
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        aria-label="Legal settings (CGV, bank details)"
        title="Legal settings — CGV + bank details"
        onClick={() => void openModal()}
        style={{ display: "inline-flex", gap: 4, alignItems: "center", border: "none", background: "none", cursor: "pointer", color: "var(--h10-text-link)", fontSize: 12, padding: 0, font: "inherit" }}
      >
        <Scale size={13} /> Legal
      </button>
      <Modal
        open={open}
        onClose={() => !busy && setOpen(false)}
        title="Legal settings"
        size="sm"
        footer={<><Button onClick={() => setOpen(false)} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy || !loaded}>{busy ? "Saving…" : "Save"}</Button></>}
      >
        <div style={{ display: "grid", gap: 10, fontSize: 12.5 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--h10-text-3)" }}>Condizioni generali di vendita</div>
          <div style={{ color: "var(--h10-text-3)", fontSize: 11.5 }}>
            Referenced on every new PDF + accept page and recorded in the acceptance evidence. Left empty, the line is simply omitted. Bump the version whenever the text changes.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <label style={{ display: "grid", gap: 3, fontSize: 11.5, color: "var(--h10-text-2)", width: 90 }}>Version
              <Input value={cgv.version} onChange={(e) => setCgv((c) => ({ ...c, version: e.target.value }))} aria-label="CGV version" />
            </label>
            <label style={{ display: "grid", gap: 3, fontSize: 11.5, color: "var(--h10-text-2)", flex: 1 }}>Public URL (optional)
              <Input value={cgv.url} onChange={(e) => setCgv((c) => ({ ...c, url: e.target.value }))} placeholder="https://…" aria-label="CGV URL" />
            </label>
          </div>
          <label style={{ display: "grid", gap: 3, fontSize: 11.5, color: "var(--h10-text-2)" }}>Text (optional; used when there is no URL)
            <Textarea value={cgv.text} onChange={(e) => setCgv((c) => ({ ...c, text: e.target.value }))} rows={4} aria-label="CGV text" />
          </label>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--h10-text-3)", marginTop: 4 }}>Bank transfer details</div>
          <div style={{ color: "var(--h10-text-3)", fontSize: 11.5 }}>
            Shown to the customer after acceptance as the way to pay the deposit (always, Stripe or not).
          </div>
          <Textarea value={bankDetails} onChange={(e) => setBankDetails(e.target.value)} rows={3} placeholder={"IBAN IT…\nIntestato a …"} aria-label="Bank details" />
        </div>
      </Modal>
    </>
  );
}
