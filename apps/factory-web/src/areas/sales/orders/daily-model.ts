import { parsePrice } from '../quotes/model'
import type { StyleDetail } from '../quotes/api'
import type {
  AmendLineInput,
  AmendmentDiff,
  CancelCheck,
  DailyOrderAction,
  ImpactItem,
  Milestone,
  MilestoneStatus,
  NewLineInput,
  Order,
  OrderLine,
  OrderSnapshot,
  OrderStatus,
  PathIssue,
} from './api'
import { isFinal, type OrderAbilities, type Phrase, type Tone } from './model'

/**
 * The order studio every day (B-W2a-50; screens on the API of B-W2a-30), pure: the band's daily verbs and why each
 * waits (in this app's words: the API's held sentences are English), "Close remaining lines" and its reversal, the
 * amendment draft (the Lines tab in amend mode, and the typed New order: one editor) and what it sends, the API's
 * refusals by their place, the cancel's impact in words, the payment schedule, the Changes tab's before → after.
 * No fetching, no React: orders.vitest.test.ts holds them.
 */

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

// ---- the band's daily verbs -------------------------------------------------------------------------------------------

/** Lines change through an amendment while nothing shipped (factory-domain AMEND_STATUSES). */
export const AMEND_STATUSES: readonly OrderStatus[] = ['CONFIRMED', 'IN_PRODUCTION', 'READY']
/** Lines are closed short in these states (factory-domain CLOSE_SHORT_STATUSES); reopened also once SHIPPED. */
export const CLOSE_SHORT_STATUSES: readonly OrderStatus[] = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED']
export const REOPEN_STATUSES: readonly OrderStatus[] = [...CLOSE_SHORT_STATUSES, 'SHIPPED']

export const dailyOf = (order: Pick<Order, 'dailyActions'>, action: DailyOrderAction) => order.dailyActions.find((entry) => entry.action === action) ?? null

/** Pieces of a line still to make or ship: its pieces less what shipped of it. */
export const leftOf = (line: Pick<OrderLine, 'quantity' | 'progress'>): number => Math.max(0, line.quantity - line.progress.shipped)

/** Why "Amend order" waits, or null. */
export function amendHeld(order: Order, can: OrderAbilities): Phrase | null {
  if (!can.manage) return phrase('held.noManage')
  if (isFinal(order)) return phrase('held.final')
  if (!AMEND_STATUSES.includes(order.status)) return phrase('held.amendShipped')
  if (order.lines.some((line) => line.kind !== 'SIZE_GRID')) return phrase('held.amendMtm')
  const daily = dailyOf(order, 'amend')
  if (daily && !daily.allowed) return phrase('held.amendState')
  return null
}

/** Why "Close remaining lines" waits, or null. */
export function closeLinesHeld(order: Order, can: OrderAbilities): Phrase | null {
  if (!can.manage) return phrase('held.noManage')
  if (isFinal(order)) return phrase('held.final')
  if (!CLOSE_SHORT_STATUSES.includes(order.status)) return phrase('held.closeLinesState')
  const open = closableLines(order)
  if (open.length === 0) return phrase('held.closeLinesNone')
  const anyShipped = order.lines.some((line) => line.progress.shipped > 0)
  if (!anyShipped && open.length === 1 && order.lines.filter((line) => !line.closedShort).length === 1) return phrase('held.closeLinesOnly')
  const daily = dailyOf(order, 'closeLines')
  if (daily && !daily.allowed) return phrase('held.closeLinesState')
  return null
}

/** Why "Reopen lines" waits, or null. */
export function reopenHeld(order: Order, can: OrderAbilities): Phrase | null {
  if (!can.manage) return phrase('held.noManage')
  if (!REOPEN_STATUSES.includes(order.status)) return phrase('held.reopenState')
  if (!order.lines.some((line) => line.closedShort)) return phrase('held.reopenNone')
  return null
}

/** Why "Copy as new quote" waits, or null (a cancelled order still copies). */
export const copyHeld = (can: OrderAbilities): Phrase | null => (can.manageQuotes ? null : phrase('held.noQuotes'))

// ---- close remaining lines ----------------------------------------------------------------------------------------------

export interface ClosableLine {
  line: OrderLine
  /** Pieces that will not be made or shipped once it is closed. */
  left: number
  /** Per size: what is left of it. */
  sizes: { size: string; left: number }[]
}

/** The open lines with something left (what "Close remaining lines" may close), in line order. */
export function closableLines(order: Pick<Order, 'lines'>): ClosableLine[] {
  return [...order.lines]
    .sort((a, b) => a.seq - b.seq)
    .filter((line) => !line.closedShort && leftOf(line) > 0)
    .map((line) => ({
      line,
      left: leftOf(line),
      sizes: line.sizes.flatMap((size) => {
        const left = Math.max(0, size.quantity - size.progress.shipped)
        return size.size !== null && left > 0 ? [{ size: size.size, left }] : []
      }),
    }))
}

export const closedLines = (order: Pick<Order, 'lines'>): OrderLine[] => [...order.lines].sort((a, b) => a.seq - b.seq).filter((line) => line.closedShort)

/** The close's own problem with the lines chosen (the API holds the same rule), or null. */
export function closeChoiceProblem(order: Pick<Order, 'lines'>, chosen: readonly string[], reason: string): Phrase | null {
  if (chosen.length === 0) return phrase('closeLines.problem.none')
  const anyShipped = order.lines.some((line) => line.progress.shipped > 0)
  const stillOpen = order.lines.filter((line) => !line.closedShort && !chosen.includes(line.id) && leftOf(line) > 0)
  if (!anyShipped && stillOpen.length === 0 && order.lines.filter((line) => !line.closedShort && !chosen.includes(line.id)).length === 0) return phrase('closeLines.problem.all')
  if (reason.trim() === '') return phrase('closeLines.problem.reason')
  return null
}

/** Pieces of the chosen lines still in work orders (Production decides about them). */
export const inWorkOrdersOf = (order: Pick<Order, 'lines'>, chosen: readonly string[]): number =>
  order.lines.filter((line) => chosen.includes(line.id)).reduce((sum, line) => sum + Math.max(0, line.progress.inWorkOrders - line.progress.shipped), 0)

// ---- the amendment draft (and the typed New order): one editor ------------------------------------------------------------

export interface DraftLine {
  /** The order line's id; a new line: `new:<styleId>:<colourwayId>`. */
  key: string
  lineId: string | null
  styleId: string
  colourwayId: string
  /** Size → pieces (a size at 0 or missing: none). */
  sizes: Record<string, number>
  /** The typed unit price (an order's line starts with its price as accepted; empty on a new line: the customer's list price). */
  price: string
  /** Closed short or made to measure: kept as it is (shown, never edited). */
  locked: boolean
}

export const newKey = (styleId: string, colourwayId: string): string => `new:${styleId}:${colourwayId}`

export const piecesOf = (line: Pick<DraftLine, 'sizes'>): number => Object.values(line.sizes).reduce((sum, value) => sum + (value > 0 ? value : 0), 0)

/** The order's lines as the draft starts: every size, the price as accepted. */
export function draftOf(order: Pick<Order, 'lines'>): DraftLine[] {
  return [...order.lines]
    .sort((a, b) => a.seq - b.seq)
    .map((line) => ({
      key: line.id,
      lineId: line.id,
      styleId: line.styleId,
      colourwayId: line.colourwayId,
      sizes: Object.fromEntries(line.sizes.flatMap((size) => (size.size === null ? [] : [[size.size, size.quantity]]))),
      price: line.unitPrice ?? '',
      locked: !!line.closedShort || line.kind !== 'SIZE_GRID',
    }))
}

/** Draft lines grouped by style, in the order the first line of each style appears. */
export function draftGroups(lines: readonly DraftLine[]): { styleId: string; lines: DraftLine[] }[] {
  const groups: { styleId: string; lines: DraftLine[] }[] = []
  for (const line of lines) {
    const group = groups.find((entry) => entry.styleId === line.styleId)
    if (group) group.lines.push(line)
    else groups.push({ styleId: line.styleId, lines: [line] })
  }
  return groups
}

export interface LineNames {
  style: string
  colour: string
  swatch?: string | null
}

/** What a draft line is called: from the order's own line, else from the style read (codes; never an id). */
export function namesOf(line: Pick<DraftLine, 'lineId' | 'styleId' | 'colourwayId'>, order: Pick<Order, 'lines'> | null, style: StyleDetail | null | undefined): LineNames {
  const own = line.lineId ? order?.lines.find((entry) => entry.id === line.lineId) : order?.lines.find((entry) => entry.styleId === line.styleId && entry.colourwayId === line.colourwayId)
  const colourway = style?.colourways.find((entry) => entry.id === line.colourwayId)
  return {
    style: own?.style?.code ?? style?.code ?? '—',
    colour: colourway ? `${colourway.code} · ${colourway.name}` : own?.colourway ? `${own.colourway.code} · ${own.colourway.name}` : '—',
    swatch: colourway?.colour?.hex ?? null,
  }
}

/** A style block's grid: the style's sizes when read (else what its lines hold), one row per editable draft line. */
export function draftGrid(lines: readonly DraftLine[], style: StyleDetail | null | undefined, order: Pick<Order, 'lines'> | null) {
  const editable = lines.filter((line) => !line.locked)
  const labels = new Map(style?.matrix.sizes.map((size) => [size.code, size.label]) ?? [])
  const keys: string[] = style ? [...style.sizes] : []
  for (const line of lines) for (const size of Object.keys(line.sizes)) if (!keys.includes(size)) keys.push(size)
  const colours = editable.map((line) => {
    const names = namesOf(line, order, style)
    const offered = style?.colourways.find((entry) => entry.id === line.colourwayId)?.offeredSizes
    // A size the line already holds stays offered (the order may hold one the style no longer offers).
    const holds = Object.keys(line.sizes).filter((size) => (line.sizes[size] ?? 0) > 0)
    return { key: line.key, label: names.colour, swatch: names.swatch ?? null, offered: offered ? [...new Set([...offered, ...holds])] : keys }
  })
  const value: Record<string, Record<string, number>> = {}
  for (const line of editable) value[line.key] = { ...line.sizes }
  return { sizes: keys.map((key) => ({ key, label: labels.get(key) ?? key })), colours, value }
}

/** A grid's change back into the draft (only the rows the grid holds). */
export function withCells(lines: readonly DraftLine[], next: Readonly<Record<string, Readonly<Record<string, number>>>>): DraftLine[] {
  return lines.map((line) => (next[line.key] ? { ...line, sizes: Object.fromEntries(Object.entries(next[line.key]!).filter(([, value]) => value > 0)) } : line))
}

const sizeInputs = (line: Pick<DraftLine, 'sizes'>) =>
  Object.entries(line.sizes)
    .filter(([, quantity]) => quantity > 0)
    .map(([size, quantity]) => ({ size, quantity }))

const sameSizes = (line: OrderLine, draft: DraftLine): boolean => {
  const key = (rows: { size: string; quantity: number }[]) =>
    [...rows]
      .filter((row) => row.quantity > 0)
      .sort((a, b) => a.size.localeCompare(b.size))
      .map((row) => `${row.size}:${row.quantity}`)
      .join(',')
  return key(line.sizes.flatMap((size) => (size.size === null ? [] : [{ size: size.size, quantity: size.quantity }]))) === key(sizeInputs(draft))
}

/** A typed price that is not one ("4,5,0"), so the draft cannot be reviewed yet. */
export const badPrice = (line: Pick<DraftLine, 'price'>): boolean => line.price.trim() !== '' && parsePrice(line.price) === null

export type DraftChange = 'added' | 'removed' | 'changed'

/** What happens to each line of the draft (null: nothing). */
export function changeOf(line: DraftLine, order: Pick<Order, 'lines'> | null): DraftChange | null {
  if (!line.lineId) return piecesOf(line) > 0 ? 'added' : null
  const own = order?.lines.find((entry) => entry.id === line.lineId)
  if (!own || line.locked) return null
  if (piecesOf(line) === 0) return 'removed'
  if (!sameSizes(own, line)) return 'changed'
  if (line.price.trim() !== '' && parsePrice(line.price) !== null && Number(parsePrice(line.price)) !== Number(own.unitPrice ?? 'NaN')) return 'changed'
  return null
}

/** How many lines the draft changes (the bar's count; 0: nothing to review). */
export const changeCount = (lines: readonly DraftLine[], order: Pick<Order, 'lines'>): number => lines.filter((line) => changeOf(line, order) !== null).length

/** What an amendment sends, beside the draft line each entry comes from (the API's refusals name the entry's index). */
export function amendPairs(lines: readonly DraftLine[], order: Pick<Order, 'lines'>): { draft: DraftLine; input: AmendLineInput }[] {
  const out: { draft: DraftLine; input: AmendLineInput }[] = []
  for (const line of lines) {
    if (line.lineId) {
      const own = order.lines.find((entry) => entry.id === line.lineId)
      if (!own) continue
      if (line.locked) {
        out.push({ draft: line, input: { id: line.lineId } })
        continue
      }
      if (piecesOf(line) === 0) continue
      const price = parsePrice(line.price)
      const priceChanged = price !== null && Number(price) !== Number(own.unitPrice ?? 'NaN')
      out.push({ draft: line, input: { id: line.lineId, sizes: sizeInputs(line), ...(priceChanged ? { unitPrice: price } : {}) } })
      continue
    }
    if (piecesOf(line) === 0) continue
    const price = parsePrice(line.price)
    out.push({ draft: line, input: { styleId: line.styleId, colourwayId: line.colourwayId, sizes: sizeInputs(line), ...(price !== null ? { unitPrice: price } : {}) } })
  }
  return out
}

/** What an amendment sends: every line the order keeps (a line left out is removed), new lines with pieces. */
export const amendLines = (lines: readonly DraftLine[], order: Pick<Order, 'lines'>): AmendLineInput[] => amendPairs(lines, order).map((pair) => pair.input)

/** What a typed order sends: its lines with pieces (an empty price: the customer's list price). */
export function manualLines(lines: readonly DraftLine[]): NewLineInput[] {
  return lines
    .filter((line) => piecesOf(line) > 0)
    .map((line) => {
      const price = parsePrice(line.price)
      return { styleId: line.styleId, colourwayId: line.colourwayId, sizes: sizeInputs(line), ...(price !== null ? { unitPrice: price } : {}) }
    })
}

/** Pieces work orders already make, per line and size: an amendment never goes under them. */
export function minimumsOf(order: Pick<Order, 'lines'>): Record<string, Record<string, number>> {
  return Object.fromEntries(order.lines.map((line) => [line.id, Object.fromEntries(line.sizes.flatMap((size) => (size.size !== null && size.progress.inWorkOrders > 0 ? [[size.size, size.progress.inWorkOrders]] : [])))]))
}

/** Cells typed under what work orders already make (the grid says so; the API refuses it too). */
export function underWorkOrders(lines: readonly DraftLine[], minimums: Readonly<Record<string, Readonly<Record<string, number>>>>): { key: string; size: string; made: number }[] {
  const out: { key: string; size: string; made: number }[] = []
  for (const line of lines) {
    const mins = line.lineId ? minimums[line.lineId] : undefined
    if (!mins || line.locked) continue
    for (const [size, made] of Object.entries(mins)) if ((line.sizes[size] ?? 0) < made) out.push({ key: line.key, size, made })
  }
  return out
}

/** Why the draft cannot be reviewed yet (in this app's words), or null. */
export function reviewHeld(lines: readonly DraftLine[], order: Pick<Order, 'lines'>, minimums: Readonly<Record<string, Readonly<Record<string, number>>>>, header: { changed: boolean }): Phrase | null {
  if (lines.some(badPrice)) return phrase('amend.held.price')
  if (underWorkOrders(lines, minimums).length > 0) return phrase('amend.held.workOrders')
  if (amendLines(lines, order).length === 0) return phrase('amend.held.empty')
  if (changeCount(lines, order) === 0 && !header.changed) return phrase('amend.held.nothing')
  return null
}

// ---- the API's refusals, by their place, in this app's words ---------------------------------------------------------------

const LINE_FIELDS: Record<string, string> = { sizes: 'sizes', quantity: 'sizes', unitPrice: 'price', colourwayId: 'catalogue', styleId: 'catalogue', id: 'moved', description: 'text', note: 'text' }
const HEADER_FIELDS: Record<string, string> = {
  reason: 'reason',
  partyId: 'party',
  contactId: 'contact',
  billToAddressId: 'billTo',
  shipToAddressId: 'shipTo',
  promiseDate: 'promiseDate',
  requestedDate: 'requestedDate',
  customerRef: 'customerRef',
  depositPct: 'deposit',
  depositKind: 'deposit',
  companyId: 'number',
  paymentTermsId: 'terms',
  internalNote: 'text',
  lines: 'lines',
}

/**
 * A refusal (path + the API's English) as this app's words, by its place only: `body/lines/2/sizes` → "Line 2 ·
 * DEMO-JKT-01 BLK: check its sizes…". `label(index)` names the line the body sent at that index.
 */
export function issueWords(issue: PathIssue, label: (index: number) => string | null): Phrase {
  const parts = issue.path.replace(/^body\/?/, '').split(/[/.]/).filter(Boolean)
  if (parts.length === 0) return phrase('issue.state')
  if (parts[0] === 'lines' && parts.length >= 2 && /^\d+$/.test(parts[1]!)) {
    const kind = LINE_FIELDS[parts[2] ?? ''] ?? 'other'
    return phrase(`issue.line.${kind}`, { line: label(Number(parts[1])) ?? String(Number(parts[1]) + 1) })
  }
  return phrase(`issue.${HEADER_FIELDS[parts[0]!] ?? 'other'}`)
}

/** The refusals in words, each said once. */
export function issuePhrases(issues: readonly PathIssue[], label: (index: number) => string | null): Phrase[] {
  const seen = new Set<string>()
  const out: Phrase[] = []
  for (const issue of issues) {
    const words = issueWords(issue, label)
    const id = `${words.key}|${JSON.stringify(words.params ?? {})}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push(words)
  }
  return out
}

// ---- the cancel's impact check ----------------------------------------------------------------------------------------------

const numbersOf = (item: Pick<ImpactItem, 'refs'>): string =>
  item.refs
    .map((ref) => ref.number)
    .filter((number): number is string => !!number)
    .join(', ')

/** One line of the impact in this app's words (numbers and counts as values; the amount travels beside it). */
export function impactWords(item: ImpactItem, check: Pick<CancelCheck, 'leatherCut' | 'status'> | null): Phrase {
  const refs = numbersOf(item)
  const count = item.refs.length
  switch (item.code) {
    case 'STATE':
      return phrase(check && isFinal({ status: check.status }) ? 'impact.STATE_final' : 'impact.STATE_shipped')
    case 'LEATHER_CUT':
      return phrase('impact.LEATHER_CUT', { count: (check?.leatherCut ?? []).reduce((sum, row) => sum + row.hides, 0), refs: refs || '—' })
    case 'DEPOSITS_CANCELLED':
    case 'STOCK_RESERVED':
    case 'PAYMENT_STEPS_CANCELLED':
    case 'PAYMENT_STEPS_PAID':
    case 'INVOICE_DRAFT':
      return phrase(`impact.${item.code}`, { count })
    case 'DEPOSIT_PAID': {
      const invoices = item.refs.filter((ref) => ref.type === 'Invoice').map((ref) => ref.number ?? '—')
      return invoices.length > 0 ? phrase('impact.DEPOSIT_PAID_invoiced', { refs: invoices.join(', ') }) : phrase('impact.DEPOSIT_PAID')
    }
    default:
      return phrase(`impact.${item.code}`, { refs: refs || '—', count })
  }
}

/** The record types an impact names that have a page to open (the rest are named only). */
export const IMPACT_LINKED = new Set(['WorkOrder', 'Shipment', 'Invoice', 'PurchaseOrder'])

/** Why "Cancel order" waits inside its dialog, or null. */
export function cancelConfirmHeld(input: { check: CancelCheck | null; reason: string; typed: string; number: string }): Phrase | null {
  if (!input.check) return phrase('cancel.held.reading')
  if (!input.check.impact.cancellable) return phrase('cancel.held.blocked')
  if (input.reason.trim() === '') return phrase('cancel.held.reason')
  if (input.typed.trim() !== input.number) return phrase('cancel.held.number', { number: input.number })
  return null
}

// ---- the payment schedule ---------------------------------------------------------------------------------------------------

export const MILESTONE_TONE: Record<MilestoneStatus, Tone> = { OPEN: 'info', PAID: 'success', WAIVED: 'neutral', CANCELLED: 'neutral' }

export const isOverdue = (step: Pick<Milestone, 'status' | 'dueDate'>, today: string): boolean => step.status === 'OPEN' && step.dueDate !== null && step.dueDate < today

// ---- the Changes tab: before → after --------------------------------------------------------------------------------------

export interface CompareRow {
  lineId: string
  seq: number
  styleId: string
  colourwayId: string
  change: 'ADDED' | 'REMOVED' | 'CHANGED' | null
  sizes: { size: string; before: number; after: number }[]
  piecesBefore: number
  piecesAfter: number
  priceBefore: string | null
  priceAfter: string | null
  netBefore: number | null
  netAfter: number | null
}

/** The VersionCompare rows: every line of before and after, its sizes old → new and its price (price grain). */
export function compareRows(before: OrderSnapshot, after: OrderSnapshot): CompareRow[] {
  const ids = [...new Set([...before.lines.map((line) => line.id), ...after.lines.map((line) => line.id)])]
  return ids
    .map((id) => {
      const old = before.lines.find((line) => line.id === id)
      const next = after.lines.find((line) => line.id === id)
      const sizeKeys = [...new Set([...(old?.sizes ?? []).map((size) => size.size), ...(next?.sizes ?? []).map((size) => size.size)])]
      const sizes = sizeKeys.map((size) => ({ size, before: old?.sizes.find((entry) => entry.size === size)?.quantity ?? 0, after: next?.sizes.find((entry) => entry.size === size)?.quantity ?? 0 }))
      const changed = sizes.some((size) => size.before !== size.after) || old?.unitPrice !== next?.unitPrice
      const change: CompareRow['change'] = !old ? 'ADDED' : !next ? 'REMOVED' : changed ? 'CHANGED' : null
      const line = (next ?? old)!
      return {
        lineId: id,
        seq: line.seq,
        styleId: line.styleId,
        colourwayId: line.colourwayId,
        change,
        sizes,
        piecesBefore: old?.quantity ?? 0,
        piecesAfter: next?.quantity ?? 0,
        priceBefore: old?.unitPrice ?? null,
        priceAfter: next?.unitPrice ?? null,
        netBefore: old?.netAmount ?? null,
        netAfter: next?.netAmount ?? null,
      }
    })
    .sort((a, b) => a.seq - b.seq)
}

/** The sizes of a change in one short line: "50: 2 → 3 · 54: 0 → 2". */
export const sizesText = (sizes: readonly { size: string; before: number; after: number }[]): string =>
  sizes
    .filter((size) => size.before !== size.after)
    .map((size) => `${size.size}: ${size.before} → ${size.after}`)
    .join(' · ')

/** The money change of an amendment (price grain), or null without it. */
export function moneyChange(diff: Pick<AmendmentDiff, 'netAmountBefore' | 'netAmountAfter'>): { before: number; after: number; delta: number } | null {
  if (diff.netAmountBefore === undefined || diff.netAmountAfter === undefined) return null
  return { before: diff.netAmountBefore, after: diff.netAmountAfter, delta: diff.netAmountAfter - diff.netAmountBefore }
}

/** A line of an amendment as people call it: its style and colour from the order (or a style read), else its number. */
export function changeLabel(row: { lineId: string; seq: number; styleId: string; colourwayId: string }, order: Pick<Order, 'lines'>, styles: Readonly<Record<string, StyleDetail | null | undefined>>): { line: string; what: string | null } {
  const own = order.lines.find((line) => line.id === row.lineId)
  if (own) return { line: String(own.seq), what: `${own.style?.code ?? '—'} · ${own.colourway?.code ?? '—'}` }
  const style = styles[row.styleId]
  const sameStyle = order.lines.find((line) => line.styleId === row.styleId)
  const sameColour = order.lines.find((line) => line.colourwayId === row.colourwayId)
  const code = style?.code ?? sameStyle?.style?.code ?? null
  const colour = style?.colourways.find((entry) => entry.id === row.colourwayId)?.code ?? sameColour?.colourway?.code ?? null
  return { line: String(row.seq), what: code ? `${code}${colour ? ` · ${colour}` : ''}` : null }
}
