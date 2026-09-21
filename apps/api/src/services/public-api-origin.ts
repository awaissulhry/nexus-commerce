/**
 * The one answer to *"what public HTTPS origin does the outside world reach this API on?"*
 *
 * ## Why this exists — 2026-09-21, measured in production
 *
 * `NEXUS_PUBLIC_API_URL` held `https://nexus-commerce-api-production.up.railway.app`, a Railway
 * host that **resolves but has no service behind it** (`HTTP 404`, against `HTTP 200` on the live
 * host). Every OAuth callback was built from it, so Shopify and Etsy both refused the sign-in with
 * *"redirect_uri is not whitelisted"* / *"The requested redirect URL is not permitted"*.
 *
 * The refusals were **luck**. Had either channel accepted the URL, the operator would have granted
 * consent and landed on a 404 — nothing connected, no error anywhere in Nexus, and the failure
 * arriving at the channel rather than here. Shopify's webhook registration reads the same value,
 * so its subscriptions would have pointed at the dead host and orders would simply never have
 * arrived.
 *
 * ## The drift this removes
 *
 * Three call sites read the same fact three different ways:
 *
 * | reader | sources | when unset |
 * |---|---|---|
 * | `cx/oauth.service.ts` | `NEXUS_PUBLIC_API_URL`, `PUBLIC_API_URL` | **empty string** — produced a host-less `redirect_uri` and said nothing |
 * | `shopify/webhook-registration.service.ts` | those two **plus `RAILWAY_PUBLIC_DOMAIN`** | a named error |
 * | `shopify/schema-sync.service.ts` | the same three | a named reason |
 *
 * Two names for one fact is the shape of every drift defect in this programme, and here the
 * weakest reader was the one on the sign-in path. `RAILWAY_PUBLIC_DOMAIN` is kept as the last
 * fallback because Railway sets it to the host actually serving the deployment — on an unset
 * variable that is self-healing, which is strictly better than an empty string.
 *
 * ## What this deliberately does NOT do
 *
 * It does not check that the host **answers**. A boot-time network probe would have caught the
 * 2026-09-21 outage, and it is a different thing from reading configuration — a probe belongs in
 * the channel-alerts sweep, where a failure is a notice rather than a refusal to start.
 */

/**
 * ⚠️ 2026-09-22 — this module was first written to share the VALIDATION as well as the sources,
 * and that was wrong. Collapsing everything into one strict `.origin` broke four existing tests,
 * and each of them was protecting something real:
 *
 *   - `https://example.test/#fragment` must be **REFUSED**, not silently cleaned. `.origin`
 *     discarded the fragment and turned a misconfiguration into a quiet pass.
 *   - `http://localhost:8091` is Shopify's explicit, opt-in local-development callback, guarded
 *     downstream to one exact route. A blanket HTTPS rule killed it.
 *
 * The drift worth removing is **which variables are read and what counts as unset**. The
 * validation is genuinely different per caller: a channel webhook endpoint must be public HTTPS,
 * while the sign-in path has its own narrower guard that has to see the raw value to refuse it.
 * So the sources are shared and the policies are not.
 */

/**
 * The configured public API address, exactly as set — the first NON-BLANK of the three sources.
 *
 * A scheme is added only when one is missing, because `RAILWAY_PUBLIC_DOMAIN` carries a bare
 * host. Nothing else is normalised: a path, a fragment or a plain-HTTP scheme is handed back
 * intact so the caller's own guard can judge it.
 */
export function publicApiBaseValue(): string | null {
  /**
   * 🔴 The first non-blank source, not the first defined one.
   *
   * All three readers used `??`, which falls through on `undefined` but **not** on an empty
   * string. A variable cleared in the Railway dashboard — an ordinary thing to do — is `''`, and
   * `'' ?? next` is `''`: the chain short-circuits on the blank and the fallbacks are never
   * reached. The caller then gets a host-less callback and no explanation, which is the exact
   * silence this file exists to end. Caught by this module's own test.
   */
  const raw = [process.env.NEXUS_PUBLIC_API_URL, process.env.PUBLIC_API_URL, process.env.RAILWAY_PUBLIC_DOMAIN]
    .map((value) => (value ?? '').trim())
    .find((value) => value.length > 0)
  if (!raw) return null
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
}

/** Scheme + host + port. A path is dropped, so this is only for callers that want an ORIGIN. */
export type PublicApiOrigin = { origin: string } | { error: string }

/**
 * The strict public HTTPS origin a CHANNEL must be able to reach — webhook endpoints.
 *
 * Not for the sign-in path: that one keeps its own guard, which must see a fragment or a
 * localhost scheme in order to refuse or allow it deliberately.
 */
export function publicApiOrigin(): PublicApiOrigin {
  const raw = publicApiBaseValue()
  if (!raw) {
    return { error: 'No public API address is configured. Set NEXUS_PUBLIC_API_URL on the API service.' }
  }
  let base: URL
  try {
    base = new URL(raw)
  } catch {
    return { error: `NEXUS_PUBLIC_API_URL is not a usable address: ${raw.slice(0, 120)}` }
  }
  if (base.protocol !== 'https:') {
    return { error: 'The public API address must be HTTPS; every channel refuses a plain-HTTP callback.' }
  }
  if (base.username || base.password) {
    return { error: 'The public API address must not carry credentials.' }
  }
  return { origin: base.origin }
}
