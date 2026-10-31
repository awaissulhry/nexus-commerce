import { HOLD_LIMITS, HOLD_SOURCE_TYPES, HOLD_SUBJECT_TYPES, STOCK_SUBJECTS, type HoldSourceType, type HoldSubjectType, type ReleaseCheckKey } from '@nexus/factory-domain/quality/holds/rules'
import type { LiveState, Notice, QualityCan, Read } from '../_shared/model'
import type { Hold, HoldCheck, HoldCounts, HoldDetail, HoldPreview, HoldSettings, HoldSettingsAnswer, HoldsQuery, PlaceBody, Person } from './api'

/**
 * The rules of Quality › Holds (SCR-078) without React and without the API: the saved views and their address (the
 * API's own filters), the tiles, a hold in our words (its kind, what it blocks, who placed it, the quarantine move),
 * the release checks in our words, what a person may do with one hold or with several (held with the reason before the
 * click), the place dialog's draft and its problems, CSV. Message keys are the `holds` catalogue's. The API's words
 * (BLOCKS, the checks' sentences, the preview's problems) are English: they are shown under ours, as data.
 */

// ---- views and tiles ----------------------------------------------------------------------------------------------------

export const VIEWS = ['open', 'mine', 'overdue', 'system', 'quarantine', 'released', 'closed', 'all'] as const
export type View = (typeof VIEWS)[number]

/** The tiles: each a saved view; its count from GET /quality/holds/counts. (No "value on hold": the API serves none.) */
export const TILES = ['open', 'overdue', 'system', 'mine', 'quarantine'] as const satisfies readonly View[]
export type TileId = (typeof TILES)[number]
export const TILE_COUNT: Readonly<Record<TileId, keyof HoldCounts>> = Object.freeze({ open: 'open', overdue: 'overdue', system: 'system', mine: 'mine', quarantine: 'waitingQuarantine' })

/** A page of the list shown; "Show more" adds a page (the API answers at most 200 rows and has no cursor). */
export const PAGE = 50
export const MAX = 200
export const nextLimit = (limit: number): number => Math.min(MAX, limit + PAGE)

export const RECORD_TABS = ['hold', 'decision', 'activity'] as const
export type RecordTab = (typeof RECORD_TABS)[number]

type Params = { get(name: string): string | null } | null | undefined

/**
 * The view an address asks for: `?view=`, else the API's own filters a link may carry (Today, LIST_PAGES):
 * `?status=RELEASED|CLOSED|ALL`, `?overdue=true`, `?system=true`, `?quarantine=ASKED`, `?ownerId=me`; else Open.
 */
export function viewFromAddress(params: Params): View {
  const asked = params?.get('view')
  if (asked && (VIEWS as readonly string[]).includes(asked)) return asked as View
  const status = params?.get('status')
  if (status === 'RELEASED') return 'released'
  if (status === 'CLOSED') return 'closed'
  if (status === 'ALL') return 'all'
  if (params?.get('overdue') === 'true') return 'overdue'
  if (params?.get('system') === 'true') return 'system'
  if (params?.get('quarantine') === 'ASKED') return 'quarantine'
  if (params?.get('ownerId') === 'me') return 'mine'
  return 'open'
}

/** One record's holds (Q3: any record's holds are reached here) and one kind: read from the address. */
export function scopeFromAddress(params: Params): { subjectType: HoldSubjectType | null; subjectId: string | null } {
  const type = params?.get('subjectType') ?? null
  const id = params?.get('subjectId') ?? null
  return { subjectType: type && (HOLD_SUBJECT_TYPES as readonly string[]).includes(type) ? (type as HoldSubjectType) : null, subjectId: id && /^[0-9a-f-]{36}$/i.test(id) ? id : null }
}

/** The API's filters of a view. */
export function queryOf(view: View, scope: { subjectType: HoldSubjectType | null; subjectId: string | null }): HoldsQuery {
  const base = { subjectType: scope.subjectType, subjectId: scope.subjectId }
  switch (view) {
    case 'open':
      return { ...base, status: 'ACTIVE' }
    case 'mine':
      return { ...base, status: 'ACTIVE', ownerId: 'me' }
    case 'overdue':
      return { ...base, status: 'ACTIVE', overdue: true }
    case 'system':
      return { ...base, status: 'ACTIVE', system: true }
    case 'quarantine':
      return { ...base, status: 'ACTIVE', quarantine: 'ASKED' }
    case 'released':
      return { ...base, status: 'RELEASED' }
    case 'closed':
      return { ...base, status: 'CLOSED' }
    case 'all':
      return { ...base, status: 'ALL' }
  }
}

/** The page's address: the view, the record the list is narrowed to, the hold open in its DetailModal and its tab. */
export function holdsAddress(state: { view: View; subjectType?: HoldSubjectType | null; subjectId?: string | null; open?: string | null; tab?: RecordTab | null }): string {
  const query = new URLSearchParams()
  if (state.view !== 'open') query.set('view', state.view)
  if (state.subjectType) query.set('subjectType', state.subjectType)
  if (state.subjectId) query.set('subjectId', state.subjectId)
  if (state.open) query.set('open', state.open)
  if (state.open && state.tab && state.tab !== 'hold') query.set('tab', state.tab)
  const qs = query.toString()
  return qs ? `?${qs}` : ''
}

export const tabFromAddress = (params: Params): RecordTab => {
  const asked = params?.get('tab') ?? ''
  return (RECORD_TABS as readonly string[]).includes(asked) ? (asked as RecordTab) : 'hold'
}

// ---- a hold in words ------------------------------------------------------------------------------------------------------

/** "lot" / "lots" (plural key with `count`). */
export const nounKey = (type: HoldSubjectType): string => `noun.${type}`

/** The kind at the start of a name ("Lot DEMO-LOT-0231"). */
export const kindKey = (type: HoldSubjectType): string => `kind.${type}`

/** What a hold of this kind blocks, in our words (the database's triggers; factory-domain BLOCKS). */
export const blocksKey = (type: HoldSubjectType): string => `blocks.${type}`

/** The held records' codes: the first ones and "+N" (a code unknown to the reader is "—"). */
export function subjectCodes(hold: Pick<Hold, 'subjects'>, shown = 2): { codes: string[]; more: number } {
  const codes = hold.subjects.slice(0, shown).map((subject) => subject.label ?? '—')
  return { codes, more: Math.max(0, hold.subjects.length - shown) }
}

/** Who placed the hold: you, someone in the office, someone at the bench, or the system (never a name in a list: W1). */
export function placedByKey(hold: Pick<Hold, 'placedBy'>, me: string): string {
  if (hold.placedBy.kind === 'SYSTEM') return 'placedBy.system'
  if (hold.placedBy.kind === 'WORKER') return 'placedBy.bench'
  return hold.placedBy.userId === me ? 'placedBy.you' : 'placedBy.office'
}

/** Who released it, in the same words. */
export function releasedByKey(hold: Pick<Hold, 'releasedBy'>, me: string): string | null {
  if (!hold.releasedBy) return null
  if (hold.releasedBy.kind === 'WORKER') return 'placedBy.bench'
  return hold.releasedBy.userId === me ? 'placedBy.you' : 'placedBy.office'
}

/** The owner in words: "you", an office user by name, or nobody. */
export function ownerWords(hold: Pick<Hold, 'owner' | 'ownerId'>, me: string): { key: string; params?: Record<string, string> } {
  if (!hold.ownerId) return { key: 'owner.nobody' }
  if (hold.ownerId === me) return { key: 'owner.you' }
  return hold.owner?.name ? { key: 'owner.name', params: { name: hold.owner.name } } : { key: 'owner.someone' }
}

/** B-W2b-17: the hold's number as printed ("HLD-2026-0091"); "—" for a hold placed before holds were numbered. */
export const numberText = (hold: Pick<Hold, 'number'>): string => hold.number ?? '—'

/** The hold's state: active (overdue said), released, closed in its NCR. */
export function statusOf(hold: Pick<Hold, 'status' | 'overdue'>): { key: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' } {
  if (hold.status === 'RELEASED') return { key: 'status.RELEASED', tone: 'success' }
  if (hold.status === 'CLOSED') return { key: 'status.CLOSED', tone: 'neutral' }
  return hold.overdue ? { key: 'status.OVERDUE', tone: 'danger' } : { key: 'status.ACTIVE', tone: 'warning' }
}

/** The quarantine move: moved, asked (not confirmed), not needed. */
export const quarantineKey = (hold: Pick<Hold, 'quarantine'>): string => `quarantine.${hold.quarantine}`

/** The record that caused the hold, in words: its kind (or "placed by hand"). */
export function sourceKey(hold: Pick<Hold, 'sourceType'>): string {
  return hold.sourceType && (HOLD_SOURCE_TYPES as readonly string[]).includes(hold.sourceType) ? `source.${hold.sourceType}` : hold.sourceType ? 'source.other' : 'source.manual'
}

/** The record types of the held records (their own pages through RECORD_PAGES / the record panel route). */
export const SUBJECT_RECORD: Readonly<Record<HoldSubjectType, string>> = Object.freeze({
  Lot: 'Lot',
  Hide: 'Hide',
  WorkOrder: 'WorkOrder',
  Bundle: 'Bundle',
  GarmentSerial: 'GarmentSerial',
  Shipment: 'Shipment',
  Parcel: 'Parcel',
})

/** The source's record type for its link (a reversal is reviewed on its release; a lab result on its lot is not known here). */
export const SOURCE_RECORD: Readonly<Record<HoldSourceType, string>> = Object.freeze({
  Inspection: 'Inspection',
  Nonconformance: 'Nonconformance',
  LabResult: 'LabResult',
  Certificate: 'Certificate',
  QualityReleaseReversal: 'QualityReleaseReversal',
  Complaint: 'Complaint',
})

/** The reason in the reader's language: the HOLD list's words, else the API's (English) words. */
export function reasonText(hold: Pick<Hold, 'reasonCode' | 'reason'>, reasons: ReadonlyMap<string, { labelIt: string; labelEn: string }>, locale: string): string {
  const found = reasons.get(hold.reasonCode)
  if (!found) return hold.reason
  return locale === 'it' ? found.labelIt || found.labelEn : found.labelEn || found.labelIt
}

/**
 * The quantity on hold in the reader's words: the API says it in English ("412.0000 FT2 + 30 garments"); an amount with
 * its unit stays as data, garments become our words (`quantity.garments` with the count). Null: nothing counted.
 */
export function quantityWords(text: string | null, t: (key: string, params?: Record<string, string | number>) => string): string | null {
  if (!text) return null
  return text
    .split(' + ')
    .map((part) => {
      const garments = /^(\d+) garments?$/.exec(part.trim())
      return garments ? t('quantity.garments', { count: Number(garments[1]) }) : part.trim()
    })
    .join(' + ')
}

// ---- the release checks -----------------------------------------------------------------------------------------------------

/** A check in our words: its name, and the line for "met" or "open" (the API's sentence goes under it as data). */
export const checkNameKey = (key: ReleaseCheckKey): string => `check.${key}.name`
export const checkLineKey = (key: ReleaseCheckKey, ok: boolean): string => `check.${key}.${ok ? 'ok' : 'open'}`

/** True when the reader placed this hold themself (an office user: the floor's worker is never the office reader). */
export const placedByMe = (hold: Pick<Hold, 'placedBy'>, me: string): boolean => hold.placedBy.kind === 'USER' && hold.placedBy.userId === me

/**
 * B-W2b-17: a check's line for this reader. "Another person" met although the reader placed the hold means the company's
 * rule lets the placer release (QualitySettings.placerMayRelease): said as such, never as "someone else placed it".
 */
export function checkLineKeyFor(check: Pick<HoldCheck, 'key' | 'ok'>, hold: Pick<Hold, 'placedBy'>, me: string, placerMayRelease: boolean): string {
  if (check.key === 'NOT_PLACER' && check.ok && placerMayRelease && placedByMe(hold, me)) return 'check.NOT_PLACER.placerMay'
  return checkLineKey(check.key, check.ok)
}

/** B-W2b-17: the four-eyes rule line of the Decision tab: the company's rule on who releases. */
export const whoRuleKey = (detail: Pick<HoldDetail, 'release'>): string => (detail.release.placerMayRelease ? 'decision.who.rulePlacerMay' : 'decision.who.rule')

/** The first check that holds the release (STATEMENT is signed inside the dialog: it never holds the button). */
export function firstOpenCheck(detail: Pick<HoldDetail, 'release'>): ReleaseCheckKey | null {
  return detail.release.checks.find((check) => !check.ok && check.key !== 'STATEMENT')?.key ?? null
}

/** The release asks the signed statement "I made none of the held garments" (the floor's records name stations only). */
export const needsStatement = (detail: Pick<HoldDetail, 'release'>): boolean => detail.release.checks.some((check) => check.key === 'STATEMENT')

// ---- what this person may do (held with the reason before the click) ---------------------------------------------------------

/** Releasing ONE hold: the reason it is held now (a `holds` key with params), or null. `detail`: its checks when read. */
export function releaseHeld(hold: Pick<Hold, 'status'>, detail: Pick<HoldDetail, 'release'> | null, can: Pick<QualityCan, 'holdsRelease'>): { key: string; params?: Record<string, string | number> } | null {
  if (!can.holdsRelease) return { key: 'held.noRelease' }
  if (hold.status !== 'ACTIVE') return { key: 'held.notActive' }
  if (detail && !detail.release.mayRelease) return { key: 'held.noReleaseHere' }
  const open = detail ? firstOpenCheck(detail) : null
  if (open) return { key: `held.check.${open}` }
  return null
}

/** Changing a hold (owner, expected release, notes). */
export function changeHeld(hold: Pick<Hold, 'status'>, can: Pick<QualityCan, 'holdsPlace'>): string | null {
  if (!can.holdsPlace) return 'held.noPlace'
  if (hold.status !== 'ACTIVE') return 'held.notActive'
  return null
}

/**
 * Releasing SEVERAL holds (the API has no bulk route: one release each, the code asked once). Held when the person may
 * not release, when a picked hold is not active, while their checks are read, or when one fails its checks (named).
 */
export function bulkReleaseHeld(
  picked: readonly Pick<Hold, 'id' | 'status' | 'subjects' | 'subjectType'>[],
  details: Readonly<Record<string, Pick<HoldDetail, 'release'>>>,
  can: Pick<QualityCan, 'holdsRelease'>,
): { key: string; params?: Record<string, string | number> } | null {
  if (!can.holdsRelease) return { key: 'held.noRelease' }
  if (picked.length === 0) return { key: 'held.pickFirst' }
  const inactive = picked.filter((hold) => hold.status !== 'ACTIVE')
  if (inactive.length > 0) return { key: 'held.bulkNotActive', params: { count: inactive.length } }
  if (picked.some((hold) => !details[hold.id])) return { key: 'held.bulkChecking' }
  const blocked = picked.filter((hold) => {
    const detail = details[hold.id]!
    return !detail.release.mayRelease || firstOpenCheck(detail) !== null
  })
  if (blocked.length > 0) {
    const first = blocked[0]!
    const check = firstOpenCheck(details[first.id]!)
    return { key: 'held.bulkCheck', params: { count: blocked.length, code: first.subjects[0]?.label ?? '—', check: check ?? 'ACTIVE' } }
  }
  return null
}

/** Assigning an owner to several holds: one site's holds at a time (the owner picker is per site). */
export function bulkAssignHeld(picked: readonly Pick<Hold, 'status' | 'siteId'>[], can: Pick<QualityCan, 'holdsPlace'>): string | null {
  if (!can.holdsPlace) return 'held.noPlace'
  if (picked.some((hold) => hold.status !== 'ACTIVE')) return 'held.assignNotActive'
  if (new Set(picked.map((hold) => hold.siteId)).size > 1) return 'held.assignSites'
  return null
}

/** Where a held lot or hide is traced both ways (Warehouse › Lots & traceability); other kinds: the reason. */
export function traceOf(prefix: string, hold: Pick<Hold, 'subjectType' | 'subjects'>): { href: string | null; held: string | null } {
  const first = hold.subjects[0]
  if (!first) return { href: null, held: 'held.traceNone' }
  if (hold.subjectType === 'Lot') return { href: `${prefix}/warehouse/lots/${encodeURIComponent(first.id)}?tab=trace`, held: null }
  if (hold.subjectType === 'Hide') return { href: `${prefix}/warehouse/hides/${encodeURIComponent(first.id)}`, held: null }
  return { href: null, held: 'held.traceKind' }
}

/** The evidence trail of the held garments (a serial; a work order's batch); other kinds: the reason. */
export function evidenceOf(prefix: string, hold: Pick<Hold, 'subjectType' | 'subjects'>, detail: Pick<HoldDetail, 'workOrders'> | null): { href: string | null; held: string | null } {
  const first = hold.subjects[0]
  if (hold.subjectType === 'GarmentSerial' && first?.label) return { href: `${prefix}/compliance/evidence/serial/${encodeURIComponent(first.label)}`, held: null }
  if (hold.subjectType === 'WorkOrder') {
    const batch = detail?.workOrders.find((order) => order.batchNumber)?.batchNumber ?? null
    if (batch) return { href: `${prefix}/compliance/evidence/batch/${encodeURIComponent(batch)}`, held: null }
    return { href: null, held: detail ? 'held.evidenceNoBatch' : 'held.evidenceOpen' }
  }
  return { href: null, held: 'held.evidenceKind' }
}

/** The hold tag's address (a new tab): one hold, or several with `?ids=`. */
export function tagAddress(prefix: string, ids: readonly string[]): string | null {
  if (ids.length === 0) return null
  const first = encodeURIComponent(ids[0]!)
  return ids.length === 1 ? `${prefix}/quality/holds/${first}/tag` : `${prefix}/quality/holds/${first}/tag?ids=${ids.map(encodeURIComponent).join(',')}`
}

// ---- the place dialog ---------------------------------------------------------------------------------------------------------

export interface PlaceHoldPrefill {
  subjectType: HoldSubjectType
  subjectIds?: readonly string[]
  codes?: readonly string[]
  sourceType?: HoldSourceType | null
  sourceId?: string | null
  reasonCode?: string | null
  fromLabel?: string | null
}

export interface PlaceDraft {
  readonly subjectType: HoldSubjectType
  /** Records named by id (a list's row verb). */
  readonly ids: readonly string[]
  /** Codes scanned or typed. */
  readonly codes: readonly string[]
  readonly reasonCode: string | null
  readonly reasonNote: string
  readonly ownerId: string | null
  /** A business day `YYYY-MM-DD`, or ''. */
  readonly expectedReleaseOn: string
  readonly askQuarantine: boolean
  readonly quarantineLocationId: string | null
  readonly note: string
  readonly sourceType: HoldSourceType | null
  readonly sourceId: string | null
  /** "From inspection INS-2026-0412" (said above the fields). */
  readonly fromLabel: string | null
}

export const isStock = (type: HoldSubjectType): boolean => STOCK_SUBJECTS.includes(type)

export function placeDraftOf(prefill: PlaceHoldPrefill | null): PlaceDraft {
  const subjectType = prefill?.subjectType ?? 'Lot'
  return {
    subjectType,
    ids: [...(prefill?.subjectIds ?? [])],
    codes: [...(prefill?.codes ?? [])],
    reasonCode: prefill?.reasonCode ?? null,
    reasonNote: '',
    ownerId: null,
    expectedReleaseOn: '',
    askQuarantine: isStock(subjectType),
    quarantineLocationId: null,
    note: '',
    sourceType: prefill?.sourceType ?? null,
    sourceId: prefill?.sourceType ? (prefill.sourceId ?? null) : null,
    fromLabel: prefill?.fromLabel ?? null,
  }
}

/** A new kind starts the records again (a hold is of one kind) and asks the move only for stock. */
export const withKind = (draft: PlaceDraft, subjectType: HoldSubjectType): PlaceDraft =>
  draft.subjectType === subjectType ? draft : { ...draft, subjectType, ids: [], codes: [], askQuarantine: isStock(subjectType), quarantineLocationId: null }

/** The records the preview found and may be held (each once). */
export const placeable = (preview: Pick<HoldPreview, 'subjects'> | null): string[] => [...new Set((preview?.subjects ?? []).flatMap((row) => (row.id && !row.problem ? [row.id] : [])))]

/** The place dialog's problems (message keys of `holds`), every one at once; the API checks the same again. */
export function placeProblems(
  draft: PlaceDraft,
  preview: Pick<HoldPreview, 'subjects' | 'quarantinePlaces'> | null,
  reasons: readonly { code: string; needsDetail: boolean }[],
  today: string,
): string[] {
  const problems: string[] = []
  if (draft.ids.length + draft.codes.length === 0) problems.push('place.problem.subjects')
  else if (draft.ids.length + draft.codes.length > HOLD_LIMITS.subjects) problems.push('place.problem.tooMany')
  else if (preview === null) problems.push('place.problem.previewing')
  else {
    if (preview.subjects.some((row) => row.problem)) problems.push('place.problem.records')
    if (placeable(preview).length === 0) problems.push('place.problem.nothing')
  }
  const reason = reasons.find((entry) => entry.code === draft.reasonCode)
  if (!draft.reasonCode || !reason) problems.push('place.problem.reason')
  else if (reason.needsDetail && !draft.reasonNote.trim()) problems.push('place.problem.reasonNote')
  if (draft.reasonNote.length > HOLD_LIMITS.reasonNote) problems.push('place.problem.reasonNoteLong')
  if (draft.note.length > HOLD_LIMITS.note) problems.push('place.problem.noteLong')
  if (draft.expectedReleaseOn && draft.expectedReleaseOn < today) problems.push('place.problem.date')
  if (draft.askQuarantine && isStock(draft.subjectType) && preview && preview.quarantinePlaces.length > 0 && !draft.quarantineLocationId) problems.push('place.problem.place')
  return problems
}

/** The body of POST /quality/holds from the draft and the preview's records. */
export function placeBody(draft: PlaceDraft, preview: Pick<HoldPreview, 'subjects' | 'quarantinePlaces'>): PlaceBody {
  const ask = draft.askQuarantine && isStock(draft.subjectType) && preview.quarantinePlaces.length > 0
  return {
    subjectType: draft.subjectType,
    subjectIds: placeable(preview),
    reasonCode: draft.reasonCode ?? '',
    reasonNote: draft.reasonNote.trim() || null,
    sourceType: draft.sourceType,
    sourceId: draft.sourceType ? draft.sourceId : null,
    ownerId: draft.ownerId,
    expectedReleaseOn: draft.expectedReleaseOn || null,
    askQuarantine: ask,
    quarantineLocationId: ask ? draft.quarantineLocationId : null,
    note: draft.note.trim() || null,
  }
}

/** The 400's issues by field (`body/reasonCode` → `reasonCode`; a record's `body/subjectIds/0` → `subjectIds`). */
export function fieldOf(path: string): string {
  const rest = path.startsWith('body/') ? path.slice(5) : path
  return rest.split('/')[0] ?? rest
}

/** The address terms that open the place dialog prefilled: `?new=1&kind=WorkOrder&ids=a,b&source=Inspection:<id>`. */
export function prefillFromAddress(params: Params): PlaceHoldPrefill | null {
  if (params?.get('new') !== '1') return null
  const kindAsked = params.get('kind')
  const subjectType = kindAsked && (HOLD_SUBJECT_TYPES as readonly string[]).includes(kindAsked) ? (kindAsked as HoldSubjectType) : 'Lot'
  const ids = (params.get('ids') ?? '').split(',').map((id) => id.trim()).filter((id) => /^[0-9a-f-]{36}$/i.test(id))
  const codes = (params.get('codes') ?? '').split(',').map((code) => code.trim()).filter(Boolean)
  const [sourceType, sourceId] = (params.get('source') ?? '').split(':')
  const source = sourceType && (HOLD_SOURCE_TYPES as readonly string[]).includes(sourceType) && sourceId && /^[0-9a-f-]{36}$/i.test(sourceId) ? { sourceType: sourceType as HoldSourceType, sourceId } : null
  return { subjectType, subjectIds: ids, codes, sourceType: source?.sourceType ?? null, sourceId: source?.sourceId ?? null, reasonCode: params.get('reason') ?? null }
}

/** The place dialog's model (one view model; the container reads the preview, the reasons and the people). */
export interface PlaceModel {
  readonly open: boolean
  readonly draft: PlaceDraft
  readonly preview: Read<HoldPreview> | null
  readonly reasons: Read<readonly { code: string; labelIt: string; labelEn: string; needsDetail: boolean }[]>
  readonly people: Read<readonly Person[]> | null
  /** The site's day (`YYYY-MM-DD`): the earliest expected release. */
  readonly today: string
  readonly busy: boolean
  /** A refusal: a `holds` key, the API's words under it, and the fields it names. */
  readonly problem: string | null
  readonly lines?: readonly string[]
  readonly fields?: readonly string[]
  /** Why placing is held for this person at all (no right): a `holds` key. */
  readonly held: string | null
}

// ---- notices and CSV ------------------------------------------------------------------------------------------------------------

/** A bulk outcome: N done, each refusal named with its record and our words. */
export function bulkNotice(done: number, refused: readonly { code: string; words: string }[], doneKey: string): Notice {
  if (refused.length === 0) return { key: doneKey, params: { count: done }, tone: 'success' }
  return { key: 'notice.bulkPartly', params: { done, refused: refused.length }, tone: done > 0 ? 'warning' : 'danger', detail: refused.map((entry) => `${entry.code}: ${entry.words}`) }
}

export const CSV_HEAD = ['csv.number', 'csv.kind', 'csv.records', 'csv.quantity', 'csv.reason', 'csv.status', 'csv.placedBy', 'csv.placedAt', 'csv.ageDays', 'csv.owner', 'csv.expected', 'csv.quarantine', 'csv.site'] as const

export function csvRow(hold: Hold, t: (key: string, params?: Record<string, string | number>) => string, reason: string, me: string): (string | number)[] {
  const owner = ownerWords(hold, me)
  return [
    hold.number ?? '',
    t(nounKey(hold.subjectType), { count: hold.subjects.length }),
    hold.subjects.map((subject) => subject.label ?? '—').join(' '),
    quantityWords(hold.quantity, t) ?? '',
    reason,
    t(statusOf(hold).key),
    t(placedByKey(hold, me)),
    hold.placedAt,
    hold.ageDays,
    t(owner.key, owner.params),
    hold.expectedReleaseOn ?? '',
    t(quarantineKey(hold)),
    hold.site?.code ?? '',
  ]
}

// ---- live ----------------------------------------------------------------------------------------------------------------------

/** The live events that change the list (quality.hold_placed / _released / _changed; a held work order's status). */
export const LIVE_EVENTS = ['quality.hold_', 'workorder.status_changed', 'ncr.hold_closed'] as const

// ---- the models the views draw ----------------------------------------------------------------------------------------------------

/** A cell being saved, saved, or refused (with our words). */
export interface CellMark {
  readonly state: 'saving' | 'saved' | 'refused'
  readonly problem?: string
}

export type HoldsDialog =
  | { kind: 'release'; ids: readonly string[] }
  | { kind: 'assign'; ids: readonly string[] }
  | { kind: 'shortcuts' }
  // B-W2b-17: who releases holds (the company's rule).
  | { kind: 'settings' }

// ---- B-W2b-17: who releases holds (design quality.settings qs-sod, qs-loosen) ------------------------------------------------

/** The settings dialog's choice: someone else releases (false), the placer may too (true), follow the tenant rule (null). */
export interface HoldSettingsDraft {
  readonly choice: boolean | null
  readonly reason: string
}

/** The draft from the company's own row (no own row: it follows the tenant-wide rule). */
export const settingsDraftOf = (settings: Pick<HoldSettings, 'own'>): HoldSettingsDraft => ({ choice: settings.own?.placerMayRelease ?? null, reason: '' })

export const settingsChanged = (settings: Pick<HoldSettings, 'own'>, draft: HoldSettingsDraft): boolean => (settings.own?.placerMayRelease ?? null) !== draft.choice

/**
 * Whether the draft lets the placer release where the rule in force does not (the looser rule: a reason and a fresh code).
 * "Follow the tenant rule" from a company's own row may loosen: the tenant's rule is known only when the company already
 * follows it (source TENANT or DEFAULT), else the reason is asked to be safe (the API decides).
 */
export function settingsLoosens(settings: Pick<HoldSettings, 'inForce' | 'own'>, draft: HoldSettingsDraft): boolean {
  if (!settingsChanged(settings, draft) || settings.inForce.placerMayRelease) return false
  if (draft.choice === true) return true
  if (draft.choice === false) return false
  return settings.inForce.source === 'COMPANY'
}

/** The least the reason says (the API's reasonProblem: factory-domain quality/final/rules REASON_MIN). */
export const SETTINGS_REASON_MIN = 3

/** Why Save is held (a `holds` key), or null. */
export function settingsHeld(answer: HoldSettingsAnswer | null, draft: HoldSettingsDraft | null, busy: boolean): string | null {
  if (!answer || !draft) return 'settings.held.reading'
  if (!answer.mayChange) return 'settings.held.noRight'
  if (busy) return 'settings.held.busy'
  if (!settingsChanged(answer.settings, draft)) return 'settings.held.nothing'
  if (settingsLoosens(answer.settings, draft) && draft.reason.trim().length < SETTINGS_REASON_MIN) return 'settings.held.reason'
  return null
}

/** The rule in force in words (a `holds` key) and where it comes from. */
export const settingsInForceKey = (settings: Pick<HoldSettings, 'inForce'>): string => (settings.inForce.placerMayRelease ? 'settings.inForce.placerMay' : 'settings.inForce.someoneElse')
export const settingsSourceKey = (settings: Pick<HoldSettings, 'inForce'>): string => `settings.source.${settings.inForce.source}`

export interface ReleaseDraft {
  readonly note: string
  readonly statement: boolean
}

export const RELEASE_DRAFT: ReleaseDraft = Object.freeze({ note: '', statement: false })

/** The release dialog's problems (holds keys). */
export function releaseProblems(draft: ReleaseDraft, details: readonly Pick<HoldDetail, 'release'>[]): string[] {
  const problems: string[] = []
  if (details.some(needsStatement) && !draft.statement) problems.push('release.problem.statement')
  if (draft.note.length > HOLD_LIMITS.note) problems.push('release.problem.noteLong')
  return problems
}

export interface HoldsListModel {
  readonly prefix: string
  readonly me: string
  readonly locale?: string
  readonly can: QualityCan
  /** The office's day (`YYYY-MM-DD`): the earliest expected release. */
  readonly today: string
  readonly view: View
  readonly subjectType: HoldSubjectType | null
  readonly subjectId: string | null
  readonly rows: Read<readonly Hold[]>
  readonly truncated: boolean
  /** The rows shown (pages of 50 of what was read, up to 200). */
  readonly limit: number
  readonly counts: Read<HoldCounts>
  readonly reasons: ReadonlyMap<string, { labelIt: string; labelEn: string }>
  /** The owner picker per site (read when an Owner cell takes the focus). */
  readonly people: Readonly<Record<string, Read<readonly Person[]>>>
  readonly cells: Readonly<Record<string, CellMark>>
  readonly asOf: string | null
  readonly live: LiveState
  readonly updates: number
  readonly selected: readonly string[]
  /** The selected holds' release checks (read when rows are selected, for "Release N" held before the click). */
  readonly details: Readonly<Record<string, HoldDetail>>
  readonly notice?: Notice | null
  readonly open?: { readonly id: string; readonly detail: Read<HoldDetail>; readonly tab: RecordTab } | null
  readonly dialog?: HoldsDialog | null
  readonly releaseDraft?: ReleaseDraft
  readonly assignTo?: string | null
  readonly busy?: boolean
  readonly dialogProblem?: string | null
  readonly dialogLines?: readonly string[]
  /** B-W2b-17: the number search (GET /quality/holds `q`). */
  readonly q?: string
  /** B-W2b-17: who releases holds — the company's rule, read when its dialog opens, and the dialog's draft. */
  readonly settings?: Read<HoldSettingsAnswer> | null
  readonly settingsDraft?: HoldSettingsDraft | null
  /** The company the settings are of (its name, in the dialog's subtitle). */
  readonly companyName?: string
  /** Design cases: the focused row, the quarantine popover open on a row. */
  readonly focusRow?: number
  readonly moveOpen?: string | null
}
