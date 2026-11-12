import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { OPEN_TASK_STATUSES } from '@nexus/factory-domain/inventory/tasks/rules'
import { lyingTotal } from '@nexus/factory-domain/inventory/tasks/sources'
import type { Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../../core/command'
import { readSiteStock, type Reader } from '../../issue/store'
import { suggestedPlace } from '../../putaway/suggest'
import { cancelInCommand, createTaskInCommand, doneInCommand, type TaskDraft } from '../lifecycle'
import { defineTaskSource, posterOf, sourceCommand } from '../source-kit'
import { TASK_COLUMNS } from '../store'

/**
 * Put-aways from goods received and goods released (B-W2b-292; SCM-202, SCM-274; WarehouseTask kind PUT_AWAY):
 *
 *   inventory.receipt_posted    each lot the receipt brought onto a dock (a RECEIVING place: its RECEIPT moves' place) waits
 *                               for a put-away: one PUT_AWAY task per lot still lying there (source GoodsReceipt), to the
 *                               suggested place (modules/inventory/putaway suggest.ts: a lot not released goes to the quality
 *                               place). The order's open RECEIVE tasks (asked by hand, source PurchaseOrder) are done by who
 *                               received it.
 *   inventory.receipt_reversed  its open put-aways are cancelled.
 *   lot.released                a lot released while it lies in a quarantine place goes back to a bin: one PUT_AWAY per
 *                               quarantine place it lies in (source Lot).
 *   quality.hold_released       the stock of a hold whose goods were moved into quarantine goes back (source QualityHold),
 *                               for each released lot or hide still lying in its quarantine place.
 */

const OPEN = [...OPEN_TASK_STATUSES]

interface Wanted extends TaskDraft {
  readonly key: string
  /** Quality let it go (released, no active hold): it goes to a bin, else to the quality place. */
  readonly released: boolean
}

const ITEM = { id: true, kind: true, baseUom: true } as const

/** One put-away of a lot (or a hide) lying at a place, with its suggestion; null when nothing of it lies there. */
async function putAwayOf(db: Reader, ask: { readonly companyId: string; readonly siteId: string; readonly lotId: string; readonly hideId?: string | null; readonly fromId: string; readonly source: TaskDraft['source'] }): Promise<Wanted | null> {
  const lot = await db.lot.findUnique({ where: { id: ask.lotId }, select: { id: true, itemId: true, itemColourId: true, qualityStatus: true } })
  if (!lot) return null
  const item = await db.item.findUniqueOrThrow({ where: { id: lot.itemId }, select: ITEM })
  const rows = (await readSiteStock(db, ask.siteId, { itemIds: [lot.itemId], lotId: lot.id, ...(ask.hideId ? { hideId: ask.hideId } : {}) })).filter((row) => row.locationId === ask.fromId)
  const quantity: Decimal = lyingTotal(rows)
  if (!quantity.gt(0)) return null
  const held = (await db.qualityHold.count({ where: { status: 'ACTIVE', OR: [{ subjectType: 'Lot', subjectIds: { has: lot.id } }, ...(ask.hideId ? [{ subjectType: 'Hide' as const, subjectIds: { has: ask.hideId } }] : [])] } })) > 0
  const released = lot.qualityStatus === 'RELEASED' && !held
  const suggestion = await suggestedPlace(db, { siteId: ask.siteId, itemId: lot.itemId, itemKind: item.kind as string, lotId: lot.id, fromId: ask.fromId, released })
  return {
    key: `${lot.id}|${ask.hideId ?? ''}|${ask.fromId}`,
    released,
    companyId: ask.companyId,
    siteId: ask.siteId,
    kind: 'PUT_AWAY',
    source: ask.source,
    itemId: lot.itemId,
    itemColourId: lot.itemColourId,
    lotId: lot.id,
    hideId: ask.hideId ?? null,
    fromLocationId: ask.fromId,
    toLocationId: suggestion?.location.id ?? null,
    quantity,
    uom: item.baseUom as string,
  }
}

/** The wanted put-aways that have no open put-away of the same goods from the same place yet. */
async function missing(db: Reader, siteId: string, wanted: readonly Wanted[]): Promise<Wanted[]> {
  if (wanted.length === 0) return []
  const open = await db.warehouseTask.findMany({ where: { siteId, kind: 'PUT_AWAY', status: { in: OPEN }, lotId: { in: [...new Set(wanted.map((entry) => entry.lotId!))] } }, select: { lotId: true, hideId: true, fromLocationId: true } })
  const have = new Set(open.map((row) => `${row.lotId}|${row.hideId ?? ''}|${row.fromLocationId}`))
  // A lot's own put-away covers its hides there too.
  const lotWide = new Set(open.filter((row) => row.hideId === null).map((row) => `${row.lotId}||${row.fromLocationId}`))
  return wanted.filter((entry) => !have.has(entry.key) && !lotWide.has(`${entry.lotId}||${entry.fromLocationId}`))
}

/** The task itself (what a source keeps beside it for its plan left out). */
function draftOf(entry: Wanted): TaskDraft {
  const { key, released, ...draft } = entry
  void key
  void released
  return draft
}

async function make(caller: CommandCaller, event: EventEnvelope, siteId: string, wanted: readonly Wanted[]): Promise<void> {
  if (wanted.length === 0) return
  await sourceCommand(caller, 'receipts', event, { lots: wanted.map((entry) => entry.key) }, async (tools) => {
    // Read again in the command: a job handed over twice makes nothing twice.
    for (const entry of await missing(tools.tx, siteId, wanted)) await createTaskInCommand(tools, draftOf(entry))
  })
}

async function onReceipt(caller: CommandCaller, event: EventEnvelope): Promise<void> {
  const payload = event.payload as { receiptId: string; purchaseOrderId: string | null; moveIds: string[] }
  const read = await caller.withClient(async (client) => {
    const db = client as unknown as Reader
    const receipt = await db.goodsReceipt.findUnique({ where: { id: payload.receiptId }, select: { id: true, number: true, companyId: true, siteId: true, status: true } })
    if (!receipt || receipt.status !== 'POSTED') return null
    const moves = await db.stockMove.findMany({ where: { id: { in: payload.moveIds } }, select: { lotId: true, toLocationId: true, createdById: true, deviceId: true }, orderBy: { id: 'asc' } })
    const docks = new Set((await db.location.findMany({ where: { id: { in: moves.flatMap((move) => (move.toLocationId ? [move.toLocationId] : [])) }, kind: 'RECEIVING' }, select: { id: true } })).map((row) => row.id))
    // B-W2b-300 (SCM-122): goods without a PO post into the holding place they waited in: they wait for a put-away there too.
    const holding = (await db.goodsReceipt.findUnique({ where: { id: receipt.id }, select: { holdingLocationId: true } }))?.holdingLocationId
    if (holding) docks.add(holding)
    const pairs = new Map<string, { lotId: string; fromId: string }>()
    for (const move of moves) if (move.lotId && move.toLocationId && docks.has(move.toLocationId)) pairs.set(`${move.lotId}|${move.toLocationId}`, { lotId: move.lotId, fromId: move.toLocationId })
    const wanted: Wanted[] = []
    for (const pair of pairs.values()) {
      const entry = await putAwayOf(db, { companyId: receipt.companyId, siteId: receipt.siteId, lotId: pair.lotId, fromId: pair.fromId, source: { type: 'GoodsReceipt', id: receipt.id } })
      if (entry) wanted.push(entry)
    }
    const receive = payload.purchaseOrderId ? await db.warehouseTask.findMany({ where: { kind: 'RECEIVE', status: { in: OPEN }, sourceType: 'PurchaseOrder', sourceId: payload.purchaseOrderId }, select: { id: true } }) : []
    return { receipt, wanted: await missing(db, receipt.siteId, wanted), receive, by: moves[0] ? posterOf(moves[0]) : null }
  })
  if (!read) return
  await make(caller, event, read.receipt.siteId, read.wanted)
  if (read.receive.length === 0) return
  await sourceCommand(caller, 'receiptReceive', event, { receiptId: read.receipt.id }, async (tools) => {
    for (const { id } of read.receive) {
      const current = await tools.tx.warehouseTask.findUniqueOrThrow({ where: { id }, select: TASK_COLUMNS })
      if (current.status !== 'OPEN' && current.status !== 'TAKEN') continue
      if (read.by) await doneInCommand(tools, current, read.by)
      else await cancelInCommand(tools, current, `Received with receipt ${read.receipt.number}.`)
    }
  })
}

async function onReversed(caller: CommandCaller, event: EventEnvelope): Promise<void> {
  const payload = event.payload as { receiptId: string; number: string }
  const open = await caller.withClient((client) => (client as unknown as Reader).warehouseTask.findMany({ where: { sourceType: 'GoodsReceipt', sourceId: payload.receiptId, status: { in: OPEN } }, select: { id: true } }))
  if (open.length === 0) return
  await sourceCommand(caller, 'receiptReversed', event, { receiptId: payload.receiptId }, async (tools) => {
    for (const { id } of open) {
      const current = await tools.tx.warehouseTask.findUniqueOrThrow({ where: { id }, select: TASK_COLUMNS })
      if (current.status === 'OPEN' || current.status === 'TAKEN') await cancelInCommand(tools, current, `Receipt ${payload.number} was reversed: nothing to put away.`)
    }
  })
}

/** The quarantine places of a site where a lot (or a hide) lies now. */
async function quarantinePlacesOf(db: Reader, siteId: string, itemId: string, lotId: string, hideId: string | null): Promise<string[]> {
  const rows = await readSiteStock(db, siteId, { itemIds: [itemId], lotId, ...(hideId ? { hideId } : {}) })
  const places = new Set((await db.location.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.locationId))] }, kind: 'QUARANTINE' }, select: { id: true } })).map((row) => row.id))
  return [...places].sort()
}

async function onLotReleased(caller: CommandCaller, event: EventEnvelope): Promise<void> {
  const payload = event.payload as { lotId: string }
  const wanted = await caller.withClient(async (client) => {
    const db = client as unknown as Reader
    const lot = await db.lot.findUnique({ where: { id: payload.lotId }, select: { id: true, companyId: true, siteId: true, itemId: true, qualityStatus: true } })
    if (!lot || lot.qualityStatus !== 'RELEASED') return null
    const out: Wanted[] = []
    for (const fromId of await quarantinePlacesOf(db, lot.siteId, lot.itemId, lot.id, null)) {
      const entry = await putAwayOf(db, { companyId: lot.companyId, siteId: lot.siteId, lotId: lot.id, fromId, source: { type: 'Lot', id: lot.id } })
      if (entry) out.push(entry)
    }
    return { siteId: lot.siteId, wanted: await missing(db, lot.siteId, out.filter((entry) => entry.released)) }
  })
  if (wanted) await make(caller, event, wanted.siteId, wanted.wanted)
}

async function onHoldReleased(caller: CommandCaller, event: EventEnvelope): Promise<void> {
  const payload = event.payload as { holdId: string; subjectType: string; subjectIds: string[] }
  if (payload.subjectType !== 'Lot' && payload.subjectType !== 'Hide') return
  const wanted = await caller.withClient(async (client) => {
    const db = client as unknown as Reader
    const hold = await db.qualityHold.findUnique({ where: { id: payload.holdId }, select: { id: true, companyId: true, siteId: true, quarantine: true, quarantineLocationId: true } })
    if (!hold || hold.quarantine !== 'MOVED' || !hold.quarantineLocationId) return null
    const goods =
      payload.subjectType === 'Lot'
        ? payload.subjectIds.map((lotId) => ({ lotId, hideId: null as string | null }))
        : (await db.hide.findMany({ where: { id: { in: payload.subjectIds } }, select: { id: true, lotId: true } })).map((hide) => ({ lotId: hide.lotId, hideId: hide.id as string | null }))
    const out: Wanted[] = []
    for (const good of goods) {
      const entry = await putAwayOf(db, { companyId: hold.companyId, siteId: hold.siteId, lotId: good.lotId, hideId: good.hideId, fromId: hold.quarantineLocationId, source: { type: 'QualityHold', id: hold.id } })
      // Only goods quality let go: a lot still in quarantine or blocked, or held by another hold, waits where it is.
      if (entry?.released) out.push(entry)
    }
    return { siteId: hold.siteId, wanted: await missing(db, hold.siteId, out) }
  })
  if (wanted) await make(caller, event, wanted.siteId, wanted.wanted)
}

export default defineTaskSource({
  name: 'receipts',
  events: ['inventory.receipt_posted', 'inventory.receipt_reversed', 'lot.released', 'quality.hold_released'],
  async handle(caller, event) {
    if (event.type === 'inventory.receipt_posted') await onReceipt(caller, event)
    else if (event.type === 'inventory.receipt_reversed') await onReversed(caller, event)
    else if (event.type === 'lot.released') await onLotReleased(caller, event)
    else if (event.type === 'quality.hold_released') await onHoldReleased(caller, event)
  },
})
