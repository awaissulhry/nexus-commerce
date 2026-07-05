/** FP2.2 placeholder — EN 17092 certificate registry + coverage lands in FP2.3. */
"use client";
import type { TemplateDetail } from "./types";

export function CertificatesEditor({ template: _template }: { template: TemplateDetail; onChanged: () => void }) {
  return (
    <div style={{ fontSize: 13, color: "var(--h10-text-2)" }}>
      <b>EN 17092 certificates</b> (class, number, notified body, expiry) attach here in <b>FP2.3</b>.
      FP6 will block PACKING when a garment's cert is missing or expired (FD14).
    </div>
  );
}
