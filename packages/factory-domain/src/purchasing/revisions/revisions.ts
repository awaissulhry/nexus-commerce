import type { BusinessDate } from '../../core/time'
import { formatDate, formatDecimal, formatQuantity } from '../../documents/format'
import type { DocumentLanguage } from '../../documents/model'
import { purchaseOrderDocumentNumber, uomText } from '../document'
import { STATUS_WORDS, type PurchaseOrderStatus } from '../orders'

/**
 * Purchase order revisions (B-W2a-52; SCM-058 "Change with revisions"; design purchasing.orders record › Confirmations &
 * changes › Revisions: "every version with a visible diff; the supplier re-confirms each"), pure.
 *
 *   change     a SENT, DECLINED or CONFIRMED order goes back to DRAFT as its next revision (the buyer clicks Change); a
 *              CHANGES_PROPOSED one does too when the buyer counter-proposes (the supplier's proposal refused). The
 *              order as it stood then, the supplier's answer included, is kept with the change (`RevisionState`), its
 *              live confirm links stop working, and its open lines lose the old revision's confirmation and proposal
 *              (the …_supply_w2a_guards triggers allow exactly that).
 *   send       the next send of the draft writes the revision row (factory-db sourcing.prisma PurchaseOrderRevision):
 *              `after` = the order as sent (no price, no internal note), `before` = the state kept at the change (null for
 *              revision 1), the prices of both apart (`RevisionPrices`, the cost grain), the buyer's change note and the
 *              PDF. The supplier gets the new PDF, a new confirm link and a mail that says what changed
 *              (`revisionMailOpening`), and confirms the new revision again.
 *   diff       `revisionDiff(before, after)`: the header fields and, per line, added, removed, cancelled or changed (which
 *              fields, from → to); `priceDiff` the same for the prices (the office with the cost grain only); words for
 *              the mail and the link page (`changeWords`, it/en).
 *
 * A revision row is append-only; the partner role reads its party's rows without the prices (the confirm link shows what
 * changed in quantities and dates, Owner design answer C2).
 */

// ---- the state of a revision ----------------------------------------------------------------------------------------------

export interface RevisionLineProposal {
  readonly quantity: string | null
  readonly date: BusinessDate | null
  readonly splitQuantity: string | null
  readonly splitDate: BusinessDate | null
  readonly reason: string | null
}

/** One line as a revision freezes it (quantities as stored, four places). */
export interface RevisionLine {
  readonly id: string
  readonly seq: number
  readonly itemId: string
  readonly itemColourId: string | null
  readonly description: string | null
  readonly supplierArticleCode?: string | null | undefined
  readonly supplierColourCode?: string | null | undefined
  readonly quantity: string
  readonly uom: string
  readonly needDate: BusinessDate
  readonly grade?: string | null | undefined
  readonly thicknessMinMm?: string | null | undefined
  readonly thicknessMaxMm?: string | null | undefined
  readonly oneDyeBatch?: boolean | undefined
  readonly areaTolerancePct?: string | null | undefined
  readonly note?: string | null | undefined
  readonly confirmedQuantity: string | null
  readonly confirmedDate: BusinessDate | null
  readonly proposal?: RevisionLineProposal | null | undefined
  readonly cancelled: boolean
  readonly closedShort?: boolean | undefined
}

export interface RevisionConfirmation {
  readonly at: string
  readonly via: 'LINK' | 'OFFICE'
  readonly byName: string | null
  readonly supplierRef: string | null
}

/** The order as a revision was sent (`after`), or as it stood with its answer when it was changed (`before`). */
export interface RevisionState {
  readonly requestedDate: BusinessDate | null
  readonly incoterms: string | null
  readonly paymentTerms: string | null
  readonly note: string | null
  readonly status: string
  readonly confirmation: RevisionConfirmation | null
  readonly decline?: { readonly at: string; readonly reason: string | null } | null | undefined
  readonly proposal?: { readonly at: string; readonly byName: string | null; readonly supplierRef: string | null; readonly note: string | null; readonly decision: string | null } | null | undefined
  readonly lines: readonly RevisionLine[]
}

/** The prices of a state (the cost grain): decimal strings and minor units, never floats. */
export interface RevisionPrices {
  readonly currency: string
  readonly netAmount: number
  readonly lines: readonly { readonly id: string; readonly seq: number; readonly unitPrice: string; readonly netAmount: number }[]
}

const bySeq = <Line extends { readonly seq: number }>(lines: readonly Line[]): Line[] => [...lines].sort((a, b) => a.seq - b.seq)

/** A state with its lines in order (the API maps the rows; this keeps one shape). */
export const revisionStateOf = (state: RevisionState): RevisionState => ({ ...state, lines: bySeq(state.lines) })

/** The prices of the open (not cancelled) lines and their sum: what the order is worth as sent. */
export function revisionPricesOf(currency: string, lines: readonly { readonly id: string; readonly seq: number; readonly unitPrice: string; readonly netAmount: number; readonly cancelled: boolean }[]): RevisionPrices {
  const open = bySeq(lines).filter((line) => !line.cancelled)
  return { currency, netAmount: open.reduce((sum, line) => sum + line.netAmount, 0), lines: open.map((line) => ({ id: line.id, seq: line.seq, unitPrice: line.unitPrice, netAmount: line.netAmount })) }
}

// ---- the rules of a change ---------------------------------------------------------------------------------------------------

export const MAX_CHANGE_NOTE = 1000

/** Whether the buyer may start the next revision of the order now (Change); null when it may, else why not. */
export function changeProblem(status: PurchaseOrderStatus): string | null {
  switch (status) {
    case 'SENT':
    case 'DECLINED':
    case 'CONFIRMED':
      return null
    case 'DRAFT':
      return 'The order is a draft: change it and send it.'
    case 'CHANGES_PROPOSED':
      return "The supplier proposed changes: accept them, refuse them, or counter-propose (a new revision from what you asked)."
    case 'PARTLY_RECEIVED':
    case 'RECEIVED':
      return 'Goods were received against this order: it is not changed any more. Cancel a line, or close it short.'
    case 'CLOSED':
    case 'CANCELLED':
      return `The order is ${STATUS_WORDS[status]} already.`
  }
}

/** A counter-proposal answers the supplier's proposal: only while it waits for the buyer. */
export function counterProblem(status: PurchaseOrderStatus): string | null {
  if (status === 'CHANGES_PROPOSED') return null
  if (status === 'SENT' || status === 'DECLINED' || status === 'CONFIRMED') return 'The order has no proposal waiting for your decision: change it instead.'
  return 'The order has no proposal waiting for a decision.'
}

/** The supplier's answer to a revision, in a word, from the state it was left in. */
export const REVISION_ANSWERS = ['NOT_SENT', 'WAITING', 'CONFIRMED', 'DECLINED', 'CHANGES_PROPOSED', 'RECEIVED', 'CANCELLED'] as const
export type RevisionAnswer = (typeof REVISION_ANSWERS)[number]

export function answerOfState(status: string, confirmed: boolean): RevisionAnswer {
  switch (status) {
    case 'DRAFT':
      return 'NOT_SENT'
    case 'SENT':
      return 'WAITING'
    case 'CONFIRMED':
      return 'CONFIRMED'
    case 'DECLINED':
      return 'DECLINED'
    case 'CHANGES_PROPOSED':
      return 'CHANGES_PROPOSED'
    case 'PARTLY_RECEIVED':
    case 'RECEIVED':
    case 'CLOSED':
      return confirmed ? 'CONFIRMED' : 'RECEIVED'
    default:
      return 'CANCELLED'
  }
}

// ---- the diff ---------------------------------------------------------------------------------------------------------------

export const HEADER_FIELDS = ['requestedDate', 'incoterms', 'paymentTerms', 'note'] as const
export type HeaderField = (typeof HEADER_FIELDS)[number]

export const LINE_FIELDS = ['quantity', 'needDate', 'itemColourId', 'description', 'supplierArticleCode', 'supplierColourCode', 'grade', 'thicknessMinMm', 'thicknessMaxMm', 'oneDyeBatch', 'areaTolerancePct', 'note'] as const
export type LineField = (typeof LINE_FIELDS)[number]

export const LINE_DIFF_KINDS = ['ADDED', 'REMOVED', 'CANCELLED', 'CHANGED'] as const
export type LineDiffKind = (typeof LINE_DIFF_KINDS)[number]

export interface FieldChange<Field extends string = string> {
  readonly field: Field
  readonly before: string | null
  readonly after: string | null
}

export interface LineDiff {
  readonly lineId: string
  readonly seq: number
  readonly itemId: string
  readonly kind: LineDiffKind
  /** CHANGED: the fields, from → to (a quantity with its unit). ADDED, REMOVED and CANCELLED: none. */
  readonly changes: readonly FieldChange<LineField>[]
}

export interface RevisionDiff {
  readonly header: readonly FieldChange<HeaderField>[]
  readonly lines: readonly LineDiff[]
  /** How many things changed (header fields + lines). */
  readonly count: number
}

const textOf = (value: unknown): string | null => (value === undefined || value === null || value === '' ? null : typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value))

function lineValue(line: RevisionLine, field: LineField): string | null {
  if (field === 'quantity') return `${line.quantity} ${line.uom}`
  if (field === 'oneDyeBatch') return line.oneDyeBatch === undefined ? null : textOf(line.oneDyeBatch)
  return textOf(line[field])
}

/**
 * What changed from one revision to the next: the header fields, and per line (by id, in line order) added, removed,
 * cancelled, or the fields that changed. A line cancelled before and after is no change; `before` null (revision 1) is
 * no change at all.
 */
export function revisionDiff(before: RevisionState | null, after: RevisionState): RevisionDiff {
  if (before === null) return { header: [], lines: [], count: 0 }
  const header = HEADER_FIELDS.flatMap((field): FieldChange<HeaderField>[] => {
    const from = textOf(before[field])
    const to = textOf(after[field])
    return from === to ? [] : [{ field, before: from, after: to }]
  })
  const old = new Map(before.lines.map((line) => [line.id, line]))
  const now = new Map(after.lines.map((line) => [line.id, line]))
  const lines: LineDiff[] = []
  for (const line of after.lines) {
    const was = old.get(line.id)
    if (!was) {
      lines.push({ lineId: line.id, seq: line.seq, itemId: line.itemId, kind: 'ADDED', changes: [] })
      continue
    }
    if (line.cancelled && !was.cancelled) {
      lines.push({ lineId: line.id, seq: line.seq, itemId: line.itemId, kind: 'CANCELLED', changes: [] })
      continue
    }
    if (line.cancelled) continue
    const changes = LINE_FIELDS.flatMap((field): FieldChange<LineField>[] => {
      const from = lineValue(was, field)
      const to = lineValue(line, field)
      // A field a stored state did not keep (an older shape) is not a change.
      if (field !== 'quantity' && field !== 'needDate' && field !== 'itemColourId' && field !== 'description' && (was[field as keyof RevisionLine] === undefined || line[field as keyof RevisionLine] === undefined)) return []
      return from === to ? [] : [{ field, before: from, after: to }]
    })
    if (changes.length > 0) lines.push({ lineId: line.id, seq: line.seq, itemId: line.itemId, kind: 'CHANGED', changes })
  }
  for (const line of before.lines) if (!now.has(line.id) && !line.cancelled) lines.push({ lineId: line.id, seq: line.seq, itemId: line.itemId, kind: 'REMOVED', changes: [] })
  const sorted = lines.sort((a, b) => a.seq - b.seq)
  return { header, lines: sorted, count: header.length + sorted.length }
}

export interface PriceDiff {
  readonly netAmount: { readonly before: number; readonly after: number } | null
  readonly lines: readonly { readonly lineId: string; readonly seq: number; readonly unitPrice: { readonly before: string | null; readonly after: string | null } | null; readonly netAmount: { readonly before: number | null; readonly after: number | null } }[]
}

/** The prices that changed (the office's view with the cost grain): the total, and each line's price and amount. */
export function priceDiff(before: RevisionPrices | null, after: RevisionPrices): PriceDiff {
  if (before === null) return { netAmount: null, lines: [] }
  const old = new Map(before.lines.map((line) => [line.id, line]))
  const now = new Map(after.lines.map((line) => [line.id, line]))
  const ids = [...new Set([...before.lines.map((line) => line.id), ...after.lines.map((line) => line.id)])]
  const lines = ids.flatMap((lineId) => {
    const was = old.get(lineId)
    const is = now.get(lineId)
    if (was && is && was.unitPrice === is.unitPrice && was.netAmount === is.netAmount) return []
    return [
      {
        lineId,
        seq: (is ?? was)!.seq,
        unitPrice: was?.unitPrice === is?.unitPrice ? null : { before: was?.unitPrice ?? null, after: is?.unitPrice ?? null },
        netAmount: { before: was?.netAmount ?? null, after: is?.netAmount ?? null },
      },
    ]
  })
  return { netAmount: before.netAmount === after.netAmount ? null : { before: before.netAmount, after: after.netAmount }, lines: lines.sort((a, b) => a.seq - b.seq) }
}

// ---- in words -------------------------------------------------------------------------------------------------------------

const WORDS = {
  it: {
    line: (seq: number, label: string) => `Riga ${seq} (${label})`,
    added: 'nuova riga',
    removed: 'tolta',
    cancelled: 'annullata',
    fields: {
      quantity: 'quantità',
      needDate: 'data di consegna',
      itemColourId: 'colore',
      description: 'descrizione',
      supplierArticleCode: 'vostro codice articolo',
      supplierColourCode: 'vostro codice colore',
      grade: 'scelta',
      thicknessMinMm: 'spessore minimo (mm)',
      thicknessMaxMm: 'spessore massimo (mm)',
      oneDyeBatch: 'un solo bagno',
      areaTolerancePct: 'tolleranza superficie (%)',
      note: 'nota',
      requestedDate: "data di consegna dell'ordine",
      incoterms: 'resa',
      paymentTerms: 'pagamento',
    } satisfies Record<LineField | HeaderField, string>,
    none: '—',
    yes: 'sì',
    no: 'no',
    order: 'Ordine',
  },
  en: {
    line: (seq: number, label: string) => `Line ${seq} (${label})`,
    added: 'new line',
    removed: 'removed',
    cancelled: 'cancelled',
    fields: {
      quantity: 'quantity',
      needDate: 'delivery date',
      itemColourId: 'colour',
      description: 'description',
      supplierArticleCode: 'your article code',
      supplierColourCode: 'your colour code',
      grade: 'grade',
      thicknessMinMm: 'thickness from (mm)',
      thicknessMaxMm: 'thickness to (mm)',
      oneDyeBatch: 'one dye batch',
      areaTolerancePct: 'area tolerance (%)',
      note: 'note',
      requestedDate: 'delivery date of the order',
      incoterms: 'delivery terms',
      paymentTerms: 'payment',
    } satisfies Record<LineField | HeaderField, string>,
    none: '—',
    yes: 'yes',
    no: 'no',
    order: 'Order',
  },
} as const

export interface ChangeLabels {
  /** The line's material as the supplier reads it (its code and name). */
  readonly lineLabel: (lineId: string) => string
  /** A colour id's name. */
  readonly colourName?: (colourId: string) => string | null
}

function valueWords(field: LineField | HeaderField, value: string | null, language: DocumentLanguage, labels: ChangeLabels): string {
  const words = WORDS[language]
  if (value === null) return words.none
  if (field === 'quantity') {
    const [quantity, uom] = value.split(' ')
    return `${formatQuantity(quantity!, language)} ${uomText(uom ?? '')}`.trim()
  }
  if (field === 'needDate' || field === 'requestedDate') return formatDate(value, language)
  if (field === 'itemColourId') return labels.colourName?.(value) ?? value
  if (field === 'oneDyeBatch') return value === 'yes' ? words.yes : words.no
  if (field === 'thicknessMinMm' || field === 'thicknessMaxMm' || field === 'areaTolerancePct') return formatDecimal(value, language, 0, 4)
  return value
}

/** The diff in the supplier's words, one sentence per changed thing (the mail of a revision, the link page). */
export function changeWords(diff: RevisionDiff, language: DocumentLanguage, labels: ChangeLabels): string[] {
  const words = WORDS[language]
  const field = (change: FieldChange<LineField | HeaderField>) => `${words.fields[change.field]} ${valueWords(change.field, change.before, language, labels)} → ${valueWords(change.field, change.after, language, labels)}`
  const header = diff.header.map((change) => `${words.order}: ${field(change)}`)
  const lines = diff.lines.map((line) => {
    const head = words.line(line.seq, labels.lineLabel(line.lineId))
    switch (line.kind) {
      case 'ADDED':
        return `${head}: ${words.added}`
      case 'REMOVED':
        return `${head}: ${words.removed}`
      case 'CANCELLED':
        return `${head}: ${words.cancelled}`
      case 'CHANGED':
        return `${head}: ${line.changes.map(field).join('; ')}`
    }
  })
  return [...header, ...lines]
}

const MAIL = {
  it: {
    hello: (name: string | null) => (name ? `Gentile ${name},` : 'Buongiorno,'),
    intro: (number: string, previous: string) => `le inviamo la revisione ${number} del nostro ordine di acquisto, che sostituisce ${previous}: il documento è in allegato. La preghiamo di confermarla di nuovo.`,
    changed: 'Cosa cambia:',
    unchanged: 'Le quantità e le date non cambiano.',
    why: (note: string) => `Il motivo: ${note}`,
  },
  en: {
    hello: (name: string | null) => (name ? `Dear ${name},` : 'Hello,'),
    intro: (number: string, previous: string) => `please find attached revision ${number} of our purchase order, which replaces ${previous}. Please confirm it again.`,
    changed: 'What changed:',
    unchanged: 'The quantities and dates do not change.',
    why: (note: string) => `Why: ${note}`,
  },
} as const

/**
 * The opening of a revision's mail (the send's `message`, above the link paragraph): the office's own words when it wrote
 * some, else the standard ones; then what changed, line by line, and the buyer's change note.
 */
export function revisionMailOpening(input: {
  readonly language: DocumentLanguage
  readonly number: string
  readonly revision: number
  readonly recipientName: string | null
  readonly changes: readonly string[]
  readonly changeNote: string | null
  readonly message: string | null
}): string {
  const words = MAIL[input.language]
  const current = purchaseOrderDocumentNumber(input.number, input.revision)
  const previous = purchaseOrderDocumentNumber(input.number, input.revision - 1)
  const opening = input.message?.trim() ? input.message.trim() : `${words.hello(input.recipientName)}\n\n${words.intro(current, previous)}`
  const what = input.changes.length > 0 ? `${words.changed}\n${input.changes.map((line) => `- ${line}`).join('\n')}` : words.unchanged
  const why = input.changeNote?.trim() ? `\n\n${words.why(input.changeNote.trim())}` : ''
  return `${opening}\n\n${what}${why}`
}
