import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { DomainError, InvalidStateError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { whenWords } from '@nexus/factory-domain/planning/schedule/time'
import type { OrderLineFacts } from '@nexus/factory-domain/production/work-orders/cells'
import type { WorkOrderStatus } from '@nexus/factory-domain/production/work-orders/machine'
import type { PlannedOperation } from '@nexus/factory-domain/production/work-orders/spec'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandTx } from '../../../core/command'

/**
 * The work orders' reads (factory-db `WorkOrder`, `WorkOrderSize`, `WorkOrderOperation`, `WorkOrderMaterial`, and what
 * they name: sales order lines and orders, the style, its colourways, the site). Every read names its columns and
 * none selects relations (inside a command's transaction Prisma would send them at once on its one connection); a
 * reader takes the command's transaction or a scoped client, and row-level security decides what it finds.
 */

export type Reader = FactoryClient | CommandTx

/** A calendar day stored as @db.Date. */
export const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
export const dayOrNull = (value: Date | null): BusinessDate | null => (value ? dayOf(value) : null)
export const asDay = (value: BusinessDate): Date => new Date(`${value}T00:00:00.000Z`)
export const dec = (value: { toString(): string } | null | undefined): Decimal => (value === null || value === undefined ? ZERO : new Dec(value.toString()))

export const HEADER = {
  id: true,
  companyId: true,
  siteId: true,
  number: true,
  batchNumber: true,
  kind: true,
  styleId: true,
  styleRevisionId: true,
  labelTemplateId: true,
  status: true,
  dueDate: true,
  priority: true,
  note: true,
  releasedAt: true,
  releasedById: true,
  startedAt: true,
  completedAt: true,
  closedAt: true,
  cancelledAt: true,
  cancelReason: true,
  // B-W2a-46: the work order's own hold (wave 5): why, since when, from which status, under which record.
  heldFromStatus: true,
  heldAt: true,
  holdReason: true,
  holdRecordType: true,
  holdRecordId: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.WorkOrderSelect
export type Header = Prisma.WorkOrderGetPayload<{ select: typeof HEADER }>

export async function readWorkOrder(db: Reader, workOrderId: string): Promise<Header | null> {
  if (!isUuid(workOrderId)) return null
  return db.workOrder.findUnique({ where: { id: workOrderId }, select: HEADER })
}

/** Inside a command on the work order (its row locked by the version bump): it as it is now, in one of `allowed`. */
export async function lockedStatus(tx: CommandTx, workOrderId: string, allowed: readonly WorkOrderStatus[], doing: string): Promise<Header> {
  const row = await readWorkOrder(tx, workOrderId)
  if (!row) throw new InvalidStateError('The work order is gone.')
  if (!allowed.includes(row.status)) throw new InvalidStateError(`Work order ${row.number} is ${row.status}; ${doing} only while it is ${allowed.join(' or ')}.`)
  return row
}

export const STYLE_COLUMNS = { id: true, code: true, name: true, companyId: true, sizes: true, ppeCategory: true, status: true } as const satisfies Prisma.StyleSelect
export type StyleRow = Prisma.StyleGetPayload<{ select: typeof STYLE_COLUMNS }>

export const SITE_COLUMNS = { id: true, companyId: true, code: true, name: true, kind: true, status: true } as const satisfies Prisma.SiteSelect
export type SiteRow = Prisma.SiteGetPayload<{ select: typeof SITE_COLUMNS }>

export const REVISION_COLUMNS = { id: true, styleId: true, revision: true, status: true, labelTemplateId: true, plannedHideYieldPct: true } as const satisfies Prisma.StyleRevisionSelect
export type RevisionRow = Prisma.StyleRevisionGetPayload<{ select: typeof REVISION_COLUMNS }>

export const LABEL_COLUMNS = { id: true, code: true, revision: true, status: true } as const satisfies Prisma.LabelTemplateSelect
export type LabelRow = Prisma.LabelTemplateGetPayload<{ select: typeof LABEL_COLUMNS }>

export async function readRevision(db: Reader, revisionId: string | null): Promise<RevisionRow | null> {
  return revisionId ? db.styleRevision.findUnique({ where: { id: revisionId }, select: REVISION_COLUMNS }) : null
}

/** The style's RELEASED revision today (at most one). */
export const readReleasedRevision = (db: Reader, styleId: string): Promise<RevisionRow | null> =>
  db.styleRevision.findFirst({ where: { styleId, status: 'RELEASED' }, select: REVISION_COLUMNS, orderBy: { revision: 'desc' } })

export async function readLabel(db: Reader, labelTemplateId: string | null): Promise<LabelRow | null> {
  return labelTemplateId ? db.labelTemplate.findUnique({ where: { id: labelTemplateId }, select: LABEL_COLUMNS }) : null
}

// ---- cells -------------------------------------------------------------------------------------------------------------

export interface CellRow {
  readonly id: string
  readonly version: number
  readonly colourwayId: string
  readonly colourwayCode: string
  readonly colourwayName: string
  readonly size: string
  readonly quantity: number
  readonly salesOrderLineId: string
  readonly partyId: string
  readonly lineSeq: number
  readonly salesOrderId: string
}

/** The work order's cells: colourways in code order, sizes in the style's range order (then by code). */
export async function readCells(db: Reader, workOrderId: string, styleSizes: readonly string[]): Promise<CellRow[]> {
  const rows = await db.workOrderSize.findMany({
    where: { workOrderId },
    select: { id: true, version: true, colourwayId: true, size: true, quantity: true, salesOrderLineId: true, partyId: true },
  })
  if (rows.length === 0) return []
  const colourways = await db.colourway.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.colourwayId))] } }, select: { id: true, code: true, name: true } })
  const lines = await db.salesOrderLine.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.salesOrderLineId))] } }, select: { id: true, seq: true, orderId: true } })
  const colourwayOf = new Map(colourways.map((row) => [row.id, row]))
  const lineOf = new Map(lines.map((row) => [row.id, row]))
  const place = (size: string) => {
    const index = styleSizes.indexOf(size)
    return index === -1 ? styleSizes.length : index
  }
  return rows
    .map((row) => ({
      ...row,
      colourwayCode: colourwayOf.get(row.colourwayId)?.code ?? '',
      colourwayName: colourwayOf.get(row.colourwayId)?.name ?? '',
      lineSeq: lineOf.get(row.salesOrderLineId)?.seq ?? 0,
      salesOrderId: lineOf.get(row.salesOrderLineId)?.orderId ?? '',
    }))
    .sort((a, b) => a.colourwayCode.localeCompare(b.colourwayCode) || place(a.size) - place(b.size) || a.size.localeCompare(b.size, undefined, { numeric: true }))
}

export const cellLabel = (cell: Pick<CellRow, 'colourwayCode' | 'size'>): string => `${cell.colourwayCode} ${cell.size}`

// ---- sales orders and their lines ------------------------------------------------------------------------------------

export interface OrderRow {
  readonly id: string
  readonly companyId: string
  readonly number: string
  readonly customerRef: string | null
  readonly status: string
  readonly partyId: string
  readonly partyName: string
  readonly depositRequired: boolean
  readonly quoteVersionId: string | null
  readonly priority: number
  readonly requestedDate: Date | null
  readonly promiseDate: Date | null
}

export async function readOrders(db: Reader, orderIds: Iterable<string>): Promise<OrderRow[]> {
  const ids = [...new Set(orderIds)].filter(isUuid)
  if (ids.length === 0) return []
  const orders = await db.salesOrder.findMany({
    where: { id: { in: ids } },
    select: { id: true, companyId: true, number: true, customerRef: true, status: true, partyId: true, depositRequired: true, quoteVersionId: true, priority: true, requestedDate: true, promiseDate: true },
    orderBy: { number: 'asc' },
  })
  const parties = await db.party.findMany({ where: { id: { in: [...new Set(orders.map((order) => order.partyId))] } }, select: { id: true, legalName: true, tradeName: true } })
  const nameOf = new Map(parties.map((party) => [party.id, party.tradeName ?? party.legalName]))
  return orders.map((order) => ({ ...order, partyName: nameOf.get(order.partyId) ?? '' }))
}

/** A sales order line as the cell rules read it, with what the work order's defaults need. */
export interface LineRow extends OrderLineFacts {
  readonly colourwayCode: string
  readonly measurementProfileId: string | null
  readonly requestedDate: Date | null
  readonly promiseDate: Date | null
  readonly priority: number | null
}

/**
 * These order lines with their size grids and orders, and the pieces of each size already on work orders that are not
 * CANCELLED, other than `exceptWorkOrderId`. A REPAIR work order's cell (B-W2a-12, MES-019) repairs a garment the line
 * sold: it is not production of the line and never counts here.
 */
export async function readOrderLines(db: Reader, lineIds: readonly string[], exceptWorkOrderId?: string): Promise<Map<string, LineRow>> {
  const ids = [...new Set(lineIds)].filter(isUuid)
  if (ids.length === 0) return new Map()
  const lines = await db.salesOrderLine.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      seq: true,
      orderId: true,
      companyId: true,
      partyId: true,
      kind: true,
      styleId: true,
      styleRevisionId: true,
      colourwayId: true,
      measurementProfileId: true,
      siteId: true,
      requestedDate: true,
      promiseDate: true,
      priority: true,
    },
  })
  if (lines.length === 0) return new Map()
  const sizes = await db.salesOrderLineSize.findMany({ where: { lineId: { in: lines.map((line) => line.id) } }, select: { lineId: true, size: true, quantity: true }, orderBy: { id: 'asc' } })
  const taken = await db.workOrderSize.groupBy({
    by: ['salesOrderLineId', 'size'],
    where: { salesOrderLineId: { in: lines.map((line) => line.id) }, workOrder: { status: { not: 'CANCELLED' }, kind: { not: 'REPAIR' } }, ...(exceptWorkOrderId ? { workOrderId: { not: exceptWorkOrderId } } : {}) },
    _sum: { quantity: true },
  })
  const orders = await db.salesOrder.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.orderId))] } }, select: { id: true, number: true, status: true } })
  const colourways = await db.colourway.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.colourwayId))] } }, select: { id: true, code: true } })
  const orderOf = new Map(orders.map((order) => [order.id, order]))
  const colourwayOf = new Map(colourways.map((colourway) => [colourway.id, colourway.code]))
  return new Map(
    lines.map((line) => {
      const onWorkOrders: Record<string, number> = {}
      for (const row of taken) if (row.salesOrderLineId === line.id) onWorkOrders[row.size] = row._sum.quantity ?? 0
      return [
        line.id,
        {
          ...line,
          orderNumber: orderOf.get(line.orderId)?.number ?? '',
          orderStatus: orderOf.get(line.orderId)?.status ?? '',
          colourwayCode: colourwayOf.get(line.colourwayId) ?? '',
          sizes: sizes.filter((size) => size.lineId === line.id).map((size) => ({ size: size.size, quantity: size.quantity })),
          onWorkOrders,
        },
      ]
    }),
  )
}

/**
 * Serialises the cells made from these order lines (two drafts of one line made at once would both take what is
 * open): one transaction-scoped advisory lock per line, taken sorted, so commands that share lines queue in one order.
 */
export async function lockOrderLines(tx: CommandTx, tenantId: string, lineIds: Iterable<string>): Promise<void> {
  for (const lineId of [...new Set(lineIds)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.work-order-line', ${tenantId}::uuid, ${lineId}::uuid), 0))`
  }
}

/** Removes a DRAFT's planned materials (BOM line × cell: the release writes them from the revision and the cells). */
export async function clearDraftMaterials(tx: CommandTx, workOrderId: string): Promise<number> {
  return (await tx.workOrderMaterial.deleteMany({ where: { workOrderId } })).count
}

// ---- a DRAFT's stored operations and the planning board (B-W2a-F3) -------------------------------------------------------

/** What a refusal says when the planning board books an operation that would go away. */
export interface BookedRefusal {
  /** The sentence's subject: what the person does ("The release", "Changing the revision"). */
  readonly doing: string
  /** Only the working plan books them: what to do after "send them back to the tray on the planning board, then …". */
  readonly then: string
  /** A published version books one (it never changes): what to do instead. */
  readonly published: string
}

const OPERATION_COLUMNS = { id: true, seq: true, routingSeq: true, code: true, name: true, standardMinutes: true, scanRequired: true, workCentreId: true } as const

/**
 * The planning board never loses a bar silently: a slot names the operation it books, the database keeps an operation
 * while a slot of any plan names it (ScheduleSlot's foreign key), and a slot never moves to another operation (the
 * …_production_w2a_guards trigger). So an operation that would go away while a slot books it is refused here (409), in
 * words that name each slot and what to do: a slot of the working plan goes back to the tray on the planning board
 * first; a slot of a published version is kept as the floor was given it, for good. Issues `scheduleSlots/<plan
 * kind>/<slot id>`, one per slot.
 */
async function refuseBooked(tx: CommandTx, workOrder: Pick<Header, 'number' | 'siteId'>, operations: readonly { id: string; seq: number; name: string }[], refusal: BookedRefusal): Promise<void> {
  if (operations.length === 0) return
  const slots = await tx.scheduleSlot.findMany({
    where: { workOrderOperationId: { in: operations.map((op) => op.id) } },
    select: { id: true, planKind: true, planVersionId: true, workOrderOperationId: true, lineId: true, workCentreId: true, partyId: true, startAt: true },
    orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
  })
  if (slots.length === 0) return
  const idsOf = (pick: (slot: (typeof slots)[number]) => string | null): string[] => [...new Set(slots.map(pick).filter((value): value is string => value !== null))]
  const site = await tx.site.findUniqueOrThrow({ where: { id: workOrder.siteId }, select: { timezone: true } })
  const lines = new Map((await tx.line.findMany({ where: { id: { in: idsOf((slot) => slot.lineId) } }, select: { id: true, code: true } })).map((row) => [row.id, `line ${row.code}`]))
  const centres = new Map((await tx.workCentre.findMany({ where: { id: { in: idsOf((slot) => slot.workCentreId) } }, select: { id: true, code: true } })).map((row) => [row.id, `work centre ${row.code}`]))
  const parties = new Map((await tx.party.findMany({ where: { id: { in: idsOf((slot) => slot.partyId) } }, select: { id: true, legalName: true, tradeName: true } })).map((row) => [row.id, `workshop ${row.tradeName ?? row.legalName}`]))
  const plans = new Map((await tx.planVersion.findMany({ where: { id: { in: idsOf((slot) => (slot.planKind === 'PUBLISHED' ? slot.planVersionId : null)) } }, select: { id: true, number: true } })).map((row) => [row.id, row.number]))
  const operationOf = new Map(operations.map((op) => [op.id, op]))
  const words = slots.map((slot) => {
    const op = operationOf.get(slot.workOrderOperationId!)!
    const lane = (slot.lineId && lines.get(slot.lineId)) || (slot.workCentreId && centres.get(slot.workCentreId)) || (slot.partyId && parties.get(slot.partyId)) || 'its lane'
    const plan = slot.planKind === 'WORKING' ? 'working plan' : `published v${plans.get(slot.planVersionId) ?? '?'}`
    return `Op ${op.seq} ${op.name} on ${lane} from ${whenWords(slot.startAt.getTime(), site.timezone)} (${plan})`
  })
  const booked = new Set(slots.map((slot) => slot.workOrderOperationId)).size
  const published = slots.some((slot) => slot.planKind === 'PUBLISHED')
  const what = booked === 1 ? 'an operation' : `${booked} operations`
  const fix = published
    ? `A published plan keeps its slots as the floor was given them, so ${booked === 1 ? 'that operation stays' : 'those operations stay'}: ${refusal.published}.`
    : `Send ${slots.length === 1 ? 'it' : 'them'} back to the tray on the planning board (Planning › Planning board), then ${refusal.then}.`
  throw new DomainError(
    'conflict',
    `${refusal.doing} would take away ${what} of work order ${workOrder.number} that the planning board books: ${words.join('; ')}. ${fix}`,
    slots.map((slot, index) => ({ path: `scheduleSlots/${slot.planKind}/${slot.id}`, message: words[index]! })),
  )
}

/**
 * A DRAFT's stored operations brought to `planned` (one per routing step it takes; seq = the step's place): the row of
 * every operation whose routing step stays is KEPT and updated in place — its id, so the planning board's slots that
 * book it stay — to the planned place and copy of the step, at its own work centre while that is still ACTIVE and of
 * the step's kind (a bar on that centre's lane stays right), else at the planned one; an operation whose step goes away
 * is removed (refused while a slot books it, refuseBooked); a step it has no operation for yet is added.
 */
export async function syncDraftOperations(
  tx: CommandTx,
  workOrder: Pick<Header, 'id' | 'number' | 'siteId'>,
  revisionId: string,
  planned: readonly PlannedOperation[],
  actorId: string | null,
  refusal: BookedRefusal,
): Promise<{ kept: number; removed: number; added: number }> {
  const stored = await tx.workOrderOperation.findMany({ where: { workOrderId: workOrder.id }, select: OPERATION_COLUMNS, orderBy: [{ seq: 'asc' }, { id: 'asc' }] })
  const left = [...stored]
  const pairs: { row: (typeof stored)[number]; op: PlannedOperation }[] = []
  const added: PlannedOperation[] = []
  for (const op of planned) {
    const at = left.findIndex((row) => row.routingSeq === op.routingSeq)
    if (at === -1) added.push(op)
    else pairs.push({ row: left.splice(at, 1)[0]!, op })
  }
  await refuseBooked(tx, workOrder, left, refusal)
  if (left.length > 0) await tx.workOrderOperation.deleteMany({ where: { id: { in: left.map((row) => row.id) } } })

  const ownCentres = [...new Set(pairs.filter(({ row, op }) => row.workCentreId !== op.workCentreId).map(({ row }) => row.workCentreId))]
  const usable = new Map(
    (ownCentres.length > 0 ? await tx.workCentre.findMany({ where: { id: { in: ownCentres } }, select: { id: true, kind: true, status: true } }) : [])
      .filter((centre) => centre.status === 'ACTIVE')
      .map((centre) => [centre.id, centre.kind as string]),
  )
  const changed = pairs
    .map(({ row, op }) => ({
      row,
      data: { seq: op.seq, code: op.code, name: op.name, standardMinutes: op.standardMinutes, scanRequired: op.scanRequired, workCentreId: usable.get(row.workCentreId) === op.workCentreKind ? row.workCentreId : op.workCentreId! },
    }))
    .filter(({ row, data }) => row.seq !== data.seq || row.code !== data.code || row.name !== data.name || !new Dec(row.standardMinutes.toString()).eq(data.standardMinutes) || row.scanRequired !== data.scanRequired || row.workCentreId !== data.workCentreId)
  // A place is unique per work order: an operation whose place changes goes through a free place first.
  let free = Math.max(0, ...stored.map((row) => row.seq), ...planned.map((op) => op.seq)) + 1
  for (const { row, data } of changed) {
    await tx.workOrderOperation.update({ where: { id: row.id }, data: { ...data, seq: row.seq === data.seq ? data.seq : free++, version: { increment: 1 } }, select: { id: true } })
  }
  for (const { row, data } of changed) {
    if (row.seq !== data.seq) await tx.workOrderOperation.update({ where: { id: row.id }, data: { seq: data.seq }, select: { id: true } })
  }
  if (added.length > 0) {
    await tx.workOrderOperation.createMany({
      data: added.map((op) => ({
        id: newId(),
        siteId: workOrder.siteId,
        workOrderId: workOrder.id,
        styleRevisionId: revisionId,
        seq: op.seq,
        routingSeq: op.routingSeq,
        code: op.code,
        name: op.name,
        standardMinutes: op.standardMinutes,
        scanRequired: op.scanRequired,
        workCentreId: op.workCentreId!,
        createdById: actorId,
      })),
    })
  }
  return { kept: pairs.length, removed: left.length, added: added.length }
}

/**
 * Removes every stored operation of a DRAFT whose revision changes (an operation copies a routing step of the work
 * order's own revision, both by foreign key, so none can stay) — refused while a slot of the planning board books one.
 */
export async function removeDraftOperations(tx: CommandTx, workOrder: Pick<Header, 'id' | 'number' | 'siteId'>, refusal: BookedRefusal): Promise<number> {
  const stored = await tx.workOrderOperation.findMany({ where: { workOrderId: workOrder.id }, select: { id: true, seq: true, name: true }, orderBy: { seq: 'asc' } })
  if (stored.length === 0) return 0
  await refuseBooked(tx, workOrder, stored, refusal)
  return (await tx.workOrderOperation.deleteMany({ where: { workOrderId: workOrder.id } })).count
}

/** The company has an ACTIVE number series of this kind. */
export async function hasSeries(db: Reader, companyId: string, kind: 'WORK_ORDER' | 'BATCH'): Promise<boolean> {
  return (await db.numberSeries.count({ where: { companyId, kind, status: 'ACTIVE' } })) > 0
}
