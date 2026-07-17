/**
 * EPQ.5 — minimal Stripe client (D-1, env-gated). No SDK: two raw HTTPS calls
 * (Checkout Session create + webhook signature verify) keep the dependency
 * surface at zero and the feature FULLY DARK without STRIPE_SECRET_KEY +
 * STRIPE_WEBHOOK_SECRET (empty strings count as unset — the env template
 * ships `KEY=`). Signature verification is the anti-forgery boundary for the
 * webhook (it carries no cookies, so the CSRF double-submit cannot apply);
 * scheme per Stripe docs: header `t=<unix>,v1=<hmac>`, signed payload
 * `${t}.${rawBody}`, HMAC-SHA256 with the webhook secret, ±5 min tolerance.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

// `||` not `??`: empty-string env values must count as unset (PLAYBOOK trap 5)
export const stripeSecretKey = (): string | null => process.env.STRIPE_SECRET_KEY || null;
export const stripeWebhookSecret = (): string | null => process.env.STRIPE_WEBHOOK_SECRET || null;
export const stripeEnabled = (): boolean => Boolean(stripeSecretKey() && stripeWebhookSecret());

/** PURE — parse `Stripe-Signature: t=...,v1=...,v1=...`. */
export function parseStripeSignature(header: string | null): { t: number; v1: string[] } | null {
  if (!header) return null;
  let t = 0;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2).map((s) => s?.trim());
    if (k === "t" && v && /^\d+$/.test(v)) t = Number(v);
    if (k === "v1" && v) v1.push(v);
  }
  return t > 0 && v1.length > 0 ? { t, v1 } : null;
}

/** PURE (clock injected) — constant-time HMAC check + replay tolerance. */
export function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
  toleranceSec = 300,
): boolean {
  const sig = parseStripeSignature(header);
  if (!sig) return false;
  if (Math.abs(nowSec - sig.t) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${sig.t}.${rawBody}`).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  return sig.v1.some((candidate) => {
    const buf = Buffer.from(candidate, "utf8");
    return buf.length === expectedBuf.length && timingSafeEqual(buf, expectedBuf);
  });
}

export type CheckoutSession = { id: string; url: string };

/**
 * Create a Checkout Session for the quote's deposit (EUR, single line).
 * Throws with Stripe's error message on refusal — callers surface it.
 */
export async function createDepositCheckoutSession(p: {
  amountCents: number;
  label: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
}): Promise<CheckoutSession> {
  const key = stripeSecretKey();
  if (!key) throw new Error("Stripe is not configured");
  const form = new URLSearchParams({
    mode: "payment",
    success_url: p.successUrl,
    cancel_url: p.cancelUrl,
    "line_items[0][price_data][currency]": "eur",
    "line_items[0][price_data][product_data][name]": p.label,
    "line_items[0][price_data][unit_amount]": String(p.amountCents),
    "line_items[0][quantity]": "1",
  });
  for (const [k, v] of Object.entries(p.metadata)) form.set(`metadata[${k}]`, v);
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as { id?: string; url?: string; error?: { message?: string } };
  if (!res.ok || !data.id || !data.url) {
    throw new Error(data.error?.message || "Stripe refused the checkout session");
  }
  return { id: data.id, url: data.url };
}
