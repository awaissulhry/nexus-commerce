/**
 * Step 4 Send to FBA (Owner 2026-10-07) — "Mark shipped" for one Amazon shipment, and its box labels.
 * Signatures and rules: `contract.ts` (Part C).
 *
 * "Mark shipped" is the moment the units leave the own warehouse (Owner decision): ONE transaction under the plan row
 * and the product locks, per product of the shipment —
 *   release the plan line's hold → re-hold what the line still has to send (other shipments) →
 *   FBA_TRANSFER_OUT of the shipped units at the From WAREHOUSE, with `casesChange` = −(the sealed case boxes of the
 *   SKU in this shipment), so sealed cases leave sealed and loose units leave loose →
 *   `shippedQuantity += units`.
 * `available` does not move (the units were held); `quantity` drops; following FBM listings are re-advertised by the
 * movement's own cascade. The FBA quantity is never written: the movement is at the From warehouse only, and
 * FBA_TRANSFER_* at an AMAZON_FBA / SHOPIFY_LOCATION location is refused by `protectedLocationRefusal`.
 * Twice (double-click, resend, two tabs) = once: `shippedAt` is set only where it is null; the second call is a no-op
 * that answers the plan.
 */
import type { Prisma } from '@prisma/client'
import type { FbaLabelsAnswer, FbaPlanStatus, FbaPlanView, FbaShipmentBox, FbaShippedRequest } from '@nexus/shared/fba-send'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { getInboundShipmentLabels } from '../fba-inbound.service.js'
import { lockProductStock } from '../stock-lock.js'
import { releaseReservationInTx, reserveStockInTx } from '../stock-level.service.js'
import { afterStockMovementCommit, applyStockMovementInTx, InsufficientStockError, type StockMovementTxResult } from '../stock-movement.service.js'
import { sealedByLevel } from '../stock/stock-cases.service.js'
import { planViewIn, readPlan } from './read.service.js'
import { dispatchSoon, FBA_SEND_HOLD_TTL_MS, lockPlan, publishPlanChanged } from './send.service.js'
import { FbaSendError, type FbaActor } from './contract.js'

const TX_OPTIONS = { isolationLevel: 'ReadCommitted' as const, maxWait: 5_000, timeout: 60_000 }
const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])

/** The tracking as sent: one entry per box of the shipment, each once, each with a number. */
function trackingOf(req: FbaShippedRequest, boxes: FbaShipmentBox[]): Array<{ boxId: string; trackingId: string }> {
  if (!req || typeof req !== 'object' || !Array.isArray(req.tracking)) throw new FbaSendError('TRACKING_INVALID', 'Send one tracking number for every box')
  if (boxes.length === 0) throw new FbaSendError('TRACKING_INVALID', 'Amazon has not given this shipment\'s boxes yet: wait for the labels.')
  const rows = req.tracking.map((row) => ({
    boxId: typeof row?.boxId === 'string' ? row.boxId.trim() : '',
    trackingId: typeof row?.trackingId === 'string' ? row.trackingId.trim() : '',
  }))
  const ids = boxes.map((box) => box.boxId)
  const named = rows.map((row) => row.boxId)
  if (rows.some((row) => !row.boxId || !row.trackingId)) throw new FbaSendError('TRACKING_INVALID', 'Every box needs a tracking number')
  if (new Set(named).size !== named.length) throw new FbaSendError('TRACKING_INVALID', 'A box is named twice')
  const unknown = named.filter((id) => !ids.includes(id))
  if (unknown.length > 0) throw new FbaSendError('TRACKING_INVALID', `Not a box of this shipment: ${unknown.join(', ')}`)
  const missing = ids.filter((id) => !named.includes(id))
  if (missing.length > 0) throw new FbaSendError('TRACKING_INVALID', `Tracking missing for ${missing.length === 1 ? 'box' : 'boxes'} ${missing.join(', ')}`)
  return ids.map((id) => rows.find((row) => row.boxId === id)!)
}

/** Is this box one sealed case of the line? Amazon's own boxes say `kind`; an unknown kind with exactly one case's
 *  worth of one SKU counts as a case. */
function isCaseBox(box: FbaShipmentBox, line: { msku: string; unitsPerCase: number | null; cases: number }): boolean {
  if (line.cases <= 0 || !line.unitsPerCase) return false
  const only = box.items.length === 1 ? box.items[0] : null
  if (!only || only.msku !== line.msku) return false
  if (box.kind === 'case') return true
  return box.kind === null && only.quantity === line.unitsPerCase
}

/** "Mark shipped" for one Amazon shipment (`shipmentId` = FBAShipment.id). See the file header. */
export async function markShipped(shipmentId: string, req: FbaShippedRequest, who: FbaActor): Promise<FbaPlanView> {
  const head = await prisma.fBAShipment.findUnique({ where: { id: String(shipmentId ?? '') }, select: { planRowId: true } })
  if (!head?.planRowId) throw new FbaSendError('NOT_FOUND', 'FBA shipment not found')
  const planRowId = head.planRowId

  type Outcome = { noop: true } | { noop: false; view: FbaPlanView | null; committed: Array<{ productId: string; result: StockMovementTxResult }> }
  let outcome: Outcome
  try {
    outcome = await prisma.$transaction(async (tx): Promise<Outcome> => {
      const plan = await lockPlan(tx, planRowId)
      // Read under the plan lock: a Shipped that committed meanwhile is seen here.
      const shipment = await tx.fBAShipment.findUnique({
        where: { id: shipmentId },
        select: { id: true, shipmentId: true, boxes: true, shippedAt: true, sourceLocationId: true, items: { select: { productId: true, quantitySent: true } } },
      })
      if (!shipment) throw new FbaSendError('NOT_FOUND', 'FBA shipment not found')
      if (shipment.shippedAt) return { noop: true }
      if (plan.status !== 'READY_TO_SHIP') {
        throw new FbaSendError('WRONG_STATE', 'Mark a shipment Shipped once Amazon\'s labels are ready (the plan is ready to ship).')
      }
      const boxes = list<FbaShipmentBox>(shipment.boxes)
      const tracking = trackingOf(req, boxes)
      const from = shipment.sourceLocationId ?? plan.sourceLocationId
      if (!from) throw new FbaSendError('WRONG_STATE', 'The plan names no From warehouse.')

      // Units per product in this shipment: Amazon's shipment items; without them, the boxes' contents by Amazon SKU.
      const units = new Map<string, number>()
      for (const item of shipment.items) units.set(item.productId, (units.get(item.productId) ?? 0) + item.quantitySent)
      if (units.size === 0) {
        for (const box of boxes) {
          for (const item of box.items) {
            const line = plan.lines.find((l) => l.msku === item.msku)
            if (line) units.set(line.productId, (units.get(line.productId) ?? 0) + item.quantity)
          }
        }
      }

      const claimed = await tx.fBAShipment.updateMany({
        where: { id: shipment.id, shippedAt: null },
        data: { shippedAt: new Date(), shippedBy: who.actor, tracking: { boxes: tracking, sentAt: null } as unknown as Prisma.InputJsonValue },
      })
      if (claimed.count !== 1) return { noop: true }

      const productIds = [...units.keys()].sort()
      await lockProductStock(tx, productIds)
      const lines = await tx.fbaInboundPlanLine.findMany({
        where: { planRowId, productId: { in: productIds } },
        select: { id: true, productId: true, msku: true, quantity: true, cases: true, unitsPerCase: true, shippedQuantity: true, reservationId: true },
      })
      const committed: Array<{ productId: string; result: StockMovementTxResult }> = []
      for (const productId of productIds) {
        const line = lines.find((l) => l.productId === productId)
        const qty = units.get(productId) ?? 0
        if (!line || qty <= 0) {
          logger.warn('[fba-ship] a shipment item is not a line of its plan; skipped', { planRowId, shipmentId, productId, qty })
          continue
        }
        // The hold covers what the line still had to send; release it, then hold again what other shipments still take.
        if (line.reservationId) await releaseReservationInTx(tx, line.reservationId, { actor: who.actor, reason: `FBA shipment ${shipment.shipmentId} shipped` })
        const remaining = Math.max(0, line.quantity - line.shippedQuantity - qty)
        let reservationId: string | null = null
        if (remaining > 0) {
          try {
            reservationId = (await reserveStockInTx(tx, {
              productId, locationId: from, quantity: remaining, reason: 'FBA_SEND', kind: 'HARD', ttlMs: FBA_SEND_HOLD_TTL_MS, actor: who.actor,
            })).id
          } catch (error) {
            // Raised before anything is written: the shipped units still leave; the rest of the line is not held.
            if (!(error instanceof InsufficientStockError)) throw error
            logger.warn('[fba-ship] the rest of a line could not be held again', { planRowId, productId, remaining, error: error.message })
          }
        }
        // Whole sealed cases leave sealed — never more than are sealed now (a count may have changed since the plan).
        const level = await tx.stockLevel.findFirst({ where: { productId, locationId: from, variationId: null }, select: { id: true, quantity: true } })
        const sealedNow = level ? (await sealedByLevel(tx, [{ id: level.id, productId, quantity: level.quantity }])).get(level.id) ?? 0 : 0
        const caseBoxes = boxes.filter((box) => isCaseBox(box, line)).length
        const casesOut = Math.min(caseBoxes, sealedNow)
        const result = await applyStockMovementInTx(tx, {
          productId,
          locationId: from,
          change: -qty,
          reason: 'FBA_TRANSFER_OUT',
          referenceType: 'FbaInboundShipment',
          referenceId: shipment.id,
          notes: `Sent to Amazon FBA: shipment ${shipment.shipmentId}${casesOut > 0 ? ` · ${casesOut} sealed ${casesOut === 1 ? 'case' : 'cases'}` : ''} · plan ${plan.name ?? plan.id}`,
          actor: who.actor,
          ...(casesOut > 0 ? { casesChange: -casesOut } : {}),
        })
        committed.push({ productId, result })
        await tx.fbaInboundPlanLine.update({ where: { id: line.id }, data: { shippedQuantity: line.shippedQuantity + qty, reservationId } })
      }

      const unshipped = await tx.fBAShipment.count({ where: { planRowId, shippedAt: null } })
      const status: FbaPlanStatus = unshipped === 0 ? 'SHIPPED' : 'READY_TO_SHIP'
      await tx.fbaInboundPlanV2.update({ where: { id: planRowId }, data: { status, currentStep: 'TRACKING', nextCheckAt: new Date() } })
      await publishPlanChanged(tx, planRowId, status, 'TRACKING', plan.lines.map((l) => l.productId))
      return { noop: false, view: await planViewIn(tx, planRowId), committed }
    }, TX_OPTIONS)
  } catch (error) {
    if (error instanceof InsufficientStockError) {
      const message = `${error.need} units leave, but only ${error.have} are on hand at the From warehouse: count the stock there first.`
      throw new FbaSendError('REFUSED', message, [{ code: 'OVER_FREE', message, productId: error.productId, blocking: true }])
    }
    throw error
  }

  if (!('committed' in outcome)) {
    const view = await readPlan(planRowId)
    if (!view) throw new FbaSendError('NOT_FOUND', 'FBA plan not found')
    return view
  }
  for (const { productId, result } of outcome.committed) {
    try {
      await afterStockMovementCommit({ productId, reason: 'FBA_TRANSFER_OUT' }, result)
    } catch (error) {
      logger.warn('[fba-ship] post-commit stock work failed (the drain cron retries)', { productId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  await dispatchSoon(planRowId) // TRACKING: the job sends the numbers to Amazon
  return outcome.view!
}

/** Labels for one Amazon shipment (contract.ts): a fresh link each time, never stored. */
export async function labelsFor(shipmentId: string): Promise<FbaLabelsAnswer> {
  const row = await prisma.fBAShipment.findUnique({ where: { id: String(shipmentId ?? '') }, select: { shipmentId: true, planRowId: true, boxes: true } })
  if (!row?.planRowId) throw new FbaSendError('NOT_FOUND', 'FBA shipment not found')
  const boxIds = list<FbaShipmentBox>(row.boxes).map((box) => box.boxId).filter((id) => typeof id === 'string' && id.length > 0)
  if (boxIds.length === 0) throw new FbaSendError('LABELS_UNAVAILABLE', 'Amazon has not given this shipment\'s boxes yet: the labels come with them.')
  try {
    const { downloadUrl } = await getInboundShipmentLabels({ shipmentId: row.shipmentId, pageType: 'PackageLabel_A4_4', labelType: 'UNIQUE', packageLabelsToPrint: boxIds })
    if (!downloadUrl) throw new Error('no link')
    return { downloadUrl }
  } catch (error) {
    throw new FbaSendError('LABELS_UNAVAILABLE', `Amazon gave no labels for ${row.shipmentId}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
