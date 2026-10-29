import { GRAINS, type Loaded } from '../shared/model'
import { AUDIT_SURFACES, AUDIT_VIEWS, type AuditCounts, type AuditEntry, type AuditQuery, type AuditSurface, type AuditViewName } from './api'

/**
 * SCR-018 Audit log (design 02 admin.audit; PLT-072, PLT-073, PLT-077, PLT-084): every audited write the person may
 * read, newest first, as sentences for the Owner (Story) or one row per write (Table); saved views as tiles; filters
 * kept in the address (`?view=&who=&surface=&type=&record=&area=&company=&period=&mode=&open=`); one entry in a
 * centred DetailModal (`?open=<id>`, J / K) with every field before → after, its context and the other rows of the same
 * request. Pure: the container (AuditPage.tsx) reads, the view draws, the tests hold every rule.
 *
 * Words are message keys of `admin-audit` (`audit.*`). An action is said by its own words when this page knows it
 * (`audit.did.<action with _>`), else as "changed" (`audit.did.other`) with the action's code beside it in the table and
 * the entry: never the API's words, never a guess. A floor worker is never named in the log (Owner answer W1): "A worker on
 * <device>".
 */

export const AUDIT_MODES = ['story', 'table'] as const
export type AuditMode = (typeof AUDIT_MODES)[number]

/** The time windows offered (rolling, from now). */
export const AUDIT_PERIODS = ['any', '24h', '7d', '30d', '90d'] as const
export type AuditPeriod = (typeof AUDIT_PERIODS)[number]
const PERIOD_MS: Readonly<Record<Exclude<AuditPeriod, 'any'>, number>> = { '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5, '90d': 90 * 864e5 }

/** The tiles count the last 30 days (the same window for every tile, so the tiles and the list agree when chosen). */
export const TILE_PERIOD: AuditPeriod = '30d'

/** The areas of the action filter (an action's first part: `numbering` for `numbering.createSeries`). */
export const ACTION_AREAS = [
  'auth',
  'users',
  'roles',
  'workers',
  'devices',
  'org',
  'companies',
  'numbering',
  'email',
  'integration',
  'imports',
  'files',
  'threads',
  'print',
  'privacy',
  'parties',
  'quotes',
  'orders',
  'purchasing',
  'inventory',
  'production',
  'workorders',
  'shipping',
  'invoices',
  'payments',
  'quality',
  'product',
  'compliance',
  'planning',
  'costing',
  'sales',
  'links',
] as const
export type ActionArea = (typeof ACTION_AREAS)[number]

/** The record types of the record filter: those the Admin and the first documents write. */
export const RECORD_TYPES = [
  'Company',
  'Site',
  'Line',
  'WorkCentre',
  'Station',
  'User',
  'Role',
  'Device',
  'Worker',
  'NumberSeries',
  'EmailIdentity',
  'IntegrationAccount',
  'ImportJob',
  'Printer',
  'StoredFile',
  'Thread',
  'Party',
  'Quote',
  'SalesOrder',
  'PurchaseOrder',
  'WorkOrder',
  'Lot',
  'Shipment',
  'Ddt',
  'Invoice',
] as const

export interface AuditFilters {
  view: AuditViewName | null
  /** An office person (the Who filter offers people only to those who may see them: users.view). */
  actorId: string | null
  audience: AuditSurface | null
  recordType: string | null
  recordId: string | null
  area: ActionArea | null
  companyId: string | null
  period: AuditPeriod
}

export const NO_FILTERS: AuditFilters = { view: null, actorId: null, audience: null, recordType: null, recordId: null, area: null, companyId: null, period: 'any' }

const isOne = <T extends string>(list: readonly T[], value: string | null | undefined): value is T => typeof value === 'string' && (list as readonly string[]).includes(value)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TYPE = /^[A-Z][A-Za-z0-9]{0,63}$/

/** The filters, the mode and the open entry as the address holds them; anything malformed is left out. */
export function stateFromParams(params: { get(name: string): string | null } | null | undefined): { filters: AuditFilters; mode: AuditMode; open: string | null } {
  const get = (name: string) => params?.get(name) ?? null
  const id = (name: string) => {
    const value = get(name)
    return value && UUID.test(value) ? value : null
  }
  const view = get('view')
  const surface = get('surface')
  const area = get('area')
  const period = get('period')
  const mode = get('mode')
  const type = get('type')
  return {
    filters: {
      view: isOne(AUDIT_VIEWS, view) ? view : null,
      actorId: id('who'),
      audience: isOne(AUDIT_SURFACES, surface) ? surface : null,
      recordType: type && TYPE.test(type) ? type : null,
      recordId: id('record'),
      area: isOne(ACTION_AREAS, area) ? area : null,
      companyId: id('company'),
      period: isOne(AUDIT_PERIODS, period) ? period : 'any',
    },
    mode: isOne(AUDIT_MODES, mode) ? mode : 'story',
    open: id('open'),
  }
}

/** The address's query for these filters (the Story mode and "any time" are the defaults, left out). */
export function paramsOf(filters: AuditFilters, mode: AuditMode, open: string | null = null): string {
  const out = new URLSearchParams()
  if (filters.view) out.set('view', filters.view)
  if (filters.actorId) out.set('who', filters.actorId)
  if (filters.audience) out.set('surface', filters.audience)
  if (filters.recordType) out.set('type', filters.recordType)
  if (filters.recordId) out.set('record', filters.recordId)
  if (filters.area) out.set('area', filters.area)
  if (filters.companyId) out.set('company', filters.companyId)
  if (filters.period !== 'any') out.set('period', filters.period)
  if (mode !== 'story') out.set('mode', mode)
  if (open) out.set('open', open)
  return out.toString()
}

/** `path?query` (no `?` when there is nothing to say). */
export const withQuery = (path: string, query: string) => (query ? `${path}?${query}` : path)

/** Where a window starts, from now (null: any time). */
export function periodFrom(period: AuditPeriod, now: Date): string | null {
  return period === 'any' ? null : new Date(now.getTime() - PERIOD_MS[period]).toISOString()
}

/** The API query for the filters. */
export function queryOf(filters: AuditFilters, now: Date): AuditQuery {
  return {
    view: filters.view,
    actorId: filters.actorId,
    audience: filters.audience,
    recordType: filters.recordType,
    recordId: filters.recordId,
    action: filters.area ? `${filters.area}.` : null,
    companyId: filters.companyId,
    from: periodFrom(filters.period, now),
  }
}

/** How many filters narrow the log (the saved view counts as one). */
export function filterCount(filters: AuditFilters): number {
  return [filters.view, filters.actorId, filters.audience, filters.recordType ?? filters.recordId, filters.area, filters.companyId, filters.period === 'any' ? null : filters.period].filter((value) => value !== null).length
}

// ---- words --------------------------------------------------------------------------------------------------------------

export interface Words {
  key: string
  params?: Readonly<Record<string, string | number>>
}

/** Who did it, in words: the office person's name; a floor worker NEVER by name (Owner answer W1). */
export function whoOf(entry: Pick<AuditEntry, 'audience' | 'actorName' | 'deviceName'>): Words {
  switch (entry.audience) {
    case 'OFFICE':
      return entry.actorName ? { key: 'audit.who.person', params: { name: entry.actorName } } : { key: 'audit.who.officeUnknown' }
    case 'FLOOR':
      return entry.deviceName ? { key: 'audit.who.floorOn', params: { device: entry.deviceName } } : { key: 'audit.who.floor' }
    case 'PARTNER':
      return { key: 'audit.who.partner' }
    case 'LINK':
      return { key: 'audit.who.link' }
    default:
      return { key: 'audit.who.system' }
  }
}

/** The action's area (its first part), when this page knows it. */
export function areaOf(action: string): ActionArea | null {
  const first = action.split('.')[0] ?? ''
  return isOne(ACTION_AREAS, first) ? first : null
}

/** The key of what was done (`audit.did.<action with _>`); the view falls back to "changed" when it has no words. */
export function didKey(action: string): string {
  return `audit.did.${action.replace(/[^A-Za-z0-9]+/g, '_')}`
}

/** A record type in words (`audit.type.<Type>`), else the type itself. */
export const typeKey = (recordType: string) => `audit.type.${recordType}`

/** The record's own name or number as the write recorded it (never a floor worker's name: W1). */
export function recordLabel(entry: Pick<AuditEntry, 'recordType' | 'before' | 'after'>): string | null {
  if (entry.recordType === 'Worker') return null
  const fields = ['number', 'formatted', 'code', 'name', 'legalName', 'label', 'domain', 'displayName', 'email', 'key', 'originalName']
  for (const side of [entry.after, entry.before]) {
    if (!side || typeof side !== 'object' || Array.isArray(side)) continue
    for (const field of fields) {
      const value = (side as Record<string, unknown>)[field]
      if (typeof value === 'string' && value.trim() !== '') return value.length > 60 ? `${value.slice(0, 59)}…` : value
      if (typeof value === 'number') return String(value)
    }
  }
  return null
}

/** The record's page, for the types the Office has a page for. */
export function recordHref(prefix: string, entry: Pick<AuditEntry, 'recordType' | 'recordId' | 'companyId'>): string | null {
  const id = encodeURIComponent(entry.recordId)
  switch (entry.recordType) {
    case 'Company':
      return `${prefix}/admin/companies/${id}`
    case 'Site':
      return entry.companyId ? `${prefix}/admin/companies/${encodeURIComponent(entry.companyId)}/sites/${id}` : null
    case 'User':
      return `${prefix}/admin/users/${id}`
    case 'Role':
      return `${prefix}/admin/roles/${id}`
    case 'Device':
      return `${prefix}/admin/devices/${id}`
    case 'Worker':
      return `${prefix}/admin/users/floor/${id}`
    case 'NumberSeries':
      return `${prefix}/admin/documents?series=${id}`
    case 'IntegrationAccount':
      return `${prefix}/admin/connections/${id}`
    default:
      return null
  }
}

/** A short form of an id, for a record the page cannot name ("…3f9a12"). */
export const shortId = (id: string) => `…${id.replace(/-/g, '').slice(-6)}`

/** Company › site in words (the names the page read), or null when unknown. */
export function whereOf(entry: Pick<AuditEntry, 'companyId' | 'siteId'>, companies: AuditViewModel['companies']): string | null {
  if (!entry.companyId) return null
  const company = companies.find((item) => item.id === entry.companyId)
  if (!company) return null
  const site = entry.siteId ? company.sites.find((item) => item.id === entry.siteId) : null
  return site ? `${company.name} › ${site.name}` : company.name
}

// ---- before → after -----------------------------------------------------------------------------------------------------

export interface ChangeRow {
  field: string
  /** Display text; null: the field was not there on that side (unknown is "—" on screen). */
  from: string | null
  to: string | null
  changed: boolean
}

/** A recorded value as text: scalars as written, lists joined, objects as compact JSON (cut at 120 characters). */
export function valueText(value: unknown): string | null {
  if (value === undefined) return null
  if (value === null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value) && value.every((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item))) return value.map((item) => (item === null ? '—' : String(item))).join(', ')
  const json = JSON.stringify(value)
  return json.length > 120 ? `${json.slice(0, 119)}…` : json
}

const objectOf = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

/** Every field of the write, before → after, in the order recorded (after's fields first); changed ones marked. */
export function changeRows(before: unknown, after: unknown): ChangeRow[] {
  const from = objectOf(before)
  const to = objectOf(after)
  const fields = [...new Set([...Object.keys(to), ...Object.keys(from)])]
  return fields.map((field) => {
    const a = valueText(from[field])
    const b = valueText(to[field])
    return { field, from: a, to: b, changed: JSON.stringify(from[field] ?? null) !== JSON.stringify(to[field] ?? null) }
  })
}

/** The changed fields only (the table's "What changed" shows the first two, then "+ N more"). */
export const changedRows = (before: unknown, after: unknown) => changeRows(before, after).filter((row) => row.changed)

/** A field in words (`audit.field.<name>`), else its name split into words ("startValue" → "start value"). */
export const fieldKey = (field: string) => `audit.field.${field.replace(/[^A-Za-z0-9]+/g, '_')}`
export const fieldWords = (field: string) =>
  field
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.]+/g, ' ')
    .toLowerCase()
    .trim()

/** The money grains the person does not hold (permissions `money.<grain>`): their values are left out of the log. */
export function hiddenGrains(permissions: readonly string[]): string[] {
  const held = new Set(permissions)
  return GRAINS.filter((grain) => !held.has(`money.${grain}`))
}

/** The device recorded its own time, and it differs from the server's by a second or more. */
export function deviceTimeDiffers(entry: Pick<AuditEntry, 'at' | 'deviceTime'>): boolean {
  if (!entry.deviceTime) return false
  return Math.abs(new Date(entry.deviceTime).getTime() - new Date(entry.at).getTime()) >= 1000
}

/** Rows that match the "find on this page" words (who, action, record, reason). */
export function findOnPage(entries: readonly AuditEntry[], find: string, words: (entry: AuditEntry) => string): AuditEntry[] {
  const needle = find
    .trim()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
  if (needle === '') return [...entries]
  return entries.filter((entry) =>
    words(entry)
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .includes(needle),
  )
}

// ---- the view model -----------------------------------------------------------------------------------------------------

export interface AuditOpen {
  id: string
  /** Null: not among the rows read (the API reads no single entry yet). */
  entry: AuditEntry | null
  /** The other rows the same request wrote. */
  siblings: Loaded<AuditEntry>
}

export interface AuditViewModel {
  /** `/w/<company>`. */
  prefix: string
  mode: AuditMode
  filters: AuditFilters
  entries: Loaded<AuditEntry>
  /** More, older rows exist ("Show older"). */
  nextBefore: string | null
  older?: { loading: boolean; problem: string | null }
  /** The saved views' counts over the last 30 days; null while unknown ("—"). */
  counts: AuditCounts | null
  asOf: string | null
  /** The office people for the Who filter; null: not offered (the person may not see people: users.view). */
  people: ReadonlyArray<{ id: string; name: string }> | null
  /** The companies and sites the person may see, for "Where" and the company filter. */
  companies: ReadonlyArray<{ id: string; name: string; sites: ReadonlyArray<{ id: string; name: string }> }>
  /** The person may read the log (audit.read). */
  canRead: boolean
  /** The grains whose values are left out for this person. */
  hiddenGrains: readonly string[]
  /** Find on the rows shown (a page of 50 and the older pages loaded). */
  find: string
  open: AuditOpen | null
  /** The record the filters name, in words, when known (the "Record's history" chip). */
  recordWords?: string | null
}

/** The address of one entry on this page (filters kept). */
export const entryHref = (prefix: string, model: Pick<AuditViewModel, 'filters' | 'mode'>, id: string) => withQuery(`${prefix}/admin/audit`, paramsOf(model.filters, model.mode, id))

/** The log filtered to one record (its whole history), from an entry. */
export function recordHistoryFilters(entry: Pick<AuditEntry, 'recordType' | 'recordId'>): AuditFilters {
  return { ...NO_FILTERS, recordType: entry.recordType, recordId: entry.recordId }
}

/** Tiles in the design's order. */
export const TILES: readonly AuditViewName[] = AUDIT_VIEWS
