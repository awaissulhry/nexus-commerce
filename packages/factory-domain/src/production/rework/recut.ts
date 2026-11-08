import type { Language } from '../../inventory/rolls/rolls'
import { dotsOf, fitText, LABEL_LAYOUT, MAX_LABEL_COPIES, stockProblems, zplText, type LabelStock } from '../../labels/zpl'
import type { CutTicketKind, CutTicketStatus } from '../cutorders/rules'
import type { WorkOrderStatus } from '../work-orders/machine'

/**
 * Recut tickets (B-W2b-117; MES-044 "Recut and panel replacement"; design floor.fabriccut "Recut tickets" — "Replacement panels
 * asked by sewing or quality: bundle, part, size, shade lot; cutting from the same shade lot or end bits; the new panel joins the
 * original bundle" —, better "Recuts stay in the original bundle's genealogy"), pure. A recut ticket is a CutTicket of kind RECUT
 * (B-W2b-85): one work order cell, the bundle its panels join (an ACTIVE bundle of the cell), the part as the pattern names it
 * (none: whole garments), the sets to cut and where they are cut from: a lot of the cell's material (the bundle's own shade lot,
 * or one of the same dye batch or shade) and/or end bits. It is numbered from the company's CUT_TICKET series by an office or
 * system command (a tablet's ask runs as the tenant's system caller), never by the tablet. The office may make it from a
 * ReplacementRequest RECUT that is OPEN and has none yet (its part and cell; the replacement names the ticket for good).
 *
 * At the cutting table the cutter scans it at the start (OPEN → STARTED) and at the end (STARTED → DONE): the panels join their
 * bundle (the bundle's genealogy lists its recut tickets). A lost or wrong ticket is voided in the office with the reason. Cut
 * tickets of a cut order (kind CUT) have their own scans (../cutorders/tickets): these scans refuse one, as those refuse a recut.
 * Nothing here carries money or names a person.
 */

export const RECUT_LIMITS = Object.freeze({
  /** Sets on one recut ticket. */
  sets: 500,
  part: 60,
  reason: 300,
  /** Rows of a list. */
  rows: 200,
})

export const RECUT_REFUSALS = [
  'WORK_ORDER_NOT_OPEN',
  'WORK_ORDER_ON_HOLD',
  'BUNDLE_NOT_ACTIVE',
  'BUNDLE_NEEDED',
  'NOT_OF_CELL',
  'MORE_THAN_BUNDLE',
  'NOT_A_PART',
  'NO_SOURCE',
  'LOT_OTHER_MATERIAL',
  'LOT_NOT_SAME_SHADE',
  'REPLACEMENT_NOT_RECUT',
  'REPLACEMENT_NOT_OPEN',
  'REPLACEMENT_HAS_TICKET',
  'REPLACEMENT_OTHER_CELL',
  'REPLACEMENT_OTHER_PART',
  'MORE_THAN_REPLACEMENT',
  'TICKET_IS_CUT',
  'TICKET_VOID',
  'TICKET_DONE',
  'TICKET_STARTED',
  'TICKET_NOT_STARTED',
  'BUNDLE_VOID',
] as const
export type RecutRefusalCode = (typeof RECUT_REFUSALS)[number]

export interface RecutRefusal {
  readonly code: RecutRefusalCode
  readonly message: string
}

export const RECUT_WARNINGS = ['SHADE_UNKNOWN'] as const
export type RecutWarningCode = (typeof RECUT_WARNINGS)[number]
export interface RecutWarning {
  readonly code: RecutWarningCode
  readonly message: string
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** The statuses a work order takes a recut ticket in (the database's rule too). */
export const RECUT_OPEN_STATUSES: readonly WorkOrderStatus[] = Object.freeze(['RELEASED', 'IN_PROGRESS'])

export interface RecutWorkOrder {
  readonly number: string
  readonly status: WorkOrderStatus | string
  readonly holdReason: string | null
}

/**
 * Why nothing moves for this work order after cutting now (null: it may): on hold, or not released or running. `words` end the
 * sentence for each case ("no panel is recut for it until the hold is lifted").
 */
export function orderStop(workOrder: RecutWorkOrder, words: { readonly held: string; readonly closed: string }): { readonly code: 'WORK_ORDER_ON_HOLD' | 'WORK_ORDER_NOT_OPEN'; readonly message: string } | null {
  if (workOrder.status === 'ON_HOLD') return { code: 'WORK_ORDER_ON_HOLD', message: `Work order ${workOrder.number} is on hold${workOrder.holdReason ? ` (${workOrder.holdReason})` : ''}: ${words.held}.` }
  if (!(RECUT_OPEN_STATUSES as readonly string[]).includes(workOrder.status)) {
    return { code: 'WORK_ORDER_NOT_OPEN', message: `Work order ${workOrder.number} is ${String(workOrder.status).toLowerCase().replace('_', ' ')}: ${words.closed}.` }
  }
  return null
}

/** Why nothing is recut for this work order now (null: it may be). */
export const workOrderStop = (workOrder: RecutWorkOrder): RecutRefusal | null =>
  orderStop(workOrder, { held: 'no panel is recut for it until the hold is lifted', closed: 'recuts are cut for released or running work orders' })

/** A lot named as where a recut is cut from. */
export interface RecutLot {
  readonly id: string
  readonly code: string
  readonly itemId: string
  readonly itemColourId: string | null
  readonly dyeBatch: string | null
  readonly shade: string | null
}

/** The material of a cell (its planned materials): the lot must be one of them. */
export interface RecutMaterial {
  readonly itemId: string
  readonly itemColourId: string | null
}

/**
 * The same shade lot: one of the bundle's own lots (its genealogy), or a lot of the same material whose dye batch or shade is one
 * of theirs. Unknown (no lot of the bundle is known): not refused, a warning (`recutWarnings`).
 */
export function sameShade(lot: RecutLot, shadeLots: readonly RecutLot[]): boolean {
  if (shadeLots.length === 0) return true
  return shadeLots.some(
    (own) => own.id === lot.id || (own.itemId === lot.itemId && ((own.dyeBatch !== null && own.dyeBatch === lot.dyeBatch) || (own.shade !== null && own.shade === lot.shade))),
  )
}

const ofMaterial = (lot: RecutLot, materials: readonly RecutMaterial[]) =>
  materials.length === 0 || materials.some((material) => material.itemId === lot.itemId && (material.itemColourId === null || lot.itemColourId === null || material.itemColourId === lot.itemColourId))

export interface RecutReplacementFacts {
  readonly kind: 'RECUT' | 'REDUCE'
  readonly status: string
  readonly quantity: number
  readonly part: string | null
  readonly workOrderSizeId: string
  readonly recutTicketId: string | null
}

export interface RecutMakeFacts {
  readonly workOrder: RecutWorkOrder
  /** The bundle the panels join; null: none named (only from a replacement whose scrap names no bundle). */
  readonly bundle: { readonly code: string; readonly status: 'ACTIVE' | 'VOID' | string; readonly workOrderSizeId: string; readonly live: number } | null
  /** The cell: its words ("BLK 52") and the parts its materials and pattern name (empty: any words). */
  readonly cell: { readonly id: string; readonly label: string; readonly parts: readonly string[] }
  readonly part: string | null
  readonly quantity: number
  readonly lot: RecutLot | null
  readonly endBits: boolean
  readonly materials: readonly RecutMaterial[]
  /** The bundle's own lots (its cut log entries' lots, its cell's lays' rolls' lots). */
  readonly shadeLots: readonly RecutLot[]
  readonly replacement: RecutReplacementFacts | null
}

/** Why a recut ticket is not made (null: it is). */
export function recutMakeRefusal(facts: RecutMakeFacts): RecutRefusal | null {
  const stop = workOrderStop(facts.workOrder)
  if (stop) return stop
  const replacement = facts.replacement
  if (replacement) {
    if (replacement.kind !== 'RECUT') return { code: 'REPLACEMENT_NOT_RECUT', message: 'That replacement lowers the order: it is not recut.' }
    if (replacement.status !== 'OPEN') return { code: 'REPLACEMENT_NOT_OPEN', message: `That replacement is ${replacement.status.toLowerCase()}: it takes no recut ticket.` }
    if (replacement.recutTicketId !== null) return { code: 'REPLACEMENT_HAS_TICKET', message: 'That replacement has its recut ticket already.' }
    if (replacement.workOrderSizeId !== facts.cell.id) return { code: 'REPLACEMENT_OTHER_CELL', message: `That replacement is of another cell than ${facts.cell.label}.` }
    if ((replacement.part ?? null) !== facts.part) {
      return { code: 'REPLACEMENT_OTHER_PART', message: `That replacement recuts ${replacement.part ?? 'whole garments'}, not ${facts.part ?? 'whole garments'}.` }
    }
    if (facts.quantity > replacement.quantity) return { code: 'MORE_THAN_REPLACEMENT', message: `That replacement asks ${plural(replacement.quantity, 'set')}; ${facts.quantity} asked.` }
  }
  if (!facts.bundle && !replacement) return { code: 'BUNDLE_NEEDED', message: 'Scan the bundle the new panels join.' }
  if (facts.bundle) {
    if (facts.bundle.status !== 'ACTIVE') return { code: 'BUNDLE_NOT_ACTIVE', message: `Bundle ${facts.bundle.code} is voided: recut panels join a live bundle.` }
    if (facts.bundle.workOrderSizeId !== facts.cell.id) return { code: 'NOT_OF_CELL', message: `Bundle ${facts.bundle.code} is not of ${facts.cell.label}.` }
    if (facts.quantity < 1 || facts.quantity > facts.bundle.live) {
      return { code: 'MORE_THAN_BUNDLE', message: `Bundle ${facts.bundle.code} carries ${plural(facts.bundle.live, 'garment')}: recut 1 to ${facts.bundle.live} sets; ${facts.quantity} asked.` }
    }
  }
  if (facts.part !== null && facts.cell.parts.length > 0 && !facts.cell.parts.includes(facts.part)) {
    return { code: 'NOT_A_PART', message: `${facts.part} is not a part of ${facts.cell.label} (${facts.cell.parts.join(', ')}).` }
  }
  if (!facts.lot && !facts.endBits) return { code: 'NO_SOURCE', message: 'Say where the panels are cut from: the same shade lot, or end bits.' }
  if (facts.lot) {
    if (!ofMaterial(facts.lot, facts.materials)) return { code: 'LOT_OTHER_MATERIAL', message: `Lot ${facts.lot.code} is not of a material ${facts.cell.label} is made of.` }
    if (!sameShade(facts.lot, facts.shadeLots)) {
      return { code: 'LOT_NOT_SAME_SHADE', message: `Lot ${facts.lot.code} is not the shade of the bundle (${facts.shadeLots.map((lot) => lot.code).join(', ')}): cut from the same shade lot or from end bits.` }
    }
  }
  return null
}

/** What to look at although nothing stops the recut. */
export function recutWarnings(facts: Pick<RecutMakeFacts, 'lot' | 'shadeLots'>): RecutWarning[] {
  if (facts.lot && facts.shadeLots.length === 0) return [{ code: 'SHADE_UNKNOWN', message: `The bundle's shade lot is not known: check by eye that lot ${facts.lot.code} matches its shade.` }]
  return []
}

// ---- at the cutting table --------------------------------------------------------------------------------------------------------

export interface RecutTicketFacts {
  readonly number: string
  readonly kind: CutTicketKind
  readonly status: CutTicketStatus
  readonly voidReason: string | null
}

function goneRefusal(ticket: RecutTicketFacts): RecutRefusal | null {
  if (ticket.kind !== 'RECUT') return { code: 'TICKET_IS_CUT', message: `Ticket ${ticket.number} cuts a cut order: scan it on the cut ticket, not as a recut.` }
  if (ticket.status === 'VOID') return { code: 'TICKET_VOID', message: `Recut ticket ${ticket.number} was voided${ticket.voidReason ? ` (${ticket.voidReason})` : ''}: nothing is cut for it.` }
  if (ticket.status === 'DONE') return { code: 'TICKET_DONE', message: `Recut ticket ${ticket.number} is done: its panels joined their bundle.` }
  return null
}

/** Why the start scan stops (null: it starts). */
export function recutStartRefusal(ticket: RecutTicketFacts, workOrder: RecutWorkOrder, bundle: { readonly code: string; readonly status: string } | null): RecutRefusal | null {
  const gone = goneRefusal(ticket)
  if (gone) return gone
  if (ticket.status === 'STARTED') return { code: 'TICKET_STARTED', message: `Recut ticket ${ticket.number} was started already: scan it again when the panels are cut.` }
  const stop = workOrderStop(workOrder)
  if (stop) return stop
  if (bundle && bundle.status !== 'ACTIVE') return { code: 'BUNDLE_VOID', message: `Bundle ${bundle.code} was voided: its recut is not cut; the office voids ticket ${ticket.number}.` }
  return null
}

/** Why the end scan stops (null: the panels are cut). */
export function recutFinishRefusal(ticket: RecutTicketFacts): RecutRefusal | null {
  const gone = goneRefusal(ticket)
  if (gone) return gone
  if (ticket.status === 'OPEN') return { code: 'TICKET_NOT_STARTED', message: `Recut ticket ${ticket.number} was not started: scan it at the start of cutting first.` }
  return null
}

export type RecutNext = 'START' | 'FINISH' | 'NONE'

/** What the next scan of a recut ticket does, with the refusal it would meet. */
export function nextRecutScan(ticket: RecutTicketFacts, workOrder: RecutWorkOrder, bundle: { readonly code: string; readonly status: string } | null): { readonly next: RecutNext; readonly refusal: RecutRefusal | null } {
  if (ticket.status === 'OPEN') {
    const refusal = recutStartRefusal(ticket, workOrder, bundle)
    return { next: refusal ? 'NONE' : 'START', refusal }
  }
  const refusal = recutFinishRefusal(ticket)
  return { next: refusal ? 'NONE' : 'FINISH', refusal }
}

export const RECUT_NEXT_WORDS: Readonly<Record<Language, Readonly<Record<RecutNext, string>>>> = Object.freeze({
  it: { START: 'Scansiona per iniziare il ritaglio.', FINISH: 'Scansiona di nuovo a pannelli tagliati.', NONE: 'Nessuna scansione da fare.' },
  en: { START: 'Scan to start the recut.', FINISH: 'Scan again when the panels are cut.', NONE: 'Nothing to scan.' },
})

/** The table's list: started first, then by due day (none last), then the oldest. */
export function compareRecutRows(
  a: { readonly status: string; readonly dueDate: string | null; readonly createdAt: string; readonly number: string },
  b: { readonly status: string; readonly dueDate: string | null; readonly createdAt: string; readonly number: string },
): number {
  const started = Number(b.status === 'STARTED') - Number(a.status === 'STARTED')
  if (started !== 0) return started
  if (a.dueDate !== b.dueDate) return a.dueDate === null ? 1 : b.dueDate === null ? -1 : a.dueDate < b.dueDate ? -1 : 1
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  return a.number < b.number ? -1 : a.number > b.number ? 1 : 0
}

// ---- the ticket's label --------------------------------------------------------------------------------------------------------

export interface RecutLabel {
  /** The scan code (the ticket's number). */
  readonly code: string
  readonly language: Language
  /** The company's name, in the heading. */
  readonly maker: string | null
  readonly workOrderNumber: string
  /** The style's code. */
  readonly style: string
  /** "BLK 52". */
  readonly cell: string
  /** The part; null: whole garments. */
  readonly part: string | null
  readonly quantity: number
  /** The bundle the panels join. */
  readonly bundleCode: string | null
  readonly lotCode: string | null
  readonly endBits: boolean
  /** YYYY-MM-DD. */
  readonly due: string | null
}

const LABEL_WORDS = {
  it: { ticket: 'Buono di ritaglio', whole: 'Capi interi', sets: 'serie', workOrder: 'Ordine di lavoro', bundle: 'Unire al fascio', from: 'Tagliare da', lot: 'Lotto', endBits: 'Ritagli', due: 'Consegna', none: '—' },
  en: { ticket: 'Recut ticket', whole: 'Whole garments', sets: 'sets', workOrder: 'Work order', bundle: 'Joins bundle', from: 'Cut from', lot: 'Lot', endBits: 'End bits', due: 'Due', none: '—' },
} as const

/** Where it is cut from, in words: "Lot L-12 + end bits", "End bits". */
export function sourceWords(source: { readonly lotCode: string | null; readonly endBits: boolean }, language: Language): string {
  const words = LABEL_WORDS[language]
  const parts = [...(source.lotCode ? [`${words.lot} ${source.lotCode}`] : []), ...(source.endBits ? [words.endBits] : [])]
  return parts.length === 0 ? words.none : parts.join(' + ')
}

/** The ticket's heading, title and fields in its language (the ZPL, and the screen's LabelPreview). */
export function recutLines(label: RecutLabel): { heading: string; title: string; fields: { label: string; value: string }[] } {
  const words = LABEL_WORDS[label.language]
  const fields = [
    { label: words.workOrder, value: label.workOrderNumber },
    { label: words.bundle, value: label.bundleCode ?? words.none },
    { label: words.from, value: sourceWords(label, label.language) },
    ...(label.due ? [{ label: words.due, value: label.due }] : []),
  ]
  return {
    heading: [label.maker, words.ticket].filter((part) => part).join(' · '),
    title: `${label.part ?? words.whole} × ${label.quantity} ${words.sets} · ${label.style} ${label.cell}`,
    fields,
  }
}

const text = (x: number, y: number, height: number, value: string): string => `^FO${x},${y}^A0N,${height},${height}^FH^FD${zplText(value)}^FS`

/** The most copies of a recut ticket at once. */
export const MAX_RECUT_COPIES = 5

/**
 * The ticket's ZPL on the printer's stock, `copies` times, in factory-domain/labels' layout (heading, title, Code 128 of the scan
 * code, the code, two columns of fields). Throws a RangeError for a stock the layout does not fit or copies out of range.
 */
export function recutZpl(label: RecutLabel, stock: LabelStock, copies = 1): string {
  const problems = stockProblems(stock)
  if (problems.length > 0) throw new RangeError(problems.map((problem) => problem.message).join(' '))
  if (!Number.isSafeInteger(copies) || copies < 1 || copies > Math.min(MAX_RECUT_COPIES, MAX_LABEL_COPIES)) throw new RangeError(`A recut ticket is printed 1 to ${MAX_RECUT_COPIES} times.`)
  const lines = recutLines(label)
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
    `^FO${margin},${dots(L.barcode.y)}^BY${module},3,${barHeight}^BCN,${barHeight},N,N,N^FH^FD${zplText(label.code)}^FS`,
    text(margin, dots(L.code.y), dots(L.code.size), label.code),
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
