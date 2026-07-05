/** FP2.2 placeholder — the Materials mini-registry lands in FP2.3. */
"use client";
import { Card } from "@/design-system/components";

export function MaterialsTab() {
  return (
    <Card padded>
      <div style={{ fontSize: 13, color: "var(--h10-text-2)" }}>
        The <b>Materials registry</b> (leather by hide/m², linings, armor, thread — with current cost
        and reorder level, plus CSV import) lands in <b>FP2.3</b>, so BOM lines have something to point
        at. The full Materials page (lots, the movement-ledger UI, purchase orders, four-column stock)
        stays <b>FP7</b>; this cycle is catalog-only.
      </div>
    </Card>
  );
}
