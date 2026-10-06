/**
 * P4.6c — the Etsy stock/price write, end to end.
 *
 * Read the listing's inventory, turn it into the shape the PUT accepts, change only the offerings
 * asked for, send it, read it back, and compare. `inventory.ts` holds the transform and the
 * comparison (pure, and tested as such); this file is the order those steps happen in and the two
 * decisions that live between them.
 */
import { logger } from '../../utils/logger.js'
import { raiseChannelAlert, writeDriftAlert } from '../cx/channel-alerts.service.js'
import { etsyReader } from './read-client.js'
import { etsyWriter } from './write-client.js'
import {
  applyOfferingChanges, EtsyInventoryShapeError, EtsyPriceRefusal, etsyPriceCurrencyRefusal, EtsyQuantityRefusal, inventoryDrift, toInventoryWrite,
  type EtsyInventoryWrite, type EtsyQuantityClamp, type EtsyReadInventory, type EtsyWriteProduct, type InventoryDrift, type OfferingChange,
} from './inventory.js'
import { etsyStockWriteRefusal } from './order-ingest-switch.js'
import type { GatewayRequest } from '../gateway/gateway.js'
import { withEtsyListingLock, type EtsyListingLease } from './listing-lock.js'

export interface EtsyInventoryWriteInput {
  accountId: string
  /** Etsy's numeric listing id. */
  listingId: number | string
  changes: readonly OfferingChange[]
  pushLock?: GatewayRequest['pushLock']
  ledger?: GatewayRequest['ledger']
  /**
   * How long to wait before the read-back. Etsy is not read-your-writes, and an immediate read can
   * return the value from BEFORE the change — which is indistinguishable from "the write did not
   * land" (banked: *read before the write arrived*). Injectable so a test does not sleep.
   */
  readBackDelayMs?: number
  /**
   * 2026-09-30 — the currency Nexus holds a price change in (the listing market's `Marketplace.currency`). Required
   * with any price change: Etsy's PUT takes a bare number in the shop's currency, and the read below, where Etsy states
   * its currency, is the only place the two can be compared. A mismatch, or no stated currency, sends nothing.
   */
  priceCurrency?: string
}

export interface EtsyInventoryWriteResult {
  /** False when the change was already true at Etsy, so nothing was sent. */
  sent: boolean
  body: EtsyInventoryWrite | null
  /** Null when the read-back could not be read — which is NOT the same as "no drift". */
  drift: InventoryDrift[] | null
  confirmed: boolean
  reason?: string
  /** Quantities sent lower than asked: Etsy holds at most 999 of an item per offering. Empty when none was. */
  clamped: EtsyQuantityClamp[]
}

const DEFAULT_READ_BACK_DELAY_MS = 2_000

export async function writeEtsyInventory(input: EtsyInventoryWriteInput): Promise<EtsyInventoryWriteResult> {
  const listingId = String(input.listingId)
  if (!/^[1-9]\d*$/.test(listingId)) throw new Error('That is not an Etsy listing id; nothing was sent.')
  // 2026-10-01 (Owner) — a stock number needs Etsy order import on AND activated for this account, or it puts back
  // units Etsy already sold. Checked here as well as in the queue lane, before the lock and before any Etsy call, so
  // no other caller can skip it.
  if (input.changes.some((change) => change.quantity !== undefined)) {
    const refusal = await etsyStockWriteRefusal(input.accountId)
    if (refusal) throw new EtsyQuantityRefusal(refusal.sentence, refusal.code)
  }

  // 2026-09-30 — one read → change → replace per listing at a time (`listing-lock.ts`): two overlapping writes to one
  // listing would each replace the inventory the other had just changed. Held through the read-back, so a sibling
  // write cannot land between our PUT and the check of it.
  return withEtsyListingLock({ accountId: input.accountId, listingId }, (lease) => writeHoldingLock(input, listingId, lease))
}

async function writeHoldingLock(input: EtsyInventoryWriteInput, listingId: string, lease: EtsyListingLease): Promise<EtsyInventoryWriteResult> {
  const reader = await etsyReader(input.accountId)
  // A read that fails throws here, before anything is built or sent: the caller retries it.
  const before = await reader.get<EtsyReadInventory>(`/listings/${listingId}/inventory`)
  if (input.changes.some((change) => change.price !== undefined)) {
    const refusal = etsyPriceCurrencyRefusal(before, input.priceCurrency)
    if (refusal) throw new EtsyPriceRefusal(refusal)
  }
  const current = toInventoryWrite(before)
  const report = { clamped: [] as EtsyQuantityClamp[] }
  const body = applyOfferingChanges(current, input.changes, report)
  if (report.clamped.length > 0) logger.warn('[etsy] a quantity above Etsy\'s maximum was sent as the maximum', { listingId, accountId: input.accountId, clamped: report.clamped })
  const { clamped } = report

  /**
   * 🔴 Decision 1 — a change that changes nothing is NOT sent.
   *
   * Not an optimisation. Etsy's inventory PUT is a full replace, and on a shop with domestic +
   * international pricing it switches that feature off and blanks the domestic price whatever the
   * body says. So every PUT carries a risk of destroying a price, and a PUT that would set the
   * quantity to the value Etsy already holds takes that risk for nothing at all.
   *
   * The comparison is structural, on the body we WOULD send against the body we just derived from
   * Etsy's own answer — not on the caller's intent, which cannot see what Etsy holds.
   */
  if (JSON.stringify(body) === JSON.stringify(current)) {
    return { sent: false, body: null, drift: [], confirmed: true, reason: 'Etsy already holds these values; nothing was sent.', clamped }
  }

  const writer = await etsyWriter(input.accountId)
  await lease.assertHeld()
  await writer.send({
    path: `/listings/${listingId}/inventory`,
    method: 'PUT',
    body,
    kind: 'write',
    pushLock: input.pushLock,
    ledger: input.ledger,
    operation: 'PUT /listings/:id/inventory',
    signal: lease.signal,
  })

  /**
   * 🔴 Decision 2 — the read-back is part of the write, not a nicety.
   *
   * The quality bar (§7.1.12) asks for it, and here it is the ONLY instrument that can see the
   * damage: the PUT answers 200 while having blanked a price it was never asked about. A write's
   * response is not what it wrote.
   *
   * A read-back that cannot be read is reported as `confirmed: false` with `drift: null`. It is
   * never reported as an empty drift list — "we could not check" and "we checked and it matched"
   * are different facts, and only one of them is a pass.
   */
  const delay = input.readBackDelayMs ?? DEFAULT_READ_BACK_DELAY_MS
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))

  let drift: InventoryDrift[]
  try {
    const after = await reader.get<EtsyReadInventory>(`/listings/${listingId}/inventory`)
    drift = inventoryDrift(body, after)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    logger.warn('[etsy] the inventory change was sent but could not be confirmed', { listingId, accountId: input.accountId, reason })
    return { sent: true, body, drift: null, confirmed: false, reason, clamped }
  }

  if (drift.length > 0) {
    logger.warn('[etsy] the inventory read-back does not match what was sent', { listingId, accountId: input.accountId, drift })
    const alert = writeDriftAlert('Etsy', listingId, drift)
    if (alert) await raiseChannelAlert(alert)
  }
  return { sent: true, body, drift, confirmed: drift.length === 0, clamped }
}

// ── E2 — the studio's full inventory replace ─────────────────────────────────────────────────────────────────────

/** E2 — the studio's full inventory replace: Etsy's fresh inventory in, the body to PUT out (built by the caller). */
export interface EtsyInventoryReplaceInput { accountId: string; listingId: number | string
  /** Builds the whole body from Etsy's inventory as read now (a copy; the writer keeps its own). A throw sends nothing. */
  build: (current: EtsyInventoryWrite) => EtsyInventoryWrite
  /** Awaited with the exact body just before the PUT (the studio journals it); its throw sends nothing. */
  beforeSend?: (body: EtsyInventoryWrite) => Promise<void>
  /** The currency Nexus holds a new variation's price or a changed price in; required for either (`etsyPriceCurrencyRefusal`). */
  priceCurrency?: string; ledger?: GatewayRequest['ledger']; readBackDelayMs?: number
  /**
   * E3 — the stock rule (Etsy order import) is waived when Etsy itself says this listing is a draft: a draft cannot sell,
   * so its stock numbers cannot put back units Etsy already sold. Read under the listing lock, only when the rule would refuse.
   */
  allowDraftStock?: boolean }
export interface EtsyInventoryReplaceResult { sent: boolean; body: EtsyInventoryWrite; current: EtsyInventoryWrite; drift: InventoryDrift[] | null; confirmed: boolean }

/** JSON with object keys sorted: two bodies that differ only in key order are the same body. */
const canonical = (value: unknown) => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry)

/** Two `*_on_property` arrays name the same properties (Etsy's order is not a change; an absent array is []). */
const sameIds = (a: readonly number[] | undefined, b: readonly number[] | undefined) =>
  canonical([...new Set(a ?? [])].sort((x, y) => x - y)) === canonical([...new Set(b ?? [])].sort((x, y) => x - y))

/** A product's variation values: what tells apart several Etsy products that carry one SKU. */
const valuesKey = (product: EtsyWriteProduct) => (product.property_values ?? []).map((pv) => `${pv.property_id}=${pv.values.join('+')}`).sort().join('|')

/**
 * The body's own shape, before anything is sent: Etsy's PUT requires all four offering fields (R1 §3), and a physical
 * listing refuses an offering with no processing profile ("All offerings need readiness state").
 */
function assertReplaceBody(body: EtsyInventoryWrite): void {
  if (!body || !Array.isArray(body.products) || !body.products.length) throw new EtsyInventoryShapeError('The Etsy inventory to send has no products; nothing was sent.')
  body.products.forEach((product, pi) => {
    const name = product.sku || `#${pi + 1}`
    if (!Array.isArray(product.offerings) || !product.offerings.length) throw new EtsyInventoryShapeError(`Etsy product ${name} has no offering to send; nothing was sent.`)
    for (const offering of product.offerings) {
      if (!Number.isInteger(offering.readiness_state_id) || (offering.readiness_state_id as number) < 1) {
        throw new EtsyInventoryShapeError(`Etsy product ${name} has no processing profile (readiness_state_id), and Etsy refuses an offering without one; nothing was sent.`)
      }
      if (!Number.isFinite(offering.price) || offering.price <= 0) throw new EtsyInventoryShapeError(`Etsy product ${name}: a price of ${offering.price} is not a usable price; nothing was sent.`)
      if (!Number.isInteger(offering.quantity) || offering.quantity < 0) throw new EtsyInventoryShapeError(`Etsy product ${name}: a quantity of ${offering.quantity} is not a whole number of items; nothing was sent.`)
      if (typeof offering.is_enabled !== 'boolean') throw new EtsyInventoryShapeError(`Etsy product ${name} has no is_enabled flag; nothing was sent.`)
    }
  })
}

/**
 * E2 — replace a listing's whole inventory with a body the caller builds from Etsy's inventory as read NOW (the studio
 * send: Etsy's own price, stock and on/off for every variation it holds, Nexus's structure and processing profiles,
 * Nexus's offering for a variation Etsy does not hold yet).
 *
 * Under the listing lock (`listing-lock.ts`), held through the read-back, like every other inventory write: read →
 * build → compare → checks → `beforeSend` → PUT → read back. A body equal to Etsy's is not sent (the domestic-pricing
 * risk of every PUT, `inventory.ts` trap 3). Before the PUT, the same two rules as the stock and price pushes:
 * - a stock number (a variation new on Etsy that buyers can see, a held variation whose quantity moved, a hidden one
 *   shown again, or a changed `quantity_on_property` — what the stock is shared by) needs Etsy order import on and
 *   activated for the account (2026-10-01) — a new variation sent hidden (`is_enabled: false`) cannot sell, so it does
 *   not (D6: showing it later asks); E3 — waived with `allowDraftStock` when Etsy itself says the listing is a draft;
 * - a price (a new variation, or a held price that moved) must be in the currency Etsy states (2026-09-30).
 *
 * 🔴 After Etsy answered the PUT it never throws: a read-back that cannot be read is `drift: null` (could not check,
 * never "matched"), and a failed alert is logged. The change may have landed, and the caller must say so.
 */
export async function replaceEtsyInventory(input: EtsyInventoryReplaceInput): Promise<EtsyInventoryReplaceResult> {
  const listingId = String(input.listingId)
  if (!/^[1-9]\d*$/.test(listingId)) throw new Error('That is not an Etsy listing id; nothing was sent.')
  return withEtsyListingLock({ accountId: input.accountId, listingId }, (lease) => replaceHoldingLock(input, listingId, lease))
}

/** E3 — Etsy's own word that the listing is a draft (GET /listings/{id}, `state`). A read that fails is "not a draft". */
const listingIsDraft = (reader: Awaited<ReturnType<typeof etsyReader>>, listingId: string): Promise<boolean> =>
  reader.get<{ state?: unknown } | null>(`/listings/${listingId}`).then((listing) => listing?.state === 'draft', () => false)

async function replaceHoldingLock(input: EtsyInventoryReplaceInput, listingId: string, lease: EtsyListingLease): Promise<EtsyInventoryReplaceResult> {
  const reader = await etsyReader(input.accountId)
  // A read that fails throws here, before anything is built or sent.
  const raw = await reader.get<EtsyReadInventory>(`/listings/${listingId}/inventory`)
  const current = toInventoryWrite(raw)
  const body = input.build(structuredClone(current))
  if (canonical(body) === canonical(current)) return { sent: false, body, current, drift: [], confirmed: true }
  assertReplaceBody(body)

  const held = new Map<string, EtsyWriteProduct[]>()
  for (const product of current.products) if (product.sku) held.set(product.sku, [...(held.get(product.sku) ?? []), product])
  // 🔴 What the stock is shared by (`quantity_on_property`) is a stock fact too: the same numbers with another rule are
  // another stock on Etsy (5 shared by two variations is 5; 5 each is 10). A changed rule is a stock change.
  let stock = !sameIds(body.quantity_on_property, current.quantity_on_property)
  let price = false
  for (const product of body.products) {
    const same = product.sku ? held.get(product.sku) ?? [] : []
    const mirror = same.length <= 1 ? same[0] : same.find((other) => valuesKey(other) === valuesKey(product))
    if (!mirror) {
      price = true
      if (product.offerings.some((offering) => offering.is_enabled !== false)) stock = true
      continue
    }
    product.offerings.forEach((offering, oi) => {
      const before = mirror.offerings[oi]
      // Showing a hidden variation starts it selling at the quantity Etsy kept: a stock fact like a new number (D6).
      if (!before || before.quantity !== offering.quantity || (before.is_enabled === false && offering.is_enabled !== false)) stock = true
      if (!before || before.price !== offering.price) price = true
    })
  }
  if (stock) {
    const refusal = await etsyStockWriteRefusal(input.accountId)
    // E3 — a draft cannot sell, so its stock cannot put back units Etsy sold: the rule is waived for a caller that asks
    // (`allowDraftStock`) when ETSY says, read now under this lock, that the listing is a draft. Asked only when the rule
    // would refuse; a read that fails keeps the rule.
    if (refusal && !(input.allowDraftStock && await listingIsDraft(reader, listingId))) throw new EtsyQuantityRefusal(refusal.sentence, refusal.code)
  }
  if (price) {
    const refusal = etsyPriceCurrencyRefusal(raw, input.priceCurrency)
    if (refusal) throw new EtsyPriceRefusal(refusal)
  }

  const writer = await etsyWriter(input.accountId)
  await input.beforeSend?.(body)
  await lease.assertHeld()
  await writer.send({
    path: `/listings/${listingId}/inventory`,
    method: 'PUT',
    body,
    kind: 'write',
    ledger: input.ledger,
    operation: 'PUT /listings/:id/inventory',
    signal: lease.signal,
  })

  // From here Etsy has the change (or may have): nothing below may throw.
  let drift: InventoryDrift[]
  try {
    const delay = input.readBackDelayMs ?? DEFAULT_READ_BACK_DELAY_MS
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    const after = await reader.get<EtsyReadInventory>(`/listings/${listingId}/inventory`)
    drift = inventoryDrift(body, after)
  } catch (err) {
    try { logger.warn('[etsy] the inventory replace was sent but could not be confirmed', { listingId, accountId: input.accountId, reason: err instanceof Error ? err.message : String(err) }) } catch { /* never throws */ }
    return { sent: true, body, current, drift: null, confirmed: false }
  }
  if (drift.length > 0) {
    try {
      logger.warn('[etsy] the inventory read-back does not match what was replaced', { listingId, accountId: input.accountId, drift })
      const alert = writeDriftAlert('Etsy', listingId, drift)
      if (alert) await raiseChannelAlert(alert)
    } catch (err) {
      try { logger.warn('[etsy] the inventory drift alert could not be raised', { listingId, reason: err instanceof Error ? err.message : String(err) }) } catch { /* never throws */ }
    }
  }
  return { sent: true, body, current, drift, confirmed: drift.length === 0 }
}
