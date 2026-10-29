import { composeLabel, labelText, type LabelInput, type LabelLanguage } from '../../labels/model'
import { dotsOf, fitText, LABEL_LAYOUT, labelZpl, zplText, type LabelStock } from '../../labels/zpl'

/**
 * A bundle's ticket (B-W1-41; MES-066, MES-073, MES-184; A2 SCR-095 "Tickets"): what travels with the bundle for the
 * operator — its code (a BUNDLE scannable id, as Code 128 and as text), the work order and its batch, the style, the
 * colourway, the size, the garments it holds and the part (a part bundle), and the operations of the work order's
 * frozen routing in order. Two renderings of the one content:
 *
 *   ZPL    bundleTicketZpl: factory-domain/labels' BUNDLE label (heading, title, barcode, code, six fields) on the label
 *          printer's stock, then the operations one per line where the stock has room below the fields (a taller
 *          ticket lists all; when they do not all fit, the last line says how many more). The print module queues it
 *          (platform/print queueModuleLabel, label kind BUNDLE).
 *   PDF    ticketLabel: the same BUNDLE label as a LabelInput, for the browser's fallback without a label printer
 *          (POST /print/labels/pdf); its "operation" field lists the operations' numbers.
 *
 * No money and no person: a ticket says what the bundle is, never who made it.
 */

export interface TicketOperation {
  readonly seq: number
  readonly code: string
  readonly name: string
}

export interface BundleTicket {
  /** The bundle's current code. */
  readonly code: string
  readonly language: LabelLanguage
  /** The company's name, in the heading. */
  readonly maker: string | null
  readonly workOrder: { readonly number: string; readonly batchNumber: string | null }
  readonly style: { readonly code: string; readonly name: string }
  readonly colourway: { readonly code: string; readonly name: string }
  readonly size: string
  readonly quantity: number
  /** A part bundle's part; null: whole garments. */
  readonly part: string | null
  /** The work order's operations, in routing order. */
  readonly operations: readonly TicketOperation[]
}

const MORE: Readonly<Record<LabelLanguage, (count: number) => string>> = {
  it: (count) => `+${count} ${count === 1 ? 'altra fase' : 'altre fasi'}`,
  en: (count) => `+${count} more operation${count === 1 ? '' : 's'}`,
}

/** The ticket as factory-domain/labels' BUNDLE label (the PDF fallback, and the top of the ZPL ticket). */
export function ticketLabel(ticket: BundleTicket): LabelInput {
  return {
    kind: 'BUNDLE',
    language: ticket.language,
    scanId: ticket.code,
    maker: ticket.maker,
    title: ticket.style.name || ticket.style.code,
    fields: {
      workOrder: ticket.workOrder.batchNumber ? `${ticket.workOrder.number} · ${ticket.workOrder.batchNumber}` : ticket.workOrder.number,
      style: ticket.style.code,
      size: ticket.size,
      colour: [ticket.colourway.code, ticket.colourway.name].filter((part) => part !== '').join(' '),
      pieces: ticket.part ? `${ticket.quantity} · ${ticket.part}` : String(ticket.quantity),
      operation: ticket.operations.length > 0 ? ticket.operations.map((operation) => operation.seq).join(' · ') : null,
    },
  }
}

/** The operations block, in hundredths of a millimetre: one line each, below the label's fields. */
export const TICKET_OPERATIONS = Object.freeze({ gap: 100, lineHeight: 330, size: 230 })

/** The lines of the operations block that fit `lines` lines: every operation, or the first ones and "+N more". */
export function operationLines(ticket: BundleTicket, lines: number): string[] {
  const all = ticket.operations.map((operation) => labelText(`${operation.seq} ${operation.code} ${operation.name}`))
  if (lines < 2) return []
  if (all.length <= lines) return all
  return [...all.slice(0, lines - 1), MORE[ticket.language](all.length - (lines - 1))]
}

/**
 * The ticket's ZPL on the printer's stock, `copies` times: the BUNDLE label, then the operations where there is room.
 * Throws a ValidationError when the label cannot be printed (another tenant's or another kind's code) and a RangeError
 * for a stock the layout does not fit (the print module checks the stock first).
 */
export function bundleTicketZpl(ticket: BundleTicket, stock: LabelStock, copies = 1, options: { readonly tenantTag?: string } = {}): string {
  const label = composeLabel(ticketLabel(ticket), options)
  const base = labelZpl(label, stock, copies)
  const L = LABEL_LAYOUT
  const O = TICKET_OPERATIONS
  const rows = Math.ceil(label.fields.length / L.fields.perRow)
  const top = L.fields.y + rows * L.fields.rowHeight + O.gap
  const room = stock.heightMm * 100 - L.margin - top
  const lines = operationLines(ticket, Math.floor(room / O.lineHeight))
  if (lines.length === 0) return base
  const dots = (hundredths: number) => dotsOf(hundredths, stock.dpi)
  const margin = dots(L.margin)
  const inner = dots(stock.widthMm * 100) - 2 * margin
  const size = dots(O.size)
  const block = lines.map((line, index) => `^FO${margin},${dots(top + index * O.lineHeight)}^A0N,${size},${size}^FH^FD${zplText(fitText(line, inner, size))}^FS`).join('\n')
  const end = base.lastIndexOf('^PQ')
  return `${base.slice(0, end)}${block}\n${base.slice(end)}`
}
