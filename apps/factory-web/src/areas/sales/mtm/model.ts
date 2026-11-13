import { businessDate } from '@nexus/factory-domain/core/time'
import { decimalOf, hundredthsOf, zoneOf, type BodyZone } from '@nexus/factory-domain/sales/measure-link/rules'
import { MTM_LINE_CODES } from '@nexus/factory-domain/sales/mtm/codes'
import { BASIC_MEASURES, MTM_OFFICE_LIMITS, REVIEW_STATUSES, type ReviewDecision, type ReviewStatus } from '@nexus/factory-domain/sales/mtm/rules'
import { APPOINTMENT_KINDS, APPOINTMENT_STATUSES, FITTING_LIMITS, FITTING_VERDICTS, type FittingVerdict } from '@nexus/factory-domain/sales/fittings/rules'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { Appointment, AppointmentRow, FittingResult, FittingsTab, MtmCheck, ProfileRecord, ProfilesQuery, QuoteProofs, RepeatFacts, Revision, SentRevision, TemplatePoint, Tiles, Unit } from './api'

/**
 * Sales › Made-to-measure (SCR-036, the rider profile, the worksheet tab; B-W2b-362), pure: who may do what, the list's
 * address and tiles, the measurement form (the template's points, what is typed, what is asked again, the body sent), the
 * factory review, a fitting booked and its outcome, the measurement link, a unit on a new quote, a repeat order, the
 * compare of two revisions and the record's activity — all said from codes, states and figures in this screen's catalogue
 * (`sales-mtm`), never the API's English. Made-to-measure is built switched OFF per template (Owner 11-10, GATE-MTM): every
 * part says the off state in words and where it is started (Products › Sizes & measurements › Measurement templates).
 */

export const NS = 'sales-mtm'

export interface Phrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

export type NoticeTone = 'success' | 'info' | 'warning' | 'danger'

export interface Notice extends Phrase {
  readonly tone: NoticeTone
  readonly link?: { readonly href: string; readonly label: Phrase } | null
  readonly lines?: readonly Phrase[]
}

export const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

// ---- who may do what --------------------------------------------------------------------------------------------------

export const MTM_PERMISSIONS = Object.freeze({
  /** Rider profiles, body data, photos, fittings (B-W2b-171's read). */
  view: 'sales.measurements.view',
  /** Record a revision, keep a worksheet (B-W2b-358). */
  record: 'sales.mtm.record',
  /** The factory review (B-W2b-358: the production manager's). */
  review: 'sales.mtm.review',
  /** Send a measurement link (B-W2b-171). */
  link: 'sales.measurements.manage',
  /** Book a fitting, record its outcome (B-W2b-360). */
  fittings: 'sales.fittings.manage',
  /** A unit on a new quote, a repeat order. */
  quotes: 'quotes.manage',
  quotesView: 'quotes.view',
  ordersView: 'orders.view',
  /** The garment types (measurement templates) and the MTM styles for the check. */
  styles: 'product.styles.view',
  /** The customers and their riders for New measurements. */
  parties: 'parties.view',
  /** The office people a measurer or a fitter may be. */
  people: 'tasks.manage',
} as const)

export type MtmAbility = keyof typeof MTM_PERMISSIONS
export type MtmCan = Readonly<Record<MtmAbility, boolean>>

export function mtmCan(permissions: readonly string[]): MtmCan {
  const held = new Set(permissions)
  return Object.fromEntries(Object.entries(MTM_PERMISSIONS).map(([ability, permission]) => [ability, held.has(permission)])) as unknown as MtmCan
}

/** The words of a missing right: `held.right` with the right said in words (`right.<ability>`). */
export const rightHeld = (ability: MtmAbility): Phrase => phrase('held.right', { right: `right.${ability}` })

// ---- addresses --------------------------------------------------------------------------------------------------------

export const LIST_PATH = '/sales/made-to-measure'
export const listHref = (prefix: string): string => `${prefix}${LIST_PATH}`

export const RECORD_TABS = ['measurements', 'photos', 'fittings', 'proofs', 'orders', 'activity'] as const
export type RecordTab = (typeof RECORD_TABS)[number]

/** What a record address opens besides its tab: a dialog of the row verbs (`?do=`). */
export const RECORD_DOS = ['revision', 'review', 'fitting', 'link', 'quote', 'repeat', 'compare'] as const
export type RecordDo = (typeof RECORD_DOS)[number]

export function recordHref(prefix: string, profileId: string, tab?: RecordTab | null, todo?: RecordDo | null): string {
  const search = new URLSearchParams()
  if (tab && tab !== 'measurements') search.set('tab', tab)
  if (todo) search.set('do', todo)
  const text = search.toString()
  return `${prefix}${LIST_PATH}/${encodeURIComponent(profileId)}${text ? `?${text}` : ''}`
}

export const doOf = (value: string | null | undefined): RecordDo | null => ((RECORD_DOS as readonly string[]).includes(value ?? '') ? (value as RecordDo) : null)

/** The worksheet and order form PDF (tab:mtm.worksheet), a new tab. */
export const worksheetHref = (prefix: string, profileId: string): string => `${prefix}${LIST_PATH}/${encodeURIComponent(profileId)}/worksheet`

/** Products › Sizes & measurements › Measurement templates (where made-to-measure is started per template). */
export const templatesHref = (prefix: string): string => `${prefix}/products/sizes?view=templates`
export const templateHref = (prefix: string, templateId: string): string => `${prefix}/products/sizes/templates/${encodeURIComponent(templateId)}`
export const quoteHref = (prefix: string, quoteId: string, tab?: string): string => `${prefix}/sales/quotes/${encodeURIComponent(quoteId)}${tab ? `?tab=${tab}` : ''}`
export const orderHref = (prefix: string, orderId: string): string => `${prefix}/sales/orders/${encodeURIComponent(orderId)}`
export const repairHref = (prefix: string, repairId: string): string => `${prefix}/sales/returns/repairs/${encodeURIComponent(repairId)}`
export const customerHref = (prefix: string, partyId: string): string => `${prefix}/sales/customers/${encodeURIComponent(partyId)}`

// ---- the list -----------------------------------------------------------------------------------------------------------

/** Rows ▾ (design savedRows; B-W2b-371: "Outside range" and "Fittings this week" filter the list too, "By customer" is its own chip). */
export const ROW_VIEWS = ['all', 'waiting', 'needMore', 'confirmed', 'old', /* B-W2b-371 */ 'outside', 'fittings'] as const
export type RowView = (typeof ROW_VIEWS)[number]

export interface ListAddress {
  readonly view: RowView
  /** A garment type (the measurement template's code). */
  readonly garment: string | null
  readonly q: string
  /** New measurements (`?new=1`). */
  readonly isNew: boolean
  /** Send a measurement link from the band (`?link=1`). */
  readonly link: boolean
  /** B-W2b-371 (XF2:03): one customer's riders (`?customer=<party id>`, design Rows ▾ "By customer"). */
  readonly customer: string | null
}

export const HOME_ADDRESS: ListAddress = Object.freeze({ view: 'all', garment: null, q: '', isNew: false, link: false, customer: null })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function addressOf(params: Pick<URLSearchParams, 'get'> | null | undefined): ListAddress {
  const view = params?.get('view') ?? ''
  const garment = (params?.get('garment') ?? '').trim()
  return {
    view: (ROW_VIEWS as readonly string[]).includes(view) ? (view as RowView) : 'all',
    garment: /^[A-Z][A-Z0-9_-]{0,39}$/.test(garment) ? garment : null,
    q: (params?.get('q') ?? '').slice(0, 100),
    isNew: params?.get('new') === '1',
    link: params?.get('link') === '1',
    customer: UUID.test(params?.get('customer') ?? '') ? params!.get('customer') : null,
  }
}

export function addressText(address: ListAddress): string {
  const search = new URLSearchParams()
  if (address.view !== 'all') search.set('view', address.view)
  if (address.garment) search.set('garment', address.garment)
  if (address.q.trim()) search.set('q', address.q.trim())
  if (address.customer) search.set('customer', address.customer)
  if (address.isNew) search.set('new', '1')
  if (address.link) search.set('link', '1')
  const text = search.toString()
  return text ? `?${text}` : ''
}

export const isFiltered = (address: ListAddress): boolean => address.view !== 'all' || address.garment !== null || address.q.trim() !== '' || address.customer !== null

const REVIEW_OF: Readonly<Partial<Record<RowView, ReviewStatus>>> = { waiting: 'WAITING', needMore: 'NEED_MORE', confirmed: 'CONFIRMED' }

export function queryOf(address: ListAddress, offset = 0): ProfilesQuery {
  return { q: address.q, garmentType: address.garment, review: REVIEW_OF[address.view] ?? null, old: address.view === 'old' ? true : null, partyId: address.customer, range: address.view === 'outside' ? 'outside' : null, fittings: address.view === 'fittings' ? 'week' : null, offset }
}

export interface Chip {
  readonly id: string
  readonly label: Phrase
  readonly clear: Partial<ListAddress>
}

export function chipsOf(address: ListAddress, customerName?: string | null): Chip[] {
  const chips: Chip[] = []
  // B-W2b-371: the customer chosen (its name once the picker knows it).
  if (address.customer) chips.push({ id: 'customer', label: customerName ? phrase('chip.customer', { customer: customerName }) : phrase('chip.customerUnnamed'), clear: { customer: null } })
  if (address.view !== 'all') chips.push({ id: 'view', label: phrase(`view.${address.view}`), clear: { view: 'all' } })
  if (address.garment) chips.push({ id: 'garment', label: phrase('chip.garment', { garment: address.garment }), clear: { garment: null } })
  if (address.q.trim()) chips.push({ id: 'q', label: phrase('chip.search', { q: address.q.trim() }), clear: { q: '' } })
  return chips
}

/** The tiles (design mtm.tiles): each a saved row of the list (B-W2b-371: "Outside" and "Fittings" press theirs too). */
export const TILES = ['waiting', 'needMore', 'outside', 'fittings', 'old'] as const
export type Tile = (typeof TILES)[number]

/** The row view a tile presses. */
export const TILE_VIEW: Readonly<Record<Tile, RowView | null>> = Object.freeze({ waiting: 'waiting', needMore: 'needMore', outside: 'outside', fittings: 'fittings', old: 'old' })

/** A tile's number (the riders its filter shows); null: unknown ("—", never 0) — "outside" while no unit's range is known. */
export function tileValue(tiles: Tiles | null, tile: Tile): number | null {
  if (!tiles) return null
  if (tile === 'waiting') return tiles.waitingReview
  if (tile === 'needMore') return tiles.needMore
  if (tile === 'fittings') return tiles.fittingsThisWeek
  if (tile === 'old') return tiles.older
  return tiles.outsideRange
}

/** The row verbs (design mtm.grid#2): Open, Open in new tab, New revision, Use in a new quote, Print worksheet. */
export type RowVerb = 'revision' | 'quote' | 'worksheet'

export function rowVerbHeld(verb: RowVerb, can: MtmCan, offline: boolean): Phrase | null {
  if (offline && verb !== 'worksheet') return phrase('held.offline')
  if (verb === 'revision' && !can.record) return rightHeld('record')
  if (verb === 'quote' && !can.quotes) return rightHeld('quotes')
  if (verb === 'worksheet' && !can.record) return rightHeld('record')
  return null
}

export const REVIEW_TONE: Readonly<Record<ReviewStatus, NoticeTone>> = Object.freeze({ WAITING: 'warning', CONFIRMED: 'success', NEED_MORE: 'danger' })

// ---- the measurement form ---------------------------------------------------------------------------------------------

/** One point as the office form shows it: the template's ACTIVE points in order, their unit cm or mm. */
export interface FormPoint {
  readonly code: string
  readonly name: string
  /** 'cm' or 'mm' (the point's unit, lower case as stored on a revision). */
  readonly unit: string
  readonly required: boolean
  readonly min: string | null
  readonly max: string | null
  /** How to measure it (the template's words, the factory's own). */
  readonly howTo: string | null
  readonly zone: BodyZone
}

export function formPoints(points: readonly Pick<TemplatePoint, 'code' | 'name' | 'uom' | 'required' | 'minValue' | 'maxValue' | 'howTo' | 'status'>[] | null | undefined): FormPoint[] {
  return (points ?? [])
    .filter((point) => point.status === 'ACTIVE')
    .map((point) => ({ code: point.code, name: point.name, unit: point.uom.toLowerCase(), required: point.required, min: point.minValue, max: point.maxValue, howTo: point.howTo, zone: zoneOf(point.code) }))
}

/** The basics every revision may carry beside the template's points (height cm, weight kg), unless the template measures them. */
export const basicsOf = (points: readonly FormPoint[]): Array<'height' | 'weight'> => (Object.keys(BASIC_MEASURES) as Array<'height' | 'weight'>).filter((code) => !points.some((point) => point.code === code))

/** Who measured: the person, another office person of ours, or someone outside named in words (a dealer's fitter, the rider). */
export type Measurer = { readonly kind: 'me' } | { readonly kind: 'person'; readonly id: string } | { readonly kind: 'outside' }

export interface FormDraft {
  /** Per point code, and `height` / `weight`, as typed. */
  readonly values: Readonly<Record<string, string>>
  /** The points outside their plausible range the person checked again. */
  readonly confirmed: readonly string[]
  readonly baseSize: string
  readonly fitNotes: string
  readonly internalNote: string
  /** When the rider was measured (an instant, ISO). */
  readonly takenAt: string
  readonly measurer: Measurer
  /** Who measured, in words, when it was someone outside (a dealer's fitter, the rider). */
  readonly takenBy: string
  readonly place: string
  /** The privacy notice given before any value (GDPR art. 13): which one, and when. */
  readonly noticeRef: string
  readonly noticeAt: string
}

export function emptyDraft(now: string): FormDraft {
  return { values: {}, confirmed: [], baseSize: '', fitNotes: '', internalNote: '', takenAt: now, measurer: { kind: 'me' }, takenBy: '', place: '', noticeRef: '', noticeAt: now }
}

/** A new revision starts from the one on screen: its values, base size and notes; a new time, who and where are asked again. */
export function draftFromRevision(revision: Revision, now: string): FormDraft {
  const values: Record<string, string> = {}
  for (const [code, entry] of Object.entries(revision.measurements)) values[code] = entry.value
  return { ...emptyDraft(now), values, baseSize: revision.baseSize ?? '', fitNotes: revision.fitNotes ?? '', internalNote: revision.internalNote ?? '', noticeRef: revision.privacyNoticeRef, noticeAt: revision.privacyNoticeAt }
}

/** A value outside its point's plausible range (in hundredths), or null. */
export function outsideRange(point: Pick<FormPoint, 'min' | 'max'>, typed: string | undefined): boolean {
  const value = hundredthsOf(typed?.trim() ?? '')
  if (value === null) return false
  const min = hundredthsOf(point.min)
  const max = hundredthsOf(point.max)
  return (min !== null && value < min) || (max !== null && value > max)
}

export const rangeText = (point: Pick<FormPoint, 'min' | 'max' | 'unit'>): string | null => (point.min === null && point.max === null ? null : `${point.min ?? '…'}–${point.max ?? '…'} ${point.unit}`)

/** What is wrong with one point as typed (said under it), the API's rule first: required, a number, outside and not confirmed. */
export function pointProblem(point: FormPoint, draft: Pick<FormDraft, 'values' | 'confirmed'>): Phrase | null {
  const typed = draft.values[point.code]?.trim() ?? ''
  if (typed === '') return point.required ? phrase('form.problem.required', { point: point.name }) : null
  const value = hundredthsOf(typed)
  if (value === null || value <= 0) return phrase('form.problem.number')
  if (outsideRange(point, typed) && !draft.confirmed.includes(point.code)) return phrase('form.problem.outside', { point: point.name, value: `${decimalOf(value)} ${point.unit}`, range: rangeText(point) ?? '' })
  return null
}

export function basicProblem(typed: string | undefined): Phrase | null {
  const text = typed?.trim() ?? ''
  if (text === '') return null
  const value = hundredthsOf(text)
  return value === null || value <= 0 ? phrase('form.problem.number') : null
}

/** Every problem of the form by field (a point's code, `height`, `weight`, `takenBy`, `noticeRef`, `noticeAt`, `takenAt`). */
export function formProblems(draft: FormDraft, points: readonly FormPoint[], options: { needNotice: boolean; now: string }): Record<string, Phrase> {
  const out: Record<string, Phrase> = {}
  for (const point of points) {
    const problem = pointProblem(point, draft)
    if (problem) out[point.code] = problem
  }
  for (const code of basicsOf(points)) {
    const problem = basicProblem(draft.values[code])
    if (problem) out[code] = problem
  }
  if (draft.measurer.kind === 'outside' && !draft.takenBy.trim()) out.takenBy = phrase('form.problem.takenBy')
  if (draft.takenAt && new Date(draft.takenAt).getTime() > new Date(options.now).getTime() + 5 * 60_000) out.takenAt = phrase('form.problem.takenAtFuture')
  if (options.needNotice && !draft.noticeRef.trim()) out.noticeRef = phrase('form.problem.noticeRef')
  if (draft.noticeAt && draft.takenAt && new Date(draft.noticeAt).getTime() > new Date(draft.takenAt).getTime()) out.noticeAt = phrase('form.problem.noticeAfter')
  if (draft.fitNotes.length > MTM_OFFICE_LIMITS.notes) out.fitNotes = phrase('form.problem.tooLong', { max: MTM_OFFICE_LIMITS.notes })
  if (draft.internalNote.length > MTM_OFFICE_LIMITS.notes) out.internalNote = phrase('form.problem.tooLong', { max: MTM_OFFICE_LIMITS.notes })
  return out
}

/** The points typed and outside their range (each asks "I checked it"). */
export const outsidePointsOf = (draft: Pick<FormDraft, 'values'>, points: readonly FormPoint[]): string[] => points.filter((point) => outsideRange(point, draft.values[point.code])).map((point) => point.code)

/** How many of the points are filled ("Point 9 of 24"). */
export const filledOf = (draft: Pick<FormDraft, 'values'>, points: readonly FormPoint[]): number => points.filter((point) => (draft.values[point.code]?.trim() ?? '') !== '').length

const trimmed = (value: string): string | null => (value.trim() ? value.trim() : null)

/** The values sent: every point typed, and the basics typed (the API checks them again). */
function measurementsOf(draft: FormDraft, points: readonly FormPoint[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const point of points) {
    const typed = draft.values[point.code]?.trim() ?? ''
    if (typed) out[point.code] = typed.replace(',', '.')
  }
  for (const code of basicsOf(points)) {
    const typed = draft.values[code]?.trim() ?? ''
    if (typed) out[code] = typed.replace(',', '.')
  }
  return out
}

function measuredBody(draft: FormDraft, points: readonly FormPoint[], me: string) {
  const outside = outsidePointsOf(draft, points).filter((code) => draft.confirmed.includes(code))
  return {
    measurements: measurementsOf(draft, points),
    ...(outside.length > 0 ? { confirmedOutside: outside } : {}),
    baseSize: trimmed(draft.baseSize),
    fitNotes: trimmed(draft.fitNotes),
    internalNote: trimmed(draft.internalNote),
    takenAt: new Date(draft.takenAt).toISOString(),
    ...(draft.measurer.kind === 'outside' ? { takenBy: draft.takenBy.trim(), measuredByUserId: null } : { measuredByUserId: draft.measurer.kind === 'me' ? me : draft.measurer.id }),
    measuredPlace: trimmed(draft.place),
  }
}

export interface NewHeader {
  readonly partyId: string
  readonly contactId: string | null
  readonly riderName: string
  readonly garmentType: string
}

export function newProfileBodyOf(header: NewHeader, draft: FormDraft, points: readonly FormPoint[], me: string) {
  return {
    partyId: header.partyId,
    ...(header.contactId ? { contactId: header.contactId } : {}),
    riderName: header.riderName.trim(),
    garmentType: header.garmentType,
    ...measuredBody(draft, points, me),
    privacyNoticeRef: draft.noticeRef.trim(),
    privacyNoticeAt: new Date(draft.noticeAt).toISOString(),
  }
}

export function newRevisionBodyOf(draft: FormDraft, points: readonly FormPoint[], me: string, notice: { ref: string; at: string } | null) {
  const changedNotice = notice !== null && (draft.noticeRef.trim() !== notice.ref || new Date(draft.noticeAt).getTime() !== new Date(notice.at).getTime())
  return { ...measuredBody(draft, points, me), ...(changedNotice && draft.noticeRef.trim() ? { privacyNoticeRef: draft.noticeRef.trim(), privacyNoticeAt: new Date(draft.noticeAt).toISOString() } : {}) }
}

/** The check's measures while typing (B-W2b-248: `{code: {value, unit}}`), only the numbers typed. */
export function checkMeasuresOf(draft: Pick<FormDraft, 'values'>, points: readonly FormPoint[]): Record<string, { value: string; unit: string }> {
  const out: Record<string, { value: string; unit: string }> = {}
  for (const point of points) {
    const value = hundredthsOf(draft.values[point.code]?.trim() ?? '')
    if (value !== null && value > 0) out[point.code] = { value: decimalOf(value), unit: point.unit }
  }
  for (const code of basicsOf(points)) {
    const value = hundredthsOf(draft.values[code]?.trim() ?? '')
    if (value !== null && value > 0) out[code] = { value: decimalOf(value), unit: BASIC_MEASURES[code] }
  }
  return out
}

/** A refused save in our words, by field: the API's issue paths (`body/measurements/<code>`, `body/takenAt` …) read with what was typed. */
export function saveProblemsOf(error: unknown, draft: FormDraft, points: readonly FormPoint[], mode: 'new' | 'revision' = 'revision'): { fields: Record<string, Phrase>; notice: Phrase } {
  const fields: Record<string, Phrase> = {}
  if (!isApiError(error)) return { fields, notice: phrase('problem.unavailable') }
  for (const issue of error.issues) {
    const path = issuePath(issue).replace(/^body[./]/, '').replace(/\./g, '/')
    const [head, code] = path.split('/')
    if (head === 'measurements' && code) {
      const point = points.find((entry) => entry.code === code)
      const typed = draft.values[code]
      fields[code] = point ? (pointProblem(point, { values: draft.values, confirmed: [] }) ?? (outsideRange(point, typed) ? phrase('form.problem.outside', { point: point.name, value: `${typed} ${point.unit}`, range: rangeText(point) ?? '' }) : phrase('form.problem.rule', { point: point.name }))) : phrase('form.problem.notAPoint')
    } else if (head === 'takenAt') fields.takenAt = phrase('form.problem.takenAtFuture')
    else if (head === 'privacyNoticeAt') fields.noticeAt = phrase('form.problem.noticeAfter')
    else if (head === 'privacyNoticeRef') fields.noticeRef = phrase('form.problem.noticeRef')
    else if (head === 'takenBy') fields.takenBy = phrase('form.problem.takenBy')
    else if (head === 'measuredByUserId') fields.measurer = phrase('form.problem.measurer')
    else if (head === 'contactId') fields.contact = phrase('form.problem.contact')
    else if (head === 'garmentType') fields.garment = phrase('form.problem.garment')
    else if (head === 'riderName') fields.rider = phrase('form.problem.rider')
  }
  if (error.kind === 'conflict') return { fields, notice: phrase(mode === 'new' ? 'problem.alreadyMeasured' : 'problem.newerRevision') }
  if (error.kind === 'forbidden') return { fields, notice: rightHeld('record') }
  if (Object.keys(fields).length > 0) return { fields, notice: phrase('form.problem.fix', { count: Object.keys(fields).length }) }
  return { fields, notice: writeProblem(error) }
}

// ---- reads and writes in words ------------------------------------------------------------------------------------------

export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.unavailable'
  if (error.kind === 'forbidden') return 'problem.forbidden'
  if (error.kind === 'not_found') return 'problem.notFound'
  if (error.kind === 'rate_limited') return 'problem.rateLimited'
  if (error.kind === 'unavailable') return 'problem.unavailable'
  if (error.kind === 'contract') return 'problem.contract'
  return 'problem.internal'
}

export function writeProblem(error: unknown): Phrase {
  if (!isApiError(error)) return phrase('problem.unavailable')
  if (error.kind === 'conflict') return phrase('problem.conflict')
  if (error.kind === 'forbidden') return phrase('problem.forbidden')
  if (error.kind === 'not_found') return phrase('problem.notFound')
  if (error.kind === 'invalid') return phrase('problem.invalid')
  if (error.kind === 'rate_limited') return phrase('problem.rateLimited')
  if (error.kind === 'step_up') return phrase('problem.stepUp')
  if (error.kind === 'unavailable') return phrase('problem.unavailable')
  return phrase('problem.internal')
}

// ---- made-to-measure started (GATE-MTM) -----------------------------------------------------------------------------------

/** The off state in words: the template's made-to-measure rules are off (nothing is checked; no unit, no fitting). */
export function offPhrase(template: { code: string; rulesOn: boolean } | null | undefined): Phrase | null {
  if (!template) return phrase('off.noTemplate')
  return template.rulesOn ? null : phrase('off.template', { template: template.code })
}

// ---- the factory review (SAL-292) ---------------------------------------------------------------------------------------

/** Why the newest revision's review cannot be made now by this person, from the facts (never the API's `why`). */
export function reviewHeld(record: ProfileRecord, decision: ReviewDecision, me: string, can: MtmCan, offline: boolean): Phrase | null {
  if (!can.review) return rightHeld('review')
  const latest = record.revisions[0]
  if (!latest) return phrase('held.review.none')
  if (latest.review.status === 'CONFIRMED') return phrase('held.review.confirmed', { revision: latest.revision })
  if (decision === 'CONFIRM' && latest.measuredBy?.id === me) return phrase('held.review.ownMeasures')
  if (offline) return phrase('held.offline')
  const may = decision === 'CONFIRM' ? record.review.may.confirm : record.review.may.askMore
  return may ? null : phrase('held.review.notNow')
}

export interface ReviewDraft {
  readonly decision: ReviewDecision
  readonly note: string
  readonly notify: boolean
}

export const reviewDraftFor = (decision: ReviewDecision, mailTo: boolean): ReviewDraft => ({ decision, note: '', notify: mailTo })

export function reviewDraftHeld(draft: ReviewDraft): Phrase | null {
  if (draft.decision === 'NEED_MORE' && !draft.note.trim()) return phrase('review.held.note')
  if (draft.note.length > MTM_OFFICE_LIMITS.review) return phrase('form.problem.tooLong', { max: MTM_OFFICE_LIMITS.review })
  return null
}

/** The review's body: the sender company only when the revision came by no link and no unit names one (else the API's own). */
export function reviewBodyOf(draft: ReviewDraft, record: ProfileRecord, companyId: string | null, language: 'it' | 'en') {
  const latest = record.revisions[0]
  const needsCompany = draft.decision === 'NEED_MORE' && draft.notify && latest !== undefined && !latest.byLink && record.units.length === 0
  return { decision: draft.decision, note: draft.note.trim() || null, notify: draft.decision === 'NEED_MORE' ? draft.notify : false, language, ...(needsCompany && companyId ? { companyId } : {}) }
}

/** The receipt of a review in words: confirmed (and the orders that went on), or more asked (mailed or not). */
export function reviewedNotice(decision: ReviewDecision, answer: { mailed: boolean; ordersGoneOn: readonly { number: string }[] }, notify: boolean): Notice {
  if (decision === 'CONFIRM') return answer.ordersGoneOn.length > 0 ? { key: 'review.done.confirmedOrders', params: { count: answer.ordersGoneOn.length, orders: answer.ordersGoneOn.map((order) => order.number).join(', ') }, tone: 'success' } : { key: 'review.done.confirmed', tone: 'success' }
  if (!notify) return { key: 'review.done.needMoreKept', tone: 'success' }
  return answer.mailed ? { key: 'review.done.needMoreMailed', tone: 'success' } : { key: 'review.done.needMoreNotMailed', tone: 'warning' }
}

// ---- the record's measures -------------------------------------------------------------------------------------------

export interface MeasureLine {
  readonly code: string
  readonly name: string
  readonly value: string | null
  readonly unit: string
  readonly range: string | null
  /** Outside its plausible range (kept because the measurer checked it). */
  readonly outside: boolean
  readonly howTo: string | null
}

/** A revision's values against the template's points (archived points it still holds after them; the basics last). */
export function measureLines(revision: Revision, points: readonly FormPoint[]): MeasureLine[] {
  const known = new Set(points.map((point) => point.code))
  const lines: MeasureLine[] = points.map((point) => {
    const entry = revision.measurements[point.code]
    return { code: point.code, name: point.name, value: entry?.value ?? null, unit: entry?.unit ?? point.unit, range: rangeText(point), outside: entry ? outsideRange(point, entry.value) : false, howTo: point.howTo }
  })
  for (const [code, entry] of Object.entries(revision.measurements)) {
    if (known.has(code) || code in BASIC_MEASURES) continue
    lines.push({ code, name: code, value: entry.value, unit: entry.unit, range: null, outside: false, howTo: null })
  }
  return lines
}

export const basicLines = (revision: Revision): Array<{ code: 'height' | 'weight'; value: string | null; unit: string }> =>
  (['height', 'weight'] as const).map((code) => ({ code, value: revision.measurements[code]?.value ?? null, unit: revision.measurements[code]?.unit ?? BASIC_MEASURES[code] }))

export interface CompareLine {
  readonly code: string
  readonly name: string
  readonly before: string | null
  readonly after: string | null
  readonly unit: string
  /** after − before, signed ("+2.0"), null when either is missing. */
  readonly difference: string | null
  readonly changed: boolean
}

/** Two revisions side by side per point (design pop:mtm.compare), the differences toned by the view. */
export function compareLines(before: Revision, after: Revision, points: readonly FormPoint[]): CompareLine[] {
  const codes = [...points.map((point) => point.code), ...Object.keys({ ...before.measurements, ...after.measurements }).filter((code) => !points.some((point) => point.code === code))]
  return [...new Set(codes)].map((code) => {
    const point = points.find((entry) => entry.code === code)
    const a = before.measurements[code]?.value ?? null
    const b = after.measurements[code]?.value ?? null
    const ha = hundredthsOf(a)
    const hb = hundredthsOf(b)
    const diff = ha !== null && hb !== null ? hb - ha : null
    return {
      code,
      name: point?.name ?? code,
      before: a,
      after: b,
      unit: before.measurements[code]?.unit ?? after.measurements[code]?.unit ?? point?.unit ?? 'cm',
      difference: diff === null || diff === 0 ? null : `${diff > 0 ? '+' : '−'}${decimalOf(Math.abs(diff))}`,
      changed: diff !== null ? diff !== 0 : a !== b,
    }
  })
}

// ---- the check (base size, impossible ratios, certified range) --------------------------------------------------------

/** The rules the measures break (impossible ratios, ranges), in the rule's own words for the language when it has them. */
export function brokenRules(check: MtmCheck | null): Array<{ code: string; severity: 'BLOCK' | 'WARN'; words: Readonly<Record<string, string>>; pointCode: string; otherPointCode: string | null }> {
  return (check?.rules ?? []).filter((rule) => rule.outcome === 'BROKEN').map((rule) => ({ code: rule.code, severity: rule.severity, words: rule.words, pointCode: rule.pointCode, otherPointCode: rule.otherPointCode }))
}

export const ruleWords = (words: Readonly<Record<string, string>>, locale: string, code: string): string => words[locale] ?? words.it ?? words.en ?? code

/** The alterations beyond the certified basic model (the points that fall out, by how much). */
export const beyondPoints = (check: MtmCheck | null) => (check?.alterations ?? []).filter((entry) => entry.outcome === 'BEYOND')

/** The check's verdict for one style in words. */
export function rangeVerdict(check: MtmCheck): Phrase {
  if (!check.rulesOn) return phrase('range.off', { template: check.template.code })
  if (check.blocks.some((finding) => finding.kind === 'STYLE_NOT_MTM' || finding.kind === 'NO_TEMPLATE' || finding.kind === 'OTHER_TEMPLATE' || finding.kind === 'GARMENT_TYPE')) return phrase('range.notThisStyle')
  if (check.insideCertifiedRange === true) return phrase('range.inside')
  if (check.insideCertifiedRange === false) return phrase('range.outside')
  return phrase('range.unknown')
}

/** The style findings in words (PRD-017: a style not made to measure, no template, another template, another garment type). */
export const styleFindingsOf = (check: MtmCheck): Phrase[] =>
  check.blocks.filter((finding) => ['STYLE_NOT_MTM', 'NO_TEMPLATE', 'OTHER_TEMPLATE', 'GARMENT_TYPE'].includes(finding.kind)).map((finding) => phrase(`finding.${finding.kind}`, { style: check.style?.code ?? '', template: check.template.code }))

// ---- the measurement link (SAL-096) ----------------------------------------------------------------------------------

export interface LinkDraft {
  /** The rider's address typed (empty: the rider's contact's). */
  readonly email: string
  readonly language: 'it' | 'en'
  readonly photos: 'REQUIRED' | 'OPTIONAL'
  readonly days: number
  /** Mail it now; else the link is shown once to pass on. */
  readonly send: boolean
}

export const LINK_DAYS = [7, 14, 30, 60] as const

export const linkDraftFor = (language: 'it' | 'en'): LinkDraft => ({ email: '', language, photos: 'OPTIONAL', days: 14, send: true })

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function linkHeld(draft: LinkDraft, context: { can: MtmCan; offline: boolean; hasContact: boolean }): Phrase | null {
  if (!context.can.link) return rightHeld('link')
  if (context.offline) return phrase('held.offline')
  if (draft.email.trim() && !EMAIL.test(draft.email.trim())) return phrase('link.held.email')
  if (draft.send && !draft.email.trim() && !context.hasContact) return phrase('link.held.noAddress')
  return null
}

export function linkProblem(error: unknown): Phrase {
  if (isApiError(error) && error.kind === 'conflict') {
    const paths = error.issues.map(issuePath)
    if (paths.some((path) => path.includes('NO_NOTICE'))) return phrase('link.problem.noNotice')
    return phrase('link.problem.conflict')
  }
  if (isApiError(error) && error.kind === 'invalid') return phrase('link.problem.invalid')
  return writeProblem(error)
}

// ---- fittings (SAL-054, SAL-297) --------------------------------------------------------------------------------------

export const KIND_WORDS = APPOINTMENT_KINDS
export const STATUS_WORDS = APPOINTMENT_STATUSES

/** Why fittings cannot be booked or recorded here: not started (GATE-MTM), no right, offline. */
export function fittingsHeld(tab: FittingsTab | null, what: 'book' | 'record', can: MtmCan, offline: boolean, template: string | null): Phrase | null {
  if (!can.fittings) return rightHeld('fittings')
  if (tab && !tab.started) return phrase('off.template', { template: template ?? tab.garmentType })
  if (offline) return phrase('held.offline')
  if (tab && !(what === 'book' ? tab.may.book : tab.may.record)) return phrase('held.fittings.notNow')
  return null
}

export const FITTING_MINUTES = [30, 45, 60, 90, 120] as const

/** Where a fitting takes place (the design's "showroom, track, dealer"): quick picks, the place is typed. */
export const PLACE_PICKS = ['showroom', 'track', 'dealer'] as const

export interface BookDraft {
  /** The start (ISO). */
  readonly startsAt: string
  readonly minutes: number
  readonly place: string
  readonly fitter: Measurer
  /** The fitter's name when someone outside (a dealer's fitter). */
  readonly fitterName: string
  readonly notes: string
  readonly invite: boolean
}

/** A fitting tomorrow at 10:00 (local), an hour, the person as fitter, the invite on. */
export function bookDraftFor(now: Date): BookDraft {
  const start = new Date(now)
  start.setDate(start.getDate() + 1)
  start.setHours(10, 0, 0, 0)
  return { startsAt: start.toISOString(), minutes: 60, place: '', fitter: { kind: 'me' }, fitterName: '', notes: '', invite: true }
}

export function bookHeld(draft: BookDraft, now: Date): Phrase | null {
  if (!draft.startsAt) return phrase('book.held.when')
  if (new Date(draft.startsAt).getTime() < now.getTime() - 5 * 60_000) return phrase('book.held.past')
  if (!draft.place.trim()) return phrase('book.held.place')
  if (draft.place.length > FITTING_LIMITS.place) return phrase('form.problem.tooLong', { max: FITTING_LIMITS.place })
  if (draft.fitter.kind === 'outside' && !draft.fitterName.trim()) return phrase('book.held.fitter')
  if (draft.notes.length > FITTING_LIMITS.notes) return phrase('form.problem.tooLong', { max: FITTING_LIMITS.notes })
  return null
}

export function bookBodyOf(draft: BookDraft, record: Pick<ProfileRecord, 'partyId' | 'latestId' | 'contactId'>, companyId: string, me: string, language: 'it' | 'en') {
  const starts = new Date(draft.startsAt)
  return {
    companyId,
    partyId: record.partyId,
    kind: 'FITTING' as const,
    measurementProfileId: record.latestId,
    ...(record.contactId ? { contactId: record.contactId } : {}),
    startsAt: starts.toISOString(),
    endsAt: new Date(starts.getTime() + draft.minutes * 60_000).toISOString(),
    place: draft.place.trim(),
    ...(draft.fitter.kind === 'outside' ? { withName: draft.fitterName.trim() } : { withUserId: draft.fitter.kind === 'me' ? me : draft.fitter.id }),
    ...(draft.notes.trim() ? { notes: draft.notes.trim() } : {}),
    invite: draft.invite,
    language,
  }
}

/** The booking's warnings in words (a fitter of ours already booked then, no address for the invite) from their paths. */
export function bookWarnings(warnings: readonly { path: string }[]): Phrase[] {
  return warnings.map((warning) => (/with|fitter|overlap/i.test(warning.path) ? phrase('book.warn.fitterBusy') : /invite|mail|address|contact/i.test(warning.path) ? phrase('book.warn.noAddress') : phrase('book.warn.other')))
}

export const appointmentTone = (status: AppointmentRow['status']): NoticeTone => (status === 'BOOKED' ? 'info' : status === 'DONE' ? 'success' : status === 'MISSED' ? 'warning' : 'danger')

/** What the appointment's panel may do now (from `may`), held with why in our words. */
export function appointmentHeld(appointment: Appointment, action: 'move' | 'close' | 'cancel' | 'invite' | 'result', can: MtmCan, offline: boolean): Phrase | null {
  if (!can.fittings) return rightHeld('fittings')
  if (offline) return phrase('held.offline')
  if (appointment.may[action]) return null
  if (appointment.status !== 'BOOKED' && action !== 'result') return phrase('appt.held.closed', { status: `apptStatus.${appointment.status}` })
  if (action === 'invite' && !appointment.mailTo) return phrase('appt.held.noAddress')
  if (action === 'close' && new Date(appointment.startsAt).getTime() > Date.now()) return phrase('appt.held.notStarted')
  return phrase('appt.held.notNow')
}

export const VERDICTS = FITTING_VERDICTS

export interface ResultDraft {
  readonly appointmentId: string
  readonly orderLineId: string
  readonly verdict: FittingVerdict
  /** Per point code: the change asked in its unit ("+2.0") and a note. */
  readonly changes: Readonly<Record<string, { readonly change: string; readonly note: string }>>
  readonly notes: string
  readonly days: string
}

export const resultDraftFor = (appointmentId: string, orderLineId: string): ResultDraft => ({ appointmentId, orderLineId, verdict: 'OK', changes: {}, notes: '', days: '' })

const SIGNED = /^[+-−]?\d{1,4}([.,]\d{1,2})?$/

/** A point's change as typed: a signed decimal (≤ 4 digits, 2 decimals), not zero. */
export function changeProblem(text: string): Phrase | null {
  const value = text.trim()
  if (value === '') return null
  if (!SIGNED.test(value)) return phrase('result.problem.change')
  if (Number(value.replace('−', '-').replace(',', '.')) === 0) return phrase('result.problem.zero')
  return null
}

export function resultHeld(draft: ResultDraft): Phrase | null {
  if (!draft.appointmentId && !draft.orderLineId) return phrase('result.held.what')
  for (const entry of Object.values(draft.changes)) if (changeProblem(entry.change)) return phrase('result.held.changes')
  if (draft.verdict === 'ALTER' && draft.days.trim() && !/^\d{1,3}$/.test(draft.days.trim())) return phrase('result.held.days')
  if (draft.notes.length > FITTING_LIMITS.notes) return phrase('form.problem.tooLong', { max: FITTING_LIMITS.notes })
  return null
}

export function resultBodyOf(draft: ResultDraft, record: Pick<ProfileRecord, 'latestId'>, points: readonly FormPoint[]) {
  const pointChanges: Record<string, { change: string; unit?: 'cm' | 'mm'; note?: string }> = {}
  for (const [code, entry] of Object.entries(draft.changes)) {
    const text = entry.change.trim().replace('−', '-').replace(',', '.')
    if (!text) continue
    const unit = points.find((point) => point.code === code)?.unit
    pointChanges[code] = { change: /^[+-]/.test(text) ? text : `+${text}`, ...(unit === 'cm' || unit === 'mm' ? { unit } : {}), ...(entry.note.trim() ? { note: entry.note.trim() } : {}) }
  }
  return {
    ...(draft.appointmentId ? { appointmentId: draft.appointmentId } : {}),
    ...(draft.orderLineId ? { salesOrderLineId: draft.orderLineId } : {}),
    ...(draft.orderLineId ? {} : { measurementProfileId: record.latestId }),
    verdict: draft.verdict,
    pointChanges,
    ...(draft.notes.trim() ? { notes: draft.notes.trim() } : {}),
    ...(draft.verdict === 'ALTER' && draft.days.trim() ? { alterationDays: Number(draft.days.trim()) } : {}),
  }
}

/** A refused result in our words; a point's change refused names its point. */
export function resultProblem(error: unknown, points: readonly FormPoint[]): Phrase {
  if (isApiError(error) && error.kind === 'invalid') {
    const path = error.issues.map(issuePath).find((entry) => /pointChanges/.test(entry))
    if (path) {
      const code = path.replace(/^body[./]/, '').split(/[./]/)[1] ?? ''
      return phrase('result.problem.point', { point: points.find((point) => point.code === code)?.name ?? code })
    }
    return phrase('problem.invalid')
  }
  return writeProblem(error)
}

/** What comes next after a fitting, in words (never the API's `next`). */
export function nextOf(result: FittingResult): Phrase | null {
  if (result.verdict === 'OK') return phrase('fit.next.ok')
  if (result.verdict === 'ALTER') return result.alteration ? phrase('fit.next.altered', { number: result.alteration.number }) : result.orderLine ? phrase('fit.next.alter') : phrase('fit.next.alterNoLine')
  return result.newProfile ? phrase('fit.next.remakeReturn', { revision: result.newProfile.revision }) : phrase('fit.next.remakeMeasure')
}

/** "The date moved by its time": the order line's promise now → by the alteration. */
export const promiseMove = (result: FittingResult): { from: string; to: string } | null => (result.promise?.current && result.promise.byAlteration && result.promise.current !== result.promise.byAlteration ? { from: result.promise.current, to: result.promise.byAlteration } : null)

/** The alteration's receipt: the date moved, or why not (from the facts only). */
export function alteredNotice(answer: { repair: { number: string }; promise: { moved: boolean; from: string | null; to: string | null } }): Notice {
  if (answer.promise.moved && answer.promise.from && answer.promise.to) return { key: 'result.altered.moved', params: { number: answer.repair.number, from: answer.promise.from, to: answer.promise.to }, tone: 'success' }
  return { key: 'result.altered.notMoved', params: { number: answer.repair.number }, tone: 'success' }
}

// ---- a unit on a new quote ("Use in a new quote") and a repeat order (SAL-300) -------------------------------------------

export interface QuoteDraft {
  readonly styleId: string
  readonly colourwayId: string
  readonly baseSize: string
}

export const EMPTY_QUOTE_DRAFT: QuoteDraft = Object.freeze({ styleId: '', colourwayId: '', baseSize: '' })

/** Why the unit cannot go on a new quote yet (the style's check says made-to-measure has not started, PRD-017). */
export function quoteHeld(draft: QuoteDraft, check: MtmCheck | null, context: { can: MtmCan; offline: boolean; companyId: string | null }): Phrase | null {
  if (!context.can.quotes) return rightHeld('quotes')
  if (context.offline) return phrase('held.offline')
  if (!context.companyId) return phrase('held.company')
  if (!draft.styleId) return phrase('quote.held.style')
  if (!draft.colourwayId) return phrase('quote.held.colourway')
  if (check && !check.rulesOn) return phrase('off.template', { template: check.template.code })
  if (check) {
    const findings = styleFindingsOf(check)
    if (findings.length > 0) return findings[0]!
  }
  return null
}

/** The repeat order: on the newest revision; old measures ask "order on these measures anyway?" first. */
export function repeatHeld(facts: RepeatFacts | null, measuredOk: boolean, context: { can: MtmCan; offline: boolean; companyId: string | null }): Phrase | null {
  if (!context.can.quotes) return rightHeld('quotes')
  if (context.offline) return phrase('held.offline')
  if (!context.companyId) return phrase('held.company')
  if (!facts) return phrase('held.reading')
  if (facts.earlier.length === 0) return phrase('repeat.held.noEarlier')
  if (facts.latest.old && !measuredOk) return phrase('repeat.held.old', { months: facts.latest.months })
  return null
}

// ---- the photos (SAL-286) --------------------------------------------------------------------------------------------

export const PHOTO_VIEWS = ['FRONT', 'SIDE', 'BACK'] as const

/** The revisions that came with photos, newest first, each with its three views (a missing view is said). */
export function photoSets(revisions: readonly SentRevision[]): Array<{ revision: SentRevision; views: Array<{ view: (typeof PHOTO_VIEWS)[number]; fileId: string | null; status: string | null }> }> {
  return [...revisions]
    .sort((a, b) => b.revision - a.revision)
    .filter((revision) => revision.photos.length > 0)
    .map((revision) => ({ revision, views: PHOTO_VIEWS.map((view) => { const photo = revision.photos.find((entry) => entry.view === view); return { view, fileId: photo?.fileId ?? null, status: photo?.status ?? null } }) }))
}

export function deleteDayHeld(day: string, reason: string, today: string): Phrase | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return phrase('photos.held.day')
  if (day < today) return phrase('photos.held.past')
  if (!reason.trim()) return phrase('photos.held.reason')
  return null
}

// ---- proofs (the rider's quotes) -----------------------------------------------------------------------------------------

export interface ProofLine {
  readonly key: string
  readonly quoteId: string
  readonly number: string
  readonly revision: number
  readonly name: string
  readonly shape: 'PDF' | 'PICTURE'
  readonly state: 'READY' | 'UPLOADING' | 'CHECKING' | 'REFUSED'
  readonly shared: boolean
  readonly sentAt: string | null
  /** Who accepted it on the link, and when (null: not accepted yet). */
  readonly accepted: { readonly signer: string | null; readonly at: string } | null
}

/** The proofs of the rider's quotes, newest version first, each with whether the customer accepted it on the link. */
export function proofLines(quotes: ReadonlyArray<{ number: string; proofs: QuoteProofs }>): ProofLine[] {
  return quotes.flatMap(({ number, proofs }) =>
    [...proofs.versions]
      .sort((a, b) => b.revision - a.revision)
      .flatMap((version) =>
        version.proofs.map((proof) => ({
          key: `${proofs.quoteId}:${version.versionId}:${proof.fileId}`,
          quoteId: proofs.quoteId,
          number,
          revision: version.revision,
          name: proof.name,
          shape: proof.shape,
          state: proof.state,
          shared: proof.sharedWithCustomer,
          sentAt: version.sentAt,
          accepted: version.accepted && version.accepted.proofs.some((entry) => entry.fileId === proof.fileId) ? { signer: version.accepted.signerName, at: version.accepted.acceptedAt } : null,
        })),
      ),
  )
}

/** The quotes the rider's units are on (each once), for the Proofs tab. */
export const unitQuotes = (units: readonly Unit[]): Array<{ id: string; number: string }> => [...new Map(units.filter((unit) => unit.kind === 'QUOTE').map((unit) => [unit.documentId, { id: unit.documentId, number: unit.number }])).values()]

// ---- the record's activity ----------------------------------------------------------------------------------------------

export interface ActivityStep {
  readonly key: string
  readonly label: Phrase
  readonly tone: NoticeTone | 'neutral'
  readonly at: string
  readonly detail: Phrase | null
}

/** What happened to the rider's garment type, newest first: each revision recorded or sent, its review, the worksheets, the units. */
export function activityOf(record: ProfileRecord): ActivityStep[] {
  const steps: ActivityStep[] = []
  for (const revision of record.revisions) {
    steps.push({
      key: `rev-${revision.id}`,
      label: revision.byLink ? phrase('activity.sent', { revision: revision.revision }) : phrase('activity.recorded', { revision: revision.revision, by: revision.measuredBy?.name ?? revision.takenBy }),
      tone: 'info',
      at: revision.submittedAt ?? revision.createdAt,
      detail: revision.measuredPlace ? phrase('activity.where', { place: revision.measuredPlace }) : null,
    })
    if (revision.review.status !== 'WAITING' && revision.review.at)
      steps.push({
        key: `review-${revision.id}`,
        label: phrase(revision.review.status === 'CONFIRMED' ? 'activity.confirmed' : 'activity.needMore', { revision: revision.revision, by: revision.review.by?.name ?? '' }),
        tone: revision.review.status === 'CONFIRMED' ? 'success' : 'warning',
        at: revision.review.at,
        detail: null,
      })
  }
  for (const sheet of record.worksheets) steps.push({ key: `sheet-${sheet.id}`, label: phrase('activity.worksheet', { version: sheet.version, revision: sheet.revision }), tone: 'neutral', at: sheet.createdAt, detail: sheet.createdBy ? phrase('activity.by', { name: sheet.createdBy }) : null })
  for (const unit of record.units) steps.push({ key: `unit-${unit.lineId}`, label: phrase(unit.kind === 'QUOTE' ? 'activity.quoteUnit' : 'activity.orderUnit', { number: unit.number, revision: unit.revision }), tone: 'neutral', at: unit.at, detail: phrase('activity.style', { style: unit.style.code, colourway: unit.colourway.code }) })
  return steps.sort((a, b) => b.at.localeCompare(a.at))
}

// ---- small helpers -----------------------------------------------------------------------------------------------------

/** Today as a business day (Europe/Rome), never the UTC slice of an instant. */
export const todayOf = (now: string | Date = new Date()): string => businessDate(typeof now === 'string' ? new Date(now) : now)

export const REVIEWS = REVIEW_STATUSES
export const LINE_CODES = MTM_LINE_CODES

/** The units made to an older revision than the newest (the Orders tab says "a newer revision exists"). */
export const latestRevisionOf = (record: Pick<ProfileRecord, 'revisions'>): number => record.revisions[0]?.revision ?? 0
