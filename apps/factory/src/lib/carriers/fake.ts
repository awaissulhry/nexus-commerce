/**
 * FP8 — the FakeCarrierAdapter: a deterministic, zero-network carrier so the
 * whole flow (rates → buy → real PDF → tracking → delivered) is provable on the
 * verify build with no live Sendcloud account and no spend. `resolveAdapter`
 * selects it whenever no carrier is connected (and always under the verify
 * force-flag). Rates are derived from parcel weight; tracking advances one step
 * per poll (Announced → In transit → Delivered) via in-process counters, so a
 * verify can drive a shipment to delivered in three polls without wall-clock waits.
 */
import type { CarrierAdapter, LabelResult, Rate, ShipInput, TrackingUpdate } from "./types";
import { renderLabelPdf } from "../shipping/render-label";

const STEPS = ["Announced", "In transit", "Delivered"];
// in-process progression counter per tracking number (a fake needs no durability)
const g = globalThis as unknown as { __fakeCarrierPolls?: Map<string, number> };
const polls: Map<string, number> = (g.__fakeCarrierPolls ??= new Map());

function ratesFor(input: ShipInput): Rate[] {
  const kg = Math.max(1, Math.ceil(input.parcel.weightGrams / 1000));
  const currency = input.currency ?? "EUR";
  return [
    { code: "unstamped", carrier: "Test", service: "Unstamped letter (free)", costCents: 0, currency, estDays: 3 },
    { code: "poste_crono", carrier: "Poste Italiane", service: "Crono", costCents: 490 + (kg - 1) * 100, currency, estDays: 3 },
    { code: "brt_express", carrier: "BRT", service: "Express", costCents: 750 + (kg - 1) * 150, currency, estDays: 1 },
  ];
}

export const fakeCarrierAdapter: CarrierAdapter = {
  id: "fake",
  name: "Test carrier (no account connected)",

  async getRates(input) {
    return ratesFor(input);
  },

  async createShipment(input, rate) {
    const trackingNumber = `FAKE-${input.shipmentId.replace(/[^a-zA-Z0-9]/g, "").slice(-8).toUpperCase()}`;
    const pdf = await renderLabelPdf({
      orderNumber: input.orderNumber,
      trackingNumber,
      carrier: rate.carrier,
      service: rate.service,
      to: input.to,
      from: input.from,
    });
    polls.delete(trackingNumber); // fresh progression if a shipmentId is reused
    const result: LabelResult = {
      trackingNumber,
      trackingUrl: `https://track.invalid.test/${trackingNumber}`,
      carrier: rate.carrier,
      service: rate.service,
      costCents: rate.costCents,
      currency: rate.currency,
      labelFormat: "PDF_A6",
      labelBase64: pdf.toString("base64"),
      carrierRef: trackingNumber,
    };
    return result;
  },

  async cancelShipment(carrierRef) {
    polls.delete(carrierRef);
  },

  async pollTracking(trackingNumbers) {
    const now = new Date().toISOString();
    const out: TrackingUpdate[] = [];
    for (const tn of trackingNumbers) {
      const count = polls.get(tn) ?? 0;
      const step = Math.min(count, STEPS.length - 1);
      polls.set(tn, count + 1);
      out.push({ trackingNumber: tn, status: STEPS[step], message: STEPS[step], occurredAt: now });
    }
    return out;
  },
};
