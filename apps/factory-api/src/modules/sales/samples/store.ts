import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { WORKORDERS_MANAGE, WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import type { RoundRow, RoundView, ShipmentView } from '@nexus/factory-domain/sales/samples/contracts'
import { SALES_SAMPLES_MANAGE, SALES_SAMPLES_VIEW } from '@nexus/factory-domain/sales/samples/permissions'
import {
  cancelRefusal,
  cellsOf,
  daysLate,
  MANUAL_STAGES,
  piecesOf,
  roundEditRefusal,
  roundLabel,
  shipmentAddRefusal,
  shipmentRemoveRefusal,
  stageMoveRefusal,
  workOrderRefusal,
  type SampleKind,
  type SampleRefusal,
  type SampleStage,
} from '@nexus/factory-domain/sales/samples/rules'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'

/**
 * Sample rounds' rows (B-W2b-246; factory-db samples.prisma, B-W2b-212): who may see which, the columns every read names, how
 * rows become the contracts' views, and the refusal every command throws in words. A round belongs to a company and, when it is
 * for a customer, to that customer: can() checks both (a role limited to some customers sees only their rounds).
 */

export type Reader = FactoryClient | CommandTx

/** A sample-round change refused in words: 409 `conflict` with the issue `refusal/<CODE>`. */
export class SampleRefusedError extends ConflictError {
  override name = 'SampleRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: SampleRefusal) {
    super(refusal.message)
    this.issues = [{ path: `refusal/${refusal.code}`, message: refusal.message }]
  }
}

export const refuse = (refusal: SampleRefusal | null): void => {
  if (refusal) throw new SampleRefusedError(refusal)
}

export function badBody(path: string, message: string): never {
  throw new ValidationError(message, [{ path: `body/${path}`, message }])
}

/**
 * The last net (the lead: "a database refusal never reaches a person as a 500"): a samples guard's own refusal
 * (…_changes_samples_w2b_guards: check_violation 'samples: …', and the work order's 'production: … sample …'), when a write
 * reached it past this module's checks (a race): a 409 in the database's words. Anything else is thrown as it is.
 */
export function databaseRefusal(error: unknown): never {
  const original = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause
  if (original?.originalCode === '23514' && typeof original.originalMessage === 'string') {
    const message = original.originalMessage
    const words = message.startsWith('samples: ') ? message.slice('samples: '.length) : message.startsWith('production: ') && /sample/i.test(message) ? message.slice('production: '.length) : null
    if (words !== null) throw new ConflictError(`${words.charAt(0).toUpperCase()}${words.slice(1)}.`)
  }
  throw error
}

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

/** A round's scope: its company, and its customer when it has one (an internal round: the company only). */
const scopeOf = (row: { readonly companyId: string; readonly partyId: string | null }) => ({ companyId: row.companyId, ...(row.partyId ? { partyId: row.partyId } : {}) })

export const may = (context: OfficeContext, permission: Permission, row: { readonly companyId: string; readonly partyId: string | null }): boolean => can(actorOf(context), permission, scopeOf(row))

export const ROUND_COLUMNS = {
  id: true,
  companyId: true,
  number: true,
  styleId: true,
  revisionId: true,
  kind: true,
  roundNo: true,
  partyId: true,
  cells: true,
  dueDate: true,
  stage: true,
  instructions: true,
  chargeAmountMinor: true,
  chargeCurrency: true,
  decision: true,
  decisionComments: true,
  decidedAt: true,
  decidedVia: true,
  decidedById: true,
  approvalRequestId: true,
  testZones: true,
  testResult: true,
  certificateId: true,
  cancelledAt: true,
  cancelReason: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.SampleRoundSelect
export type RoundData = Prisma.SampleRoundGetPayload<{ select: typeof ROUND_COLUMNS }>

export async function readRoundRow(db: Reader, roundId: string): Promise<RoundData | null> {
  return isUuid(roundId) ? db.sampleRound.findUnique({ where: { id: roundId }, select: ROUND_COLUMNS }) : null
}

/** The round the office caller sees (sales.samples.view, else not found) and acts on with `permission` (else forbidden). */
export async function officeRound(caller: CommandCaller, roundId: string, permission: Permission = SALES_SAMPLES_VIEW): Promise<{ context: OfficeContext; round: RoundData }> {
  const context = officeOf(caller)
  const round = await caller.withClient((db) => readRoundRow(db, roundId))
  if (!round || !may(context, SALES_SAMPLES_VIEW, round)) throw new NotFoundError('Sample round not found.')
  if (!may(context, permission, round)) throw new ForbiddenError('Your role does not keep sample rounds for this company or customer (sales.samples.manage).')
  return { context, round }
}

/** A @db.Date as its day. */
export const dayOrNull = (value: Date | null): BusinessDate | null => (value ? value.toISOString().slice(0, 10) : null)
export const asDay = (value: BusinessDate): Date => new Date(`${value}T00:00:00.000Z`)
const at = (value: Date | null): string | null => (value ? toUtcIso(value) : null)

const byId = <Row extends { id: string }>(rows: readonly Row[]): Map<string, Row> => new Map(rows.map((row) => [row.id, row]))
const ids = (values: readonly (string | null)[]): string[] => [...new Set(values.filter((value): value is string => value !== null))]

/** The rows as the board and the list show them, their references read in one pass. */
export async function roundRowsOf(db: Reader, rows: readonly RoundData[], today: BusinessDate): Promise<RoundRow[]> {
  if (rows.length === 0) return []
  const roundIds = rows.map((row) => row.id)
  const colourwayIds = ids(rows.flatMap((row) => cellsOf(row.cells).map((cell) => cell.colourwayId)))
  const [styles, revisions, parties, colourways, comments, workOrders, shipments] = await Promise.all([
    db.style.findMany({ where: { id: { in: ids(rows.map((row) => row.styleId)) } }, select: { id: true, code: true, name: true } }),
    db.styleRevision.findMany({ where: { id: { in: ids(rows.map((row) => row.revisionId)) } }, select: { id: true, revision: true, status: true } }),
    db.party.findMany({ where: { id: { in: ids(rows.map((row) => row.partyId)) } }, select: { id: true, code: true, legalName: true, tradeName: true } }),
    colourwayIds.length === 0 ? Promise.resolve([]) : db.colourway.findMany({ where: { id: { in: colourwayIds } }, select: { id: true, code: true } }),
    db.sampleComment.groupBy({ by: ['roundId'], where: { roundId: { in: roundIds }, resolved: false }, _count: { _all: true } }),
    db.workOrder.groupBy({ by: ['sampleRoundId'], where: { sampleRoundId: { in: roundIds } }, _count: { _all: true } }),
    db.sampleShipment.groupBy({ by: ['roundId'], where: { roundId: { in: roundIds } }, _count: { _all: true } }),
  ])
  const style = byId(styles)
  const revision = byId(revisions)
  const partyOf = byId(parties)
  const colourway = byId(colourways)
  const openComments = new Map(comments.map((row) => [row.roundId, row._count._all]))
  const madeBy = new Map(workOrders.map((row) => [row.sampleRoundId, row._count._all]))
  const shipped = new Map(shipments.map((row) => [row.roundId, row._count._all]))
  return rows.map((row) => {
    const styleRow = style.get(row.styleId)
    const revisionRow = revision.get(row.revisionId)
    const partyRow = row.partyId ? partyOf.get(row.partyId) : undefined
    const cells = cellsOf(row.cells).map((cell) => ({ colourwayId: cell.colourwayId, colourwayCode: cell.colourwayId ? (colourway.get(cell.colourwayId)?.code ?? null) : null, size: cell.size, quantity: cell.quantity }))
    const dueDate = dayOrNull(row.dueDate)
    return {
      id: row.id,
      number: row.number,
      companyId: row.companyId,
      style: { id: row.styleId, code: styleRow?.code ?? '', name: styleRow?.name ?? '' },
      revision: { id: row.revisionId, revision: revisionRow?.revision ?? 0, status: revisionRow?.status ?? '' },
      kind: row.kind,
      roundNo: row.roundNo,
      label: roundLabel(row.kind as SampleKind, row.roundNo),
      party: partyRow ? { id: partyRow.id, code: partyRow.code, name: partyRow.tradeName ?? partyRow.legalName } : null,
      cells,
      pieces: piecesOf(cells),
      dueDate,
      daysLate: daysLate(row.stage as SampleStage, dueDate, today),
      stage: row.stage,
      decision: row.decision,
      decidedAt: at(row.decidedAt),
      createdById: row.createdById,
      createdAt: toUtcIso(row.createdAt),
      openComments: openComments.get(row.id) ?? 0,
      workOrders: madeBy.get(row.id) ?? 0,
      shipments: shipped.get(row.id) ?? 0,
      chargeAmountMinor: asMoney('price', row.chargeAmountMinor),
      chargeCurrency: row.chargeCurrency,
      version: row.version,
    }
  })
}

export const SHIPMENT_COLUMNS = {
  id: true,
  roundId: true,
  partyId: true,
  direction: true,
  shipToAddressId: true,
  carrierName: true,
  trackingNumber: true,
  trackingUrl: true,
  sentAt: true,
  receivedAt: true,
  note: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.SampleShipmentSelect
export type ShipmentData = Prisma.SampleShipmentGetPayload<{ select: typeof SHIPMENT_COLUMNS }>

export async function shipmentViewsOf(db: Reader, rows: readonly ShipmentData[]): Promise<ShipmentView[]> {
  if (rows.length === 0) return []
  const [parties, addresses] = await Promise.all([
    db.party.findMany({ where: { id: { in: ids(rows.map((row) => row.partyId)) } }, select: { id: true, code: true, legalName: true, tradeName: true } }),
    db.partyAddress.findMany({ where: { id: { in: ids(rows.map((row) => row.shipToAddressId)) } }, select: { id: true, name: true, line1: true, postalCode: true, city: true, country: true } }),
  ])
  const partyOf = byId(parties)
  const addressOf = byId(addresses)
  return rows.map((row) => {
    const partyRow = partyOf.get(row.partyId)
    return {
      id: row.id,
      roundId: row.roundId,
      direction: row.direction,
      party: { id: row.partyId, code: partyRow?.code ?? '', name: partyRow ? (partyRow.tradeName ?? partyRow.legalName) : '' },
      shipToAddress: row.shipToAddressId ? (addressOf.get(row.shipToAddressId) ?? null) : null,
      carrierName: row.carrierName,
      trackingNumber: row.trackingNumber,
      trackingUrl: row.trackingUrl,
      sentAt: at(row.sentAt),
      receivedAt: at(row.receivedAt),
      note: row.note,
      removable: shipmentRemoveRefusal(row) === null,
      createdAt: toUtcIso(row.createdAt),
      version: row.version,
    }
  })
}

const action = (allowedByRole: boolean, refusal: SampleRefusal | null) => ({ allowed: allowedByRole && refusal === null, refusal })

/** The round's record: the row, the request, the decision as recorded, its work orders, shipments, moves and actions for this reader. */
export async function roundViewOf(db: Reader, context: OfficeContext, round: RoundData, today: BusinessDate): Promise<RoundView> {
  const [row] = await roundRowsOf(db, [round], today)
  const [style, released, creator, certificate, workOrders, shipments, measurements, swatches] = await Promise.all([
    db.style.findUniqueOrThrow({ where: { id: round.styleId }, select: { id: true, code: true, name: true, lifecycle: true, status: true, brandPartyId: true } }),
    db.styleRevision.findFirst({ where: { styleId: round.styleId, status: 'RELEASED' }, select: { id: true, revision: true, status: true } }),
    round.createdById ? db.user.findUnique({ where: { id: round.createdById }, select: { id: true, displayName: true } }) : Promise.resolve(null),
    round.certificateId ? db.certificate.findUnique({ where: { id: round.certificateId }, select: { id: true, number: true } }) : Promise.resolve(null),
    db.workOrder.findMany({
      where: { sampleRoundId: round.id },
      select: { id: true, number: true, status: true, companyId: true, siteId: true, dueDate: true, releasedAt: true, startedAt: true, completedAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    db.sampleShipment.findMany({ where: { roundId: round.id }, select: SHIPMENT_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    db.sampleMeasurement.count({ where: { roundId: round.id } }),
    db.sampleSwatch.count({ where: { roundId: round.id } }),
  ])
  const seen = workOrders.filter((workOrder) => can(actorOf(context), WORKORDERS_VIEW, { companyId: workOrder.companyId, siteId: workOrder.siteId }))
  const [sites, cells, lineless] = await Promise.all([
    seen.length === 0 ? Promise.resolve([]) : db.site.findMany({ where: { id: { in: ids(seen.map((workOrder) => workOrder.siteId)) } }, select: { id: true, code: true } }),
    seen.length === 0 ? Promise.resolve([]) : db.workOrderSize.groupBy({ by: ['workOrderId'], where: { workOrderId: { in: seen.map((workOrder) => workOrder.id) } }, _sum: { quantity: true } }),
    // B-W2b-284: the work orders made for no order line (an internal or uncharged round's).
    seen.length === 0 ? Promise.resolve([]) : db.workOrderSize.groupBy({ by: ['workOrderId'], where: { workOrderId: { in: seen.map((workOrder) => workOrder.id) }, salesOrderLineId: null }, _count: { _all: true } }),
  ])
  const siteOf = byId(sites)
  const piecesOfWorkOrder = new Map(cells.map((cell) => [cell.workOrderId, cell._sum.quantity ?? 0]))
  const withoutOrderLine = new Set(lineless.map((row) => row.workOrderId))
  const manage = may(context, SALES_SAMPLES_MANAGE, round)
  const facts = { number: round.number, stage: round.stage as SampleStage }
  const revisionNo = row!.revision.revision
  return {
    ...row!,
    style: { id: style.id, code: style.code, name: style.name, lifecycle: style.lifecycle, status: style.status, brandPartyId: style.brandPartyId },
    releasedRevision: released && released.id !== round.revisionId ? released : null,
    instructions: round.instructions,
    createdBy: creator ? { id: creator.id, name: creator.displayName } : null,
    decisionComments: round.decisionComments,
    decidedVia: round.decidedVia,
    decidedById: round.decidedById,
    approvalRequestId: round.approvalRequestId,
    testZones: round.testZones,
    testResult: round.testResult,
    certificate,
    cancelledAt: at(round.cancelledAt),
    cancelReason: round.cancelReason,
    workOrdersList: seen.map((workOrder) => ({
      id: workOrder.id,
      number: workOrder.number,
      status: workOrder.status,
      site: { id: workOrder.siteId, code: siteOf.get(workOrder.siteId)?.code ?? '' },
      pieces: piecesOfWorkOrder.get(workOrder.id) ?? 0,
      dueDate: dayOrNull(workOrder.dueDate),
      releasedAt: at(workOrder.releasedAt),
      startedAt: at(workOrder.startedAt),
      completedAt: at(workOrder.completedAt),
      withoutOrderLine: withoutOrderLine.has(workOrder.id),
    })),
    workOrdersHeld: workOrders.length - seen.length,
    shipmentsList: await shipmentViewsOf(db, shipments),
    measurements,
    swatches,
    moves: MANUAL_STAGES.map((to) => {
      const refusal = stageMoveRefusal(facts, to)
      return { to, allowed: manage && refusal === null, refusal }
    }),
    actions: {
      edit: action(manage, roundEditRefusal({ ...facts, revision: revisionNo }, [])),
      changeRevision: action(manage, roundEditRefusal({ ...facts, revision: revisionNo }, ['revisionId'])),
      cancel: action(manage, cancelRefusal(facts)),
      makeWorkOrder: action(manage && can(actorOf(context), WORKORDERS_MANAGE, { companyId: round.companyId }), workOrderRefusal(facts)),
      addShipment: action(manage, shipmentAddRefusal(facts)),
    },
  }
}
