import { z } from 'zod'
import { SEGMENT_KINDS } from '@nexus/factory-domain/calendars/patterns'
import { CALENDAR_SCOPES, DAY_KINDS } from '@nexus/factory-domain/calendars/working-time'
import { BUCKET_KINDS } from '@nexus/factory-domain/planning/settings/buckets'
import { ITEM_PLANNING_METHODS, ITEM_PLANNING_SOURCES } from '@nexus/factory-domain/planning/settings/items'
import type { ApiClient } from '../../../lib/api/client'

/**
 * Every call of Planning › Planning settings (SCR-124 Calendars & shifts, SCR-127 Item planning settings) and of Admin ›
 * Company › Calendars (SCR-008): the calendars and shift patterns of B-W2a-08 (apps/factory-api platform/calendars), the
 * planning settings, item parameters, reorder rules and lanes of B-W2a-16 (modules/planning/settings), the capacity a
 * closure takes away (modules/planning/capacity) and an item's approved suppliers (modules/purchasing/supplier-items).
 * Each answer's shape is checked (zod; unknown fields are dropped, so a new API field never breaks the page); the enum
 * lists are factory-domain's own. The API's English (a pattern's `summary`, capacity `words`, a 409's message) is never
 * drawn: the screens say their own words from the numbers and codes. No money and no person anywhere: efficiency and
 * people are per line or work centre (Statuto dei Lavoratori art. 4).
 */

const seg = (value: string) => encodeURIComponent(value)
const named = z.object({ id: z.string(), code: z.string(), name: z.string() })

// ---- calendars ------------------------------------------------------------------------------------------------------

export const calendarScope = z.enum(CALENDAR_SCOPES)
export type CalendarScope = z.infer<typeof calendarScope>
export const dayKind = z.enum(DAY_KINDS)
export type DayKind = z.infer<typeof dayKind>
const status = z.enum(['ACTIVE', 'ARCHIVED'])

const patternRef = z.object({ id: z.string(), code: z.string(), name: z.string(), status })
export type PatternRef = z.infer<typeof patternRef>

const calendarSchema = z.object({
  id: z.string(),
  scope: calendarScope,
  companyId: z.string().nullable(),
  siteId: z.string().nullable(),
  lineId: z.string().nullable(),
  workCentreId: z.string().nullable(),
  partyId: z.string().nullable(),
  owner: z.object({ code: z.string(), name: z.string() }),
  name: z.string(),
  workingWeekdays: z.array(z.number()),
  shiftPattern: patternRef.nullable(),
  status,
  exceptions: z.number(),
  version: z.number(),
  updatedAt: z.string(),
})
export type Calendar = z.infer<typeof calendarSchema>

const daySchema = z.object({
  id: z.string(),
  date: z.string(),
  kind: dayKind,
  name: z.string(),
  shiftPattern: patternRef.nullable(),
  note: z.string().nullable(),
  /** `IT`: loaded from the national list; null: set by a person. */
  holidaySet: z.string().nullable(),
  version: z.number(),
  updatedAt: z.string(),
})
export type CalendarDayRow = z.infer<typeof daySchema>

const calendarDetailSchema = z.object({ calendar: calendarSchema, above: z.array(calendarSchema), from: z.string(), to: z.string(), days: z.array(daySchema) })
export type CalendarDetail = z.infer<typeof calendarDetailSchema>

/** The calendars the person may see (`companyId`: the company's, its sites', lines' and workshops'; suppliers' too). */
export const listCalendars = async (api: ApiClient, query: { companyId?: string; siteId?: string; scope?: CalendarScope }, signal?: AbortSignal) =>
  (await api.get('/calendars', { query, schema: z.object({ calendars: z.array(calendarSchema) }), signal })).calendars

/** One calendar with its own dated days between `from` and `to` (≤ 733 days) and the ACTIVE calendars above it. */
export const getCalendar = (api: ApiClient, calendarId: string, range: { from: string; to: string }, signal?: AbortSignal) =>
  api.get(`/calendars/${seg(calendarId)}`, { query: range, schema: calendarDetailSchema, signal })

export interface NewCalendarBody {
  scope: CalendarScope
  ownerId: string
  name?: string
  workingWeekdays?: number[]
  shiftPatternId?: string | null
}
/** calendars.manage (a company's: over every site of the company): the owner's calendar (409 when it has one). */
export const createCalendar = async (api: ApiClient, body: NewCalendarBody, idempotencyKey: string) =>
  (await api.post('/calendars', { body, schema: z.object({ calendar: calendarSchema }), idempotencyKey })).calendar

export interface EditCalendarBody {
  version: number
  name?: string
  workingWeekdays?: number[]
  shiftPatternId?: string | null
  reason?: string
}
export const editCalendar = async (api: ApiClient, calendarId: string, body: EditCalendarBody, idempotencyKey: string) =>
  (await api.request('PATCH', `/calendars/${seg(calendarId)}`, { body, schema: z.object({ calendar: calendarSchema }), idempotencyKey })).calendar

/** The calendar stops counting (its owner follows the calendars above again); its days are kept and read. */
export const archiveCalendar = async (api: ApiClient, calendarId: string, body: { version: number; reason?: string }, idempotencyKey: string) =>
  (await api.post(`/calendars/${seg(calendarId)}/archive`, { body, schema: z.object({ calendar: calendarSchema }), idempotencyKey })).calendar

export interface SetDaysBody {
  version?: number
  from: string
  to?: string
  kind: DayKind
  name: string
  shiftPatternId?: string | null
  note?: string | null
  replace?: boolean
}
const setDaysAnswer = z.object({ calendar: calendarSchema, days: z.array(daySchema), replaced: z.number() })
export type SetDaysAnswer = z.infer<typeof setDaysAnswer>
/** Holidays, closures or extra working days from `from` to `to`; a day already set → 409 (`body/days/<date>`) unless `replace`. */
export const setDays = (api: ApiClient, calendarId: string, body: SetDaysBody, idempotencyKey: string) =>
  api.post(`/calendars/${seg(calendarId)}/days`, { body, schema: setDaysAnswer, idempotencyKey })

/** Takes the dated days of a range back (the days then follow the week and the calendars above). */
export const removeDays = (api: ApiClient, calendarId: string, body: { version?: number; from: string; to?: string }, idempotencyKey: string) =>
  api.post(`/calendars/${seg(calendarId)}/days/remove`, { body, schema: z.object({ calendar: calendarSchema, removed: z.array(z.string()) }), idempotencyKey })

const holidaysAnswer = z.object({ calendar: calendarSchema, added: z.array(daySchema), skipped: z.array(z.object({ date: z.string(), name: z.string() })) })
export type HolidaysAnswer = z.infer<typeof holidaysAnswer>
/** The national public holidays of a year (Italy); dates the calendar already has are kept as they are. */
export const loadHolidays = (api: ApiClient, calendarId: string, body: { version?: number; year: number }, idempotencyKey: string) =>
  api.post(`/calendars/${seg(calendarId)}/holidays`, { body: { ...body, set: 'IT' }, schema: holidaysAnswer, idempotencyKey })

export interface OwnerRef {
  scope: Exclude<CalendarScope, 'SUPPLIER'>
  id: string
}
const ownerQueryOf = (owner: OwnerRef) =>
  owner.scope === 'COMPANY' ? { companyId: owner.id } : owner.scope === 'SITE' ? { siteId: owner.id } : owner.scope === 'LINE' ? { lineId: owner.id } : { workCentreId: owner.id }

const workingDaySchema = z.object({
  date: z.string(),
  weekday: z.number(),
  open: z.boolean(),
  working: z.boolean(),
  reason: z.enum(['WEEK', 'DAY_OFF', 'HOLIDAY', 'CLOSURE', 'WORKING']),
  name: z.string().nullable(),
  decidedBy: z.object({ calendarId: z.string(), scope: calendarScope }).nullable(),
  pattern: z.object({ id: z.string(), code: z.string(), name: z.string(), source: z.enum(['DAY', 'CALENDAR', 'DEFAULT']), calendarId: z.string().nullable() }).nullable(),
  minutes: z.number().nullable(),
  shifts: z.array(z.object({ label: z.string().nullable(), start: z.string(), end: z.string(), minutes: z.number() })),
  issue: z.enum(['NO_SHIFTS']).nullable(),
})
export type WorkingDay = z.infer<typeof workingDaySchema>
const workingTimeSchema = z.object({
  owner: z.object({
    scope: calendarScope,
    id: z.string(),
    code: z.string(),
    name: z.string(),
    companyId: z.string().nullable(),
    siteId: z.string().nullable(),
    timeZone: z.string(),
    calendars: z.array(z.object({ id: z.string(), scope: calendarScope, name: z.string() })),
  }),
  from: z.string(),
  to: z.string(),
  workingDays: z.number(),
  minutes: z.number(),
  days: z.array(workingDaySchema),
})
export type WorkingTime = z.infer<typeof workingTimeSchema>
/** Each day's state for a company, site, line or workshop (≤ 366 days): open or not, why, who decided, its shifts. */
export const workingTime = (api: ApiClient, owner: OwnerRef, range: { from: string; to: string }, signal?: AbortSignal) =>
  api.get('/calendars/working-time', { query: { ...ownerQueryOf(owner), ...range }, schema: workingTimeSchema, signal })

// ---- shift patterns -------------------------------------------------------------------------------------------------

export const segmentKind = z.enum(SEGMENT_KINDS)
export type SegmentKind = z.infer<typeof segmentKind>
const segmentSchema = z.object({ id: z.string(), weekday: z.number(), kind: segmentKind, label: z.string().nullable(), startMinute: z.number(), endMinute: z.number(), start: z.string(), end: z.string() })
export type Segment = z.infer<typeof segmentSchema>
const patternSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status,
  segments: z.array(segmentSchema),
  weekdays: z.array(z.object({ weekday: z.number(), minutes: z.number(), shifts: z.array(z.object({ label: z.string().nullable(), startMinute: z.number(), endMinute: z.number(), minutes: z.number() })) })),
  weeklyMinutes: z.number(),
  shiftEnds: z.array(z.string()),
  calendars: z.number(),
  version: z.number(),
  updatedAt: z.string(),
})
export type Pattern = z.infer<typeof patternSchema>

export interface SegmentBody {
  weekday: number
  kind: SegmentKind
  label?: string | null
  startMinute: number
  endMinute: number
}

export const listPatterns = async (api: ApiClient, companyId: string | null, signal?: AbortSignal) =>
  (await api.get('/shift-patterns', { query: { companyId: companyId ?? undefined }, schema: z.object({ patterns: z.array(patternSchema) }), signal })).patterns

const onePattern = z.object({ pattern: patternSchema })
/** calendars.manage over every site of the company (a tenant-wide pattern: every company). */
export const createPattern = async (api: ApiClient, body: { companyId?: string | null; code: string; name: string; description?: string | null; segments: SegmentBody[] }, idempotencyKey: string) =>
  (await api.post('/shift-patterns', { body, schema: onePattern, idempotencyKey })).pattern
export const editPattern = async (api: ApiClient, patternId: string, body: { version: number; name?: string; description?: string | null }, idempotencyKey: string) =>
  (await api.request('PATCH', `/shift-patterns/${seg(patternId)}`, { body, schema: onePattern, idempotencyKey })).pattern
/** Every segment at once (one command); 400 issues at `body/segments/<i>[/field]`. */
export const saveSegments = async (api: ApiClient, patternId: string, body: { version: number; segments: SegmentBody[] }, idempotencyKey: string) =>
  (await api.request('PUT', `/shift-patterns/${seg(patternId)}/segments`, { body, schema: onePattern, idempotencyKey })).pattern
/** 409 while ACTIVE calendars use it. */
export const archivePattern = async (api: ApiClient, patternId: string, body: { version: number }, idempotencyKey: string) =>
  (await api.post(`/shift-patterns/${seg(patternId)}/archive`, { body, schema: onePattern, idempotencyKey })).pattern

// ---- planning settings (horizon and buckets) ---------------------------------------------------------------------------

const siteSchema = z.object({ id: z.string(), companyId: z.string(), code: z.string(), name: z.string(), kind: z.string(), timeZone: z.string() })
export type PlanningSite = z.infer<typeof siteSchema>
const settingsSchema = z.object({
  horizonWeeks: z.number(),
  dayBucketWeeks: z.number(),
  weekBucketWeeks: z.number(),
  defaultEfficiencyPct: z.string(),
  scheduledRunTime: z.string().nullable(),
  isDefault: z.boolean(),
  version: z.number().nullable(),
  updatedAt: z.string().nullable(),
})
export type PlanningSettings = z.infer<typeof settingsSchema>
const bucketSchema = z.object({ key: z.string(), kind: z.enum(BUCKET_KINDS), from: z.string(), to: z.string() })
export type PlanBucket = z.infer<typeof bucketSchema>
const siteSettingsSchema = z.object({ site: siteSchema, settings: settingsSchema, horizon: z.object({ from: z.string(), to: z.string(), buckets: z.array(bucketSchema) }) })
export type SiteSettings = z.infer<typeof siteSettingsSchema>

/** The ACTIVE sites the person plans at, each with its settings (planning.view). */
export const listPlanningSites = async (api: ApiClient, companyId: string | null, signal?: AbortSignal) =>
  (await api.get('/planning/settings', { query: { companyId: companyId ?? undefined }, schema: z.object({ sites: z.array(z.object({ site: siteSchema, settings: settingsSchema })) }), signal })).sites

export const getSiteSettings = (api: ApiClient, siteId: string, signal?: AbortSignal) => api.get(`/planning/settings/${seg(siteId)}`, { schema: siteSettingsSchema, signal })

export interface EditSettingsBody {
  version?: number
  horizonWeeks?: number
  dayBucketWeeks?: number
  weekBucketWeeks?: number
  defaultEfficiencyPct?: string
  scheduledRunTime?: string | null
}
/** planning.settings.manage: the first save makes the row; 400 issues `body/<field>`; 409 stale version. */
export const editSiteSettings = (api: ApiClient, siteId: string, body: EditSettingsBody, idempotencyKey: string) =>
  api.request('PATCH', `/planning/settings/${seg(siteId)}`, { body, schema: siteSettingsSchema.extend({ changed: z.array(z.string()) }), idempotencyKey })

// ---- item parameters and reorder rules ----------------------------------------------------------------------------------

export const planningMethod = z.enum(ITEM_PLANNING_METHODS)
export type PlanningMethod = z.infer<typeof planningMethod>
export const planningSource = z.enum(ITEM_PLANNING_SOURCES)
export type PlanningSource = z.infer<typeof planningSource>

const itemParametersSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), baseUom: z.string() }),
  colour: named.nullable(),
  method: planningMethod,
  source: planningSource.nullable(),
  supplier: named.nullable(),
  makeSite: named.nullable(),
  buyLeadTimeDays: z.number().nullable(),
  makeLeadTimeDays: z.number().nullable(),
  safetyLeadTimeDays: z.number().nullable(),
  safetyStock: z.string().nullable(),
  reorderPoint: z.string().nullable(),
  lotSize: z.string().nullable(),
  minStock: z.string().nullable(),
  maxStock: z.string().nullable(),
  minOrderQty: z.string().nullable(),
  orderMultiple: z.string().nullable(),
  maxOrderQty: z.string().nullable(),
  note: z.string().nullable(),
  version: z.number(),
  updatedAt: z.string(),
})
export type ItemParameters = z.infer<typeof itemParametersSchema>
const itemDefaultsSchema = z.object({
  sourcing: z.string(),
  supplier: named.nullable(),
  leadTimeDays: z.number().nullable(),
  purchaseUom: z.string(),
  minOrderQty: z.string().nullable(),
  orderMultiple: z.string().nullable(),
})
export type ItemDefaults = z.infer<typeof itemDefaultsSchema>
const itemEntrySchema = z.object({
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string(), tracking: z.string(), baseUom: z.string(), colours: z.array(named) }),
  defaults: itemDefaultsSchema,
  parameters: z.array(itemParametersSchema),
})
export type ItemEntry = z.infer<typeof itemEntrySchema>
const itemPageSchema = z.object({ site: siteSchema, items: z.array(itemEntrySchema), nextCursor: z.string().nullable() })
export type ItemPage = z.infer<typeof itemPageSchema>

export interface ItemQuery {
  siteId: string
  q?: string
  kind?: string
  method?: PlanningMethod
  configured?: boolean
  cursor?: string
  limit?: number
}
/** The site's items by code, each with its own defaults and the site's rows (the one for every colour first). */
export const listItemParameters = (api: ApiClient, query: ItemQuery, signal?: AbortSignal) =>
  api.get('/planning/item-parameters', { query: { ...query, configured: query.configured === undefined ? undefined : String(query.configured) }, schema: itemPageSchema, signal })

/** The writable fields; null clears one. Quantities are decimal strings in the item's base unit, days whole numbers. */
export interface ItemParametersFields {
  method?: PlanningMethod
  source?: PlanningSource | null
  supplierId?: string | null
  makeSiteId?: string | null
  buyLeadTimeDays?: number | null
  makeLeadTimeDays?: number | null
  safetyLeadTimeDays?: number | null
  safetyStock?: string | null
  reorderPoint?: string | null
  lotSize?: string | null
  minStock?: string | null
  maxStock?: string | null
  minOrderQty?: string | null
  orderMultiple?: string | null
  maxOrderQty?: string | null
  note?: string | null
}
const writeAnswer = z.object({ parameters: itemParametersSchema, cleared: z.array(z.string()) })
export type ItemWriteAnswer = z.infer<typeof writeAnswer>

/** planning.items.manage: the site's row for an item (and colour); 409 when it has one. */
export const createItemParameters = (api: ApiClient, body: ItemParametersFields & { siteId: string; itemId: string; itemColourId?: string | null }, idempotencyKey: string) =>
  api.post('/planning/item-parameters', { body, schema: writeAnswer, idempotencyKey })
/** A method change clears the old method's own fields it does not name; a source change the supplier or make site. */
export const editItemParameters = (api: ApiClient, itemPlanningId: string, body: ItemParametersFields & { version: number }, idempotencyKey: string) =>
  api.request('PATCH', `/planning/item-parameters/${seg(itemPlanningId)}`, { body, schema: writeAnswer, idempotencyKey })
/** The item is planned by its defaults again. */
export const deleteItemParameters = (api: ApiClient, itemPlanningId: string, body: { version: number }, idempotencyKey: string) =>
  api.post(`/planning/item-parameters/${seg(itemPlanningId)}/delete`, { body, schema: z.object({ deleted: z.string(), siteId: z.string(), itemId: z.string() }), idempotencyKey })

/** The rows planned by a reorder point or min/max at the site (the site is the warehouse), by item code. */
export const listReorderRules = (api: ApiClient, siteId: string, signal?: AbortSignal) =>
  api.get('/planning/reorder-rules', { query: { siteId }, schema: z.object({ site: siteSchema, rules: z.array(itemParametersSchema) }), signal })

const supplierItemsSchema = z.object({
  items: z.array(z.object({ id: z.string(), partyId: z.string(), supplier: z.object({ code: z.string(), name: z.string(), status: z.string() }), colour: z.object({ code: z.string(), name: z.string() }).nullable(), status: z.string() })),
})
/** An item's approved suppliers (purchasing.view): the preferred supplier is one of them or the item's own default. */
export const itemSuppliers = async (api: ApiClient, itemId: string, signal?: AbortSignal) => (await api.get('/purchasing/supplier-items', { query: { itemId }, schema: supplierItemsSchema, signal })).items

// ---- lanes: line efficiency and people ---------------------------------------------------------------------------------

const laneSchema = z.object({
  kind: z.enum(['LINE', 'WORK_CENTRE']),
  id: z.string(),
  code: z.string(),
  name: z.string(),
  workCentreKind: z.string().nullable(),
  stations: z.number(),
  capacity: z.object({ plannedEfficiencyPct: z.string(), people: z.number().nullable(), note: z.string().nullable(), version: z.number(), updatedAt: z.string() }).nullable(),
  effective: z.object({ efficiencyPct: z.string(), efficiencySource: z.enum(['LANE', 'SITE', 'DEFAULT']), people: z.number(), peopleSource: z.enum(['CAPACITY', 'STATIONS']) }),
  actual: z.array(z.object({ week: z.string(), from: z.string(), to: z.string(), earnedMinutes: z.string(), availableMinutes: z.string(), pct: z.string().nullable() })).nullable(),
})
export type Lane = z.infer<typeof laneSchema>
const lanesSchema = z.object({ site: siteSchema, defaultEfficiencyPct: z.string(), defaultEfficiencySource: z.enum(['SITE', 'DEFAULT']), lines: z.array(laneSchema), workCentres: z.array(laneSchema) })
export type SiteLanes = z.infer<typeof lanesSchema>

/** The site's lines (with the last four weeks' actual efficiency) and work centres. */
export const listLanes = (api: ApiClient, siteId: string, signal?: AbortSignal) => api.get('/planning/lanes', { query: { siteId }, schema: lanesSchema, signal })

const laneAnswer = z.object({ lane: laneSchema, changed: z.array(z.string()) })
/** planning.settings.manage: a line's planned efficiency and people per shift (a headcount, never who; null = its stations). */
export const editLineCapacity = (api: ApiClient, lineId: string, body: { version?: number; plannedEfficiencyPct?: string; operators?: number | null; note?: string | null }, idempotencyKey: string) =>
  api.request('PATCH', `/planning/lines/${seg(lineId)}/capacity`, { body, schema: laneAnswer, idempotencyKey })
/** planning.settings.manage: a work centre's planned efficiency and units at once (null = its stations). */
export const editWorkCentreCapacity = (api: ApiClient, workCentreId: string, body: { version?: number; plannedEfficiencyPct?: string; units?: number | null; note?: string | null }, idempotencyKey: string) =>
  api.request('PATCH', `/planning/work-centres/${seg(workCentreId)}/capacity`, { body, schema: laneAnswer, idempotencyKey })

// ---- the capacity a closure takes away ----------------------------------------------------------------------------------

const capacityLane = z.object({
  kind: z.enum(['LINE', 'WORK_CENTRE']),
  id: z.string(),
  code: z.string(),
  name: z.string(),
  overall: z.object({ availableMinutes: z.string(), bookedMinutes: z.string() }),
})
/** Every lane of the site over the days (one bucket), its available and booked minutes. */
export const capacityOver = async (api: ApiClient, query: { siteId: string; from: string; to: string }, signal?: AbortSignal) =>
  (await api.get('/planning/capacity', { query: { ...query, bucket: 'MONTH' }, schema: z.object({ lanes: z.array(capacityLane) }), signal })).lanes

const cellSchema = z.object({
  bookedMinutes: z.string(),
  orders: z.array(z.object({ workOrder: z.object({ id: z.string(), number: z.string() }), minutes: z.string() })),
})
/** The open work orders booked on a lane in those days. */
export const capacityCell = (api: ApiClient, query: { siteId: string; laneKind: 'LINE' | 'WORK_CENTRE'; laneId: string; from: string; to: string }, signal?: AbortSignal) =>
  api.get('/planning/capacity/cell', { query, schema: cellSchema, signal })
