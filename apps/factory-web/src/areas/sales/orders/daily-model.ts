import { parsePrice } from '../quotes/model'
import type { StyleDetail } from '../quotes/api'
import type {
  AmendLineInput,
  AmendmentDiff,
  AmendPreview, // F-OP-106
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
import type { Followed, FollowRoute, WorkOrderPlan } from './api' // F-OP-106
// F-OP-107 (B2): the extra pieces' outcomes, in the review window's words (factory-domain's).
import type { ExtraPiecesView } from './api'
import type { ExtraOutcome } from '@nexus/factory-domain/order-apply/rules'
import { outcomeOptionsOf } from '@nexus/factory-domain/sales/change-requests/apply-plan'
import type { ExtraChoice, ExtraPiece } from '../../home/approvals/requests/view/ExtraPieces' // the picker's props (types only)
import { isFinal, type OrderAbilities, type Phrase, type Tone } from './model'
import { frozenProblemsOf } from './depth/model' // F-OP-106: the freeze rules' refusals are the strip's own part
// F-OP-108: a frozen field makes Apply a priced change (the freeze read says whether it still may), with its optional fee.
import { frozenOffer, PRICED_EMPTY, pricedProblems } from './depth/model'
import type { Freeze } from './depth/api'
// B-W2b-374: a new line's options.
import type { PickBody } from '../quotes/record/configurator/api'

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
  // B-W2b-368 (XF1:01): a made-to-measure unit is amended with its order (kept as it is). F-OL-01 (ol-s1, B-OL-012): a fee line no
  // longer holds a change — the server keeps it as it is (`held.amendFee` went).
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

/**
 * The close's own problem with the lines chosen (the API holds the same rule), or null. B-W2b-16: when the CANCEL list is
 * read, a code of it is asked too (the words stay required); a list that could not be read asks none (the API takes none).
 */
export function closeChoiceProblem(order: Pick<Order, 'lines'>, chosen: readonly string[], reason: string, reasonCode = '', reasons: readonly { readonly code: string }[] | null = null): Phrase | null {
  if (chosen.length === 0) return phrase('closeLines.problem.none')
  const anyShipped = order.lines.some((line) => line.progress.shipped > 0)
  const stillOpen = order.lines.filter((line) => !line.closedShort && !chosen.includes(line.id) && leftOf(line) > 0)
  if (!anyShipped && stillOpen.length === 0 && order.lines.filter((line) => !line.closedShort && !chosen.includes(line.id)).length === 0) return phrase('closeLines.problem.all')
  if (reasons && reasons.length > 0 && !reasons.some((entry) => entry.code === reasonCode)) return phrase('closeLines.problem.reasonCode')
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
  /** B-W2b-374 (XF3:02): a new line's options, chosen in its Options dialog (sent with the line). */
  options?: PickBody[]
  /** F-OP-109: the line's description and its note for production (no prices), as typed in edit mode; absent: not edited here. */
  text?: { readonly description: string; readonly note: string }
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
      text: { description: line.description ?? '', note: line.note ?? '' }, // F-OP-109
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

// ---- F-OP-109: a line's text in edit mode ----
/** The description and note an amendment sends for a line: only what differs from the order's (empty: cleared); a new line's when typed. */
export function textOf(line: Pick<DraftLine, 'text'>, own: Pick<OrderLine, 'description' | 'note'> | null): { description?: string | null; note?: string | null } {
  if (!line.text) return {}
  const out: { description?: string | null; note?: string | null } = {}
  for (const field of ['description', 'note'] as const) {
    const typed = line.text[field].trim() || null
    if (typed !== (own?.[field] ?? null)) out[field] = typed
  }
  return out
}
// ---- end F-OP-109

/** What happens to each line of the draft (null: nothing). */
export function changeOf(line: DraftLine, order: Pick<Order, 'lines'> | null): DraftChange | null {
  if (!line.lineId) return piecesOf(line) > 0 ? 'added' : null
  const own = order?.lines.find((entry) => entry.id === line.lineId)
  if (!own || line.locked) return null
  if (piecesOf(line) === 0) return 'removed'
  if (!sameSizes(own, line)) return 'changed'
  if (Object.keys(textOf(line, own)).length > 0) return 'changed' // F-OP-109
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
      out.push({ draft: line, input: { id: line.lineId, sizes: sizeInputs(line), ...(priceChanged ? { unitPrice: price } : {}), ...textOf(line, own) /* F-OP-109 */ } })
      continue
    }
    if (piecesOf(line) === 0) continue
    const price = parsePrice(line.price)
    out.push({ draft: line, input: { styleId: line.styleId, colourwayId: line.colourwayId, sizes: sizeInputs(line), ...(price !== null ? { unitPrice: price } : {}), ...(line.options?.length ? { options: line.options } : {}), ...textOf(line, null) /* F-OP-109 */ } })
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
      return { styleId: line.styleId, colourwayId: line.colourwayId, sizes: sizeInputs(line), ...(price !== null ? { unitPrice: price } : {}), ...(line.options?.length ? { options: line.options } : {}) }
    })
}

/**
 * Pieces work orders already make, per line and size. F-SA-231 (lead note after B-SA-042, R1): an amendment MAY go under them now —
 * the work order follows as a work-order change ("Still to do"); the editor says so in words (a warning, never a hold). F-OP-107: under
 * what is CUT its extra pieces get an outcome (`cellIssuesOf`); under what SHIPPED it never goes.
 */
export function minimumsOf(order: Pick<Order, 'lines'>): Record<string, Record<string, number>> {
  return Object.fromEntries(order.lines.map((line) => [line.id, Object.fromEntries(line.sizes.flatMap((size) => (size.size !== null && size.progress.inWorkOrders > 0 ? [[size.size, size.progress.inWorkOrders]] : [])))]))
}

// ── F-OP-107 (B2; 10-order-page §4.2; review R-16): the floors of each cell — what shipped, what is cut, what work orders make ──
/** One cell's floors: pieces of the order's own cells already cut and already shipped (a step not counted there: 0). */
export interface CellFloor {
  readonly cut: number
  readonly shipped: number
}
export type CellFloors = Readonly<Record<string, Readonly<Record<string, CellFloor>>>>

type ReadLine = { readonly lineId: string; readonly cut: number | null; readonly sewn: number | null; readonly shipped: number; readonly sizes: readonly { readonly size: string | null; readonly cut: number | null; readonly shipped: number }[] }

/** The floors per line and size from the production read's own cells (shipped per size is in the read: R-16). */
export function cellFloorsOf(lines: readonly ReadLine[]): CellFloors {
  return Object.fromEntries(lines.map((line) => [line.lineId, Object.fromEntries(line.sizes.flatMap((size) => (size.size !== null && ((size.cut ?? 0) > 0 || size.shipped > 0) ? [[size.size, { cut: size.cut ?? 0, shipped: size.shipped }]] : [])))]))
}

/** "Cut 40 · Sewn 32 · Shipped 0" of a colour line (null: the step is not counted there — never a made-up 0). */
export interface LineFigures {
  readonly cut: number | null
  readonly sewn: number | null
  readonly shipped: number
}
export const lineFiguresOf = (lines: readonly ReadLine[]): Record<string, LineFigures> => Object.fromEntries(lines.map((line) => [line.lineId, { cut: line.cut, sewn: line.sewn, shipped: line.shipped }]))

export type CellIssueKind = 'shipped' | 'cut' | 'inWork'
/** One cell typed under a floor: under what shipped (held: it cannot go lower), under what is cut (the extra pieces get an outcome), under what work orders make (the work order follows). */
export interface CellIssue {
  readonly key: string
  readonly size: string
  readonly kind: CellIssueKind
  /** shipped: the pieces shipped; cut: the pieces cut beyond the figure typed; inWork: what work orders make. */
  readonly count: number
}

/** Each cell's strongest floor it is typed under (shipped, then cut, then in work orders); a line kept as it is never has one. */
export function cellIssuesOf(lines: readonly DraftLine[], floors: CellFloors, minimums: Readonly<Record<string, Readonly<Record<string, number>>>> = {}): CellIssue[] {
  const out: CellIssue[] = []
  for (const line of lines) {
    if (!line.lineId || line.locked) continue
    const own = floors[line.lineId] ?? {}
    const made = minimums[line.lineId] ?? {}
    for (const size of [...new Set([...Object.keys(own), ...Object.keys(made)])]) {
      const typed = line.sizes[size] ?? 0
      const floor = own[size]
      if (floor && typed < floor.shipped) out.push({ key: line.key, size, kind: 'shipped', count: floor.shipped })
      else if (floor && typed < floor.cut) out.push({ key: line.key, size, kind: 'cut', count: floor.cut - typed })
      else if (typed < (made[size] ?? 0)) out.push({ key: line.key, size, kind: 'inWork', count: made[size]! })
    }
  }
  return out
}
// ── end F-OP-107

/**
 * Why the draft cannot be applied yet (in this app's words), or null. F-OP-107 (B2): under what already shipped holds; under what is
 * cut no longer does — its extra pieces get an outcome in the strip; under work orders never did.
 */
export function reviewHeld(lines: readonly DraftLine[], order: Pick<Order, 'lines'>, header: { changed: boolean }, floors: CellFloors = {}): Phrase | null {
  if (lines.some(badPrice)) return phrase('amend.held.price')
  if (cellIssuesOf(lines, floors).some((issue) => issue.kind === 'shipped')) return phrase('edit.held.shipped')
  if (amendLines(lines, order).length === 0) return phrase('amend.held.empty')
  if (changeCount(lines, order) === 0 && !header.changed) return phrase('amend.held.nothing')
  return null
}

// ---- F-OP-106 (order page N2; 10-order-page §4.1; review R-4): the "What changes" strip — fed by the amendment's preview ----------

/** The draft as the strip reads it (record-model AmendState holds it). */
export interface AmendDraftLike {
  readonly lines: readonly DraftLine[]
  readonly customerRef: string
  readonly requestedDate: string
  /** F-OP-110: another delivery address picked in the edit header ('' or absent: the order keeps its own). */
  readonly shipToAddressId?: string
}

/** The amendment's body as the API reads it (the preview, Apply, and the priced change it may become): its lines, and the header that changed. */
export function amendBodyOf(draft: AmendDraftLike, order: Pick<Order, 'lines' | 'customerRef' | 'requestedDate'>) {
  const customerRef = draft.customerRef.trim() || null
  const requestedDate = draft.requestedDate || null
  return {
    lines: amendLines(draft.lines, order),
    ...(customerRef !== (order.customerRef ?? null) ? { customerRef } : {}),
    ...(requestedDate !== (order.requestedDate ?? null) ? { requestedDate } : {}),
    ...(draft.shipToAddressId ? { shipToAddressId: draft.shipToAddressId } : {}), // F-OP-110
  }
}

// ---- F-OP-110 (10-order-page §4.5): Ship to in the edit header ------------------------------------------------------------------
/** The Ship to field's id (⋯ Change ship-to… opens edit mode with it focused). */
export const SHIP_TO_FIELD_ID = 'amend-ship-to'

/** The header changed: the customer PO, the requested date, or another delivery address picked. */
export function headerChangedOf(draft: AmendDraftLike, order: Pick<Order, 'customerRef' | 'requestedDate'>): boolean {
  return (draft.customerRef.trim() || null) !== (order.customerRef ?? null) || (draft.requestedDate || null) !== (order.requestedDate ?? null) || !!draft.shipToAddressId
}

/** An address as one line: its name, street, postal code and town (what the order and the Select show). */
export function addressLineOf(address: { readonly name?: unknown; readonly line1?: unknown; readonly postalCode?: unknown; readonly city?: unknown } | null | undefined): string | null {
  if (!address) return null
  const text = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
  const town = [text(address.postalCode), text(address.city)].filter(Boolean).join(' ')
  const words = [text(address.name), text(address.line1), town || null].filter((part): part is string => !!part)
  return words.length > 0 ? words.join(' · ') : null
}

/** The shipment a SHIPMENT_PREPARED refusal names (the API's sentence "Shipment SHP-… is being prepared …"); null: not said. */
export function preparedShipmentOf(message: string): string | null {
  return /^Shipment (\S+) is being prepared/.exec(message)?.[1] ?? null
}
// ---- end F-OP-110

/** What a preview is about: the body it was asked with, on the order's version (an answer about another one is stale). */
export const amendKeyOf = (draft: AmendDraftLike, order: Pick<Order, 'lines' | 'customerRef' | 'requestedDate' | 'version'>): string => JSON.stringify([order.version, amendBodyOf(draft, order)])

/** The strip's read of the API's preview, with the key it was asked for. */
export interface AmendReview {
  readonly phase: 'reading' | 'ready' | 'failed'
  readonly key: string
  readonly preview: AmendPreview | null
  readonly problem: Phrase | null
}

/** A preview's answer into the draft; dropped when the draft asked for another body since (its key moved on) or is gone. */
export function tookPreview<T extends { readonly review: AmendReview | null }>(draft: T | null, next: AmendReview): T | null {
  if (!draft || draft.review?.key !== next.key) return draft
  return { ...draft, review: next }
}

export interface StripChange {
  readonly before: number
  readonly after: number
  readonly delta: number
}

/** One work order of the strip: what the change does to it and whether it follows now (the API's rule) or waits for production. */
export interface StripWorkOrder {
  readonly key: string
  /** null: a work order this reader does not reach ("A work order"). */
  readonly number: string | null
  /** null: it cannot be carried out now (`held` says why). */
  readonly route: FollowRoute | null
  readonly before: number
  readonly after: number
  /** It follows in the same click (D1); false: it waits for production — decided on this page. */
  readonly now: boolean
  /** Why it waits (the API's words), when it says one. */
  readonly held: { readonly it: string; readonly en: string } | null
  readonly reprint: boolean
  /** The order's lines its cells make (F-OP-109: "WO-0311 loses this line"); none when the preview does not say. */
  readonly lineIds: readonly string[]
}

export interface AmendStrip {
  /** idle: nothing to ask yet (the draft's own hold says why); reading: the preview of THIS draft is not there yet. */
  readonly phase: 'idle' | 'reading' | 'ready' | 'failed'
  /** The failed read's words. */
  readonly problem: Phrase | null
  /** The order's pieces before → after. */
  readonly pieces: StripChange | null
  /** The net before → after (the price grain only; never shown without it). */
  readonly net: StripChange | null
  /**
   * F-CP-149 (customer page plan C4, the money wall; review A8, D5): the net may change but this reader does not see prices — the
   * strip says "Net: shown to people who see prices" in its place (never a blank). False with the price grain or nothing to say.
   */
  readonly netHeld: boolean
  readonly workOrders: readonly StripWorkOrder[]
  /** The API's refusals by place, in this app's words (the freeze rules' apart, below). */
  readonly problems: readonly Phrase[]
  /** The freeze rules' refusals (FrozenOffer says what froze and the way on). */
  readonly frozen: readonly PathIssue[]
  /** The net total changes: the customer accepts the order again (information: it blocks nothing). null: not known yet. */
  readonly reaccept: boolean | null
  /** The preview's lines old → new and its header (Show all changes). */
  readonly diff: AmendmentDiff | null
  /** F-OP-107 (B2): pieces already cut beyond the new figures (their outcome is picked in the strip); null: none. */
  readonly extra: ExtraPiecesView | null
}

const EMPTY_STRIP = { problem: null, pieces: null, net: null, netHeld: false /* F-CP-149 */, workOrders: [], problems: [], frozen: [], reaccept: null, diff: null, extra: null } as const

/** A work order of the preview's plan as the strip says it. */
export function stripWorkOrderOf(plan: WorkOrderPlan, index: number): StripWorkOrder {
  const before = plan.cells.reduce((sum, cell) => sum + cell.from, 0)
  const after = plan.cells.reduce((sum, cell) => sum + cell.to, 0)
  const lineIds = [...new Set(plan.cells.map((cell) => cell.lineId))]
  return { key: plan.workOrderId ?? `new-${index}`, number: plan.number, route: plan.route, before, after, now: plan.appliesNow, held: plan.appliesNow ? null : plan.held, reprint: plan.reprint, lineIds }
}

/**
 * The strip of a draft: idle while the draft's own hold stands (nothing is asked), reading until the preview of THIS draft is there
 * (an answer for an older draft is never drawn), its failure, or what changes — pieces, net (price grain), the work orders (each
 * "follows now" or "waits for production", by the API's rule and the reader's rights: R-4), the refusals by place, re-acceptance.
 */
export function stripOf(input: { readonly order: Pick<Order, 'lines'>; readonly review: AmendReview | null; readonly key: string; readonly local: Phrase | null; readonly price: boolean; readonly label: (index: number) => string | null }): AmendStrip {
  if (input.local) return { phase: 'idle', ...EMPTY_STRIP }
  const review = input.review
  if (!review || review.key !== input.key || review.phase === 'reading') return { phase: 'reading', ...EMPTY_STRIP }
  if (review.phase === 'failed' || !review.preview) return { phase: 'failed', ...EMPTY_STRIP, problem: review.problem }
  const preview = review.preview
  const frozenPaths = new Set(preview.ok ? [] : preview.problems.filter((issue) => frozenProblemsOf([issue]).length > 0).map((issue) => issue.path))
  const diff = preview.diff
  const ordered = input.order.lines.reduce((sum, line) => sum + line.quantity, 0)
  const delta = diff ? diff.lines.reduce((sum, line) => sum + (line.piecesAfter - line.piecesBefore), 0) : 0
  return {
    phase: 'ready',
    problem: null,
    pieces: diff ? { before: ordered, after: ordered + delta, delta } : null,
    net: input.price && diff ? moneyChange(diff) : null,
    netHeld: !input.price && diff !== null, // F-CP-149: the held words in the net's place
    workOrders: (preview.workOrders?.plan ?? []).map(stripWorkOrderOf),
    problems: preview.ok ? [] : issuePhrases(preview.problems.filter((issue) => !frozenPaths.has(issue.path)), input.label),
    frozen: preview.ok ? [] : preview.problems.filter((issue) => frozenPaths.has(issue.path)),
    reaccept: diff ? diff.reacceptanceNeeded : null,
    diff,
    extra: preview.workOrders && preview.workOrders.extra.length > 0 ? preview.workOrders : null, // F-OP-107
  }
}

// ---- F-OP-108: a frozen field turns Apply into "Apply as a priced change" (one button instead of the FrozenOffer step) ----
/** What a frozen draft may still become: a priced change the customer accepts, nothing any more (blocked), or not frozen (null). */
export type PricedOffer = 'priced' | 'blocked' | null
export const pricedOfferOf = (strip: Pick<AmendStrip, 'frozen'>, freeze: Freeze | null): PricedOffer => frozenOffer(frozenProblemsOf(strip.frozen), freeze)
/** The optional fee typed (price grain) is not one ("25,00": above 0, at most 2 decimals — the priced change's own rule). */
export const feeHeld = (fee: string): boolean => fee.trim() !== '' && pricedProblems({ ...PRICED_EMPTY, fee }, '', { price: true }).fee !== undefined
// ---- end F-OP-108

/** Words of a hold: a phrase of this app, or the API's own words (F-OP-107: "Choose what happens to the 4 extra pieces"). */
export type HeldWords = Phrase | { readonly words: { readonly it: string; readonly en: string } }

/** A hold said in the reader's language. */
export const heldWordsOf = (held: HeldWords, t: (key: string, params?: Record<string, string | number>) => string, locale: 'it' | 'en'): string => ('words' in held ? (locale === 'it' ? held.words.it : held.words.en) : t(held.key, held.params))

/**
 * Why Apply waits, or null: the work, the draft's own hold, the preview (reading, failed, refused), the extra pieces' outcome not
 * picked yet (F-OP-107, B2: when the preview says it is needed), the reason.
 */
export function stripHeld(strip: AmendStrip, input: { readonly reason: string; readonly busy: boolean; readonly local: Phrase | null; readonly extraOutcome?: ExtraOutcome | null; readonly offer?: PricedOffer; readonly fee?: string; /* F-CP-149 */ readonly price?: boolean }): HeldWords | null {
  if (input.busy) return phrase('held.busy')
  if (input.local) return input.local
  if (strip.phase === 'reading' || strip.phase === 'idle') return phrase('amend.held.reading')
  if (strip.phase === 'failed') return phrase('amend.held.failed')
  // F-OP-108: a frozen field holds Apply only when it is frozen for good; else Apply is "Apply as a priced change" (its fee checked).
  if (strip.problems.length > 0 || (strip.frozen.length > 0 && input.offer !== 'priced')) return phrase('amend.held.problems')
  // ---- F-CP-149 (the money wall; review A8): a priced change is made by a price holder — a reader without the price grain never
  // makes one blind (no fee field, no deposit, no amount), held in words whatever else is typed.
  if (input.offer === 'priced' && input.price === false) return phrase('edit.pricedHeld.apply')
  // ---- end F-CP-149
  if (input.offer === 'priced' && feeHeld(input.fee ?? '')) return phrase('edit.held.fee')
  const outcome = outcomeHeld(strip.extra, input.extraOutcome ?? null)
  if (outcome) return outcome
  if (input.reason.trim() === '') return phrase('amend.held.reason')
  return null
}

// ---- F-OP-107 (B2): the extra-pieces picker — the strip's, Close remaining lines' and Cancel's (the review window's part) ----

/** Apply waits for the extra pieces' outcome when the preview says it is needed and none is picked: the API's words. */
export function outcomeHeld(extra: ExtraPiecesView | null, chosen: ExtraOutcome | null): HeldWords | null {
  if (!extra || !extra.needsOutcome || chosen !== null || extra.extra.length === 0) return null
  return extra.words ? { words: extra.words } : phrase('edit.held.extra', { count: extra.extra.reduce((sum, entry) => sum + entry.count, 0) })
}

/**
 * The picker of an office change: its pieces by order line, and the three outcomes in the review window's order and words
 * (factory-domain outcomeOptionsOf) — charging the customer needs the price grain (held, said why); none is picked for the reader.
 */
export function extraChoicesOf(view: ExtraPiecesView, order: Pick<Order, 'lines' | 'party'>, seesPrices: boolean): { readonly pieces: ExtraPiece[]; readonly outcomes: ExtraChoice[] } {
  return {
    pieces: view.extra.map((piece) => ({ key: piece.workOrderSizeId, line: order.lines.find((line) => line.id === piece.salesOrderLineId)?.seq ?? 0, words: piece.words })),
    outcomes: outcomeOptionsOf({ customer: order.party?.legalName ?? '', seesPrices }).map((option) => ({ outcome: option.outcome, words: option.words, held: option.mayChoose ? null : option.needsWords })),
  }
}

type Translate = (key: string, params?: Record<string, string | number>) => string
const saidIn = (words: { readonly it: string; readonly en: string }, locale: 'it' | 'en'): string => (locale === 'it' ? words.it : words.en)

/** One work order in words (the strip, Close remaining lines, Cancel): "WO-0311 40 → 28 · follows now" / "… · waits for production — decide on this page". */
export function workOrderWords(wo: StripWorkOrder, t: Translate, locale: 'it' | 'en'): string {
  const number = wo.number ?? t('edit.strip.wo.someone')
  const what = wo.route === 'NEW_DRAFT' ? t('edit.strip.wo.new', { after: wo.after }) : wo.route === 'CANCEL_WORK_ORDER' ? t('edit.strip.wo.cancel', { number }) : t('edit.strip.wo.change', { number, before: wo.before, after: wo.after })
  return [what, t(wo.now ? 'edit.strip.wo.now' : 'edit.strip.wo.waits'), ...(wo.held ? [saidIn(wo.held, locale)] : []), ...(wo.reprint ? [t('edit.strip.wo.reprint')] : [])].join(' · ')
}
// ---- end F-OP-107 (the picker)

/** F-OP-109: the work orders of the strip that make an order line ("WO-0311 loses this line" when it is removed); none when not said. */
export const workOrdersOfLine = (workOrders: readonly StripWorkOrder[], lineId: string): readonly StripWorkOrder[] => workOrders.filter((wo) => wo.lineIds.includes(lineId))

/** The work orders an answer names, as numbers ("WO-0311, WO-0312"); one this reader does not reach reads "WO-…". */
export const followedNumbers = (entries: readonly { readonly number: string | null }[]): string => entries.map((entry) => entry.number ?? 'WO-…').join(', ')

/**
 * The notice after Apply: "Amendment 3 applied · WO-0311 changed · WO-0312 waits for production — decide on this page · <Customer>
 * told" — the work orders that followed in the same command and those that wait (B-OP-012's answer), and the customer when the words
 * reached them (null: not told).
 */
export function appliedNotice(revision: number, followed: Followed, told: string | null): Phrase {
  const changed = followedNumbers(followed.applied)
  const waits = followedNumbers(followed.waiting)
  const which = changed && waits ? 'both' : changed ? 'changed' : waits ? 'waits' : 'plain'
  return phrase(`edit.done.${which}${told ? 'Told' : ''}`, { revision, ...(changed ? { changed } : {}), ...(waits ? { waits } : {}), ...(told ? { customer: told } : {}) })
}
// ---- end F-OP-106

// ---- the API's refusals, by their place, in this app's words ---------------------------------------------------------------

const LINE_FIELDS: Record<string, string> = { sizes: 'sizes', quantity: 'sizes', unitPrice: 'price', colourwayId: 'catalogue', styleId: 'catalogue', id: 'moved', description: 'text', note: 'text', /* B-W2b-374 */ options: 'options' }
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
  // F-OP-110: a shipment is being prepared for the order's address — said with that shipment (the same customer's).
  if (parts[0] === 'shipToAddressId' && parts[1] === 'SHIPMENT_PREPARED') {
    const number = preparedShipmentOf(issue.message)
    return number ? phrase('edit.shipToPreparedOf', { number }) : phrase('edit.shipToPrepared')
  }
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
