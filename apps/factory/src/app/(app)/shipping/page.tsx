/** FP8 — Shipping is LIVE: the golden flow's last leg (spec: docs/factory/FP8-SPEC.md). */
import { Suspense } from "react";
import { ShippingClient } from "./_components/ShippingClient";

export default function ShippingPage() {
  return (
    <Suspense fallback={null}>
      <ShippingClient />
    </Suspense>
  );
}
