import { PROBLEM_ORDERS_MAX } from '@nexus/factory-domain/production-brand/issues'
import { isApiError } from '../../../../lib/api/errors'
import type { Locale } from '../../../../lib/i18n/locales'
import type { PartnerMessageRead } from '../../../shell/api'
import type { OrderDocument } from '../../orders/api'
import type { ProblemState } from '../api'
import type { PointerSources, ProblemAnswer } from './api'

/**
 * F-PR-24 — "Report a problem" and its state, pure (production plan §1, §3 "Issues"; lead picks L24, L25; 17-web-r2 §1.6; review
 * fixes R-41, R-42, R-43; walls PW-12, PW-15, PW-17, PW-P02): which orders the report names (one or more of the customer's OWN
 * orders, at most 50), what it may point to on ONE order (a file we shared, a message of the order's conversation — the line the
 * message carries, never a re-typed measurement), why Send waits, the words of a refusal (the text is always kept), the result per
 * order, and the chip of the order and of its My production row: "Waiting on us since 16 Nov", then "Answered 17 Nov" — the other
 * orders of a batch answered in one order's thread read "Answered in your order 13" (the customer's own number or its PO, never the
 * office's series). The chip names no person: whoever answers in the order's thread signs with their name there, as today.
 */

export { PROBLEM_ORDERS_MAX }
/** The longest text of one message (factory-domain threads/rules MAX_BODY_LENGTH: that module is server-only). */
export const PROBLEM_TEXT_MAX = 20_000
/** The most files and messages the pointer offers (the newest first). */
export const POINTERS_SHOWN = 20

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string
type Writer = (iso: string) => string

// ── the orders the report names ───────────────────────────────────────────────────────────────────────────────────────
export interface ProblemOrder {
  readonly id: string
  /** The customer's own name of the order: their PO first, then "Your order 12" (never the office's series). */
  readonly name: string
}

/** The orders named, each once in the order picked; `over`: how many past the 50 a report takes (Send is held). */
export function problemOrdersOf(orders: readonly ProblemOrder[]): { readonly orders: ProblemOrder[]; readonly over: number } {
  const seen = new Set<string>()
  const unique: ProblemOrder[] = []
  for (const order of orders) {
    if (seen.has(order.id)) continue
    seen.add(order.id)
    unique.push(order)
  }
  return { orders: unique, over: Math.max(0, unique.length - PROBLEM_ORDERS_MAX) }
}

// ── what the message is about (one order only) ───────────────────────────────────────────────────────────────────────
export interface PointerOption {
  /** `file:<document id>` or `message:<message id>`. */
  readonly id: string
  readonly kind: 'file' | 'message'
  /** What the list shows. */
  readonly label: string
  /** The line the message carries in the order's thread, in the person's language. */
  readonly line: string
}

/** One message's words in short (a line, never more). */
export function excerptOf(body: string, max: number): string {
  const text = body.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/**
 * What one order's message may point to: the files we shared on the order and its lines (the current version of each, newest
 * first) and the messages of its conversation (newest first; a message removed after a privacy request is not offered).
 */
export function pointerOptionsOf(sources: PointerSources, locale: Locale, t: Translate, writers: { readonly day: Writer; readonly at: Writer }): PointerOption[] {
  const files = (sources.files?.items ?? [])
    .filter((document: OrderDocument) => document.current)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, POINTERS_SHOWN)
    .map((document): PointerOption => ({ id: `file:${document.id}`, kind: 'file', label: t('problem.pointer.fileOption', { name: document.title[locale], date: writers.day(document.date) }), line: t('problem.about.file', { name: document.title[locale] }) }))
  const messages = sources.messages
    .filter((message: PartnerMessageRead) => !message.erased && message.body.trim() !== '')
    .slice(0, POINTERS_SHOWN)
    .map((message): PointerOption => ({
      id: `message:${message.id}`,
      kind: 'message',
      label: t(message.author.mine ? 'problem.pointer.mineOption' : 'problem.pointer.oursOption', { when: writers.at(message.at), excerpt: excerptOf(message.body, 60) }),
      line: t('problem.about.message', { when: writers.at(message.at), excerpt: excerptOf(message.body, 120) }),
    }))
  return [...files, ...messages]
}

/** The message each order's thread gets: what is wrong, then (one order) what it is about. */
export const problemBodyOf = (text: string, pointer: PointerOption | null): string => (pointer ? `${text.trim()}\n\n${pointer.line}` : text.trim())

// ── why Send waits ───────────────────────────────────────────────────────────────────────────────────────────────────
export interface ProblemFacts {
  readonly preview: boolean
  readonly offline: boolean
  /** The person writes in its orders' conversations (portal.comment): else the dialog is never offered. */
  readonly mayWrite: boolean
  readonly sending: boolean
}

/** The key (of `portal-production`) and its words' values of why Send waits, in the order the person fixes it; null: it may go. */
export function problemHeld(facts: ProblemFacts, draft: { readonly orders: readonly ProblemOrder[]; readonly over: number; readonly text: string; readonly pointer: PointerOption | null }): { readonly key: string; readonly params?: Readonly<Record<string, number>> } | null {
  if (facts.preview) return { key: 'problem.held.preview' }
  if (!facts.mayWrite) return { key: 'problem.held.mayWrite' }
  if (draft.orders.length === 0) return { key: 'problem.held.none' }
  if (draft.over > 0) return { key: 'problem.held.tooMany', params: { count: draft.orders.length, max: PROBLEM_ORDERS_MAX } }
  if (facts.sending) return { key: 'problem.held.sending' }
  if (facts.offline) return { key: 'problem.held.offline' }
  if (draft.text.trim() === '') return { key: 'problem.held.empty' }
  if (problemBodyOf(draft.text, draft.pointer).length > PROBLEM_TEXT_MAX) return { key: 'problem.held.long', params: { max: PROBLEM_TEXT_MAX } }
  return null
}

/**
 * A report that did not go, in our words (the text always stays in the box). `retry`: a moment's failure (no answer, the server
 * busy) — Retry sends the same report again with the same key (never a second message); a refusal does not change by retrying.
 */
export function problemFailure(error: unknown): { readonly key: string; readonly retry: boolean } {
  if (!isApiError(error)) return { key: 'problem.failed.unavailable', retry: true }
  switch (error.kind) {
    case 'not_found':
      return { key: 'problem.failed.notFound', retry: false }
    case 'forbidden':
      return { key: 'problem.failed.forbidden', retry: false }
    case 'conflict':
      return { key: 'problem.failed.refused', retry: false }
    case 'invalid':
      return { key: 'problem.failed.invalid', retry: false }
    default:
      return { key: 'problem.failed.unavailable', retry: true }
  }
}

// ── what happened, per order ─────────────────────────────────────────────────────────────────────────────────────────
export interface ProblemOutcome {
  /** Sent: one message in the order's thread, "Waiting on us since …". */
  readonly sent: readonly { readonly id: string; readonly name: string; readonly since: string }[]
  /** Not sent, and why in the API's words (its order no longer in production, its conversation closed …). */
  readonly notSent: readonly { readonly id: string; readonly name: string; readonly words: string }[]
  /** Named but not one of its orders (another's, or gone): counted, never named. */
  readonly notFound: number
}

/** The answer per order, each named by the customer's own name of it (the list it picked), never the office's number. */
export function problemOutcomeOf(answer: ProblemAnswer, orders: readonly ProblemOrder[], locale: Locale, t: Translate): ProblemOutcome {
  const nameOf = new Map(orders.map((order) => [order.id, order.name]))
  const name = (result: ProblemAnswer['results'][number]) => nameOf.get(result.orderId) ?? result.customerRef ?? t('row.noName')
  return {
    sent: answer.results.flatMap((result) => (result.done && result.problem ? [{ id: result.orderId, name: name(result), since: result.problem.since }] : [])),
    notSent: answer.results.flatMap((result) => (result.done ? [] : [{ id: result.orderId, name: name(result), words: result.words ? result.words[locale] : t('problem.result.notSent') }])),
    notFound: answer.notFound,
  }
}

// ── the chip on the order and its My production row ──────────────────────────────────────────────────────────────────
export interface ProblemChip {
  readonly tone: 'warning' | 'success'
  readonly text: string
}

/** The order our answer is in, by the customer's own words: "your order 13", else its PO; null: neither (plain "Answered"). */
function answeredInOf(problem: ProblemState, t: Translate): string | null {
  const order = problem.inOrder
  if (!order) return null
  if (order.yourNumber) return t('problem.chip.answeredIn', { seq: order.yourNumber.seq })
  if (order.customerRef) return t('problem.chip.answeredInRef', { ref: order.customerRef })
  return null
}

/**
 * "Problem reported · Waiting on us since 16 Nov" until we write in the order's thread, then "Answered 17 Nov"; on the other
 * orders of a batch we answered in one order's thread, "Answered in your order 13". Never a person, never the office's series.
 */
export function problemChipOf(problem: ProblemState | null | undefined, t: Translate, day: Writer): ProblemChip | null {
  if (!problem) return null
  if (problem.state === 'WAITING_ON_US') return { tone: 'warning', text: problem.since ? t('problem.chip.waiting', { date: day(problem.since) }) : t('problem.chip.waitingNoDate') }
  if (problem.state === 'ANSWERED_IN') {
    const where = answeredInOf(problem, t)
    if (where) return { tone: 'success', text: where }
  }
  return { tone: 'success', text: problem.on ? t('problem.chip.answered', { date: day(problem.on) }) : t('problem.chip.answeredNoDate') }
}

// ── the files card on the order (Order files (3) · All in Documents (7)) ─────────────────────────────────────────────────
/** The files card shows the newest three. */
export const ORDER_FILES_SHOWN = 3

/** The newest current documents we shared on the order and its lines, and how many there are in all; none: the card is not drawn. */
export function orderFilesOf<D extends Pick<OrderDocument, 'current' | 'date'>>(items: readonly D[], max = ORDER_FILES_SHOWN): { readonly shown: D[]; readonly count: number } {
  const current = items.filter((item) => item.current).sort((a, b) => b.date.localeCompare(a.date))
  return { shown: current.slice(0, max), count: current.length }
}
