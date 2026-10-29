import { CHECK_CODES, crViVerdict, CR_VI_METHODS, LOT_DOCUMENT_KINDS, type CrViEvidence, type EvidenceRule, type LotDocumentKind } from '@nexus/factory-domain/quality/lab/rules'
import type { StepUpState } from '../../quality/_shared/hooks'
import { LIST_MAX, type Lot, type LotQuery, type LotStatus } from '../../quality/_shared/lots'
import type { LiveState, Notice, QualityCan, Read } from '../../quality/_shared/model'
import type { LabResult, LabSettings, LotDecision, LotDetail, RecordAnswer, WorkOrderUse } from './api'

/**
 * Tests & substances (SCR-054; design compliance.tests W1; B-W1-34 part 2) without React: the saved views and the tiles
 * (one filter model: a tile is a view), the address's filters, the Cr VI words of a lot and of a result being typed (the
 * domain's own `crViVerdict`, in this app's words), the held reasons of every action, the result and document drafts'
 * problems, the CSV of a view, and the view models of the list and the lot record. Pure.
 */

// ---- views and tiles ------------------------------------------------------------------------------------------------------

export const LOT_VIEWS = ['all', 'onHold', 'waiting', 'failed', 'quarantine', 'blocked', 'released', 'rejected'] as const
export type LotView = (typeof LOT_VIEWS)[number]

/** The tiles: named saved filters (pressing one shows its view; the count and the list agree). */
export const LOT_TILES = ['onHold', 'waiting', 'failed', 'released'] as const
export type LotTile = (typeof LOT_TILES)[number]

const STATUS_OF: Partial<Record<LotView, LotStatus>> = { quarantine: 'QUARANTINE', blocked: 'BLOCKED', released: 'RELEASED', rejected: 'REJECTED' }

/** Lots waiting for chromium VI evidence: in quarantine, the test needed and no result yet. */
export const isWaitingEvidence = (lot: Lot): boolean => lot.qualityStatus === 'QUARANTINE' && lot.crVi.required && lot.crVi.status === 'PENDING'
/** Lots whose Cr VI test failed and that are not rejected yet (quarantine or blocked). */
export const isFailedOnHold = (lot: Lot): boolean => (lot.qualityStatus === 'QUARANTINE' || lot.qualityStatus === 'BLOCKED') && lot.crVi.status === 'FAIL'

/** What the API is asked for a view (two views are filtered here from the lots on hold: the API has no such filter). */
export function viewQuery(view: LotView, q: string, limit: number): LotQuery {
  const query = q.trim()
  if (view === 'waiting' || view === 'failed') return { onHold: true, q: query || null, limit: LIST_MAX }
  if (view === 'onHold') return { onHold: true, q: query || null, limit }
  const status = STATUS_OF[view]
  return { ...(status ? { status } : {}), q: query || null, limit }
}

/** The rows of a view from what the API answered. */
export function viewRows(view: LotView, lots: readonly Lot[]): Lot[] {
  if (view === 'waiting') return lots.filter(isWaitingEvidence)
  if (view === 'failed') return lots.filter(isFailedOnHold)
  return [...lots]
}

/** Whether the view's list may hold more rows than were read ("Show more", up to LIST_MAX). */
export function hasMore(view: LotView, read: number, limit: number): boolean {
  if (view === 'waiting' || view === 'failed') return false
  return read >= limit && limit < LIST_MAX
}

/** Whether a view's read stopped at the largest page (its count is "at least"). */
export const capped = (read: number, limit: number): boolean => read >= limit && limit >= LIST_MAX

/** The view the address names: `?view=`, or the API's own filters (`?onHold=true`, `?status=RELEASED`) from a link. */
export function viewFromAddress(params: { get(name: string): string | null } | null | undefined): LotView {
  const asked = params?.get('view') ?? ''
  if ((LOT_VIEWS as readonly string[]).includes(asked)) return asked as LotView
  if (params?.get('onHold') === 'true') return 'onHold'
  const status = params?.get('status')
  const byStatus = Object.entries(STATUS_OF).find(([, value]) => value === status)
  return byStatus ? (byStatus[0] as LotView) : 'all'
}

/** One tile's count: unknown (null: the read failed), not read yet (undefined), or a number, "at least" when cut. */
export interface TileCount {
  readonly count: number | null | undefined
  readonly atLeast: boolean
}

/** The tiles' counts from the two reads they rest on: the lots on hold and the released lots (each up to LIST_MAX). */
export function tileCounts(onHold: readonly Lot[] | null, released: readonly Lot[] | null): Record<LotTile, TileCount> {
  const held = onHold === null ? null : onHold.length >= LIST_MAX
  return {
    onHold: { count: onHold === null ? null : onHold.length, atLeast: held === true },
    waiting: { count: onHold === null ? null : onHold.filter(isWaitingEvidence).length, atLeast: held === true },
    failed: { count: onHold === null ? null : onHold.filter(isFailedOnHold).length, atLeast: held === true },
    released: { count: released === null ? null : released.length, atLeast: released !== null && released.length >= LIST_MAX },
  }
}

// ---- Cr VI words ----------------------------------------------------------------------------------------------------------

/** The legal limit (REACH Annex XVII entry 47) when a lot names none. */
export const LEGAL_LIMIT = '3.000'

/** A mg/kg decimal string in the person's language, without trailing zeros ("1.2", "1,2"). */
export function mgKg(value: string | null, locale: string): string {
  if (value === null) return '—'
  const number = Number(value)
  if (!Number.isFinite(number)) return value
  return new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: 3 }).format(number)
}

export type CrViWord = 'NOT_REQUIRED' | 'PENDING' | 'PASS' | 'FAIL' | 'NOT_DETECTED'

/** A lot's Cr VI state as a word key (`crVi.<word>`): a PASS with no value was below the detection limit. */
export function crViWord(lot: Pick<Lot, 'crVi'>): CrViWord {
  if (!lot.crVi.required) return 'NOT_REQUIRED'
  if (lot.crVi.status === 'PASS' && lot.crVi.valueMgKg === null) return 'NOT_DETECTED'
  return lot.crVi.status === 'NOT_REQUIRED' ? 'NOT_REQUIRED' : lot.crVi.status
}

export const CR_VI_WORD_TONE: Record<CrViWord, 'success' | 'warning' | 'danger' | 'neutral'> = {
  NOT_REQUIRED: 'neutral',
  PENDING: 'warning',
  PASS: 'success',
  NOT_DETECTED: 'success',
  FAIL: 'danger',
}

/** The live verdict of a result being typed, as the API will compute it (factory-domain `crViVerdict`): our words' key and values. */
export type LiveVerdict =
  | { readonly kind: 'none' }
  | { readonly kind: 'pass'; readonly value: string; readonly limit: string }
  | { readonly kind: 'notDetected'; readonly lod: string; readonly limit: string }
  | { readonly kind: 'fail'; readonly value: string; readonly limit: string }
  | { readonly kind: 'problem'; readonly key: string; readonly lod?: string; readonly limit: string }

/** A decimal typed with a comma or a point. */
export const decimalText = (text: string): string => text.trim().replace(',', '.')

export function liveVerdict(draft: Pick<ResultDraft, 'valueMgKg' | 'belowDetectionLimit' | 'detectionLimitMgKg'>, limitMgKg: string | null): LiveVerdict {
  const limit = limitMgKg ?? LEGAL_LIMIT
  const value = decimalText(draft.valueMgKg)
  const lod = decimalText(draft.detectionLimitMgKg)
  if (!draft.belowDetectionLimit && value === '') return { kind: 'none' }
  if (draft.belowDetectionLimit && lod === '') return { kind: 'none' }
  const answer = crViVerdict(draft.belowDetectionLimit ? { belowDetectionLimit: true, detectionLimitMgKg: lod } : { valueMgKg: value }, limit)
  if (answer.verdict === null) {
    const path = answer.problems[0]?.path ?? 'valueMgKg'
    if (path === 'detectionLimitMgKg' && Number.isFinite(Number(lod)) && Number(lod) > Number(limit)) return { kind: 'problem', key: 'result.verdict.lodAbove', lod, limit }
    return { kind: 'problem', key: path === 'detectionLimitMgKg' ? 'result.verdict.lodInvalid' : 'result.verdict.valueInvalid', limit }
  }
  const verdict = answer.verdict
  if (verdict.belowDetectionLimit) return { kind: 'notDetected', lod: verdict.detectionLimitMgKg ?? lod, limit: verdict.limitMgKg }
  return verdict.verdict === 'PASS' ? { kind: 'pass', value: verdict.valueMgKg ?? value, limit: verdict.limitMgKg } : { kind: 'fail', value: verdict.valueMgKg ?? value, limit: verdict.limitMgKg }
}

// ---- held reasons ---------------------------------------------------------------------------------------------------------

/** Why recording a result is held (a message key), or null when it may be recorded. */
export function recordResultHeld(lot: Lot, can: QualityCan): string | null {
  if (!can.lotsTest) return 'held.test'
  if (!lot.crVi.required) return 'held.noTest'
  if (lot.qualityStatus === 'REJECTED') return 'held.rejected'
  if (lot.crVi.status === 'FAIL') return 'held.failFinal'
  return null
}

/** Why attaching a supplier document is held, or null. */
export function documentHeld(lot: Lot, can: QualityCan): string | null {
  if (!can.lotsDocuments) return 'held.documents'
  if (lot.qualityStatus === 'REJECTED') return 'held.rejected'
  return null
}

/** Why a decision is held (a message key, its params), or null when it may be taken. `me`: the viewer's user id. */
export function decisionHeld(decision: LotDecision, detail: Pick<LotDetail, 'lot' | 'checklist'>, can: QualityCan, me: string | null): { key: string; params?: Record<string, string | number> } | null {
  const { lot, checklist } = detail
  const receiver = me !== null && lot.receivedById === me
  switch (decision) {
    case 'release':
      if (!can.lotsRelease) return { key: 'held.release' }
      if (lot.qualityStatus !== 'QUARANTINE') return { key: 'held.notQuarantine' }
      if (receiver) return { key: 'held.receiver' }
      if (!checklist.ready) return { key: 'held.checksOpen', params: { count: checklist.open.length } }
      return null
    case 'unblock':
      if (!can.lotsRelease) return { key: 'held.release' }
      if (lot.qualityStatus !== 'BLOCKED') return { key: 'held.notBlocked' }
      if (!checklist.ready) return { key: 'held.checksOpen', params: { count: checklist.open.length } }
      return null
    case 'reject':
      if (!can.lotsReject) return { key: 'held.reject' }
      if (lot.qualityStatus !== 'QUARANTINE' && lot.qualityStatus !== 'BLOCKED') return { key: 'held.rejectState' }
      return null
    case 'block':
      if (!can.lotsReject) return { key: 'held.reject' }
      if (lot.qualityStatus !== 'RELEASED') return { key: 'held.blockState' }
      return null
    case 'clearHold':
      if (!can.lotsRelease) return { key: 'held.release' }
      if (lot.qualityStatus !== 'QUARANTINE' || !lot.hold) return { key: 'held.noHold' }
      if (receiver) return { key: 'held.holdOwn' }
      return null
  }
}

/** The decisions the record offers for the lot's state (others are not drawn: there is nothing to do). */
export function decisionsFor(lot: Lot): LotDecision[] {
  switch (lot.qualityStatus) {
    case 'QUARANTINE':
      return lot.hold ? ['release', 'clearHold', 'reject'] : ['release', 'reject']
    case 'BLOCKED':
      return ['unblock', 'reject']
    case 'RELEASED':
      return ['block']
    default:
      return []
  }
}

/** The band's primary decision for the state (null: none, the lot is final). */
export function primaryDecision(lot: Lot): LotDecision | null {
  if (lot.qualityStatus === 'QUARANTINE') return 'release'
  if (lot.qualityStatus === 'BLOCKED') return 'unblock'
  return null
}

/** The rule change loosens (a lab report for every lot → a supplier report counts): it asks the reason and a fresh code. */
export const loosens = (from: EvidenceRule, to: EvidenceRule): boolean => from === 'LOT_REPORT_REQUIRED' && to === 'SUPPLIER_REPORT_ACCEPTED'

/** Why changing the rule is held, or null. */
export const ruleHeld = (can: QualityCan): string | null => (can.settingsManage ? null : 'held.rule')

// ---- drafts ---------------------------------------------------------------------------------------------------------------

export interface ResultDraft {
  readonly method: string
  readonly valueMgKg: string
  readonly belowDetectionLimit: boolean
  readonly detectionLimitMgKg: string
  readonly lab: string
  readonly reportNumber: string
  readonly testedOn: string
  readonly evidence: CrViEvidence
  readonly article: string
  readonly periodFrom: string
  readonly periodTo: string
  readonly note: string
  /** The chosen report's name (the bytes stay in the container). */
  readonly fileName: string | null
  /** Release the lot right after (a second step that still asks for the typed code). */
  readonly thenRelease: boolean
}

export const blankResult = (today: string): ResultDraft => ({
  method: CR_VI_METHODS[1],
  valueMgKg: '',
  belowDetectionLimit: false,
  detectionLimitMgKg: '',
  lab: '',
  reportNumber: '',
  testedOn: today,
  evidence: 'LOT_REPORT',
  article: '',
  periodFrom: '',
  periodTo: '',
  note: '',
  fileName: null,
  thenRelease: false,
})

/** What a result draft lacks, field → message key (every problem at once; the API checks again). */
export function resultProblems(draft: ResultDraft, today: string, rule: EvidenceRule | null, limit: string | null): Record<string, string> {
  const problems: Record<string, string> = {}
  if (!(CR_VI_METHODS as readonly string[]).includes(draft.method)) problems.method = 'result.problem.method'
  const verdict = liveVerdict(draft, limit)
  if (verdict.kind === 'none') problems[draft.belowDetectionLimit ? 'detectionLimitMgKg' : 'valueMgKg'] = draft.belowDetectionLimit ? 'result.problem.lod' : 'result.problem.value'
  if (verdict.kind === 'problem') problems[draft.belowDetectionLimit ? 'detectionLimitMgKg' : 'valueMgKg'] = verdict.key
  if (draft.lab.trim() === '') problems.lab = 'result.problem.lab'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.testedOn)) problems.testedOn = 'result.problem.testedOn'
  else if (draft.testedOn > today) problems.testedOn = 'result.problem.testedOnFuture'
  if (draft.evidence === 'SUPPLIER_REPORT') {
    if (rule === 'LOT_REPORT_REQUIRED') problems.evidence = 'result.problem.ruleLotReport'
    if (draft.article.trim() === '') problems.article = 'result.problem.article'
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.periodFrom)) problems.periodFrom = 'result.problem.periodFrom'
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.periodTo)) problems.periodTo = 'result.problem.periodTo'
    else if (/^\d{4}-\d{2}-\d{2}$/.test(draft.periodFrom) && draft.periodFrom > draft.periodTo) problems.periodTo = 'result.problem.periodOrder'
  }
  if (draft.fileName === null) problems.file = 'result.problem.file'
  return problems
}

export interface DocumentDraft {
  readonly kind: LotDocumentKind
  readonly validTo: string
  readonly note: string
  readonly fileName: string | null
}

export const blankDocument = (): DocumentDraft => ({ kind: LOT_DOCUMENT_KINDS[0], validTo: '', note: '', fileName: null })

export function documentProblems(draft: DocumentDraft, today: string): Record<string, string> {
  const problems: Record<string, string> = {}
  if (draft.validTo !== '' && draft.validTo < today) problems.validTo = 'document.problem.expired'
  if (draft.kind === 'OTHER' && draft.note.trim() === '') problems.note = 'document.problem.note'
  if (draft.fileName === null) problems.file = 'document.problem.file'
  return problems
}

/** A reason a decision asks for: 3 to 500 characters. */
export function reasonProblem(text: string): string | null {
  const length = text.trim().length
  if (length === 0) return 'decide.problem.reason'
  if (length > 500) return 'decide.problem.reasonLong'
  return null
}

/** The typed code matches the lot's (spaces around it and letter case do not matter, as the API's `codeMatches`). */
export const codeMatches = (typed: string, code: string): boolean => typed.trim().toUpperCase() === code.trim().toUpperCase()

// ---- results ---------------------------------------------------------------------------------------------------------------

/** Newest first; a superseded result (a later FAIL replaced its PASS) is marked, never hidden. */
export const resultsNewestFirst = (results: readonly LabResult[]): LabResult[] => [...results].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))

/** The check names in the order the API lists them. */
export const CHECK_ORDER = CHECK_CODES

// ---- CSV -------------------------------------------------------------------------------------------------------------------

/** The CSV header and rows of lots (Export "This view (CSV)"): codes and values as the API gave them. */
export function lotsCsvRows(lots: readonly Lot[], header: readonly string[], words: { status: (lot: Lot) => string; crVi: (lot: Lot) => string; evidence: (lot: Lot) => string }): (string | null)[][] {
  return [
    [...header],
    ...lots.map((lot) => [
      lot.code,
      lot.item.code,
      lot.item.name,
      words.status(lot),
      words.crVi(lot),
      lot.crVi.valueMgKg,
      lot.crVi.limitMgKg,
      words.evidence(lot),
      lot.crVi.testedOn,
      lot.receivedAt ? lot.receivedAt.slice(0, 10) : null,
      lot.hold,
    ]),
  ]
}

// ---- view models -----------------------------------------------------------------------------------------------------------

export type ListDialog = { readonly kind: 'pick' } | { readonly kind: 'rule' } | { readonly kind: 'shortcuts' }

export interface RuleDraft {
  readonly rule: EvidenceRule
  readonly reason: string
}

export interface LotsListModel {
  readonly prefix: string
  readonly can: QualityCan
  readonly view: LotView
  readonly query: string
  /** The rows of the view (null value: still reading). */
  readonly rows: Read<Lot[]>
  /** The page size read (50, 100 … up to LIST_MAX). */
  readonly limit: number
  readonly more: boolean
  /** The read stopped at the largest page (LIST_MAX): more lots may exist than are listed. */
  readonly capped: boolean
  readonly loadingMore?: boolean
  readonly tiles: Record<LotTile, TileCount>
  /** The Cr VI evidence rule in force (the banner at rest). */
  readonly rule: Read<LabSettings>
  readonly asOf: string | null
  readonly live: LiveState
  readonly updates: number
  readonly selected: readonly string[]
  readonly notice?: Notice | null
  readonly dialog?: ListDialog | null
  /** "Record test result": the lots waiting for evidence to choose from. */
  readonly pick?: Read<Lot[]>
  readonly pickQuery?: string
  readonly ruleDraft?: RuleDraft | null
  readonly busy?: boolean
  /** A message key of the open dialog's refusal. */
  readonly dialogProblem?: string | null
  readonly stepUp?: StepUpState
  /** Design cases: the row with the focus, the keys panel open. */
  readonly focusRow?: number
}

export const RECORD_TABS = ['results', 'documents', 'release', 'activity'] as const
export type RecordTab = (typeof RECORD_TABS)[number]

export type RecordDialog =
  | { readonly kind: 'result' }
  | { readonly kind: 'document' }
  | { readonly kind: 'decide'; readonly decision: LotDecision }
  | { readonly kind: 'shortcuts' }

export interface LotRecordModel {
  readonly prefix: string
  readonly tab: RecordTab
  readonly detail: Read<LotDetail>
  readonly can: QualityCan
  /** The viewer's user id (the receiver never releases). */
  readonly me: string | null
  readonly today: string
  readonly asOf: string | null
  readonly live: LiveState
  readonly notice?: Notice | null
  readonly dialog?: RecordDialog | null
  readonly resultDraft?: ResultDraft
  readonly documentDraft?: DocumentDraft
  /** The typed code and the reason of the decision dialog. */
  readonly decideDraft?: { readonly code: string; readonly reason: string }
  readonly busy?: boolean
  readonly dialogProblem?: string | null
  /** The API's sentences of a refusal (a release with checks open), shown under our words. */
  readonly dialogLines?: readonly string[]
  /** The last result's answer: a later FAIL that blocked a released lot, its work orders and register entry. */
  readonly answer?: Pick<RecordAnswer, 'effect' | 'trace'> | null
  /** The work orders a block reached. */
  readonly blocked?: readonly WorkOrderUse[] | null
  readonly dockOpen?: boolean
}

export { CR_VI_METHODS, LOT_DOCUMENT_KINDS }
