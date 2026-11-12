import { hideAreasOf } from '@nexus/factory-domain/inventory/unplanned/rules'
import type { Phrase } from '../../../_shared/buying/model'
import { phrase } from '../../../_shared/buying/model'
import type { NameLine, ReceptionReport, ReportLine, Serve, Unplanned, UnplannedOrder } from './api'

/**
 * The receipt's W2b-5 depth (B-W2b-300; SCM-119, SCM-122), the pure rules of its screens: the reception report's rows (one per
 * line × demand), which may be chosen and why not, what the reserve sends; goods without a PO's naming draft (the order, a line
 * of it per waiting line, a leather line's hide areas), what holds it and its body; refusals said in our words by their path.
 * Catalogue `warehouse-receiving-depth`.
 */

export const NAMESPACE = 'warehouse-receiving-depth'

// ---- the reception report -------------------------------------------------------------------------------------------------

export interface ServeRow {
  /** `<receiptLineId>|<demand key>`: one demand of one line. */
  readonly id: string
  readonly line: ReportLine
  readonly serve: Serve
}

export const rowIdOf = (line: Pick<ReportLine, 'receiptLineId'>, serve: Pick<Serve, 'key'>): string => `${line.receiptLineId}|${serve.key}`

export function serveRows(report: ReceptionReport | null): ServeRow[] {
  return (report?.lines ?? []).flatMap((line) => line.serves.map((serve) => ({ id: rowIdOf(line, serve), line, serve })))
}

const positive = (value: string): boolean => Number(value) > 0

/** Why a row may not be chosen (a key of the catalogue), or null. */
export function rowHeld(row: ServeRow): string | null {
  if (positive(row.serve.proposed)) return null
  return `reception.held.${row.serve.held ?? 'NOTHING_LEFT'}`
}

/** The rows chosen when the report opens: every demand that has something to take now. */
export const defaultChoice = (rows: readonly ServeRow[]): string[] => rows.filter((row) => rowHeld(row) === null).map((row) => row.id)

/** The chosen rows' work orders and order lines (one demand may serve two lines: counted once). */
export function choiceCounts(rows: readonly ServeRow[], chosen: readonly string[]): { readonly workOrders: number; readonly orders: number; readonly rows: number } {
  const picked = rows.filter((row) => chosen.includes(row.id) && rowHeld(row) === null)
  const keys = new Set(picked.map((row) => row.serve.key))
  return { workOrders: [...keys].filter((key) => key.startsWith('WORK_ORDER:')).length, orders: [...keys].filter((key) => key.startsWith('ORDER_LINE:')).length, rows: picked.length }
}

/** Why the reserve is held now (a catalogue key), or null. */
export function reserveHeld(report: ReceptionReport | null, rows: readonly ServeRow[], chosen: readonly string[], busy: boolean): string | null {
  if (busy) return 'reception.held.busy'
  if (!report) return 'reception.held.loading'
  if (report.held) return `reception.report.${report.held}`
  if (!report.can.reserve) return report.proposals === 0 ? 'reception.held.nothing' : 'reception.held.noReserve'
  if (choiceCounts(rows, chosen).rows === 0) return 'reception.held.choose'
  return null
}

/** Why sending the report alone is held now, or null. */
export function sendHeld(report: ReceptionReport | null, busy: boolean): string | null {
  if (busy) return 'reception.held.busy'
  if (!report) return 'reception.held.loading'
  if (report.held) return `reception.report.${report.held}`
  if (!report.can.send) return 'reception.held.noSend'
  return null
}

export function reserveBody(rows: readonly ServeRow[], chosen: readonly string[], tellBuyer: boolean, note: string) {
  return {
    demands: rows.filter((row) => chosen.includes(row.id) && rowHeld(row) === null).map((row) => ({ receiptLineId: row.line.receiptLineId, key: row.serve.key })),
    tellBuyer,
    note: note.trim() || null,
  }
}

/** What a demand is in words: the work order's number, or the order and its line. */
export const demandLabel = (serve: Serve): string => (serve.workOrder ? serve.workOrder.number : serve.orderLine ? `${serve.orderLine.number} / ${serve.orderLine.seq}` : '—')

/** A refused reserve or send in our words, by the API's issue paths and kind. */
export function reportProblem(paths: readonly string[], error: { kind: string }): Phrase | null {
  if (paths.some((path) => path.includes('/refusal/'))) return phrase('reception.problem.refused')
  if (paths.some((path) => path.startsWith('body/demands'))) return phrase('reception.problem.demand')
  if (error.kind === 'conflict') return phrase('reception.problem.nothing')
  return null
}

// ---- goods without a PO ---------------------------------------------------------------------------------------------------

export interface NamingLine {
  readonly purchaseOrderLineId: string
  readonly supplierLotRef: string
  readonly hideAreas: string
}

export interface NamingDraft {
  readonly orderId: string | null
  /** Per waiting line (its id). */
  readonly lines: Readonly<Record<string, NamingLine>>
}

/** The order's lines each waiting line could go to. */
export const fitsOf = (order: UnplannedOrder | undefined, receiptLineId: string): string[] => order?.fits.find((fit) => fit.receiptLineId === receiptLineId)?.purchaseOrderLineIds ?? []

/** A draft for an order: each waiting line on the one line that fits it (when only one does). */
export function namingFor(unplanned: Unplanned, orderId: string | null): NamingDraft {
  const order = unplanned.orders.find((entry) => entry.id === orderId)
  const lines: Record<string, NamingLine> = {}
  for (const line of unplanned.lines) {
    const fits = fitsOf(order, line.id)
    lines[line.id] = { purchaseOrderLineId: fits.length === 1 ? fits[0]! : '', supplierLotRef: '', hideAreas: '' }
  }
  return { orderId, lines }
}

/** The first order that takes every waiting line, else the first order. */
export function suggestedOrder(unplanned: Unplanned): string | null {
  const full = unplanned.orders.find((order) => unplanned.lines.every((line) => fitsOf(order, line.id).length > 0))
  return (full ?? unplanned.orders[0])?.id ?? null
}

/** Why the naming is held (a catalogue key with its words' params), or null. */
export function namingHeld(unplanned: Unplanned, draft: NamingDraft, busy: boolean): Phrase | null {
  if (busy) return phrase('waiting.held.busy')
  if (!unplanned.can.decide) return phrase('waiting.held.noDecide')
  if (unplanned.orders.length === 0) return phrase('waiting.held.noOrder', { supplier: unplanned.receipt.supplier.name })
  if (!draft.orderId) return phrase('waiting.held.pickOrder')
  for (const line of unplanned.lines) {
    const named = draft.lines[line.id]
    if (!named?.purchaseOrderLineId) return phrase('waiting.held.pickLine', { seq: line.seq, code: line.item.code })
    if (line.item.tracking === 'HIDE' && hideAreasOf(named.hideAreas).problem) return phrase('waiting.held.hides', { seq: line.seq, code: line.item.code })
  }
  return null
}

export function namingBody(unplanned: Unplanned, draft: NamingDraft): { version: number; purchaseOrderId: string; lines: NameLine[] } {
  return {
    version: unplanned.receipt.version,
    purchaseOrderId: draft.orderId!,
    lines: unplanned.lines.map((line) => {
      const named = draft.lines[line.id]!
      return {
        receiptLineId: line.id,
        purchaseOrderLineId: named.purchaseOrderLineId,
        ...(line.item.tracking !== 'NONE' && named.supplierLotRef.trim() ? { supplierLotRef: named.supplierLotRef.trim() } : {}),
        ...(line.item.tracking === 'HIDE' ? { hideAreas: hideAreasOf(named.hideAreas).areas } : {}),
      }
    }),
  }
}

/** Why sending the goods back is held, or null. */
export function sendBackHeld(unplanned: Unplanned, reason: string, busy: boolean): Phrase | null {
  if (busy) return phrase('waiting.held.busy')
  if (!unplanned.can.decide) return phrase('waiting.held.noDecide')
  if (reason.trim().length < 3) return phrase('waiting.held.reason')
  return null
}

/** A refused naming or send-back in our words, by the API's issue paths. */
export function waitingProblem(paths: readonly string[], error: { kind: string }): Phrase | null {
  const line = paths.find((path) => /^body\/lines\/\d+/.test(path))
  if (line) return phrase(line.endsWith('/quantity') || line.endsWith('/differenceReason') ? 'waiting.problem.tolerance' : line.includes('hide') ? 'waiting.problem.hides' : 'waiting.problem.line')
  if (paths.includes('body/purchaseOrderId')) return phrase('waiting.problem.order')
  if (paths.includes('body/reason')) return phrase('waiting.held.reason')
  if (paths.some((path) => path.startsWith('body/moves'))) return phrase('waiting.problem.period')
  if (error.kind === 'conflict') return phrase('waiting.problem.changed')
  return null
}
