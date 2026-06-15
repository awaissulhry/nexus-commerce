/**
 * DD.4 — eBay publish adapter (Inventory API).
 *
 * Three-step flow per eBay's modern selling stack:
 *   1. PUT  /sell/inventory/v1/inventory_item/{sku}
 *   2. POST /sell/inventory/v1/offer
 *   3. POST /sell/inventory/v1/offer/{offerId}/publish
 *
 * NOT END-TO-END TESTED — wiring is real but exercising it requires
 * eBay developer credentials + a sandbox/production seller account
 * with policies (payment, return, fulfillment) attached. See
 * TECH_DEBT #35 for the gating items.
 *
 * The adapter never throws; it returns either a success result with
 * the offerId and listingId or a failure result with the eBay error
 * message. The caller (channel-publish.service.ts) maps that into a
 * SubmissionEntry.
 */

import prisma from '../../db.js'
import { ebayAuthService } from '../ebay-auth.service.js'
import { ebayAccountService } from '../ebay-account.service.js'
import { EbayCategoryService } from '../ebay-category.service.js'
import { logger } from '../../utils/logger.js'
import {
  acquireEbayPublishToken,
  checkEbayCircuit,
  getEbayApiBaseForMode,
  getEbayPublishMode,
  recordEbayOutcome,
} from '../ebay-publish-gate.service.js'
import {
  digestPayload,
  writeAttemptLog,
} from '../channel-publish-audit.service.js'
import { buildSafetyStatements } from '../compliance-resolver.service.js'

const ebayCategoryService = new EbayCategoryService()

// C.1 — symmetric retry/backoff for eBay Inventory API. Same policy as
// the Amazon SP-API client: 3 retries (1s/2s/4s) on 429 + 5xx +
// network errors; non-retryable on 4xx (other than 429) so caller
// errors fail fast.
const EBAY_RETRY_DELAYS_MS = [1000, 2000, 4000] as const
const EBAY_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])

async function ebayFetchWithRetry(
  url: string,
  init: RequestInit,
  label: string,
): Promise<Response> {
  let lastErr: unknown = null
  const maxAttempts = EBAY_RETRY_DELAYS_MS.length + 1
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetch(url, init)
      if (!EBAY_RETRY_DELAYS_MS[attempt]) return response
      if (!EBAY_RETRYABLE_STATUSES.has(response.status)) return response
      try {
        await response.text()
      } catch {
        // ignore body-read failures on a discarded response
      }
      const delay = EBAY_RETRY_DELAYS_MS[attempt]!
      logger.warn('eBay retryable status — backing off', {
        label,
        attempt: attempt + 1,
        status: response.status,
        delayMs: delay,
      })
      await new Promise((r) => setTimeout(r, delay))
    } catch (err) {
      lastErr = err
      if (!EBAY_RETRY_DELAYS_MS[attempt]) throw err
      const delay = EBAY_RETRY_DELAYS_MS[attempt]!
      logger.warn('eBay network error — backing off', {
        label,
        attempt: attempt + 1,
        error: err instanceof Error ? err.message : String(err),
        delayMs: delay,
      })
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error('eBay fetchWithRetry exhausted')
}

export interface EbayPublishResult {
  ok: boolean
  /** eBay InventoryItem.sku — the same one we sent. */
  sku?: string
  /** Created offer id. */
  offerId?: string
  /** eBay item/listing id once the offer is published. */
  listingId?: string
  /** Public marketplace URL. */
  listingUrl?: string
  /** Human-readable error when ok=false. */
  error?: string
  /** Which step failed (createInventory|createOffer|publishOffer). */
  failedStep?: string
  /** B1 — non-fatal: fitment couldn't be set (e.g. category without
   *  compatibility support). The listing still published. */
  compatibilityWarning?: string
  /** C2 — non-fatal: the GPSR/regulatory container was rejected, so the offer
   *  was created without it. The listing still published. */
  regulatoryWarning?: string
}

interface EbayPayload {
  sku?: string
  marketplaceId?: string
  categoryId?: string
  product?: {
    title?: string
    description?: string
    aspects?: Record<string, string[]>
    imageUrls?: string[]
  }
  availability?: {
    shipToLocationAvailability?: { quantity?: number }
  }
  condition?: string
  price?: { value: number; currency: string }
  /** EC.11 — listing-level policy overrides. Preferred over
   *  connection.connectionMetadata.ebayPolicies when supplied. The
   *  cockpit picks these per-(productId, marketplace) in EC.8's
   *  PricingPoliciesCard and writes them to platformAttributes; the
   *  cockpit publish endpoint copies them into the payload so each
   *  listing can override the seller-wide defaults. */
  policies?: {
    fulfillmentPolicyId?: string
    paymentPolicyId?: string
    returnPolicyId?: string
    merchantLocationKey?: string
  }
  /** B1 — eBay Motors fitment (captured in the cockpit, persisted to
   *  ChannelListing.platformAttributes.compatibility). Sent via the
   *  Inventory API product_compatibility resource at publish. */
  compatibility?: {
    universal?: boolean
    fitments?: Array<{
      year?: string | number
      make?: string
      model?: string
      submodel?: string | null
    }>
  }
  /** C2 — EU GPSR data (from the canonical compliance resolver). Emitted as the
   *  Inventory API offer `regulatory` container at publish. */
  compliance?: {
    manufacturer?: string | null
    responsiblePerson?: {
      name?: string | null
      addressLines?: string[]
      email?: string | null
      phone?: string | null
    } | null
    // C4.2 — structured CE/PPE → productSafety statements.
    garmentClass?: string | null
    impactProtectors?: Array<{ zone?: string | null; standard?: string | null; level?: string | null }>
  }
}

/**
 * C2 — map canonical EU compliance to eBay's Inventory API offer `regulatory`
 * container: an EU responsible person + the manufacturer (the GPSR core). The
 * free-form address lines fold into addressLine1/2; country defaults to the
 * seller's establishment (Xavia → IT). Returns null when there's nothing usable
 * so the caller omits `regulatory`. Pure + unit-tested. (productSafety pictograms
 * = C4; DoC documents[] = a later doc-upload phase.)
 */
export function buildEbayRegulatory(
  compliance: EbayPayload['compliance'],
  country: string = 'IT',
): Record<string, unknown> | null {
  if (!compliance) return null
  const regulatory: Record<string, unknown> = {}

  const rp = compliance.responsiblePerson
  if (rp?.name) {
    const lines = (rp.addressLines ?? []).filter(Boolean).map(String)
    const person: Record<string, unknown> = { companyName: rp.name, country, types: ['EU_RESPONSIBLE_PERSON'] }
    if (lines[0]) person.addressLine1 = lines[0]
    if (lines.length > 1) person.addressLine2 = lines.slice(1).join(', ')
    if (rp.email) person.email = rp.email
    if (rp.phone) person.phone = rp.phone
    regulatory.responsiblePersons = [person]
  }

  if (compliance.manufacturer) {
    regulatory.manufacturer = { companyName: compliance.manufacturer, country }
  }

  // C4.2 — productSafety statements from the structured CE/PPE data (garment
  // class + EN 1621 protectors). Pictograms need eBay code IDs → deferred.
  const statements = buildSafetyStatements({ garmentClass: compliance.garmentClass, impactProtectors: compliance.impactProtectors })
  if (statements.length > 0) regulatory.productSafety = { statements }

  return Object.keys(regulatory).length > 0 ? regulatory : null
}

/**
 * B1 — map captured eBay Motors fitment to the Inventory API
 * product_compatibility body. Returns null when there's nothing to send
 * (universal fit, or no fitment with at least a make+model) so the caller
 * skips the PUT. Pure + unit-tested.
 */
export function buildEbayCompatibilityBody(
  compatibility: EbayPayload['compatibility'],
): { compatibleProducts: Array<{ compatibilityProperties: Array<{ name: string; value: string }> }> } | null {
  if (!compatibility || compatibility.universal) return null
  const fitments = Array.isArray(compatibility.fitments) ? compatibility.fitments : []
  const compatibleProducts = fitments
    .map((f) => {
      const props: Array<{ name: string; value: string }> = []
      const year = String(f?.year ?? '').trim()
      const make = String(f?.make ?? '').trim()
      const model = String(f?.model ?? '').trim()
      const submodel = f?.submodel ? String(f.submodel).trim() : ''
      // eBay motorsports compatibility property names. Order is not significant
      // (name/value pairs) but we keep a stable Year→Make→Model→Submodel order.
      if (year) props.push({ name: 'Year', value: year })
      if (make) props.push({ name: 'Make', value: make })
      if (model) props.push({ name: 'Model', value: model })
      if (submodel) props.push({ name: 'Submodel', value: submodel })
      return props
    })
    // A meaningful fitment needs at least a make + model; drop anything blanker.
    .filter((props) => props.some((p) => p.name === 'Make') && props.some((p) => p.name === 'Model'))
    .map((compatibilityProperties) => ({ compatibilityProperties }))
  return compatibleProducts.length > 0 ? { compatibleProducts } : null
}

export class EbayPublishAdapter {
  async publish(payload: EbayPayload): Promise<EbayPublishResult> {
    if (!payload.sku) {
      return { ok: false, error: 'sku is required for eBay publish.' }
    }
    if (!payload.marketplaceId) {
      return { ok: false, error: 'marketplaceId is required (e.g. EBAY_IT).' }
    }
    if (!payload.categoryId) {
      return { ok: false, error: 'categoryId is required for eBay publish.' }
    }

    // C.7 — feature-flag gate. Runs FIRST, before any DB read or
    // network call, so a gated outcome is genuinely free of side
    // effects. We don't yet know the connectionId here (we look it
    // up below) so the audit row uses the marketplaceId itself as
    // the seller key — good enough since gated rows can't be tied
    // to a specific connection anyway, and the dashboard groups by
    // (channel, marketplace) for this case.
    const mode = getEbayPublishMode()
    const digest = digestPayload({
      sku: payload.sku,
      marketplaceId: payload.marketplaceId,
      categoryId: payload.categoryId,
      product: payload.product,
      condition: payload.condition,
      price: payload.price,
      availability: payload.availability,
    })
    if (mode === 'gated') {
      writeAttemptLog({
        channel: 'EBAY',
        marketplace: payload.marketplaceId,
        sellerId: payload.marketplaceId, // pre-connection-lookup placeholder
        sku: payload.sku,
        mode: 'gated',
        outcome: 'gated',
        payloadDigest: digest,
        errorMessage:
          'NEXUS_ENABLE_EBAY_PUBLISH=false — set true to enable eBay publishes.',
      })
      return {
        ok: false,
        sku: payload.sku,
        error:
          'eBay publish disabled by feature flag (NEXUS_ENABLE_EBAY_PUBLISH=false).',
      }
    }

    // Pick the first active eBay connection. Multi-account support
    // keys off marketplaceId once that lands.
    const connection = await prisma.channelConnection.findFirst({
      where: { channelType: 'EBAY', isActive: true },
      orderBy: { updatedAt: 'desc' },
    })
    if (!connection) {
      return {
        ok: false,
        error:
          'No active eBay connection — link an eBay account in Settings first.',
      }
    }

    // C.7 — circuit breaker check. Per (connectionId, marketplaceId)
    // so a broken sandbox account doesn't trip the prod connection.
    const circuit = checkEbayCircuit(connection.id, payload.marketplaceId)
    if (!circuit.ok) {
      writeAttemptLog({
        channel: 'EBAY',
        marketplace: payload.marketplaceId,
        sellerId: connection.id,
        sku: payload.sku,
        mode,
        outcome: 'circuit-open',
        payloadDigest: digest,
        errorMessage: circuit.error,
      })
      return { ok: false, sku: payload.sku, error: circuit.error }
    }

    // C.7 — rate limiter. One token per publish attempt; the 3
    // internal HTTP calls share the token because they're sequential
    // and tied to a single operator action.
    const tokenStart = Date.now()
    const acquired = await acquireEbayPublishToken(
      connection.id,
      payload.marketplaceId,
    )
    if (!acquired.ok) {
      writeAttemptLog({
        channel: 'EBAY',
        marketplace: payload.marketplaceId,
        sellerId: connection.id,
        sku: payload.sku,
        mode,
        outcome: 'rate-limited',
        payloadDigest: digest,
        errorMessage: acquired.error,
      })
      return { ok: false, sku: payload.sku, error: acquired.error }
    }

    // C.7 — dry-run short-circuit. Mirrors Amazon's: log the would-be
    // payload, write an audit row, return synthetic success so the
    // wizard's downstream bookkeeping (status transitions,
    // listing.created emit) runs naturally without external side
    // effect. We skip the DB token fetch too because that has its own
    // side effect (lastUsedAt update).
    if (mode === 'dry-run') {
      const fakeOfferId = `dry-run-offer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const fakeListingId = `dry-run-listing-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      logger.info('eBay publish (dry-run, no HTTP)', {
        sku: payload.sku,
        marketplaceId: payload.marketplaceId,
        categoryId: payload.categoryId,
        connectionId: connection.id,
        title: payload.product?.title,
      })
      recordEbayOutcome(connection.id, payload.marketplaceId, true)
      writeAttemptLog({
        channel: 'EBAY',
        marketplace: payload.marketplaceId,
        sellerId: connection.id,
        sku: payload.sku,
        mode: 'dry-run',
        outcome: 'success',
        payloadDigest: digest,
        submissionId: fakeOfferId,
        durationMs: Date.now() - tokenStart,
      })
      return {
        ok: true,
        sku: payload.sku,
        offerId: fakeOfferId,
        listingId: fakeListingId,
      }
    }

    let token: string
    try {
      token = await ebayAuthService.getValidToken(connection.id)
    } catch (err) {
      const message = `Could not obtain eBay token: ${
        err instanceof Error ? err.message : String(err)
      }`
      recordEbayOutcome(connection.id, payload.marketplaceId, false)
      writeAttemptLog({
        channel: 'EBAY',
        marketplace: payload.marketplaceId,
        sellerId: connection.id,
        sku: payload.sku,
        mode,
        outcome: 'failed',
        payloadDigest: digest,
        errorMessage: message,
        durationMs: Date.now() - tokenStart,
      })
      return { ok: false, error: message }
    }

    // C.7 — sandbox URL swap. The mode resolver returns the right
    // base for the active mode; live falls through to EBAY_API_BASE
    // env or the production default.
    const apiBase = getEbayApiBaseForMode(mode)

    // C.7 — single source of truth for the audit log + circuit
    // outcome at every exit of the 3-step HTTP flow below. The 8
    // existing returns become `return finalize(<existing shape>)`
    // so the publish-once-write-once-record-once invariant holds
    // without inline duplication at every branch.
    const httpStart = Date.now()
    const finalize = (result: EbayPublishResult): EbayPublishResult => {
      recordEbayOutcome(connection.id, payload.marketplaceId, result.ok)
      writeAttemptLog({
        channel: 'EBAY',
        marketplace: payload.marketplaceId,
        sellerId: connection.id,
        sku: payload.sku,
        mode,
        outcome: result.ok ? 'success' : 'failed',
        payloadDigest: digest,
        errorMessage: result.error ?? null,
        errorCode: result.failedStep ?? null,
        submissionId: result.offerId ?? result.listingId ?? null,
        durationMs: Date.now() - httpStart,
      })
      return result
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Language': contentLanguageFor(payload.marketplaceId),
      Accept: 'application/json',
    }

    // ── Step 1: createOrReplaceInventoryItem ─────────────────────
    const inventoryBody = {
      product: {
        title: payload.product?.title ?? '',
        description: payload.product?.description ?? '',
        aspects: payload.product?.aspects ?? {},
        imageUrls: payload.product?.imageUrls ?? [],
      },
      condition: payload.condition ?? 'NEW',
      availability: payload.availability ?? {
        shipToLocationAvailability: { quantity: 1 },
      },
    }
    const invRes = await ebayFetchWithRetry(
      `${apiBase}/sell/inventory/v1/inventory_item/${encodeURIComponent(
        payload.sku,
      )}`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify(inventoryBody),
      },
      `createOrReplaceInventoryItem(${payload.sku})`,
    )
    if (!invRes.ok && invRes.status !== 204) {
      const body = await invRes.text().catch(() => '')
      return finalize({
        ok: false,
        sku: payload.sku,
        failedStep: 'createInventory',
        error: `createOrReplaceInventoryItem ${invRes.status}: ${body.slice(
          0,
          500,
        )}`,
      })
    }

    // ── Step 1b (B1): product compatibility (eBay Motors fitment) ─
    // Fitment is captured in the cockpit + persisted, but was DROPPED at
    // publish. Send it now via the Inventory API product_compatibility
    // resource, keyed by the SKU we just created (so the published listing
    // carries fitment from the start). Soft-fail: a category that doesn't
    // support compatibility (most apparel) must not block the listing.
    let compatibilityWarning: string | undefined
    const compatBody = buildEbayCompatibilityBody(payload.compatibility)
    if (compatBody) {
      try {
        const compatRes = await ebayFetchWithRetry(
          `${apiBase}/sell/inventory/v1/inventory_item/${encodeURIComponent(
            payload.sku,
          )}/product_compatibility`,
          { method: 'PUT', headers, body: JSON.stringify(compatBody) },
          `createOrReplaceProductCompatibility(${payload.sku})`,
        )
        if (!compatRes.ok && compatRes.status !== 204) {
          const body = await compatRes.text().catch(() => '')
          compatibilityWarning = `compatibility not set (${compatRes.status}): ${body.slice(0, 300)}`
          logger.warn('eBay product_compatibility rejected — publishing without fitment', {
            sku: payload.sku,
            status: compatRes.status,
          })
        }
      } catch (err) {
        compatibilityWarning = `compatibility not set: ${err instanceof Error ? err.message : String(err)}`
        logger.warn('eBay product_compatibility call failed — publishing without fitment', {
          sku: payload.sku,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // ── Step 2: createOffer ──────────────────────────────────────
    // Fulfillment / payment / return policies are required for a
    // publishable offer. Read pre-configured ids from
    // ChannelConnection.connectionMetadata.ebayPolicies first
    // (deterministic — what the user explicitly chose). When any
    // are missing, GG.2 falls back to the seller's first-active
    // policy of each kind from the live Account API so the wizard
    // doesn't hard-fail on a fresh account.
    const meta = (connection.connectionMetadata ?? {}) as Record<
      string,
      unknown
    >
    const configured = ((meta.ebayPolicies ?? {}) as {
      fulfillmentPolicyId?: string
      paymentPolicyId?: string
      returnPolicyId?: string
      merchantLocationKey?: string
    })
    // EC.11 — payload.policies (listing-level) takes precedence over
    // connection-level configured policies. Each field falls back
    // independently so a partial override is safe.
    const override = payload.policies ?? {}
    const policies = {
      fulfillmentPolicyId: override.fulfillmentPolicyId ?? configured.fulfillmentPolicyId,
      paymentPolicyId: override.paymentPolicyId ?? configured.paymentPolicyId,
      returnPolicyId: override.returnPolicyId ?? configured.returnPolicyId,
      merchantLocationKey: override.merchantLocationKey ?? configured.merchantLocationKey,
    }
    if (
      !policies.fulfillmentPolicyId ||
      !policies.paymentPolicyId ||
      !policies.returnPolicyId ||
      !policies.merchantLocationKey
    ) {
      try {
        const snapshot = await ebayAccountService.getSnapshot(
          connection.id,
          payload.marketplaceId,
        )
        if (!policies.fulfillmentPolicyId) {
          policies.fulfillmentPolicyId =
            snapshot.fulfillmentPolicies[0]?.id
        }
        if (!policies.paymentPolicyId) {
          policies.paymentPolicyId = snapshot.paymentPolicies[0]?.id
        }
        if (!policies.returnPolicyId) {
          policies.returnPolicyId = snapshot.returnPolicies[0]?.id
        }
        if (!policies.merchantLocationKey) {
          policies.merchantLocationKey = snapshot.locations[0]?.key
        }
      } catch (err) {
        return finalize({
          ok: false,
          sku: payload.sku,
          failedStep: 'createOffer',
          error: `Could not fetch seller policies via Account API: ${
            err instanceof Error ? err.message : String(err)
          }`,
        })
      }
    }
    if (
      !policies.fulfillmentPolicyId ||
      !policies.paymentPolicyId ||
      !policies.returnPolicyId ||
      !policies.merchantLocationKey
    ) {
      const missing: string[] = []
      if (!policies.fulfillmentPolicyId) missing.push('fulfillment')
      if (!policies.paymentPolicyId) missing.push('payment')
      if (!policies.returnPolicyId) missing.push('return')
      if (!policies.merchantLocationKey) missing.push('merchantLocation')
      return finalize({
        ok: false,
        sku: payload.sku,
        failedStep: 'createOffer',
        error: `Seller has no ${missing.join(' / ')} policy/location for ${payload.marketplaceId}. Create one in eBay Seller Hub or set ChannelConnection.connectionMetadata.ebayPolicies.`,
      })
    }

    // GG.1 — validate the picked condition against eBay's live policy
    // for this category. Submitting a condition the category rejects
    // is a hard publish error; better to surface it before the round
    // trip.
    const requestedCondition = payload.condition ?? 'NEW'
    try {
      const allowedConditions =
        await ebayCategoryService.getItemConditionPolicies(
          payload.categoryId,
          payload.marketplaceId,
        )
      if (allowedConditions.length > 0) {
        const ok = allowedConditions.some(
          (c) =>
            c.conditionDescription.toUpperCase().replace(/\s+/g, '_') ===
              requestedCondition.toUpperCase() ||
            c.conditionId === requestedCondition,
        )
        if (!ok) {
          const labels = allowedConditions
            .map((c) => c.conditionDescription)
            .join(', ')
          return finalize({
            ok: false,
            sku: payload.sku,
            failedStep: 'createInventory',
            error: `Condition "${requestedCondition}" not allowed for category ${payload.categoryId} on ${payload.marketplaceId}. Allowed: ${labels}.`,
          })
        }
      }
    } catch {
      // Soft-fail: condition lookup is advisory. Let eBay return the
      // canonical error if it disagrees.
    }

    const offerBody: Record<string, unknown> = {
      sku: payload.sku,
      marketplaceId: payload.marketplaceId,
      format: 'FIXED_PRICE',
      categoryId: payload.categoryId,
      listingPolicies: {
        fulfillmentPolicyId: policies.fulfillmentPolicyId,
        paymentPolicyId: policies.paymentPolicyId,
        returnPolicyId: policies.returnPolicyId,
      },
      merchantLocationKey: policies.merchantLocationKey,
      availableQuantity:
        payload.availability?.shipToLocationAvailability?.quantity ?? 1,
    }
    if (payload.price) {
      offerBody.pricingSummary = {
        price: {
          value: String(payload.price.value),
          currency: payload.price.currency,
        },
      }
    }

    // C2 — GPSR/regulatory (EU responsible person + manufacturer) on the offer.
    // If it's present but the offer is rejected, retry once WITHOUT it so a
    // compliance-data problem never blocks the listing (surfaced as a warning).
    let regulatoryWarning: string | undefined
    const regulatory = buildEbayRegulatory(payload.compliance)
    if (regulatory) offerBody.regulatory = regulatory

    let offerRes = await ebayFetchWithRetry(
      `${apiBase}/sell/inventory/v1/offer`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(offerBody),
      },
      `createOffer(${payload.sku})`,
    )
    if (!offerRes.ok && regulatory) {
      const body = await offerRes.text().catch(() => '')
      regulatoryWarning = `GPSR/regulatory not sent (createOffer ${offerRes.status}): ${body.slice(0, 300)}`
      logger.warn('eBay createOffer rejected with regulatory — retrying without it', {
        sku: payload.sku,
        status: offerRes.status,
      })
      delete offerBody.regulatory
      offerRes = await ebayFetchWithRetry(
        `${apiBase}/sell/inventory/v1/offer`,
        { method: 'POST', headers, body: JSON.stringify(offerBody) },
        `createOffer(${payload.sku}) [no-regulatory retry]`,
      )
    }
    if (!offerRes.ok) {
      const body = await offerRes.text().catch(() => '')
      return finalize({
        ok: false,
        sku: payload.sku,
        failedStep: 'createOffer',
        error: `createOffer ${offerRes.status}: ${body.slice(0, 500)}`,
      })
    }
    const offerJson = (await offerRes.json().catch(() => null)) as {
      offerId?: string
    } | null
    const offerId = offerJson?.offerId
    if (!offerId) {
      return finalize({
        ok: false,
        sku: payload.sku,
        failedStep: 'createOffer',
        error: 'createOffer succeeded but returned no offerId.',
      })
    }

    // ── Step 3: publishOffer ─────────────────────────────────────
    const pubRes = await ebayFetchWithRetry(
      `${apiBase}/sell/inventory/v1/offer/${encodeURIComponent(
        offerId,
      )}/publish`,
      {
        method: 'POST',
        headers,
      },
      `publishOffer(${offerId})`,
    )
    if (!pubRes.ok) {
      const body = await pubRes.text().catch(() => '')
      return finalize({
        ok: false,
        sku: payload.sku,
        offerId,
        failedStep: 'publishOffer',
        error: `publishOffer ${pubRes.status}: ${body.slice(0, 500)}`,
      })
    }
    const pubJson = (await pubRes.json().catch(() => null)) as {
      listingId?: string
    } | null
    const listingId = pubJson?.listingId

    return finalize({
      ok: true,
      sku: payload.sku,
      offerId,
      listingId,
      listingUrl: listingId
        ? marketplaceListingUrl(payload.marketplaceId, listingId)
        : undefined,
      compatibilityWarning,
      regulatoryWarning,
    })
  }
}

const MARKETPLACE_LANG: Record<string, string> = {
  EBAY_IT: 'it-IT',
  EBAY_DE: 'de-DE',
  EBAY_FR: 'fr-FR',
  EBAY_ES: 'es-ES',
  EBAY_GB: 'en-GB',
  EBAY_US: 'en-US',
  EBAY_AU: 'en-AU',
  EBAY_CA: 'en-CA',
}

function contentLanguageFor(marketplaceId: string): string {
  return MARKETPLACE_LANG[marketplaceId] ?? 'en-US'
}

const MARKETPLACE_HOST: Record<string, string> = {
  EBAY_IT: 'ebay.it',
  EBAY_DE: 'ebay.de',
  EBAY_FR: 'ebay.fr',
  EBAY_ES: 'ebay.es',
  EBAY_GB: 'ebay.co.uk',
  EBAY_US: 'ebay.com',
  EBAY_AU: 'ebay.com.au',
  EBAY_CA: 'ebay.ca',
}

function marketplaceListingUrl(
  marketplaceId: string,
  listingId: string,
): string {
  const host = MARKETPLACE_HOST[marketplaceId] ?? 'ebay.com'
  return `https://www.${host}/itm/${encodeURIComponent(listingId)}`
}
