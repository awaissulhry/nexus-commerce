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
  applyOfferingChanges, EtsyPriceRefusal, etsyPriceCurrencyRefusal, EtsyQuantityRefusal, inventoryDrift, toInventoryWrite,
  type EtsyInventoryWrite, type EtsyQuantityClamp, type EtsyReadInventory, type InventoryDrift, type OfferingChange,
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
  // 2026-10-01 (Owner) — a stock number needs Etsy order import on, or it puts back units Etsy already sold. Checked
  // here as well as in the queue lane, before the lock and before any call, so no other caller can skip it.
  if (input.changes.some((change) => change.quantity !== undefined)) {
    const refusal = etsyStockWriteRefusal()
    if (refusal) throw new EtsyQuantityRefusal(refusal)
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
