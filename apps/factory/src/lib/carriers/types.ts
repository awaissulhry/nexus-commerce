/**
 * F1 + FP8 — the carrier contract. F1 shipped the CONNECTOR half (connect,
 * validate, capability-probe). FP8 adds the OPERATIONAL half: rates, buy-a-label,
 * void, poll-tracking — the four calls the golden flow's last leg needs, behind
 * one interface so a second carrier (MyDHL, FD6) is additive. The FakeCarrier
 * and the real Sendcloud adapter both implement `CarrierAdapter`.
 */
import type { Parcel } from "../shipping/parcel";

// ── F1: connect + probe ──────────────────────────────────────────
export type LabelFormat = "PDF_A4" | "PDF_A6" | "ZPL";

export type CarrierCaps = {
  supportsPickup: boolean;
  supportsPollingTracking: boolean; // REQUIRED true for local-first v1
  supportsWebhookTracking: boolean;
  supportsServicePoints: boolean;
  supportsOwnContract: boolean;
  supportsMulticollo: boolean;
  labelFormats: LabelFormat[];
};

export type ProbeResult = {
  ok: boolean;
  accountLabel?: string;
  checks: { name: string; ok: boolean; detail: string }[];
  caps: CarrierCaps;
};

export interface CarrierConnector {
  readonly id: string; // "sendcloud"
  readonly name: string;
  /** Validate credentials + empirically probe what the plan tier unlocks. */
  validateAndProbe(credentials: Record<string, string>): Promise<ProbeResult>;
}

// ── FP8: rates + buy + void + track ──────────────────────────────
export type Address = {
  name: string;
  company?: string;
  street: string;
  street2?: string;
  city: string;
  postalCode: string;
  country: string; // ISO-2, e.g. "IT"
  phone?: string;
  email?: string;
};

export type ShipInput = {
  shipmentId: string;
  orderNumber: string;
  to: Address;
  from?: Address; // optional — real carriers fall back to the account's default sender
  parcel: Parcel;
  currency?: string; // default EUR
};

export type Rate = {
  code: string; // carrier service code (opaque to us)
  carrier: string; // "BRT", "PostNL", …
  service: string; // human label
  costCents: number;
  currency: string;
  estDays?: number;
};

export type LabelResult = {
  trackingNumber: string;
  trackingUrl: string;
  carrier: string;
  service: string;
  costCents: number;
  currency: string;
  labelFormat: LabelFormat;
  labelBase64: string; // the PDF/ZPL bytes, base64 — stored locally by the buy route
  carrierRef?: string; // the carrier's own shipment id (for cancel/track)
};

export type TrackingUpdate = {
  trackingNumber: string;
  status: string; // RAW carrier status — mapCarrierStatus() interprets it (never trust the adapter to map)
  message?: string;
  occurredAt: string; // ISO
  raw?: unknown;
};

export interface CarrierAdapter {
  readonly id: string;
  readonly name: string;
  /** Advisory rates for a parcel+destination; the buy panel pre-selects the cheapest. */
  getRates(input: ShipInput): Promise<Rate[]>;
  /** Buy a label. Returns tracking + the label bytes (stored locally, never a public URL). */
  createShipment(input: ShipInput, rate: Rate): Promise<LabelResult>;
  /** Void before dispatch (best-effort; resolves even if already gone). */
  cancelShipment(carrierRef: string): Promise<void>;
  /** Batched, read-only tracking poll for in-flight shipments. */
  pollTracking(trackingNumbers: string[]): Promise<TrackingUpdate[]>;
}
