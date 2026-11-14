import type { Translate } from '../../../../lib/i18n/messages'
import { SECURITY_EVENT_VIEWS, SECURITY_SURFACES, type SecurityEvent, type SecurityEventView, type SecuritySurface } from './api'

/**
 * Admin › Security › Security events (SCR-166 section `events` and pop:event, B-W2b-413; design admin.security "Time, event in
 * words, who (or 'unknown'), IP country, result"; "Row → DetailModal; saved filters 'Failed sign-ins', 'Exports'"), pure: the
 * filters as the address holds them (the export's own terms: `view`, `surface`, `ip`; the open event `event`), and every code
 * in words (`admin-security-depth` `events.*`). Rows, never a count or a total per person; a floor worker never by name.
 */

export interface EventFilters {
  view: SecurityEventView | null
  surface: SecuritySurface | null
  /** The address typed (matched by its keyed hash; never shown back from an event). */
  ip: string | null
}
export const NO_EVENT_FILTERS: EventFilters = { view: null, surface: null, ip: null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const oneOf = <T extends string>(list: readonly T[], value: string | null): T | null => (value !== null && (list as readonly string[]).includes(value) ? (value as T) : null)

/** An IPv4 or IPv6 address as typed (the API checks it again): digits, dots, colons and hex. */
export const looksLikeAddress = (value: string): boolean => /^(\d{1,3}\.){3}\d{1,3}$/.test(value.trim()) || /^[0-9a-f:]{2,45}$/i.test(value.trim()) && value.includes(':')

/** The filters and the open event from the address; anything malformed is left out. */
export function eventsState(params: { get(name: string): string | null } | null | undefined): { filters: EventFilters; open: string | null } {
  const get = (name: string) => params?.get(name) ?? null
  const ip = get('ip')
  const open = get('event')
  return {
    filters: { view: oneOf(SECURITY_EVENT_VIEWS, get('view')), surface: oneOf(SECURITY_SURFACES, get('surface')), ip: ip && looksLikeAddress(ip) ? ip.trim() : null },
    open: open && UUID.test(open) ? open : null,
  }
}

/** The address terms for these filters and the open event, over the page's other terms (kept). */
export function eventsQuery(current: string, filters: EventFilters, open: string | null): string {
  const out = new URLSearchParams(current)
  for (const name of ['view', 'surface', 'ip', 'event']) out.delete(name)
  if (filters.view) out.set('view', filters.view)
  if (filters.surface) out.set('surface', filters.surface)
  if (filters.ip) out.set('ip', filters.ip)
  if (open) out.set('event', open)
  return out.toString()
}

export const filterCount = (filters: EventFilters): number => [filters.view, filters.surface, filters.ip].filter((value) => value !== null).length

export const RESULT_TONE = { SUCCEEDED: 'success', REFUSED: 'danger', LOCKED: 'warning', DONE: 'neutral' } as const

/** Who, in words: an office or portal person by name; a floor worker, a link, the system or nobody known, never by name. */
export function whoWords(event: Pick<SecurityEvent, 'actor'>, t: Translate): string {
  if (event.actor.kind === 'PERSON') return event.actor.name ?? t('events.who.person')
  return t(`events.who.${event.actor.kind}`)
}

/** A code of the details in words, when this page knows it; else the code itself (never a guess). */
function codeWords(group: string, value: string, t: Translate): string {
  const key = `events.${group}.${value.replace(/[^A-Za-z0-9]+/g, '_')}`
  const words = t(key)
  return words === key ? value : words
}

/** The detail keys this page says in words, in this order; any other key follows with its code. */
const DETAIL_ORDER = ['reason', 'what', 'change', 'secondFactor', 'method', 'failedAttempts', 'failures', 'tries', 'lockMinutes', 'permission', 'route', 'listKey', 'format', 'result', 'lockedUntil', 'action', 'after'] as const
/** Details shown as they are: routes, list keys, actions, formats, counts. */
const AS_IS: ReadonlySet<string> = new Set(['route', 'listKey', 'action', 'after', 'format', 'method', 'failedAttempts', 'failures', 'tries', 'lockMinutes'])

/** A detail key this page has no words for, as words of its own ("lockMinutes" → "lock minutes"): never the bare key. */
const keyWords = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()

export interface DetailLine {
  key: string
  label: string
  value: string
}

/**
 * The event's details as lines (label, value), from codes only: reason, what was locked, the two-factor change, the second
 * factor, the permission refused (in the Admin words through `permission`), the route, the list exported and its format, the
 * step-up result and until when it is locked (`time`).
 */
export function detailLines(details: Readonly<Record<string, unknown>>, t: Translate, words: { permission: (name: string) => string; time: (iso: string) => string }): DetailLine[] {
  const keys = [...DETAIL_ORDER.filter((key) => key in details), ...Object.keys(details).filter((key) => !(DETAIL_ORDER as readonly string[]).includes(key)).sort()]
  return keys.flatMap((key) => {
    const raw = details[key]
    if (raw === null || raw === undefined || raw === '') return []
    const text = Array.isArray(raw) ? raw.map(String).join(', ') : String(raw)
    // A step-up try's code (`result`) has words of its own group: `events.result` is the event's result.
    const value = key === 'permission' ? words.permission(text) : key === 'lockedUntil' ? words.time(text) : AS_IS.has(key) ? text : codeWords(key === 'result' ? 'tryResult' : key, text, t)
    const labelKey = `events.detail.${key}`
    const label = t(labelKey)
    return [{ key, label: label === labelKey ? keyWords(key) : label, value }]
  })
}

/** The table's one line beside the kind: the reason, the permission refused, the list exported, the change. */
export function summaryOf(event: Pick<SecurityEvent, 'kind' | 'details'>, t: Translate, permission: (name: string) => string): string | null {
  const details = event.details
  const text = (key: string) => (typeof details[key] === 'string' ? (details[key] as string) : null)
  if (text('reason')) return codeWords('reason', text('reason')!, t)
  if (event.kind === 'PERMISSION_DENIED' && text('permission')) return permission(text('permission')!)
  if (event.kind === 'MFA_CHANGED' && text('change')) return codeWords('change', text('change')!, t)
  if (event.kind === 'EXPORT' && text('listKey')) return text('format') ? `${text('listKey')} · ${text('format')}` : text('listKey')
  if (text('what')) return codeWords('what', text('what')!, t)
  return null
}
