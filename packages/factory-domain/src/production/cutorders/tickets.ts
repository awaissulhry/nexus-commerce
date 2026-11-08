import type { Language } from '../../inventory/rolls/rolls'
import { dotsOf, fitText, LABEL_LAYOUT, MAX_LABEL_COPIES, stockProblems, zplText, type LabelStock } from '../../labels/zpl'
import type { CutOrderKind, CutOrderStatus, CutTicketKind, CutTicketStatus, LayStatus } from './rules'

/**
 * Cut tickets (B-W2b-112; MES-041 "Cut ticket"; design floor.fabriccut "Cut ticket" — "Start from the ticket: style, colour,
 * sizes and ratio, plies, marker, parts, due" — and "Cut" — "Scan the ticket again at the end of cutting"), pure. A released cut
 * order has one ticket per lay (fabric) or one ticket (leather), printed in the office. At the table the cutter scans it at the
 * start (OPEN → STARTED; the cut order's first start moves it RELEASED → IN_PROGRESS) and again when the cut is done (STARTED →
 * DONE; a lay's ticket only once its plies were counted at both ends, and the lay is then CUT; when every lay is cut or
 * cancelled the cut order is CUT; a leather cut order is CUT with its ticket). A lost ticket is voided in the office and a new
 * one printed; a voided ticket is never taken again. The ticket's scan code is its number (no spaces), printed as Code 128.
 *
 * A recut ticket (kind RECUT, MES-044) is B-W2b-117's: these scans refuse it in words.
 */

export const TICKET_REFUSALS = ['TICKET_VOID', 'TICKET_DONE', 'TICKET_STARTED', 'TICKET_NOT_STARTED', 'TICKET_IS_RECUT', 'CUT_ORDER_NOT_RELEASED', 'PLIES_NOT_COUNTED'] as const
export type TicketRefusalCode = (typeof TICKET_REFUSALS)[number]

export interface TicketRefusal {
  readonly code: TicketRefusalCode
  readonly message: string
}

export interface TicketFacts {
  readonly number: string
  readonly kind: CutTicketKind
  readonly status: CutTicketStatus
  readonly voidReason: string | null
}

export interface TicketOrderFacts {
  readonly number: string
  readonly status: CutOrderStatus
}

/** A scan code as typed or read: trimmed, upper case. */
export const scanCodeOf = (code: string): string => code.trim().toUpperCase()

function goneRefusal(ticket: TicketFacts): TicketRefusal | null {
  if (ticket.kind === 'RECUT') return { code: 'TICKET_IS_RECUT', message: `Ticket ${ticket.number} is a recut ticket: it is cut from the recut list.` }
  if (ticket.status === 'VOID') return { code: 'TICKET_VOID', message: `Ticket ${ticket.number} was voided${ticket.voidReason ? ` (${ticket.voidReason})` : ''}: take the new ticket from the office.` }
  if (ticket.status === 'DONE') return { code: 'TICKET_DONE', message: `Ticket ${ticket.number} is done: its cut is finished.` }
  return null
}

/** Why the start scan stops (null: it starts). */
export function startRefusal(ticket: TicketFacts, order: TicketOrderFacts): TicketRefusal | null {
  const gone = goneRefusal(ticket)
  if (gone) return gone
  if (ticket.status === 'STARTED') return { code: 'TICKET_STARTED', message: `Ticket ${ticket.number} was started already: scan it again when the cut is done.` }
  if (order.status !== 'RELEASED' && order.status !== 'IN_PROGRESS') {
    const why = order.status === 'PLANNED' ? 'is back in planning' : order.status === 'CANCELLED' ? 'was cancelled' : `is ${order.status.toLowerCase()}`
    return { code: 'CUT_ORDER_NOT_RELEASED', message: `Cut order ${order.number} ${why}: its tickets are not cut now.` }
  }
  return null
}

/** Why the end scan stops (null: the cut is done). `layStatus` is the ticket's lay's (fabric), null for a leather ticket. */
export function finishRefusal(ticket: TicketFacts, layStatus: LayStatus | null, laySeq: number | null): TicketRefusal | null {
  const gone = goneRefusal(ticket)
  if (gone) return gone
  if (ticket.status === 'OPEN') return { code: 'TICKET_NOT_STARTED', message: `Ticket ${ticket.number} was not started: scan it at the start of cutting first.` }
  if (layStatus !== null && layStatus !== 'CHECKED' && layStatus !== 'CUT') {
    return { code: 'PLIES_NOT_COUNTED', message: `${laySeq !== null ? `Lay ${laySeq}` : 'The lay'} is ${layStatus.toLowerCase()}: count its plies at both ends before the cut is done.` }
  }
  return null
}

/** What the next scan of the ticket does: START, FINISH, or NONE (with the refusal it would meet). */
export function nextScanOf(ticket: TicketFacts, order: TicketOrderFacts, layStatus: LayStatus | null, laySeq: number | null): { readonly next: 'START' | 'FINISH' | 'NONE'; readonly refusal: TicketRefusal | null } {
  if (ticket.status === 'OPEN') {
    const refusal = startRefusal(ticket, order)
    return { next: refusal ? 'NONE' : 'START', refusal }
  }
  const refusal = finishRefusal(ticket, layStatus, laySeq)
  return { next: ticket.status === 'STARTED' ? 'FINISH' : 'NONE', refusal }
}

/** The cut order after a lay's ticket is done: CUT when every lay is CUT or CANCELLED and one at least CUT (the database's rule). */
export function fabricOrderCut(lays: readonly LayStatus[]): boolean {
  return lays.length > 0 && lays.every((status) => status === 'CUT' || status === 'CANCELLED') && lays.some((status) => status === 'CUT')
}

// ---- the ticket's label -----------------------------------------------------------------------------------------------------------

/** The print job's label kind of a cut ticket (platform/print MODULE_LABEL_KINDS). */
export const CUT_TICKET_LABEL_KIND = 'CUT_TICKET' as const
/** Copies of a ticket at once. */
export const MAX_TICKET_COPIES = 5

export interface TicketLabel {
  /** The scan code (the ticket's number). */
  readonly code: string
  readonly language: Language
  /** The company's name, in the heading. */
  readonly maker: string | null
  readonly cutOrderNumber: string
  readonly kind: CutOrderKind
  /** FABRIC: the lay, of how many, and its plies. */
  readonly lay: { readonly seq: number; readonly of: number; readonly plies: number } | null
  /** "SEED-LIN-200 GRY Grey lining". */
  readonly material: string
  /** "MK-LIN-3S · 2.4 m" (fabric). */
  readonly marker: string | null
  /** "46:1 · 48:2" (fabric). */
  readonly ratio: string | null
  /** "SEED-JKT-02 ×3" or the work orders' styles. */
  readonly styles: string
  readonly workOrders: string
  readonly garments: number
  /** The due day, YYYY-MM-DD. */
  readonly due: string | null
}

const TICKET_WORDS = {
  it: { ticket: 'Buono di taglio', lay: 'Materasso', plies: 'strati', hides: 'Pelle', garments: 'capi', cutOrder: 'Ordine di taglio', material: 'Materiale', marker: 'Piazzamento', ratio: 'Taglie', workOrders: 'Ordini di lavoro', due: 'Consegna' },
  en: { ticket: 'Cut ticket', lay: 'Lay', plies: 'plies', hides: 'Leather', garments: 'garments', cutOrder: 'Cut order', material: 'Material', marker: 'Marker', ratio: 'Sizes', workOrders: 'Work orders', due: 'Due' },
} as const

/** The ticket's heading, title and fields in its language (the ZPL, and the screen's LabelPreview). */
export function ticketLines(ticket: TicketLabel): { heading: string; title: string; fields: { label: string; value: string }[] } {
  const words = TICKET_WORDS[ticket.language]
  const title = ticket.lay ? `${words.lay} ${ticket.lay.seq}/${ticket.lay.of} · ${ticket.lay.plies} ${words.plies}` : `${words.hides} · ${ticket.garments} ${words.garments}`
  const fields = [
    { label: words.cutOrder, value: ticket.cutOrderNumber },
    { label: words.material, value: ticket.material },
    ...(ticket.marker ? [{ label: words.marker, value: ticket.marker }] : []),
    ...(ticket.ratio ? [{ label: words.ratio, value: ticket.ratio }] : []),
    { label: words.workOrders, value: ticket.workOrders },
    ...(ticket.due ? [{ label: words.due, value: ticket.due }] : []),
  ].slice(0, 6)
  return { heading: [ticket.maker, words.ticket].filter((part) => part).join(' · '), title: `${title} · ${ticket.styles}`, fields }
}

const text = (x: number, y: number, height: number, value: string): string => `^FO${x},${y}^A0N,${height},${height}^FH^FD${zplText(value)}^FS`

/**
 * The ticket's ZPL on the printer's stock, `copies` times, in the layout of factory-domain/labels (heading, title, Code 128 of
 * the scan code, the code, two columns of fields). Throws a RangeError for a stock the layout does not fit or copies out of range.
 */
export function ticketZpl(ticket: TicketLabel, stock: LabelStock, copies = 1): string {
  const problems = stockProblems(stock)
  if (problems.length > 0) throw new RangeError(problems.map((problem) => problem.message).join(' '))
  if (!Number.isSafeInteger(copies) || copies < 1 || copies > Math.min(MAX_TICKET_COPIES, MAX_LABEL_COPIES)) throw new RangeError(`A ticket is printed 1 to ${MAX_TICKET_COPIES} times.`)
  const lines = ticketLines(ticket)
  const dots = (hundredths: number): number => dotsOf(hundredths, stock.dpi)
  const L = LABEL_LAYOUT
  const width = dots(stock.widthMm * 100)
  const margin = dots(L.margin)
  const inner = width - 2 * margin
  const module = Math.max(2, dots(L.barcode.module))
  const barHeight = dots(L.barcode.height)
  const labelSize = dots(L.fields.labelSize)
  const valueSize = dots(L.fields.valueSize)
  const column = Math.floor(inner / L.fields.perRow)
  const commands = [
    '^XA',
    '^CI28',
    `^PW${width}`,
    `^LL${dots(stock.heightMm * 100)}`,
    '^LH0,0',
    text(margin, dots(L.heading.y), dots(L.heading.size), fitText(lines.heading, inner, dots(L.heading.size))),
    text(margin, dots(L.title.y), dots(L.title.size), fitText(lines.title, inner, dots(L.title.size))),
    `^FO${margin},${dots(L.barcode.y)}^BY${module},3,${barHeight}^BCN,${barHeight},N,N,N^FH^FD${zplText(ticket.code)}^FS`,
    text(margin, dots(L.code.y), dots(L.code.size), ticket.code),
  ]
  lines.fields.forEach((field, index) => {
    const x = margin + (index % L.fields.perRow) * column
    const y = dots(L.fields.y + Math.floor(index / L.fields.perRow) * L.fields.rowHeight)
    commands.push(text(x, y, labelSize, fitText(field.label, column - margin, labelSize)))
    commands.push(text(x, y + dots(L.fields.valueOffset), valueSize, fitText(field.value, column - margin, valueSize)))
  })
  commands.push(`^PQ${copies}`, '^XZ')
  return `${commands.join('\n')}\n`
}
