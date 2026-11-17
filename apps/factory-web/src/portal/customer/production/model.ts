import type { Locale } from '../../../lib/i18n/locales'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { countWords } from '@nexus/factory-domain/production-brand/portal-read' // F-PR-12a
import type { HealthInput, HealthState, HoldInput, PlainStage, WaitingInput } from '../../../lib/production/model'
import { PORTAL_AREAS } from '../../shell/nav/portal-nav' // F-PR-12a
import { recordHref } from '../orders/model'
import type { BrandUrgencyCode, ProductionChip, ProductionHealth, ProductionList, ProductionOrder, ProductionRow, ProductionWaiting, Urgency, UrgencyAnswer, UrgencyOutcome, UrgentUse, Words } from './api'
import { isProductionChip, URGENCY_OUTCOMES } from './api'

/**
 * F-PR-11 — the customer's My production (production plan §3 "Customer urgency", §4, §5 Portal › Production; 17-web-r2 §1.4;
 * lead picks L17, L18, L20), pure: the page's address, the customer's own name of an order (their PO first, then "Your order 12",
 * never the office's series), the Urgent / Regular groups, the urgency cell, whether "Mark urgent" / "Mark regular" may act now
 * (at once inside the quota and before Cutting; over the quota, from Cutting or locked by us it is held with the words — "Ask us"
 * comes with F-PR-23), the words of a refusal, of a done mark and of an Undo, the urgent order of the dialog and the words of a
 * version conflict ("Changed by us at 10:42", never a name). F-PR-12a reads the order's production with the same rules
 * (health, waiting on, holds, the stage as the "In production" note).
 *
 * The wall (PW-P01, PW-11, PW-15): every rule reads ONE customer's own answer; nothing here makes a place in our plan, a count of
 * another customer or a name of ours — only its own list and "2 of 3 urgent used" as the API wrote them.
 */

export const NS = 'portal-production'

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

const say = (words: Words, locale: Locale): string => words[locale]

// ── the address ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** The chip of the address (`ALL` is the API's default and is left out of it). */
export const chipOf = (value: string | null | undefined): ProductionChip | null => (isProductionChip(value) && value !== 'ALL' ? value : null)

/** The page's address terms: the chip and the search. */
export function listQuery(chip: ProductionChip | null, q: string): string {
  const params = new URLSearchParams()
  if (chip && chip !== 'ALL') params.set('chip', chip)
  if (q.trim()) params.set('q', q.trim())
  const text = params.toString()
  return text ? `?${text}` : ''
}

/** Where a row opens: the order's own page on Status & progress (the order's production is drawn there). */
export const rowHref = (prefix: string, row: Pick<ProductionRow, 'id'>): string => recordHref(prefix, row.id, 'status')

// ── the customer's own name of an order (B-TH-303: never the office's SO- series) ──────────────────────────────────────
/** RefPair's two sides: their PO first, then the customer's own number ("Your order" · "12"). */
export function rowRef(row: Pick<ProductionRow, 'customerRef' | 'yourNumber'>, locale: Locale): { theirs: string | null; ours: { label: string; value: string } | null } {
  if (!row.yourNumber) return { theirs: row.customerRef, ours: null }
  const words = say(row.yourNumber.words, locale)
  const value = String(row.yourNumber.seq)
  return { theirs: row.customerRef, ours: { label: words.endsWith(value) ? words.slice(0, words.length - value.length).trim() : words, value } }
}

/** One line naming the order (a menu, a notice, the dialog): "ALPHA-PO-0042 · Your order 12", else either, else "your order". */
export function rowName(row: Pick<ProductionRow, 'customerRef' | 'yourNumber'>, locale: Locale, t: Translate): string {
  const own = row.yourNumber ? say(row.yourNumber.words, locale) : null
  const parts = [row.customerRef, own].filter((part): part is string => !!part)
  return parts.length > 0 ? parts.join(' · ') : t('row.noName')
}

/** The styles cell: the first style, "+2" for the others. */
export function stylesText(row: Pick<ProductionRow, 'styles'>, t: Translate): string {
  const [first, ...rest] = row.styles
  if (!first) return '—'
  const name = [first.code, first.name].filter(Boolean).join(' ')
  return rest.length > 0 ? t('cell.styleMore', { style: name, count: rest.length }) : name
}

// ── Urgent / Regular (the list frame's groups: DS gap G-R2-2 is met by the frame's own groups) ──────────────────────────────
export const URGENCY_GROUPS = ['URGENT', 'REGULAR'] as const
export type UrgencyGroup = (typeof URGENCY_GROUPS)[number]

/** An order's group: Urgent while marked (in its own order), else Regular ("Urgent – asked" stays among Regular with its chip). */
export const groupOf = (row: Pick<ProductionRow, 'urgency'>): UrgencyGroup => (row.urgency?.code === 'URGENT' ? 'URGENT' : 'REGULAR')

/** The groups drawn: both while the customer's urgency is on (the list keeps the API's order inside each); none while off. */
export const groupsOf = (read: Pick<ProductionList, 'urgencyOn'> | null): readonly UrgencyGroup[] => (read?.urgencyOn ? URGENCY_GROUPS : [])

// ── the urgency cell ─────────────────────────────────────────────────────────────────────────────────────────────────
export interface UrgencyCell {
  /** "Urgent 1", "Urgent – asked", "Regular". */
  readonly text: string
  readonly tone: Tone
  /** We set it to Regular and locked it: the lock mark (the note carries our reason). */
  readonly locked: boolean
  /** The line under it: "Set to Regular by us: <our reason>" while locked, else "Changed by us" when we set it last (never who). */
  readonly note: string | null
}

/** The urgency of a row in the API's words, in the person's language (the API's own CSV writes the same). */
export function urgencyCell(urgency: Urgency, locale: Locale): UrgencyCell {
  const urgent = urgency.code === 'URGENT'
  if (urgency.locked) return { text: say(urgency.words, locale), tone: 'neutral', locked: true, note: urgency.lockWords ? say(urgency.lockWords, locale) : null }
  const text = urgent && urgency.urgentRank !== null ? `${say(urgency.words, locale)} ${urgency.urgentRank}` : !urgent && urgency.asked && urgency.askedWords ? say(urgency.askedWords, locale) : say(urgency.words, locale)
  return { text, tone: urgent ? 'warning' : urgency.asked ? 'info' : 'neutral', locked: false, note: urgency.byUs && urgency.byUsWords ? say(urgency.byUsWords, locale) : null }
}

/** The cell in one line (a phone card's title, the menu's name): "Regular · Set to Regular by us: …". */
export const urgencyText = (cell: UrgencyCell): string => [cell.text, cell.note].filter(Boolean).join(' · ')

// ── Mark urgent / Mark regular ───────────────────────────────────────────────────────────────────────────────────────
export interface MarkFacts {
  /** The customer's urgency switch (off: no mark is drawn; its marks are kept, not used). */
  readonly urgencyOn: boolean
  /** The person holds portal.production.urgency (else: no mark is drawn — a role that reads sees no button). */
  readonly mayMark: boolean
  readonly preview: boolean
  readonly offline: boolean
  /** A mark of this order is being saved. */
  readonly busy: boolean
  readonly use: UrgentUse | null
}

export interface MarkAction {
  /** What the one mark of the row sets: Urgent on a Regular order, Regular on an Urgent one. */
  readonly urgency: BrandUrgencyCode
  /** Why it cannot act now, in words (null: it acts at once). */
  readonly held: string | null
}

/**
 * The row's one mark, or null when none is drawn (urgency off, a role that reads, no urgency read). Back to Regular is always
 * free; a mark to Urgent acts at once only inside the quota and before Cutting (the stage we keep: the API decides on the live
 * cut facts and says so if a bundle was made since). A lock from us holds both, with our reason.
 */
export function markActionOf(row: Pick<ProductionRow, 'urgency' | 'stage'>, facts: MarkFacts, locale: Locale, t: Translate): MarkAction | null {
  const urgency = row.urgency
  if (!facts.urgencyOn || !facts.mayMark || !urgency) return null
  const target: BrandUrgencyCode = urgency.code === 'URGENT' ? 'REGULAR' : 'URGENT'
  const held = (() => {
    if (facts.preview) return t('held.preview')
    if (facts.offline) return t('held.offline')
    if (facts.busy) return t('held.busy')
    if (urgency.locked) return urgency.lockWords ? say(urgency.lockWords, locale) : t('held.locked')
    if (target === 'REGULAR') return null
    if (urgency.asked) return t('held.asked')
    if (row.stage && row.stage.code !== 'PREPARING') return t('held.cut')
    if (facts.use && facts.use.max <= 0) return t('held.quotaNone')
    if (facts.use && facts.use.left <= 0) return t('held.quota', { used: facts.use.used, max: facts.use.max })
    return null
  })()
  return { urgency: target, held }
}

/** "Urgent order" (the dialog) opens with two urgent orders or more; why not, else null. */
export function orderHeld(urgent: number, facts: Pick<MarkFacts, 'preview' | 'offline'>, t: Translate): string | null {
  if (facts.preview) return t('held.preview')
  if (facts.offline) return t('held.offline')
  return urgent < 2 ? t('band.orderFew') : null
}

/** The urgent orders of the list in its own order (Urgent 1 first). */
export const urgentRowsOf = (rows: readonly ProductionRow[]): ProductionRow[] =>
  rows.filter((row) => row.urgency?.code === 'URGENT').sort((a, b) => (a.urgency?.urgentRank ?? Number.MAX_SAFE_INTEGER) - (b.urgency?.urgentRank ?? Number.MAX_SAFE_INTEGER))

/** "Move to top" inside the dialog: the order first, the others as they were. */
export const toTop = (items: readonly string[], id: string): string[] => (items.includes(id) ? [id, ...items.filter((item) => item !== id)] : [...items])

/** The dialog's order differs from the list's (Save may send it). */
export const orderChanged = (items: readonly string[], rows: readonly ProductionRow[]): boolean => items.join('|') !== urgentRowsOf(rows).map((row) => row.id).join('|')

/**
 * "Keep my order" after a conflict: the new list's urgent orders in my order where I had them, the ones new to the list after
 * them (in the list's order); an order no longer urgent leaves.
 */
export function keepMine(mine: readonly string[], rows: readonly ProductionRow[]): string[] {
  const now = urgentRowsOf(rows).map((row) => row.id)
  const still = mine.filter((id) => now.includes(id))
  return [...still, ...now.filter((id) => !still.includes(id))]
}

// ── the words of an answer ─────────────────────────────────────────────────────────────────────────────────────────────
export interface Notice {
  readonly tone: Tone
  readonly words: string
  /** The batch an Undo puts back (a mark, an order saved). */
  readonly undo?: string | null
}

/** A mark that was done: "ALPHA-PO-0042 · Your order 12 is urgent now: Urgent 2." / "… is regular now." */
export function markedNotice(answer: UrgencyAnswer, row: Pick<ProductionRow, 'customerRef' | 'yourNumber'>, locale: Locale, t: Translate): Notice {
  const result = answer.results[0]
  const name = rowName(row, locale, t)
  if (!result || !result.done) return { tone: 'warning', words: result?.words ? say(result.words, locale) : t('refused.failed') }
  const words = result.urgency === 'URGENT' ? (result.urgentRank !== null ? t('notice.urgent', { name, rank: result.urgentRank }) : t('notice.urgentNoRank', { name })) : t('notice.regular', { name })
  return { tone: 'success', words, undo: answer.batchId }
}

/** The outcome a refusal names at `body/orderIds/<index>/<OUTCOME>` (B-PR-22a), else null. */
export function refusedOutcome(error: unknown): UrgencyOutcome | null {
  if (!isApiError(error)) return null
  for (const issue of error.issues) {
    const last = issuePath(issue).split('/').pop() ?? ''
    if ((URGENCY_OUTCOMES as readonly string[]).includes(last)) return last as UrgencyOutcome
  }
  return null
}

/** A mark refused: the words in the person's language, and whether the list is read again (its state moved). */
export function markRefusal(error: unknown, t: Translate): { words: string; reread: boolean } {
  if (!isApiError(error)) return { words: t('refused.failed'), reread: false }
  if (error.kind === 'not_found') return { words: t('refused.notFound'), reread: true }
  if (error.kind === 'forbidden') return { words: t('refused.forbidden'), reread: false }
  if (error.kind === 'unavailable') return { words: t('held.offline'), reread: false }
  const outcome = refusedOutcome(error)
  if (outcome && outcome !== 'DONE') return { words: t(`refused.${outcome}`), reread: true }
  return { words: t('refused.failed'), reread: error.kind === 'conflict' }
}

/** An Undo done: "Put back as it was." (and how many orders changed since and were left). */
export function undoneNotice(answer: { readonly skipped: readonly unknown[] }, t: Translate): Notice {
  return answer.skipped.length > 0 ? { tone: 'info', words: t('notice.undoneSkipped', { count: answer.skipped.length }) } : { tone: 'success', words: t('notice.undone') }
}

/** An Undo refused: another's, ours or none is "not found"; a batch whose every order changed since puts nothing back. */
export function undoRefusal(error: unknown, t: Translate): string {
  if (!isApiError(error)) return t('refused.failed')
  if (error.kind === 'not_found') return t('refused.undoNotFound')
  if (error.kind === 'conflict') return t('refused.undoNothing')
  if (error.kind === 'unavailable') return t('held.offline')
  return t('refused.failed')
}

/**
 * The Urgent order refused. A version conflict names who changed the list and when ("Changed by us at 10:42", "Changed at 10:42"
 * by its own side; never a name: `body/orderIds/CHANGED_SINCE/<US|YOU>/<hh:mm>`); the same order is nothing to change; an order
 * that is no longer urgent (or not found) means the list moved. `conflict`: the dialog offers "Use the new list" / "Keep my order".
 */
export function orderRefusal(error: unknown, t: Translate): { words: string; conflict: boolean } {
  if (!isApiError(error)) return { words: t('dialog.failed'), conflict: false }
  if (error.kind === 'unavailable') return { words: t('held.offline'), conflict: false }
  if (error.kind === 'forbidden') return { words: t('refused.forbidden'), conflict: false }
  const paths = error.issues.map((issue) => issuePath(issue))
  const changed = paths.find((path) => path.startsWith('body/orderIds/CHANGED_SINCE'))
  if (changed) {
    const [, , , who, time] = changed.split('/')
    const at = time && /^\d{2}:\d{2}$/.test(time) ? time : null
    const key = who === 'US' ? (at ? 'dialog.changedByUsAt' : 'dialog.changedByUs') : at ? 'dialog.changedAt' : 'dialog.changed'
    return { words: t(key, at ? { time: at } : undefined), conflict: true }
  }
  if (error.kind === 'conflict' && paths.length > 0 && paths.every((path) => path === 'body/orderIds')) return { words: t('dialog.unchanged'), conflict: false }
  if (error.kind === 'conflict' || error.kind === 'not_found') return { words: t('dialog.reread'), conflict: true }
  return { words: t('dialog.failed'), conflict: false }
}

// ── the order's production, as both pages draw it (F-PR-11 cells, F-PR-12a Status & progress) ──────────────────────────
const HEALTH_OF: Readonly<Record<ProductionHealth['code'], HealthState>> = Object.freeze({ LATE: 'LATE', AT_RISK: 'AT_RISK', NO_DATE: 'NOT_PROMISED', ON_TRACK: 'ON_TIME' })

/** The health chip's input: the API's chip and, when a person raised it, the curated reason (never the office's note). */
export function healthInputOf(health: ProductionHealth | null): HealthInput {
  if (!health) return { computed: null }
  return { computed: HEALTH_OF[health.code], raised: health.reason ? { reason: health.reason.code } : null }
}

/** "Waiting on you" or "Waiting on us" (a supplier or a workshop is ours to solve and never named), since when. */
export const waitingInputOf = (waiting: ProductionWaiting): WaitingInput => ({ who: waiting.code === 'YOU' ? 'BRAND' : 'US', since: waiting.since, kind: 'record' })

/** The plain stage of the lib's strip (the API's five stages are the same). */
export const plainStageOf = (stage: { readonly code: string } | null): PlainStage | null => (stage ? (stage.code as PlainStage) : null)

// ── F-PR-12a: the order's Status & progress (portal/customer/orders/view/StatusTab.tsx) ─────────────────────────────────────
/** What holds its work, as the lib's banner reads it: the curated words only (every level). */
export const holdsOf = (holds: ProductionOrder['holds'], locale: Locale): HoldInput[] => holds.map((hold, index) => ({ id: `${hold.kind}-${index}`, kind: hold.kind, since: hold.since, customerWords: say(hold.words, locale) }))

const COUNT_OF: Readonly<Partial<Record<PlainStage, 'cut' | 'sewn' | 'inspected' | 'packed'>>> = Object.freeze({ CUTTING: 'cut', SEWING: 'sewn', QUALITY: 'inspected', READY: 'packed' })

/**
 * The note of the order's "In production" step (06-tree §0.2: the plain stage is the step's note): "Sewing · 32 of 40 sewn ·
 * 1 line ahead" — the count only from + Progress (its own cells; "—" never 0 where sewing is not counted).
 */
export function stageNoteOf(read: Pick<ProductionOrder, 'stage' | 'progress'>, locale: Locale): string | null {
  const stage = read.stage
  if (!stage) return null
  const parts = [say(stage.words, locale)]
  const key = COUNT_OF[stage.code as PlainStage]
  const whole = read.progress?.whole ?? null
  const done = key && whole ? whole[key] : null
  // The list's own count words (factory-domain portal-read countWords: "32 of 40 sewn"), so the list and the order say the same.
  if (key && whole && done !== null && done !== undefined && !(stage.code === 'SEWING' && stage.sewingNotCounted)) parts.push(say(countWords(key, done, whole.ordered), locale))
  if (stage.sewingNotCounted && stage.sewingNotCountedWords) parts.push(say(stage.sewingNotCountedWords, locale))
  if (stage.ahead > 0 && stage.aheadWords) parts.push(say(stage.aheadWords, locale))
  return parts.join(' · ')
}

/** Where "See what waits for you" leads: Waiting for you once built (F-PR-14), until then Home, which lists what waits. */
export function waitingHrefOf(prefix: string, areas = PORTAL_AREAS): string {
  const built = areas.some((area) => (area.pages ?? []).some((page) => page.id === 'home.waiting' && page.built))
  return built ? `${prefix}/waiting` : `${prefix}/`
}
// ── end F-PR-12a
