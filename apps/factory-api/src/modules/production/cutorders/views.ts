import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { LengthUom } from '@nexus/factory-domain/inventory/rolls/rolls'
import { acrossLaysWarnings, type AllocationWarning } from '@nexus/factory-domain/production/cutorders/allocation'
import { garmentsPerPly, planWords, ratioText, type CutOrderKind, type CutOrderStatus, type CutTicketStatus, type LayStatus, type PlyRunStatus } from '@nexus/factory-domain/production/cutorders/rules'
import { decimalText, type CutOrderRow, type LayRollRow, type LayRow, type LineRow, type PlyRunRow, type TicketRow } from './store'

/**
 * The answers of cut orders (B-W2b-112): a list row, the record with its lines, lays (their rolls, ticket and ply runs) and
 * tickets, built from the store's rows. Dates are ISO strings (a day as YYYY-MM-DD), lengths decimal strings in the unit beside
 * them. No money, no person.
 */

const day = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null)
const at = (value: Date | null): string | null => (value ? toUtcIso(value) : null)

export function ticketView(row: TicketRow, laySeq: number | null) {
  return {
    id: row.id,
    number: row.number,
    code: row.scanCode,
    status: row.status as CutTicketStatus,
    cutOrderId: row.cutOrderId!,
    layId: row.layId,
    laySeq,
    printedAt: at(row.printedAt),
    startedAt: at(row.startedAt),
    doneAt: at(row.doneAt),
    voidedAt: at(row.voidedAt),
    voidReason: row.voidReason,
    version: row.version,
  }
}
export type TicketView = ReturnType<typeof ticketView>

export function plyRunView(row: PlyRunRow) {
  return {
    id: row.id,
    layId: row.layId,
    seq: row.seq,
    firstPly: row.firstPly,
    lastPly: row.lastPly,
    parts: [...row.parts],
    labelCount: row.labelCount,
    status: row.status as PlyRunStatus,
    printedAt: at(row.printedAt),
    voidedAt: at(row.voidedAt),
    voidReason: row.voidReason,
    version: row.version,
  }
}
export type PlyRunView = ReturnType<typeof plyRunView>

export function layRollView(row: LayRollRow) {
  return {
    id: row.id,
    seq: row.seq,
    rollId: row.rollId,
    code: row.roll.code,
    lotCode: row.roll.lot.code,
    plies: row.plies,
    splices: row.splices,
    endLoss: decimalText(row.endLoss)!,
    endReturned: decimalText(row.endReturned)!,
    state: row.roll.state,
    lengthLeft: decimalText(row.roll.lengthLeft)!,
    uom: row.roll.uom as LengthUom,
    widthCm: decimalText(row.roll.widthCm, 2),
    shade: row.roll.shade,
    shadeGroupId: row.roll.shadeGroupId,
    shrinkageGroup: row.roll.shrinkageGroup,
    version: row.version,
  }
}

function lineView(row: LineRow) {
  const cell = row.workOrderSize
  return {
    id: row.id,
    seq: row.seq,
    workOrder: { id: cell.workOrder.id, number: cell.workOrder.number, batchNumber: cell.workOrder.batchNumber, status: cell.workOrder.status, holdReason: cell.workOrder.holdReason, dueDate: day(cell.workOrder.dueDate) },
    style: cell.workOrder.style,
    colourway: cell.colourway,
    workOrderSizeId: row.workOrderSizeId,
    size: cell.size,
    cellQuantity: cell.quantity,
    quantity: row.quantity,
    ratio: row.ratio,
    plies: row.plies,
    version: row.version,
  }
}

/** The plies a fabric cut order takes: its lines' (they share them); null for leather. */
const pliesOf = (order: CutOrderRow, lines: readonly LineRow[]): number | null => (order.kind === 'FABRIC' ? Math.max(0, ...lines.map((line) => line.plies ?? 0)) : null)

export function summaryView(order: CutOrderRow, lines: readonly LineRow[], lays: readonly LayRow[], tickets: readonly TicketRow[]) {
  const workOrders = new Map<string, { id: string; number: string }>()
  const styles = new Map<string, { id: string; code: string; name: string }>()
  for (const line of lines) {
    workOrders.set(line.workOrderId, { id: line.workOrderId, number: line.workOrderSize.workOrder.number })
    styles.set(line.workOrderSize.workOrder.style.id, line.workOrderSize.workOrder.style)
  }
  const garments = lines.reduce((sum, line) => sum + line.quantity, 0)
  const plies = pliesOf(order, lines)
  const live = lays.filter((lay) => lay.status !== 'CANCELLED')
  const plan = { kind: order.kind as CutOrderKind, lays: live.length, plies, garments }
  const count = (status: string) => tickets.filter((ticket) => ticket.status === status).length
  return {
    id: order.id,
    number: order.number,
    kind: order.kind as CutOrderKind,
    status: order.status as CutOrderStatus,
    companyId: order.companyId,
    siteId: order.siteId,
    material: { item: { id: order.item.id, code: order.item.code, name: order.item.name }, colour: order.itemColour },
    workOrders: [...workOrders.values()],
    styles: [...styles.values()],
    garments,
    plies,
    lays: { count: live.length, cut: live.filter((lay) => lay.status === 'CUT').length, open: live.filter((lay) => lay.status !== 'CUT').length },
    tickets: { open: count('OPEN'), started: count('STARTED'), done: count('DONE') },
    station: order.station ? { id: order.station.id, code: order.station.code, name: order.station.name } : null,
    dueDate: day(order.dueDate),
    releasedAt: at(order.releasedAt),
    cutAt: at(order.cutAt),
    createdAt: toUtcIso(order.createdAt),
    version: order.version,
    words: { it: planWords(plan, 'it'), en: planWords(plan, 'en') },
  }
}
export type CutOrderSummary = ReturnType<typeof summaryView>

export interface RecordParts {
  readonly order: CutOrderRow
  readonly lines: readonly LineRow[]
  readonly lays: readonly LayRow[]
  readonly layRolls: readonly LayRollRow[]
  readonly tickets: readonly TicketRow[]
  readonly plyRuns: readonly PlyRunRow[]
  readonly manage: boolean
}

export function recordView(parts: RecordParts) {
  const { order, lines, lays, layRolls, tickets, plyRuns, manage } = parts
  const status = order.status as CutOrderStatus
  const laySeq = new Map(lays.map((lay) => [lay.id, lay.seq]))
  const ticketViews = tickets.map((ticket) => ticketView(ticket, ticket.layId ? (laySeq.get(ticket.layId) ?? null) : null))
  const layViews = lays.map((lay) => {
    const rolls = layRolls.filter((row) => row.layId === lay.id).map(layRollView)
    const counted = lay.status === 'CHECKED' || lay.status === 'CUT' ? lay.plyCountLeft : null
    return {
      id: lay.id,
      seq: lay.seq,
      plies: lay.plies,
      status: lay.status as LayStatus,
      layLength: decimalText(lay.layLength),
      lengthUom: lay.lengthUom,
      counted,
      checkedAt: at(lay.checkedAt),
      cutAt: at(lay.cutAt),
      cancelledAt: at(lay.cancelledAt),
      cancelReason: lay.cancelReason,
      note: lay.note,
      version: lay.version,
      allocated: rolls.reduce((sum, roll) => sum + roll.plies, 0),
      shade: rolls[0]?.shade ?? null,
      shrinkageGroup: rolls.map((roll) => roll.shrinkageGroup).find((group) => group !== null) ?? null,
      rolls,
      ticket: ticketViews.find((ticket) => ticket.layId === lay.id && ticket.status !== 'VOID') ?? null,
      plyRuns: plyRuns.filter((run) => run.layId === lay.id).map(plyRunView),
    }
  })
  const lineViews = lines.map(lineView)
  const marker =
    order.kind === 'FABRIC' && order.markerName !== null
      ? {
          name: order.markerName,
          length: decimalText(order.markerLength),
          uom: order.markerUom as LengthUom | null,
          widthCm: decimalText(order.markerWidthCm, 2),
          fileId: order.markerFileId,
          ratio: ratioText(lineViews.map((line) => ({ size: line.size, ratio: line.ratio }))),
          garmentsPerPly: garmentsPerPly(lineViews),
        }
      : null
  const warnings: AllocationWarning[] = acrossLaysWarnings(
    layViews.filter((lay) => lay.status !== 'CANCELLED' && lay.rolls.length > 0).map((lay) => lay.rolls.map((roll) => ({ shadeGroupId: roll.shadeGroupId, shade: roll.shade, shrinkageGroup: roll.shrinkageGroup }))),
  )
  const started = tickets.some((ticket) => ticket.status === 'STARTED' || ticket.status === 'DONE')
  return {
    cutOrder: {
      ...summaryView(order, lines, lays, tickets),
      marker,
      markerName: order.markerName,
      note: order.note,
      cancelReason: order.cancelReason,
      cancelledAt: at(order.cancelledAt),
      reconciledAt: at(order.reconciledAt),
    },
    lines: lineViews,
    lays: layViews,
    tickets: ticketViews,
    warnings,
    can: {
      edit: manage && status === 'PLANNED',
      release: manage && status === 'PLANNED',
      backToPlanning: manage && status === 'RELEASED' && !started && lays.every((lay) => lay.status === 'PLANNED' || lay.status === 'CANCELLED'),
      cancel: manage && (status === 'PLANNED' || status === 'RELEASED') && !started,
      allocate: manage && order.kind === 'FABRIC' && (status === 'RELEASED' || status === 'IN_PROGRESS') && lays.some((lay) => lay.status === 'PLANNED'),
    },
  }
}
export type CutOrderRecord = ReturnType<typeof recordView>
