/**
 * FP8.2 — the Shipping workspace: a Ready-to-ship queue (orders the floor
 * finished) and an In-flight list (live shipments), plus the two-click buy panel
 * — parcel preset → ship-to (prefilled) → rates (cheapest pre-selected) →
 * Confirm & print. Buying flips the order to SHIPPED and opens the label PDF.
 * Cost is grain-gated; the workers never reach this page (Owner surface).
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Truck, Package, ExternalLink, Printer } from "lucide-react";
import { DataGrid, Drawer, useToast } from "@/design-system/components";
import { Button, Pill, RadioCard } from "@/design-system/primitives";
import { eur } from "@/design-system/lib/format";
import { apiJson } from "@/lib/api-client";
import { usePermission } from "@/lib/auth/client";
import { type Address, type InflightRow, type ParcelPreset, type Rate, type RatesResponse, type ReadyRow, type ShippingResponse, SHIP_LABEL, SHIP_TONE } from "./types";

const inp: React.CSSProperties = { width: "100%", border: "1px solid var(--h10-border)", borderRadius: 7, padding: "6px 8px", fontSize: 12.5, background: "var(--h10-surface)", color: "var(--h10-text)" };
const lbl: React.CSSProperties = { fontSize: 11.5, color: "var(--h10-text-3)", marginBottom: 3 };
const emptyAddr = (): Address => ({ name: "", street: "", city: "", postalCode: "", country: "IT", phone: "" });
const dmy = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "—");

export function ShippingClient() {
  const { toast } = useToast();
  const params = useSearchParams();
  const canCost = usePermission("financials.costs.view");
  const canBuy = usePermission("labels.purchase");
  const [data, setData] = useState<ShippingResponse | null>(null);
  const [buyOrder, setBuyOrder] = useState<ReadyRow | null>(null);

  const load = useCallback(async () => {
    try { setData(await apiJson<ShippingResponse>("/api/shipping")); }
    catch (e) { toast((e as Error).message, "danger"); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  // deep-link ?buy=<orderId> opens the panel once the queue is loaded
  const buyParam = params.get("buy");
  useEffect(() => {
    if (!buyParam || !data) return;
    const o = data.ready.find((r) => r.id === buyParam);
    if (o) setBuyOrder(o);
  }, [buyParam, data]);

  return (
    <div className="factory-page factory-grid-grow-1">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0, display: "flex", alignItems: "center", gap: 8 }}><Truck size={18} /> Shipping</h1>
          <div style={{ fontSize: 12.5, color: "var(--h10-text-2)", marginTop: 2 }}>Buy a label, share the tracking, and let the order move to delivered.</div>
        </div>
        <div style={{ marginLeft: "auto" }}>
          {data && (data.carrier.connected
            ? <Pill tone="success">Connected · {data.carrier.label ?? data.carrier.name}</Pill>
            : <Pill tone="warning">No carrier connected · test mode</Pill>)}
        </div>
      </div>

      <section style={{ marginBottom: 22 }}>
        <SectionHeading icon={<Package size={14} />} title="Ready to ship" count={data?.ready.length} />
        <DataGrid
          columns={[
            { key: "number", label: "Order", render: (r: ReadyRow) => <b>{r.number}</b> },
            { key: "party", label: "Customer", render: (r: ReadyRow) => r.partyName },
            { key: "lines", label: "Items", align: "right" as const, render: (r: ReadyRow) => r.lineCount },
            { key: "promise", label: "Promised", render: (r: ReadyRow) => dmy(r.promiseDateAt) },
            { key: "buy", label: "", align: "right" as const, render: (r: ReadyRow) => (canBuy ? <Button variant="primary" onClick={() => setBuyOrder(r)}><Printer size={13} /> Buy label</Button> : null) },
          ]}
          rows={data?.ready ?? []}
          rowKey={(r: ReadyRow) => r.id}
          emptyState="Nothing ready to ship — orders land here when production finishes."
        />
      </section>

      <section>
        <SectionHeading icon={<Truck size={14} />} title="In flight" count={data?.inflight.length} />
        <DataGrid
          columns={[
            { key: "order", label: "Order", render: (r: InflightRow) => <b>{r.orderNumber}</b> },
            { key: "party", label: "Customer", render: (r: InflightRow) => r.partyName },
            { key: "carrier", label: "Carrier", render: (r: InflightRow) => r.service ?? "—" },
            { key: "tracking", label: "Tracking", render: (r: InflightRow) => (r.trackingUrl ? <a href={r.trackingUrl} target="_blank" rel="noreferrer" style={{ color: "var(--h10-text-link)", display: "inline-flex", gap: 4, alignItems: "center" }}>{r.trackingNumber} <ExternalLink size={11} /></a> : (r.trackingNumber ?? "—")) },
            { key: "state", label: "Status", render: (r: InflightRow) => <Pill tone={SHIP_TONE[r.state]}>{SHIP_LABEL[r.state]}</Pill> },
            ...(canCost ? [{ key: "cost", label: "Cost", align: "right" as const, render: (r: InflightRow) => (r.costCents != null ? eur(r.costCents) : "—") }] : []),
            { key: "label", label: "", align: "right" as const, render: (r: InflightRow) => <a href={`/api/shipping/${r.id}/label`} target="_blank" rel="noreferrer" style={{ color: "var(--h10-text-link)", fontSize: 12, display: "inline-flex", gap: 4, alignItems: "center" }}><Printer size={12} /> Label</a> },
          ]}
          rows={data?.inflight ?? []}
          rowKey={(r: InflightRow) => r.id}
          emptyState="No shipments in flight."
        />
      </section>

      <BuyPanel order={buyOrder} presets={data?.presets ?? []} canCost={canCost} onClose={() => setBuyOrder(null)} onBought={() => { setBuyOrder(null); void load(); }} />
    </div>
  );
}

function SectionHeading({ icon, title, count }: { icon: React.ReactNode; title: string; count?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8, fontSize: 13, fontWeight: 700, color: "var(--h10-text)" }}>
      {icon}<span>{title}</span>{count != null && <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--h10-text-3)", background: "var(--h10-surface-2)", borderRadius: 20, padding: "1px 8px" }}>{count}</span>}
    </div>
  );
}

function BuyPanel({ order, presets, canCost, onClose, onBought }: { order: ReadyRow | null; presets: ParcelPreset[]; canCost: boolean; onClose: () => void; onBought: () => void }) {
  const { toast } = useToast();
  const [presetKey, setPresetKey] = useState("");
  const [custom, setCustom] = useState({ weightGrams: "", lengthCm: "", widthCm: "", heightCm: "" });
  const [to, setTo] = useState<Address>(emptyAddr());
  const [rates, setRates] = useState<Rate[] | null>(null);
  const [rateCode, setRateCode] = useState("");
  const [busy, setBusy] = useState<"rates" | "buy" | null>(null);

  // reset the form whenever a new order opens; prefill the remembered address
  useEffect(() => {
    if (!order) return;
    setTo(order.address ? { ...emptyAddr(), ...order.address } : { ...emptyAddr(), name: order.partyName });
    setPresetKey(presets.find((p) => p.key === "M") ? "M" : (presets[0]?.key ?? "custom"));
    setCustom({ weightGrams: "", lengthCm: "", widthCm: "", heightCm: "" });
    setRates(null); setRateCode(""); setBusy(null);
  }, [order, presets]);

  const parcel = useMemo(() => {
    if (presetKey === "custom") {
      const p = { weightGrams: +custom.weightGrams, lengthCm: +custom.lengthCm, widthCm: +custom.widthCm, heightCm: +custom.heightCm };
      return p.weightGrams > 0 && p.lengthCm > 0 && p.widthCm > 0 && p.heightCm > 0 ? p : null;
    }
    const preset = presets.find((p) => p.key === presetKey);
    return preset ? { weightGrams: preset.weightGrams, lengthCm: preset.lengthCm, widthCm: preset.widthCm, heightCm: preset.heightCm } : null;
  }, [presetKey, custom, presets]);

  // changing parcel/address invalidates fetched rates (never buy at a stale price)
  useEffect(() => { setRates(null); setRateCode(""); }, [parcel, to]);

  const addrOk = to.name && to.street && to.city && to.postalCode && to.country.length === 2;
  const set = (k: keyof Address) => (e: React.ChangeEvent<HTMLInputElement>) => setTo((a) => ({ ...a, [k]: e.target.value }));

  const getRates = async () => {
    if (!order || !parcel || !addrOk) { toast("Fill the parcel and a complete address first", "danger"); return; }
    setBusy("rates");
    try {
      const r = await apiJson<RatesResponse>("/api/shipping/rates", { method: "POST", body: JSON.stringify({ orderId: order.id, to, parcel }) });
      setRates(r.rates); setRateCode(r.cheapestCode ?? r.rates[0]?.code ?? "");
      if (r.rates.length === 0) toast("No rates for that parcel/address", "danger");
    } catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(null); }
  };

  const buy = async () => {
    if (!order || !parcel || !rateCode) return;
    setBusy("buy");
    try {
      const r = await apiJson<{ labelUrl: string; trackingNumber: string }>("/api/shipping/buy", { method: "POST", body: JSON.stringify({ orderId: order.id, to, parcel, rateCode }) });
      if (typeof window !== "undefined") window.open(r.labelUrl, "_blank");
      toast(`Label bought — ${r.trackingNumber}`, "success");
      onBought();
    } catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(null); }
  };

  return (
    <Drawer open={!!order} onClose={onClose} title={order ? `Buy label — ${order.number}` : "Buy label"} footer={
      <div style={{ display: "flex", gap: 8, width: "100%" }}>
        {!rates ? (
          <Button variant="primary" onClick={getRates} disabled={busy !== null || !parcel || !addrOk} style={{ marginLeft: "auto" }}>{busy === "rates" ? "Getting rates…" : "Get rates"}</Button>
        ) : (
          <Button variant="primary" onClick={buy} disabled={busy !== null || !rateCode} style={{ marginLeft: "auto" }}><Printer size={13} /> {busy === "buy" ? "Buying…" : "Confirm & print"}</Button>
        )}
      </div>
    }>
      {order && (
        <div style={{ display: "grid", gap: 16 }}>
          <div>
            <div style={lbl}>Parcel</div>
            <div style={{ display: "grid", gap: 6 }}>
              {presets.map((p) => (
                <RadioCard key={p.key} name="preset" value={p.key} title={p.label} description={`${p.weightGrams} g · ${p.lengthCm}×${p.widthCm}×${p.heightCm} cm`} selected={presetKey === p.key} checked={presetKey === p.key} onChange={() => setPresetKey(p.key)} />
              ))}
              <RadioCard name="preset" value="custom" title="Custom" description="Enter weight and dimensions" selected={presetKey === "custom"} checked={presetKey === "custom"} onChange={() => setPresetKey("custom")} />
            </div>
            {presetKey === "custom" && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6, marginTop: 6 }}>
                <NumIn label="Weight (g)" v={custom.weightGrams} on={(v) => setCustom((c) => ({ ...c, weightGrams: v }))} />
                <NumIn label="L (cm)" v={custom.lengthCm} on={(v) => setCustom((c) => ({ ...c, lengthCm: v }))} />
                <NumIn label="W (cm)" v={custom.widthCm} on={(v) => setCustom((c) => ({ ...c, widthCm: v }))} />
                <NumIn label="H (cm)" v={custom.heightCm} on={(v) => setCustom((c) => ({ ...c, heightCm: v }))} />
              </div>
            )}
          </div>

          <div>
            <div style={lbl}>Ship to</div>
            <div style={{ display: "grid", gap: 6 }}>
              <input style={inp} placeholder="Recipient name" value={to.name} onChange={set("name")} />
              <input style={inp} placeholder="Company (optional)" value={to.company ?? ""} onChange={set("company")} />
              <input style={inp} placeholder="Street and number" value={to.street} onChange={set("street")} />
              <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: 6 }}>
                <input style={inp} placeholder="Postal code" value={to.postalCode} onChange={set("postalCode")} />
                <input style={inp} placeholder="City" value={to.city} onChange={set("city")} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: 6 }}>
                <input style={inp} placeholder="Country" maxLength={2} value={to.country} onChange={(e) => setTo((a) => ({ ...a, country: e.target.value.toUpperCase() }))} />
                <input style={inp} placeholder="Phone (optional)" value={to.phone ?? ""} onChange={set("phone")} />
              </div>
            </div>
          </div>

          {rates && (
            <div>
              <div style={lbl}>Rate {rates.length > 0 && <span style={{ color: "var(--h10-text-3)" }}>· cheapest pre-selected</span>}</div>
              <div style={{ display: "grid", gap: 6 }}>
                {rates.map((r) => {
                  const cheapest = rates.every((x) => (x.costCents ?? Infinity) >= (r.costCents ?? Infinity));
                  return (
                    <label key={r.code} style={{ display: "flex", alignItems: "center", gap: 8, border: `1px solid ${rateCode === r.code ? "var(--h10-primary)" : "var(--h10-border)"}`, borderRadius: 8, padding: "8px 10px", cursor: "pointer", background: rateCode === r.code ? "var(--h10-primary-subtle)" : "var(--h10-surface)" }}>
                      <input type="radio" name="rate" checked={rateCode === r.code} onChange={() => setRateCode(r.code)} style={{ accentColor: "var(--h10-primary)" }} />
                      <span style={{ fontSize: 12.5 }}><b>{r.carrier}</b> · {r.service}{r.estDays ? <span style={{ color: "var(--h10-text-3)" }}> · ~{r.estDays}d</span> : null}</span>
                      <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6, alignItems: "center" }}>
                        {cheapest && r.costCents === 0 && <Pill tone="success">free</Pill>}
                        {canCost && r.costCents != null && <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12.5 }}>{eur(r.costCents)}</span>}
                      </span>
                    </label>
                  );
                })}
              </div>
              <button type="button" onClick={() => { setRates(null); setRateCode(""); }} style={{ marginTop: 6, background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 11.5, color: "var(--h10-text-link)" }}>← change parcel or address</button>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

function NumIn({ label, v, on }: { label: string; v: string; on: (v: string) => void }) {
  return (
    <div>
      <div style={{ ...lbl, fontSize: 10.5 }}>{label}</div>
      <input type="number" min="0" style={inp} value={v} onChange={(e) => on(e.target.value)} />
    </div>
  );
}
