import type { Prisma } from '@nexus/factory-db'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { blockedWords, workOrderOnHoldWords, type BlockingHold, type HoldSubjectType } from '@nexus/factory-domain/quality/holds/rules'
import type { CommandTx } from '../../../core/command'
import type { RequestContext } from '../../../core/context'
import { reasonWords } from '../../../platform/reasons/service'

/**
 * What a hold blocks, said in words BEFORE the database's "…_awaits_quality_hold" triggers (and wave 5's work order gate)
 * refuse the same with a check_violation (B-W2a-26; QHS-074, MES-008: "floor devices refuse to start it and show the
 * reason"). One named hook per module, called inside that module's command, after its own locks:
 *
 *   holdOnScan      modules/production/scans: a report or undo of a bundle (and the office's approved correction):
 *                   the work order ON_HOLD (its hold reason), a hold of the bundle or of its work order.
 *   holdOnIssue     modules/inventory/issue (and a disposition's ISSUE): a hold of the lot, the hide or the work order;
 *                   a work order ON_HOLD.
 *   holdOnPacking   modules/shipping/packing: garments put into a parcel, a serial packed, the shipment PACKED: a hold of
 *                   a line's work order, of the shipment, a parcel or a serial.
 *
 * B-W2a-F1 (the hooks B-W2a-26 left: those inserts reached the database's check_violation, a 500):
 *
 *   holdOnCut        modules/production/cutting: a cut (not its reversal): a hold of the hide, of its lot or of the work
 *                    order (CutLog_awaits_quality_hold); the work order ON_HOLD (wave 5's CutLog_awaits_hold).
 *   holdOnBundles    modules/production/bundles: bundles made for a work order ON_HOLD (Bundle_awaits_hold).
 *   holdOnInspection modules/quality/final: a final inspection opened for a work order ON_HOLD (Inspection_awaits_hold).
 *                    An ACTIVE hold of a COMPLETED work order does not stop it: a passed inspection after the hold is
 *                    what releases an inspection's hold.
 *   holdOnRelease    modules/quality/final: garments released: a hold of the work order or of a serial named
 *                    (QualityRelease_ and GarmentSerial_awaits_quality_hold); the work order ON_HOLD (QualityRelease_awaits_hold).
 *   holdOnLabels     modules/production/serials: garment labels printed or printed again for a work order ON_HOLD
 *                    (GarmentLabelPrint_awaits_hold).
 *
 * Each takes the records' hold locks SHARED in id order first ('factory.quality-hold|<tenant>|<id>', the triggers'
 * locks; a scan the work order's gate lock before them, as the triggers' name order does): a hold being placed finishes
 * first and is then seen. Answers null, or the words of the first hold found. Any client the module's command uses: the
 * floor role reads its site's holds, reasons and records.
 */

type Tx = CommandTx

const tenantOf = (context: RequestContext): string => {
  if (!('tenantId' in context) || !context.tenantId) throw new Error('a hold check needs a tenant context')
  return context.tenantId
}

const sorted = (ids: readonly (string | null | undefined)[]): string[] => [...new Set(ids.filter((id): id is string => typeof id === 'string'))].sort()

/** The hold locks of these records, SHARED, in id order (factory_quality_hold_wait's). */
export async function waitForHolds(tx: Tx, tenantId: string, ids: readonly (string | null | undefined)[]): Promise<void> {
  for (const id of sorted(ids)) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(concat_ws('|', 'factory.quality-hold', ${tenantId}::uuid, ${id}::uuid), 0))`
  }
}

/** The work orders' gate locks, SHARED, in id order (wave 5's factory_work_order_gate). */
async function waitForGates(tx: Tx, tenantId: string, ids: readonly (string | null | undefined)[]): Promise<void> {
  for (const id of sorted(ids)) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(concat_ws('|', 'factory.work-order-gate', ${tenantId}::uuid, ${id}::uuid), 0))`
  }
}

const HOLD_SELECT = { id: true, subjectType: true, subjectIds: true, reasonCode: true, placedAt: true } as const satisfies Prisma.QualityHoldSelect
export type ActiveHold = Prisma.QualityHoldGetPayload<{ select: typeof HOLD_SELECT }>

/** The ACTIVE holds of these records of one kind (oldest first). */
export async function activeHoldsOf(tx: Pick<Tx, 'qualityHold'>, subjectType: HoldSubjectType, ids: readonly (string | null | undefined)[]): Promise<ActiveHold[]> {
  const wanted = sorted(ids)
  if (wanted.length === 0) return []
  return tx.qualityHold.findMany({ where: { status: 'ACTIVE', subjectType, subjectIds: { hasSome: wanted } }, select: HOLD_SELECT, orderBy: [{ placedAt: 'asc' }, { id: 'asc' }] })
}

/** The words of a HOLD reason (else its code). */
async function reasonOf(tx: Tx, code: string): Promise<string> {
  return (await reasonWords(tx, 'HOLD')).get(code)?.labelEn ?? code
}

async function blocking(tx: Tx, hold: ActiveHold, subjectType: HoldSubjectType, label: string): Promise<BlockingHold> {
  return { holdId: hold.id, subjectType, label, reason: await reasonOf(tx, hold.reasonCode), placedAt: toUtcIso(hold.placedAt) }
}

/** A refusal of the scans' shape (factory-domain production/scans/rules ScanRefusal's words and fix). */
export interface HoldRefusal {
  readonly holdId: string | null
  readonly message: string
  readonly fix: string
}

const SCAN_FIX = 'Put the bundle aside and ask quality: the hold is released in the office.'

/** A scan of a bundle (report, undo, an approved correction): its work order ON_HOLD, a hold of the bundle or the work order. */
export async function holdOnScan(tx: Tx, context: RequestContext, subject: { readonly bundleId: string; readonly workOrderId: string }): Promise<HoldRefusal | null> {
  const tenantId = tenantOf(context)
  await waitForGates(tx, tenantId, [subject.workOrderId])
  await waitForHolds(tx, tenantId, [subject.bundleId, subject.workOrderId])
  const workOrder = await tx.workOrder.findUnique({ where: { id: subject.workOrderId }, select: { number: true, status: true, holdReason: true } })
  const bundleHold = (await activeHoldsOf(tx, 'Bundle', [subject.bundleId]))[0]
  if (bundleHold) {
    const bundle = await tx.bundle.findUnique({ where: { id: subject.bundleId }, select: { code: true } })
    return { holdId: bundleHold.id, message: blockedWords(await blocking(tx, bundleHold, 'Bundle', bundle?.code ?? ''), 'it is not scanned'), fix: SCAN_FIX }
  }
  const orderHold = (await activeHoldsOf(tx, 'WorkOrder', [subject.workOrderId]))[0]
  if (orderHold) return { holdId: orderHold.id, message: blockedWords(await blocking(tx, orderHold, 'WorkOrder', workOrder?.number ?? ''), 'its bundles are not scanned'), fix: SCAN_FIX }
  if (workOrder?.status === 'ON_HOLD') return { holdId: null, message: workOrderOnHoldWords(workOrder.number, workOrder.holdReason, 'its bundles are not scanned'), fix: SCAN_FIX }
  return null
}

/** An issue of stock to a work order: a hold of the lot, the hide or the work order; the work order ON_HOLD. */
export async function holdOnIssue(tx: Tx, context: RequestContext, subject: { readonly lotId: string | null; readonly hideId: string | null; readonly workOrderId: string | null }): Promise<string | null> {
  const tenantId = tenantOf(context)
  await waitForHolds(tx, tenantId, [subject.lotId, subject.hideId, subject.workOrderId])
  const lotHold = (await activeHoldsOf(tx, 'Lot', [subject.lotId]))[0]
  if (lotHold) {
    const lot = await tx.lot.findUnique({ where: { id: subject.lotId! }, select: { code: true } })
    return blockedWords(await blocking(tx, lotHold, 'Lot', lot?.code ?? ''), 'its stock is not issued')
  }
  const hideHold = (await activeHoldsOf(tx, 'Hide', [subject.hideId]))[0]
  if (hideHold) {
    const hide = await tx.hide.findUnique({ where: { id: subject.hideId! }, select: { code: true } })
    return blockedWords(await blocking(tx, hideHold, 'Hide', hide?.code ?? ''), 'it is not issued')
  }
  if (!subject.workOrderId) return null
  const workOrder = await tx.workOrder.findUnique({ where: { id: subject.workOrderId }, select: { number: true, status: true, holdReason: true } })
  const orderHold = (await activeHoldsOf(tx, 'WorkOrder', [subject.workOrderId]))[0]
  if (orderHold) return blockedWords(await blocking(tx, orderHold, 'WorkOrder', workOrder?.number ?? ''), 'nothing is issued to it')
  if (workOrder?.status === 'ON_HOLD') return workOrderOnHoldWords(workOrder.number, workOrder.holdReason, 'nothing is issued to it')
  return null
}

/** The words of a work order ON_HOLD (wave 5's gate), read after its gate lock; null when it is not held. */
async function onHoldWords(tx: Tx, tenantId: string, workOrderId: string, what: string): Promise<string | null> {
  await waitForGates(tx, tenantId, [workOrderId])
  const workOrder = await tx.workOrder.findUnique({ where: { id: workOrderId }, select: { number: true, status: true, holdReason: true } })
  return workOrder?.status === 'ON_HOLD' ? workOrderOnHoldWords(workOrder.number, workOrder.holdReason, what) : null
}

/** A cut of a hide for a work order (not a reversal): a hold of the hide, of its lot or of the work order; the work order ON_HOLD. */
export async function holdOnCut(tx: Tx, context: RequestContext, subject: { readonly hideId: string; readonly lotId: string | null; readonly workOrderId: string }): Promise<string | null> {
  const tenantId = tenantOf(context)
  // The triggers' order: the work order's gate (CutLog_awaits_hold), then the hold locks (CutLog_awaits_quality_hold).
  await waitForGates(tx, tenantId, [subject.workOrderId])
  await waitForHolds(tx, tenantId, [subject.lotId, subject.hideId, subject.workOrderId])
  const hideHold = (await activeHoldsOf(tx, 'Hide', [subject.hideId]))[0]
  if (hideHold) {
    const hide = await tx.hide.findUnique({ where: { id: subject.hideId }, select: { code: true } })
    return blockedWords(await blocking(tx, hideHold, 'Hide', hide?.code ?? ''), 'it is not cut')
  }
  const lotHold = (await activeHoldsOf(tx, 'Lot', [subject.lotId]))[0]
  if (lotHold) {
    const lot = await tx.lot.findUnique({ where: { id: subject.lotId! }, select: { code: true } })
    return blockedWords(await blocking(tx, lotHold, 'Lot', lot?.code ?? ''), 'its hides are not cut')
  }
  const orderHold = (await activeHoldsOf(tx, 'WorkOrder', [subject.workOrderId]))[0]
  if (orderHold) {
    const workOrder = await tx.workOrder.findUnique({ where: { id: subject.workOrderId }, select: { number: true } })
    return blockedWords(await blocking(tx, orderHold, 'WorkOrder', workOrder?.number ?? ''), 'nothing is cut for it')
  }
  return onHoldWords(tx, tenantId, subject.workOrderId, 'nothing is cut for it')
}

/** Bundles made for a work order (the make; a split says its own words): the work order ON_HOLD. */
export async function holdOnBundles(tx: Tx, context: RequestContext, subject: { readonly workOrderId: string }): Promise<string | null> {
  return onHoldWords(tx, tenantOf(context), subject.workOrderId, 'no bundle is made for it')
}

/** A final inspection opened for a work order: the work order ON_HOLD. */
export async function holdOnInspection(tx: Tx, context: RequestContext, subject: { readonly workOrderId: string }): Promise<string | null> {
  return onHoldWords(tx, tenantOf(context), subject.workOrderId, 'its garments are not inspected')
}

/** Garment labels printed, or printed again, for a work order: the work order ON_HOLD. */
export async function holdOnLabels(tx: Tx, context: RequestContext, subject: { readonly workOrderId: string }): Promise<string | null> {
  return onHoldWords(tx, tenantOf(context), subject.workOrderId, 'its garment labels are not printed')
}

/** What a release refusal is about: the work order (its hold, or ON_HOLD) or a serial named. */
export interface ReleaseHold {
  readonly subjectType: 'WorkOrder' | 'GarmentSerial'
  readonly message: string
}

/** Garments of a work order released (a cell, its serials named): a hold of the work order or of a serial; the work order ON_HOLD. */
export async function holdOnRelease(tx: Tx, context: RequestContext, subject: { readonly workOrderId: string; readonly serialIds?: readonly string[] }): Promise<ReleaseHold | null> {
  const tenantId = tenantOf(context)
  const serials = sorted(subject.serialIds ?? [])
  // The triggers' order: the work order's gate (QualityRelease_awaits_hold), then the hold locks.
  await waitForGates(tx, tenantId, [subject.workOrderId])
  await waitForHolds(tx, tenantId, [subject.workOrderId, ...serials])
  const workOrder = await tx.workOrder.findUnique({ where: { id: subject.workOrderId }, select: { number: true, status: true, holdReason: true } })
  const orderHold = (await activeHoldsOf(tx, 'WorkOrder', [subject.workOrderId]))[0]
  if (orderHold) return { subjectType: 'WorkOrder', message: blockedWords(await blocking(tx, orderHold, 'WorkOrder', workOrder?.number ?? ''), 'its garments are not released') }
  const serialHold = (await activeHoldsOf(tx, 'GarmentSerial', serials))[0]
  if (serialHold) {
    const serial = await tx.garmentSerial.findFirst({ where: { id: { in: serialHold.subjectIds.filter((id) => serials.includes(id)) } }, select: { serial: true } })
    return { subjectType: 'GarmentSerial', message: blockedWords(await blocking(tx, serialHold, 'GarmentSerial', serial?.serial ?? ''), 'it is not released') }
  }
  if (workOrder?.status === 'ON_HOLD') return { subjectType: 'WorkOrder', message: workOrderOnHoldWords(workOrder.number, workOrder.holdReason, 'its garments are not released') }
  return null
}

/**
 * Packing (garments into a parcel, a serial packed, the shipment PACKED): a hold of a work order of the lines, of the
 * shipment, of the parcel, or of a serial.
 */
export async function holdOnPacking(
  tx: Tx,
  context: RequestContext,
  subject: { readonly shipmentId: string; readonly parcelIds?: readonly (string | null)[]; readonly workOrderIds?: readonly string[]; readonly serialIds?: readonly string[] },
): Promise<string | null> {
  const tenantId = tenantOf(context)
  const parcels = sorted(subject.parcelIds ?? [])
  const orders = sorted(subject.workOrderIds ?? [])
  const serials = sorted(subject.serialIds ?? [])
  await waitForHolds(tx, tenantId, [subject.shipmentId, ...parcels, ...orders, ...serials])
  const shipmentHold = (await activeHoldsOf(tx, 'Shipment', [subject.shipmentId]))[0]
  if (shipmentHold) {
    const shipment = await tx.shipment.findUnique({ where: { id: subject.shipmentId }, select: { number: true } })
    return blockedWords(await blocking(tx, shipmentHold, 'Shipment', shipment?.number ?? ''), 'it is neither packed nor shipped')
  }
  const parcelHold = (await activeHoldsOf(tx, 'Parcel', parcels))[0]
  if (parcelHold) {
    const parcel = await tx.parcel.findFirst({ where: { id: { in: parcelHold.subjectIds.filter((id) => parcels.includes(id)) } }, select: { seq: true, shipment: { select: { number: true } } } })
    return blockedWords(await blocking(tx, parcelHold, 'Parcel', parcel ? `${parcel.shipment.number}/${parcel.seq}` : ''), 'nothing is packed into it')
  }
  const orderHold = (await activeHoldsOf(tx, 'WorkOrder', orders))[0]
  if (orderHold) {
    const order = await tx.workOrder.findFirst({ where: { id: { in: orderHold.subjectIds.filter((id) => orders.includes(id)) } }, select: { number: true } })
    return blockedWords(await blocking(tx, orderHold, 'WorkOrder', order?.number ?? ''), 'its garments are not packed')
  }
  const serialHold = (await activeHoldsOf(tx, 'GarmentSerial', serials))[0]
  if (serialHold) {
    const serial = await tx.garmentSerial.findFirst({ where: { id: { in: serialHold.subjectIds.filter((id) => serials.includes(id)) } }, select: { serial: true } })
    return blockedWords(await blocking(tx, serialHold, 'GarmentSerial', serial?.serial ?? ''), 'it is not packed')
  }
  return null
}
