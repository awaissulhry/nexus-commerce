import { runWithTraceId } from '../utils/request-context.js'
import { buildAmazonContentAttributes, type AmazonContentInput } from './pim/amazon-content-payload.js'
import { amazonContentRefusal, isAmazonContentPatchSet } from './amazon/validate-before-send.js'
import { noDestinationSentence, resolveDestinations, type Destination } from './outbound-destination.js';
import { syncShopifyLinkedListing, type LinkedListingWork } from './shopify/listing-write.service.js';
import { createOutboundRow, quantityRowTarget, unnamedQuantitySentence, unnamedRowKind } from './outbound-rows.js'
import { ebaySend } from './gateway/ebay.js';
import { isFbaCoordinate as isFbaListing } from "../lib/amazon-fulfillment.js";
import { assertPushAllowed, type PushLockListing } from '@nexus/shared/push-lock'
import { readSaleWindows } from './pim/sale-window.js' // MX.1 (D-MX4) — the stored sale window a price push must carry
import { assertListingContentReviewed, PUBLISH_CONTENT_FIELDS } from './pim/publish-review-gate.js'
import { marketLanguages, languageTag } from './pim/market-languages.js'
import { assertInformationLocale } from './pim/information-locale.js'
import { getAmazonSellerId } from '../lib/amazon-sp-client.js'
import { assertWriteAccount, isWrongAccountWriteError } from './write-account-guard.js'
import prisma from "../db.js";
import { DELIST_OPERATOR_COPY } from './delist-error-codes.js';
import { logger } from "../utils/logger.js";
import { amazonSpApiClient } from "../clients/amazon-sp-api.client.js";
import {
  acquireAmazonPublishToken,
  checkAmazonCircuit,
  getAmazonPublishMode,
  recordAmazonOutcome,
} from "./amazon-publish-gate.service.js";
import {
  acquireEbayPublishToken,
  checkEbayCircuit,
  getEbayApiBaseForMode,
  getEbayPublishMode,
  recordEbayOutcome,
} from "./ebay-publish-gate.service.js";
import { getShopifyPublishMode } from "./shopify-publish-gate.service.js";
import { getEtsyPublishMode } from "./etsy-publish-gate.service.js";
import {
  digestPayload,
  writeAttemptLog,
} from "./channel-publish-audit.service.js";
import { ebayAuthService } from "./ebay-auth.service.js";
import { listingPublishService } from "./listing-publish.service.js";
import { computeAvailableToPublish } from "./available-to-publish.service.js";
import { priceRefusalFor } from "./price-bounds.service.js";
import { confirmEbayOfferPrice, ebayFixedPriceOfferOf, ebayMarketplaceIdOf, offerPriceOf, pickEbayPriceOffer } from "./ebay-price-readback.service.js";
import { detectEuIntentConflict, AMAZON_EU_SHARED_MARKETS, EU_GUARD_REMEDY } from "./amazon-eu-quantity-guard.js";
import { resolveMembershipIntended, routedAvailable } from "./sync-control-core.js";
import { marketCurrency } from './pim/market-currency.js';
import { ledgerInputs, loadSyncLedgers } from "./stock-pool/sync-ledgers.js";
import { loadChannelPolicies, policyFor } from "./sync-control-policy.service.js";
import { publishOrderEvent } from "./order-events.service.js";
import { productEventService } from "./product-event.service.js";
import {
  reviseInventoryStatus as ebayReviseInventoryStatus,
  reviseInventoryStatusBatch as ebayReviseInventoryStatusBatch,
  REVISE_INVENTORY_STATUS_MAX_ENTRIES,
} from "./ebay-trading-api.service.js";
import { ebayListingLanguage } from './gateway/channels.js';
import { tryResolveConnection } from './connection-resolver.service.js'
import { syncNativeShopifyOffer } from './shopify/offer-sync.service.js'
import { amazonDiscountedPrice } from './amazon/discounted-price.js'
import { amazonOfferMergeEnabled, amazonOfferReadFailure, amazonPriceOfferPlan, readAmazonOfferLive } from './amazon/purchasable-offer.js'

// Phase 3 — test seam for the Trading-API network call.
// Overridable in unit tests; defaults to the real Phase-1 fn.
export const __ebayTrading = {
  reviseInventoryStatus: ebayReviseInventoryStatus,
  reviseInventoryStatusBatch: ebayReviseInventoryStatusBatch,
}

// RT.2 — per-item revise pacing. eBay hard-caps ~250 revises per listing per
// CALENDAR DAY (each ReviseInventoryStatus CALL counts once, hence the ≤4-SKU
// batching). The debounce spaces successive revises of one ItemID; a debounced
// row re-arms via the deferral disposition WITHOUT consuming retry budget, and
// coalescing usually replaces it with a fresher row before it re-fires.
const EBAY_REVISE_MIN_INTERVAL_MS = Number(process.env.NEXUS_EBAY_REVISE_MIN_INTERVAL_MS ?? 15_000);
const EBAY_REVISE_DAILY_WARN = Number(process.env.NEXUS_EBAY_REVISE_DAILY_WARN ?? 150);
const _reviseDayCounts = new Map<string, { day: string; count: number }>();

/** Count a Trading revise call for an item; returns today's total (UTC day). */
export function countEbayReviseCall(itemId: string, now: number = Date.now()): number {
  const day = new Date(now).toISOString().slice(0, 10);
  const cur = _reviseDayCounts.get(itemId);
  if (!cur || cur.day !== day) {
    _reviseDayCounts.set(itemId, { day, count: 1 });
    return 1;
  }
  cur.count += 1;
  return cur.count;
}

// Advertising mutations (bids/budgets/state) ride the same OutboundSyncQueue
// table but are owned exclusively by the dedicated ads-sync worker
// (ads-sync.worker.ts → dispatchToAmazon, gated by checkAdsWriteGate). This
// generic listings processor must NOT pick them up — routing an AD_BID_UPDATE
// through syncToAmazon (the listings PATCH path) fails it at the listings
// publish gate and starves the real ads dispatcher. Exclude them from both the
// pending and retry selections.
const AD_SYNC_TYPES = [
  "AD_BID_UPDATE",
  "AD_BUDGET_UPDATE",
  "AD_ENTITY_STATE_UPDATE",
  "AD_BIDDING_STRATEGY_UPDATE",
] as const;

// ── RT.0 — failure disposition (cron drain path) ────────────────────────────
// The old handleSyncFailure burned the 3-attempt budget in 2s/4s/8s — inside a
// single 10-minute circuit-open episode every attempt fails and the row goes
// terminally FAILED (invisible: no isDead). New semantics:
//   • circuit-open / rate-limited failures are DEFERRALS: retryCount is NOT
//     consumed, the row re-arms after the episode should have passed.
//   • genuinely retryable failures back off 30s / 2m / 10m (+ jitter ≤20%).
//   • non-retryable (validation-class) failures are terminal immediately.
//   • every terminal row is dead-lettered (isDead + diedAt + SYNC_DEAD event)
//     for parity with the BullMQ worker path (P3.2).

const RETRY_BACKOFF_MS = [30_000, 120_000, 600_000] as const;
const CIRCUIT_DEFER_MS = 5 * 60_000;
const RATE_LIMIT_DEFER_MS = 60_000;
// AS.1 — auth-class outages (revoked token / missing authorization role) are
// account-level episodes: no retry can succeed until the credential is fixed,
// so burning the 3-attempt budget just converts the whole queue into
// MAX_RETRIES_EXCEEDED dead-letters (812 measured during the 2026-07-20 403
// incident). Defer longer than a circuit episode; the latency-watchdog
// tripwire (CHANNEL_AUTH_FAILURE) owns making the outage visible.
const AUTH_DEFER_MS = 15 * 60_000;
// Matches the P0b-era honest client messages ("HTTP 403 — Unauthorized:
// Access to requested resource is denied.") and LWA refresh failures.
// Deliberately narrow: eBay transient 401s ("Invalid access token") keep
// their existing transient/circuit classification and self-heal via token
// refresh.
const AUTH_CLASS_RE = /Unauthorized|invalid_grant|Access to requested resource is denied|writes are paused until the operator reconnects|Held, nothing sent:.*(?:needs to be reconnected|no .* token for this account)/i;
const AUTH_HOLD_CODES = new Set(['AUTH_REQUIRED', 'ACCOUNT_NEEDS_SIGNIN', 'CONNECTION_NEEDS_REAUTH', 'TOKEN_UNAVAILABLE']);
// 2026-09-30 — another change to the same Etsy listing holds its inventory lock (etsy/listing-lock.ts). Nothing was
// sent; the row waits its turn and spends no retry.
const LISTING_BUSY_DEFER_MS = 30_000;

export function withJitter(ms: number): number {
  return Math.round(ms * (1 + Math.random() * 0.2));
}

export type FailureDisposition =
  | { kind: "deferral"; nextRetryAt: Date; errorCode: "CIRCUIT_OPEN_DEFERRED" | "AUTH_REQUIRED" | "ETSY_LISTING_BUSY" }
  | { kind: "terminal"; errorCode: string }
  | { kind: "retry"; nextRetryAt: Date; errorCode: "RETRY_SCHEDULED" };

export function computeFailureDisposition(
  queueItem: { retryCount: number; maxRetries?: number | null },
  errorMessage: string,
  opts?: { errorCode?: string; retryable?: boolean },
  now: number = Date.now(),
): FailureDisposition {
  if (opts?.errorCode === "ETSY_LISTING_BUSY") {
    return { kind: "deferral", nextRetryAt: new Date(now + withJitter(LISTING_BUSY_DEFER_MS)), errorCode: "ETSY_LISTING_BUSY" };
  }
  const isCircuitOpen =
    opts?.errorCode === "EBAY_CIRCUIT_OPEN" || /circuit open/i.test(errorMessage);
  const isRateLimited =
    opts?.errorCode === "EBAY_RATE_LIMITED" || /rate limit/i.test(errorMessage);
  // RT.2 — a debounced revise is episode-style too: re-arm shortly, no budget.
  // SC.5-fix — ALSO match the message: any path that drops the errorCode
  // (measured 2026-07-20: 20 debounce dead-letters) must still defer.
  const isDebounced =
    opts?.errorCode === "EBAY_REVISE_DEBOUNCED" || /debounced:/i.test(errorMessage);
  // A structural colour sync can take longer than the normal stock retry window. Its lease is a wait, not a failure.
  const isColourSyncBusy = opts?.errorCode === "SHOPIFY_COLOUR_SYNC_BUSY";
  if (isCircuitOpen || isRateLimited || isDebounced || isColourSyncBusy) {
    const defer = isCircuitOpen ? CIRCUIT_DEFER_MS : RATE_LIMIT_DEFER_MS;
    return {
      kind: "deferral",
      nextRetryAt: new Date(now + withJitter(defer)),
      errorCode: "CIRCUIT_OPEN_DEFERRED",
    };
  }
  if (AUTH_HOLD_CODES.has(opts?.errorCode ?? '') || AUTH_CLASS_RE.test(errorMessage)) {
    return {
      kind: "deferral",
      nextRetryAt: new Date(now + withJitter(AUTH_DEFER_MS)),
      errorCode: "AUTH_REQUIRED",
    };
  }
  if (opts?.retryable === false) {
    return { kind: "terminal", errorCode: opts?.errorCode ?? "NON_RETRYABLE" };
  }
  const newRetryCount = queueItem.retryCount + 1;
  const maxRetries = queueItem.maxRetries || 3;
  if (newRetryCount >= maxRetries) {
    return { kind: "terminal", errorCode: "MAX_RETRIES_EXCEEDED" };
  }
  const backoff =
    RETRY_BACKOFF_MS[Math.min(newRetryCount - 1, RETRY_BACKOFF_MS.length - 1)];
  return {
    kind: "retry",
    nextRetryAt: new Date(now + withJitter(backoff)),
    errorCode: "RETRY_SCHEDULED",
  };
}

// ── RT.0 — eBay "listing ended" auto-heal ───────────────────────────────────
// Trading-API failures arrive as Ack=Failure with an error code in the thrown
// message, e.g.: `eBay ReviseInventoryStatus Failure: Non puoi modificare
// un'inserzione scaduta "256552369326". (code 21916750)`. A dead listing is a
// PER-LISTING terminal condition: pushing at it can never succeed, and letting
// it record circuit outcomes froze the whole marketplace lane for ~10 minutes
// per episode (measured incident, 2026-07-19). Fail-closed: only the codes
// below auto-end a membership; everything else keeps the existing behavior.
const EBAY_ENDED_LISTING_CODES = new Set(
  (process.env.NEXUS_EBAY_ENDED_CODES ?? "21916750")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

export function matchEbayEndedListingCode(message: string): string | null {
  for (const m of message.matchAll(/\(code (\d+)\)/g)) {
    if (EBAY_ENDED_LISTING_CODES.has(m[1])) return m[1];
  }
  return null;
}

// ── eBay payload helpers (Phase 0.1) ───────────────────────────────────────
// On eBay, price lives on the OFFER and quantity on the inventory_item — two
// different endpoints — and createOrReplaceInventoryItem REPLACES the whole
// item, so we GET-merge-PUT to avoid wiping listing content. The prior single
// inventory_item PUT put price on the item, used the wrong qty key, and
// hardcoded USD, so master price/stock changes silently never reached eBay.

/**
 * P4.4a — from the `Marketplace` row, not `EBAY_GB ? GBP : EUR`.
 *
 * The old form was wrong for every eBay market whose currency is neither of
 * those, and it refused nothing: an unconfigured market silently priced in EUR.
 * `marketCurrency` refuses instead, because a wrong currency is a money defect
 * the channel reports as success.
 */
export async function ebayCurrencyForMarket(marketplaceId: string | undefined): Promise<string> {
  return marketCurrency('EBAY', marketplaceId ?? 'EBAY_IT');
}

/** eBay Inventory API requires BOTH language headers set to the marketplace
 *  locale, plus the marketplace id, on every call (error 25709 otherwise). */
export async function ebayInventoryHeaders(token: string, marketplaceId: string): Promise<Record<string, string>> {
  const mp2 = (marketplaceId ?? "EBAY_IT").replace(/^EBAY_/, "");
  const lang = await ebayListingLanguage(mp2);
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "Content-Language": lang,
    "Accept-Language": lang,
    "X-EBAY-C-MARKETPLACE-ID": marketplaceId ?? "EBAY_IT",
  };
}

/** Merge quantity/content into an existing inventory_item so the createOrReplace
 *  PUT doesn't drop the rest of the listing. */
export function mergeEbayInventoryItem(
  existing: Record<string, any>,
  payload: { quantity?: number; title?: string; description?: string; images?: string[]; mappingAspects?: Record<string, string[] | null> },
): Record<string, any> {
  const merged: Record<string, any> = { ...existing };
  if (payload.quantity !== undefined) {
    merged.availability = {
      ...(existing.availability ?? {}),
      shipToLocationAvailability: { quantity: payload.quantity },
    };
  }
  if (payload.title || payload.description || (payload.images && payload.images.length > 0)) {
    merged.product = { ...(existing.product ?? {}) };
    if (payload.title) merged.product.title = payload.title;
    if (payload.description) merged.product.description = payload.description;
    if (payload.images && payload.images.length > 0) merged.product.imageUrls = payload.images;
  }
  if (payload.mappingAspects) {
    merged.product = { ...(merged.product ?? {}) };
    const aspects = { ...(merged.product.aspects ?? {}) };
    for (const [name, value] of Object.entries(payload.mappingAspects)) {
      if (value === null) delete aspects[name];
      else aspects[name] = value;
    }
    merged.product.aspects = aspects;
  }
  return merged;
}

/** Update an existing offer's price, preserving its other fields. */
export function buildEbayOfferUpdate(
  existingOffer: Record<string, any>,
  price: number,
  currency: string,
): Record<string, any> {
  return {
    ...existingOffer,
    pricingSummary: { price: { value: price.toFixed(2), currency } },
  };
}

// Amazon EU marketplace IDs (Phase 0.2). The price PATCH was hardcoded to the
// US marketplace (ATVPDKIKX0DER) for an Amazon-IT seller; resolve the listing's
// real marketplace, defaulting to IT (the primary market) — never US.
const AMAZON_MARKETPLACE_IDS: Record<string, string> = {
  IT: "APJ6JRA9NG5V4", DE: "A1PA6795UKMFR9", FR: "A13V1IB3VIYZZH", ES: "A1RKKUPIHCS9HS",
  NL: "A1805IZSGTT6HS", SE: "A2NODRKZP88ZB9", PL: "A1C3SOZRARQ6R3", BE: "AMEN7PMS3EDWL",
  IE: "A28R8C7NBKEWEA", UK: "A1F83G8C2ARO7P", GB: "A1F83G8C2ARO7P", US: "ATVPDKIKX0DER",
};

/** A-24 (R-20) — the id for a known market code (or a full id), or null. Never a default market. */
export function amazonMarketplaceIdOrNull(mp: string | null | undefined): string | null {
  if (!mp) return null;
  if (/^A[A-Z0-9]{9,}$/.test(mp)) return mp;
  return AMAZON_MARKETPLACE_IDS[mp.toUpperCase()] ?? null;
}

export function resolveAmazonMarketplaceId(mp: string | undefined): string {
  if (!mp) return AMAZON_MARKETPLACE_IDS.IT;
  if (/^A[A-Z0-9]{9,}$/.test(mp)) return mp; // already a full Amazon marketplace id
  return AMAZON_MARKETPLACE_IDS[mp.toUpperCase()] ?? AMAZON_MARKETPLACE_IDS.IT;
}

/**
 * A4.0 — build a CORRECT Amazon Listings Items PATCH body. The old
 * constructAmazonPayload emitted non-schema attribute names (`title`, `price`,
 * `fulfillmentAvailability`) inside a bare `{attributes}` object — Amazon's PATCH
 * needs `{ productType, patches: [{op,path:/attributes/<name>,value}] }` with the
 * real schema names (item_name / product_description / bullet_point /
 * purchasable_offer / fulfillment_availability) and value shapes. Mirrors the
 * proven buildJsonFeedBody attribute shapes; same serializer semantics everywhere.
 */
export async function buildAmazonListingPatch(
  payload: SyncPayload,
  marketplaceCode: string,
  productType: string,
  fulfillmentMethod?: string | null,
  content?: Omit<AmazonContentInput, 'marketplace' | 'marketplaceId'>,
): Promise<Record<string, any>> {
  const rawCode = (marketplaceCode || "IT").toUpperCase();
  const code = Object.entries(AMAZON_MARKETPLACE_IDS).find(([, id]) => id === rawCode)?.[0] ?? rawCode;
  const marketplaceId = resolveAmazonMarketplaceId(code);
  const hasContent = !!(payload.title || payload.description || payload.bulletPoints?.length);
  const languages = hasContent && !content ? await marketLanguages('AMAZON', code) : [];
  const language = payload.language ?? languages[0];
  if (hasContent && !content) assertInformationLocale('AMAZON', language, languages);
  const language_tag = hasContent && !content ? languageTag(language, code) : undefined;
  const isFba = String(fulfillmentMethod ?? "").toUpperCase() === "FBA";
  const attrs: Record<string, any> = {};

  if (content) Object.assign(attrs, await buildAmazonContentAttributes({ ...content, marketplace: code, marketplaceId }));
  else {
  if (payload.title) {
    attrs.item_name = [{ value: String(payload.title), marketplace_id: marketplaceId, language_tag }];
  }
  if (payload.description) {
    attrs.product_description = [{ value: String(payload.description), marketplace_id: marketplaceId, language_tag }];
  }
  const bullets = (payload as any).bulletPoints;
  if (Array.isArray(bullets) && bullets.length > 0) {
    attrs.bullet_point = bullets.filter(Boolean).map((b: any) => ({ value: String(b), marketplace_id: marketplaceId, language_tag }));
  }
  }
  if (payload.price !== undefined) {
    // P4.4a — from the Marketplace row, not a UK/GB ternary. Resolved HERE rather
    // than at the top of the builder so a CONTENT-only push to a market with no
    // currency configured is not refused for a price it is not sending.
    const currency = await marketCurrency('AMAZON', code);
    const offer: Record<string, any> = { currency, our_price: [{ schedule: [{ value_with_tax: payload.price }] }], marketplace_id: marketplaceId };
    // MX.1 (D-MX4) — the sale rides the SAME purchasable_offer instance as our_price, so the one `op:replace` this
    // builder emits carries both and a price push never wipes the sale (report 19 §5.9). Shape = the cached
    // Listings-Items JSON schema (`discounted_price[].schedule[]{ start_at, end_at, value_with_tax }`, all three
    // REQUIRED; measured on IT/UK/DE, MX.1 phase 0(c)) — NOT the feed's `sale_price` with `start_at:[{value}]`. A sale
    // without both dates is never emitted: Amazon would reject the schedule entry.
    // With NEXUS_AMAZON_OFFER_MERGE=1, `syncToAmazon` turns this replace into a MERGE on the live offer instance at
    // send time (amazon/purchasable-offer.ts); the replace then goes out as built only for a first offer.
    const sale = amazonDiscountedPrice(payload.salePrice != null ? Number(payload.salePrice) : null, payload.salePriceStart, payload.salePriceEnd);
    if (sale) offer.discounted_price = sale;
    attrs.purchasable_offer = [offer];
  }
  // B2 — FBA stock is owned by Amazon. Pushing a merchant fulfillment_availability
  // (DEFAULT channel) for an FBA SKU flips the offer to FBM and overwrites Amazon's
  // managed quantity. So only emit a merchant quantity for FBM (or unknown — the
  // common, safe default). For FBA we leave fulfillment untouched (handled upstream).
  if (payload.quantity !== undefined && !isFba) {
    // P0b — canonical schema shape: fulfillment_availability entries carry
    // fulfillment_channel_code + quantity ONLY (channel-scoped, not
    // marketplace-scoped; the marketplace comes from the ?marketplaceIds
    // query param). The stray marketplace_id predates the incident.
    attrs.fulfillment_availability = [{ fulfillment_channel_code: "DEFAULT", quantity: payload.quantity }];
  }

  return {
    productType,
    patches: [...Object.entries(attrs).map(([k, v]) => ({ op: "replace", path: `/attributes/${k}`, value: v })), ...(payload.source === 'FM_CATALOG_CASCADE' ? payload.mappingAttributePatches ?? [] : [])],
  };
}

/**
 * B2 / FBA-flip fix — is this Amazon listing FBA (Amazon-fulfilled)? Returns true
 * (⇒ caller must NOT push a merchant DEFAULT quantity) on ANY FBA signal:
 *   • the listing's explicit FBA method, or a persisted AMAZON_* channel code;
 *   • Product.fulfillmentMethod === 'FBA' — STANDALONE, no longer gated on the
 *     listing method being null. A stale/wrong listing 'FBM' must not authorize a
 *     flip: that gate is exactly what let real FBA offers get flipped to FBM;
 *   • positive FBA evidence the caller resolved (FBA stock on hand / active FBA offer).
 * Fail-closed: when fulfillment is ambiguous we treat it as FBA and SKIP the qty
 * push. Cost = a missed merchant-qty sync for a genuinely-FBM listing of an
 * FBA-default product (benign, recoverable); avoided cost = flipping an FBA offer to
 * "Venduto e spedito da …" (catastrophic). Pure + testable.
 */
export { isFbaCoordinate as isFbaListing } from "../lib/amazon-fulfillment.js";

/**
 * B3 — map a master CONTENT_UPDATE payload to a Shopify Admin API product
 * update body. Title is pushed only when non-empty (Shopify rejects an empty
 * product title); description → body_html (an explicit '' clears the body).
 * Returns null when there's no Shopify-supported field to push (e.g. a
 * bullets-only change) OR the product id is unusable — caller skips the PUT.
 * Pure + testable. (bulletPoints → body_html merge = follow-up B3.1.)
 */
export function buildShopifyProductUpdate(
  shopifyProductId: string | number | null | undefined,
  payload: { title?: string | null; description?: string | null },
): { product: Record<string, unknown> } | null {
  const numId = typeof shopifyProductId === "string" ? parseInt(shopifyProductId, 10) : shopifyProductId;
  if (!numId || Number.isNaN(numId)) return null;
  const product: Record<string, unknown> = { id: numId };
  let has = false;
  if (payload.title != null && String(payload.title).trim() !== "") {
    product.title = String(payload.title);
    has = true;
  }
  if (payload.description !== undefined) {
    product.body_html = payload.description == null ? "" : String(payload.description);
    has = true;
  }
  return has ? { product } : null;
}

/**
 * Phase 1 — at dispatch time, the freshest committed quantity is the current
 * ChannelListing.quantity (the cascade always updates it transactionally to the
 * latest value). Pushing that instead of the payload snapshot prevents a stale
 * in-flight job from overwriting a newer value (last-writer-wins). `0` is a real
 * value (out of stock) and must not be treated as falsy.
 */
export function resolveDispatchQuantity(
  currentListingQty: number | null | undefined,
  payloadQty: number | null | undefined,
): number | undefined {
  if (typeof currentListingQty === 'number') return currentListingQty
  return payloadQty ?? undefined
}

/**
 * Phase 2 — hard oversell guard. Clamp a requested dispatch quantity to what
 * the backing pool can actually ship. `clamped` flags an overshoot so the
 * caller can emit a sync.oversell.clamped event (never silent). Pure.
 */
export function applyOversellClamp(
  requested: number,
  available: number,
): { quantity: number; clamped: boolean } {
  if (requested > available) return { quantity: available, clamped: true }
  return { quantity: requested, clamped: false }
}

// ── Data Structures ──────────────────────────────────────────────────────

interface SyncPayload {
  price?: number;
  quantity?: number;
  categoryAttributes?: Record<string, any>;
  title?: string;
  description?: string;
  images?: string[];
  [key: string]: any;
}

interface QueueResult {
  success: boolean;
  queueId?: string;
  message: string;
}

interface SyncResult {
  success: boolean;
  queueId: string;
  channel: string;
  status: string;
  message: string;
  error?: string;
  /** Stable error classifier (e.g. EBAY_VALIDATION, EBAY_TRANSIENT). Copied
   *  by the BullMQ worker onto OutboundSyncQueue.errorCode so the operator
   *  sees the real cause instead of the downstream circuit-open message. */
  errorCode?: string;
  retryable?: boolean;
  /** PD.3 — true when the "success" was a dry-run/sandbox no-op (nothing actually
   *  published). The worker marks these SKIPPED, not SUCCESS, so the grid doesn't
   *  show false green. */
  dryRun?: boolean;
  /** CX (review 2026-09-26) — report-only work to start AFTER the row is written (`startAfterAnswer`). */
  afterAnswer?: () => Promise<unknown>;
}

interface ProcessingStats {
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  errors: Array<{ queueId: string; error: string }>;
}

/** W1.9: a completed attempt may have sent nothing. All queue writers agree. */
export function completedSyncQueueData(result: Pick<SyncResult, 'status' | 'dryRun' | 'message' | 'errorCode'>) {
  const skipped = result.dryRun === true || result.status === 'SKIPPED' || result.status === 'NOT_SENT';
  return {
    syncStatus: skipped ? 'SKIPPED' as const : 'SUCCESS' as const,
    syncedAt: skipped ? null : new Date(),
    errorCode: skipped ? result.errorCode ?? (result.dryRun ? 'DELIST_DRY_RUN' : 'OUTBOUND_NOT_SENT') : null,
    errorMessage: skipped ? result.message || DELIST_OPERATOR_COPY.OUTBOUND_NOT_SENT : null,
    nextRetryAt: null,
  };
}

// ── Outbound Sync Service ────────────────────────────────────────────────

/**
 * Classify an eBay API failure by HTTP status so the operator sees a stable
 * code on the queue row rather than the downstream "circuit open" message.
 *
 * 400/404/409/422 = the listing or payload is wrong; retrying won't help and
 * must NOT back off the whole marketplace (EBAY_VALIDATION).
 * Everything else (401/403/429/5xx, network/null) is transient/connection-level:
 * retry + trip the circuit (EBAY_TRANSIENT).
 *
 * retryable / tripsCircuit are wired into the circuit-breaker in Task 3;
 * only `code` is consumed in Task 2.
 */
export function classifyEbayFailure(httpStatus: number | null): {
  code: 'EBAY_VALIDATION' | 'EBAY_TRANSIENT';
  retryable: boolean;
  tripsCircuit: boolean;
} {
  const listingFatal = httpStatus != null && [400, 404, 409, 422].includes(httpStatus);
  return listingFatal
    ? { code: 'EBAY_VALIDATION', retryable: false, tripsCircuit: false }
    : { code: 'EBAY_TRANSIENT', retryable: true, tripsCircuit: true };
}

/**
 * Task 3 — pure decision helper for `ebayFail`.
 *
 * Determines, for a given failure, whether the marketplace circuit breaker
 * should be tripped and whether the queue row should be retried.
 *
 * Kill-switch: `NEXUS_EBAY_FAILURE_ISOLATION`
 *   - default (absent or any value ≠ '0'): isolation ON — validation errors
 *     do NOT trip the circuit and are marked non-retryable (terminal FAILED).
 *   - '0': isolation OFF — preserve pre-Task-3 behavior (always record toward
 *     the circuit; retryable left for the worker's default true logic).
 *
 * Exported so it can be unit-tested as a pure function without mocking.
 */
export function ebayFailureDecision(
  httpStatus: number | null | undefined,
  isolationEnabled: boolean,
): { record: boolean; retryable: boolean; code: 'EBAY_VALIDATION' | 'EBAY_TRANSIENT' } {
  const c = classifyEbayFailure(httpStatus ?? null);
  if (!isolationEnabled) {
    // Kill-switch '0': always record toward circuit, retryable stays true
    return { record: true, retryable: true, code: c.code };
  }
  return { record: c.tripsCircuit, retryable: c.retryable, code: c.code };
}

/**
 * PD-Q — bound a promise so one hung downstream call (SP-API / Redis) can never
 * wedge the sync loop. On timeout it rejects; the caller's per-item catch marks
 * the row FAILED-retryable and moves on.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

/** Per-item dispatch ceiling for the backstop loop (env-overridable). */
const DISPATCH_TIMEOUT_MS = Math.max(5_000, Number(process.env.NEXUS_SYNC_DISPATCH_TIMEOUT_MS ?? '45000') || 45_000);

/**
 * CX (review 2026-09-26) — start a result's report-only follow-up (the eBay price read-back) once its queue row is
 * WRITTEN. Called by every completion writer after the row's update: the follow-up never spends the row's dispatch
 * budget, never delays its answer, and can never change it. Not awaited; it never throws into the caller.
 */
export function startAfterAnswer(result: { afterAnswer?: () => Promise<unknown> } | null | undefined): void {
  const run = result?.afterAnswer
  if (!run) return
  void Promise.resolve().then(run).catch((err) => {
    logger.warn('outbound-sync: after-answer work failed (report-only; the row keeps its answer)', { error: err instanceof Error ? err.message : String(err) })
  })
}

export class OutboundSyncService {
  private stats = {
    queued: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
  };

  /**
   * Queue a product update for outbound sync to a specific channel
   */
  async queueProductUpdate(
    productId: string,
    targetChannel: "AMAZON" | "EBAY" | "SHOPIFY" | "WOOCOMMERCE" | "ETSY",
    syncType: "PRICE_UPDATE" | "QUANTITY_UPDATE" | "ATTRIBUTE_UPDATE" | "FULL_SYNC",
    payload: SyncPayload
  ): Promise<QueueResult> {
    try {
      // Verify product exists
      const product = await prisma.product.findUnique({
        where: { id: productId },
      });

      if (!product) {
        return {
          success: false,
          message: `Product ${productId} not found`,
        };
      }

      // Create queue entry
      const queueEntry = await createOutboundRow(prisma, {
        data: {
          productId,
          targetChannel,
          syncStatus: "PENDING",
          syncType,
          payload,
          retryCount: 0,
          maxRetries: 3,
          externalListingId: this.getExternalListingId(product, targetChannel),
        },
      });

      // RT.2 — instant lane (covers every queueProductUpdate caller at once);
      // dynamic import avoids a static cycle, addJobSafely never hangs.
      void import("./outbound-enqueue.js")
        .then(({ fireOutboundJobs }) =>
          fireOutboundJobs(
            [{ id: queueEntry.id, productId, syncType, holdUntil: null }],
            { source: "QUEUE_PRODUCT_UPDATE" },
          ),
        )
        .catch(() => {});

      this.stats.queued++;

      return {
        success: true,
        queueId: queueEntry.id,
        message: `Product queued for ${targetChannel} sync`,
      };
    } catch (error) {
      console.error("Error queuing product update:", error);
      return {
        success: false,
        message: `Failed to queue product: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  /** A2.1 — route one queue item to the right channel sync method. */
  /**
   * P4.3d — the ceiling of the send-time oversell clamp, ROUTED the same way the
   * intended quantity is.
   *
   * Before this, all three lanes summed `sellableAvailable` — every warehouse row
   * the product holds, routed or not — and subtracted the buffer. The quantity a
   * listing may promise was routed (`resolveIntendedQuantity`); the cap on it was
   * not. Two derivations of one number, and the cap was the WIDER one, so it
   * caught nothing a routed push could do wrong: a pinned quantity, a stale row
   * or a legacy producer could promise units held in a warehouse that does not
   * serve that market at all.
   *
   * `routed: false` — no location is routed here — is returned, never turned into
   * a ceiling of 0. For a pooled product that means "we do not know" (the
   * resolver answers UNCOUNTED and pushes nothing), and capping an unknown to
   * zero and sending it is the scoped-Zero incident. The caller decides.
   */
  async routedCeiling(args: {
    productId: string
    channel: string
    channelLabel: string
    marketplace: string
    sourceLocationCodes: string[]
    stockBuffer: number
  }): Promise<{ available: number; routedAvailable: number; locationCodes: string[]; refusal: string | null }> {
    const productLedger = (await loadSyncLedgers(prisma, [args.productId])).get(args.productId);
    const inputs = ledgerInputs(productLedger, args.sourceLocationCodes);
    const routed = routedAvailable({
      ledger: inputs.ledger,
      channel: args.channel,
      marketplace: args.marketplace,
      sourceLocationCodes: inputs.sourceLocationCodes,
    });
    // Two nullable fields, not an `ok` union: `apps/api` sets "strict": false, so a
    // discriminated union never narrows and `refusal` would be a compile error
    // after the guard.
    return {
      // The listing's own hold-back is applied on top, exactly as before.
      available: computeAvailableToPublish({
        fulfillmentMethod: 'FBM',
        warehouseAvailable: routed.available,
        fbaSellable: 0,
        stockBuffer: args.stockBuffer,
      }).available,
      routedAvailable: routed.available,
      locationCodes: routed.locationCodes,
      refusal: !routed.routed && !inputs.uncountedIsZero
        ? `Nothing was sent to ${args.channelLabel}: no stock location is routed to ${args.marketplace} for this listing, so the quantity it may promise cannot be worked out. Route a location to this market in Sync Control.`
        : null,
    };
  }

  private async pushLockListings(queueItem: any, channel: string): Promise<PushLockListing[]> {
    if (queueItem.channelListingId) {
      const listing = await prisma.channelListing.findUnique({ where: { id: queueItem.channelListingId } });
      return listing ? [listing] : [];
    }
    const productId = queueItem.productId ?? queueItem.product?.id ?? queueItem.payload?.productId;
    const itemId = channel === 'EBAY' && queueItem.payload?.pushVia === 'TRADING'
      ? queueItem.payload?.itemId ?? queueItem.externalListingId : null;
    if (!productId && !itemId) return [];
    const region = queueItem.targetRegion ?? queueItem.payload?.market ?? queueItem.payload?.marketplace;
    const markets = region === 'GB' || region === 'UK' ? ['GB', 'UK'] : region ? [region] : null;
    return prisma.channelListing.findMany({ where: {
      channel,
      ...(itemId ? { externalListingId: itemId } : { productId }),
      ...(markets ? { marketplace: { in: markets } } : {}),
      ...(queueItem.payload?.channelConnectionId ? { channelConnectionId: queueItem.payload.channelConnectionId } : {}),
      // A shared ItemID writes every member: any held coordinate must hold it.
      ...(!itemId && queueItem.payload?.aliasKey !== undefined ? { aliasKey: queueItem.payload.aliasKey } : {}),
    } });
  }

  /**
   * P1.3 — the channel account this row goes to: the one written with it (services/outbound-rows.ts),
   * else — a row from before P1.3 — resolved by the same rule. `connectionId: null` = refuse the row.
   */
  private async destinationOf(queueItem: any): Promise<Destination> {
    if (queueItem.channelConnectionId) return { connectionId: queueItem.channelConnectionId, reason: "NAMED" };
    const [destination] = await resolveDestinations(prisma as never, [queueItem]);
    return destination;
  }

  private async dispatchSync(item: any): Promise<SyncResult> {
    // Presence W1.2 / D10 / SHOP-P4: the legacy dispatcher has no lifecycle
    // implementation. Refuse before content preparation or any update path.
    if (item.syncType === 'UNPUBLISH_LISTING' || item.syncType === 'DELETE_LISTING') {
      const { DELIST_OPERATOR_COPY } = await import('./delist-error-codes.js');
      const error = DELIST_OPERATOR_COPY.LIFECYCLE_DISPATCH_REFUSED;
      return { success: false, queueId: item.id, channel: item.targetChannel,
        status: 'FAILED', message: error, error, errorCode: 'LIFECYCLE_DISPATCH_REFUSED', retryable: false };
    }

    if (item.payload?.source === 'FM_CATALOG_CASCADE') {
      const { prepareMappingDispatch } = await import('./pim/mapping/prepare-dispatch.js');
      item = await prepareMappingDispatch(item);
    }
    // D7 / R-LX-7 — the ONE review verdict, at the point every channel
    // converges. Only the Amazon branch consulted it before, so an unreviewed
    // machine draft that reached this queue published live on eBay, Shopify and
    // Woo. A text-free payload (price/quantity/image) is untouched, and the
    // refusal is terminal (retryable: false) because a retry cannot review copy.
    const contentFields = PUBLISH_CONTENT_FIELDS.filter(field => item.payload?.[field] !== undefined);
    if (contentFields.length) {
      try {
        await assertListingContentReviewed({ productId: item.productId, channel: item.targetChannel, listingId: item.channelListingId, fields: contentFields });
      } catch (error: any) {
        if (error?.code !== 'content_review_required') throw error;
        return { success: false, queueId: item.id, channel: item.targetChannel, status: "FAILED", message: error.message, error: error.message, errorCode: "CONTENT_REVIEW_REQUIRED", retryable: false };
      }
    }
    // P4.3c — a quantity row that names no listing is not sent. Rows born after
    // P4.3c cannot be in this state (services/outbound-rows.ts refuses them at
    // creation), so this arm exists for rows ALREADY in the queue — the catalog
    // PATCH's product-level gross-stock rows among them.
    //
    // Placed LAST of the shared refusals on purpose: the lifecycle refusal and the
    // content-review verdict above both still answer first, so neither is masked.
    // It sits before the channel switch rather than inside each channel because
    // every channel resolves its listing from `channelListingId` alone and every
    // one of them loses its re-read without it.
    if (quantityRowTarget(item) === 'UNNAMED') {
      const error = unnamedQuantitySentence(String(item.targetChannel), unnamedRowKind(item));
      return { success: false, queueId: item.id, channel: item.targetChannel, status: "FAILED",
        message: error, error, errorCode: "UNNAMED_QUANTITY_ROW", retryable: false };
    }
    switch (item.targetChannel) {
      case "AMAZON": return this.syncToAmazon(item);
      case "EBAY": return this.syncToEbay(item);
      case "SHOPIFY": return this.syncToShopify(item);
      case "WOOCOMMERCE": return this.syncToWoocommerce(item);
      case "ETSY": return this.syncToEtsy(item);
      default: throw new Error(`Unknown channel: ${item.targetChannel}`);
    }
  }

  /**
   * A2.1 — process exactly ONE queue row (the row a BullMQ job owns) instead of
   * draining the whole table. Guards (PENDING / not CANCELLED / past holdUntil),
   * marks IN_PROGRESS, dispatches, and returns the result. The caller owns the
   * final status write (the BullMQ worker's per-job update), so this never
   * touches any other row.
   */
  /**
   * P3.6 — the hop the trace used to die at.
   *
   * The row was created by an operator's click and carries that change's `traceId`.
   * The worker, though, runs inside its own cron tick, so without this every channel
   * call it makes is stamped with the TICK's id — and a tick id is shared by up to
   * 1,243 calls. Binding the row's trace first means "show me everything my change
   * did" is one indexed lookup.
   */
  async processSingle(queueId: string): Promise<SyncResult> {
    const item = await prisma.outboundSyncQueue.findUnique({
      where: { id: queueId },
      // P1.4 — the listing too: the Shopify native lane reads its mapping (it was never reached).
      include: { product: true, channelListing: true },
    });
    // P3.6 — bind the CHANGE's trace before anything else happens.
    //
    // The row was created by an operator's click and carries that change's `traceId`.
    // Without this the worker runs inside its own cron tick and every channel call it
    // makes is stamped with the TICK's id — and one tick id covers up to 1,243 calls.
    //
    // The row is read ONCE and handed down. A first draft read `traceId` in its own
    // query before delegating, which doubled the per-row reads — the same waste the
    // P1.3 follow-up was about, and a P1.4 test caught it by asserting on the first
    // query's shape.
    return runWithTraceId(item?.traceId ?? null, () => this.processSingleInner(queueId, item))
  }

  private async processSingleInner(
    queueId: string,
    item: Awaited<ReturnType<typeof prisma.outboundSyncQueue.findUnique>> & { product?: unknown; channelListing?: unknown } | null,
  ): Promise<SyncResult> {
    if (!item) {
      return { success: false, queueId, channel: "UNKNOWN", status: "FAILED", message: `Queue row ${queueId} not found`, error: "queue-row-not-found" };
    }
    if ((item.syncStatus as any) === "CANCELLED") {
      return { success: false, queueId, channel: item.targetChannel, status: "SKIPPED", message: "Cancelled during grace period", error: "cancelled" };
    }
    if (item.syncStatus !== "PENDING") {
      return { success: false, queueId, channel: item.targetChannel, status: "SKIPPED", message: `Not PENDING (${item.syncStatus})`, error: "not-pending" };
    }
    if (item.holdUntil && item.holdUntil > new Date()) {
      return { success: false, queueId, channel: item.targetChannel, status: "SKIPPED", message: "Still within grace window", error: "held" };
    }
    // P7 B2 — respect the offerActive suppress flag. OPT-IN (default OFF): only
    // when NEXUS_RESPECT_OFFER_ACTIVE=1 do we skip pushing to a suppressed offer.
    // Default-off so existing offerActive=false rows are unaffected until enabled.
    if (process.env.NEXUS_RESPECT_OFFER_ACTIVE === '1' && item.channelListingId) {
      const cl = await prisma.channelListing.findUnique({
        where: { id: item.channelListingId },
        select: { offerActive: true },
      }).catch(() => null)
      if (cl && cl.offerActive === false) {
        return { success: false, queueId, channel: item.targetChannel, status: "SKIPPED", message: "Offer suppressed (offerActive=false)", error: "offer-suppressed" }
      }
    }
    // AS.5 — atomic claim (compare-and-swap on status). The 60s cron backstop
    // and this BullMQ path can race the same row: buildBullMQSkip is TOCTOU
    // and fails open on Redis timeouts. Whoever loses the CAS walks away
    // instead of double-dispatching a duplicate marketplace write.
    const claimed = await prisma.outboundSyncQueue.updateMany({
      where: { id: item.id, syncStatus: "PENDING" },
      data: { syncStatus: "IN_PROGRESS" },
    });
    if (claimed.count === 0) {
      return { success: false, queueId, channel: item.targetChannel, status: "SKIPPED", message: "Lost dispatch claim (already being processed)", error: "claim-lost" };
    }
    try {
      return await withTimeout(this.dispatchSync(item), DISPATCH_TIMEOUT_MS, `dispatchSync(${item.targetChannel}/${item.id})`);
    } catch (err) {
      // dispatch threw (e.g. unknown channel) — don't leave the row stuck IN_PROGRESS.
      await prisma.outboundSyncQueue.update({ where: { id: item.id }, data: { syncStatus: "PENDING" } }).catch(() => {});
      throw err;
    }
  }

  /**
   * Process all pending syncs in the queue.
   * A2.3 — `opts.skip` lets the cron act as a BACKSTOP when BullMQ is enabled: it
   * skips rows that already have a live BullMQ job, so the cron only sweeps
   * orphans (rows written without a job, or jobs that died).
   */
  async processPendingSyncs(opts?: { skip?: (queueId: string) => Promise<boolean> }): Promise<ProcessingStats> {
    const stats: ProcessingStats = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      errors: [],
    };

    try {
      // Get all pending syncs that have either passed their grace
      // window or never had one. TECH_DEBT #49 — without the holdUntil
      // filter, any caller that wrote an OutboundSyncQueue row without
      // ALSO adding a BullMQ job (legacy paths, raw imports, manual
      // SQL) bypassed the 5-minute undo window because BullMQ's job
      // delay was the only thing deferring processing. This filter
      // mirrors outbound-sync-phase9.service.ts:332's getReadyItems().
      const now = new Date();
      const pendingItems = await prisma.outboundSyncQueue.findMany({
        where: {
          syncStatus: "PENDING",
          syncType: { notIn: [...AD_SYNC_TYPES] },
          OR: [{ holdUntil: null }, { holdUntil: { lte: now } }],
        },
        include: {
          product: true,
          channelListing: true, // P1.4 — the Shopify native lane reads the listing's mapping
        },
        orderBy: {
          createdAt: "asc",
        },
        // P1.3 — the 1-minute backup loop takes the oldest N rows per tick (it read every pending row,
        // which after an outage or a bulk edit could be tens of thousands in one tick).
        take: Math.max(1, Number(process.env.NEXUS_OUTBOUND_BACKUP_BATCH) || 200),
      });

      console.log(`Processing ${pendingItems.length} pending syncs`);

      for (const item of pendingItems) {
        if (opts?.skip && (await opts.skip(item.id))) {
          stats.skipped++;
          continue;
        }
        try {
          // AS.5 — atomic claim (see processSingle): only proceed if this
          // loop wins the PENDING→IN_PROGRESS compare-and-swap.
          const claimed = await prisma.outboundSyncQueue.updateMany({
            where: { id: item.id, syncStatus: "PENDING" },
            data: { syncStatus: "IN_PROGRESS" },
          });
          if (claimed.count === 0) {
            stats.skipped++;
            continue;
          }

          // PD-Q — a hung SP-API/Redis call must not deadlock the whole loop.
          const result = await withTimeout(
            this.dispatchSync(item),
            DISPATCH_TIMEOUT_MS,
            `dispatchSync(${item.targetChannel}/${item.id})`,
          );

          if (result.success) {
            const completion = completedSyncQueueData(result);
            await prisma.outboundSyncQueue.update({
              where: { id: item.id },
              data: completion,
            });
            startAfterAnswer(result);
            if (completion.syncStatus === 'SKIPPED') stats.skipped++;
            else stats.succeeded++;
          } else {
            // Handle retry logic
            const outcome = await this.handleSyncFailure(item, result.error || "Unknown error", {
              errorCode: result.errorCode,
              retryable: result.retryable,
            });
            if (outcome === 'UNKNOWN') stats.skipped++;
            else stats.failed++;
            stats.errors.push({
              queueId: item.id,
              error: result.error || "Unknown error",
            });
          }

          stats.processed++;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          await this.handleSyncFailure(item, errorMessage, {
            errorCode: typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : undefined,
          });
          stats.failed++;
          stats.errors.push({
            queueId: item.id,
            error: errorMessage,
          });
          stats.processed++;
        }
      }

      // Get retry items
      const retryItems = await prisma.outboundSyncQueue.findMany({
        where: {
          syncStatus: "FAILED",
          syncType: { notIn: [...AD_SYNC_TYPES] },
          nextRetryAt: {
            lte: new Date(),
          },
          isDead: false,
          OR: [{ retryCount: { lt: 3 } }, { errorCode: 'AUTH_REQUIRED' }],
        },
        include: {
          product: true,
          channelListing: true,
        },
        take: 200,
        orderBy: { nextRetryAt: 'asc' },
      });

      console.log(`Processing ${retryItems.length} retry items`);

      for (const item of retryItems) {
        if (opts?.skip && (await opts.skip(item.id))) {
          stats.skipped++;
          continue;
        }
        try {
          // AS.5 — atomic claim from FAILED (retry lane); mirrors the
          // PENDING-lane compare-and-swap above.
          const claimed = await prisma.outboundSyncQueue.updateMany({
            where: { id: item.id, syncStatus: "FAILED" },
            data: { syncStatus: "IN_PROGRESS" },
          });
          if (claimed.count === 0) {
            stats.skipped++;
            continue;
          }

          // PD-Q — a hung SP-API/Redis call must not deadlock the whole loop.
          const result = await withTimeout(
            this.dispatchSync(item),
            DISPATCH_TIMEOUT_MS,
            `dispatchSync(${item.targetChannel}/${item.id})`,
          );

          if (result.success) {
            const completion = completedSyncQueueData(result);
            await prisma.outboundSyncQueue.update({
              where: { id: item.id },
              data: completion,
            });
            startAfterAnswer(result);
            if (completion.syncStatus === 'SKIPPED') stats.skipped++;
            else stats.succeeded++;
          } else {
            const outcome = await this.handleSyncFailure(item, result.error || "Unknown error", {
              errorCode: result.errorCode,
              retryable: result.retryable,
            });
            if (outcome === 'UNKNOWN') stats.skipped++;
            else stats.failed++;
            stats.errors.push({
              queueId: item.id,
              error: result.error || "Unknown error",
            });
          }

          stats.processed++;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          await this.handleSyncFailure(item, errorMessage, {
            errorCode: typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : undefined,
          });
          stats.failed++;
          stats.errors.push({
            queueId: item.id,
            error: errorMessage,
          });
          stats.processed++;
        }
      }

      return stats;
    } catch (error) {
      console.error("Error processing pending syncs:", error);
      throw error;
    }
  }

  /**
   * Sync product to Amazon using SP-API.
   * PATCH /listings/2021-08-01/items/{sellerId}/{sku}
   *
   * C.8 — replaced the Math.random demo simulator with a real PATCH
   * call routed through amazonSpApiClient.submitListingPayload, gated
   * by the same NEXUS_ENABLE_AMAZON_PUBLISH flag + AMAZON_PUBLISH_MODE
   * resolver as the wizard publish path (C.6). Default state: gated
   * outcome, queue row fails honestly. Set the flag + mode on Railway
   * to enable real updates.
   */
  private async syncToAmazon(queueItem: any): Promise<SyncResult> {
    const pushRefusal = (await this.pushLockListings(queueItem, 'AMAZON'))
      .map(listing => assertPushAllowed(listing)).find(Boolean);
    if (pushRefusal) return { success: false, queueId: queueItem.id, channel: 'AMAZON',
      status: 'SKIPPED', message: pushRefusal.sentence, error: pushRefusal.sentence,
      errorCode: pushRefusal.code, retryable: false };

    const { product, payload, id: queueId } = queueItem;
    const sku = product?.sku ?? queueItem.externalListingId ?? "(unknown sku)";
    // P1.3 — the seller of the account this row was created for (never the default seller).
    const destination = await this.destinationOf(queueItem);
    if (!destination.connectionId) {
      const error = noDestinationSentence("Amazon", destination.reason);
      return { success: false, queueId, channel: "AMAZON", status: "FAILED", message: error, error, errorCode: "NO_DESTINATION_ACCOUNT", retryable: false };
    }
    const sellerId =
      (await getAmazonSellerId(destination.connectionId));

    // A4.0 — resolve the Amazon product type (required by the Listings PATCH) and
    // build the CORRECT patch body (schema attribute names + value shapes),
    // replacing the malformed constructAmazonPayload.
    let productType = String((payload as any).productType ?? '').toUpperCase();
    // B2 — load the listing ONCE for both productType and fulfillment method.
    let cl: any = null;
    if (queueItem.channelListingId) {
      cl = await prisma.channelListing
        .findUnique({
          where: { id: queueItem.channelListingId },
          select: { platformAttributes: true, fulfillmentMethod: true, quantity: true, stockBuffer: true, marketplace: true, syncPaused: true, offerClosedAt: true, salePrice: true, sourceLocationCodes: true },
        })
        .catch(() => null);
    }
    // 🔴 A-24 (R-20) — the row's own LISTING decides the market. This was
    // `payload.marketplaceId ?? AMAZON_DEFAULT_MARKETPLACE ?? "IT"`: no producer but the mapping cascade
    // sets `marketplaceId`, and the variable is defined nowhere, so every other row — price, content,
    // stock — was built and submitted for ITALY. Never a default market: refuse, and say why.
    const listingMarket: string | null = cl?.marketplace ?? null;
    const requestedMarket: string | null = payload?.marketplaceId ?? null;
    const marketplaceId: string = listingMarket ?? requestedMarket ?? "";
    const marketRefusal = !marketplaceId
      ? "This row names no Amazon market and has no listing to take one from, so nothing was sent."
      : !amazonMarketplaceIdOrNull(marketplaceId)
        ? `Amazon · ${marketplaceId} has no marketplace id in the push, so nothing was sent.`
        : listingMarket && requestedMarket && amazonMarketplaceIdOrNull(requestedMarket) !== amazonMarketplaceIdOrNull(listingMarket)
          ? `This row asks for ${requestedMarket}, but its listing is on ${listingMarket}, so nothing was sent.`
          : null;
    if (marketRefusal) return { success: false, queueId, channel: "AMAZON", status: "FAILED", message: marketRefusal, error: marketRefusal, errorCode: "AMAZON_MARKET_UNRESOLVED", retryable: false };
    // MX.1 (D-MX4) — a PRICE push that carries no sale (a legacy producer) takes the listing's STORED sale + window, so
    // `buildAmazonListingPatch`'s `op:replace` on purchasable_offer re-emits it instead of wiping it (report 19 §5.9).
    if (payload.price !== undefined && payload.salePrice === undefined && cl && queueItem.channelListingId && cl.salePrice != null) {
      try {
        const window = (await readSaleWindows(prisma as never, [queueItem.channelListingId])).get(queueItem.channelListingId);
        if (window?.start && window?.end) { payload.salePrice = Number(cl.salePrice); payload.salePriceStart = window.start; payload.salePriceEnd = window.end; }
      } catch { /* a database without the window columns pushes the price alone — the sale cannot be scheduled there */ }
    }
    try {
      const scp = policyFor(await loadChannelPolicies(), 'AMAZON', cl?.marketplace ?? marketplaceId, destination.connectionId);
      if (scp?.pushesPaused) {
        return { success: false, queueId, channel: "AMAZON", status: "SKIPPED", message: "Channel-market pushes PAUSED (Sync Control policy)", error: "sync-paused-policy" };
      }
    } catch { /* fail-open: policy unreadable = not paused */ }
    if (!productType) productType = String((cl?.platformAttributes as any)?.productType ?? '').toUpperCase();
    if (!productType) productType = String((product as any)?.productType ?? '').toUpperCase();

    // B2 / FBA-flip fix — FBA SKUs must not receive a merchant quantity push (it
    // flips the offer to FBM). The listing's own fulfillmentMethod marker proved
    // unreliable (stale 'FBM' on real FBA listings), so for a quantity push we also
    // resolve positive FBA evidence — FBA stock on hand + an active FBA offer — and
    // fail closed. buildAmazonListingPatch then drops the qty attribute for FBA.
    let fbaStockQty: number | null = null;
    let hasActiveFbaOffer = false;
    if (payload.quantity !== undefined && product?.id) {
      const [fbaAgg, fbaOffer] = await Promise.all([
        prisma.stockLevel
          .aggregate({
            where: { productId: product.id, location: { code: "AMAZON-EU-FBA" } },
            _sum: { quantity: true },
          })
          .catch(() => null),
        queueItem.channelListingId
          ? prisma.offer
              .findFirst({
                where: { channelListingId: queueItem.channelListingId, fulfillmentMethod: "FBA", isActive: true },
                select: { id: true },
              })
              .catch(() => null)
          : Promise.resolve(null),
      ]);
      fbaStockQty = fbaAgg?._sum.quantity ?? null;
      hasActiveFbaOffer = !!fbaOffer;
    }
    const isFba = isFbaListing(cl, product, { fbaStockQty, hasActiveFbaOffer });
    // P1 — push the CURRENT listing quantity (the latest committed value), not
    // the stale enqueue-time snapshot. FBA listings still drop the qty patch
    // below regardless of value. Kill-switch: NEXUS_SYNC_ORDERING_V2=0.
    if (process.env.NEXUS_SYNC_ORDERING_V2 !== '0' && cl && payload.quantity !== undefined) {
      payload.quantity = resolveDispatchQuantity(cl.quantity, payload.quantity);
    }
    // P2 — hard oversell guard for Amazon-FBM. FBA is never clamped (Amazon
    // owns the qty; buildAmazonListingPatch drops the patch for FBA anyway).
    // Kill-switch: NEXUS_OVERSELL_CLAMP=0.
    if (
      process.env.NEXUS_OVERSELL_CLAMP !== '0' &&
      !isFba &&
      payload.quantity !== undefined &&
      product?.id
    ) {
      // P4.3d — shared stock AND routing: the limit is what the ledger the product
      // follows holds IN THE LOCATIONS ROUTED TO THIS MARKET, minus the listing's
      // buffer. Same filter as the intended quantity, so the promise and its cap
      // cannot be computed two ways.
      const ceiling = await this.routedCeiling({
        productId: product.id,
        channel: 'AMAZON',
        channelLabel: 'Amazon',
        marketplace: String(cl?.marketplace ?? marketplaceId),
        sourceLocationCodes: (cl?.sourceLocationCodes as string[] | undefined) ?? [],
        stockBuffer: cl?.stockBuffer ?? 0,
      })
      // Nothing routed here and the ledger does not treat uncounted as zero (a
      // pooled product): we do not know the ceiling, so we do not cap to 0 and
      // send it — that is the scoped Zero. Refuse, as the EU guard does (D9).
      if (ceiling.refusal) {
        return { success: false, queueId, channel: "AMAZON", status: "FAILED", message: ceiling.refusal, error: ceiling.refusal, errorCode: "NO_ROUTED_LOCATION", retryable: false }
      }
      const available = ceiling.available
      const requested = payload.quantity
      const { quantity, clamped } = applyOversellClamp(requested, available)
      if (clamped) {
        payload.quantity = quantity
        try {
          publishOrderEvent({
            type: 'sync.oversell.clamped',
            sku,
            channel: 'AMAZON',
            marketplace: marketplaceId,
            requested,
            clampedTo: quantity,
            available,
            ts: Date.now(),
          })
        } catch { /* observability must never break the sync */ }
      }
    }
    // SCT.4 — Amazon EU SHARED-QUANTITY belt (kill-switch: NEXUS_EU_SHARED_QTY_GUARD=0).
    // Amazon keeps ONE merchant quantity per SKU across EU marketplaces (proved
    // 2026-07-26: 302 market-scoped Zero&Pins blanked the whole IT storefront).
    // If this SKU's sibling EU rows disagree on the shared number, pushing ANY
    // side would silently overwrite the other market's intent — refuse, log a
    // conflict, and let the operator align the modes instead.
    if (
      process.env.NEXUS_EU_SHARED_QTY_GUARD !== '0' &&
      !isFba &&
      payload.quantity !== undefined &&
      product?.id &&
      AMAZON_EU_SHARED_MARKETS.has(String(cl?.marketplace ?? '').toUpperCase())
    ) {
      try {
        const siblings = await prisma.channelListing.findMany({
          where: {
            productId: product.id,
            channel: 'AMAZON',
            isPublished: true,
            listingStatus: { notIn: ['ENDED', 'REMOVED'] },
          },
          select: {
            marketplace: true, followMasterQuantity: true, quantityOverride: true,
            quantity: true, syncPaused: true, fulfillmentMethod: true,
          },
        })
        const euRows = siblings.map((sib) => ({
          marketplace: sib.marketplace,
          followMasterQuantity: sib.followMasterQuantity,
          quantityOverride: sib.quantityOverride,
          quantity: sib.quantity,
          syncPaused: sib.syncPaused,
          isFba: sib.fulfillmentMethod === 'FBA',
        }))
        const verdict = detectEuIntentConflict(euRows)
        if (verdict.conflict) {
          const message = `EU shared-quantity conflict for ${sku}: ${verdict.detail}. Push refused so no market's intent is silently overwritten. ${EU_GUARD_REMEDY}`
          try {
            const { syncHealthService } = await import('./sync-health.service.js')
            await syncHealthService.logConflict({
              channel: 'AMAZON',
              conflictType: 'EU_SHARED_QTY_CONFLICT',
              message,
              productId: product.id,
              localData: { rows: euRows },
              remoteData: { attemptedQuantity: payload.quantity, marketplace: cl?.marketplace ?? marketplaceId },
            })
          } catch { /* observability best-effort */ }
          return { success: false, queueId, channel: "AMAZON", status: "SKIPPED", message, error: "eu-shared-qty-conflict" };
        }
      } catch (guardErr) {
        // P4.3b / D9 — FAIL CLOSED. This used to say "Guard infrastructure
        // failing must not stop legitimate pushes" and allow the send. The Owner
        // ruled the other way in decision D9: *hold the push and alert — a wrong
        // EU quantity is worse than a short delay.*
        //
        // The reason the ruling is right: Amazon holds ONE merchant quantity per
        // SKU across the EU markets. If the guard cannot run, we do not know
        // whether this push fights a sibling market's intent — and the incident
        // this guard exists for is a scoped Zero that blanked an entire
        // storefront. "We could not check" is not "there is no conflict".
        //
        // A retry is cheap: the row stays queued and the next attempt runs the
        // guard again. Sending blind is not reversible.
        const detail = guardErr instanceof Error ? guardErr.message : String(guardErr)
        const message = `EU shared-quantity guard could not run for ${sku} (${detail}). Push held rather than sent blind: Amazon holds one EU quantity per SKU, so an unchecked push can overwrite another market's intent. It will be retried. ${EU_GUARD_REMEDY}`
        logger.warn('[outbound-sync] EU shared-qty guard check failed (push HELD)', { sku, error: detail })
        try {
          const { syncHealthService } = await import('./sync-health.service.js')
          await syncHealthService.logConflict({
            channel: 'AMAZON',
            // Its own type: "the guard could not run" is a different fact from
            // "the guard found a conflict", and an operator must be able to tell
            // them apart on the screen.
            conflictType: 'EU_SHARED_QTY_GUARD_UNAVAILABLE',
            message,
            productId: product.id,
            localData: { guardError: detail },
            remoteData: { attemptedQuantity: payload.quantity, marketplace: cl?.marketplace ?? marketplaceId },
          })
        } catch { /* observability best-effort — it must not decide the push */ }
        return { success: false, queueId, channel: "AMAZON", status: "SKIPPED", message, error: "eu-shared-qty-guard-unavailable" };
      }
    }
    const hasContent = payload.title !== undefined || payload.description !== undefined || payload.bulletPoints !== undefined || payload.keywords !== undefined;
    let content: Omit<AmazonContentInput, 'marketplace' | 'marketplaceId'> | undefined;
    if (hasContent) {
      const owner = await prisma.product.findUniqueOrThrow({ where: { id: product.id }, include: { translations: true, parent: { include: { translations: true } } } });
      const listing = queueItem.channelListingId
        ? await prisma.channelListing.findUniqueOrThrow({ where: { id: queueItem.channelListingId }, include: { translations: true } }) : null;
      if (!listing) throw new Error('Content sync needs an exact listing coordinate before publishing.');
      content = { product: owner as any, parent: owner.parent as any, listing,
        fields: ['title', 'description', 'bulletPoints', 'keywords'].filter(field => payload[field] !== undefined) };
    }
    // P4.4c — the operator's own pricing floor and ceiling (Product.minPrice /
    // maxPrice). Placed HERE, beside the quantity guards and AFTER the push lock
    // and the pause checks, so a paused or locked listing still reports that
    // rather than a price complaint. It REFUSES rather than clamping: a price is
    // a number a person typed, and sending a different one quietly is worse than
    // not sending it.
    {
      // Only a price in the master currency is held to the master-currency floor and ceiling (refuse, don't convert).
      const refusal = await priceRefusalFor({ price: payload.price, productId: product?.id, channel: 'Amazon', sku, market: { channel: 'AMAZON', marketplace: cl?.marketplace ?? marketplaceId } });
      if (refusal) return { success: false, queueId, channel: "AMAZON", status: "FAILED", message: refusal, error: refusal, errorCode: "PRICE_OUT_OF_BOUNDS", retryable: false };
    }
    const amazonPayload = await buildAmazonListingPatch(payload, marketplaceId, productType, isFba ? "FBA" : "FBM", content);

    // B2 — an FBA quantity-only update yields zero patches (we never touch Amazon's
    // FBA stock). Don't submit an empty patch — return a terminal, no-retry skip.
    if (!Array.isArray(amazonPayload.patches) || amazonPayload.patches.length === 0) {
      return {
        success: true,
        queueId,
        channel: "AMAZON",
        status: "SKIPPED",
        errorCode: 'AMAZON_EMPTY_PATCH_NOT_SENT',
        retryable: false,
        message: isFba
          ? "Amazon manages the FBA quantity. Nothing was sent to the channel."
          : DELIST_OPERATOR_COPY.AMAZON_EMPTY_PATCH_NOT_SENT,
      };
    }

    // With NEXUS_AMAZON_OFFER_MERGE=1 (amazon/purchasable-offer.ts — OFF by default, and OFF is exactly what this sent
    // before), the price goes as a MERGE into the live offer instance it prices, so a price push changes our_price —
    // and the sale only as far as Nexus owns it — and leaves the rest of Amazon's offer as it is: a Seller Central sale,
    // map_price, the min/max seller-allowed prices, the offer dates, the B2B instance. The builder's replace stands only
    // for a first offer. Read INSIDE `execute` and only in live mode, i.e. only when a real write follows (gated,
    // dry-run and sandbox stay exactly as they were), right before the write; a failed read sends nothing.
    const offerPatchAt = amazonOfferMergeEnabled() && payload.price !== undefined
      ? amazonPayload.patches.findIndex((p: { op?: string; path?: string }) => p?.op === 'replace' && p?.path === '/attributes/purchasable_offer')
      : -1;
    let offerFailure: { errorCode: string; retryable: boolean } | null = null;

    // P0.7 → P1.3 — the row goes to its own account; this stays as a consistency check (the listing or
    // SKU must belong to that account), refused and terminal if not.
    if (sellerId) {
      try {
        await assertWriteAccount("AMAZON", destination.connectionId, queueItem.channelListingId ? { listingIds: [queueItem.channelListingId] } : { skus: [sku], marketplace: marketplaceId });
      } catch (err) {
        if (!isWrongAccountWriteError(err)) throw err;
        return { success: false, queueId, channel: "AMAZON", status: "FAILED", message: err.message, error: err.message, errorCode: err.code, retryable: false };
      }
    }

    // A1.3 — delegate the gate→circuit→rate-limit→dry-run→audit chain to the
    // shared ListingPublishService; inject Amazon's gate functions + the actual
    // SP-API call. (Behavior-preserving extraction of the former inline chain.)
    const r = await listingPublishService.publish({
      channel: "AMAZON",
      marketplaceId,
      sku,
      productId: product?.id ?? null,
      digest: digestPayload(amazonPayload),
      gate: {
        getMode: getAmazonPublishMode,
        checkCircuit: checkAmazonCircuit,
        acquireToken: acquireAmazonPublishToken,
        recordOutcome: recordAmazonOutcome,
      },
      resolveSeller: async () =>
        sellerId
          ? { id: sellerId }
          : { error: "AMAZON_SELLER_ID is not configured. Set the env var before enabling outbound sync." },
      execute: async ({ sellerId: sid, mode }) => {
        if (offerPatchAt >= 0 && mode === 'live') {
          const offerMarketplaceId = resolveAmazonMarketplaceId(marketplaceId);
          const live = await readAmazonOfferLive({ sellerId: sid, sku, marketplaceId: offerMarketplaceId });
          if (live.read === 'failed') {
            // Never the blind replace: without the live offer it could clear the sale and every part Nexus does not set.
            offerFailure = { errorCode: 'AMAZON_OFFER_READ_FAILED', retryable: true };
            return { ok: false, error: `${amazonOfferReadFailure(sku, live.error)} It will be retried.` };
          }
          const plan = amazonPriceOfferPlan({
            built: amazonPayload.patches[offerPatchAt].value[0],
            live: live.instances,
            marketplaceId: offerMarketplaceId,
            saleRemoved: payload.saleRemoved === true,
          });
          if (plan.kind === 'refused') {
            offerFailure = { errorCode: 'AMAZON_OFFER_NOT_MATCHED', retryable: false };
            return { ok: false, error: plan.reason };
          }
          if (plan.kind === 'merge') amazonPayload.patches[offerPatchAt] = plan.patch;
        }
        // P1.7 — Amazon's own dry run before any CONTENT write (it was run for the mapping source only).
        // A price- or stock-only patch set needs no preview; anything else does.
        if (payload.source === 'FM_CATALOG_CASCADE' || isAmazonContentPatchSet(amazonPayload.patches)) {
          const refusal = await amazonContentRefusal({ sellerId: sid, sku, marketplaceId: resolveAmazonMarketplaceId(marketplaceId), productType, patches: amazonPayload.patches });
          if (refusal) return { ok: false, error: refusal };
        }
        const res = await amazonSpApiClient.submitListingPayload({
          sellerId: sid,
          sku,
          payload: amazonPayload,
          // P0b — REQUIRED patchListingsItem query param; per-market row targets its own market.
          marketplaceId: resolveAmazonMarketplaceId(marketplaceId),
        });
        return { ok: res.success, error: res.error };
      },
    });

    return {
      success: r.success,
      queueId,
      channel: "AMAZON",
      status: r.status,
      message: r.message,
      error: r.error,
      dryRun: r.mode !== "live", // PD.3 — a non-live "success" published nothing.
      ...(offerFailure ?? {}),
    };
  }

  /**
   * Sync product to eBay using Inventory API.
   * PUT /sell/inventory/v1/inventory_item/{sku}
   *
   * C.8 — replaced the Math.random demo simulator with a real PUT
   * call gated by NEXUS_ENABLE_EBAY_PUBLISH + EBAY_PUBLISH_MODE
   * (same flags as the wizard publish path, C.7).
   */
  private async syncToEbay(queueItem: any): Promise<SyncResult> {
    const pushRefusal = (await this.pushLockListings(queueItem, 'EBAY'))
      .map(listing => assertPushAllowed(listing)).find(Boolean);
    if (pushRefusal) return { success: false, queueId: queueItem.id, channel: 'EBAY',
      status: 'SKIPPED', message: pushRefusal.sentence, error: pushRefusal.sentence,
      errorCode: pushRefusal.code, retryable: false };

    // Phase 3 — shared-SKU Trading-API quantity fan-out. These rows have no
    // ChannelListing and must use ReviseInventoryStatus (multi-listing shared
    // SKU), NOT the Inventory-API GET-merge-PUT path below.
    if (queueItem?.payload?.pushVia === 'TRADING') {
      return this.syncSharedTradingQuantity(queueItem);
    }

    const { product, payload, id: queueId } = queueItem;
    const sku = product?.sku ?? queueItem.externalListingId ?? "(unknown sku)";

    // FCF.2 / 1.4 — defensive pool cap (defence-in-depth). The cascade now
    // queues reserved-adjusted available, but a stale/pre-fix or manually
    // inserted queue row could carry a quantity above what the warehouse can
    // ship. Clamp FBM eBay quantity to the own-warehouse pool (available −
    // buffer) so the auto-sync path can never oversell — same pool maths as the
    // flat-file manual push (capToFbm). Only triggers on overshoot; FBA-backed
    // (MCF) eBay listings draw the Amazon pool, so they're left to the MCF path.
    // MX.1 / Add 4(c) — the pause gates run for EVERY payload, BEFORE the quantity branch. They sat inside
    // `if (payload.quantity !== undefined …)`, so a content FULL_SYNC (no quantity) on a PAUSED eBay listing passed
    // both gates and reached the mode gate (report 28 §5.2) — the Amazon lane checks all of its gates unconditionally
    // and is the shape this now mirrors. Pinned by `outbound-sync.ebay-pause-gate.vitest.test.ts`.
    const cl = queueItem.channelListingId
      ? await prisma.channelListing
          .findUnique({
            where: { id: queueItem.channelListingId },
            select: { stockBuffer: true, fulfillmentMethod: true, quantity: true, marketplace: true, syncPaused: true, sourceLocationCodes: true, channelConnectionId: true },
          })
          .catch(() => null)
      : null;
    // CX (review 2026-09-26) — ONE market per row, resolved once. eBay's Inventory API offers a SKU on one
    // marketplace ("the same SKU value can not be offered across multiple eBay marketplaces" — getOffers), so the
    // row's quantity, content and price all go to the same market. This defaulted to EBAY_IT, so a DE listing's
    // quantity went to EBAY_IT beside a price sent to EBAY_DE. As on Amazon (A-24): the row's own LISTING decides;
    // a row without one uses the market it names; a row that names another market than its listing, or none at
    // all, is refused — nothing sent, the reason on the row.
    const listingMarket = ebayMarketplaceIdOf((cl as { marketplace?: string } | null)?.marketplace);
    const requestedMarkets = [payload?.marketplaceId, payload?.marketplace].map((m) => ebayMarketplaceIdOf(m)).filter((m): m is string => !!m);
    const marketplaceId = listingMarket ?? requestedMarkets[0] ?? null;
    const conflicting = requestedMarkets.find((m) => m !== marketplaceId);
    const marketRefusal = !marketplaceId
      ? "This eBay row names no eBay market and has no listing to take one from, so nothing was sent."
      : conflicting
        ? (listingMarket
          ? `This eBay row asks for ${conflicting}, but its listing is on ${marketplaceId}, so nothing was sent.`
          : `This eBay row names two markets (${marketplaceId} and ${conflicting}), so nothing was sent.`)
        : null;
    if (marketRefusal || !marketplaceId) {
      const refusal = marketRefusal ?? "This eBay row names no eBay market, so nothing was sent.";
      return { success: false, queueId, channel: "EBAY", status: "FAILED", message: refusal, error: refusal, errorCode: "EBAY_MARKET_UNRESOLVED", retryable: false };
    }
    // SC.1 — pause guard (listing + channel-market policy), re-checked at
    // dispatch time like the Amazon lane.
    try {
      const scp = policyFor(await loadChannelPolicies(), 'EBAY', (cl as { marketplace?: string } | null)?.marketplace ?? marketplaceId, queueItem.channelConnectionId ?? cl?.channelConnectionId ?? null);
      if (scp?.pushesPaused) {
        return { success: false, queueId, channel: "EBAY", status: "SKIPPED", message: "Channel-market pushes PAUSED (Sync Control policy)", error: "sync-paused-policy" };
      }
    } catch { /* fail-open */ }
    if (payload.quantity !== undefined && product?.id) {
      // P1 — base the eBay push on the CURRENT listing quantity, then apply the
      // routed cap below. Kill-switch: NEXUS_SYNC_ORDERING_V2=0.
      if (process.env.NEXUS_SYNC_ORDERING_V2 !== '0' && cl && payload.quantity !== undefined) {
        payload.quantity = resolveDispatchQuantity(cl.quantity, payload.quantity);
      }
      if (cl?.fulfillmentMethod !== "FBA") {
        // P4.3d — the same routed ceiling as the Amazon lane. It used to sum every
        // warehouse row the product held, routed to this market or not.
        const ceiling = await this.routedCeiling({
          productId: product.id,
          channel: 'EBAY',
          channelLabel: 'eBay',
          marketplace: String((cl as { marketplace?: string } | null)?.marketplace ?? marketplaceId),
          sourceLocationCodes: ((cl as { sourceLocationCodes?: string[] } | null)?.sourceLocationCodes) ?? [],
          stockBuffer: cl?.stockBuffer ?? 0,
        });
        if (ceiling.refusal) {
          return { success: false, queueId, channel: "EBAY", status: "FAILED", message: ceiling.refusal, error: ceiling.refusal, errorCode: "NO_ROUTED_LOCATION", retryable: false };
        }
        const warehouseAvailable = ceiling.routedAvailable;
        const cap = ceiling.available;
        const requested = payload.quantity
        const { quantity: clampedQty, clamped } = applyOversellClamp(requested, cap)
        if (clamped) {
          console.warn(
            `[EBAY] capping ${sku} quantity ${requested} -> ${clampedQty} (warehouse available ${warehouseAvailable}, buffer ${cl?.stockBuffer ?? 0})`,
          );
          payload.quantity = clampedQty;
          try {
            publishOrderEvent({
              type: 'sync.oversell.clamped',
              sku,
              channel: 'EBAY',
              marketplace: marketplaceId,
              requested,
              clampedTo: clampedQty,
              available: cap,
              ts: Date.now(),
            })
          } catch { /* observability must never break the sync */ }
        }
      }
    }

    // P4.4c — the operator's own pricing floor and ceiling (Product.minPrice /
    // maxPrice). Placed HERE, beside the quantity guards and AFTER the push lock
    // and the pause checks, so a paused or locked listing still reports that
    // rather than a price complaint. It REFUSES rather than clamping: a price is
    // a number a person typed, and sending a different one quietly is worse than
    // not sending it.
    {
      // Only a price in the master currency is held to the master-currency floor and ceiling (refuse, don't convert).
      const refusal = await priceRefusalFor({ price: payload.price, productId: product?.id, channel: 'eBay', sku, market: { channel: 'EBAY', marketplace: marketplaceId } });
      if (refusal) return { success: false, queueId, channel: "EBAY", status: "FAILED", message: refusal, error: refusal, errorCode: "PRICE_OUT_OF_BOUNDS", retryable: false };
    }
    const digest = digestPayload({
      price: payload.price,
      quantity: payload.quantity,
      content: !!(payload.title || payload.description || (payload.images && payload.images.length > 0)),
    });

    const fail = (
      outcome: "gated" | "rate-limited" | "circuit-open" | "failed" | "timeout",
      mode: "gated" | "dry-run" | "sandbox" | "live",
      sellerId: string,
      message: string,
      durationMs?: number,
    ): SyncResult => {
      writeAttemptLog({
        channel: "EBAY",
        marketplace: marketplaceId,
        sellerId,
        sku,
        productId: product?.id ?? null,
        mode,
        outcome,
        payloadDigest: digest,
        errorMessage: message,
        durationMs: durationMs ?? null,
      });
      return {
        success: false,
        queueId,
        channel: "EBAY",
        status: "FAILED",
        message: `Failed to sync to eBay`,
        error: message,
      };
    };

    // 1. Feature flag
    const mode = getEbayPublishMode();
    if (mode === "gated") {
      return fail(
        "gated",
        "gated",
        marketplaceId, // pre-connection-lookup placeholder
        "NEXUS_ENABLE_EBAY_PUBLISH=false — set true to enable eBay outbound sync.",
      );
    }

    // 2. Connection lookup (post-gate so a gated attempt is side-effect-free)
    // MAP.3 — DECLARED. 🔴 MAP.6/7: an outbound push SHOULD derive its account
    // from the listing it is pushing; that needs the product→account intent this
    // programme calls labels.
    // P1.3 — the account this row was created for (never "the primary"): the one written with the row,
    // else resolved the same way for rows from before P1.3; none → refused, terminal.
    const destination = await this.destinationOf(queueItem);
    if (!destination.connectionId) {
      return { ...fail("failed", mode, "(no-destination)", noDestinationSentence("eBay", destination.reason)), errorCode: "NO_DESTINATION_ACCOUNT", retryable: false };
    }
    const connection = await tryResolveConnection({ accountId: destination.connectionId });
    if (!connection) {
      return fail(
        "failed",
        mode,
        "(no-connection)",
        "No active eBay connection — link an eBay account in Settings first.",
      );
    }
    // P0.7 → P1.3 — the row now goes to its own account; this stays as a consistency check (the listing
    // or SKU must belong to that account), refused and terminal if not.
    try {
      await assertWriteAccount("EBAY", connection.id, queueItem.channelListingId ? { listingIds: [queueItem.channelListingId] } : { skus: [product?.sku], marketplace: marketplaceId });
    } catch (err) {
      if (!isWrongAccountWriteError(err)) throw err;
      return { ...fail("failed", mode, connection.id, err.message), errorCode: err.code, retryable: false };
    }

    // 3. Circuit breaker
    const circuit = checkEbayCircuit(connection.id, marketplaceId);
    if (!circuit.ok) {
      return fail(
        "circuit-open",
        mode,
        connection.id,
        circuit.error ?? "Circuit open",
      );
    }

    // 4. Rate limiter
    const t0 = Date.now();
    const acquired = await acquireEbayPublishToken(connection.id, marketplaceId);
    if (!acquired.ok) {
      return fail(
        "rate-limited",
        mode,
        connection.id,
        acquired.error ?? "Rate limited",
        Date.now() - t0,
      );
    }

    // 5. Dry-run short-circuit
    if (mode === "dry-run") {
      console.log(`[EBAY] Dry-run sync for ${sku}:`, { price: payload.price, quantity: payload.quantity });
      recordEbayOutcome(connection.id, marketplaceId, true);
      writeAttemptLog({
        channel: "EBAY",
        marketplace: marketplaceId,
        sellerId: connection.id,
        sku,
        productId: product?.id ?? null,
        mode: "dry-run",
        outcome: "success",
        payloadDigest: digest,
        durationMs: Date.now() - t0,
      });
      return {
        success: true,
        queueId,
        channel: "EBAY",
        status: "SUCCESS",
        message: `Product ${sku} dry-run synced to eBay`,
      };
    }

    // 6. Auth (token fetch has a side effect — lastUsedAt update — so
    // it lives after the dry-run short-circuit)
    let token: string;
    try {
      token = await ebayAuthService.getValidToken(connection.id);
    } catch (err) {
      const message = `Could not obtain eBay token: ${
        err instanceof Error ? err.message : String(err)
      }`;
      recordEbayOutcome(connection.id, marketplaceId, false);
      return fail("failed", mode, connection.id, message, Date.now() - t0);
    }

    // 7. Apply the update. Quantity/content → inventory_item (GET-merge-PUT so
    // the full-replace never wipes existing content); price → the OFFER
    // (different endpoint). Either or both may run depending on the payload.
    const apiBase = getEbayApiBaseForMode(mode);
    const headers = await ebayInventoryHeaders(token, marketplaceId);

    // Task 3: gate the new per-listing isolation behind an env flag (default ON).
    // Set NEXUS_EBAY_FAILURE_ISOLATION=0 to fall back to pre-Task-3 behavior.
    const failureIsolationEnabled = process.env.NEXUS_EBAY_FAILURE_ISOLATION !== '0';
    // B1 — the price read-back, handed to the caller to start once the row has its answer.
    let priceReadback: (() => Promise<unknown>) | undefined;
    // P4.4 (CX) — whether 7a already sent quantity/content (a later price refusal says so).
    let itemWritten = false;

    const ebayFail = (
      message: string,
      outcome: "failed" | "timeout" = "failed",
      httpStatus?: number | null,
    ): SyncResult => {
      const decision = ebayFailureDecision(httpStatus, failureIsolationEnabled);
      // Only record toward the marketplace circuit breaker when the failure is
      // transient/connection-level (EBAY_TRANSIENT). A per-listing validation
      // error (EBAY_VALIDATION) must NOT trip the whole marketplace circuit.
      if (decision.record) {
        recordEbayOutcome(connection.id, marketplaceId, false);
      }
      writeAttemptLog({
        channel: "EBAY",
        marketplace: marketplaceId,
        sellerId: connection.id,
        sku,
        productId: product?.id ?? null,
        mode,
        outcome,
        payloadDigest: digest,
        errorMessage: message.slice(0, 500),
        durationMs: Date.now() - t0,
      });
      return {
        success: false,
        queueId,
        channel: "EBAY",
        status: "FAILED",
        message: `Failed to sync to eBay`,
        error: message,
        errorCode: decision.code,
        // When isolation is ON, propagate retryable so the worker routes EBAY_VALIDATION
        // to terminal FAILED (retryable:false) instead of re-queuing forever.
        // When isolation is OFF (kill-switch), leave retryable unset to preserve
        // pre-Task-3 byte-compat (worker defaults to retryable=true).
        ...(failureIsolationEnabled ? { retryable: decision.retryable } : {}),
      };
    };

    try {
      // 7a. Quantity (+ any content) → inventory_item.
      const touchesItem =
        payload.quantity !== undefined || !!payload.mappingAspects ||
        !!payload.title ||
        !!payload.description ||
        !!(payload.images && payload.images.length > 0);
      // ── THE IMAGE REVERTER, FOUND 2026-07-26 ─────────────────────────────
      // A QUANTITY-ONLY sync used GET-merge-PUT: it round-tripped the ENTIRE
      // inventory_item through eBay's EVENTUALLY-CONSISTENT read to change one
      // number. When it ran seconds after an image publish (which it always
      // did — the publish itself triggers the stock fan-out), the GET returned
      // the PRE-publish item (old Amazon-CDN images) and the PUT wrote that
      // stale snapshot back, silently reinstating the old images. Every image
      // publish scheduled its own destruction; the operator watched curated
      // photos "revert" within minutes, with zero errors anywhere.
      //
      // Quantity-only updates now use eBay's DEDICATED endpoint,
      // bulk_update_price_quantity: it changes quantity (and the offer floor)
      // WITHOUT replacing the item — no GET, no merge, no stale replay. A
      // quantity sync is now STRUCTURALLY INCAPABLE of touching images. The
      // offer's availableQuantity rides the same call, which retires the 25004
      // parked-offer deadlock for this path too.
      const contentTouched =
        !!payload.mappingAspects || !!payload.title || !!payload.description || !!(payload.images && payload.images.length > 0);
      if (payload.quantity !== undefined && !contentTouched) {
        // Offer id (read of the OFFER, never the item — zero image risk). CX — the FIXED_PRICE offer of this market;
        // none or several → item-level quantity only (the auction offer eBay may list first is never raised).
        let offerId: string | null = null;
        try {
          const bySku = await ebaySend(connection.id,
            `${apiBase}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${marketplaceId}`,
            { headers },
          );
          if (bySku.ok) offerId = ebayFixedPriceOfferOf(((await bySku.json().catch(() => ({}))) as { offers?: unknown }).offers, marketplaceId)?.offerId ?? null;
        } catch { /* unpublished listing — item-level quantity alone is fine */ }
        const bulkBody = {
          requests: [{
            sku,
            shipToLocationAvailability: { quantity: payload.quantity },
            ...(offerId ? { offers: [{ offerId, availableQuantity: payload.quantity }] } : {}),
          }],
        };
        const bulkRes = await ebaySend(connection.id, `${apiBase}/sell/inventory/v1/bulk_update_price_quantity`, {
          method: "POST", headers, body: JSON.stringify(bulkBody),
        });
        const bulkJson = bulkRes.ok
          ? ((await bulkRes.json().catch(() => ({}))) as { responses?: Array<{ statusCode?: number; errors?: Array<{ message?: string }> }> })
          : null;
        const rowStatus = bulkJson?.responses?.[0]?.statusCode ?? (bulkRes.ok ? 200 : bulkRes.status);
        if (!bulkRes.ok || rowStatus >= 300) {
          const detail = bulkJson?.responses?.[0]?.errors?.map((e) => e.message).join(" | ")
            ?? (await bulkRes.text().catch(() => "")).slice(0, 300);
          return ebayFail(`bulk_update_price_quantity ${rowStatus}: ${detail}`, "failed", rowStatus);
        }
        itemWritten = true;
        // fall through to 7b (price/offer handling) below — item untouched.
      } else if (touchesItem) {
        const itemUrl = `${apiBase}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
        let existing: Record<string, any> = {};
        const getRes = await ebaySend(connection.id, itemUrl, { method: "GET", headers });
        if (getRes.ok) existing = (await getRes.json().catch(() => ({}))) as Record<string, any>;
        // WIPE GUARD: createOrReplace REPLACES the whole item. If the GET
        // failed (rate-limit, blip) `existing` is {}, and a content PUT built
        // from it would DELETE the listing's product data (images included).
        // Never write a full replacement assembled from an empty read.
        if (!existing.product && !(payload.title && payload.description)) {
          return ebayFail(
            `inventory_item GET ${getRes.status} — refusing content PUT built from an empty read (would wipe product data)`,
            "failed", getRes.status,
          );
        }
        const itemBodyJson = JSON.stringify(mergeEbayInventoryItem(existing, payload));
        const putRes = await ebaySend(connection.id, itemUrl, { method: "PUT", headers, body: itemBodyJson });
        if (!(putRes.ok || putRes.status === 204)) {
          const errBody = (await putRes.text().catch(() => "")).slice(0, 500);
          // RT.4 — 25004 self-heal, ported from the manual flat-file push
          // (ebay-variation-push.service.ts): eBay computes live qty as
          // min(inventory_item.quantity, offer.availableQuantity); a PUBLISHED
          // offer parked at availableQuantity:0 floors that min and rejects our
          // quantity>0 PUT with 25004 — a deadlock, since the offer update
          // that would raise it only runs on price changes. Break it: raise
          // the existing offer to the SAME dispatch quantity (pool-capped
          // upstream — never more than available) and retry the PUT once.
          if (errBody.includes('"errorId":25004') && payload.quantity !== undefined) {
            try {
              const bySku = await ebaySend(connection.id,
                `${apiBase}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${marketplaceId}`,
                { headers },
              );
              // CX — the parked FIXED_PRICE offer of this market, never `offers[0]` (possibly the auction).
              const offerId = bySku.ok
                ? ebayFixedPriceOfferOf(((await bySku.json().catch(() => ({}))) as { offers?: unknown }).offers, marketplaceId)?.offerId ?? null
                : null;
              if (offerId) {
                const getFull = await ebaySend(connection.id, `${apiBase}/sell/inventory/v1/offer/${offerId}`, { headers });
                if (getFull.ok) {
                  const fullOffer = (await getFull.json().catch(() => ({}))) as Record<string, unknown>;
                  const raised = await ebaySend(connection.id, `${apiBase}/sell/inventory/v1/offer/${offerId}`, {
                    method: "PUT",
                    headers,
                    body: JSON.stringify({ ...fullOffer, availableQuantity: payload.quantity }),
                  });
                  if (raised.ok || raised.status === 204) {
                    const retryItem = await ebaySend(connection.id, itemUrl, { method: "PUT", headers, body: itemBodyJson });
                    if (retryItem.ok || retryItem.status === 204) {
                      logger.info("syncToEbay: recovered from 25004 — raised parked offer + retried", {
                        sku, offerId, quantity: payload.quantity,
                      });
                    } else {
                      return ebayFail(`inventory_item PUT retry after 25004 heal ${retryItem.status}: ${(await retryItem.text().catch(() => "")).slice(0, 300)}`, "failed", retryItem.status);
                    }
                  } else {
                    return ebayFail(`25004 heal offer PUT ${raised.status}: ${(await raised.text().catch(() => "")).slice(0, 300)}`, "failed", raised.status);
                  }
                } else {
                  return ebayFail(`inventory_item PUT ${putRes.status} (25004; offer GET ${getFull.status} blocked heal): ${errBody.slice(0, 200)}`, "failed", putRes.status);
                }
              } else {
                return ebayFail(`inventory_item PUT ${putRes.status}: ${errBody.slice(0, 300)}`, "failed", putRes.status);
              }
            } catch (healErr) {
              return ebayFail(`inventory_item PUT ${putRes.status} (25004 heal threw: ${healErr instanceof Error ? healErr.message : String(healErr)})`, "failed", putRes.status);
            }
          } else {
            return ebayFail(`inventory_item PUT ${putRes.status}: ${errBody.slice(0, 300)}`, "failed", putRes.status);
          }
        }
        itemWritten = true;
      }

      // 7b. Price → the FIXED_PRICE offer of this row's market, priced in that market's currency, then a read-back.
      if (payload.price !== undefined) {
        // A refusal names what it did NOT send, and what 7a already did.
        const sentNote = () => (itemWritten ? " The quantity/content in this row were already sent." : "");
        const priceFail = (message: string, httpStatus?: number | null) => ebayFail(`${message}${sentNote()}`, "failed", httpStatus);
        // Resolved here, not for every row: a quantity row on a market with no configured currency still goes out.
        let priceCurrency: string;
        try {
          priceCurrency = await ebayCurrencyForMarket(marketplaceId);
        } catch (err) {
          return priceFail(`${err instanceof Error ? err.message : String(err)} The price was not written.`, 400);
        }
        // Stays AFTER 7a on purpose: 7a can raise the offer's availableQuantity (bulk update, 25004
        // heal), and the PUT below sends the whole offer — read earlier, it would put the old one back.
        const offersRes = await ebaySend(connection.id,
          `${apiBase}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${encodeURIComponent(marketplaceId)}`,
          { method: "GET", headers },
        );
        if (!offersRes.ok) {
          return priceFail(`get offers ${offersRes.status}: ${(await offersRes.text().catch(() => "")).slice(0, 300)} The price was not written.`, offersRes.status);
        }
        const offersData = (await offersRes.json().catch(() => ({}))) as { offers?: unknown };
        // Exactly one FIXED_PRICE offer of this marketplace; none or several → refused before the PUT
        // (404 / 409 → EBAY_VALIDATION: terminal, does not trip the marketplace circuit).
        const pick = pickEbayPriceOffer(offersData.offers, marketplaceId, sku);
        if (!pick.offer) return priceFail(pick.reason, pick.status);
        const offerId = String(pick.offer.offerId);
        const offerUrl = `${apiBase}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
        const offerRes = await ebaySend(connection.id, offerUrl, {
          method: "PUT",
          headers,
          body: JSON.stringify(buildEbayOfferUpdate(pick.offer, payload.price, priceCurrency)),
        });
        if (!offerRes.ok) {
          return priceFail(`offer PUT ${offerRes.status}: ${(await offerRes.text().catch(() => "")).slice(0, 300)}`, offerRes.status);
        }
        // The write happened (200 or 204). B1 reads the offer back ONCE — but only AFTER the row has its answer
        // (`afterAnswer`, started by the completion writer): a read inside the dispatch budget could hold the row
        // past its timer, which resets it and sends the PUT again. Report-only: the row stays SUCCESS whatever it
        // finds, and nothing is re-sent — an automatic price correction is a money write the Owner has not ruled on.
        const expected = { price: Number(payload.price), currency: priceCurrency };
        const previous = offerPriceOf(pick.offer);
        priceReadback = () => confirmEbayOfferPrice({ connectionId: connection.id, offerUrl, headers, expected, previous,
          sku, marketplaceId, offerId, productId: product?.id ?? null, queueId });
      }
    } catch (err) {
      // Once 7a has written, a throw can only come from the price step.
      const note = itemWritten && payload.price !== undefined ? " The quantity/content in this row were already sent." : "";
      return ebayFail(`${err instanceof Error ? err.message : String(err)}${note}`, "timeout");
    }

    recordEbayOutcome(connection.id, marketplaceId, true);
    writeAttemptLog({
      channel: "EBAY",
      marketplace: marketplaceId,
      sellerId: connection.id,
      sku,
      productId: product?.id ?? null,
      mode,
      outcome: "success",
      payloadDigest: digest,
      durationMs: Date.now() - t0,
    });
    return {
      success: true,
      queueId,
      channel: "EBAY",
      status: "SUCCESS",
      message: `Product ${sku} synced to eBay`,
      ...(priceReadback ? { afterAnswer: priceReadback } : {}),
    };
  }

  /**
   * Phase 3 — shared-SKU quantity fan-out via Trading API ReviseInventoryStatus.
   * These OutboundSyncQueue rows carry payload.pushVia:'TRADING' and have no
   * ChannelListing; the SKU lives in MANY listings (one membership per ItemID),
   * which the multi-variation shared listing model needs (the Inventory API
   * forces unique SKUs and can't address a shared SKU). Reuses the eBay gate +
   * connection + circuit + rate-limit + dry-run scaffolding from syncToEbay.
   */
  private async syncSharedTradingQuantity(queueItem: any): Promise<SyncResult> {
    const pushRefusal = (await this.pushLockListings(queueItem, 'EBAY'))
      .map(listing => assertPushAllowed(listing)).find(Boolean);
    if (pushRefusal) return { success: false, queueId: queueItem.id, channel: 'EBAY',
      status: 'SKIPPED', message: pushRefusal.sentence, error: pushRefusal.sentence,
      errorCode: pushRefusal.code, retryable: false };

    const { payload, id: queueId } = queueItem;
    const itemId: string = payload?.itemId ?? queueItem.externalListingId ?? "";
    const market: string = payload?.market ?? "IT";
    const marketplaceId: string = payload?.marketplaceId ?? `EBAY_${market}`;

    // RT.2 — batched payloads carry ALL changed SKUs for the item in
    // `updates[]`; legacy rows (pre-deploy PENDING) carry a single
    // sku/quantity pair. Normalize both to one updates list.
    const updates: Array<{ sku: string; quantity: number }> = Array.isArray(payload?.updates)
      ? payload.updates
          .map((u: { sku?: unknown; quantity?: unknown }) => ({
            sku: String(u.sku ?? ""),
            quantity: Math.max(0, Math.trunc(Number(u.quantity ?? 0))),
          }))
          .filter((u: { sku: string }) => u.sku.length > 0)
      : [{
          sku: String(payload?.sku ?? "(unknown sku)"),
          quantity: Math.max(0, Math.trunc(Number(payload?.quantity ?? 0))),
        }];
    const sku: string = updates[0]?.sku ?? "(unknown sku)";
    const digest = digestPayload({ updates });

    const writeMembership = async (data: Record<string, unknown>, skuScope?: string) => {
      try {
        await prisma.sharedListingMembership.updateMany({
          where: skuScope
            ? { marketplace: market, itemId, sku: skuScope }
            : { marketplace: market, itemId, sku: { in: updates.map((u) => u.sku) } },
          data,
        });
      } catch { /* writeback is best-effort */ }
    };

    // RT.4 — re-read the pool at dispatch. The row's quantities were computed
    // at enqueue; the pool may have moved since (order mid-flight, superseded
    // row that outran coalescing). Recompute available−buffer NOW, and drop
    // SKUs already sitting at that value — a fully-no-op row returns success
    // WITHOUT spending a revise against the item's ~250/day budget.
    if (process.env.NEXUS_SYNC_ORDERING_V2 !== "0" && payload?.productId) {
      try {
        // SC.1 — per-membership derivation at dispatch: routing + followPool
        // + per-membership buffer + channel policy. PAUSED/UNCOUNTED members
        // are dropped here exactly like at enqueue (controls can change
        // between the two — dispatch re-checks, never trusts the row).
        // Shared stock — the ledger comes from loadSyncLedgers, as at enqueue: a pooled product is
        // re-read from the pool, never from this business's own rows.
        const productLedger = (await loadSyncLedgers(prisma, [payload.productId])).get(payload.productId);
        const scLedger = ledgerInputs(productLedger).ledger;
        const scPolicies = await loadChannelPolicies();
        const mems = await prisma.sharedListingMembership.findMany({
          where: { marketplace: market, itemId, sku: { in: updates.map((u) => u.sku) } },
          select: { sku: true, lastQtyPushed: true, followPool: true, stockBuffer: true, pinnedQuantity: true, channelConnectionId: true },
        });
        const memBySku = new Map(
          mems.map((m: { sku: string; lastQtyPushed: number | null; followPool?: boolean; stockBuffer?: number; pinnedQuantity?: number | null; channelConnectionId?: string | null }) => [m.sku, m]),
        );
        const effective: typeof updates = [];
        for (const u of updates) {
          const m = memBySku.get(u.sku);
          const r = resolveMembershipIntended({
            marketplace: market,
            followPool: m?.followPool ?? true,
            pinnedQuantity: m?.pinnedQuantity ?? null,
            stockBuffer: m?.stockBuffer ?? 0,
            channelPolicy: policyFor(scPolicies, 'EBAY', market, m?.channelConnectionId ?? queueItem.channelConnectionId ?? null),
            ledger: scLedger,
            uncountedIsZero: productLedger?.uncountedIsZero ?? false,
          });
          // Follow → the pool's number; a fixed number (shared stock step 3) → exactly that number;
          // paused/uncounted member — never push.
          const wanted = r.kind === 'FOLLOW' ? r.quantity : r.kind === 'PINNED' ? r.quantity : null;
          if (wanted == null) continue;
          u.quantity = wanted;
          if (m?.lastQtyPushed !== wanted) effective.push(u);
        }
        if (effective.length === 0) {
          return {
            success: true, queueId, channel: "EBAY", status: "SUCCESS",
            message: `Shared ${itemId}: pool unchanged/controlled since last push — no revise spent`,
          };
        }
        updates.length = 0;
        updates.push(...effective);
      } catch (err) {
        // Re-read is an accuracy upgrade, not a gate — fall back to the
        // enqueue-time quantities on any read failure.
        logger.warn("syncSharedTradingQuantity: dispatch re-read failed — using enqueue-time quantities", {
          itemId, error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 1. Feature flag
    const mode = getEbayPublishMode();
    if (mode === "gated") {
      return {
        success: false, queueId, channel: "EBAY", status: "FAILED",
        message: "eBay outbound sync gated",
        error: "NEXUS_ENABLE_EBAY_PUBLISH=false — set true to enable eBay outbound sync.",
      };
    }

    // 2. P1.3 — the account this row was created for (never "the primary").
    const destination = await this.destinationOf(queueItem);
    if (!destination.connectionId) {
      const error = noDestinationSentence("eBay", destination.reason);
      return { success: false, queueId, channel: "EBAY", status: "FAILED", message: error, error, errorCode: "NO_DESTINATION_ACCOUNT", retryable: false };
    }
    const connection = await tryResolveConnection({ accountId: destination.connectionId });
    if (!connection) {
      return {
        success: false, queueId, channel: "EBAY", status: "FAILED",
        message: "No active eBay connection",
        error: "No active eBay connection — link an eBay account in Settings first.",
      };
    }
    // P0.7 — the shared listing (ItemID) must belong to the account this row is about to use.
    try {
      await assertWriteAccount("EBAY", connection.id, { itemIds: [itemId] });
    } catch (err) {
      if (!isWrongAccountWriteError(err)) throw err;
      return { success: false, queueId, channel: "EBAY", status: "FAILED", message: err.message, error: err.message, errorCode: err.code, retryable: false };
    }

    // 3. Circuit breaker
    const circuit = checkEbayCircuit(connection.id, marketplaceId);
    if (!circuit.ok) {
      return {
        success: false, queueId, channel: "EBAY", status: "FAILED",
        message: "Circuit open", error: circuit.error ?? "Circuit open",
        errorCode: "EBAY_CIRCUIT_OPEN",
      };
    }

    // 3b. RT.2 — per-item revise debounce (250/day cap defense). A row that
    // fires within the min interval of the item's last revise re-arms via the
    // deferral disposition (no retry budget consumed); coalescing usually
    // replaces it with a fresher row before it re-fires.
    if (EBAY_REVISE_MIN_INTERVAL_MS > 0) {
      const last = await prisma.sharedListingMembership.aggregate({
        where: { marketplace: market, itemId },
        _max: { lastPushedAt: true },
      });
      const lastAt = last._max.lastPushedAt?.getTime() ?? 0;
      if (lastAt && Date.now() - lastAt < EBAY_REVISE_MIN_INTERVAL_MS) {
        return {
          success: false, queueId, channel: "EBAY", status: "FAILED",
          message: "Revise debounced (item revised moments ago)",
          error: `debounced: last revise ${Math.round((Date.now() - lastAt) / 1000)}s ago (< ${Math.round(EBAY_REVISE_MIN_INTERVAL_MS / 1000)}s min interval)`,
          errorCode: "EBAY_REVISE_DEBOUNCED",
        };
      }
    }

    // 4. Rate limiter
    const t0 = Date.now();
    const acquired = await acquireEbayPublishToken(connection.id, marketplaceId);
    if (!acquired.ok) {
      return {
        success: false, queueId, channel: "EBAY", status: "FAILED",
        message: "Rate limited", error: acquired.error ?? "Rate limited",
        errorCode: "EBAY_RATE_LIMITED",
      };
    }

    // 5. Dry-run short-circuit.
    //    INTENTIONAL divergence from the Inventory-API sibling (syncToEbay):
    //    we treat `sandbox` the same as `dry-run` here because `callTradingApi`
    //    (Phase 1) has its own NEXUS_EBAY_REAL_API / EBAY_SANDBOX gate and would
    //    otherwise return a fake "DRYRUN-" success that we'd mis-mark as a real
    //    push.  Collapsing both modes here avoids that false-green.
    if (mode === "dry-run" || mode === "sandbox") {
      recordEbayOutcome(connection.id, marketplaceId, true);
      writeAttemptLog({
        channel: "EBAY", marketplace: marketplaceId, sellerId: connection.id, sku,
        productId: payload?.productId ?? null, mode, outcome: "success",
        payloadDigest: digest, durationMs: Date.now() - t0,
      });
      return {
        success: true, queueId, channel: "EBAY", status: "SUCCESS",
        message: `Shared ${sku}@${itemId} ${mode} (ReviseInventoryStatus)`, dryRun: true,
      };
    }

    // 6. Auth
    let token: string;
    try {
      token = await ebayAuthService.getValidToken(connection.id);
    } catch (err) {
      const message = `Could not obtain eBay token: ${err instanceof Error ? err.message : String(err)}`;
      recordEbayOutcome(connection.id, marketplaceId, false);
      await writeMembership({ lastError: message });
      return { success: false, queueId, channel: "EBAY", status: "FAILED", message: "eBay auth failed", error: message };
    }

    // 7. Guard: never call ReviseInventoryStatus with an empty ItemID
    if (!itemId) {
      const message = `shared Trading row missing itemId (sku ${sku})`;
      await writeMembership({ lastError: message });
      return { success: false, queueId, channel: "EBAY", status: "FAILED", message, error: message };
    }

    // 8. The Trading-API call — RT.2: ≤4 SKUs per call (each CALL counts once
    //    against the item's ~250/day revise budget), per-chunk membership
    //    writeback so a mid-loop failure only re-pushes unfinished SKUs on
    //    retry (revise is absolute-qty idempotent regardless).
    try {
      for (let i = 0; i < updates.length; i += REVISE_INVENTORY_STATUS_MAX_ENTRIES) {
        const chunk = updates.slice(i, i + REVISE_INVENTORY_STATUS_MAX_ENTRIES);
        await __ebayTrading.reviseInventoryStatusBatch(
          { itemId, entries: chunk },
          { oauthToken: token, market, connectionId: connection.id },
        );
        const dayCount = countEbayReviseCall(itemId);
        if (dayCount === EBAY_REVISE_DAILY_WARN) {
          logger.warn("syncSharedTradingQuantity: item nearing eBay's ~250 revises/day cap", {
            itemId, market, revisesToday: dayCount,
          });
        }
        for (const u of chunk) {
          await writeMembership(
            { lastQtyPushed: u.quantity, lastPushedAt: new Date(), lastError: null },
            u.sku,
          );
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // RT.0 auto-heal — the listing no longer exists on eBay (ended/expired).
      // This is a PER-LISTING terminal condition: end every membership riding
      // this ItemID so the fan-out stops producing rows for it, and do NOT
      // record a circuit outcome (a dead listing must never freeze the whole
      // marketplace lane — that was the measured 2026-07-19 incident).
      const endedCode = matchEbayEndedListingCode(message);
      if (endedCode) {
        try {
          const ended = await prisma.sharedListingMembership.updateMany({
            where: { marketplace: market, itemId, status: "ACTIVE" },
            data: {
              status: "ENDED",
              lastError: `auto-ended (eBay code ${endedCode}): ${message.slice(0, 300)}`,
            },
          });
          logger.warn("syncSharedTradingQuantity: listing ended on eBay — memberships auto-ENDED", {
            itemId, market, sku, endedCode, membershipsEnded: ended.count,
          });
        } catch (healErr) {
          logger.error("syncSharedTradingQuantity: membership auto-end failed", {
            itemId, market,
            error: healErr instanceof Error ? healErr.message : String(healErr),
          });
        }
        writeAttemptLog({
          channel: "EBAY", marketplace: marketplaceId, sellerId: connection.id, sku,
          productId: payload?.productId ?? null, mode, outcome: "failed",
          payloadDigest: digest, errorMessage: message.slice(0, 500), durationMs: Date.now() - t0,
        });
        return {
          success: false, queueId, channel: "EBAY", status: "FAILED",
          message: "eBay listing ended — memberships auto-ENDED, push permanently stopped",
          error: message,
          errorCode: "EBAY_LISTING_ENDED",
          retryable: false,
        };
      }

      recordEbayOutcome(connection.id, marketplaceId, false);
      writeAttemptLog({
        channel: "EBAY", marketplace: marketplaceId, sellerId: connection.id, sku,
        productId: payload?.productId ?? null, mode, outcome: "failed",
        payloadDigest: digest, errorMessage: message.slice(0, 500), durationMs: Date.now() - t0,
      });
      await writeMembership({ lastError: message.slice(0, 500) });
      return {
        success: false, queueId, channel: "EBAY", status: "FAILED",
        message: "Failed to sync to eBay (Trading)", error: message,
      };
    }

    // 9. Success — record outcome + log (membership writeback already done
    //    per-chunk inside the loop).
    recordEbayOutcome(connection.id, marketplaceId, true);
    writeAttemptLog({
      channel: "EBAY", marketplace: marketplaceId, sellerId: connection.id, sku,
      productId: payload?.productId ?? null, mode, outcome: "success",
      payloadDigest: digest, durationMs: Date.now() - t0,
    });
    return {
      success: true, queueId, channel: "EBAY", status: "SUCCESS",
      message: `Shared ${updates.length} SKU(s) pushed to ItemID ${itemId} (${market}) in ${Math.ceil(updates.length / REVISE_INVENTORY_STATUS_MAX_ENTRIES)} call(s)`,
    };
  }

  /**
   * Sync one queued change to Shopify. A native family goes to `syncNativeShopifyOffer`; a linked listing
   * goes to `syncShopifyLinkedListing` (P1.4: the 2026-07 GraphQL client with the row's own account).
   */
  private async syncToShopify(queueItem: any): Promise<SyncResult> {
    const pushRefusal = (await this.pushLockListings(queueItem, 'SHOPIFY'))
      .map(listing => assertPushAllowed(listing)).find(Boolean);
    if (pushRefusal) return { success: false, queueId: queueItem.id, channel: 'SHOPIFY',
      status: 'SKIPPED', message: pushRefusal.sentence, error: pushRefusal.sentence,
      errorCode: pushRefusal.code, retryable: false };

    const { product, payload, channelListing, id: queueId, syncType } = queueItem;
    const sku = product?.sku ?? queueItem.externalListingId ?? "(unknown sku)";

    // PD.4 — Shopify publish-mode gate. Shopify used to write live the instant
    // creds existed (no mode switch — accidental-live risk). Only 'live' writes;
    // anything else is a dry-run no-op (marked SKIPPED, not green SUCCESS).
    const shopifyMode = getShopifyPublishMode();
    if (shopifyMode !== "live") {
      return { success: true, queueId, channel: "SHOPIFY", status: "SKIPPED",
        message: `Shopify ${shopifyMode} — not published (set NEXUS_ENABLE_SHOPIFY_PUBLISH=true + SHOPIFY_PUBLISH_MODE=live)`,
        dryRun: true };
    }

    if ((channelListing?.platformAttributes as Record<string, unknown> | null)?.nexusFamilyId) {
      try {
        const message = await syncNativeShopifyOffer(queueItem);
        return { success: true, queueId, channel: "SHOPIFY", status: "SUCCESS", message };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, queueId, channel: "SHOPIFY", status: "FAILED", message, error: message,
          errorCode: typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : undefined };
      }
    }

    // PE P4.0 — Owner D2 (2026-09-26): content for a LINKED store product goes only through Publish, where the
    // Owner sees the exact change first. An automatic content row wrote a child row's title over the shared product.
    if (syncType === "CONTENT_UPDATE") {
      const message = "Content for a linked Shopify product is sent only through Publish (changes only). Nothing was sent.";
      return { success: true, queueId, channel: "SHOPIFY", status: "SKIPPED", message, retryable: false };
    }

    // P1.3 / P1.4 — the row's own Shopify account, on the 2026-07 GraphQL client (services/shopify/
    // listing-write.service.ts). The REST 2024-01 path with env credentials is gone: it picked "the first"
    // variant for a SKU and "the first" shop location, and wrote with a token of no named account.
    const destination = await this.destinationOf(queueItem);
    if (!destination.connectionId) {
      const error = noDestinationSentence("Shopify", destination.reason);
      return { success: false, queueId, channel: "SHOPIFY", status: "FAILED", message: error, error, errorCode: "NO_DESTINATION_ACCOUNT", retryable: false };
    }
    // The consistency check (as P0.7 for eBay / Amazon): a row may not name one shop for a listing of another.
    // Its stored ids — or its SKU — would then be looked up in the wrong shop.
    const listingAccount: string | null = channelListing?.channelConnectionId ?? null;
    if (listingAccount && listingAccount !== destination.connectionId) {
      const error = `This Shopify listing belongs to another Shopify account than the one this change was queued for. Nothing was sent.`;
      return { success: false, queueId, channel: "SHOPIFY", status: "FAILED", message: error, error, errorCode: "WRONG_ACCOUNT_WRITE", retryable: false };
    }
    const work: LinkedListingWork = {};
    if (syncType === "PRICE_UPDATE" || payload?.price != null) {
    // P4.4c — the operator's own pricing floor and ceiling (Product.minPrice /
    // maxPrice). Placed HERE, beside the quantity guards and AFTER the push lock
    // and the pause checks, so a paused or locked listing still reports that
    // rather than a price complaint. It REFUSES rather than clamping: a price is
    // a number a person typed, and sending a different one quietly is worse than
    // not sending it.
      // Only a price in the master currency is held to the master-currency floor and ceiling (refuse, don't convert).
      const refusal = await priceRefusalFor({ price: payload?.price, productId: product?.id, channel: 'Shopify', sku, market: { channel: 'SHOPIFY', marketplace: channelListing?.marketplace ?? 'GLOBAL' } });
      if (refusal) return { success: false, queueId, channel: "SHOPIFY", status: "FAILED", message: refusal, error: refusal, errorCode: "PRICE_OUT_OF_BOUNDS", retryable: false };
      work.price = payload?.price ?? null;
    } else {
      const dispatchQuantity = await this.linkedDispatchQuantity(queueItem, sku, 'SHOPIFY', 'Shopify');
      if (dispatchQuantity.refusal) {
        return { success: false, queueId, channel: "SHOPIFY", status: "FAILED", message: dispatchQuantity.refusal, error: dispatchQuantity.refusal, errorCode: "NO_ROUTED_LOCATION", retryable: false };
      }
      work.quantity = dispatchQuantity.quantity;
    }
    const t0 = Date.now();
    try {
      const message = await syncShopifyLinkedListing(queueItem, destination.connectionId, work);
      writeAttemptLog({ channel: "SHOPIFY", marketplace: "GLOBAL", sellerId: destination.connectionId, sku, productId: product?.id ?? null, mode: "live", outcome: "success", payloadDigest: digestPayload(payload), errorMessage: null, durationMs: Date.now() - t0 });
      return { success: true, queueId, channel: "SHOPIFY", status: "SUCCESS", message };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeAttemptLog({ channel: "SHOPIFY", marketplace: "GLOBAL", sellerId: destination.connectionId, sku, productId: product?.id ?? null, mode: "live", outcome: "failed", payloadDigest: digestPayload(payload), errorMessage: message.slice(0, 300), durationMs: Date.now() - t0 });
      return { success: false, queueId, channel: "SHOPIFY", status: "FAILED", message, error: message,
        errorCode: typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : undefined };
    }
  }

  /**
   * RT.4 — parity with Amazon/eBay: re-read the live committed quantity at dispatch (a stale payload from
   * a superseded-but-undelivered row must not overwrite a fresher value) and clamp to the warehouse pool
   * so Shopify can never advertise units the pool doesn't have. (Moved unchanged from the REST path.)
   */
  private async linkedDispatchQuantity(
    queueItem: any,
    sku: string,
    // P4.6e — was `shopifyDispatchQuantity`, hardcoded to SHOPIFY. The Etsy lane needs the same
    // three steps (re-read the committed quantity, apply the routed ceiling, clamp), and a second
    // copy of them is the banked "two builders drift" trap: the drift would be a silent oversell
    // on whichever channel was not updated. One builder, the channel as a parameter.
    channel: 'SHOPIFY' | 'ETSY',
    channelLabel: string,
  ): Promise<{ quantity: number; refusal: string | null }> {
    const { product, payload, channelListing } = queueItem;
    let newQty: number = payload?.quantity ?? 0;
    if (process.env.NEXUS_SYNC_ORDERING_V2 !== "0") {
      const cl = channelListing?.id
        ? await prisma.channelListing.findUnique({
            where: { id: channelListing.id },
            select: { quantity: true, stockBuffer: true, fulfillmentMethod: true, marketplace: true, sourceLocationCodes: true },
          })
        : null;
      const resolved = resolveDispatchQuantity(cl?.quantity, payload?.quantity);
      if (resolved !== undefined) newQty = resolved;
      if (
        process.env.NEXUS_OVERSELL_CLAMP !== "0" &&
        product?.id &&
        cl?.fulfillmentMethod !== "FBA"
      ) {
        // P4.3d — the same routed ceiling as the Amazon and eBay lanes. It used to
        // sum every warehouse row the product held, routed to this market or not.
        const ceiling = await this.routedCeiling({
          productId: product.id,
          channel,
          channelLabel,
          marketplace: String((cl as { marketplace?: string } | null)?.marketplace ?? 'GLOBAL'),
          sourceLocationCodes: ((cl as { sourceLocationCodes?: string[] } | null)?.sourceLocationCodes) ?? [],
          stockBuffer: cl?.stockBuffer ?? 0,
        });
        if (ceiling.refusal) return { quantity: newQty, refusal: ceiling.refusal };
        const available = ceiling.available;
        const clamp = applyOversellClamp(newQty, available);
        if (clamp.clamped) {
          try {
            publishOrderEvent({
              type: "sync.oversell.clamped",
              sku,
              channel,
              marketplace: "GLOBAL",
              requested: newQty,
              clampedTo: clamp.quantity,
              available,
              ts: Date.now(),
            } as never);
          } catch { /* observability must never break the sync */ }
          newQty = clamp.quantity;
        }
      }
    }

    return { quantity: newQty, refusal: null };
  }

  /**
   * P4.6e — the Etsy lane.
   *
   * Same order as the Shopify lane, because the order is the safety: push lock, publish mode,
   * destination account, wrong-account guard, then the change itself. What differs is Etsy's own
   * shape, and all of it lives in services/etsy/:
   *
   * - **Stock and price are one endpoint** (`PUT /listings/{id}/inventory`), and it is a full
   *   replace. `writeEtsyInventory` reads, changes only the offering named, sends, and reads back.
   * - **Content is a different body format** (form-encoded, and partial), so it is a different
   *   call rather than a field on the same one.
   * - **The listing id is Etsy's**, and the offering inside it is found by SKU.
   * - **A price** (2026-09-30, when the price door started queueing Etsy): only that offering's price changes, in
   *   the listing market's currency checked against the one Etsy states; every quantity goes back exactly as Etsy
   *   stated it in the read made just before the PUT. A price Etsy cannot hold for one SKU alone is refused.
   *
   * The quantity comes from `linkedDispatchQuantity` — the same three steps as Shopify and, through
   * `routedCeiling`, the same routed ceiling as Amazon and eBay. Etsy never gets a raw payload
   * number: P4.3a is the reason (`syncInventoryFromEtsy` wrote Etsy's quantities straight into
   * `ProductVariation.stock`, past the resolver and the pool), and the same rule binds the other way.
   */
  private async syncToEtsy(queueItem: any): Promise<SyncResult> {
    const pushRefusal = (await this.pushLockListings(queueItem, 'ETSY'))
      .map(listing => assertPushAllowed(listing)).find(Boolean);
    if (pushRefusal) return { success: false, queueId: queueItem.id, channel: 'ETSY',
      status: 'SKIPPED', message: pushRefusal.sentence, error: pushRefusal.sentence,
      errorCode: pushRefusal.code, retryable: false };

    const { product, payload, channelListing, id: queueId, syncType } = queueItem;
    const sku = channelListing?.sku ?? product?.sku ?? queueItem.externalListingId ?? "(unknown sku)";

    // P4.6a — the Etsy publish gate. The channel gateway applies it too; this reports it as a
    // SKIPPED row with the switch names rather than as a failure, which is what the Shopify lane
    // does and what an operator reading the queue needs.
    const etsyMode = getEtsyPublishMode();
    if (etsyMode !== "live") {
      return { success: true, queueId, channel: "ETSY", status: "SKIPPED",
        message: `Etsy ${etsyMode} — not published (set NEXUS_ENABLE_ETSY_PUBLISH=true + ETSY_PUBLISH_MODE=live)`,
        dryRun: true };
    }

    // What this row writes, decided once: the branch below follows the same three answers.
    const isContent = syncType === "CONTENT_UPDATE";
    const isPrice = !isContent && (syncType === "PRICE_UPDATE" || payload?.price != null);

    const destination = await this.destinationOf(queueItem);
    if (!destination.connectionId) {
      const error = noDestinationSentence("Etsy", destination.reason);
      return { success: false, queueId, channel: "ETSY", status: "FAILED", message: error, error, errorCode: "NO_DESTINATION_ACCOUNT", retryable: false };
    }
    // As P0.7 for eBay / Amazon and P1.4 for Shopify: a row may not name one shop for a listing of
    // another. Etsy listing ids are per shop, so the same number is a different listing elsewhere.
    const listingAccount: string | null = channelListing?.channelConnectionId ?? null;
    if (listingAccount && listingAccount !== destination.connectionId) {
      const error = `This Etsy listing belongs to another Etsy account than the one this change was queued for. Nothing was sent.`;
      return { success: false, queueId, channel: "ETSY", status: "FAILED", message: error, error, errorCode: "WRONG_ACCOUNT_WRITE", retryable: false };
    }

    const listingId = channelListing?.externalListingId ?? this.getExternalListingId(product ?? {}, "ETSY");
    if (!listingId) {
      const error = "This product has no Etsy listing id, so there is nothing on Etsy to change. Nothing was sent.";
      return { success: false, queueId, channel: "ETSY", status: "FAILED", message: error, error, errorCode: "NO_EXTERNAL_LISTING", retryable: false };
    }

    // 2026-10-01 (Owner) — a STOCK row also needs Etsy order import: the switch on AND this account activated. Without
    // either, Etsy's sales never reach Nexus stock, and the number sent would put back units Etsy has already sold.
    // SKIPPED, naming what is missing, before any Etsy call; not retried (both are deliberate steps, not passing faults).
    if (!isContent && !isPrice) {
      const { etsyStockWriteRefusal } = await import("./etsy/order-ingest-switch.js");
      let refusal: Awaited<ReturnType<typeof etsyStockWriteRefusal>>;
      try {
        refusal = await etsyStockWriteRefusal(destination.connectionId);
      } catch (error) {
        const message = `Nexus could not read whether Etsy order import is activated for this account, so nothing was sent. (${error instanceof Error ? error.message : String(error)})`;
        return { success: false, queueId, channel: "ETSY", status: "FAILED", message, error: message, errorCode: "ETSY_ORDER_IMPORT_UNKNOWN", retryable: true };
      }
      if (refusal) return { success: true, queueId, channel: "ETSY", status: "SKIPPED", message: refusal.sentence, errorCode: refusal.code, retryable: false };
    }

    // SC.1 — the channel policy pause, re-checked at send time as the Amazon and eBay lanes do: a policy set after
    // the row was queued still holds it. Etsy's market is GLOBAL, so a policy for '*' or GLOBAL applies.
    try {
      const scp = policyFor(await loadChannelPolicies(), 'ETSY', String(channelListing?.marketplace ?? 'GLOBAL'), destination.connectionId);
      if (scp?.pushesPaused) {
        // Not retried, as the listing pause above: a pause is the operator's state, not a passing fault.
        return { success: false, queueId, channel: "ETSY", status: "SKIPPED", message: "Channel-market pushes PAUSED (Sync Control policy)", error: "sync-paused-policy", errorCode: "SYNC_PAUSED_POLICY", retryable: false };
      }
    } catch { /* fail-open: policy unreadable = not paused, as the other lanes */ }

    const t0 = Date.now();
    const failed = (message: string, errorCode?: string, retryable = true): SyncResult => {
      writeAttemptLog({ channel: "ETSY", marketplace: "GLOBAL", sellerId: destination.connectionId!, sku, productId: product?.id ?? null, mode: "live", outcome: "failed", payloadDigest: digestPayload(payload), errorMessage: message.slice(0, 300), durationMs: Date.now() - t0 });
      return { success: false, queueId, channel: "ETSY", status: "FAILED", message, error: message, ...(errorCode ? { errorCode } : {}), retryable };
    };

    try {
      let message: string;
      if (isContent) {
        const { updateEtsyListingContent } = await import("./etsy/listing-write.service.js");
        await updateEtsyListingContent({
          accountId: destination.connectionId, listingId, pushLock: channelListing ? [channelListing] : undefined,
          ledger: { productId: product?.id ?? null, listingId: channelListing?.id ?? null, triggeredBy: "api" },
          content: {
            title: payload?.title,
            ...(payload && "description" in payload ? { description: payload.description } : {}),
          },
        });
        message = `Etsy listing ${listingId} content updated.`;
      } else {
        const { writeEtsyInventory } = await import("./etsy/inventory-write.service.js");
        const changes: Array<{ sku?: string | null; quantity?: number; price?: number }> = [];
        const offeringSku = channelListing?.sku ?? product?.etsySku ?? product?.sku ?? null;
        let priceCurrency: string | undefined;
        if (isPrice) {
          // 2026-09-30 — a price row with no usable price is refused by name. It used to reach the writer as "no
          // change" and come back SUCCESS: "Etsy already holds these values".
          const price = payload?.price == null || payload.price === "" ? Number.NaN : Number(payload.price);
          if (!Number.isFinite(price) || price <= 0) return failed("This price change carries no usable price, so nothing was sent to Etsy.", "NO_PRICE", false);
          // P4.4c — the operator's own floor and ceiling, and it REFUSES rather than clamping,
          // because a price is a number a person typed.
          // Only a price in the master currency is held to the master-currency floor and ceiling (refuse, don't convert).
          const refusal = await priceRefusalFor({ price, productId: product?.id, channel: 'Etsy', sku, market: { channel: 'ETSY', marketplace: channelListing?.marketplace ?? 'GLOBAL' } });
          if (refusal) return failed(refusal, "PRICE_OUT_OF_BOUNDS", false);
          // P4.4a, as the Amazon and eBay lanes: the currency is the listing market's Marketplace row, never guessed.
          // The writer compares it with the currency Etsy states for the listing, and a mismatch sends nothing.
          try {
            priceCurrency = await marketCurrency("ETSY", String(channelListing?.marketplace ?? "GLOBAL"));
          } catch (err) {
            return failed(`${err instanceof Error ? err.message : String(err)} The price was not written.`, "MARKET_CURRENCY_UNCONFIGURED", false);
          }
          // Only the price: the writer sends every quantity back exactly as Etsy stated it in the read before the PUT.
          changes.push({ sku: offeringSku, price });
        } else {
          const dispatchQuantity = await this.linkedDispatchQuantity(queueItem, sku, 'ETSY', 'Etsy');
          if (dispatchQuantity.refusal) return failed(dispatchQuantity.refusal, "NO_ROUTED_LOCATION", false);
          changes.push({ sku: offeringSku, quantity: dispatchQuantity.quantity });
        }
        const result = await writeEtsyInventory({
          accountId: destination.connectionId, listingId, changes,
          ...(priceCurrency ? { priceCurrency } : {}),
          pushLock: channelListing ? [channelListing] : undefined,
          ledger: { productId: product?.id ?? null, listingId: channelListing?.id ?? null, triggeredBy: "api" },
        });
        // A read-back that did not match is NOT a failed write — the change was accepted. It is a
        // success with a warning the operator has already been alerted about (P4.6c), and saying
        // "FAILED" here would invite a retry, which on a full-replace endpoint is the one thing
        // that would make it worse.
        message = !result.sent
          ? (result.reason ?? "Etsy already holds these values; nothing was sent.")
          : result.confirmed
            ? `Etsy listing ${listingId} updated and confirmed.`
            : `Etsy listing ${listingId} updated, but the read-back did not match. ${result.drift === null ? "Etsy could not be re-read." : `${result.drift.length} field(s) differ.`} An alert has been raised.`;
        // 2026-10-01 — Etsy holds at most 999 of an item per offering; a higher stock number was sent as 999.
        for (const clamp of result.clamped ?? []) message += ` Etsy holds at most ${clamp.sent} of an item, so ${clamp.requested} was sent as ${clamp.sent}.`;
        // Etsy has no sale price on a listing (its sales are shop promotions), so a Nexus sale is not in this write.
        if (isPrice && payload?.salePrice != null) message += " Etsy has no per-listing sale price, so the sale price stays in Nexus only.";
      }
      writeAttemptLog({ channel: "ETSY", marketplace: "GLOBAL", sellerId: destination.connectionId, sku, productId: product?.id ?? null, mode: "live", outcome: "success", payloadDigest: digestPayload(payload), errorMessage: null, durationMs: Date.now() - t0 });
      return { success: true, queueId, channel: "ETSY", status: "SUCCESS", message };
    } catch (error) {
      // Etsy's inventory refusing the change (a SKU it does not have, a price it cannot take alone, another currency)
      // gives the same answer on a retry, so it is not retried. A failed read is not one of those: it stays retryable.
      const { isEtsyInventoryRefusal } = await import("./etsy/inventory.js");
      return failed(error instanceof Error ? error.message : String(error),
        typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : undefined,
        !isEtsyInventoryRefusal(error));
    }
  }

  /**
   * Sync product to WooCommerce.
   *
   * C.8 — same shape as syncToShopify: honest NOT_IMPLEMENTED gate
   * until Wave 6 / C.19 wires the real REST adapter.
   */
  private async syncToWoocommerce(queueItem: any): Promise<SyncResult> {
    const pushRefusal = (await this.pushLockListings(queueItem, 'WOOCOMMERCE'))
      .map(listing => assertPushAllowed(listing)).find(Boolean);
    if (pushRefusal) return { success: false, queueId: queueItem.id, channel: 'WOOCOMMERCE',
      status: 'SKIPPED', message: pushRefusal.sentence, error: pushRefusal.sentence,
      errorCode: pushRefusal.code, retryable: false };

    const { product, payload, id: queueId } = queueItem;
    const sku = product?.sku ?? queueItem.externalListingId ?? "(unknown sku)";
    const wooPayload = this.constructWoocommercePayload(payload);
    writeAttemptLog({
      channel: "WOOCOMMERCE",
      marketplace: "GLOBAL",
      sellerId: process.env.WOOCOMMERCE_STORE_URL ?? "(unset)",
      sku,
      productId: product?.id ?? null,
      mode: "gated",
      outcome: "gated",
      payload: wooPayload,
      errorMessage:
        "WooCommerce outbound sync not yet wired — see roadmap C.19 (Wave 6 Path A).",
    });
    return {
      success: false,
      queueId,
      channel: "WOOCOMMERCE",
      status: "FAILED",
      message: `Failed to sync to WooCommerce`,
      error:
        "WooCommerce outbound sync not yet wired — see roadmap C.19 (Wave 6 Path A).",
    };
  }

  /**
   * Handle sync failure with retry logic (RT.0 semantics — see
   * computeFailureDisposition). Circuit-open/rate-limit episodes defer without
   * consuming retry budget; terminal rows are dead-lettered + emit SYNC_DEAD.
   */
  private async handleSyncFailure(
    queueItem: any,
    errorMessage: string,
    opts?: { errorCode?: string; retryable?: boolean },
  ): Promise<'UNKNOWN' | void> {
    if (opts?.errorCode === 'LIFECYCLE_DISPATCH_REFUSED'
      && ['UNPUBLISH_LISTING', 'DELETE_LISTING'].includes(queueItem.syncType)
      && queueItem.payload?.delistOutcome === 'UNKNOWN') {
      // This drain cannot attempt a lifecycle write. Its refusal cannot change
      // what an earlier channel attempt did, or consume another channel retry.
      await prisma.outboundSyncQueue.update({
        where: { id: queueItem.id },
        data: {
          syncStatus: 'SKIPPED', syncedAt: null, nextRetryAt: null,
          isDead: true, diedAt: new Date(),
          errorCode: queueItem.errorCode ?? 'LIFECYCLE_DISPATCH_REFUSED',
          errorMessage: `${queueItem.errorMessage ?? 'The outcome of the earlier channel attempt is unknown.'} ${errorMessage}`,
          payload: { ...queueItem.payload, delistDispatchErrorCode: opts.errorCode, delistDispatchError: errorMessage },
        },
      });
      return 'UNKNOWN';
    }
    const disposition = computeFailureDisposition(queueItem, errorMessage, opts);

    if (disposition.kind === "deferral") {
      await prisma.outboundSyncQueue.update({
        where: { id: queueItem.id },
        data: {
          syncStatus: "FAILED",
          errorMessage,
          errorCode: disposition.errorCode,
          // retryCount deliberately NOT incremented — the failure belongs to
          // the circuit/rate-limit episode, not to this row.
          nextRetryAt: disposition.nextRetryAt,
        },
      });
      return;
    }

    if (disposition.kind === "terminal") {
      await prisma.outboundSyncQueue.update({
        where: { id: queueItem.id },
        data: {
          syncStatus: "FAILED",
          errorMessage,
          errorCode: disposition.errorCode,
          retryCount: queueItem.retryCount + 1,
          isDead: true,
          diedAt: new Date(),
        },
      });
      productEventService
        .emit({
          aggregateId: queueItem.productId ?? queueItem.id,
          aggregateType: "ChannelListing",
          eventType: "SYNC_DEAD",
          data: {
            queueId: queueItem.id,
            channel: queueItem.targetChannel,
            syncType: queueItem.syncType,
            error: errorMessage,
            retryCount: queueItem.retryCount + 1,
          },
          metadata: { source: "SYSTEM" },
        })
        .catch(() => {});
      return;
    }

    await prisma.outboundSyncQueue.update({
      where: { id: queueItem.id },
      data: {
        syncStatus: "FAILED",
        errorMessage,
        errorCode: disposition.errorCode,
        retryCount: queueItem.retryCount + 1,
        nextRetryAt: disposition.nextRetryAt,
      },
    });
  }

  /* A4.0 — constructAmazonPayload removed; replaced by the module-level
   * buildAmazonListingPatch (correct schema names + Listings PATCH shape). */

  /**
   * Construct WooCommerce payload
   */
  private constructWoocommercePayload(payload: SyncPayload): Record<string, any> {
    const wooPayload: Record<string, any> = {};

    if (payload.title) {
      wooPayload.name = payload.title;
    }

    if (payload.description) {
      wooPayload.description = payload.description;
    }

    if (payload.price !== undefined) {
      wooPayload.regular_price = payload.price.toString();
    }

    if (payload.quantity !== undefined) {
      wooPayload.stock_quantity = payload.quantity;
    }

    if (payload.images && payload.images.length > 0) {
      wooPayload.images = payload.images.map((url) => ({
        src: url,
      }));
    }

    return wooPayload;
  }

  /**
   * Get external listing ID from product based on channel
   */
  private getExternalListingId(
    product: any,
    channel: "AMAZON" | "EBAY" | "SHOPIFY" | "WOOCOMMERCE" | "ETSY"
  ): string | null {
    switch (channel) {
      case "AMAZON":
        return product.amazonAsin || null;
      case "EBAY":
        return product.ebayItemId || null;
      case "SHOPIFY":
        return product.shopifyProductId || null;
      case "WOOCOMMERCE":
        return product.woocommerceProductId || null;
      case "ETSY":
        // P4.6e — Product.etsyListingId (schema line 1381). Unlike the other three this is the
        // listing, not a product: on Etsy a listing IS the sellable thing, and its inventory
        // hangs off it.
        return product.etsyListingId || null;
      default:
        return null;
    }
  }

  /**
   * Get queue status
   */
  async getQueueStatus(
    filters?: {
      status?: string;
      channel?: string;
      productId?: string;
    }
  ): Promise<any[]> {
    const where: any = {};

    if (filters?.status) {
      where.syncStatus = filters.status;
    }

    if (filters?.channel) {
      where.targetChannel = filters.channel;
    }

    if (filters?.productId) {
      where.productId = filters.productId;
    }

    return prisma.outboundSyncQueue.findMany({
      where,
      include: {
        product: {
          select: {
            id: true,
            sku: true,
            name: true,
            basePrice: true,
            totalStock: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });
  }

  /**
   * Retry a specific queue item
   */
  async retryQueueItem(queueId: string): Promise<QueueResult> {
    try {
      const queueItem = await prisma.outboundSyncQueue.findUnique({
        where: { id: queueId },
      });

      if (!queueItem) {
        return {
          success: false,
          message: `Queue item ${queueId} not found`,
        };
      }

      // Reset for retry
      await prisma.outboundSyncQueue.update({
        where: { id: queueId },
        data: {
          syncStatus: "PENDING",
          retryCount: 0,
          errorMessage: null,
          errorCode: null,
          nextRetryAt: null,
        },
      });

      return {
        success: true,
        queueId,
        message: `Queue item reset for retry`,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to retry queue item: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  /**
   * Get sync statistics
   */
  getStats() {
    return this.stats;
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      queued: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
    };
  }
}

export default new OutboundSyncService();
