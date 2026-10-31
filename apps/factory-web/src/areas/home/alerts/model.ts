import { RULE_KINDS, type AlertSeverity, type RuleKind } from '@nexus/factory-domain/alerts/kinds'
import { ALERT_TILES, type AlertTile, type AlertVerb } from '@nexus/factory-domain/alerts/rules'
import type { ListKey } from '../../../list-frame/model'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { formatDate, formatDateTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import type { Params, Translate } from '../../../lib/i18n/messages'
import type { PanelRead } from '../../../record-panels/model'
import type { AlertRule, RulesList } from '../../_shared/rules/api'
import type { RuleDialogState } from '../../_shared/rules/view/RuleDialog'
import type { AlertDetail, AlertHistoryEntry, AlertItem, AlertPerson, AlertTileCount } from './api'

/**
 * Home › Alerts (SCR-234; design home.alerts, W2a; ANA-036): the ONE view model the page draws and its pure rules. The
 * alerts, their tiles and what a person may do with each come from the API (B-W2a-33: an alert is behind alerts.view AND its
 * record's own view permission); the web adds the address (`?tile` `?severity` `?kind` `?q` `?open` `?rule`), the
 * selection and its bulk acknowledge, each alert said from its phrase in the reader's language, the keys and where each
 * row opens. "For me" and "unassigned" are the only filters about people (Statuto art. 4: never another person).
 */

export const NAMESPACE = 'home-alerts'
export const TILES: readonly AlertTile[] = ALERT_TILES
export const SEVERITY_ORDER: readonly AlertSeverity[] = Object.freeze(['CRITICAL', 'WARNING', 'INFO'])

export interface AlertsControls {
  readonly tile: AlertTile | null
  readonly severity: AlertSeverity | null
  readonly kind: RuleKind | null
  readonly q: string
  /** The alert whose popup is open (`?open=`). */
  readonly open: string | null
  /** The rule dialog (`?rule=<id>`, `?rule=new`). */
  readonly rule: string | null
}

const oneOf = <T extends string>(list: readonly T[], value: string | null | undefined): T | null => ((list as readonly string[]).includes(value ?? '') ? (value as T) : null)

export function controlsOf(params: { get(name: string): string | null } | null | undefined): AlertsControls {
  return {
    tile: oneOf(ALERT_TILES, params?.get('tile')),
    severity: oneOf(SEVERITY_ORDER, params?.get('severity')),
    // `ruleKind` too: an API list's own filter (lib/records LIST_PAGES '/alerts').
    kind: oneOf(RULE_KINDS, params?.get('kind') ?? params?.get('ruleKind')),
    q: params?.get('q') ?? '',
    open: params?.get('open') || null,
    rule: params?.get('rule') || null,
  }
}

/** The page's address (its own query: the API's filters as the page reads them back). */
export function alertsAddress(controls: AlertsControls): string {
  const query = new URLSearchParams()
  if (controls.tile) query.set('tile', controls.tile)
  if (controls.severity) query.set('severity', controls.severity)
  if (controls.kind) query.set('kind', controls.kind)
  if (controls.q.trim()) query.set('q', controls.q.trim())
  if (controls.open) query.set('open', controls.open)
  if (controls.rule) query.set('rule', controls.rule)
  const text = query.toString()
  return text ? `?${text}` : ''
}

/** Any filter of the list set (the empty list then offers to clear them). */
export const filtered = (controls: Pick<AlertsControls, 'tile' | 'severity' | 'kind' | 'q'>): boolean => controls.tile !== null || controls.severity !== null || controls.kind !== null || controls.q.trim() !== ''

/** A row as the page draws it: the API's alert, its popup's address and its record's. */
export interface AlertRow extends AlertItem {
  /** `?open=<id>` on this page (a real link: ⌘-click opens it in a new tab). */
  readonly href: string
  /** The record it is about (its own page, else its panels): ⌘-click investigates while the queue stays. */
  readonly recordHref: string
}

export type LiveState = 'connecting' | 'live' | 'offline'

export interface AlertsList {
  readonly asOf: string
  readonly tiles: readonly AlertTileCount[]
  readonly total: number
  /** False: more than 1000 alerts match; the first 1000 in rank order were read. */
  readonly complete: boolean
  readonly rows: readonly AlertRow[]
  readonly more: boolean
  readonly loadingMore: boolean
}

export interface AlertView extends Omit<AlertDetail, 'alert' | 'similar'> {
  readonly alert: AlertRow
  readonly similar: readonly (AlertDetail['similar'][number] & { readonly href: string })[]
}

/** The open alert's popup: the alert read alone (history, similar), and its rule (its sentence in the reader's words). */
export interface OpenAlert {
  readonly id: string
  readonly detail: PanelRead<AlertView>
  readonly rule: PanelRead<AlertRule> | null
}

export type AlertsDialog =
  | { readonly kind: 'assign'; readonly id: string; readonly people: PanelRead<readonly AlertPerson[]> }
  | { readonly kind: 'resolve'; readonly id: string }
  | { readonly kind: 'snooze'; readonly id: string }
  | { readonly kind: 'help' }

export interface AlertsNotice {
  /** A message key of `home-alerts` (or `rules` for `rules:` keys). */
  readonly key: string
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
  readonly params?: Readonly<Record<string, string | number>>
}

export interface AlertsCan {
  readonly view: boolean
  readonly handle: boolean
  readonly manageRules: boolean
}

export function alertsCan(permissions: readonly string[]): AlertsCan {
  const held = new Set(permissions)
  return { view: held.has('alerts.view'), handle: held.has('alerts.handle'), manageRules: held.has('alerts.rules.manage') }
}

export interface AlertsViewModel {
  /** alerts.view: else the page says so and reads nothing. */
  readonly access: 'open' | 'refused'
  readonly now: number
  readonly prefix: string
  readonly can: AlertsCan
  readonly live: LiveState
  readonly controls: AlertsControls
  readonly list: PanelRead<AlertsList>
  /** Live changes waiting behind "N updates · Show". */
  readonly updates: number
  readonly selected: readonly string[]
  readonly open: OpenAlert | null
  readonly dialog: AlertsDialog | null
  readonly busy: boolean
  readonly notice: AlertsNotice | null
  /** The Rules section (GET /alerts/rules). */
  readonly rules: PanelRead<RulesList>
  readonly ruleDialog: RuleDialogState | null
  /** Rules whose switch or number is being saved (the cell shows it). */
  readonly savingRules: readonly string[]
  /** Design cases: the row that has the focus. */
  readonly focusRow?: number
}

// ---- rules -------------------------------------------------------------------------------------------------------------

/** Why a row cannot be ticked for "Acknowledge N" (a key of `home-alerts`), or null. */
export function selectHeld(row: Pick<AlertItem, 'verbs' | 'state'>): string | null {
  if (row.verbs.includes('ACKNOWLEDGE')) return null
  if (row.state === 'RESOLVED') return 'held.rowResolved'
  if (row.state === 'ACKNOWLEDGED') return 'held.rowAcknowledged'
  return 'held.rowReadOnly'
}

/** The selected rows "Acknowledge N" reaches (open ones the person may handle), in the list's order. */
export function bulkRows<T extends Pick<AlertItem, 'id' | 'verbs' | 'state'>>(rows: readonly T[], selected: readonly string[]): T[] {
  return rows.filter((row) => selected.includes(row.id) && selectHeld(row) === null)
}

/** Why every change is held now (a key of `home-alerts`), or null. */
export function actionHeld(state: { readonly can: Pick<AlertsCan, 'handle'>; readonly live: LiveState; readonly busy: boolean }): string | null {
  if (!state.can.handle) return 'held.noHandle'
  if (state.live === 'offline') return 'held.offline'
  if (state.busy) return 'held.busy'
  return null
}

/** Why one of the popup's verbs is held for this alert (a key of `home-alerts`), or null. */
export function verbHeld(alert: Pick<AlertItem, 'verbs' | 'state'>, verb: AlertVerb, base: string | null): string | null {
  if (base) return base
  if (alert.verbs.includes(verb)) return null
  if (alert.state === 'RESOLVED') return 'held.resolved'
  if (verb === 'ACKNOWLEDGE' && alert.state === 'ACKNOWLEDGED') return 'held.acknowledged'
  return 'held.noHandleHere'
}

/** How many rows of a fresh read differ from those shown (new, changed or gone): "N updates · Show". */
export function updatesBetween(shown: readonly Pick<AlertItem, 'id' | 'version'>[], fresh: readonly Pick<AlertItem, 'id' | 'version'>[]): number {
  const before = new Map(shown.map((row) => [row.id, row.version]))
  const after = new Map(fresh.map((row) => [row.id, row.version]))
  let count = 0
  for (const [id, version] of after) if (before.get(id) !== version) count += 1
  for (const id of before.keys()) if (!after.has(id)) count += 1
  return count
}

/** A tile's number: exact, or "at least" when more alerts match than the API read. */
export const tileValue = (tile: AlertTileCount): { key: string; count: number } => (tile.complete ? { key: 'tile.count', count: tile.count } : { key: 'tile.atLeast', count: tile.count })

/** The rows the popup steps through (J / K): the list as shown. */
export const popupIds = (rows: readonly { readonly id: string }[]): string[] => rows.map((row) => row.id)

// ---- words ----------------------------------------------------------------------------------------------------------------

/** An alert in the reader's language, from its phrase (`w.<key>`; dates written the reader's way). */
export function alertSentence(alert: Pick<AlertItem, 'words' | 'record'>, t: Translate, locale: Locale): string {
  const params: Record<string, string | number> = {}
  for (const [name, value] of Object.entries(alert.words.params)) params[name] = typeof value === 'string' && /Date$/.test(name) && /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDate(value, { locale }) : value
  const key = `w.${alert.words.key}`
  const text = t(key, params as Params)
  return text === key ? t('w.alerts.UNKNOWN', { label: alert.record.label }) : text
}

/** What the rule watches, in the reader's words (`rules:kind.<KIND>`), or the code for a kind this web does not know. */
export const kindWords = (kind: string, r: Translate): string => ((RULE_KINDS as readonly string[]).includes(kind) ? r(`kind.${kind}`) : kind)

/** A colleague named inside one alert: "you" for the reader (a cell, said alone). */
export const personWords = (person: AlertPerson | null, t: Translate): string => (person === null ? t('person.system') : person.me ? t('person.you') : person.name)
/** The same after a preposition ("by you", "da te"; "for you", "per te"). */
export const personAfter = (person: AlertPerson | null, t: Translate): string => (person === null ? t('person.system') : person.me ? t('person.youAfter') : person.name)

/** How old an alert is, in words. */
export const ageWords = (days: number, t: Translate): string => (days <= 0 ? t('age.today') : t('age.days', { count: days }))

/** The state as the list says it: open, acknowledged, resolved (or cleared), snoozed until. */
export function stateWords(alert: Pick<AlertItem, 'state' | 'snoozed' | 'resolved'>, t: Translate, locale: Locale): string {
  if (alert.state === 'RESOLVED') return t(alert.resolved?.resolution === 'CLEARED' ? 'state.CLEARED' : 'state.RESOLVED')
  if (alert.snoozed?.now) return t('state.snoozed', { date: formatDateTime(alert.snoozed.until, { locale }) })
  return t(`state.${alert.state}`)
}

/** Whose it is: assigned to someone, else "nobody yet". */
export const assigneeWords = (alert: Pick<AlertItem, 'assigned'>, t: Translate): string => (alert.assigned ? personWords(alert.assigned.to, t) : t('person.nobody'))

/** One step of an alert's history in words (the actor named inside the one alert; the system says it plainly). */
export function historyWords(entry: AlertHistoryEntry, t: Translate, locale: Locale): string {
  const who = personAfter(entry.actor, t)
  switch (entry.verb) {
    case 'RAISED':
      return t('history.RAISED')
    case 'ACKNOWLEDGED':
      return t('history.ACKNOWLEDGED', { who })
    case 'ASSIGNED':
      return t('history.ASSIGNED', { who, to: personAfter(entry.assignee, t) })
    case 'UNASSIGNED':
      return t('history.UNASSIGNED', { who, to: personAfter(entry.assignee, t) })
    case 'SNOOZED':
      return t('history.SNOOZED', { who, date: entry.snoozedUntil ? formatDateTime(entry.snoozedUntil, { locale }) : '—' })
    case 'RESOLVED':
      return entry.actor === null ? t('history.CLEARED') : t('history.RESOLVED', { who })
  }
}

/** The page's own keys, in the list footer's info icon (the frame adds j / k, Enter, x and the rest). */
export function alertsKeys(t: Translate): ListKey[] {
  return [{ keys: ['d'], does: t('keys.acknowledge') }]
}

// ---- refusals --------------------------------------------------------------------------------------------------------------

const CODES = ['RESOLVED', 'ALREADY_ACKNOWLEDGED', 'ALREADY_ASSIGNED', 'NOT_ASSIGNED'] as const

/**
 * A refused change in words (a key of `home-alerts`), and whether the list is read again: resolved or acknowledged
 * meanwhile, changed by someone else, a person who may not be given it, a snooze time or note refused, no right, gone.
 */
export function refusalOf(error: unknown): { readonly key: string; readonly reload: boolean } {
  if (!isApiError(error)) return { key: 'refusal.failed', reload: false }
  const paths = error.issues.map(issuePath)
  const code = CODES.find((entry) => paths.some((path) => path === `alert/${entry}` || path.endsWith(`/${entry}`)))
  if (error.kind === 'conflict') return { key: code ? `refusal.${code}` : 'refusal.changed', reload: true }
  if (error.kind === 'invalid') {
    if (paths.includes('body/assigneeId')) return { key: 'refusal.assignee', reload: false }
    if (paths.includes('body/until')) return { key: 'refusal.until', reload: false }
    if (paths.includes('body/note')) return { key: 'refusal.note', reload: false }
    return { key: 'refusal.invalid', reload: false }
  }
  if (error.kind === 'forbidden' || error.kind === 'step_up') return { key: 'refusal.forbidden', reload: false }
  if (error.kind === 'not_found') return { key: 'refusal.gone', reload: true }
  if (error.kind === 'unavailable') return { key: 'refusal.offline', reload: false }
  return { key: 'refusal.failed', reload: false }
}

/** A failed read in words (a key of `home-alerts`). */
export function readProblemOf(error: unknown): string {
  if (!isApiError(error)) return 'problem.failed'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'problem.forbidden'
  if (error.kind === 'not_found') return 'problem.gone'
  if (error.kind === 'unavailable') return 'problem.offline'
  return 'problem.failed'
}

/** A resolution's note, trimmed, or why it is not ready (a key of `home-alerts`): it says what was done, at most 1000. */
export function noteHeld(note: string): string | null {
  const length = note.trim().length
  if (length === 0) return 'resolve.noteEmpty'
  if (length > 1000) return 'resolve.noteLong'
  return null
}
