/** FP2.2 placeholder — price lists + preview-as-configurator land in FP2.4. */
"use client";
import { Card } from "@/design-system/components";

export function PriceListsTab() {
  return (
    <Card padded>
      <div style={{ fontSize: 13, color: "var(--h10-text-2)" }}>
        <b>Price lists</b> arrive in <b>FP2.4</b> (FD7): a new party list starts empty — it <i>is</i>
        the Listino base until you override the exact lines you negotiated. The preview-as-configurator
        composes each party's price live through the FP2.1 engine.
      </div>
    </Card>
  );
}
