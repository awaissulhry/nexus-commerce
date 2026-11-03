import { addDays, daysBetween, DEADLINE_KINDS, DEADLINE_LIMITS, DEADLINE_REFUSALS, KNOWN_CALENDAR_KINDS, CALENDAR_WINDOW_MAX_DAYS, type DeadlineKind, type ItemState, type RepeatUnit } from '@nexus/factory-domain/safety/calendar/rules'
import { ORGANISATION_LIMITS, ORGANISATION_REFUSALS, RLS_ROLES, SAFETY_ROLES, TEAM_ROLES, type AppointmentSignMethod, type SafetyRole } from '@nexus/factory-domain/safety/organisation/rules'
import { issuePath, isApiError } from '../../../lib/api/errors'
import { hasRecordPage, recordAddress } from '../../../lib/records/record-links'
import { isIsoDay, isIsoMonth, monthBounds, moveMonth, stateRank } from '../_shared/calendar/model'
import type { Appointment, CalendarItem, CountsAnswer, Deadline, DeadlineEdit, MissingRole, NewAppointmentBody, NewDeadlineBody, OrgPlace, RlsNotice } from './api'

/**
 * Plant › Health & safety › Safety calendar (SCR-267; B-W2b-120; design plant.calendar): the page's rules, pure. The address
 * ⇄ the page's state, the read windows, an item's sentence per kind (data words in, message keys out: never the API's
 * English), where an item is kept (a built page, this page, or words), the tiles, the organisation's and the notices'
 * rows, every dialog's draft with why its button is held and what it sends, and the API's refusals in our words.
 * A person's name only inside the organisation register (the roles' holders, safety.view) and one record; health stays
 * a count for everyone.
 */

// ---- permissions ----------------------------------------------------------------------------------------------------------

export interface CalendarCan {
  /** safety.view: the page at all. */
  view: boolean
  /** safety.calendar.manage: Add deadline, edit, mark done, cancel. */
  manageCalendar: boolean
  /** safety.organisation.manage: appoint, sign, end a term, record a notice. */
  manageOrganisation: boolean
  /** files.upload: a letter, a receipt, evidence. */
  upload: boolean
}

export function calendarCan(permissions: readonly string[]): CalendarCan {
  const held = new Set(permissions)
  return { view: held.has('safety.view'), manageCalendar: held.has('safety.calendar.manage'), manageOrganisation: held.has('safety.organisation.manage'), upload: held.has('files.upload') }
}

// ---- live -------------------------------------------------------------------------------------------------------------------

/** The live types that move the calendar: this page's own, and every other page's deadlines by their type's start. */
const ORGANISATION_EVENTS = new Set(['safety_appointment.changed'])
const NOTICE_EVENTS = new Set(['rls_notice.changed'])
const DEADLINE_EVENTS = new Set(['safety_deadline.changed'])
const SOURCE_PREFIXES = ['machine_check', 'machine_check_plan', 'training_', 'health_visit', 'incident', 'inail', 'risk_assessment']

/** Which sections a live message reads again (a message is a hint: the page reads, it never takes data from it). */
export function sectionsOfChange(change: { readonly type: string }): PageSection[] {
  if (ORGANISATION_EVENTS.has(change.type)) return ['organisation', 'notices', 'counts', 'calendar']
  if (NOTICE_EVENTS.has(change.type)) return ['notices', 'counts', 'calendar']
  if (DEADLINE_EVENTS.has(change.type)) return ['calendar', 'counts']
  if (SOURCE_PREFIXES.some((prefix) => change.type.startsWith(prefix))) return ['calendar', 'counts']
  return []
}

// ---- the address ------------------------------------------------------------------------------------------------------------

/** The page's four reads, each loading and failing on its own. */
export type PageSection = 'counts' | 'calendar' | 'organisation' | 'notices'

export type CalendarMode = 'month' | 'list'
export type CalendarTile = 'overdue' | 'dueSoon'
export const TILES = ['overdue', 'dueSoon', 'roles', 'rls'] as const
export type TileId = (typeof TILES)[number]

/**
 * `?view=month|list&month=YYYY-MM&day=&tile=overdue|dueSoon&from=&to=&ended=1&open=<item key>&new=1&appoint=new|<id>
 * &role=<ROLE>&at=<site id>&filing=<notice id>` — a tile is a filter of the List (the export reads `tile`, `from`, `to`).
 */
export interface CalendarAddress {
  view: CalendarMode
  month: string | null
  day: string | null
  tile: CalendarTile | null
  from: string | null
  to: string | null
  ended: boolean
  /** An item key (`DEADLINE:<id>`) whose window is open. */
  open: string | null
  /** Add deadline open. */
  newDeadline: boolean
  /** The Appointment dialog: `new` or an appointment id. */
  appoint: string | null
  /** A new appointment's role (from "Nobody holds …"). */
  role: SafetyRole | null
  /** A new appointment's site (from "Nobody holds …"). */
  at: string | null
  /** Record RLS notice: the notice's id. */
  filing: string | null
}

export const EMPTY_ADDRESS: CalendarAddress = Object.freeze({ view: 'month', month: null, day: null, tile: null, from: null, to: null, ended: false, open: null, newDeadline: false, appoint: null, role: null, at: null, filing: null }) as CalendarAddress

const isRole = (value: unknown): value is SafetyRole => typeof value === 'string' && (SAFETY_ROLES as readonly string[]).includes(value)

export function calendarAddressOf(params: Pick<URLSearchParams, 'get'> | null): CalendarAddress {
  const get = (name: string) => params?.get(name) ?? null
  const tile = get('tile')
  const month = get('month')
  const day = get('day')
  const from = get('from')
  const to = get('to')
  const role = get('role')
  const appoint = get('appoint')
  const asTile = tile === 'overdue' || tile === 'dueSoon' ? tile : null
  return {
    view: get('view') === 'list' || asTile ? 'list' : 'month',
    month: isIsoMonth(month) ? month : null,
    day: isIsoDay(day) ? day : null,
    tile: asTile,
    from: isIsoDay(from) ? from : null,
    to: isIsoDay(to) ? to : null,
    ended: get('ended') === '1',
    open: get('open') || null,
    newDeadline: get('new') === '1',
    appoint: appoint || null,
    role: appoint === 'new' && isRole(role) ? role : null,
    at: appoint === 'new' ? get('at') || null : null,
    filing: get('filing') || null,
  }
}

export function calendarAddressText(address: CalendarAddress): string {
  const query = new URLSearchParams()
  if (address.view === 'list' && !address.tile) query.set('view', 'list')
  if (address.month) query.set('month', address.month)
  if (address.day) query.set('day', address.day)
  if (address.tile) query.set('tile', address.tile)
  if (address.from) query.set('from', address.from)
  if (address.to) query.set('to', address.to)
  if (address.ended) query.set('ended', '1')
  if (address.open) query.set('open', address.open)
  if (address.newDeadline) query.set('new', '1')
  if (address.appoint) query.set('appoint', address.appoint)
  if (address.appoint === 'new' && address.role) query.set('role', address.role)
  if (address.appoint === 'new' && address.at) query.set('at', address.at)
  if (address.filing) query.set('filing', address.filing)
  const text = query.toString()
  return text ? `?${text}` : ''
}

/** The address with a change; closing one dialog never closes the page's filters. */
export const withAddress = (address: CalendarAddress, change: Partial<CalendarAddress>): CalendarAddress => ({ ...address, ...change })

// ---- the read windows -------------------------------------------------------------------------------------------------------

/** Today in the site's zone (Europe/Rome), before the API says its own. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** The Month view reads the month shown and the one each side (a move of a month is drawn at once). */
export function monthWindow(month: string): { from: string; to: string } {
  return { from: monthBounds(moveMonth(month, -1)).first, to: monthBounds(moveMonth(month, 1)).last }
}

/** The List reads 35 days back to a year on (400 days, the API's longest window), or the address's own `from` / `to`. */
export const LIST_BACK_DAYS = 35
export const LIST_AHEAD_DAYS = 365

export function listWindow(today: string, address: Pick<CalendarAddress, 'from' | 'to'>): { from: string; to: string } {
  if (address.from && address.to && address.from <= address.to && daysBetween(address.from, address.to) <= CALENDAR_WINDOW_MAX_DAYS) return { from: address.from, to: address.to }
  return { from: addDays(today, -LIST_BACK_DAYS), to: addDays(today, LIST_AHEAD_DAYS) }
}

/** The calendar print: this month and the next 11, or the address's `from` / `to` (at most 400 days). */
export function printWindow(today: string, address: Pick<CalendarAddress, 'from' | 'to'>): { from: string; to: string } {
  if (address.from && address.to && address.from <= address.to && daysBetween(address.from, address.to) <= CALENDAR_WINDOW_MAX_DAYS) return { from: address.from, to: address.to }
  const month = today.slice(0, 7)
  return { from: monthBounds(month).first, to: monthBounds(moveMonth(month, 11)).last }
}

// ---- an item in words -------------------------------------------------------------------------------------------------------

/** A message key and its params; `sub` names params that are message keys themselves (said first, then filled in). */
export interface Words {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
  readonly sub?: Readonly<Record<string, string>>
}

const KNOWN = new Set<string>(KNOWN_CALENDAR_KINDS)
const value = (params: Readonly<Record<string, string>>, name: string): string => {
  const text = params[name]?.trim()
  return text ? text : '—'
}
const roleKey = (role: string | undefined): string => (isRole(role) ? `role.${role}` : 'role.unknown')
const kindKey = (kind: string | undefined): string => (kind && (DEADLINE_KINDS as readonly string[]).includes(kind) ? `deadlineKind.${kind}` : 'deadlineKind.OTHER')

/**
 * The item's sentence from its kind and data words (the API's params): a deadline's title and type, a course and how many
 * people, a check type and the machine, an incident's number, a role and its holder. A health visit is a count, never a
 * name. A kind a later step adds still reads: "Deadline" with its title when it has one (never a raw code).
 */
export function itemWords(item: Pick<CalendarItem, 'kind' | 'params' | 'count'>, locale: 'it' | 'en'): Words {
  const p = item.params
  const count = item.count ?? 1
  switch (KNOWN.has(item.kind) ? item.kind : 'OTHER') {
    case 'DEADLINE':
      return { key: 'item.DEADLINE', params: { title: value(p, 'title') }, sub: { type: kindKey(p.kind) } }
    case 'DVR_REVIEW':
      return p.assessment?.trim() ? { key: 'item.DVR_REVIEW', params: { assessment: value(p, 'assessment') } } : { key: 'item.DVR_REVIEW_plain' }
    case 'TRAINING_REFRESHER':
      return { key: 'item.TRAINING_REFRESHER', params: { course: value(p, 'course'), count } }
    case 'RLS_TRAINING':
      return { key: 'item.RLS_TRAINING', params: { course: value(p, 'course'), count } }
    case 'HEALTH_VISIT':
      return { key: 'item.HEALTH_VISIT', params: { count } }
    case 'MACHINE_CHECK': {
      const check = (locale === 'it' ? p.checkIt || p.checkEn : p.checkEn || p.checkIt)?.trim() || '—'
      const machine = [p.asset, p.machine].map((part) => part?.trim()).filter(Boolean).join(' ') || '—'
      return { key: 'item.MACHINE_CHECK', params: { check, machine } }
    }
    case 'INAIL_REPORT':
      return { key: 'item.INAIL_REPORT', params: { incident: value(p, 'incident'), count } }
    case 'APPOINTMENT_END':
      return { key: 'item.APPOINTMENT_END', params: { person: value(p, 'person') }, sub: { role: roleKey(p.role) } }
    case 'RLS_NOTICE':
      return { key: 'item.RLS_NOTICE', params: { person: value(p, 'person') }, sub: { role: roleKey(p.role) } }
    default:
      return p.title?.trim() ? { key: 'item.other', params: { title: value(p, 'title') } } : { key: 'item.otherPlain' }
  }
}

/** Words → text with a translator (the `sub` keys first). */
export function sayWords(t: (key: string, params?: Record<string, string | number>) => string, words: Words): string {
  const sub = words.sub ? Object.fromEntries(Object.entries(words.sub).map(([name, key]) => [name, t(key)])) : {}
  return t(words.key, { ...(words.params ?? {}), ...sub })
}

/** A source that could not be read, in words ("Machine checks could not be read"); never drawn as nothing due. */
export const failedKey = (kind: string): string => (KNOWN.has(kind) ? `failed.${kind}` : 'failed.other')

/** The evidence of an item in words: asked and on file, asked and missing, not asked, or kept on its own page. */
export function evidenceKey(evidence: CalendarItem['evidence']): string {
  if (!evidence) return 'evidence.source'
  if (evidence.onFile) return 'evidence.onFile'
  return evidence.required ? 'evidence.missing' : 'evidence.notAsked'
}

// ---- where an item is kept --------------------------------------------------------------------------------------------------

/** Design page id → its Office address (opened only when built: OFFICE_PAGES). */
export const SOURCE_PAGES: Readonly<Record<string, string>> = Object.freeze({
  'plant.preventive': '/plant/preventive',
  'plant.risk': '/plant/risk',
  'plant.health': '/plant/health',
  'plant.incidents': '/plant/incidents',
  'people.skills': '/people/skills',
  'plant.calendar': '/plant/calendar',
})

export type OpenTarget =
  | { readonly kind: 'deadline'; readonly id: string }
  | { readonly kind: 'appointment'; readonly id: string }
  | { readonly kind: 'filing'; readonly id: string }
  | { readonly kind: 'link'; readonly href: string; readonly page: string }
  | { readonly kind: 'kept'; readonly page: string | null; readonly parentHref: string | null; readonly parentType: string | null }

const HERE: Readonly<Record<string, OpenTarget['kind']>> = { DEADLINE: 'deadline', SafetyDeadline: 'deadline', APPOINTMENT_END: 'appointment', SafetyAppointment: 'appointment', RLS_NOTICE: 'filing', RlsNotice: 'filing' }

/**
 * What Enter on an item does: a deadline typed here, an appointment ending or an RLS notice opens in place; an item of a
 * built page opens there (its record when that record has a page); else it says where it is kept, with a link to the
 * record it belongs to when that one has a page (a check plan's machine).
 */
export function openTargetOf(item: Pick<CalendarItem, 'kind' | 'recordId' | 'recordType' | 'source'>, built: ReadonlySet<string>): OpenTarget {
  const here = HERE[item.kind] ?? (item.source.page === 'plant.calendar' && item.source.recordType ? HERE[item.source.recordType] : undefined)
  const hereId = item.source.page === 'plant.calendar' && item.source.recordId ? item.source.recordId : item.recordId
  if (here && hereId && (here === 'deadline' || here === 'appointment' || here === 'filing')) return { kind: here, id: hereId }
  const page = item.source.page
  const address = page ? SOURCE_PAGES[page] : undefined
  if (page && address && built.has(address)) {
    const { recordType, recordId } = item.source
    const href = recordType && recordId && hasRecordPage(recordType, built) ? recordAddress({ type: recordType, id: recordId }, built) : address
    return { kind: 'link', href, page }
  }
  const { parentType, parentId } = item.source
  const parentHref = parentType && parentId && hasRecordPage(parentType, built) ? recordAddress({ type: parentType, id: parentId }, built) : null
  return { kind: 'kept', page, parentHref, parentType: parentHref ? parentType : null }
}

/** The page's name for "Kept on …" (a design page id the catalogue names, else "its own page"). */
export const pageKey = (page: string | null): string => (page && page in SOURCE_PAGES ? `page.${page}` : 'page.other')

/** The parent record's name for its link ("Open the machine"). */
export const parentKey = (type: string | null): string => (type === 'Machine' || type === 'Incident' || type === 'Employee' ? `parent.${type}` : 'parent.other')

// ---- the list ---------------------------------------------------------------------------------------------------------------

/** The List's rows: the tile's state (if any), by due day, then worst first. */
export function listRows(items: readonly CalendarItem[], tile: CalendarTile | null): CalendarItem[] {
  const state: ItemState | null = tile === 'overdue' ? 'OVERDUE' : tile === 'dueSoon' ? 'DUE_SOON' : null
  return items.filter((item) => !state || item.state === state).sort((a, b) => a.dueOn.localeCompare(b.dueOn) || stateRank(a.state) - stateRank(b.state) || a.key.localeCompare(b.key))
}

const OPEN_STATES = new Set<ItemState>(['OVERDUE', 'DUE_SOON', 'PLANNED', 'TO_CONFIRM'])

/** Why a row may not be selected for Mark done (null: it may): only an open deadline typed here that this person keeps. */
export function itemSelectHeld(item: Pick<CalendarItem, 'kind' | 'editable' | 'state'>): string | null {
  if (item.kind !== 'DEADLINE') return 'held.select.source'
  if (!OPEN_STATES.has(item.state)) return 'held.select.closed'
  if (!item.editable) return 'held.select.notYours'
  return null
}

/** A row Mark done N refuses before any call: evidence asked and not on file (it stays, said in words). */
export const doneRefusedFirst = (item: Pick<CalendarItem, 'evidence'>): boolean => !!item.evidence?.required && !item.evidence.onFile

/** The calendar print: the items by month (an open item from before the window under its own month), each by due day. */
export function monthGroups(items: readonly CalendarItem[]): { month: string; items: CalendarItem[] }[] {
  const groups = new Map<string, CalendarItem[]>()
  for (const item of listRows(items, null)) {
    const month = item.dueOn.slice(0, 7)
    groups.set(month, [...(groups.get(month) ?? []), item])
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, list]) => ({ month, items: list }))
}

// ---- the tiles --------------------------------------------------------------------------------------------------------------

export interface TileValue {
  readonly id: TileId
  readonly value: number | null
}

export function tilesOf(counts: CountsAnswer | null): TileValue[] {
  return [
    { id: 'overdue', value: counts?.overdue ?? null },
    { id: 'dueSoon', value: counts?.dueSoon ?? null },
    { id: 'roles', value: counts?.rolesWithoutPerson ?? null },
    { id: 'rls', value: counts?.rlsPending ?? null },
  ]
}

// ---- the organisation -------------------------------------------------------------------------------------------------------

/** The training of a role's holder in words (from People › Skills). */
export function trainingWords(training: Appointment['training']): Words {
  switch (training.state) {
    case 'VALID':
      return training.validUntil ? { key: 'training.valid', params: { date: training.validUntil } } : { key: 'training.validOpen' }
    case 'EXPIRED':
      return training.validUntil ? { key: 'training.expired', params: { date: training.validUntil } } : { key: 'training.expiredPlain' }
    case 'NONE':
      return { key: 'training.none' }
    default:
      return { key: 'training.notTracked' }
  }
}

/** Why a term may not be selected for End term (null: it may). */
export function appointmentSelectHeld(row: Pick<Appointment, 'canManage' | 'inForce' | 'ended' | 'untilDate'>, today: string): string | null {
  if (!row.canManage) return 'held.select.organisation'
  if (row.ended || (row.untilDate !== null && row.untilDate < today)) return 'held.select.ended'
  if (!row.inForce) return 'held.select.later'
  return null
}

/** "Nobody holds: RSPP (Officina Demo), First aid (Plant N)": each slot with its place's name. */
export function missingPlaces(missing: readonly MissingRole[], companies: readonly OrgPlace[]): { key: string; role: SafetyRole; companyId: string; siteId: string | null; place: string }[] {
  return missing
    .map((slot) => {
      const company = companies.find((entry) => entry.id === slot.companyId)
      const site = slot.siteId ? company?.sites.find((entry) => entry.id === slot.siteId) : null
      return { key: `${slot.companyId}:${slot.siteId ?? '-'}:${slot.role}`, role: slot.role, companyId: slot.companyId, siteId: slot.siteId, place: site?.name ?? company?.name ?? '—' }
    })
    .sort((a, b) => SAFETY_ROLES.indexOf(a.role) - SAFETY_ROLES.indexOf(b.role) || a.place.localeCompare(b.place))
}

/** The organisation chart print: per company, per site (the whole company first), the roles in their order. */
export function chartGroups(appointments: readonly Appointment[], today: string): { key: string; company: string; site: string | null; rows: Appointment[] }[] {
  const live = appointments.filter((row) => !row.ended && (row.untilDate === null || row.untilDate >= today) && row.fromDate <= today)
  const groups = new Map<string, { key: string; company: string; site: string | null; rows: Appointment[] }>()
  for (const row of live) {
    const key = `${row.company.code}|${row.site?.code ?? ''}`
    const group = groups.get(key) ?? { key, company: row.company.name, site: row.site?.name ?? null, rows: [] }
    group.rows.push(row)
    groups.set(key, group)
  }
  for (const group of groups.values()) group.rows.sort((a, b) => SAFETY_ROLES.indexOf(a.role) - SAFETY_ROLES.indexOf(b.role) || a.appointee.name.localeCompare(b.appointee.name))
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key))
}

// ---- the RLS notices --------------------------------------------------------------------------------------------------------

export const FILED_SHOWN = 10

/** Pending first (soonest due first), then the last 10 filed (newest first). */
export function noticeLists(notices: readonly RlsNotice[]): { pending: RlsNotice[]; filed: RlsNotice[] } {
  return {
    pending: notices.filter((notice) => notice.status === 'PENDING').sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.id.localeCompare(b.id)),
    filed: notices
      .filter((notice) => notice.status === 'FILED')
      .sort((a, b) => (b.filedOn ?? '').localeCompare(a.filedOn ?? '') || a.id.localeCompare(b.id))
      .slice(0, FILED_SHOWN),
  }
}

/** A pending notice's due day is the first day unless someone confirmed another: said "to confirm", never late. */
export const noticeToConfirm = (notice: Pick<RlsNotice, 'status' | 'dueOn' | 'appointedFrom'>): boolean => notice.status === 'PENDING' && notice.dueOn === notice.appointedFrom

// ---- Add deadline and Edit --------------------------------------------------------------------------------------------------

export type RepeatChoice = 'none' | RepeatUnit

export interface DeadlineDraft {
  title: string
  kind: DeadlineKind
  dueOn: string
  repeat: RepeatChoice
  every: string
  ownerId: string
  evidenceRequired: boolean
}

export const EMPTY_DEADLINE: DeadlineDraft = Object.freeze({ title: '', kind: 'DRILL', dueOn: '', repeat: 'none', every: '1', ownerId: '', evidenceRequired: false }) as DeadlineDraft

export function draftOfDeadline(deadline: Deadline): DeadlineDraft {
  return { title: deadline.title, kind: deadline.kind, dueOn: deadline.dueOn, repeat: deadline.repeatUnit ?? 'none', every: String(deadline.repeatEvery ?? 1), ownerId: deadline.ownerId ?? '', evidenceRequired: deadline.evidenceRequired }
}

const everyOf = (draft: DeadlineDraft): number | null => {
  if (draft.repeat === 'none') return null
  const n = Number(draft.every)
  return Number.isInteger(n) ? n : NaN
}

/** Why Add deadline / Save is held (a message key), or null. */
export function deadlineHeld(draft: DeadlineDraft, busy = false): string | null {
  if (busy) return 'held.saving'
  if (!draft.title.trim()) return 'held.title'
  if (draft.title.trim().length > DEADLINE_LIMITS.title) return 'held.titleLong'
  if (!isIsoDay(draft.dueOn)) return 'held.due'
  const every = everyOf(draft)
  if (every !== null && (!Number.isInteger(every) || every < DEADLINE_LIMITS.repeatMin || every > DEADLINE_LIMITS.repeatMax)) return 'held.every'
  return null
}

/** POST /safety/deadlines: the company of the page, the top bar's site (null: the whole company). */
export function deadlineBody(draft: DeadlineDraft, companyId: string, siteId: string | null): NewDeadlineBody {
  const every = everyOf(draft)
  return {
    companyId,
    siteId,
    title: draft.title.trim(),
    kind: draft.kind,
    dueOn: draft.dueOn,
    repeatEvery: every,
    repeatUnit: draft.repeat === 'none' ? null : draft.repeat,
    ownerId: draft.ownerId || null,
    evidenceRequired: draft.evidenceRequired,
  }
}

/** PATCH: only what changed, at the version read; null when nothing changed. */
export function deadlineEdit(deadline: Deadline, draft: DeadlineDraft): DeadlineEdit | null {
  const body = deadlineBody(draft, deadline.companyId, deadline.siteId)
  const edit: DeadlineEdit = { version: deadline.version }
  if (body.title !== deadline.title) edit.title = body.title
  if (body.dueOn !== deadline.dueOn) edit.dueOn = body.dueOn
  if (body.repeatEvery !== deadline.repeatEvery || body.repeatUnit !== deadline.repeatUnit) {
    edit.repeatEvery = body.repeatEvery
    edit.repeatUnit = body.repeatUnit
  }
  if (body.ownerId !== deadline.ownerId) edit.ownerId = body.ownerId
  if (body.evidenceRequired !== deadline.evidenceRequired) edit.evidenceRequired = body.evidenceRequired
  return Object.keys(edit).length > 1 ? edit : null
}

/** Why Mark done is held on a deadline (null: it may be). */
export function doneHeld(deadline: Pick<Deadline, 'status' | 'evidenceRequired' | 'evidence' | 'canManage'>, busy = false): string | null {
  if (!deadline.canManage) return 'held.calendar'
  if (busy) return 'held.saving'
  if (deadline.status !== 'OPEN') return deadline.status === 'DONE' ? 'held.doneAlready' : 'held.cancelledAlready'
  if (deadline.evidenceRequired && deadline.evidence.length === 0) return 'held.evidenceFirst'
  return null
}

/** The repeat in words. */
export function repeatWords(every: number | null, unit: RepeatUnit | null): Words {
  if (!every || !unit) return { key: 'repeat.none' }
  return { key: `repeat.every.${unit}`, params: { count: every } }
}

// ---- the Appointment --------------------------------------------------------------------------------------------------------

export type Who = 'person' | 'outside'

export interface AppointmentDraft {
  role: SafetyRole | ''
  who: Who
  employeeId: string
  outsideName: string
  /** The party contact picked (`<partyId>|<contactId>`), or ''. */
  contact: string
  /** '' = the whole company. */
  siteId: string
  shiftId: string
  fromDate: string
  untilDate: string
  note: string
  /** An RLS or RLST: the notice to INAIL is due (default the first day, to confirm) or already filed. */
  notice: 'due' | 'filed'
  noticeDueOn: string
  filedOn: string
  reference: string
}

export const EMPTY_APPOINTMENT: AppointmentDraft = Object.freeze({ role: '', who: 'person', employeeId: '', outsideName: '', contact: '', siteId: '', shiftId: '', fromDate: '', untilDate: '', note: '', notice: 'due', noticeDueOn: '', filedOn: '', reference: '' }) as AppointmentDraft

/** A new appointment's draft: the role and the place "Nobody holds" named; an RLST is an outside contact. */
export function newAppointmentDraft(role: SafetyRole | null, siteId: string | null, today: string): AppointmentDraft {
  return { ...EMPTY_APPOINTMENT, role: role ?? '', who: role === 'RLST' ? 'outside' : 'person', siteId: siteId ?? '', fromDate: today }
}

export const isRlsRole = (role: SafetyRole | ''): boolean => role !== '' && RLS_ROLES.includes(role)
export const isTeamRole = (role: SafetyRole | ''): boolean => role !== '' && TEAM_ROLES.includes(role)

/** Why Save appointment is held (a message key), or null. */
export function appointmentHeld(draft: AppointmentDraft, today: string, busy = false): string | null {
  if (busy) return 'held.saving'
  if (!draft.role) return 'held.role'
  if (draft.role === 'RLS' && draft.who !== 'person') return 'refusal.RLS_IS_EMPLOYEE'
  if (draft.role === 'RLST' && draft.who !== 'outside') return 'refusal.RLST_IS_OUTSIDE'
  if (draft.who === 'person' && !draft.employeeId) return 'held.person'
  if (draft.who === 'outside' && !draft.outsideName.trim()) return 'held.outside'
  if (draft.who === 'outside' && draft.outsideName.trim().length > ORGANISATION_LIMITS.name) return 'held.nameLong'
  if (!isIsoDay(draft.fromDate)) return 'held.from'
  if (draft.untilDate && !isIsoDay(draft.untilDate)) return 'held.until'
  if (draft.untilDate && draft.untilDate < draft.fromDate) return 'refusal.ENDS_BEFORE_START'
  if (isRlsRole(draft.role) && draft.notice === 'filed') {
    if (!isIsoDay(draft.filedOn)) return 'held.filedOn'
    if (draft.filedOn > today) return 'refusal.FILED_IN_FUTURE'
    if (draft.filedOn < draft.fromDate) return 'refusal.FILED_BEFORE_APPOINTMENT'
    if (!draft.reference.trim()) return 'held.reference'
  }
  if (isRlsRole(draft.role) && draft.notice === 'due' && draft.noticeDueOn && !isIsoDay(draft.noticeDueOn)) return 'held.noticeDue'
  return null
}

/** POST /safety/appointments. */
export function appointmentBody(draft: AppointmentDraft, companyId: string): NewAppointmentBody {
  const role = draft.role as SafetyRole
  const [partyId, contactId] = draft.contact ? draft.contact.split('|') : []
  return {
    companyId,
    siteId: draft.siteId || null,
    role,
    ...(draft.who === 'person' ? { employeeId: draft.employeeId } : { outsideName: draft.outsideName.trim(), ...(partyId ? { outsidePartyId: partyId } : {}), ...(contactId ? { outsideContactId: contactId } : {}) }),
    ...(isTeamRole(role) && draft.shiftId ? { shiftPatternId: draft.shiftId } : {}),
    fromDate: draft.fromDate,
    ...(draft.untilDate ? { untilDate: draft.untilDate } : {}),
    ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
    ...(isRlsRole(role) ? (draft.notice === 'filed' ? { noticeFiled: { filedOn: draft.filedOn, reference: draft.reference.trim() } } : draft.noticeDueOn ? { noticeDueOn: draft.noticeDueOn } : {}) : {}),
  }
}

/** Why the appointee's signature cannot be recorded (a message key), or null. */
export function signHeld(row: Pick<Appointment, 'signature' | 'ended' | 'letter' | 'canManage'>, method: AppointmentSignMethod, busy = false): string | null {
  if (!row.canManage) return 'held.organisation'
  if (busy) return 'held.saving'
  if (row.signature) return 'refusal.SIGNED_ALREADY'
  if (row.ended) return 'refusal.ENDED'
  if (method === 'PAPER' && !row.letter) return 'refusal.LETTER_MISSING'
  return null
}

export interface EndDraft {
  untilDate: string
  reason: string
}

/** Why End term is held (a message key), or null. */
export function endHeld(draft: EndDraft, rows: readonly Pick<Appointment, 'fromDate'>[], busy = false): string | null {
  if (busy) return 'held.saving'
  if (!isIsoDay(draft.untilDate)) return 'held.untilDate'
  if (rows.some((row) => draft.untilDate < row.fromDate)) return 'refusal.ENDS_BEFORE_START'
  if (!draft.reason.trim()) return 'held.reason'
  if (draft.reason.trim().length > ORGANISATION_LIMITS.reason) return 'held.reasonLong'
  return null
}

// ---- Record RLS notice ------------------------------------------------------------------------------------------------------

export interface FilingDraft {
  filedOn: string
  reference: string
  dueOn: string
  cancelReason: string
}

export const filingDraftOf = (notice: Pick<RlsNotice, 'dueOn'>, today: string): FilingDraft => ({ filedOn: today, reference: '', dueOn: notice.dueOn, cancelReason: '' })

/** Why Record is held (a message key), or null. */
export function filingHeld(draft: FilingDraft, notice: Pick<RlsNotice, 'status' | 'appointedFrom' | 'canManage'>, today: string, busy = false): string | null {
  if (!notice.canManage) return 'held.organisation'
  if (busy) return 'held.saving'
  if (notice.status !== 'PENDING') return 'refusal.NOTICE_NOT_PENDING'
  if (!isIsoDay(draft.filedOn)) return 'held.filedOn'
  if (draft.filedOn > today) return 'refusal.FILED_IN_FUTURE'
  if (draft.filedOn < notice.appointedFrom) return 'refusal.FILED_BEFORE_APPOINTMENT'
  if (!draft.reference.trim()) return 'held.reference'
  if (draft.reference.trim().length > ORGANISATION_LIMITS.reference) return 'held.referenceLong'
  return null
}

// ---- the API's answers in our words -----------------------------------------------------------------------------------------

const REFUSALS = new Set<string>([...ORGANISATION_REFUSALS, ...DEADLINE_REFUSALS])

/** A failed call in our words: a refusal by its code, else the kind; `field` = the body field at fault (said at it). */
export interface Problem {
  readonly key: string
  readonly field: string | null
  /** No answer: whether it was done is not known (never said "saved"). */
  readonly unknown?: boolean
}

export function problemOf(error: unknown): Problem {
  if (!isApiError(error)) return { key: 'problem.unavailable', field: null, unknown: true }
  let refusal: string | null = null
  let field: string | null = null
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (path.startsWith('refusal/') && !refusal) {
      const code = path.slice('refusal/'.length)
      if (REFUSALS.has(code)) refusal = code
    } else if (/^body[./]/.test(path) && !field) {
      field = path.replace(/^body[./]/, '').split(/[./]/)[0] || null
    }
  }
  if (refusal) return { key: `refusal.${refusal}`, field }
  switch (error.kind) {
    case 'invalid':
      return { key: field ? 'problem.field' : 'problem.invalid', field }
    case 'signed_out':
      return { key: 'problem.signedOut', field: null }
    case 'forbidden':
      return { key: 'problem.forbidden', field: null }
    case 'step_up':
      return { key: 'problem.stepUp', field: null }
    case 'not_found':
      return { key: 'problem.notFound', field: null }
    case 'conflict':
      return { key: 'problem.conflict', field: null }
    case 'rate_limited':
      return { key: 'problem.rateLimited', field: null }
    case 'contract':
      return { key: 'problem.contract', field: null }
    case 'unavailable':
      return error.code === 'network' ? { key: 'problem.noAnswer', field: null, unknown: true } : { key: 'problem.unavailable', field: null }
    default:
      return { key: 'problem.internal', field: null }
  }
}

/** A read that failed, in words (a section says it and offers Try again; never drawn as empty). */
export const readProblemOf = (error: unknown): string => {
  const problem = problemOf(error)
  return problem.key.startsWith('refusal.') || problem.key === 'problem.unavailable' || problem.key === 'problem.noAnswer' || problem.key === 'problem.field' || problem.key === 'problem.invalid' ? 'problem.read' : problem.key
}

/** The problem's words at a field, when it names that field. */
export const atField = (problem: Problem | null, ...fields: readonly string[]): string | null => (problem && problem.field && fields.includes(problem.field) ? problem.key : null)
