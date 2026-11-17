import type { Locale } from '../../../lib/i18n/locales'
import type { ComposeDraft, ShipToChoice } from '../../../lib/request-compose/model'
import type { DeliveryAddress } from '../account/api'
import { styleName } from '../catalogue/model'
import type { StyleDetail } from '../catalogue/api'
import type { OrderRecord } from '../orders/api'
import type { RequestRow, SendAnswer } from '../requests/api'
import { requestHref, requestOrder, stateTone, yourNumberText } from '../requests/model'
import type { OpenRequestItem, RequestReceipt } from './view/RequestPageView'

/**
 * Portal › New order as an e-mail (B-TH-220, B-TH-303), pure: whether the catalogue door shows, the fixed recipient line, the
 * delivery addresses it offers, what a style from the catalogue or a past order puts in the message (P-CUS-NEW.details-F04:
 * "the style carried"; the order record's "Reorder this line"), the receipt (the customer's own number only), the side
 * column's open requests, and a refusal's words key. The container reads and writes; the views draw.
 */

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

/**
 * The catalogue door ("Order from the catalogue", B-W2b-194's draft with lines) is CLOSED until catalogue orders open in
 * Sales › Incoming (B-TH-039/040): it returns with B-TH-304 (PR-18). While closed, `/orders/new` is always the request like an
 * e-mail; a catalogue's "Add to order" or an order's "Reorder this line" carry their styles into the message instead.
 */
export const CATALOGUE_DOOR_OPEN = false

/** The address terms of the catalogue door (B-W2b-194): only they open its page, and only while the door is open. */
export function opensCatalogueDoor(search: Pick<URLSearchParams, 'get'> | null, open: boolean = CATALOGUE_DOOR_OPEN): boolean {
  if (!open || !search) return false
  return Boolean(search.get('draft') || search.get('way') || search.get('reorder'))
}

/** "Sales at <company>": the company of this sign-in, never a choice (W11). */
export const goesToOf = (company: string, t: Translate): string => t('request.goesTo', { company })

/** The delivery addresses a request may name: active ones, never one we refused; a new one still waiting for our check is offered (we check it before the first delivery). Default first. */
export function shipToChoices(addresses: readonly DeliveryAddress[]): ShipToChoice[] {
  return addresses
    .filter((address) => address.status === 'ACTIVE' && address.approval?.status !== 'REFUSED')
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
    .map((address) => ({
      id: address.id,
      label: [address.name, address.line1, [address.postalCode, address.city].filter(Boolean).join(' ')].filter((part) => part && part.trim() !== '').join(', '),
      waiting: address.approval?.status === 'WAITING',
      isDefault: address.isDefault,
    }))
}

// ── what the catalogue and a past order carry into the message ────────────────────────────────────────────────────────
/** The subject and message lines for styles from the catalogue ("Add to order" while the door is closed). */
export function stylesText(styles: readonly Pick<StyleDetail['style'], 'code' | 'name' | 'nameI18n'>[], locale: Locale, t: Translate): { subject: string; lines: string[] } | null {
  if (styles.length === 0) return null
  const first = styles[0]!
  const subject = styles.length === 1 ? t('request.styleSubject', { code: first.code, name: styleName(first, locale) }) : t('request.stylesSubject', { code: first.code, count: styles.length - 1 })
  return { subject, lines: styles.map((style) => t('request.styleLine', { code: style.code, name: styleName(style, locale) })) }
}

/** One past order line as words: "JKT-100 Giacca, Nero: 48 × 4, 50 × 8" (a made-to-measure unit: its quantity). */
export function reorderLineText(line: OrderRecord['lines'][number], t: Translate): string {
  const style = [line.style ? `${line.style.code} ${line.style.name}` : line.description, line.colourway?.name].filter(Boolean).join(', ')
  const sized = line.sizes.filter((row) => row.size !== null && row.ordered > 0)
  const sizes = sized.length > 0 ? sized.map((row) => `${row.size} × ${row.ordered}`).join(', ') : String(line.quantity)
  return t('request.reorderLine', { style: style || '—', sizes })
}

/** The subject and message lines for "Reorder this line" (one line) or a whole past order. */
export function reorderText(record: Pick<OrderRecord, 'order' | 'lines'> & { order: { yourNumber?: OrderRecord['order']['yourNumber'] } }, lineId: string | null, locale: Locale, t: Translate): { subject: string; lines: string[]; yours: string } {
  const yours = yourNumberText(record.order.yourNumber ?? null, locale) ?? t('request.theOrder')
  const chosen = lineId ? record.lines.filter((line) => line.id === lineId) : record.lines
  const lines = (chosen.length > 0 ? chosen : record.lines).map((line) => reorderLineText(line, t))
  return { subject: t('request.reorderSubject', { yours }), lines: [t('request.reorderIntro'), ...lines], yours }
}

/** Puts carried lines into a draft: the subject only when none is typed, the lines after what is written. */
export function withCarried(draft: ComposeDraft, carried: { subject: string; lines: readonly string[] }): ComposeDraft {
  const written = draft.message.replace(/\s+$/, '')
  return { ...draft, subject: draft.subject.trim() === '' ? carried.subject : draft.subject, message: [written, carried.lines.join('\n')].filter((part) => part !== '').join('\n\n') }
}

// ── the receipt and the side column ───────────────────────────────────────────────────────────────────────────────────
/** The receipt from the send's answer and what was typed: the customer's own number only (never the office's INQ-…). */
export function receiptOf(answer: SendAnswer, draft: ComposeDraft, choices: readonly ShipToChoice[], prefix: string, at: (iso: string) => string): RequestReceipt {
  const view = answer.request
  const shipTo = view.shipTo ? [view.shipTo.name, view.shipTo.line1, view.shipTo.city].filter(Boolean).join(', ') : (choices.find((choice) => choice.id === draft.shipToAddressId)?.label ?? null)
  return {
    seq: answer.receipt.yourNumber?.seq ?? null,
    subject: answer.receipt.subject,
    message: draft.message.replace(/\s+$/, ''),
    customerRef: view.customerRef,
    wantedDate: view.wantedDate,
    shipTo,
    at: at(view.receivedAt),
    requestHref: requestHref(prefix, view.id),
  }
}

/** "Your open requests": the last five, what needs the customer first, its own number and true state. */
export function openItems(rows: readonly RequestRow[], prefix: string, locale: Locale, when: (iso: string) => string, max = 5): OpenRequestItem[] {
  return requestOrder(rows)
    .filter((row) => row.state.open)
    .slice(0, max)
    .map((row) => ({ id: row.id, href: requestHref(prefix, row.id), yours: yourNumberText(row.yourNumber, locale), subject: row.subject, state: { words: row.state.words[locale], tone: stateTone(row.state.code) }, when: when(row.updatedAt) }))
}

/** A refused send's words (a key of `portal-ordering`), from the API error's kind. */
export function failedKey(kind: string | null): string {
  switch (kind) {
    case 'conflict':
    case 'forbidden':
    case 'invalid':
    case 'unavailable':
    case 'rate_limited':
      return `request.failed.${kind}`
    default:
      return 'request.failed.other'
  }
}

/** The send was refused because the company takes no request now (B-TH-012: 409, `request/closed`). */
export const closedRefusal = (issues: readonly { path?: unknown }[]): boolean => issues.some((issue) => (Array.isArray(issue.path) ? issue.path.join('/') : String(issue.path ?? '')).replace(/\./g, '/') === 'request/closed')
