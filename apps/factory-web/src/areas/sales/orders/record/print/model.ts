import { AGAIN_REASONS, type AgainBody, type AgainReason, type PrintPreview, type PrintProblem, type SheetCard, type StartBody } from './api'

/**
 * owb-ss4 (design plan word table "Print and start the work…", § 1 row 1, § 4.1, § 5f, § 5zj B; core.js `printCards`, reprint.js
 * `reprintModal`; settles L1, L6, L7) — the two print windows, pure.
 *
 * Print and start the work: what prints (the design pages of each piece, and one basket card for each basket — or, where the site's
 * switch is off, "Basket cards print at cutting on this site"), the work orders it makes and starts, the problems in words grouped
 * **Must be fixed first** (structure, law, money, holds) · **Warnings** (material, a credit warning), the reason field only when the
 * material warning asks for it, "0 of 3 placed — the code goes to the usual place" (never a stop). The act waits, with words, while the
 * preview refuses.
 *
 * Print again: nothing starts, the SAME codes; tick pages of each piece and basket cards (from the order: all ticked; a card of a shipped
 * basket is not offered), the reason in one tap (Lost · Damaged · A small change · One more copy), words required for "A small change"
 * (≤ 140). The words are `print-start`.
 */

/** The catalogues the print windows speak: their own, the Warehouse's read and refusal words, the order page's (the section kit). */
export const PRINT_NS = ['print-start', 'shipments', 'orders'] as const

/** Print and start the work, Print again: production.print.start (Sales; the Owner; the production manager and the planner since b6). */
export const mayPrintOf = (permissions: readonly string[]): boolean => permissions.includes('production.print.start')

export interface Said {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

/** The reason a material warning asks for (today's materialOverride.reason): 3 to 500 characters. */
export const REASON_MIN = 3
export const REASON_MAX = 500

export type StartState = 'ready' | 'refused' | 'warn' | 'printed' | 'notConfirmed'

/** Where the preview stands: printed already · not confirmed · refused (a problem must be fixed) · warnings only · ready. */
export function startStateOf(preview: Pick<PrintPreview, 'state' | 'refused' | 'problems'>): StartState {
  if (preview.state === 'PRINTED') return 'printed'
  if (preview.state === 'NOT_CONFIRMED') return 'notConfirmed'
  if (preview.refused) return 'refused'
  if (preview.problems.some((problem) => problem.class === 'WARN')) return 'warn'
  return 'ready'
}

/** The problems in two groups: what must be fixed first (it holds the act) and the warnings (it goes on). */
export function problemGroupsOf(problems: readonly PrintProblem[]): { readonly mustFix: readonly PrintProblem[]; readonly warnings: readonly PrintProblem[] } {
  return { mustFix: problems.filter((problem) => problem.class !== 'WARN'), warnings: problems.filter((problem) => problem.class === 'WARN') }
}

/** The reason field shows only when the material warning asks for it. */
export const reasonShown = (preview: Pick<PrintPreview, 'needsMaterialReason' | 'state' | 'refused'>): boolean => preview.state === 'READY' && !preview.refused && preview.needsMaterialReason

/** What prints, in one line: the design pages, and the cards (or "at cutting on this site"). */
export function printsLineOf(preview: Pick<PrintPreview, 'pages' | 'baskets' | 'basketsAtPrint'>): { readonly pages: number; readonly cards: Said } {
  const pages = preview.pages.reduce((sum, page) => sum + (page.fileId ? Math.max(1, page.pageCount ?? 1) : 0), 0)
  return { pages, cards: preview.basketsAtPrint ? { key: 'start.cards', params: { count: preview.baskets.count } } : { key: 'start.cardsAtCutting' } }
}

/** "0 of 3 placed — the code goes to the usual place" while some page has none; every page placed: one plain line. Never a stop. */
export function placedLineOf(placed: PrintPreview['placed']): Said {
  if (placed.of === 0) return { key: 'start.placed.none' }
  return placed.done < placed.of ? { key: 'start.placed.some', params: { done: placed.done, of: placed.of } } : { key: 'start.placed.all', params: { of: placed.of } }
}

/** Why "Print and start the work" waits (null: it may go): the right, the order's state, the refusal, the reason, a run. */
export function startHeldOf(input: { readonly may: boolean; readonly preview: PrintPreview | null; readonly reason: string; readonly busy: boolean }): Said | null {
  if (!input.may) return { key: 'held.noRight' }
  const preview = input.preview
  if (!preview) return { key: 'held.reading' }
  const state = startStateOf(preview)
  if (state === 'printed') return { key: 'held.printed' }
  if (state === 'notConfirmed') return { key: 'held.notConfirmed' }
  if (state === 'refused') return { key: 'held.refused', params: { count: problemGroupsOf(preview.problems).mustFix.length } }
  if (reasonShown(preview)) {
    const words = input.reason.trim()
    if (words.length < REASON_MIN) return { key: 'held.reason', params: { min: REASON_MIN } }
    if (words.length > REASON_MAX) return { key: 'held.reasonLong', params: { max: REASON_MAX } }
  }
  if (input.busy) return { key: 'held.busy' }
  return null
}

/** The start's body: the version read, and the material reason only when it is asked for. */
export function startBodyOf(preview: Pick<PrintPreview, 'version' | 'needsMaterialReason' | 'state' | 'refused'>, reason: string): StartBody {
  return reasonShown(preview) ? { version: preview.version, materialReason: reason.trim() } : { version: preview.version }
}

// ---- Print again ---------------------------------------------------------------------------------------------------------------

/** The longest words of "A small change" (the floor reads them on the basket). */
export const NOTE_MAX = 140

/** A page of a piece: `<salesOrderLineId>:<page>`. */
export const pageKey = (salesOrderLineId: string, page: number): string => `${salesOrderLineId}:${page}`

export interface AgainPage {
  readonly key: string
  readonly salesOrderLineId: string
  readonly label: string
  readonly page: number
}

/** The pages of each piece that can print again (a piece with no mockup file has none). */
export function againPagesOf(pages: PrintPreview['pages']): AgainPage[] {
  return pages.flatMap((piece) => {
    if (!piece.fileId) return []
    const count = Math.max(1, piece.pageCount ?? 1)
    return Array.from({ length: count }, (_, index) => ({ key: pageKey(piece.salesOrderLineId, index + 1), salesOrderLineId: piece.salesOrderLineId, label: piece.label, page: index + 1 }))
  })
}

/** The basket cards offered: every card of the order but a shipped basket's (L7: a card of a shipped basket never prints again). */
export const againCardsOf = (cards: readonly SheetCard[]): SheetCard[] => cards.filter((card) => card.shipped !== true)

export interface AgainForm {
  readonly pages: ReadonlySet<string>
  readonly cards: ReadonlySet<string>
  readonly reason: AgainReason | null
  readonly note: string
}

/** What is ticked when the window opens from the order: every page and every card offered; no reason yet. */
export function againFormOf(pages: readonly AgainPage[], cards: readonly SheetCard[]): AgainForm {
  return { pages: new Set(pages.map((page) => page.key)), cards: new Set(cards.map((card) => card.bundleId)), reason: null, note: '' }
}

/**
 * owb-ss4b: the pages offered, with the page "Place the scan code" asks for added when the preview did not count it (the server sends no
 * page count: page 1 of each piece is offered; a placed page 2 of the same file joins after its piece's pages).
 */
export function againPagesWith(pages: readonly AgainPage[], pieces: PrintPreview['pages'], only: { readonly salesOrderLineId: string; readonly page: number } | null): AgainPage[] {
  if (!only || pages.some((page) => page.key === pageKey(only.salesOrderLineId, only.page))) return [...pages]
  const piece = pieces.find((entry) => entry.salesOrderLineId === only.salesOrderLineId && entry.fileId)
  if (!piece || only.page < 1) return [...pages]
  const added: AgainPage = { key: pageKey(only.salesOrderLineId, only.page), salesOrderLineId: only.salesOrderLineId, label: piece.label, page: only.page }
  const last = pages.map((page) => page.salesOrderLineId).lastIndexOf(only.salesOrderLineId)
  return last < 0 ? [...pages, added] : [...pages.slice(0, last + 1), added, ...pages.slice(last + 1)]
}

/**
 * owb-ss4b: from "Place the scan code" → "Print this page again…": only that page is ticked, no card (design plan § 5zj B "From
 * 'Place the scan code': only that page"). A page the window does not offer: nothing ticked.
 */
export function againFormOnlyOf(pages: readonly AgainPage[], only: { readonly salesOrderLineId: string; readonly page: number }): AgainForm {
  const key = pageKey(only.salesOrderLineId, only.page)
  return { pages: new Set(pages.some((page) => page.key === key) ? [key] : []), cards: new Set(), reason: null, note: '' }
}

/** A tick on one page or one card. */
export function toggledIn(set: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(set)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

/** Why "Print again" waits (null: it may go): the right, a tick, the reason, the words of a small change. */
export function againHeldOf(input: { readonly may: boolean; readonly form: AgainForm; readonly busy: boolean }): Said | null {
  if (!input.may) return { key: 'held.noRight' }
  const { form } = input
  if (form.pages.size + form.cards.size === 0) return { key: 'again.held.tick' }
  if (!form.reason) return { key: 'again.held.why' }
  if (form.reason === 'SMALL_CHANGE') {
    const words = form.note.trim()
    if (words.length === 0) return { key: 'again.held.note' }
    if (words.length > NOTE_MAX) return { key: 'again.held.noteLong', params: { max: NOTE_MAX } }
  }
  if (input.busy) return { key: 'held.busy' }
  return null
}

/** The body: the reason, the words (only on a small change), the ticked pages and cards in the window's order. */
export function againBodyOf(form: AgainForm, pages: readonly AgainPage[], cards: readonly SheetCard[]): AgainBody | null {
  if (!form.reason) return null
  return {
    reason: form.reason,
    ...(form.reason === 'SMALL_CHANGE' ? { note: form.note.trim().slice(0, NOTE_MAX) } : {}),
    pages: pages.filter((page) => form.pages.has(page.key)).map((page) => ({ salesOrderLineId: page.salesOrderLineId, page: page.page })),
    cards: cards.filter((card) => form.cards.has(card.bundleId)).map((card) => ({ bundleId: card.bundleId })),
  }
}

/** The reasons in the window's order, each with its word key. */
export const AGAIN_REASON_KEYS: readonly { readonly reason: AgainReason; readonly key: string }[] = AGAIN_REASONS.map((reason) => ({ reason, key: `again.reason.${reason}` }))
