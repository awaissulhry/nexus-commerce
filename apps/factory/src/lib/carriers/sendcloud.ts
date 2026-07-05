/**
 * F1 — Sendcloud connector (FD6: confirmed first adapter; the Owner's account
 * exists at Xavia). Basic auth (public/secret key). The probe answers the one
 * open FD6 question EMPIRICALLY: does THIS plan tier expose label purchase
 * and tracking polls? (Lite €28/mo has "API access"; the "Tracking API" row
 * starts at Growth — boundary unverified in docs, so we test, not guess.)
 */
import type { CarrierConnector, ProbeResult } from "./types";

const BASE = "https://panel.sendcloud.sc/api/v2";
const TIMEOUT_MS = 12_000;

async function call(path: string, publicKey: string, secretKey: string): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    headers: {
      Authorization: "Basic " + Buffer.from(`${publicKey}:${secretKey}`).toString("base64"),
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

export const sendcloudConnector: CarrierConnector = {
  id: "sendcloud",
  name: "Sendcloud",

  async validateAndProbe(credentials): Promise<ProbeResult> {
    const { publicKey, secretKey } = credentials;
    const checks: ProbeResult["checks"] = [];
    let accountLabel: string | undefined;

    // 1. auth — GET /user
    let authOk = false;
    try {
      const res = await call("/user", publicKey, secretKey);
      authOk = res.ok;
      if (res.ok) {
        const body = (await res.json()) as { user?: { username?: string; company_name?: string } };
        accountLabel = body.user?.company_name || body.user?.username;
        checks.push({ name: "Authentication", ok: true, detail: `Connected as ${accountLabel ?? "account"}` });
      } else {
        checks.push({ name: "Authentication", ok: false, detail: `HTTP ${res.status} — check the public/secret key pair` });
      }
    } catch (err) {
      checks.push({ name: "Authentication", ok: false, detail: (err as Error).message.slice(0, 120) });
    }

    // 2. label capability — GET /shipping_methods
    let labelOk = false;
    if (authOk) {
      try {
        const res = await call("/shipping_methods", publicKey, secretKey);
        labelOk = res.ok;
        if (res.ok) {
          const body = (await res.json()) as { shipping_methods?: unknown[] };
          checks.push({
            name: "Label purchase (shipping methods)",
            ok: true,
            detail: `${body.shipping_methods?.length ?? 0} shipping methods available`,
          });
        } else {
          checks.push({ name: "Label purchase (shipping methods)", ok: false, detail: `HTTP ${res.status} — plan may not include API label access` });
        }
      } catch (err) {
        checks.push({ name: "Label purchase (shipping methods)", ok: false, detail: (err as Error).message.slice(0, 120) });
      }
    }

    // 3. tracking-poll capability — GET /tracking/<dummy>; 404-with-auth = accessible, 401/403 = plan-gated
    let trackingOk = false;
    if (authOk) {
      try {
        const res = await call("/tracking/FACTORYPROBE000", publicKey, secretKey);
        trackingOk = res.status === 404 || res.ok;
        checks.push({
          name: "Tracking poll (FD6 open question)",
          ok: trackingOk,
          detail: trackingOk
            ? "Tracking endpoint answers on this plan — local-first polling confirmed"
            : `HTTP ${res.status} — tracking may require the Growth tier (€87/mo)`,
        });
      } catch (err) {
        checks.push({ name: "Tracking poll (FD6 open question)", ok: false, detail: (err as Error).message.slice(0, 120) });
      }
    }

    return {
      ok: authOk && labelOk,
      accountLabel,
      checks,
      caps: {
        supportsPickup: true, // carrier-dependent (BRT ≥5 parcels; FP8 handles per-carrier rules)
        supportsPollingTracking: trackingOk,
        supportsWebhookTracking: true, // exists upstream; unused without a public endpoint
        supportsServicePoints: true,
        supportsOwnContract: true,
        supportsMulticollo: true,
        labelFormats: ["PDF_A4", "PDF_A6", "ZPL"],
      },
    };
  },
};

export const CONNECTORS: Record<string, CarrierConnector> = {
  sendcloud: sendcloudConnector,
};
