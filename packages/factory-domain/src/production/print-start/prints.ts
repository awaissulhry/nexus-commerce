import type { Issue } from '../../core/errors'

/**
 * The prints of an order (owb- order workflow, S3 ss2 steps 2.2 + 2.3; settles L7, L8; design plan § 5zj B, prototype reprint.js).
 * "Print and start the work" is the FIRST print; "Print again" prints the SAME codes again (one OrderPrint AGAIN row: never a new
 * code, never a BundleReprint) with its reason — Lost, Damaged, A small change (words, at most 140), One more copy — for the pages
 * and basket cards ticked; a card of a basket whose work order was shipped or closed never prints again. Pure: apps/factory-api
 * modules/production/{print-start,prints} read the facts and write the rows.
 *
 * The print number of a page or a card ("Print N · date" from 2): the FIRST print prints every page and every basket made at it
 * (its row's `cards` stay empty: the baskets are made after the row, in the same command), so it is 1 + the AGAIN rows naming it.
 */

export const PRINT_AGAIN_REASONS = ['LOST', 'DAMAGED', 'SMALL_CHANGE', 'ONE_MORE_COPY'] as const
export type PrintAgainReason = (typeof PRINT_AGAIN_REASONS)[number]

/** The most a small change's words say (the floor reads them on a phone). */
export const SMALL_CHANGE_NOTE_MAX = 140

/** The work order states whose basket cards never print again (the work order is over); a basket whose garments left neither. */
export const NO_CARD_AGAIN_STATUSES: readonly string[] = Object.freeze(['CLOSED', 'CANCELLED'])

export interface PrintAgainAsk {
  readonly reason: PrintAgainReason
  readonly note?: string | null | undefined
  readonly pages: readonly { readonly salesOrderLineId: string; readonly page: number }[]
  readonly cards: readonly { readonly bundleId: string }[]
}

/** What "Print again" reads of the order: its lines (for the pages) and its baskets (for the cards). */
export interface PrintAgainFacts {
  readonly lineIds: ReadonlySet<string>
  /** The order's baskets: their work order's status, their own status (ACTIVE or VOID), whether their cell's garments all left. */
  readonly baskets: ReadonlyMap<string, { readonly workOrderStatus: string; readonly status: string; readonly code: string; readonly shipped: boolean }>
}

/** Why the print again is refused, field by field (empty: it may print). */
export function printAgainProblems(ask: PrintAgainAsk, facts: PrintAgainFacts): Issue[] {
  const problems: Issue[] = []
  const note = ask.note?.trim() ?? ''
  if (ask.reason === 'SMALL_CHANGE' && note === '') problems.push({ path: 'body/note', message: 'Say in words what changed: the floor reads it with the design.' })
  if (note.length > SMALL_CHANGE_NOTE_MAX) problems.push({ path: 'body/note', message: `At most ${SMALL_CHANGE_NOTE_MAX} characters.` })
  if (ask.pages.length === 0 && ask.cards.length === 0) problems.push({ path: 'body/pages', message: 'Tick at least one page or one basket card to print again.' })
  const seenPages = new Set<string>()
  ask.pages.forEach((page, index) => {
    const at = `body/pages/${index}`
    if (!facts.lineIds.has(page.salesOrderLineId)) problems.push({ path: `${at}/salesOrderLineId`, message: 'Not a line of this order.' })
    if (!Number.isSafeInteger(page.page) || page.page < 1) problems.push({ path: `${at}/page`, message: 'A page is a number from 1.' })
    const key = `${page.salesOrderLineId}|${page.page}`
    if (seenPages.has(key)) problems.push({ path: at, message: 'This page is ticked twice.' })
    seenPages.add(key)
  })
  const seenCards = new Set<string>()
  ask.cards.forEach((card, index) => {
    const at = `body/cards/${index}/bundleId`
    const basket = facts.baskets.get(card.bundleId)
    if (!basket) problems.push({ path: at, message: 'Not a basket of this order.' })
    else if (basket.status !== 'ACTIVE') problems.push({ path: at, message: `Basket ${basket.code} is void: its card never prints again.` })
    else if (basket.shipped) problems.push({ path: at, message: `Basket ${basket.code} left with its goods: its card never prints again.` })
    else if (NO_CARD_AGAIN_STATUSES.includes(basket.workOrderStatus)) problems.push({ path: at, message: `The work order of basket ${basket.code} is ${basket.workOrderStatus}: its card never prints again.` })
    if (seenCards.has(card.bundleId)) problems.push({ path: at, message: 'This basket card is ticked twice.' })
    seenCards.add(card.bundleId)
  })
  return problems
}

/** A basket card never prints again (S3 lead settle 09:13 `shipped`): its cell's garments left, or its work order is closed or cancelled. */
export const cardShipped = (workOrderStatus: string, garmentsLeft: boolean): boolean => garmentsLeft || NO_CARD_AGAIN_STATUSES.includes(workOrderStatus)

/** An OrderPrint row as the print numbers read it. */
export interface PrintRow {
  readonly kind: 'FIRST' | 'AGAIN'
  readonly pages: readonly { readonly salesOrderLineId: string; readonly page: number }[]
  readonly cards: readonly { readonly bundleId: string }[]
}

/** The print number of a page: 1 (the FIRST print) + the AGAIN rows naming it (pass the rows up to the print shown). */
export function pagePrintNo(rows: readonly PrintRow[], page: { readonly salesOrderLineId: string; readonly page: number }): number {
  return 1 + rows.filter((row) => row.kind === 'AGAIN' && row.pages.some((entry) => entry.salesOrderLineId === page.salesOrderLineId && entry.page === page.page)).length
}

/** The print number of a basket card: 1 (made and printed at the FIRST print) + the AGAIN rows naming it. */
export function cardPrintNo(rows: readonly PrintRow[], bundleId: string): number {
  return 1 + rows.filter((row) => row.kind === 'AGAIN' && row.cards.some((entry) => entry.bundleId === bundleId)).length
}

/** The words of the floor note a small change writes on each work order of the pieces ticked (settle L7). */
export const smallChangeNote = (note: string): string => `The design changed: ${note.trim()}`

/** The words a solved PAPER help call keeps (settle L7): its code and its note. */
export const PRINTED_AGAIN = Object.freeze({ resolutionCode: 'PRINTED_AGAIN', resolutionNote: 'The office printed it again' })

/** The order statuses "Print and start the work" may start (CONFIRMED, or IN_PRODUCTION for an order made in parts). */
export const PRINT_START_ORDER_STATUSES: readonly string[] = Object.freeze(['CONFIRMED', 'IN_PRODUCTION'])

/** The preview's state: READY (may print), PRINTED (a FIRST print exists), NOT_CONFIRMED (the order may not start). */
export type PrintStartState = 'READY' | 'PRINTED' | 'NOT_CONFIRMED'
export function printStartState(order: { readonly status: string }, firstPrintedAt: Date | null): PrintStartState {
  if (firstPrintedAt !== null) return 'PRINTED'
  return PRINT_START_ORDER_STATUSES.includes(order.status) ? 'READY' : 'NOT_CONFIRMED'
}

/** The refusal words of a second FIRST print and of an order that may not start (409). */
export const printedAlreadyWords = (day: string): string => `Printed on ${day}: the work started then. Use Print again… to print pages or basket cards again.`
export const notConfirmedWords = (status: string): string => `The order is ${status}: the work starts once it is confirmed.`

/** The words of a basket card on a site that makes its baskets at cutting (settle L6). */
export const BASKETS_AT_CUTTING_WORDS = 'Basket cards print at cutting on this site.'
