import type { Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { stockActionWords, type DefectClass, type DispositionFollowUp, type DispositionMove, type DispositionOutcome } from '@nexus/factory-domain/quality/defects/rules'
import {
  ageDays,
  containmentOverdue,
  decidedOf,
  decisionState,
  actionOverdue,
  type ContainmentKind,
  type ContainmentStatus,
  type NcrFacts,
  type NcrSource,
  type NcrStage,
} from '@nexus/factory-domain/quality/ncr/rules'
import type { CommandTx } from '../../../core/command'

/**
 * The NCR module's reads (B-W2a-47): the rows (every read names its columns), the facts the stage checks read (its
 * actions, decisions and the holds it decides) and the views of the list, the board and the record. Any client: the
 * command's or the caller's (row-level security scopes both). No cost, no price, no worker's name in a list; the record
 * names who found it (an office user or a worker of the site: their ids).
 */

export type Reader = CommandTx

export const NCR_RECORD = 'Nonconformance'

export const NCR_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  number: true,
  title: true,
  description: true,
  source: true,
  sourceType: true,
  sourceId: true,
  foundAt: true,
  foundOn: true,
  foundById: true,
  foundByWorkerId: true,
  quantityAffected: true,
  quantitySuspect: true,
  uom: true,
  defectCodeId: true,
  severity: true,
  zone: true,
  styleId: true,
  colourwayId: true,
  size: true,
  serial: true,
  workOrderId: true,
  itemId: true,
  lotId: true,
  supplierId: true,
  stage: true,
  ownerId: true,
  containmentDueAt: true,
  containedAt: true,
  decidedAt: true,
  closedAt: true,
  closedById: true,
  closeNote: true,
  closeSignatureSha256: true,
  cancelledAt: true,
  cancelReason: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.NonconformanceSelect
export type NcrRow = Prisma.NonconformanceGetPayload<{ select: typeof NCR_COLUMNS }>

export const ACTION_COLUMNS = {
  id: true,
  ncrId: true,
  seq: true,
  kind: true,
  description: true,
  ownerId: true,
  dueAt: true,
  status: true,
  doneAt: true,
  doneById: true,
  evidenceNote: true,
  recordType: true,
  recordId: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.NcrContainmentActionSelect
export type ActionRow = Prisma.NcrContainmentActionGetPayload<{ select: typeof ACTION_COLUMNS }>

export const DECISION_COLUMNS = {
  id: true,
  ncrId: true,
  seq: true,
  dispositionCodeId: true,
  quantity: true,
  note: true,
  decidedAt: true,
  decidedById: true,
  approvalRequired: true,
  approvedAt: true,
  approvedById: true,
  doneAt: true,
  stockMoveId: true,
  followUpType: true,
  followUpId: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.NcrDispositionLineSelect
export type DecisionRow = Prisma.NcrDispositionLineGetPayload<{ select: typeof DECISION_COLUMNS }>

export const LINK_COLUMNS = { id: true, ncrId: true, recordType: true, recordId: true, note: true, createdAt: true, createdById: true } as const satisfies Prisma.NcrLinkSelect
export type LinkRow = Prisma.NcrLinkGetPayload<{ select: typeof LINK_COLUMNS }>

export const CODE_COLUMNS = { id: true, code: true, labelIt: true, labelEn: true, icon: true, colour: true, outcome: true, stockMoveReason: true, followUp: true, reinspection: true, active: true } as const satisfies Prisma.DispositionCodeSelect
export type CodeRow = Prisma.DispositionCodeGetPayload<{ select: typeof CODE_COLUMNS }>

export const readNcr = (db: Reader, id: string): Promise<NcrRow | null> => (isUuid(id) ? db.nonconformance.findUnique({ where: { id }, select: NCR_COLUMNS }) : Promise.resolve(null))
export const readActions = (db: Reader, ncrIds: readonly string[]): Promise<ActionRow[]> =>
  ncrIds.length === 0 ? Promise.resolve([]) : db.ncrContainmentAction.findMany({ where: { ncrId: { in: [...ncrIds] } }, select: ACTION_COLUMNS, orderBy: [{ ncrId: 'asc' }, { seq: 'asc' }] })
export const readDecisions = (db: Reader, ncrIds: readonly string[]): Promise<DecisionRow[]> =>
  ncrIds.length === 0 ? Promise.resolve([]) : db.ncrDispositionLine.findMany({ where: { ncrId: { in: [...ncrIds] } }, select: DECISION_COLUMNS, orderBy: [{ ncrId: 'asc' }, { seq: 'asc' }] })
export const readLinks = (db: Reader, ncrId: string): Promise<LinkRow[]> => db.ncrLink.findMany({ where: { ncrId }, select: LINK_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })

/** The holds an NCR decides: those that name it, and those placed from it. */
export const readNcrHolds = (db: Reader, ncrId: string) =>
  db.qualityHold.findMany({
    where: { OR: [{ ncrId }, { sourceType: NCR_RECORD, sourceId: ncrId }] },
    select: { id: true, status: true, subjectType: true, subjectIds: true, reasonCode: true, reasonNote: true, placedAt: true, ncrId: true, version: true },
    orderBy: [{ placedAt: 'asc' }, { id: 'asc' }],
  })

/** The NCR row locked (two writes of one NCR take turns: its version bump), at the version the caller read. */
export async function lockNcr(tx: CommandTx, ncrId: string): Promise<{ version: number; stage: NcrStage } | null> {
  const [row] = await tx.$queryRaw<{ version: number; stage: NcrStage }[]>`SELECT "version", "stage"::text AS "stage" FROM "Nonconformance" WHERE "id" = ${ncrId}::uuid FOR UPDATE`
  return row ?? null
}

const byNcr = <Row extends { ncrId: string }>(rows: readonly Row[]): Map<string, Row[]> => {
  const map = new Map<string, Row[]>()
  for (const row of rows) map.set(row.ncrId, [...(map.get(row.ncrId) ?? []), row])
  return map
}

/** The facts the stage checks and the band read, per NCR. */
export function factsOf(row: Pick<NcrRow, 'stage' | 'quantityAffected' | 'uom'>, actions: readonly ActionRow[], decisions: readonly DecisionRow[], activeHolds: number): NcrFacts {
  return {
    stage: row.stage as NcrStage,
    quantityAffected: row.quantityAffected.toString(),
    uom: row.uom,
    actions: actions.map((action) => ({ status: action.status as ContainmentStatus })),
    decisions: decisions.map((decision) => ({ quantity: decision.quantity.toString(), approvalRequired: decision.approvalRequired, approved: decision.approvedAt !== null, done: decision.doneAt !== null })),
    activeHolds,
  }
}

export async function activeHoldCount(db: Reader, ncrId: string): Promise<number> {
  return db.qualityHold.count({ where: { ncrId, status: 'ACTIVE' } })
}

/** Everything the summaries name, read once for many NCRs. */
export async function summaryFactsOf(db: Reader, rows: readonly NcrRow[]) {
  const ids = (pick: (row: NcrRow) => string | null) => [...new Set(rows.map(pick).filter((value): value is string => value !== null))]
  const ncrIds = rows.map((row) => row.id)
  // One query after another: never Promise.all on one transaction client.
  const defects = await db.defectCode.findMany({ where: { id: { in: ids((row) => row.defectCodeId) } }, select: { id: true, code: true, labelIt: true, labelEn: true, icon: true, colour: true } })
  const styles = await db.style.findMany({ where: { id: { in: ids((row) => row.styleId) } }, select: { id: true, code: true, name: true, ppeCategory: true } })
  const colourways = await db.colourway.findMany({ where: { id: { in: ids((row) => row.colourwayId) } }, select: { id: true, code: true, name: true } })
  const workOrders = await db.workOrder.findMany({ where: { id: { in: ids((row) => row.workOrderId) } }, select: { id: true, number: true } })
  const items = await db.item.findMany({ where: { id: { in: ids((row) => row.itemId) } }, select: { id: true, code: true, name: true } })
  const lots = await db.lot.findMany({ where: { id: { in: ids((row) => row.lotId) } }, select: { id: true, code: true } })
  const suppliers = await db.party.findMany({ where: { id: { in: ids((row) => row.supplierId) } }, select: { id: true, code: true, legalName: true, tradeName: true } })
  const actions = await readActions(db, ncrIds)
  const decisions = await readDecisions(db, ncrIds)
  return {
    defects: new Map(defects.map((row) => [row.id, row])),
    styles: new Map(styles.map((row) => [row.id, row])),
    colourways: new Map(colourways.map((row) => [row.id, row])),
    workOrders: new Map(workOrders.map((row) => [row.id, row])),
    items: new Map(items.map((row) => [row.id, row])),
    lots: new Map(lots.map((row) => [row.id, row])),
    suppliers: new Map(suppliers.map((row) => [row.id, row])),
    actions: byNcr(actions),
    decisions: byNcr(decisions),
  }
}
export type SummaryFacts = Awaited<ReturnType<typeof summaryFactsOf>>

/** One NCR as the list and the board show it. */
export function ncrSummary(row: NcrRow, facts: SummaryFacts, now: Date) {
  const actions = facts.actions.get(row.id) ?? []
  const decisions = facts.decisions.get(row.id) ?? []
  const bar = decidedOf(factsOf(row, actions, decisions, 0))
  const defect = row.defectCodeId ? facts.defects.get(row.defectCodeId) : undefined
  const style = row.styleId ? facts.styles.get(row.styleId) : undefined
  const colourway = row.colourwayId ? facts.colourways.get(row.colourwayId) : undefined
  const workOrder = row.workOrderId ? facts.workOrders.get(row.workOrderId) : undefined
  const item = row.itemId ? facts.items.get(row.itemId) : undefined
  const lot = row.lotId ? facts.lots.get(row.lotId) : undefined
  const supplier = row.supplierId ? facts.suppliers.get(row.supplierId) : undefined
  return {
    id: row.id,
    number: row.number,
    companyId: row.companyId,
    siteId: row.siteId,
    title: row.title,
    source: row.source as NcrSource,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    stage: row.stage as NcrStage,
    severity: row.severity as DefectClass,
    defect: defect ? { id: defect.id, code: defect.code, labelEn: defect.labelEn, labelIt: defect.labelIt, icon: defect.icon, colour: defect.colour } : null,
    zone: row.zone,
    foundAt: row.foundAt,
    foundOn: row.foundOn.toISOString(),
    quantityAffected: row.quantityAffected.toString(),
    quantitySuspect: row.quantitySuspect?.toString() ?? null,
    uom: row.uom,
    decided: { decided: bar.decided.toString(), left: bar.left.toString(), words: bar.words },
    style: style ? { id: style.id, code: style.code, name: style.name, ppe: style.ppeCategory !== 'NOT_PPE' } : null,
    colourway: colourway ? { id: colourway.id, code: colourway.code, name: colourway.name } : null,
    size: row.size,
    serial: row.serial,
    workOrder: workOrder ? { id: workOrder.id, number: workOrder.number } : null,
    item: item ? { id: item.id, code: item.code, name: item.name } : null,
    lot: lot ? { id: lot.id, code: lot.code } : null,
    supplier: supplier ? { id: supplier.id, code: supplier.code, name: supplier.tradeName ?? supplier.legalName } : null,
    ownerId: row.ownerId,
    containmentDueAt: row.containmentDueAt?.toISOString() ?? null,
    containmentOverdue: containmentOverdue({ stage: row.stage as NcrStage, containmentDueAt: row.containmentDueAt }, actions.map((action) => ({ status: action.status as ContainmentStatus, dueAt: action.dueAt })), now),
    actions: { open: actions.filter((action) => action.status === 'OPEN').length, done: actions.filter((action) => action.status === 'DONE').length },
    decisionsWaiting: decisions.filter((decision) => decisionState({ approvalRequired: decision.approvalRequired, approved: decision.approvedAt !== null, done: decision.doneAt !== null }) !== 'DONE').length,
    ageDays: ageDays(row.foundOn, now),
    containedAt: row.containedAt?.toISOString() ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}
export type NcrSummaryView = ReturnType<typeof ncrSummary>

// ---- the record's parts -------------------------------------------------------------------------------------------------

export async function actionViews(db: Reader, actions: readonly ActionRow[], now: Date) {
  const files = actions.length === 0 ? [] : await db.storedFile.groupBy({ by: ['recordId'], where: { recordType: 'NcrContainmentAction', recordId: { in: actions.map((action) => action.id) }, status: { not: 'DELETED' } }, _count: { _all: true } })
  const fileCount = new Map(files.map((row) => [row.recordId, row._count._all]))
  const holdIds = actions.flatMap((action) => (action.recordType === 'QualityHold' && action.recordId ? [action.recordId] : []))
  const holds = holdIds.length === 0 ? [] : await db.qualityHold.findMany({ where: { id: { in: holdIds } }, select: { id: true, status: true, subjectType: true, subjectIds: true } })
  const holdOf = new Map(holds.map((hold) => [hold.id, hold]))
  return actions.map((action) => {
    const hold = action.recordType === 'QualityHold' && action.recordId ? holdOf.get(action.recordId) : undefined
    return {
      id: action.id,
      seq: action.seq,
      kind: action.kind as ContainmentKind,
      description: action.description,
      ownerId: action.ownerId,
      dueAt: action.dueAt?.toISOString() ?? null,
      overdue: actionOverdue({ status: action.status as ContainmentStatus, dueAt: action.dueAt }, now),
      status: action.status as ContainmentStatus,
      doneAt: action.doneAt?.toISOString() ?? null,
      doneById: action.doneById,
      evidenceNote: action.evidenceNote,
      files: fileCount.get(action.id) ?? 0,
      record: action.recordType && action.recordId ? { type: action.recordType, id: action.recordId } : null,
      hold: hold ? { id: hold.id, status: hold.status, subjectType: hold.subjectType, count: hold.subjectIds.length } : null,
      version: action.version,
    }
  })
}

/** A decision's follow-up record in words (its number and state), when the caller sees it. */
async function followUpLabels(db: Reader, decisions: readonly DecisionRow[]) {
  const of = (type: string) => decisions.flatMap((decision) => (decision.followUpType === type && decision.followUpId ? [decision.followUpId] : []))
  const reworks = await db.reworkOrder.findMany({ where: { id: { in: of('ReworkOrder') } }, select: { id: true, status: true, quantity: true, workOrder: { select: { number: true } } } })
  const repairs = await db.repairOrder.findMany({ where: { id: { in: of('RepairOrder') } }, select: { id: true, number: true, stage: true } })
  const claims = await db.supplierClaim.findMany({ where: { id: { in: of('SupplierClaim') } }, select: { id: true, number: true, status: true } })
  const labels = new Map<string, { label: string; state: string }>()
  for (const row of reworks) labels.set(row.id, { label: `Rework of ${row.quantity} on ${row.workOrder.number}`, state: row.status })
  for (const row of repairs) labels.set(row.id, { label: row.number, state: row.stage })
  for (const row of claims) labels.set(row.id, { label: row.number, state: row.status })
  return labels
}

export async function decisionViews(db: Reader, decisions: readonly DecisionRow[], viewer: { readonly userId: string; readonly mayApprove: boolean }) {
  const codes = await db.dispositionCode.findMany({ where: { id: { in: [...new Set(decisions.map((decision) => decision.dispositionCodeId))] } }, select: CODE_COLUMNS })
  const codeOf = new Map(codes.map((code) => [code.id, code]))
  const moveIds = decisions.flatMap((decision) => (decision.stockMoveId ? [decision.stockMoveId] : []))
  const moves = moveIds.length === 0 ? [] : await db.stockMove.findMany({ where: { id: { in: moveIds } }, select: { id: true, reason: true, quantity: true, uom: true, reference: true, fromLocation: { select: { code: true } }, toLocation: { select: { code: true } } } })
  const moveOf = new Map(moves.map((move) => [move.id, move]))
  const labels = await followUpLabels(db, decisions)
  return decisions.map((decision) => {
    const code = codeOf.get(decision.dispositionCodeId)
    const approved = decision.approvedAt !== null
    const done = decision.doneAt !== null
    const move = decision.stockMoveId ? moveOf.get(decision.stockMoveId) : undefined
    const followUp = decision.followUpType && decision.followUpId ? { type: decision.followUpType, id: decision.followUpId, label: labels.get(decision.followUpId)?.label ?? null, state: labels.get(decision.followUpId)?.state ?? null } : null
    return {
      id: decision.id,
      seq: decision.seq,
      disposition: code
        ? {
            id: code.id,
            code: code.code,
            labelEn: code.labelEn,
            labelIt: code.labelIt,
            icon: code.icon,
            colour: code.colour,
            outcome: code.outcome as DispositionOutcome,
            stockMoveReason: code.stockMoveReason as DispositionMove | null,
            followUp: code.followUp as DispositionFollowUp | null,
            reinspection: code.reinspection,
            words: stockActionWords({ outcome: code.outcome as DispositionOutcome, stockMoveReason: code.stockMoveReason as DispositionMove | null, followUp: code.followUp as DispositionFollowUp | null, reinspection: code.reinspection }),
          }
        : null,
      quantity: decision.quantity.toString(),
      note: decision.note,
      decidedAt: decision.decidedAt.toISOString(),
      decidedById: decision.decidedById,
      approvalRequired: decision.approvalRequired,
      approvedAt: decision.approvedAt?.toISOString() ?? null,
      approvedById: decision.approvedById,
      state: decisionState({ approvalRequired: decision.approvalRequired, approved, done }),
      /** The caller may approve it: needs approval, not approved, and they did not decide it. */
      mayApprove: viewer.mayApprove && decision.approvalRequired && !approved && decision.decidedById !== viewer.userId,
      doneAt: decision.doneAt?.toISOString() ?? null,
      stockMove: move ? { id: move.id, reason: move.reason, quantity: move.quantity.toString(), uom: move.uom, from: move.fromLocation?.code ?? null, to: move.toLocation?.code ?? null } : decision.stockMoveId ? { id: decision.stockMoveId, reason: null, quantity: null, uom: null, from: null, to: null } : null,
      followUp,
      version: decision.version,
    }
  })
}
