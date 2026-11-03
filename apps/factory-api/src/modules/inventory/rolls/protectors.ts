import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { INVENTORY_PROTECTORS_RECORD } from '@nexus/factory-domain/inventory/rolls/permissions'
import { certificateOf, coverageOf, recallWords, recordProblems, recordRefusal, recordWarnings, withdrawProblems } from '@nexus/factory-domain/inventory/rolls/protectors'
import { QUALITY_LOTS_VIEW } from '@nexus/factory-domain/quality/lab/permissions'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { serverClock } from '../../../core/time'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { certificateCovering } from '../../quality/lab/store'
import { mayAt, officeContextOf, postedBy, stockContextOf, type StockContext } from '../ledger/access'
import { fixed } from '../stock/read-kit'
import { ProtectorRefusedError } from './facts'

/**
 * Protector lots per batch or garment (B-W2b-107; SCM-261; EN 1621-1, -2; Reg. (EU) 2016/425; design floor.operation "Trace
 * protectors and lots per garment", warehouse.lots "Trace tree: protector and trim lots beside", planning.leather "Certified
 * protectors"). A GarmentProtectorLot row says a work order (the batch) or one garment serial of it holds a protector lot; it
 * records what was built in, so the lot's state and certificate never refuse it (they come back as warnings).
 *
 *   GET  /inventory/work-orders/:workOrderId/protector-lots   office (workorders.view): the batch's protectors (its BOM's
 *   GET  /inventory/protector-lots/work-orders/:workOrderId   floor (inventory.protectors.record, its own site): protector
 *                                                             lines) against the live records, the records with each lot's
 *                                                             certificate, and the protector lots issued to it (what to pick
 *                                                             from). The office answer also names the register certificate
 *                                                             that covers the protector today.
 *   POST /inventory/protector-lots                            office + floor (inventory.protectors.record): a batch or one
 *                                                             garment (by id or its scanned serial) holds a lot (by id or its
 *                                                             scanned code), at a placement. ONE command under the work
 *                                                             order's protector lock; refused in words (nothing built, not
 *                                                             its garment, a voided garment, not a protector, recorded
 *                                                             already); the warnings in the answer.
 *   POST /inventory/protector-lots/:rowId/withdraw            office (inventory.protectors.record): a wrong record withdrawn
 *                                                             at its version, with the reason; never changed or deleted.
 *   GET  /inventory/lots/:lotId/protector-recall              office (quality.lots.view): which batches and garments hold a
 *                                                             protector lot, the work orders it was issued to without a
 *                                                             record, the certificate, and the concern the PPE register's
 *                                                             trace takes (POST /compliance/register/trace).
 *
 * Every write: audit rows on the record and protector_lot.recorded | withdrawn. No person is named; no money.
 */

const today = (): BusinessDate => businessDate(serverClock.now())
const dayOf = (value: Date | null): BusinessDate | null => (value === null ? null : value.toISOString().slice(0, 10))

const WORK_ORDER_SELECT = { id: true, companyId: true, siteId: true, number: true, batchNumber: true, status: true, style: { select: { code: true, name: true } } } as const satisfies Prisma.WorkOrderSelect
type WorkOrderRow = Prisma.WorkOrderGetPayload<{ select: typeof WORK_ORDER_SELECT }>

const ROW_SELECT = {
  id: true,
  siteId: true,
  workOrderId: true,
  garmentSerialId: true,
  itemId: true,
  lotId: true,
  placement: true,
  voidedAt: true,
  voidReason: true,
  version: true,
  createdAt: true,
  garmentSerial: { select: { id: true, serial: true, status: true } },
  lot: { select: { id: true, code: true, supplierLotRef: true, qualityStatus: true, companyId: true, item: { select: { id: true, code: true, name: true, kind: true, isPpeComponent: true } } } },
} as const satisfies Prisma.GarmentProtectorLotSelect
type ProtectorRow = Prisma.GarmentProtectorLotGetPayload<{ select: typeof ROW_SELECT }>

const LOT_SELECT = { id: true, code: true, supplierLotRef: true, qualityStatus: true, companyId: true, siteId: true, itemId: true, item: { select: { id: true, code: true, name: true, kind: true, isPpeComponent: true } } } as const satisfies Prisma.LotSelect
type LotRow = Prisma.LotGetPayload<{ select: typeof LOT_SELECT }>

type Reader = FactoryClient | CommandTx

/** The ACTIVE PPE certificates of these lots: the last day each is valid. */
async function certificatesOf(db: Pick<CommandTx, 'lotDocument'>, lotIds: readonly string[]): Promise<Map<string, { validTo: BusinessDate | null }[]>> {
  const result = new Map<string, { validTo: BusinessDate | null }[]>()
  const unique = [...new Set(lotIds)]
  if (unique.length === 0) return result
  for (const row of await db.lotDocument.findMany({ where: { lotId: { in: unique }, kind: 'PPE_CERTIFICATE', status: 'ACTIVE' }, select: { lotId: true, validTo: true } })) {
    result.set(row.lotId, [...(result.get(row.lotId) ?? []), { validTo: dayOf(row.validTo) }])
  }
  return result
}

const certificateView = (lot: { readonly id: string; readonly item: { readonly isPpeComponent: boolean } }, certificates: ReadonlyMap<string, { validTo: BusinessDate | null }[]>, day: BusinessDate) =>
  certificateOf({ isPpeComponent: lot.item.isPpeComponent, documents: certificates.get(lot.id) ?? [] }, day)

/** What the work order holds of each lot of these items: its ISSUE moves less what came back (RETURN, REMNANT, reversals). */
async function issuedLots(db: Pick<CommandTx, 'stockMove'>, siteId: string, workOrderId: string, itemIds: readonly string[] | null): Promise<Map<string, Decimal>> {
  const where: Prisma.StockMoveWhereInput = { siteId, workOrderId, lotId: { not: null }, ...(itemIds ? { itemId: { in: [...itemIds] } } : {}) }
  const out = await db.stockMove.groupBy({ by: ['lotId'], where: { ...where, fromLocationId: { not: null }, toLocationId: null }, _sum: { baseQuantity: true } })
  const back = await db.stockMove.groupBy({ by: ['lotId'], where: { ...where, fromLocationId: null, toLocationId: { not: null } }, _sum: { baseQuantity: true } })
  const net = new Map<string, Decimal>()
  for (const row of out) net.set(row.lotId!, (net.get(row.lotId!) ?? ZERO).plus(row._sum.baseQuantity?.toString() ?? '0'))
  for (const row of back) net.set(row.lotId!, (net.get(row.lotId!) ?? ZERO).minus(row._sum.baseQuantity?.toString() ?? '0'))
  return net
}

/** Was the lot ever issued to the work order (an ISSUE move naming both, reversed or not)? */
const everIssued = async (db: Pick<CommandTx, 'stockMove'>, workOrderId: string, lotId: string): Promise<boolean> => (await db.stockMove.count({ where: { workOrderId, lotId, reason: 'ISSUE' } })) > 0

function rowView(row: ProtectorRow, certificates: ReadonlyMap<string, { validTo: BusinessDate | null }[]>, day: BusinessDate) {
  return {
    id: row.id,
    workOrderId: row.workOrderId,
    garmentSerial: row.garmentSerial ? { id: row.garmentSerial.id, serial: row.garmentSerial.serial, status: row.garmentSerial.status } : null,
    item: { id: row.lot.item.id, code: row.lot.item.code, name: row.lot.item.name },
    lot: { id: row.lot.id, code: row.lot.code, supplierLotRef: row.lot.supplierLotRef, qualityStatus: row.lot.qualityStatus },
    placement: row.placement,
    certificate: certificateView(row.lot, certificates, day),
    withdrawn: row.voidedAt ? { at: toUtcIso(row.voidedAt), reason: row.voidReason ?? '' } : null,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
  }
}

/** The work order the caller reads or records for: office with `permission` at its site (else not found), floor its own site. */
async function workOrderFor(caller: CommandCaller, workOrderId: string, permission: Parameters<typeof mayAt>[1]): Promise<{ workOrder: WorkOrderRow; context: StockContext }> {
  const context = stockContextOf(caller)
  const workOrder = isUuid(workOrderId) ? await caller.withClient((client) => client.workOrder.findUnique({ where: { id: workOrderId }, select: WORK_ORDER_SELECT })) : null
  if (!workOrder || !mayAt(context, permission, workOrder)) throw new NotFoundError('Work order not found.')
  return { workOrder, context }
}

/** GET /inventory/work-orders/:workOrderId/protector-lots (office) and /inventory/protector-lots/work-orders/:id (floor). */
export async function batchProtectors(caller: CommandCaller, workOrderId: string) {
  const audience = stockContextOf(caller).audience
  const { workOrder } = await workOrderFor(caller, workOrderId, audience === 'office' ? WORKORDERS_VIEW : INVENTORY_PROTECTORS_RECORD)
  const context = stockContextOf(caller)
  return caller.withClient((client) => batchView(client, workOrder, context))
}

async function batchView(db: Reader, workOrder: WorkOrderRow, context: StockContext) {
  const day = today()
  const planned = await db.workOrderMaterial.findMany({ where: { workOrderId: workOrder.id }, select: { itemId: true } })
  const plannedIds = [...new Set(planned.map((line) => line.itemId))]
  const protectorItems = plannedIds.length ? await db.item.findMany({ where: { id: { in: plannedIds }, OR: [{ kind: 'PROTECTOR' }, { isPpeComponent: true }] }, select: { id: true, code: true, name: true, isPpeComponent: true } }) : []
  const rows = await db.garmentProtectorLot.findMany({ where: { workOrderId: workOrder.id }, select: ROW_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const issued = await issuedLots(db, workOrder.siteId, workOrder.id, null)
  const issuedIds = [...issued.keys()]
  const issuedLotRows = issuedIds.length ? await db.lot.findMany({ where: { id: { in: issuedIds }, item: { OR: [{ kind: 'PROTECTOR' }, { isPpeComponent: true }] } }, select: LOT_SELECT }) : []
  const certificates = await certificatesOf(db, [...rows.map((row) => row.lotId), ...issuedLotRows.map((lot) => lot.id)])
  const lines = protectorItems.map((item) => ({ itemId: item.id, code: item.code }))
  const coverage = coverageOf(lines, rows.map((row) => ({ itemId: row.itemId, lotId: row.lotId, garmentSerialId: row.garmentSerialId, voided: row.voidedAt !== null })))
  const itemsById = new Map([...protectorItems.map((item) => [item.id, item] as const), ...rows.map((row) => [row.itemId, row.lot.item] as const)])
  // The register's certificate covering each certified protector today (office only; one read after another on the client).
  const register = new Map<string, Awaited<ReturnType<typeof certificateCovering>>>()
  if (context.audience === 'office') for (const item of protectorItems.filter((entry) => entry.isPpeComponent)) register.set(item.id, await certificateCovering(db, { itemId: item.id, companyId: workOrder.companyId }, day))
  const missing = coverage.filter((entry) => entry.planned && entry.missing)
  return {
    workOrder: { id: workOrder.id, number: workOrder.number, batchNumber: workOrder.batchNumber, status: workOrder.status, style: workOrder.style },
    protectors: coverage.map((entry) => {
      const item = itemsById.get(entry.itemId)
      return {
        item: { id: entry.itemId, code: item?.code ?? entry.code, name: item?.name ?? '' },
        planned: entry.planned,
        batchLotIds: [...entry.batchLotIds],
        garments: entry.garments,
        missing: entry.missing,
        registerCertificate: register.get(entry.itemId) ?? null,
      }
    }),
    records: rows.map((row) => rowView(row, certificates, day)),
    issuedLots: issuedLotRows
      .map((lot) => ({ lot: { id: lot.id, code: lot.code, supplierLotRef: lot.supplierLotRef, qualityStatus: lot.qualityStatus }, item: { id: lot.item.id, code: lot.item.code, name: lot.item.name }, issued: fixed(issued.get(lot.id)), certificate: certificateView(lot, certificates, day) }))
      .sort((a, b) => (a.lot.code < b.lot.code ? -1 : 1)),
    words: missing.length === 0
      ? { it: 'Ogni protezione prevista ha il suo lotto registrato.', en: 'Every protector the batch plans has its lot on record.' }
      : { it: `Senza lotto registrato: ${missing.map((entry) => entry.code).join(', ')}.`, en: `No lot on record for: ${missing.map((entry) => entry.code).join(', ')}.` },
  }
}

// ---- record ---------------------------------------------------------------------------------------------------------------

export interface RecordBody {
  readonly workOrderId: string
  readonly garmentSerialId?: string | undefined
  /** A scanned garment serial (SN-…) instead of the id. */
  readonly serial?: string | undefined
  readonly lotId?: string | undefined
  /** A scanned lot code instead of the id. */
  readonly lotCode?: string | undefined
  readonly placement?: string | null | undefined
}

const invalid = (problems: readonly Issue[], words: string): never => {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))
}

/** The work order's protector lock: two records of one batch take turns (the duplicate check reads under it). */
async function lockProtectors(tx: CommandTx, tenantId: string, workOrderId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.protector-lots', ${tenantId}::uuid, ${workOrderId}::uuid), 0))`
}

/** POST /inventory/protector-lots. */
export async function recordProtector(caller: CommandCaller, body: RecordBody, idempotencyKey?: string) {
  const shape: Issue[] = [...recordProblems(body)]
  if ((body.lotId === undefined) === (body.lotCode === undefined)) shape.push({ path: 'lotId', message: 'Name the lot once: its id or its scanned code.' })
  if (body.garmentSerialId !== undefined && body.serial !== undefined) shape.push({ path: 'serial', message: 'Name the garment once: its id or its scanned serial.' })
  if (shape.length > 0) invalid(shape, 'The record is not valid.')
  const { workOrder, context } = await workOrderFor(caller, body.workOrderId, INVENTORY_PROTECTORS_RECORD)

  const { result } = await command(caller, { name: 'inventory.recordProtectorLot', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    await lockProtectors(tx, context.tenantId, workOrder.id)
    const current = await tx.workOrder.findUniqueOrThrow({ where: { id: workOrder.id }, select: WORK_ORDER_SELECT })
    const serial = body.garmentSerialId || body.serial
      ? await tx.garmentSerial.findFirst({ where: body.garmentSerialId ? { id: isUuid(body.garmentSerialId) ? body.garmentSerialId : newId() } : { serial: body.serial!.trim().toUpperCase() }, select: { id: true, serial: true, workOrderId: true, status: true } })
      : null
    if ((body.garmentSerialId || body.serial) && !serial) invalid([{ path: body.serial ? 'serial' : 'garmentSerialId', message: 'No garment has this serial.' }], 'No garment has this serial.')
    const lot = await tx.lot.findFirst({ where: body.lotId ? { id: isUuid(body.lotId) ? body.lotId : newId() } : { code: body.lotCode!.trim() }, select: LOT_SELECT })
    if (!lot) invalid([{ path: body.lotId ? 'lotId' : 'lotCode', message: 'No lot has this code.' }], 'No lot has this code.')
    const placement = (body.placement ?? '').trim() || null
    const duplicate = (await tx.garmentProtectorLot.count({ where: { workOrderId: current.id, garmentSerialId: serial?.id ?? null, lotId: lot!.id, placement, voidedAt: null } })) > 0
    const refusal = recordRefusal({ workOrder: current, workOrderId: current.id, serial, lot: lot!, item: lot!.item, duplicate })
    if (refusal) throw new ProtectorRefusedError(refusal)
    const id = newId()
    const by = postedBy(context)
    await tx.garmentProtectorLot.create({
      data: { id, siteId: current.siteId, workOrderId: current.id, garmentSerialId: serial?.id ?? null, itemId: lot!.itemId, lotId: lot!.id, placement, createdAt: now, updatedAt: now, createdById: by.audience === 'OFFICE' ? by.createdById : null },
      select: { id: true },
    })
    tools.audit({
      action: 'inventory.recordProtectorLot',
      recordType: 'GarmentProtectorLot',
      recordId: id,
      companyId: current.companyId,
      siteId: current.siteId,
      after: { workOrderId: current.id, garmentSerialId: serial?.id ?? null, serial: serial?.serial ?? null, lotId: lot!.id, lotCode: lot!.code, itemId: lot!.itemId, placement },
    })
    tools.emit({
      type: 'protector_lot.recorded',
      subject: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      payload: { rowId: id, workOrderId: current.id, garmentSerialId: serial?.id ?? null, lotId: lot!.id, itemId: lot!.itemId, postedBy: by.audience },
    })
    const row = await tx.garmentProtectorLot.findUniqueOrThrow({ where: { id }, select: ROW_SELECT })
    const certificates = await certificatesOf(tx, [lot!.id])
    const view = rowView(row, certificates, today())
    const warnings = recordWarnings({ lotCode: lot!.code, workOrderNumber: current.number, certificate: view.certificate.state, qualityStatus: lot!.qualityStatus, issuedToOrder: await everIssued(tx, current.id, lot!.id) })
    return { record: view, warnings }
  })
  return result
}

// ---- withdraw -------------------------------------------------------------------------------------------------------------

/** POST /inventory/protector-lots/:rowId/withdraw. */
export async function withdrawProtector(caller: CommandCaller, rowId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const problems = withdrawProblems(body)
  if (problems.length > 0) invalid(problems, 'Say why.')
  const row = isUuid(rowId) ? await caller.withClient((client) => client.garmentProtectorLot.findUnique({ where: { id: rowId }, select: { ...ROW_SELECT, workOrder: { select: { companyId: true } } } })) : null
  const scope = row ? { companyId: row.workOrder.companyId, siteId: row.siteId } : null
  if (!row || !scope || !(mayAt(context, WORKORDERS_VIEW, scope) || mayAt(context, INVENTORY_PROTECTORS_RECORD, scope))) throw new NotFoundError('Protector record not found.')
  if (!mayAt(context, INVENTORY_PROTECTORS_RECORD, scope)) throw new ForbiddenError("This needs inventory.protectors.record at the work order's site.")
  const reason = body.reason.trim()
  const { result } = await command(caller, { name: 'inventory.withdrawProtectorLot', idempotencyKey, input: { rowId, ...body }, record: { type: 'GarmentProtectorLot', id: row.id, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const current = await tx.garmentProtectorLot.findUniqueOrThrow({ where: { id: row.id }, select: ROW_SELECT })
    if (current.voidedAt) throw new ProtectorRefusedError({ code: 'WITHDRAWN_ALREADY', message: `This record of lot ${current.lot.code} was withdrawn already.` })
    await tx.garmentProtectorLot.update({ where: { id: current.id }, data: { voidedAt: now, voidedById: context.actorId, voidReason: reason, updatedAt: now }, select: { id: true } })
    tools.audit({
      action: 'inventory.withdrawProtectorLot',
      recordType: 'GarmentProtectorLot',
      recordId: current.id,
      companyId: scope.companyId,
      siteId: current.siteId,
      before: { voidedAt: null },
      after: { voidedAt: toUtcIso(now), workOrderId: current.workOrderId, garmentSerialId: current.garmentSerialId, lotId: current.lotId },
      reason,
    })
    tools.emit({
      type: 'protector_lot.withdrawn',
      subject: current.workOrderId,
      companyId: scope.companyId,
      siteId: current.siteId,
      payload: { rowId: current.id, workOrderId: current.workOrderId, garmentSerialId: current.garmentSerialId, lotId: current.lotId },
    })
    const updated = await tx.garmentProtectorLot.findUniqueOrThrow({ where: { id: current.id }, select: ROW_SELECT })
    return { record: rowView(updated, await certificatesOf(tx, [current.lotId]), today()) }
  })
  return result
}

// ---- recall ---------------------------------------------------------------------------------------------------------------

/** GET /inventory/lots/:lotId/protector-recall. */
export async function protectorRecall(caller: CommandCaller, lotId: string) {
  const context = officeContextOf(caller)
  const lot: LotRow | null = isUuid(lotId) ? await caller.withClient((client) => client.lot.findUnique({ where: { id: lotId }, select: LOT_SELECT })) : null
  if (!lot || !mayAt(context, QUALITY_LOTS_VIEW, lot)) throw new NotFoundError('Lot not found.')
  return caller.withClient(async (client) => {
    const day = today()
    const rows = await client.garmentProtectorLot.findMany({ where: { lotId: lot.id, voidedAt: null }, select: { ...ROW_SELECT, workOrder: { select: WORK_ORDER_SELECT } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    const issues = await client.stockMove.findMany({ where: { lotId: lot.id, reason: 'ISSUE', workOrderId: { not: null }, reversalOfId: null, reversals: { none: {} } }, select: { workOrderId: true, baseQuantity: true } })
    const recordedOrders = new Set(rows.map((row) => row.workOrderId))
    const withoutIds = [...new Set(issues.map((move) => move.workOrderId!).filter((id) => !recordedOrders.has(id)))]
    const without = withoutIds.length ? await client.workOrder.findMany({ where: { id: { in: withoutIds } }, select: WORK_ORDER_SELECT, orderBy: { number: 'asc' } }) : []
    const issuedTo = new Map<string, Decimal>()
    for (const move of issues) issuedTo.set(move.workOrderId!, (issuedTo.get(move.workOrderId!) ?? ZERO).plus(new Dec(move.baseQuantity.toString())))
    const batches = new Map<string, { workOrder: WorkOrderRow; placements: Set<string> }>()
    const garments: { serial: { id: string; serial: string; status: string }; workOrder: { id: string; number: string }; placement: string | null }[] = []
    for (const row of rows) {
      if (row.garmentSerial) garments.push({ serial: row.garmentSerial, workOrder: { id: row.workOrder.id, number: row.workOrder.number }, placement: row.placement })
      else {
        const entry = batches.get(row.workOrderId) ?? { workOrder: row.workOrder, placements: new Set<string>() }
        if (row.placement) entry.placements.add(row.placement)
        batches.set(row.workOrderId, entry)
      }
    }
    const certificates = await certificatesOf(client, [lot.id])
    const certificate = certificateOf({ isPpeComponent: lot.item.isPpeComponent, documents: certificates.get(lot.id) ?? [] }, day)
    const register = lot.item.isPpeComponent ? await certificateCovering(client, { itemId: lot.itemId, companyId: lot.companyId }, day) : null
    garments.sort((a, b) => (a.serial.serial < b.serial.serial ? -1 : a.serial.serial > b.serial.serial ? 1 : 0))
    const batchNumbers = [...batches.values()].map((entry) => entry.workOrder.number).sort()
    const serials = garments.map((garment) => garment.serial.serial)
    const withoutNumbers = without.map((order) => order.number)
    const numbers = new Map([...rows.map((row) => [row.workOrderId, row.workOrder.number] as const), ...without.map((order) => [order.id, order.number] as const)])
    const workOrderIds = [...numbers.keys()].sort((a, b) => (numbers.get(a)! < numbers.get(b)! ? -1 : 1))
    return {
      lot: { id: lot.id, code: lot.code, supplierLotRef: lot.supplierLotRef, qualityStatus: lot.qualityStatus, item: { id: lot.item.id, code: lot.item.code, name: lot.item.name } },
      certificate,
      registerCertificate: register,
      batches: [...batches.values()].sort((a, b) => (a.workOrder.number < b.workOrder.number ? -1 : 1)).map((entry) => ({ workOrder: { id: entry.workOrder.id, number: entry.workOrder.number, batchNumber: entry.workOrder.batchNumber, status: entry.workOrder.status, style: entry.workOrder.style }, placements: [...entry.placements].sort() })),
      garments,
      issuedWithoutRecord: without.map((order) => ({ workOrder: { id: order.id, number: order.number, batchNumber: order.batchNumber, status: order.status, style: order.style }, issued: fixed(issuedTo.get(order.id)) })),
      words: { it: recallWords(lot.code, batchNumbers, serials, withoutNumbers, 'it'), en: recallWords(lot.code, batchNumbers, serials, withoutNumbers, 'en') },
      /** What the PPE register's trace takes (POST /compliance/register/trace, with the style the person picks). */
      registerConcern: { lotIds: [lot.id], workOrderIds, serials },
    }
  })
}
