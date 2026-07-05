/** FP2.2 placeholder — real BOM & per-option draws editor lands in FP2.3. */
"use client";
import type { TemplateDetail } from "./types";

export function BomEditor({ template: _template }: { template: TemplateDetail; onChanged: () => void }) {
  return (
    <div style={{ fontSize: 13, color: "var(--h10-text-2)" }}>
      <b>Bill of materials & per-option draws</b> arrive in <b>FP2.3</b> (alongside the Materials
      registry these lines point at). The engine already composes material draws — this tab wires the
      editor.
    </div>
  );
}
