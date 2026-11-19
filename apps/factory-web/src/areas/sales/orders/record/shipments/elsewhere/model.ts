import { ELSEWHERE_LIMITS, elsewhereProblems, paperDdtNumber, type ElsewhereProblem } from '@nexus/factory-domain/shipping/elsewhere'
import { isApiError, issuePath } from '../../../../../../lib/api/errors'
import type { ReadyCell } from '../../../../../warehouse/shipments/api'
import { zonedInstant, zonedToday } from '../../../../../warehouse/shipments/model'
import type { Order, OrderStatus } from '../../../api'
import type { Phrase } from '../../../model'
import type { ElsewhereBody, ElsewherePreview } from './api'

/**
 * F-OP-123 (order page N5; 10-order-page §8.5; review R-9, R-10, R-23) — "Record a shipment made elsewhere…", pure: the door (held
 * with its words, never hidden), the form and the request it sends, the live rules under the fields (the API's own rule —
 * factory-domain shipping/elsewhere — on this browser's clock, with what the preview says is released and since when), what holds
 * Record, and a refused recording in this screen's words. The words are this catalogue's (`orders`: `elsewhere.*`).
 */

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

/** The states of an order whose released garments may still leave (the line guard's list). */
export const ELSEWHERE_FROM: readonly OrderStatus[] = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED']

/** The door (⋯ Next steps and the Shipments card head): open, or held with why (D4: Sales sees it held, no role change). */
export function elsewhereDoor(order: Pick<Order, 'status'>, permissions: readonly string[]): Phrase | null {
  if (!ELSEWHERE_FROM.includes(order.status)) return phrase('elsewhere.held.state')
  if (!permissions.includes('shipping.manage') || !permissions.includes('shipping.ddt.issue')) return phrase('elsewhere.held.noRight')
  return null
}

export type ElsewhereTransport = ElsewhereBody['transportBy']

export interface ElsewhereForm {
  /** Garments per cell (workOrderSizeId). */
  readonly quantities: Readonly<Record<string, number>>
  /** The serials typed per serial-tracked cell (spaces, commas or new lines between them). */
  readonly serials: Readonly<Record<string, string>>
  readonly ddtNumber: string
  /** YYYY-MM-DD. */
  readonly ddtDate: string
  /** R-23: an immediate invoice travelled with the goods instead of a DDT (ddtRequired false). */
  readonly invoiceInstead: boolean
  /** When the goods left (ISO); it follows the DDT date until the person changes it. */
  readonly shippedAt: string
  readonly leftTouched: boolean
  readonly transportBy: ElsewhereTransport
  readonly carrierName: string
  readonly trackingNumber: string
  /** R-9: why the goods were let go while the customer is on hold (a person who may release holds). */
  readonly holdReason: string
  readonly note: string
}

/** "Left on" by default: 09:00 in Rome on that day, never later than now (rounded down to 5 minutes). */
export function defaultLeaving(day: string, now: Date): string {
  const nine = zonedInstant(day, '09:00') ?? now.toISOString()
  return Date.parse(nine) > now.getTime() ? new Date(Math.floor(now.getTime() / 300_000) * 300_000).toISOString() : nine
}

export function emptyForm(now: Date): ElsewhereForm {
  const today = zonedToday(now)
  return { quantities: {}, serials: {}, ddtNumber: '', ddtDate: today, invoiceInstead: false, shippedAt: defaultLeaving(today, now), leftTouched: false, transportBy: 'CARRIER', carrierName: '', trackingNumber: '', holdReason: '', note: '' }
}

/** A field changed: the DDT date moves "Left on" with it until the person chose a time themselves. */
export function changed(form: ElsewhereForm, next: Partial<ElsewhereForm>, now: Date): ElsewhereForm {
  const merged = { ...form, ...next }
  if (next.shippedAt !== undefined) return { ...merged, leftTouched: true }
  if (next.ddtDate !== undefined && !form.leftTouched && next.ddtDate !== '') return { ...merged, shippedAt: defaultLeaving(next.ddtDate, now) }
  return merged
}

export const serialsOf = (text: string | undefined): string[] => (text ?? '').split(/[\s,;]+/).map((serial) => serial.trim()).filter((serial) => serial !== '')

/** The cells the person may record: this order's released garments on no shipment. */
export const recordableCells = (cells: readonly ReadyCell[]): ReadyCell[] => cells.filter((cell) => cell.shippable > 0)

export const garmentsOf = (form: ElsewhereForm): number => Object.values(form.quantities).reduce((sum, quantity) => sum + (quantity > 0 ? quantity : 0), 0)

/** The request as the API reads it: the cells with garments, in the list's order. */
export function elsewhereBody(orderId: string, form: ElsewhereForm, cells: readonly ReadyCell[]): ElsewhereBody {
  const lines = cells.flatMap((cell) => {
    const quantity = form.quantities[cell.workOrderSizeId] ?? 0
    if (quantity <= 0) return []
    const serials = cell.serialTracked ? serialsOf(form.serials[cell.workOrderSizeId]) : []
    return [{ workOrderSizeId: cell.workOrderSizeId, quantity, ...(serials.length > 0 ? { serials } : {}) }]
  })
  const carrier = form.transportBy === 'CARRIER'
  return {
    salesOrderId: orderId,
    ...(cells[0] ? { siteId: cells[0].siteId } : {}),
    lines,
    transportBy: form.transportBy,
    carrierName: carrier && form.carrierName.trim() !== '' ? form.carrierName.trim() : null,
    trackingNumber: carrier && form.trackingNumber.trim() !== '' ? form.trackingNumber.trim() : null,
    // No number typed: no paper DDT (required unless an immediate invoice travelled instead, R-23).
    externalDdt: paperDdtNumber(form.ddtNumber) === '' ? null : { number: form.ddtNumber, date: form.ddtDate },
    ddtRequired: !form.invoiceInstead,
    shippedAt: form.shippedAt,
    ...(form.holdReason.trim() !== '' ? { holdReason: form.holdReason.trim() } : {}),
    internalNote: form.note.trim() === '' ? null : form.note.trim(),
  }
}

/** The live rules under the fields: the API's own rule on this browser's clock, with what the preview says is released. */
export function liveProblems(form: ElsewhereForm, cells: readonly ReadyCell[], preview: ElsewherePreview | null, now: Date): ElsewhereProblem[] {
  const body = elsewhereBody('', form, cells)
  const lines = body.lines.map((line) => {
    const cell = cells.find((entry) => entry.workOrderSizeId === line.workOrderSizeId)!
    const read = preview?.lines.find((entry) => entry.workOrderSizeId === line.workOrderSizeId)
    return {
      workOrderSizeId: line.workOrderSizeId,
      label: `${cell.styleCode} · ${cell.colourwayName} · ${cell.size}`,
      quantity: line.quantity,
      shippable: read?.shippable ?? cell.shippable,
      // Until the preview read this line, its release is not known: no rule on it yet (the API decides at Record).
      releasedAt: read ? read.releasedAt : '0000-01-01T00:00:00.000Z',
      serialTracked: cell.serialTracked,
      serials: line.serials?.length ?? 0,
    }
  })
  const ddt = body.externalDdt === null ? null : { number: body.externalDdt.number, date: body.externalDdt.date }
  return elsewhereProblems({ shippedAt: body.shippedAt, externalDdt: ddt, ddtRequired: body.ddtRequired, cells: lines }, now)
}

/** Where each problem shows: under "Left on", the DDT, a line (by its cell), or the lines as a whole. */
export interface ProblemPlaces {
  readonly left: Phrase[]
  readonly ddt: Phrase[]
  readonly lines: Phrase[]
  readonly byCell: Readonly<Record<string, Phrase[]>>
}

/** Each problem in this screen's words, in its place. `releasedOn`: the earliest the goods may have left (a date's words). */
export function problemPlaces(problems: readonly ElsewhereProblem[], body: Pick<ElsewhereBody, 'lines'>, words: { readonly releasedOn: (iso: string) => string }): ProblemPlaces {
  const places: { left: Phrase[]; ddt: Phrase[]; lines: Phrase[]; byCell: Record<string, Phrase[]> } = { left: [], ddt: [], lines: [], byCell: {} }
  const cellAt = (path: string): string | null => {
    const index = Number(/\/lines\/(\d+)/.exec(path)?.[1] ?? NaN)
    return Number.isInteger(index) ? (body.lines[index]?.workOrderSizeId ?? null) : null
  }
  const onCell = (path: string, words: Phrase) => {
    const cell = cellAt(path)
    if (cell) places.byCell[cell] = [...(places.byCell[cell] ?? []), words]
    else places.lines.push(words)
  }
  for (const problem of problems) {
    if (problem.code === 'FUTURE') places.left.push(phrase('elsewhere.future'))
    else if (problem.code === 'TOO_OLD') places.left.push(phrase('elsewhere.tooOld', { days: ELSEWHERE_LIMITS.daysBack }))
    else if (problem.code === 'BEFORE_RELEASE') {
      const at = /released on (\d{4}-\d{2}-\d{2})/.exec(problem.message)?.[1] ?? null
      places.left.push(phrase('elsewhere.beforeRelease', { date: at ? words.releasedOn(`${at}T12:00:00.000Z`) : '—' }))
    } else if (problem.code === 'DDT_REQUIRED') places.ddt.push(phrase('elsewhere.ddtRequired'))
    else if (problem.code === 'DDT_NUMBER') places.ddt.push(phrase('elsewhere.ddtNumberRule', { max: ELSEWHERE_LIMITS.ddtNumber }))
    else if (problem.code === 'DDT_AFTER_LEFT') places.ddt.push(phrase('elsewhere.ddtAfter'))
    else if (problem.code === 'NOT_RELEASED') onCell(problem.path, phrase('elsewhere.notReleased'))
    else if (problem.code === 'SERIALS') {
      const counts = /\((\d+) of (\d+)\)/.exec(problem.message)
      onCell(problem.path, phrase('elsewhere.serialsMissing', { count: Number(counts?.[1] ?? 0), total: Number(counts?.[2] ?? 0) }))
    } else places.lines.push(phrase('elsewhere.noLines'))
  }
  return places
}

/** Pieces of the order that still wait for quality (ordered, not released, not closed short): "Only released garments: N pieces wait". */
export const waitingForQuality = (order: Pick<Order, 'progress'>): number => Math.max(0, order.progress.ordered - order.progress.closedShort - order.progress.released)

/**
 * What holds Record (the first reason): a write running, the preview being read, no garment, a live problem, the customer held
 * (no right to record over it, or no reason given — R-9), the paper DDT recorded already (R-10).
 */
export function recordHeld(input: { readonly busy: boolean; readonly form: ElsewhereForm; readonly problems: readonly ElsewhereProblem[]; readonly preview: ElsewherePreview | null; readonly customer: string }): Phrase | null {
  if (input.busy) return phrase('held.busy')
  if (garmentsOf(input.form) === 0) return phrase('elsewhere.noLines')
  if (!input.preview) return phrase('elsewhere.held.reading')
  if (input.problems.length > 0) return phrase('elsewhere.held.problems')
  if (input.preview.ddtUsed) return phrase('elsewhere.ddtUsed')
  if (input.preview.holds.held && !input.preview.holds.mayRelease) return phrase('elsewhere.held.customer', { customer: input.customer })
  if (input.preview.holds.held && input.form.holdReason.trim() === '') return phrase('elsewhere.held.reason')
  return null
}

/** A refused recording in this screen's words (409 `refusal/<CODE>`; 400 field problems; else the general words with the API's sentence). */
export function refusalOf(error: unknown, customer: string): { readonly words: Phrase; readonly detail: string | null } {
  if (!isApiError(error)) return { words: phrase('elsewhere.refusal.failed'), detail: null }
  const paths = error.issues.map(issuePath)
  if (paths.includes('refusal/DDT_NUMBER_USED')) return { words: phrase('elsewhere.ddtUsed'), detail: null }
  if (paths.includes('refusal/HELD')) return { words: phrase('elsewhere.held.customer', { customer }), detail: null }
  if (paths.includes('refusal/REASON_REQUIRED')) return { words: phrase('elsewhere.held.reason'), detail: null }
  if (error.kind === 'forbidden') return { words: phrase('elsewhere.held.noRight'), detail: null }
  if (error.kind === 'invalid' || error.kind === 'conflict') return { words: phrase('elsewhere.refusal.state'), detail: error.message || error.issues[0]?.message || null }
  return { words: phrase('elsewhere.refusal.failed'), detail: null }
}

/** The "Made elsewhere" chip of a shipment row (its paper DDT, or the immediate invoice that travelled instead); null: made here. */
export function madeElsewhereChip(row: { readonly origin?: 'NEXUS' | 'ELSEWHERE' | undefined; readonly externalDdt?: { readonly number: string } | null | undefined }): Phrase | null {
  if (row.origin !== 'ELSEWHERE') return null
  return row.externalDdt ? phrase('elsewhere.chip', { ddt: row.externalDdt.number }) : phrase('elsewhere.chipInvoice')
}
