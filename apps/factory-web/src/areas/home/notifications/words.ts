import { isCurrencyCode, minorPlaces } from '@nexus/factory-domain/core/money'
import { formatNumber } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import type { Translate } from '../../../lib/i18n/messages'
import type { Notification, NotificationRow } from './model'

/**
 * A notification in the person's language (PLT-152 "text built per reader"). The API keeps each notification's message
 * key and params, made FOR its reader (factory-domain notifications/rules MESSAGE_TEMPLATES): this file draws it with
 * `w.<message key>` of the `home-notifications` catalogue (it, en; the English is the domain's own, a test holds it).
 * Placeholders: {actor} the person who caused it (by id, named in `people`; none: "the system"), {record} the record's
 * label, {title} a task's or a rule's title, {kind} a Today row's kind in words, {status} a decision (`w.status.<code>`),
 * {figure} the amount the reader may see — only when the params still hold it (the API drops an amount whose grain the
 * reader lost); {count}, {entered}, {left} the rows of a followed saved view (B-W2b-385). An unknown key says "News on
 * {record}".
 */

/** A marked amount `{ $money, value }` (kept by the API only for a reader with its grain), or the bare value. */
function unmarked(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && '$money' in value && 'value' in value) return (value as { value: unknown }).value
  return value
}

/** The amounts the sentence may quote, in the person's format: " (€1.234,00, margin 18,2 %)", or ''. */
export function figureWords(params: Readonly<Record<string, unknown>>, t: Translate, locale: Locale): string {
  const parts: string[] = []
  const net = unmarked(params.netAmount) as { minor?: unknown; currency?: unknown } | undefined
  if (net && typeof net.minor === 'number' && typeof net.currency === 'string') parts.push(formatNumber(net.minor / 10 ** (isCurrencyCode(net.currency) ? minorPlaces(net.currency) : 2), locale, { style: 'currency', currency: net.currency }))
  const margin = unmarked(params.marginPct)
  if (typeof margin === 'string' && margin.trim() !== '' && Number.isFinite(Number(margin))) parts.push(t('w.margin', { value: formatNumber(Number(margin), locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }))
  return parts.length === 0 ? '' : t('w.figure', { parts: parts.join(', ') })
}

const paramsOf = (notification: Pick<Notification, 'params'>): Record<string, unknown> =>
  (notification.params && typeof notification.params === 'object' && !Array.isArray(notification.params) ? notification.params : {}) as Record<string, unknown>

/** Who caused it, by name ("the system" when nobody did; "someone" when the reader may not know who). */
function actorWords(notification: Pick<Notification, 'params' | 'actor' | 'people'>, t: Translate): string {
  const params = paramsOf(notification)
  const actorId = typeof params.actorId === 'string' ? params.actorId : (notification.actor?.id ?? null)
  return actorId ? (notification.people[actorId] ?? (notification.actor?.id === actorId ? notification.actor.name : null) ?? t('w.someone')) : t('w.system')
}

/** The notification's sentence, as its reader reads it now. */
export function sentenceWords(notification: Pick<Notification, 'messageKey' | 'params' | 'record' | 'actor' | 'people'>, t: Translate, locale: Locale): string {
  const params = paramsOf(notification)
  const actor = actorWords(notification, t)
  const statusCode = typeof params.status === 'string' ? params.status : ''
  const statusKey = `w.status.${statusCode}`
  const status = statusCode ? (t(statusKey) === statusKey ? statusCode : t(statusKey)) : ''
  const values = {
    actor,
    record: notification.record.label,
    title: typeof params.title === 'string' ? params.title : '',
    kind: typeof params.kindLabel === 'string' ? params.kindLabel : String(params.kind ?? ''),
    status,
    figure: figureWords(params, t, locale),
    // B-W2b-385: the rows of a followed saved view (now, came in, left).
    count: typeof params.count === 'number' ? formatNumber(params.count, locale) : '',
    entered: typeof params.entered === 'number' ? formatNumber(params.entered, locale) : '',
    left: typeof params.left === 'number' ? formatNumber(params.left, locale) : '',
  }
  const key = `w.${notification.messageKey}`
  const text = t(key, values)
  return text === key ? t('w.fallback', values) : text
}

/** B-TH-239: a row's words — folded new requests say "5 new requests came in" (the numbers stay on the chip), any other its sentence. */
export function rowWords(row: Pick<NotificationRow, 'messageKey' | 'params' | 'record' | 'actor' | 'people' | 'fold'> & { readonly group?: { readonly records?: number | undefined } }, t: Translate, locale: Locale): string {
  if (row.fold) return t('fold.newRequests', { count: row.fold.requests })
  // ---- F-PR-22: one "Note to N" batch on several records is one row (threads T6, B-TH-045's batch group): "Alex Demo mentioned you on
  // 12 orders" — the records this reader may read only (the API's `records`), never another customer's count.
  const records = row.group?.records ?? 1
  if (row.messageKey === MENTION_KEY && records > 1) return t('w.notifications.mentionedOn', { actor: actorWords(row, t), records: formatNumber(records, locale) })
  // ---- end F-PR-22
  return sentenceWords(row, t, locale)
}

/** F-PR-22: the message key of a mention (factory-domain notifications/rules MESSAGE_TEMPLATES). */
const MENTION_KEY = 'notifications.mentioned'
