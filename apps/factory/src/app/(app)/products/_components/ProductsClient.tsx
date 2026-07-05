/**
 * FP2 — the Products & Pricing workspace: three top tabs (Templates · Price
 * lists · Materials). The pricing model everything downstream consumes. Tab in
 * the URL (?tab=) so links and refreshes are stable.
 */
"use client";

import { Suspense, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { PageHeader } from "@/design-system/patterns";
import { Tabs } from "@/design-system/components";
import { TemplatesTab } from "./TemplatesTab";
import { PriceListsTab } from "./PriceListsTab";
import { MaterialsTab } from "./MaterialsTab";

const TABS = [
  { id: "templates", label: "Templates" },
  { id: "pricelists", label: "Price lists" },
  { id: "materials", label: "Materials" },
];

function ProductsInner() {
  const params = useSearchParams();
  const tab = params.get("tab") ?? "templates";
  const setTab = useCallback((id: string) => {
    const usp = new URLSearchParams(window.location.search);
    usp.set("tab", id);
    window.history.replaceState(null, "", `/products?${usp}`);
    // history.replaceState syncs with useSearchParams (Next interop); force a
    // re-render by dispatching popstate so the tab switch is immediate.
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);

  return (
    <div style={{ maxWidth: 1180 }}>
      <PageHeader
        eyebrow="Factory OS"
        title="Products & Pricing"
        subtitle="Templates, option pricing, BOMs, certificates and per-party price lists — the model every quote is composed from."
      />
      <div style={{ marginBottom: 12 }}>
        <Tabs tabs={TABS} active={tab} onChange={setTab} />
      </div>
      {tab === "templates" && <TemplatesTab />}
      {tab === "pricelists" && <PriceListsTab />}
      {tab === "materials" && <MaterialsTab />}
    </div>
  );
}

export function ProductsClient() {
  return (
    <Suspense fallback={null}>
      <ProductsInner />
    </Suspense>
  );
}
