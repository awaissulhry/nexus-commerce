import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { QUALITY_NCR_VIEW } from '@nexus/factory-domain/quality/ncr/permissions'
import {
  REPAIR_LIMITS,
  repairActions,
  reworkRoundOf,
  safetyFailures,
  safetyStateOf,
  statusWords,
  stepsOf,
  type RepairStage,
  type RepairWorkOrder,
  type SafetyChecklist,
  type SafetyFacts,
} from '@nexus/factory-domain/sales/repairs/rules'
import type { CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { sourceDdtsOf } from '../../shipping/ddt/sources-store'

/**
 * The reads of a repair (B-W2a-57): its row, its live repair work order and DDT, the garment its serial names, and the
 * record the screen shows (design sales.returns "Repair order": Intake & photos, Work with the stages, Safety check,
 * Return; the Activity tab is the record's thread, type RepairOrder). Every read names its columns, runs one after
 * another on the client it is given (a command's transaction or a scoped client: row-level security decides what it
 * finds) and carries no amount.
 */

export type Reader = FactoryClient | CommandTx

export const REPAIR_RECORD = 'RepairOrder'

export const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
export const dayOrNull = (value: Date | null): BusinessDate | null => (value ? dayOf(value) : null)
export const asDay = (value: BusinessDate): Date => new Date(`${value}T00:00:00.000Z`)
const iso = (value: Date | null): string | null => (value ? toUtcIso(value) : null)

export const REPAIR_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  partyId: true,
  number: true,
  kind: true,
  returnLineId: true,
  complaintId: true,
  serial: true,
  styleId: true,
  colourwayId: true,
  size: true,
  problem: true,
  stage: true,
  receivedAt: true,
  inboundDdtNumber: true,
  inboundDdtDate: true,
  workOrderId: true,
  repairedAt: true,
  safetyCheckRequired: true,
  safetyChecklist: true,
  safetyCheckResult: true,
  safetyCheckedAt: true,
  safetyCheckedById: true,
  shippedAt: true,
  cancelledAt: true,
  cancelReason: true,
  ownerId: true,
  internalNote: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.RepairOrderSelect

export type RepairRow = Prisma.RepairOrderGetPayload<{ select: typeof REPAIR_COLUMNS }>

export async function readRepair(db: Reader, repairId: string): Promise<RepairRow | null> {
  return db.repairOrder.findUnique({ where: { id: repairId }, select: REPAIR_COLUMNS })
}

export const safetyFactsOf = (repair: Pick<RepairRow, 'safetyCheckRequired' | 'safetyCheckResult' | 'safetyCheckedAt' | 'repairedAt'>): SafetyFacts => ({
  required: repair.safetyCheckRequired,
  result: repair.safetyCheckResult,
  checkedAt: repair.safetyCheckedAt,
  repairedAt: repair.repairedAt,
})

/** The repair's work order, any status (the record's link), and the live one (not CANCELLED) the stage rules read. */
export async function workOrderOf(db: Reader, repair: Pick<RepairRow, 'workOrderId'>): Promise<{ any: { id: string; number: string; status: string } | null; live: RepairWorkOrder | null }> {
  const row = repair.workOrderId ? await db.workOrder.findUnique({ where: { id: repair.workOrderId }, select: { id: true, number: true, status: true } }) : null
  return { any: row, live: row && row.status !== 'CANCELLED' ? { number: row.number, status: row.status } : null }
}

/**
 * B-W2b-16: the repair's earlier work orders (a rework after the repair went back into repair gets its own): the work
 * orders it named before, from the audit rows of production's make (`workorders.createRepair`, `before.workOrderId`),
 * oldest first, without the one it names now.
 */
export async function earlierWorkOrdersOf(db: Reader, repair: Pick<RepairRow, 'id' | 'workOrderId'>): Promise<{ id: string; number: string; status: string }[]> {
  const rows = await db.auditLog.findMany({ where: { recordType: 'RepairOrder', recordId: repair.id, action: 'workorders.createRepair' }, select: { before: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }] })
  const ids = [...new Set(rows.flatMap((row) => {
    const before = (row.before ?? {}) as { workOrderId?: unknown }
    return typeof before.workOrderId === 'string' && before.workOrderId !== repair.workOrderId ? [before.workOrderId] : []
  }))]
  if (ids.length === 0) return []
  const found = new Map((await db.workOrder.findMany({ where: { id: { in: ids } }, select: { id: true, number: true, status: true } })).map((row) => [row.id, row]))
  return ids.flatMap((id) => (found.has(id) ? [found.get(id)!] : []))
}

/** The repair's live DDT (one per repair; B-W2a-17), or null. */
export async function liveDdtOf(db: Reader, repairId: string): Promise<{ id: string; number: string } | null> {
  const { live } = await sourceDdtsOf(db as CommandTx, { type: 'RepairOrder', id: repairId })
  return live[0] ? { id: live[0].id, number: live[0].number } : null
}

// ---- the garment a serial names (design repair.intake "Garment serial (scan or type) → style, size, colour, made on") ----

export interface GarmentFacts {
  readonly serial: string
  readonly styleId: string
  readonly colourwayId: string
  readonly size: string
  /** The customer it was made for (its order line's), to compare with the repair's. */
  readonly partyId: string | null
  readonly madeOn: BusinessDate
  readonly workOrderNumber: string
  readonly batchNumber: string | null
  readonly status: string
}

/** Our garment with this serial (as read from its label), or null when no garment of ours carries it. */
export async function garmentOf(db: Reader, serial: string | null): Promise<GarmentFacts | null> {
  if (!serial || serial.trim() === '') return null
  const row = await db.garmentSerial.findFirst({
    where: { serial: serial.trim() },
    select: { serial: true, status: true, createdAt: true, workOrderSize: { select: { styleId: true, colourwayId: true, size: true, partyId: true, workOrder: { select: { number: true, batchNumber: true } } } } },
  })
  if (!row) return null
  const cell = row.workOrderSize
  return { serial: row.serial, styleId: cell.styleId, colourwayId: cell.colourwayId, size: cell.size, partyId: cell.partyId, madeOn: dayOf(row.createdAt), workOrderNumber: cell.workOrder.number, batchNumber: cell.workOrder.batchNumber, status: row.status }
}

export async function styleOf(db: Reader, styleId: string | null) {
  return styleId ? db.style.findUnique({ where: { id: styleId }, select: { id: true, code: true, name: true, ppeCategory: true, ppeStandard: true } }) : null
}

/** The names of the office people a record names (the owner, who moved a stage, who signed the check). */
export async function peopleOf(db: Reader, ids: readonly (string | null | undefined)[]): Promise<{ id: string; name: string }[]> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string'))]
  if (wanted.length === 0) return []
  return (await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true }, orderBy: { id: 'asc' } })).map((row) => ({ id: row.id, name: row.displayName }))
}

// ---- the record -----------------------------------------------------------------------------------------------------

/** GET /sales/repairs/:repairId: everything the record's tabs show, read now. */
export async function repairView(db: Reader, repair: RepairRow, context: OfficeContext) {
  const [site, party] = [
    await db.site.findUniqueOrThrow({ where: { id: repair.siteId }, select: { id: true, code: true, name: true } }),
    await db.party.findUniqueOrThrow({ where: { id: repair.partyId }, select: { id: true, code: true, legalName: true } }),
  ]
  const style = await styleOf(db, repair.styleId)
  const colourway = repair.colourwayId ? await db.colourway.findUnique({ where: { id: repair.colourwayId }, select: { id: true, code: true, name: true } }) : null
  const garment = await garmentOf(db, repair.serial)
  const line = repair.returnLineId
    ? await db.returnLine.findUnique({ where: { id: repair.returnLineId }, select: { id: true, seq: true, returnId: true, rma: { select: { number: true } } } })
    : null
  const complaint = repair.complaintId ? await db.complaint.findUnique({ where: { id: repair.complaintId }, select: { id: true, number: true, status: true } }) : null
  const workOrder = await workOrderOf(db, repair)
  const events = await db.repairStageEvent.findMany({ where: { repairId: repair.id }, select: { id: true, fromStage: true, stage: true, at: true, note: true, createdById: true }, orderBy: [{ repairVersion: 'asc' }, { at: 'asc' }] })
  const ddts = await db.ddt.findMany({
    where: { sourceType: 'RepairOrder', sourceId: repair.id },
    select: { id: true, number: true, documentDate: true, reason: true, startAt: true, cancellations: { select: { id: true }, take: 1 } },
    orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }],
  })
  const live = ddts.find((ddt) => ddt.cancellations.length === 0) ?? null
  const reworkRound = reworkRoundOf(repair.stage as RepairStage, events.map((event) => ({ from: event.fromStage as RepairStage | null, to: event.stage as RepairStage })))
  const history = repair.serial
    ? await db.repairOrder.findMany({ where: { serial: repair.serial, id: { not: repair.id } }, select: { id: true, number: true, kind: true, stage: true, problem: true, createdAt: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: REPAIR_LIMITS.history })
    : []
  const ncrs = can(actorOf(context), QUALITY_NCR_VIEW, { companyId: repair.companyId }) ? await linkedNcrs(db, repair.id) : []
  const safety = safetyFactsOf(repair)
  const checklist = repair.safetyChecklist as unknown as SafetyChecklist | null
  return {
    id: repair.id,
    number: repair.number,
    companyId: repair.companyId,
    site,
    party,
    kind: repair.kind,
    stage: repair.stage,
    status: statusWords({ stage: repair.stage as RepairStage, ...safety }),
    problem: repair.problem,
    garment: {
      serial: repair.serial,
      style: style ? { id: style.id, code: style.code, name: style.name, ppeCategory: style.ppeCategory } : null,
      colourway,
      size: repair.size,
      /** Our garment with this serial: where and when it was made, and whether it was made for this customer. */
      found: garment ? { madeOn: garment.madeOn, workOrderNumber: garment.workOrderNumber, batchNumber: garment.batchNumber, forThisCustomer: garment.partyId === null || garment.partyId === repair.partyId } : null,
    },
    source: {
      returnLine: line ? { id: line.id, seq: line.seq, returnId: line.returnId, returnNumber: line.rma.number } : null,
      complaint,
    },
    receivedAt: iso(repair.receivedAt),
    inboundDdt: repair.inboundDdtNumber ? { number: repair.inboundDdtNumber, date: dayOrNull(repair.inboundDdtDate) } : null,
    workOrder: workOrder.any,
    /** B-W2b-16: the work orders of earlier rounds (a rework after a failed check gets its own), oldest first. */
    earlierWorkOrders: await earlierWorkOrdersOf(db, repair),
    /** B-W2b-16: back into repair after it was repaired: a new work order may follow a done one. */
    reworkRound,
    repairedAt: iso(repair.repairedAt),
    safety: {
      required: repair.safetyCheckRequired,
      state: safetyStateOf(safety),
      result: repair.safetyCheckResult,
      checklist,
      failures: checklist ? safetyFailures(checklist) : [],
      checkedAt: iso(repair.safetyCheckedAt),
      checkedById: repair.safetyCheckedById,
    },
    shippedAt: iso(repair.shippedAt),
    cancelledAt: iso(repair.cancelledAt),
    cancelReason: repair.cancelReason,
    ownerId: repair.ownerId,
    internalNote: repair.internalNote,
    createdAt: toUtcIso(repair.createdAt),
    createdById: repair.createdById,
    version: repair.version,
    stages: events.map((event) => ({ id: event.id, from: event.fromStage, to: event.stage, at: toUtcIso(event.at), note: event.note, byId: event.createdById })),
    steps: stepsOf(repair.stage as RepairStage, events.map((event) => ({ stage: event.stage as RepairStage, at: event.at }))),
    ddts: ddts.map((ddt) => ({ id: ddt.id, number: ddt.number, documentDate: dayOf(ddt.documentDate), reason: ddt.reason, startAt: toUtcIso(ddt.startAt), live: ddt.cancellations.length === 0 })),
    history: history.map((row) => ({ id: row.id, number: row.number, kind: row.kind, stage: row.stage, problem: row.problem, createdAt: toUtcIso(row.createdAt) })),
    ncrs,
    actions: repairActions({ number: repair.number, stage: repair.stage as RepairStage, workOrder: workOrder.live, liveDdt: live ? { number: live.number } : null, reworkRound, ...safety }),
    people: await peopleOf(db, [repair.ownerId, repair.createdById, repair.safetyCheckedById, ...events.map((event) => event.createdById)]),
  }
}

export type RepairView = Awaited<ReturnType<typeof repairView>>

/** The NCRs the repair is linked to or carries out (B-W2a-47: a repair as an NCR's follow-up). */
async function linkedNcrs(db: Reader, repairId: string): Promise<{ id: string; number: string; stage: string }[]> {
  const links = await db.ncrLink.findMany({ where: { recordType: REPAIR_RECORD, recordId: repairId }, select: { ncrId: true } })
  const followUps = await db.ncrDispositionLine.findMany({ where: { followUpType: REPAIR_RECORD, followUpId: repairId }, select: { ncrId: true } })
  const ids = [...new Set([...links, ...followUps].map((row) => row.ncrId))]
  if (ids.length === 0) return []
  return db.nonconformance.findMany({ where: { id: { in: ids } }, select: { id: true, number: true, stage: true }, orderBy: { number: 'asc' } })
}
