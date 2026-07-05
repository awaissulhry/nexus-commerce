/** FP8 — shipping workspace shapes (cost optional: grain-stripped for non-financial callers). */
export type Address = { name: string; company?: string; street: string; street2?: string; city: string; postalCode: string; country: string; phone?: string; email?: string };

export type ParcelPreset = { key: string; label: string; weightGrams: number; lengthCm: number; widthCm: number; heightCm: number };

export type ReadyRow = { id: string; number: string; partyId: string; partyName: string; promiseDateAt: string | null; lineCount: number; address: Address | null };

export type ShipmentState = "CREATED" | "LABEL_PURCHASED" | "IN_TRANSIT" | "DELIVERED" | "EXCEPTION" | "CANCELLED";

export type InflightRow = {
  id: string;
  orderId: string;
  orderNumber: string;
  partyName: string;
  service: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  state: ShipmentState;
  costCents?: number;
  createdAt: string;
  updatedAt: string;
};

export type ShippingResponse = {
  ready: ReadyRow[];
  inflight: InflightRow[];
  presets: ParcelPreset[];
  carrier: { connected: boolean; label: string | null; name: string };
};

export type Rate = { code: string; carrier: string; service: string; costCents?: number; currency: string; estDays?: number };
export type RatesResponse = { rates: Rate[]; cheapestCode: string | null; live: boolean };

export const SHIP_TONE: Record<ShipmentState, "neutral" | "info" | "warning" | "success" | "danger"> = {
  CREATED: "neutral",
  LABEL_PURCHASED: "info",
  IN_TRANSIT: "info",
  DELIVERED: "success",
  EXCEPTION: "danger",
  CANCELLED: "neutral",
};

export const SHIP_LABEL: Record<ShipmentState, string> = {
  CREATED: "created",
  LABEL_PURCHASED: "label bought",
  IN_TRANSIT: "in transit",
  DELIVERED: "delivered",
  EXCEPTION: "needs attention",
  CANCELLED: "voided",
};
