/** FP2.2 placeholder — preview-as-configurator (waterfall + margin + goal-seek) lands in FP2.4. */
"use client";
import type { TemplateDetail } from "./types";

export function PreviewPanel({ template: _template }: { template: TemplateDetail }) {
  return (
    <div style={{ fontSize: 13, color: "var(--h10-text-2)" }}>
      <b>Preview-as-configurator</b> arrives in <b>FP2.4</b>: pick a party, toggle options, and watch
      the 4-line waterfall (Cost → List → Adjustment → Net), live margin, composed materials,
      constraint messages and goal-seek — server-composed through the FP2.1 engine and grain-stripped.
      This panel is FP3's dress rehearsal.
    </div>
  );
}
