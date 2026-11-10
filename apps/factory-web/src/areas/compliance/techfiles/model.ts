import { GARMENT_ZONES } from '@nexus/factory-domain/quality/defects/rules'
import {
  ANNEX_III_POINTS,
  EVIDENCE_FILE_RECORD_TYPES,
  FREQUENCIES,
  HAZARDS,
  PACK_CONTENTS,
  PACK_LINK_DAYS_MAX,
  PACK_LIMITS,
  RESIDUAL_RISKS,
  TECHNICAL_FILE_STATUSES,
  TEST_KINDS,
  ZONE_CODE,
  type AnnexIIIPoint,
  type AssessmentStatus,
  type BatchState,
  type Frequency,
  type Hazard,
  type ItemState,
  type PackContent,
  type PackPurpose,
  type PackScopeKind,
  type PackStatus,
  type PlanState,
  type PointState,
  type ResidualRisk,
  type RetentionState,
  type TechnicalFileStatus,
  type TestKind,
  type TestResult,
} from '@nexus/factory-domain/compliance/techfiles/rules'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { Tone } from '../../quality/_shared/model'
import { LIST_TILES, type Assessment, type EvidenceState, type FileSummary, type Item, type ListTile, type Pack, type Report, type RiskRow, type Tiles } from './api'

/**
 * Compliance › Technical files (SCR-120, B-W2b-269): the pure rules of the list, the record and its pop-ups, so the tests hold
 * them — who may do what (the API decides again), the list's address, the tiles, what a cell says, why a button is held, the
 * garment zones of the risk assessment, the drafts of the pop-ups and their problems, and a refusal in our words. Every word is
 * a key of the `compliance-techfiles` catalogue: never the API's English.
 */

export const NAMESPACE = 'compliance-techfiles'
/** The catalogues every techfiles view reads: its own, the list frame's and the quality words (record frame, step-up). */
export const NAMESPACES = [NAMESPACE, 'lists', 'quality', 'records'] as const

// ---- reads ----------------------------------------------------------------------------------------------------------------

export type Read<T> = { readonly status: 'loading' } | { readonly status: 'ready'; readonly value: T } | { readonly status: 'error'; readonly problem: string }
export const LOADING = Object.freeze({ status: 'loading' }) as Read<never>
export const ready = <T>(value: T): Read<T> => ({ status: 'ready', value })
export const failed = <T>(problem: string): Read<T> => ({ status: 'error', problem })
export const valueOf = <T>(read: Read<T> | null | undefined): T | null => (read && read.status === 'ready' ? read.value : null)

/** A failed call in our words (a key of this catalogue), from its kind; never the API's English. */
export function problemOf(error: unknown): string {
  if (!isApiError(error)) return 'problem.unavailable'
  switch (error.kind) {
    case 'signed_out':
      return 'problem.signedOut'
    case 'forbidden':
      return 'problem.forbidden'
    case 'step_up':
      return 'problem.stepUp'
    case 'not_found':
      return 'problem.notFound'
    case 'conflict':
      return 'problem.conflict'
    case 'invalid':
      return 'problem.invalid'
    case 'rate_limited':
      return 'problem.rateLimited'
    case 'contract':
      return 'problem.contract'
    default:
      return 'problem.unavailable'
  }
}

/**
 * A refusal's lines as the API wrote them (a 409 in words: the open points of a file it cannot complete, "kept until …"): the
 * API's sentences are data under our title, as the quality screens show a gate's facts.
 */
export function refusalDetail(error: unknown): string[] {
  if (!isApiError(error)) return []
  return error.issues.map((entry) => entry.message ?? '').filter((message) => message.trim() !== '' && message !== error.message)
}

/** The API's issue paths of a 400 (which fields it refused). */
export function refusedFields(error: unknown): string[] {
  if (!isApiError(error) || error.kind !== 'invalid') return []
  return error.issues.map((entry) => issuePath(entry).replace(/^body[./]/, '').split(/[./]/)[0] ?? '').filter(Boolean)
}

// ---- who may ----------------------------------------------------------------------------------------------------------------

export const TECHFILES_PERMISSIONS = {
  view: 'compliance.certificates.view',
  manage: 'compliance.techfiles.manage',
  sign: 'compliance.techfiles.sign',
  share: 'compliance.techfiles.share',
  filesRead: 'files.read',
  filesUpload: 'files.upload',
  threads: 'threads.read',
  parties: 'parties.view',
  stylesView: 'styles.view',
  workOrders: 'workorders.view',
  inspections: 'quality.inspections.view',
  shipping: 'shipping.view',
} as const

export type TechfilesAbility = keyof typeof TECHFILES_PERMISSIONS
export type TechfilesCan = Readonly<Record<TechfilesAbility, boolean>>

export function techfilesCan(permissions: readonly string[]): TechfilesCan {
  const held = new Set(permissions)
  return Object.fromEntries(Object.entries(TECHFILES_PERMISSIONS).map(([name, permission]) => [name, held.has(permission)])) as unknown as TechfilesCan
}

// ---- the list's address ---------------------------------------------------------------------------------------------------

export interface ListAddress {
  readonly status: TechnicalFileStatus | null
  readonly q: string
  readonly tile: ListTile | null
  /** `?new=1`: New technical file is open. */
  readonly add: boolean
  /** `?pack=<fileId>`: Build evidence pack for that row's file. */
  readonly pack: string | null
}

export const EMPTY_ADDRESS: ListAddress = Object.freeze({ status: null, q: '', tile: null, add: false, pack: null })

export function listAddressOf(params: Pick<URLSearchParams, 'get'> | null | undefined): ListAddress {
  const status = params?.get('status') ?? ''
  const tile = params?.get('tile') ?? ''
  return {
    status: (TECHNICAL_FILE_STATUSES as readonly string[]).includes(status) ? (status as TechnicalFileStatus) : null,
    q: (params?.get('q') ?? '').slice(0, 100),
    tile: (LIST_TILES as readonly string[]).includes(tile) ? (tile as ListTile) : null,
    add: params?.get('new') === '1',
    pack: params?.get('pack') || null,
  }
}

/** The list's address terms (a saved view keeps them). */
export function listSearch(address: ListAddress): string {
  const search = new URLSearchParams()
  if (address.status) search.set('status', address.status)
  if (address.q.trim()) search.set('q', address.q.trim())
  if (address.tile) search.set('tile', address.tile)
  if (address.add) search.set('new', '1')
  if (address.pack) search.set('pack', address.pack)
  const text = search.toString()
  return text ? `?${text}` : ''
}

export const isFiltered = (address: ListAddress): boolean => !!(address.status || address.q.trim() || address.tile)

// ---- the tiles ----------------------------------------------------------------------------------------------------------------

export type TileId = 'complete' | 'itemsMissing' | 'batches' | 'retention' | 'authority'

export interface TileView {
  readonly id: TileId
  /** The API's saved filter behind the tile. */
  readonly tile: ListTile
  readonly value: number | null
  /** A second number said in the hint (items missing in all; files on legal hold). */
  readonly second: number | null
  /** The tile asks for attention (danger accent) when it counts anything. */
  readonly alarm: boolean
}

export const TILE_OF: Readonly<Record<TileId, ListTile>> = Object.freeze({
  complete: 'COMPLETE',
  itemsMissing: 'ITEMS_MISSING',
  batches: 'BATCHES_WITHOUT_EVIDENCE',
  retention: 'RETENTION_ENDING',
  authority: 'AUTHORITY_PACKS',
})

/** The five tiles (design sec:tf-metrics), each a saved filter; null values while the list is read. */
export function tilesOf(tiles: Tiles | null): TileView[] {
  return [
    { id: 'complete', tile: 'COMPLETE', value: tiles?.complete ?? null, second: null, alarm: false },
    { id: 'itemsMissing', tile: 'ITEMS_MISSING', value: tiles?.withItemsMissing ?? null, second: tiles?.itemsMissing ?? null, alarm: (tiles?.withItemsMissing ?? 0) > 0 },
    { id: 'batches', tile: 'BATCHES_WITHOUT_EVIDENCE', value: tiles?.batchesWithoutEvidence ?? null, second: null, alarm: (tiles?.batchesWithoutEvidence ?? 0) > 0 },
    { id: 'retention', tile: 'RETENTION_ENDING', value: tiles?.retentionEndingInYear ?? null, second: tiles?.onLegalHold ?? null, alarm: false },
    { id: 'authority', tile: 'AUTHORITY_PACKS', value: tiles?.authorityPacksSentThisYear ?? null, second: null, alarm: false },
  ]
}

/** The tile a list address shows as pressed. */
export const tileOfAddress = (address: ListAddress): TileId | null => (Object.entries(TILE_OF).find(([, tile]) => tile === address.tile)?.[0] as TileId | undefined) ?? null

// ---- words and tones ------------------------------------------------------------------------------------------------------------

export const FILE_TONE: Readonly<Record<TechnicalFileStatus, Tone | 'neutral'>> = { OPEN: 'info', COMPLETE: 'success', ARCHIVED: 'neutral' }
export const ITEM_TONE: Readonly<Record<ItemState, Tone | 'neutral'>> = { MISSING: 'danger', LINKED: 'warning', REVIEWED: 'success', NOT_APPLICABLE: 'neutral' }
export const POINT_TONE: Readonly<Record<PointState, Tone | 'neutral'>> = { NONE: 'danger', MISSING: 'danger', LINKED: 'warning', REVIEWED: 'success', NOT_APPLICABLE: 'neutral' }
export const ASSESSMENT_TONE: Readonly<Record<AssessmentStatus, Tone | 'neutral'>> = { DRAFT: 'warning', SIGNED: 'success', SUPERSEDED: 'neutral' }
export const PACK_TONE: Readonly<Record<PackStatus, Tone | 'neutral'>> = { BUILDING: 'info', BUILT: 'success', FAILED: 'danger' }
export const PLAN_TONE: Readonly<Record<PlanState, Tone | 'neutral'>> = { OVERDUE: 'danger', DUE_SOON: 'warning', PLANNED: 'info', EVERY_BATCH: 'neutral', ON_CHANGE: 'neutral', DONE: 'success' }
export const BATCH_TONE: Readonly<Record<BatchState, Tone | 'neutral'>> = { COMPLETE: 'success', MISSING: 'warning', FAILED: 'danger', IN_PROGRESS: 'info' }
export const RESULT_TONE: Readonly<Record<TestResult, Tone>> = { PASS: 'success', FAIL: 'danger' }
export const RESIDUAL_TONE: Readonly<Record<ResidualRisk, Tone | 'neutral'>> = { NEGLIGIBLE: 'success', LOW: 'success', MEDIUM: 'warning', HIGH: 'danger' }
export const RETENTION_TONE: Readonly<Record<RetentionState, Tone | 'neutral'>> = { NOT_SET: 'neutral', KEPT: 'neutral', ENDS_WITHIN_YEAR: 'warning', MAY_GO: 'info' }
export const EVIDENCE_TONE: Readonly<Record<EvidenceState, Tone | 'neutral'>> = { CURRENT: 'success', DRAFT: 'warning', SUPERSEDED: 'warning', WITHDRAWN: 'danger', EXPIRED: 'danger', SUSPENDED: 'danger', GONE: 'danger' }

/** "9 of 13" in numbers (the words come from the catalogue) and the bar's percent and tone. */
export function annexBar(annex: FileSummary['annex']): { percent: number; tone: 'complete' | 'partial' | 'missing' } {
  const percent = annex.outOf > 0 ? Math.round((annex.done / annex.outOf) * 100) : 0
  return { percent, tone: annex.done >= annex.outOf ? 'complete' : annex.missingItems > 0 ? 'missing' : 'partial' }
}

/** The production-control cell: batches with evidence / batches made, and its tone (failed beats missing). */
export function productionTone(production: FileSummary['production']): Tone | 'neutral' {
  if (production.made === 0) return 'neutral'
  if (production.failed > 0) return 'danger'
  if (production.missing > 0) return 'warning'
  return production.withEvidence >= production.made ? 'success' : 'info'
}

/** The point's letter as the law writes it: "(b)". */
export const letterOf = (point: AnnexIIIPoint): string => `(${point.charAt(0).toLowerCase()})`

/** A record type in our words (a key `recordType.<Type>`, else the general word). */
export const RECORD_TYPE_WORDS: readonly string[] = EVIDENCE_FILE_RECORD_TYPES
export const recordTypeKey = (type: string | null | undefined): string => (type && RECORD_TYPE_WORDS.includes(type) ? `recordType.${type}` : 'recordType.other')

/** Evidence that is no longer in force: the key of its words (never the API's sentence). */
export const staleKey = (state: EvidenceState): string | null => (state === 'CURRENT' ? null : `evidence.stale.${state}`)

/** The test kind a report row's title names ("seam strength (zip pull)" → SEAM_STRENGTH and "zip pull"), else null. */
export function reportKind(report: Pick<Report, 'source' | 'title'>): { test: TestKind; name: string | null } | null {
  if (report.source !== 'CONTROL_TEST') return null
  const title = report.title.toLowerCase()
  const test = [...TEST_KINDS].sort((a, b) => b.length - a.length).find((kind) => title.startsWith(kind.replace(/_/g, ' ').toLowerCase()))
  if (!test) return null
  const named = /\((.+)\)\s*$/.exec(report.title)
  return { test, name: named?.[1] ?? null }
}

// ---- the record's actions ------------------------------------------------------------------------------------------------------

export const RECORD_TABS = ['annex', 'risk', 'tests', 'production', 'pack', 'activity'] as const
export type RecordTab = (typeof RECORD_TABS)[number]

/** Why the file cannot be changed now (a key), or null: an OPEN file, a person who manages, online. */
export function fileWriteHeld(status: TechnicalFileStatus, can: Pick<TechfilesCan, 'manage'>, online: boolean): string | null {
  if (!can.manage) return 'held.manage'
  if (!online) return 'held.offline'
  if (status === 'COMPLETE') return 'held.complete'
  if (status === 'ARCHIVED') return 'held.archived'
  return null
}

/** Complete: an OPEN file whose every point is reviewed or not applicable (and whose certificate is named when it must be). */
export function completeHeld(record: { file: Pick<FileSummary, 'status'>; completeProblems: readonly unknown[] }, can: Pick<TechfilesCan, 'manage'>, online: boolean): string | null {
  const held = fileWriteHeld(record.file.status, can, online)
  if (held) return held === 'held.complete' ? 'held.alreadyComplete' : held
  return record.completeProblems.length > 0 ? 'held.openPoints' : null
}

export const reopenHeld = (status: TechnicalFileStatus, can: Pick<TechfilesCan, 'manage'>, online: boolean): string | null =>
  !can.manage ? 'held.manage' : !online ? 'held.offline' : status !== 'COMPLETE' ? 'held.notComplete' : null

export const archiveHeld = (status: TechnicalFileStatus, can: Pick<TechfilesCan, 'manage'>, online: boolean): string | null =>
  !can.manage ? 'held.manage' : !online ? 'held.offline' : status === 'ARCHIVED' ? 'held.archived' : null

export type ItemAction = 'link' | 'review' | 'unreview' | 'notApplicable' | 'clear' | 'remove'

/** Why one action on an Annex III row is held (a key), or null. The API decides again. */
export function itemActionHeld(action: ItemAction, item: Pick<Item, 'state' | 'evidence'>, writeHeld: string | null, rowsOfPoint: number): string | null {
  if (writeHeld) return writeHeld
  switch (action) {
    case 'review':
      return item.state === 'LINKED' && item.evidence ? null : item.state === 'REVIEWED' ? 'held.reviewed' : item.state === 'NOT_APPLICABLE' ? 'held.isNa' : 'held.noEvidence'
    case 'unreview':
      return item.state === 'REVIEWED' || item.state === 'NOT_APPLICABLE' ? null : 'held.notReviewed'
    case 'notApplicable':
      return item.state === 'NOT_APPLICABLE' ? 'held.alreadyNa' : null
    case 'clear':
      return item.state === 'MISSING' ? 'held.nothingToClear' : null
    case 'remove':
      return rowsOfPoint <= 1 ? 'held.lastRow' : null
    default:
      return null
  }
}

/** The state an "undo the review" goes back to: LINKED with evidence, else MISSING. */
export const unreviewState = (item: Pick<Item, 'evidence'>): ItemState => (item.evidence ? 'LINKED' : 'MISSING')

/** A note that says why a point does not apply (the API wants at least 3 characters). */
export const naNoteProblem = (note: string): string | null => (note.trim().length < 3 ? 'problem.naNote' : note.trim().length > 2000 ? 'problem.noteLong' : null)
/** A reason to reopen or archive (3 to 500 characters). */
export const reasonProblem = (reason: string): string | null => (reason.trim().length < 3 ? 'problem.reason' : reason.trim().length > 500 ? 'problem.reasonLong' : null)

// ---- garment zones (the risk assessment's GarmentZoneMap) -------------------------------------------------------------------------

/** A zone of the map (GARMENT_ZONES ids, upper case) as the risk row keeps it (`^[a-z][a-z0-9_-]{0,39}$`). */
export const zoneCodeOf = (zone: string | null): string | null => (zone ? zone.toLowerCase() : null)
/** A row's zone code back to a zone of the map (null: none, or a code the map does not draw: said as it is). */
export function zoneIdOf(code: string | null | undefined): string | null {
  if (!code) return null
  const id = code.toUpperCase()
  return GARMENT_ZONES.some((zone) => zone.id === id) ? id : null
}
export const isZoneCode = (code: string): boolean => ZONE_CODE.test(code)

/** The marks of the map: how many hazards each zone holds (rows without a zone stand for the whole garment). */
export function zoneMarks(rows: readonly Pick<RiskRow, 'garmentZone'>[]): { zone: string; value: number }[] {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const zone = zoneIdOf(row.garmentZone)
    if (zone) counts.set(zone, (counts.get(zone) ?? 0) + 1)
  }
  return [...counts.entries()].map(([zone, value]) => ({ zone, value }))
}

/** The revision a risk tab shows: the asked one, else the draft, else the newest. */
export function shownAssessment(assessments: readonly Assessment[], asked: string | null): Assessment | null {
  if (asked) {
    const found = assessments.find((entry) => entry.id === asked)
    if (found) return found
  }
  return assessments.find((entry) => entry.status === 'DRAFT') ?? [...assessments].sort((a, b) => b.revision - a.revision)[0] ?? null
}

/** Why the risk assessment cannot change now (a key): only a DRAFT of an open file, by a person who manages. */
export function riskWriteHeld(assessment: Pick<Assessment, 'status'> | null, fileStatus: TechnicalFileStatus, can: Pick<TechfilesCan, 'manage'>, online: boolean): string | null {
  if (!can.manage) return 'held.manage'
  if (!online) return 'held.offline'
  if (fileStatus === 'ARCHIVED') return 'held.archived'
  if (!assessment) return 'held.noRevision'
  if (assessment.status === 'SIGNED') return 'held.signed'
  if (assessment.status === 'SUPERSEDED') return 'held.superseded'
  return null
}

/** Start the next revision: none is a draft now, the file is not archived. */
export function newRevisionHeld(assessments: readonly Pick<Assessment, 'status'>[], fileStatus: TechnicalFileStatus, can: Pick<TechfilesCan, 'manage'>, online: boolean): string | null {
  if (!can.manage) return 'held.manage'
  if (!online) return 'held.offline'
  if (fileStatus === 'ARCHIVED') return 'held.archived'
  return assessments.some((entry) => entry.status === 'DRAFT') ? 'held.draftExists' : null
}

/** Sign: a draft with at least one hazard, by a person who may sign (a fresh code is asked when it is pressed). */
export function signHeld(assessment: Pick<Assessment, 'status' | 'rows'> | null, fileStatus: TechnicalFileStatus, can: Pick<TechfilesCan, 'sign'>, online: boolean): string | null {
  if (!can.sign) return 'held.sign'
  if (!online) return 'held.offline'
  if (fileStatus === 'ARCHIVED') return 'held.archived'
  if (!assessment || assessment.status !== 'DRAFT') return 'held.noDraft'
  return assessment.rows.length === 0 ? 'held.noHazards' : null
}

export type RiskCell = 'hazard' | 'garmentZone' | 'intendedUse' | 'foreseeableMisuse' | 'control' | 'standardClause' | 'residualRisk' | 'hazardNote'
export const RISK_TEXT_MAX: Readonly<Record<'intendedUse' | 'foreseeableMisuse' | 'control' | 'standardClause' | 'hazardNote', number>> = { intendedUse: 2000, foreseeableMisuse: 2000, control: 2000, standardClause: 100, hazardNote: 300 }

/** A cell typed in the hazards grid: its problem (a key) before anything is sent, or null. */
export function riskCellProblem(cell: RiskCell, value: string): string | null {
  const text = value.trim()
  if (cell === 'hazard') return (HAZARDS as readonly string[]).includes(text) ? null : 'problem.hazard'
  if (cell === 'residualRisk') return (RESIDUAL_RISKS as readonly string[]).includes(text) ? null : 'problem.residual'
  if (cell === 'garmentZone') return text === '' || isZoneCode(text) ? null : 'problem.zone'
  if ((cell === 'intendedUse' || cell === 'control') && text === '') return 'problem.required'
  return text.length > RISK_TEXT_MAX[cell] ? 'problem.tooLong' : null
}

/** A new hazard row: the first hazard not in the revision yet, the zone picked on the map, the rest typed after. */
export function newRiskRow(rows: readonly Pick<RiskRow, 'hazard'>[], zone: string | null, words: { intendedUse: string; control: string }): { hazard: Hazard; garmentZone: string | null; intendedUse: string; control: string; residualRisk: ResidualRisk } {
  const used = new Set(rows.map((row) => row.hazard))
  return { hazard: HAZARDS.find((hazard) => !used.has(hazard)) ?? 'OTHER', garmentZone: zoneCodeOf(zone), intendedUse: words.intendedUse, control: words.control, residualRisk: 'LOW' }
}

/** The signer's typed name and function (1 to 200 characters each). */
export function signProblems(input: { name: string; fn: string }): string[] {
  const problems: string[] = []
  if (!input.name.trim() || input.name.trim().length > 200) problems.push('problem.signName')
  if (!input.fn.trim() || input.fn.trim().length > 200) problems.push('problem.signFunction')
  return problems
}

// ---- production control -------------------------------------------------------------------------------------------------------

export interface ScheduleDraft {
  test: TestKind
  testName: string
  frequency: Frequency
  dueOn: string
  workOrderId: string | null
  batchNumber: string
  standardClause: string
  sample: string
}

export const emptySchedule = (today: string, test: TestKind = 'SEAM_STRENGTH', workOrderId: string | null = null): ScheduleDraft => ({ test, testName: '', frequency: workOrderId ? 'EVERY_BATCH' : 'YEARLY', dueOn: today, workOrderId, batchNumber: '', standardClause: '', sample: '' })

export function scheduleProblems(draft: ScheduleDraft): string[] {
  const problems: string[] = []
  if (!(TEST_KINDS as readonly string[]).includes(draft.test)) problems.push('problem.test')
  if (draft.test === 'OTHER' && !draft.testName.trim()) problems.push('problem.testName')
  if (!(FREQUENCIES as readonly string[]).includes(draft.frequency)) problems.push('problem.frequency')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.dueOn)) problems.push('problem.dueOn')
  if (draft.testName.trim().length > 200 || draft.standardClause.trim().length > 100 || draft.sample.trim().length > 500 || draft.batchNumber.trim().length > 60) problems.push('problem.tooLong')
  return problems
}

export interface RecordDraft {
  result: TestResult | null
  testedOn: string
  testedBy: string
  reportNumber: string
  resultNote: string
  /** The lab report chosen on this device (uploaded as a file of the test when Record is pressed). */
  file: { name: string; size: number; type: string } | null
}

export const emptyRecord = (today: string): RecordDraft => ({ result: null, testedOn: today, testedBy: '', reportNumber: '', resultNote: '', file: null })

export function recordProblems(draft: RecordDraft, today: string): string[] {
  const problems: string[] = []
  if (!draft.result) problems.push('problem.result')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.testedOn)) problems.push('problem.testedOn')
  else if (draft.testedOn > today) problems.push('problem.testedFuture')
  if (!draft.testedBy.trim()) problems.push('problem.testedBy')
  if (draft.file && !['application/pdf', 'image/jpeg', 'image/png'].includes(draft.file.type)) problems.push('problem.labReportType')
  if (draft.testedBy.trim().length > 200 || draft.reportNumber.trim().length > 100 || draft.resultNote.trim().length > 2000) problems.push('problem.tooLong')
  return problems
}

/** "3 days overdue" / "due in 12 days" / "due today": the whole days from today to a due day (negative: overdue). */
export function daysUntil(day: string, today: string): number {
  const a = Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)))
  const b = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)))
  return Math.round((b - a) / 86_400_000)
}

/** A day (YYYY-MM-DD) as the instant the DS Countdown runs to: the end of that day in Rome (≈ 22:00 UTC). */
export const dueInstant = (day: string): string => `${day}T22:00:00.000Z`

// ---- evidence packs ----------------------------------------------------------------------------------------------------------------

export interface PackDraft {
  purpose: PackPurpose
  language: string
  recipient: string
  recipientPartyId: string | null
  scope: PackScopeKind
  batchNumbers: string
  serialFrom: string
  serialTo: string
  shipmentId: string
  include: PackContent[]
  note: string
}

/** The pop-up's first state: an authority pack of the whole style in the page's language, every kind of document on. */
export const emptyPack = (language: string, latestBatch: string | null = null): PackDraft => ({
  purpose: 'AUTHORITY',
  language,
  recipient: '',
  recipientPartyId: null,
  scope: latestBatch ? 'BATCHES' : 'STYLE',
  batchNumbers: latestBatch ?? '',
  serialFrom: '',
  serialTo: '',
  shipmentId: '',
  include: [...PACK_CONTENTS],
  note: '',
})

/** The batch numbers typed (one per line or comma), without blanks or repeats. */
export const batchList = (text: string): string[] => [...new Set(text.split(/[\n,;]+/).map((entry) => entry.trim()).filter(Boolean))]

export function packProblems(draft: PackDraft): string[] {
  const problems: string[] = []
  if (!/^[a-z]{2,3}$/.test(draft.language)) problems.push('problem.language')
  if (!draft.recipient.trim() || draft.recipient.trim().length > 300) problems.push('problem.recipient')
  if (draft.include.length === 0) problems.push('problem.include')
  if (draft.scope === 'BATCHES') {
    const numbers = batchList(draft.batchNumbers)
    if (numbers.length === 0 || numbers.length > PACK_LIMITS.batchNumbers) problems.push('problem.batches')
    if (numbers.some((number) => number.length > 60)) problems.push('problem.batchLong')
  }
  if (draft.scope === 'SERIALS') {
    if (!draft.serialFrom.trim() || !draft.serialTo.trim()) problems.push('problem.serials')
    else if (draft.serialFrom.trim().toUpperCase() > draft.serialTo.trim().toUpperCase()) problems.push('problem.serialOrder')
  }
  if (draft.scope === 'SHIPMENT' && !draft.shipmentId.trim()) problems.push('problem.shipment')
  if (draft.note.trim().length > 2000) problems.push('problem.noteLong')
  return problems
}

/** The request the API takes from a draft. */
export function packBody(draft: PackDraft) {
  return {
    purpose: draft.purpose,
    language: draft.language,
    recipient: draft.recipient.trim(),
    recipientPartyId: draft.recipientPartyId,
    scope: {
      kind: draft.scope,
      ...(draft.scope === 'BATCHES' ? { batchNumbers: batchList(draft.batchNumbers) } : {}),
      ...(draft.scope === 'SERIALS' ? { serialFrom: draft.serialFrom.trim(), serialTo: draft.serialTo.trim() } : {}),
      ...(draft.scope === 'SHIPMENT' ? { shipmentId: draft.shipmentId.trim() } : {}),
    },
    include: PACK_CONTENTS.filter((kind) => draft.include.includes(kind)),
    note: draft.note.trim() || null,
  }
}

/** The languages offered for a pack (EU market surveillance authorities); any other ISO 639 code can be typed. */
export const PACK_LANGUAGES = ['it', 'en', 'de', 'fr', 'es', 'nl', 'pt', 'pl', 'cs', 'sv', 'da', 'fi', 'el', 'ro', 'hu', 'sk', 'sl', 'hr', 'bg', 'et', 'lv', 'lt', 'ga', 'mt'] as const

export interface ShareDraft {
  /** Who gets the link (the pack's recipient party when it names one). */
  partyId: string | null
  email: string
  password: string
  expiresOn: string
  send: boolean
  language: 'it' | 'en'
  message: string
}

export const emptyShare = (today: string, language: 'it' | 'en', partyId: string | null = null): ShareDraft => ({ partyId, email: '', password: '', expiresOn: addDays(today, 30), send: true, language, message: '' })

/** The link's password rules (factory-domain links/password LINK_PASSWORD: 8 to 128 characters). */
export const LINK_PASSWORD_MIN = 8
export const LINK_PASSWORD_MAX = 128

export function shareProblems(draft: ShareDraft, today: string): string[] {
  const problems: string[] = []
  if (!draft.partyId) problems.push('problem.noParty')
  if (draft.password.length < LINK_PASSWORD_MIN || draft.password.length > LINK_PASSWORD_MAX) problems.push('problem.password')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.expiresOn) || draft.expiresOn < today || draft.expiresOn > addDays(today, PACK_LINK_DAYS_MAX)) problems.push('problem.expiresOn')
  if (draft.send && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim())) problems.push('problem.email')
  if (draft.message.trim().length > 2000) problems.push('problem.tooLong')
  return problems
}

export function addDays(day: string, days: number): string {
  const date = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) + days))
  return date.toISOString().slice(0, 10)
}

/** Why a pack's link cannot be made now (a key): a BUILT pack with its PDF, a person who may share, online. */
export function shareHeld(pack: Pick<Pack, 'status' | 'pdf' | 'may'>, can: Pick<TechfilesCan, 'share'>, online: boolean): string | null {
  if (!can.share || !pack.may.share) return 'held.share'
  if (!online) return 'held.offline'
  return pack.status !== 'BUILT' || !pack.pdf ? 'held.notBuilt' : null
}

export const removePackHeld = (pack: Pick<Pack, 'may' | 'status'>, online: boolean): string | null => (!online ? 'held.offline' : pack.may.remove ? null : pack.status === 'BUILT' ? 'held.packKept' : 'held.packBuilding')

/** Build a pack: a person who manages, online (an archived file still answers an authority). */
export const buildHeld = (can: Pick<TechfilesCan, 'manage'>, online: boolean): string | null => (!can.manage ? 'held.manage' : !online ? 'held.offline' : null)

/** A link still opens (not withdrawn, not expired). */
export const linkLive = (link: Pick<Pack['links'][number], 'revokedAt' | 'expiresAt' | 'state'>, now: Date): boolean => !link.revokedAt && Date.parse(link.expiresAt) > now.getTime() && link.state !== 'REVOKED' && link.state !== 'EXPIRED' && link.state !== 'USED'

/** The fingerprint shortened for a row ("3f9a…c21e"); the whole one is the title. */
export const shortHash = (hash: string | null | undefined): string => (hash ? (hash.length > 12 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash) : '—')

/** The newest pack first; a building one first of all. */
export const packsInOrder = (packs: readonly Pack[]): Pack[] => [...packs].sort((a, b) => (a.status === 'BUILDING') !== (b.status === 'BUILDING') ? (a.status === 'BUILDING' ? -1 : 1) : b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))

// ---- the windows' addresses ----------------------------------------------------------------------------------------------------

export const listAddress = (prefix: string): string => `${prefix}/compliance/techfiles`
export const recordAddress = (prefix: string, fileId: string, tab?: RecordTab, extra?: Record<string, string>): string => {
  const search = new URLSearchParams()
  if (tab) search.set('tab', tab)
  for (const [key, value] of Object.entries(extra ?? {})) search.set(key, value)
  const text = search.toString()
  return `${prefix}/compliance/techfiles/${encodeURIComponent(fileId)}${text ? `?${text}` : ''}`
}
/** SCR-326 the pack's PDF (a new tab). */
export const packWindowAddress = (prefix: string, packId: string): string => `${prefix}/compliance/techfiles/pack?pack=${encodeURIComponent(packId)}`
/** SCR-327 what the authority sees on the link (a new tab). */
export const authorityAddress = (prefix: string, packId: string): string => `${prefix}/compliance/techfiles/pack/link?pack=${encodeURIComponent(packId)}`

// ---- the list's export (this view as CSV) ----------------------------------------------------------------------------------------

export const CSV_COLUMNS = ['number', 'style', 'status', 'certificates', 'annex', 'risk', 'tests', 'production', 'lastChange', 'keeper', 'keptUntil'] as const

/** The rows as the grid says them, in the page's words (a translator in, so the test can hold it). */
export function csvRows(rows: readonly FileSummary[], t: (key: string, params?: Record<string, string | number>) => string, day: (value: string | null) => string): string[][] {
  return rows.map((row) => [
    row.number,
    `${row.style.code} ${row.style.name}`,
    t(`status.${row.status}`),
    t('cell.certificates', { valid: row.certificates.valid, all: row.certificates.all }),
    t('cell.annex', { done: row.annex.done, outOf: row.annex.outOf }),
    row.risk ? t('cell.risk', { revision: row.risk.revision, status: t(`assessment.${row.risk.status}`) }) : t('cell.noRisk'),
    t('cell.tests', { count: row.testReports.count }),
    t('cell.production', { withEvidence: row.production.withEvidence, made: row.production.made }),
    day(row.lastChangeAt),
    row.keeper?.name ?? '',
    day(row.retainUntil),
  ])
}

/** Today in Rome (YYYY-MM-DD): the API's days are the site's. */
export function romeToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** Which Annex III points a record type usually proves (the evidence finder's own grouping). */
export const POINTS = ANNEX_III_POINTS

/** The points still open (not reviewed, not "not applicable"), as the law writes their letters: "(b), (e)". */
export function openPointLetters(points: readonly { readonly point: AnnexIIIPoint; readonly state: PointState }[]): string[] {
  return points.filter((entry) => entry.state !== 'REVIEWED' && entry.state !== 'NOT_APPLICABLE').map((entry) => letterOf(entry.point))
}

/** Category II and III need a certificate named before the file is complete (PPE Reg. Annex V / VII). */
export const needsCertificate = (ppeCategory: string): boolean => ppeCategory === 'CATEGORY_II' || ppeCategory === 'CATEGORY_III'

/** Why Complete is held, in words: the open points, else the certificate the category needs, else the general rule. */
export function completeHeldWords(
  record: { file: Pick<FileSummary, 'status' | 'certificate' | 'style'>; points: readonly { readonly point: AnnexIIIPoint; readonly state: PointState }[]; completeProblems: readonly unknown[] },
  can: Pick<TechfilesCan, 'manage'>,
  online: boolean,
): { key: string; params?: Record<string, string | number> } | null {
  const held = completeHeld(record, can, online)
  if (!held) return null
  if (held !== 'held.openPoints') return { key: held }
  const open = openPointLetters(record.points)
  if (open.length > 0) return { key: 'held.openPointsList', params: { count: open.length, points: open.join(', ') } }
  if (needsCertificate(record.file.style.ppeCategory) && !record.file.certificate) return { key: 'held.certificateNeeded' }
  return { key: 'held.openPoints' }
}
