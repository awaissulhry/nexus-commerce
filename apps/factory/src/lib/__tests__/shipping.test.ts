/**
 * FP8 — the shipping core is where the risk lives (carrier-status interpretation,
 * forward-only advance, order flips, cheapest-rate, parcel presets) plus the
 * FakeCarrier contract that the whole headless verify rides on. All pure /
 * in-process — no network, no DB.
 */
import { describe, expect, it } from "vitest";
import {
  mapCarrierStatus, advanceShipmentState, deriveShipmentState, orderStateFromShipment, cheapestRate, isVoidable,
} from "../shipping/shipment-state";
import { DEFAULT_PRESETS, parcelFromPreset, resolvePresets, isValidParcel } from "../shipping/parcel";
import { trackingEmail } from "../shipping/tracking-email";
import { fakeCarrierAdapter } from "../carriers/fake";
import type { ShipInput } from "../carriers/types";

describe("mapCarrierStatus", () => {
  it("reads delivered, but a failed delivery attempt is an EXCEPTION not DELIVERED", () => {
    expect(mapCarrierStatus("Delivered")).toBe("DELIVERED");
    expect(mapCarrierStatus("Delivery attempt failed")).toBe("EXCEPTION");
    expect(mapCarrierStatus("Parcel delivered to neighbour")).toBe("DELIVERED");
  });
  it("reads the many in-transit phrasings", () => {
    for (const s of ["In transit", "En route to sorting center", "Sorted", "Out for delivery", "Picked up", "At sorting centre"]) {
      expect(mapCarrierStatus(s)).toBe("IN_TRANSIT");
    }
  });
  it("reads pre-transit as CREATED and the unknown as null", () => {
    expect(mapCarrierStatus("Announced")).toBe("CREATED");
    expect(mapCarrierStatus("Ready to send")).toBe("CREATED");
    expect(mapCarrierStatus("")).toBeNull();
    expect(mapCarrierStatus("banana")).toBeNull();
  });
});

describe("advanceShipmentState (forward-only)", () => {
  it("never drags a purchased label back to created", () => {
    expect(advanceShipmentState("LABEL_PURCHASED", "CREATED")).toBe("LABEL_PURCHASED");
  });
  it("moves forward through transit to delivered", () => {
    expect(advanceShipmentState("LABEL_PURCHASED", "IN_TRANSIT")).toBe("IN_TRANSIT");
    expect(advanceShipmentState("IN_TRANSIT", "DELIVERED")).toBe("DELIVERED");
  });
  it("a delivered parcel still wins over a late exception, but cancelled is terminal", () => {
    expect(advanceShipmentState("EXCEPTION", "DELIVERED")).toBe("DELIVERED");
    expect(advanceShipmentState("CANCELLED", "IN_TRANSIT")).toBe("CANCELLED");
    expect(advanceShipmentState("IN_TRANSIT", null)).toBe("IN_TRANSIT");
  });
  it("folds a chronological batch forward-only", () => {
    expect(deriveShipmentState("LABEL_PURCHASED", ["Announced", "In transit", "Delivered"])).toBe("DELIVERED");
    expect(deriveShipmentState("LABEL_PURCHASED", ["Delivered", "Announced"])).toBe("DELIVERED"); // stale replay can't undo
  });
});

describe("orderStateFromShipment", () => {
  it("a bought label ships a READY order; a delivered parcel delivers a SHIPPED order", () => {
    expect(orderStateFromShipment("READY", "LABEL_PURCHASED")).toBe("SHIPPED");
    expect(orderStateFromShipment("READY", "IN_TRANSIT")).toBe("SHIPPED");
    expect(orderStateFromShipment("SHIPPED", "DELIVERED")).toBe("DELIVERED");
  });
  it("never downgrades or reacts to an exception", () => {
    expect(orderStateFromShipment("DELIVERED", "IN_TRANSIT")).toBeNull();
    expect(orderStateFromShipment("SHIPPED", "EXCEPTION")).toBeNull();
    expect(orderStateFromShipment("CLOSED", "DELIVERED")).toBeNull();
  });
});

describe("cheapestRate / voidable", () => {
  it("picks the minimum, stable on ties, null on empty", () => {
    expect(cheapestRate([{ costCents: 750 }, { costCents: 0 }, { costCents: 490 }])?.costCents).toBe(0);
    expect(cheapestRate([])).toBeNull();
    const tie = [{ costCents: 5, carrier: "A" }, { costCents: 5, carrier: "B" }];
    expect(cheapestRate(tie)?.carrier).toBe("A");
  });
  it("only a pre-dispatch shipment is voidable", () => {
    expect(isVoidable("LABEL_PURCHASED")).toBe(true);
    expect(isVoidable("IN_TRANSIT")).toBe(false);
    expect(isVoidable("DELIVERED")).toBe(false);
  });
});

describe("parcel presets", () => {
  it("resolves a preset to a parcel and validates it", () => {
    const p = parcelFromPreset("M");
    expect(p?.weightGrams).toBe(1500);
    expect(isValidParcel(p)).toBe(true);
    expect(parcelFromPreset("nope")).toBeNull();
    expect(isValidParcel({ weightGrams: 0, lengthCm: 1, widthCm: 1, heightCm: 1 })).toBe(false);
  });
  it("falls back to defaults on a malformed AppSetting", () => {
    expect(resolvePresets(null)).toBe(DEFAULT_PRESETS);
    expect(resolvePresets({ presets: "nonsense" })).toBe(DEFAULT_PRESETS);
    const custom = resolvePresets({ presets: [{ key: "XL", label: "Huge", weightGrams: 9000, lengthCm: 80, widthCm: 60, heightCm: 40 }] });
    expect(custom[0].key).toBe("XL");
  });
});

describe("trackingEmail (cost-free by construction)", () => {
  const input = { orderNumber: "ORD-9", partyName: "AWA", carrier: "BRT", service: "Express", trackingNumber: "TN123", trackingUrl: "https://x.test/TN123" };
  it("carries the tracking facts and never a price — IT default, EN option", () => {
    const it = trackingEmail(input);
    expect(it.subject).toContain("ORD-9");
    expect(it.body).toContain("TN123");
    expect(it.body).toContain("spedito");
    expect(JSON.stringify(it)).not.toMatch(/€|cent|Cents|\d+[.,]\d{2}/);
    const en = trackingEmail(input, "en");
    expect(en.body).toContain("shipped");
  });
});

describe("FakeCarrierAdapter contract", () => {
  const input: ShipInput = {
    shipmentId: "cmshiptest001",
    orderNumber: "ORD-9",
    to: { name: "AWA", street: "Via Roma 1", city: "Milano", postalCode: "20100", country: "IT" },
    parcel: { weightGrams: 1500, lengthCm: 40, widthCm: 30, heightCm: 15 },
  };
  it("offers rates with a free option as the cheapest", async () => {
    const rates = await fakeCarrierAdapter.getRates(input);
    expect(rates.length).toBeGreaterThanOrEqual(2);
    expect(cheapestRate(rates)?.costCents).toBe(0);
  });
  it("buys a real PDF label with a tracking number", async () => {
    const rates = await fakeCarrierAdapter.getRates(input);
    const label = await fakeCarrierAdapter.createShipment(input, cheapestRate(rates)!);
    expect(label.trackingNumber).toMatch(/^FAKE-/);
    expect(Buffer.from(label.labelBase64, "base64").toString("latin1").startsWith("%PDF")).toBe(true);
  });
  it("advances Announced → In transit → Delivered across three polls", async () => {
    const tn = "FAKE-POLLTEST1";
    const s1 = await fakeCarrierAdapter.pollTracking([tn]);
    const s2 = await fakeCarrierAdapter.pollTracking([tn]);
    const s3 = await fakeCarrierAdapter.pollTracking([tn]);
    expect(mapCarrierStatus(s1[0].status)).toBe("CREATED");
    expect(mapCarrierStatus(s2[0].status)).toBe("IN_TRANSIT");
    expect(mapCarrierStatus(s3[0].status)).toBe("DELIVERED");
  });
});
