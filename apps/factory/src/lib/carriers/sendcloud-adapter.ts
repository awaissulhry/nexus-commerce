/**
 * FP8 — the real Sendcloud adapter (FD6). Basic-auth against panel.sendcloud.sc
 * v2: /shipping_methods (rates), /parcels?request_label (buy → download the PDF),
 * /parcels/{id}/cancel (void), /tracking/{number} (poll). Built to the same
 * `CarrierAdapter` contract as the fake, so the routes and worker don't know
 * which is live. NOT exercised in headless verify (no account) — the Owner's
 * €0 unstamped-letter label at the gate is its first real run.
 */
import type { CarrierAdapter, LabelResult, Rate, ShipInput, TrackingUpdate } from "./types";

const BASE = "https://panel.sendcloud.sc/api/v2";
const TIMEOUT_MS = 15_000;

export function sendcloudAdapter(publicKey: string, secretKey: string): CarrierAdapter {
  const auth = "Basic " + Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  const headers = { Authorization: auth, Accept: "application/json", "Content-Type": "application/json" };

  const call = (path: string, init?: RequestInit) =>
    fetch(`${BASE}${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(TIMEOUT_MS) });

  return {
    id: "sendcloud",
    name: "Sendcloud",

    async getRates(input): Promise<Rate[]> {
      const kg = input.parcel.weightGrams / 1000;
      const q = new URLSearchParams({ to_country: input.to.country, ...(input.from?.country ? { from_country: input.from.country } : {}) });
      const res = await call(`/shipping_methods?${q.toString()}`);
      if (!res.ok) throw new Error(`Sendcloud rates HTTP ${res.status}`);
      const body = (await res.json()) as { shipping_methods?: ScMethod[] };
      const methods = body.shipping_methods ?? [];
      return methods
        .filter((m) => kg >= toNum(m.min_weight, 0) && kg <= toNum(m.max_weight, Infinity))
        .map((m) => {
          const country = m.countries?.find((c) => c.iso_2 === input.to.country) ?? m.countries?.[0];
          const price = toNum(country?.price, 0);
          return {
            code: String(m.id),
            carrier: m.carrier ?? "Sendcloud",
            service: m.name ?? `Method ${m.id}`,
            costCents: Math.round(price * 100),
            currency: input.currency ?? "EUR",
          } satisfies Rate;
        });
    },

    async createShipment(input, rate): Promise<LabelResult> {
      const body = {
        parcel: {
          name: input.to.name,
          company_name: input.to.company ?? "",
          address: input.to.street,
          address_2: input.to.street2 ?? "",
          city: input.to.city,
          postal_code: input.to.postalCode,
          country: input.to.country,
          telephone: input.to.phone ?? "",
          email: input.to.email ?? "",
          weight: (input.parcel.weightGrams / 1000).toFixed(3),
          order_number: input.orderNumber,
          request_label: true,
          quantity: 1,
          shipment: { id: Number(rate.code) },
        },
      };
      const res = await call("/parcels", { method: "POST", body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`Sendcloud buy HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const parcel = ((await res.json()) as { parcel?: ScParcel }).parcel;
      if (!parcel) throw new Error("Sendcloud buy: no parcel in response");

      // download the A6 label PDF (authenticated) → base64
      const labelUrl = parcel.label?.label_printer ?? parcel.label?.normal_printer?.[0];
      let labelBase64 = "";
      if (labelUrl) {
        const lab = await fetch(labelUrl, { headers: { Authorization: auth }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (lab.ok) labelBase64 = Buffer.from(await lab.arrayBuffer()).toString("base64");
      }
      return {
        trackingNumber: parcel.tracking_number ?? String(parcel.id),
        trackingUrl: parcel.tracking_url ?? "",
        carrier: rate.carrier,
        service: rate.service,
        costCents: rate.costCents,
        currency: rate.currency,
        labelFormat: "PDF_A6",
        labelBase64,
        carrierRef: String(parcel.id),
      };
    },

    async cancelShipment(carrierRef): Promise<void> {
      await call(`/parcels/${carrierRef}/cancel`, { method: "POST" }).catch(() => undefined);
    },

    async pollTracking(trackingNumbers): Promise<TrackingUpdate[]> {
      const out: TrackingUpdate[] = [];
      for (const tn of trackingNumbers) {
        try {
          const res = await call(`/tracking/${encodeURIComponent(tn)}`);
          if (!res.ok) continue;
          const body = (await res.json()) as { statuses?: ScStatus[] };
          const last = (body.statuses ?? []).at(-1);
          if (last) out.push({ trackingNumber: tn, status: last.carrier_message ?? last.parent_status ?? "", message: last.carrier_message, occurredAt: last.timestamp ?? new Date().toISOString(), raw: last });
        } catch {
          // a single number's failure never sinks the batch
        }
      }
      return out;
    },
  };
}

const toNum = (v: unknown, dflt: number): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : dflt;
};

type ScMethod = { id: number; name?: string; carrier?: string; min_weight?: string | number; max_weight?: string | number; countries?: { iso_2: string; price?: string | number }[] };
type ScParcel = { id: number; tracking_number?: string; tracking_url?: string; label?: { label_printer?: string; normal_printer?: string[] } };
type ScStatus = { carrier_message?: string; parent_status?: string; timestamp?: string };
