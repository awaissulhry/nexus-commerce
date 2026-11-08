import { issuePath, isApiError } from '../../../lib/api/errors'
import type { AssessmentRecord, Assessment, Catalogue, CountsAnswer, DvrVersion, FreezeBody, ImpactLine, ImpactRefs, Measure, MeasureBody, MeasureView, RoleSheet, SheetChanges, SheetDraftBody, SheetRow, Signer, SignerPlan, VersionBrief } from './api'

/**
 * Plant › Health & safety › Risk assessment (SCR-209; B-W2b-144; design plant.risk): the page's rules, pure. The words of the
 * law and every code the API speaks are mirrored here (factory-domain safety/risk/rules and safety/rolesheets/rules import
 * node:crypto, which no browser bundle takes): `risk.vitest.test.ts` holds each mirror equal to the domain's. The addresses ⇄
 * the pages' state (every dialog lives in the address), the tiles, the signers in words, the dialogs' drafts with why their
 * buttons are held and what they send, "What this changes" in words, and the API's refusals in our words. A measure's cost
 * only with the cost grain; a person's name only inside one record (a measure's owner, a role's people, a signer).
 */

// ---- mirrors of factory-domain (held equal by risk.vitest.test.ts) ------------------------------------------------------------

export const SIGNER_ROLES = ['EMPLOYER', 'RSPP', 'RLS', 'RLST', 'DOCTOR'] as const
export type SignerRole = (typeof SIGNER_ROLES)[number]
export const AUTHOR_KINDS = ['CONSULTANT', 'IN_HOUSE'] as const
export type AuthorKind = (typeof AUTHOR_KINDS)[number]
export const VERSION_STATUSES = ['AWAITING_SIGNATURES', 'SIGNED', 'WITHDRAWN'] as const
// B-W2b-F13b: LINK — an outside signer approved our approval request on the version.
export const SIGN_METHODS = ['OFFICE', 'FLOOR_PIN', 'PAPER', 'LINK'] as const
export const MEASURE_STATUSES = ['PLANNED', 'IN_PROGRESS', 'DONE', 'VERIFIED', 'CANCELLED'] as const
export type MeasureStatus = (typeof MEASURE_STATUSES)[number]
export const MEASURE_SOURCES = ['DVR', 'INCIDENT', 'INSPECTION', 'MEETING', 'OTHER'] as const
export type MeasureSource = (typeof MEASURE_SOURCES)[number]
export const ITEM_KINDS = ['RISK', 'SURVEILLANCE'] as const
export type ItemKind = (typeof ITEM_KINDS)[number]
export const SHEET_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
export const IMPACT_KINDS = ['COURSE_NEEDED', 'COURSE_NOT_NEEDED', 'COURSE_DEADLINE', 'KIT_TO_ISSUE', 'KIT_REMOVED', 'VISITS_NEEDED', 'VISITS_NOT_NEEDED'] as const

export const RISK_REFUSALS = [
  'SITE_OTHER_COMPANY',
  'NAME_TAKEN',
  'ARCHIVED',
  'DUE_TOO_FAR',
  'FILE_NOT_READY',
  'NOT_PDF',
  'FROZEN_ALREADY',
  'VERSION_WAITING',
  'NO_EMPLOYER',
  'NOT_AWAITING',
  'NOT_SIGNED',
  'NOT_A_SIGNER',
  'SIGNED_ALREADY',
  'NO_APPOINTMENT',
  'SIGNED_IN_FUTURE',
  'SIGNED_BEFORE_FROZEN',
  'NAME_MISMATCH',
  'NOT_THE_SIGNER',
  'SAME_PERSON',
  'SCAN_MISSING',
  'ROLE_SHEET_OTHER_SITE',
  'OWNER_NOT_ALLOWED',
  'VERSION_OTHER_ASSESSMENT',
  'SOURCE_NOT_FOUND',
  'MEASURE_FINAL',
  'BAD_MOVE',
] as const
export const SHEET_REFUSALS = [
  'SITE_OTHER_COMPANY',
  'CODE_TAKEN',
  'ARCHIVED',
  'NOT_ARCHIVED',
  'PEOPLE_IN_ROLE',
  'PPE_ITEM_NOT_AVAILABLE',
  'COURSE_NOT_AVAILABLE',
  'IMPACT_CHANGED',
  'LEFT',
  'ROLE_SHEET_OTHER_SITE',
  'ROLE_SHEET_ARCHIVED',
] as const

/** The law in the words the plan and the design name it (factory-domain DVR_LAW … SURVEILLANCE_LAW). */
export const LAW = Object.freeze({
  dvr: 'D.Lgs. 81/2008 artt. 28-29',
  versions: 'D.Lgs. 81/2008 art. 28 c.2',
  plan: 'D.Lgs. 81/2008 art. 28 c.2 c-d',
  review: 'D.Lgs. 81/2008 art. 29 c.3',
  roleSheet: 'D.Lgs. 81/2008 art. 28',
  kit: 'D.Lgs. 81/2008 art. 18 c.1 d; art. 77',
  training: 'D.Lgs. 81/2008 art. 37',
  surveillance: 'D.Lgs. 81/2008 art. 41',
})

/** The limits the screens hold before sending (factory-domain RISK_LIMITS and ROLE_SHEET_LIMITS). */
export const LIMITS = Object.freeze({
  name: 200,
  label: 60,
  author: 200,
  summary: 2000,
  title: 300,
  risk: 300,
  note: 2000,
  reason: 500,
  evidence: 2000,
  roleSheets: 50,
  cost: 2_000_000_000,
  daysAhead: 3660,
  sheetCode: 20,
  sheetName: 120,
  sheetDescription: 2000,
  itemTitle: 200,
  itemNote: 1000,
  whenToWear: 200,
  items: 60,
  kit: 40,
  requirements: 40,
  quantity: 99,
  withinDays: 365,
})

/** The days a due date counts as soon (factory-domain calendar DUE_SOON_DAYS). */
export const DUE_SOON_DAYS = 30

/** factory-domain ROLE_SHEET_CODE: letters, digits and . _ / - (stored in capitals). */
export const SHEET_CODE = /^[A-Z0-9][A-Z0-9._/-]*$/

// ---- who may do what ------------------------------------------------------------------------------------------------------

export interface RiskCan {
  /** safety.view: every read of the page; a measure's owner moves their own measure with it. */
  readonly view: boolean
  /** safety.risk.manage: assessments, versions, paper signatures, the seal, measures. */
  readonly manage: boolean
  /** safety.risk.sign: one's own office signature (with a fresh code). */
  readonly sign: boolean
  /** safety.rolesheets.manage: the role sheets. */
  readonly sheets: boolean
  /** money.cost: a measure's cost. */
  readonly cost: boolean
  /** files.upload: the consultant's PDF, a paper's scan, a measure's evidence. */
  readonly upload: boolean
  /** files.read: the frozen PDF, the kept seal, a scan. */
  readonly readFiles: boolean
  /** people.view: a role's people open their records. */
  readonly people: boolean
}

export function riskCan(permissions: readonly string[]): RiskCan {
  const has = (name: string) => permissions.includes(name)
  return {
    view: has('safety.view'),
    manage: has('safety.risk.manage'),
    sign: has('safety.risk.sign'),
    sheets: has('safety.rolesheets.manage'),
    cost: has('money.cost'),
    upload: has('files.upload'),
    readFiles: has('files.read'),
    people: has('people.view'),
  }
}

// ---- the page's address (/plant/risk) -------------------------------------------------------------------------------------

export const MEASURE_VIEWS: readonly MeasureView[] = ['open', 'overdue', 'dueSoon', 'mine', 'done', 'cancelled', 'all']
/** A tile that filters the assessments or the role sheets on the page (the measures' tiles set the plan's view). */
export type PageTile = 'reviews' | 'signatures' | 'roles'
export type NewDialog = 'measure' | 'version' | 'role'
export type SheetMode = 'view' | 'edit'

/**
 * `?view=open|overdue|dueSoon|mine|done|cancelled|all&tile=reviews|signatures|roles&q=&new=measure|version|role
 * &assessment=<id>&sheet=<id>&do=edit&measure=<id>` — the plan's view is the API's own; a role sheet opens in its window.
 */
export interface RiskAddress {
  view: MeasureView
  tile: PageTile | null
  q: string
  add: NewDialog | null
  /** The assessment a new measure or version is for (the dialog's first choice). */
  assessment: string | null
  sheet: string | null
  mode: SheetMode
  /** A measure asked by its id (RECORD_PAGES.RiskMeasure): the page sends it to its assessment's plan tab. */
  measure: string | null
}

export const EMPTY_ADDRESS: RiskAddress = { view: 'open', tile: null, q: '', add: null, assessment: null, sheet: null, mode: 'view', measure: null }

const oneOf = <T extends string>(value: string | null, all: readonly T[]): T | null => (value && (all as readonly string[]).includes(value) ? (value as T) : null)

export function addressOf(params: { get(name: string): string | null }): RiskAddress {
  return {
    view: oneOf(params.get('view'), MEASURE_VIEWS) ?? 'open',
    tile: oneOf(params.get('tile'), ['reviews', 'signatures', 'roles'] as const),
    q: params.get('q')?.trim().slice(0, 80) ?? '',
    add: oneOf(params.get('new'), ['measure', 'version', 'role'] as const),
    assessment: params.get('assessment')?.trim() || null,
    sheet: params.get('sheet')?.trim() || null,
    mode: params.get('do') === 'edit' ? 'edit' : 'view',
    measure: params.get('measure')?.trim() || null,
  }
}

/** The address with a change: opening another sheet starts on its facts; closing a dialog forgets its assessment. */
export function withAddress(address: RiskAddress, change: Partial<RiskAddress>): RiskAddress {
  const next = { ...address, ...change }
  if ('sheet' in change && change.sheet !== address.sheet && !('mode' in change)) next.mode = 'view'
  if (next.sheet === null) next.mode = 'view'
  if (next.add === null && !('assessment' in change)) next.assessment = null
  return next
}

export function addressText(address: RiskAddress): string {
  const params = new URLSearchParams()
  if (address.view !== 'open') params.set('view', address.view)
  if (address.tile) params.set('tile', address.tile)
  if (address.q) params.set('q', address.q)
  if (address.add) params.set('new', address.add)
  if (address.add && address.assessment) params.set('assessment', address.assessment)
  if (address.sheet) params.set('sheet', address.sheet)
  if (address.sheet && address.mode !== 'view') params.set('do', address.mode)
  if (address.measure) params.set('measure', address.measure)
  const text = params.toString()
  return text ? `?${text}` : ''
}

// ---- the record's address (/plant/risk/<id>) ------------------------------------------------------------------------------

export const RECORD_TABS = ['roles', 'plan', 'versions'] as const
export type RecordTab = (typeof RECORD_TABS)[number]
export type RecordDialog = 'version' | 'measure' | 'role' | 'edit'
export type SignMethodChoice = 'office' | 'paper'

/**
 * `?tab=roles|plan|versions&sheet=<id>&do=edit&new=version|measure|role|edit&sign=<version>&role=<ROLE>&method=office|paper
 * &withdraw=<version>&measure=<id>&view=` — Versions by default (the DVR itself).
 */
export interface RecordAddress {
  tab: RecordTab
  sheet: string | null
  mode: SheetMode
  add: RecordDialog | null
  sign: string | null
  role: SignerRole | null
  method: SignMethodChoice
  withdraw: string | null
  measure: string | null
  view: MeasureView
}

export const EMPTY_RECORD_ADDRESS: RecordAddress = { tab: 'versions', sheet: null, mode: 'view', add: null, sign: null, role: null, method: 'office', withdraw: null, measure: null, view: 'all' }

export function recordAddressOf(params: { get(name: string): string | null }): RecordAddress {
  return {
    tab: oneOf(params.get('tab'), RECORD_TABS) ?? 'versions',
    sheet: params.get('sheet')?.trim() || null,
    mode: params.get('do') === 'edit' ? 'edit' : 'view',
    add: oneOf(params.get('new'), ['version', 'measure', 'role', 'edit'] as const),
    sign: params.get('sign')?.trim() || null,
    role: oneOf(params.get('role'), SIGNER_ROLES),
    method: params.get('method') === 'paper' ? 'paper' : 'office',
    withdraw: params.get('withdraw')?.trim() || null,
    measure: params.get('measure')?.trim() || null,
    view: oneOf(params.get('view'), MEASURE_VIEWS) ?? 'all',
  }
}

export function withRecordAddress(address: RecordAddress, change: Partial<RecordAddress>): RecordAddress {
  const next = { ...address, ...change }
  if ('sheet' in change && change.sheet !== address.sheet && !('mode' in change)) next.mode = 'view'
  if (next.sheet === null) next.mode = 'view'
  if (next.sign === null) {
    next.role = null
    next.method = 'office'
  }
  return next
}

export function recordAddressText(address: RecordAddress): string {
  const params = new URLSearchParams()
  if (address.tab !== 'versions') params.set('tab', address.tab)
  if (address.sheet) params.set('sheet', address.sheet)
  if (address.sheet && address.mode !== 'view') params.set('do', address.mode)
  if (address.add) params.set('new', address.add)
  if (address.sign) params.set('sign', address.sign)
  if (address.sign && address.role) params.set('role', address.role)
  if (address.sign && address.method !== 'office') params.set('method', address.method)
  if (address.withdraw) params.set('withdraw', address.withdraw)
  if (address.measure) params.set('measure', address.measure)
  if (address.view !== 'all') params.set('view', address.view)
  const text = params.toString()
  return text ? `?${text}` : ''
}

/** Where an assessment opens (its own page; a tab and the rest as the record's address). */
export const recordHref = (prefix: string, id: string, change: Partial<RecordAddress> = {}): string => `${prefix}/plant/risk/${encodeURIComponent(id)}${recordAddressText({ ...EMPTY_RECORD_ADDRESS, ...change })}`

/** The new tabs (design tab:dvr-pdf, tab:role-sheet, tab:plan-print). */
export const dvrHref = (prefix: string, assessmentId: string, versionId: string, show: 'pdf' | 'seal' = 'pdf'): string =>
  `${prefix}/plant/risk/dvr?assessment=${encodeURIComponent(assessmentId)}&version=${encodeURIComponent(versionId)}${show === 'seal' ? '&show=seal' : ''}`
export const roleSheetsHref = (prefix: string, ids: readonly string[]): string => `${prefix}/plant/risk/role-sheets?${ids.map((id) => `id=${encodeURIComponent(id)}`).join('&')}`
export const planPrintHref = (prefix: string, query: { assessments?: readonly string[]; ids?: readonly string[]; view?: MeasureView }): string => {
  const params = new URLSearchParams()
  for (const id of query.assessments ?? []) params.append('assessment', id)
  for (const id of query.ids ?? []) params.append('id', id)
  if (query.view && query.view !== 'open') params.set('view', query.view)
  const text = params.toString()
  return `${prefix}/plant/risk/plan${text ? `?${text}` : ''}`
}

// ---- the tiles --------------------------------------------------------------------------------------------------------------

export const TILES = ['measuresOverdue', 'measuresDueSoon', 'reviewsDue', 'rolesWithoutKitOrTraining', 'signaturesMissing'] as const
export type TileId = (typeof TILES)[number]

export interface Tile {
  readonly id: TileId
  readonly value: number | null
  readonly tone: 'danger' | 'warning' | null
}

/** The design's five tiles ("what the assessment still owes"): late measures and missing signatures are red, the rest amber. */
export const tilesOf = (counts: CountsAnswer | null): Tile[] =>
  TILES.map((id) => {
    const value = counts ? counts[id] : null
    const tone = value && value > 0 ? (id === 'measuresOverdue' || id === 'signaturesMissing' ? 'danger' : 'warning') : null
    return { id, value, tone }
  })

/** What a tile does: a measures tile sets the plan's view; the others filter their section. */
export function tileAction(id: TileId): { view: MeasureView } | { tile: PageTile } {
  switch (id) {
    case 'measuresOverdue':
      return { view: 'overdue' }
    case 'measuresDueSoon':
      return { view: 'dueSoon' }
    case 'reviewsDue':
      return { tile: 'reviews' }
    case 'rolesWithoutKitOrTraining':
      return { tile: 'roles' }
    case 'signaturesMissing':
      return { tile: 'signatures' }
  }
}

/** The assessments a tile keeps (the API's counts read the same facts). */
export function assessmentsOf(rows: readonly Assessment[], tile: PageTile | null): Assessment[] {
  if (tile === 'reviews') return rows.filter((row) => row.reviewState === 'OVERDUE' || row.reviewState === 'DUE_SOON')
  if (tile === 'signatures') return rows.filter((row) => !!row.waiting && row.waiting.signers.some((signer) => !signer.signedOn))
  return [...rows]
}

/** The role sheets a tile keeps: "Roles without PPE kit or training set". */
export const sheetsOf = (rows: readonly SheetRow[], tile: PageTile | null): SheetRow[] => (tile === 'roles' ? rows.filter((row) => row.ppeItems === 0 || row.courses === 0) : [...rows])

// ---- versions and signers in words -------------------------------------------------------------------------------------------

/** "v4" — a version's number as the design writes it. */
export const versionNo = (version: Pick<VersionBrief, 'versionNo'>): string => `v${version.versionNo}`

/** The roles in the order the law lists them (the employer first). */
export const ROLE_ORDER: Readonly<Record<SignerRole, number>> = { EMPLOYER: 0, RSPP: 1, RLS: 2, RLST: 3, DOCTOR: 4 }
export const byRole = <T extends { readonly role: SignerRole }>(rows: readonly T[]): T[] => [...rows].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role])

/** Signed of listed ("2 of 4"). */
export const signedCount = (signers: readonly { readonly signedOn?: string | null; readonly signature?: unknown }[]): { signed: number; total: number } => ({
  signed: signers.filter((signer) => ('signature' in signer ? !!signer.signature : !!signer.signedOn)).length,
  total: signers.length,
})

/** The version a row's "signed by" column reads: the one waiting, else the one in force. */
export const signingVersion = (row: Pick<Assessment, 'waiting' | 'inForce'>): VersionBrief | null => row.waiting ?? row.inForce

/** A version's state, as a message key: in force, superseded, waiting for signatures, withdrawn. */
export function versionStateKey(version: Pick<DvrVersion, 'status' | 'inForce' | 'superseded'>): string {
  if (version.status === 'WITHDRAWN') return 'version.state.WITHDRAWN'
  if (version.status === 'AWAITING_SIGNATURES') return 'version.state.AWAITING_SIGNATURES'
  return version.inForce ? 'version.state.IN_FORCE' : 'version.state.SUPERSEDED'
}
export const VERSION_TONE: Readonly<Record<string, 'success' | 'warning' | 'neutral' | 'danger'>> = {
  'version.state.IN_FORCE': 'success',
  'version.state.AWAITING_SIGNATURES': 'warning',
  'version.state.SUPERSEDED': 'neutral',
  'version.state.WITHDRAWN': 'neutral',
}

/** What a signer may do now, for the person reading: sign here (their own role), record the paper, or nothing (with why). */
export type SignerAct = { kind: 'signed' } | { kind: 'office' } | { kind: 'paper' } | { kind: 'held'; key: string }
export function signerActs(version: Pick<DvrVersion, 'status'>, signer: Signer, may: { manage: boolean; sign: boolean; upload: boolean }): SignerAct[] {
  if (signer.signature) return [{ kind: 'signed' }]
  if (version.status !== 'AWAITING_SIGNATURES') return [{ kind: 'held', key: 'held.notWaiting' }]
  const acts: SignerAct[] = []
  if (signer.mine && may.sign) acts.push({ kind: 'office' })
  if (may.manage) acts.push(may.upload ? { kind: 'paper' } : { kind: 'held', key: 'held.upload' })
  if (acts.length === 0) acts.push({ kind: 'held', key: may.sign ? 'held.notYourRole' : 'held.sign' })
  return acts
}

/** Why "New DVR version" waits (null: it may start): no right, a version waiting, no employer in force. */
export function newVersionHeld(record: Pick<AssessmentRecord, 'versions' | 'next' | 'may'> | null): string | null {
  if (!record) return 'common.reading'
  if (!record.may.manage) return 'held.manage'
  if (record.versions.some((version) => version.status === 'AWAITING_SIGNATURES')) return 'refusal.VERSION_WAITING'
  if (record.next.missingEmployer) return 'refusal.NO_EMPLOYER'
  if (!record.may.upload) return 'held.upload'
  return null
}

// ---- days ----------------------------------------------------------------------------------------------------------------------

/** Today in the factory's zone (Europe/Rome), the guards' "today". */
export const todayInRome = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

const DAY = /^\d{4}-\d{2}-\d{2}$/
export const isDay = (value: string): boolean => DAY.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`))
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000)
export const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

/** A typed day too far ahead (the API's typing guard, not a law's interval). */
export const tooFar = (day: string, today: string): boolean => daysBetween(today, day) > LIMITS.daysAhead

// ---- money (the cost grain only) -----------------------------------------------------------------------------------------------

/** A cost typed in the company's currency ("1.250,50", "1250.5", "1250") → minor units; null: empty; NaN: not a cost. */
export function minorOf(text: string): number | null {
  const typed = text.trim().replace(/\s|€/g, '')
  if (typed === '') return null
  const lastComma = typed.lastIndexOf(',')
  const lastDot = typed.lastIndexOf('.')
  const decimal = lastComma > lastDot ? ',' : '.'
  const normal = decimal === ',' ? typed.replace(/\./g, '').replace(',', '.') : typed.replace(/,/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(normal)) return Number.NaN
  const [whole, cents = ''] = normal.split('.')
  return Number(whole) * 100 + Number(cents.padEnd(2, '0'))
}

/** Minor units → the text a field shows back ("1250,50" in Italian, "1250.50" in English). */
export const costText = (minor: number | null | undefined, locale: string): string => (minor === null || minor === undefined ? '' : (minor / 100).toFixed(2).replace('.', locale === 'it' ? ',' : '.'))

// ---- a measure (Add measure, Edit, the inline cells, a move) ----------------------------------------------------------------------

export interface MeasureDraft {
  assessmentId: string | null
  title: string
  risk: string
  roleSheetIds: string[]
  ownerId: string | null
  dueOn: string
  cost: string
  source: MeasureSource
  /** DVR: the version it came from (null: the API takes the one in force, else the one waiting). */
  versionId: string | null
  status: 'PLANNED' | 'IN_PROGRESS'
  note: string
}

export const EMPTY_MEASURE: MeasureDraft = { assessmentId: null, title: '', risk: '', roleSheetIds: [], ownerId: null, dueOn: '', cost: '', source: 'DVR', versionId: null, status: 'PLANNED', note: '' }

/** An existing measure as the edit form holds it. */
export const measureDraftOf = (measure: Measure, locale: string): MeasureDraft => ({
  assessmentId: measure.assessmentId,
  title: measure.title,
  risk: measure.risk ?? '',
  roleSheetIds: measure.roleSheets.map((sheet) => sheet.id),
  ownerId: measure.ownerId,
  dueOn: measure.dueOn ?? '',
  cost: costText(measure.cost, locale),
  source: measure.source,
  versionId: measure.sourceVersion?.id ?? null,
  status: measure.status === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'PLANNED',
  note: measure.note ?? '',
})

const orNull = (text: string): string | null => (text.trim() === '' ? null : text.trim())

/** What the draft sends; `cost` only with the cost grain (the API refuses the field without it). */
export function measureBodyOf(draft: MeasureDraft, seesCost: boolean): MeasureBody {
  const body: MeasureBody = { title: draft.title.trim(), risk: orNull(draft.risk), roleSheetIds: [...draft.roleSheetIds], ownerId: draft.ownerId, dueOn: draft.dueOn || null, note: orNull(draft.note) }
  if (seesCost) body.cost = minorOf(draft.cost)
  return body
}

/** The fields at fault (message keys), the first being why Add / Save waits. */
export function measureProblems(draft: MeasureDraft, today: string, seesCost: boolean, needsAssessment = true): { field: string; key: string }[] {
  const problems: { field: string; key: string }[] = []
  if (needsAssessment && !draft.assessmentId) problems.push({ field: 'assessmentId', key: 'held.assessment' })
  if (draft.title.trim() === '') problems.push({ field: 'title', key: 'held.title' })
  else if (draft.title.trim().length > LIMITS.title) problems.push({ field: 'title', key: 'held.titleLong' })
  if (draft.risk.trim().length > LIMITS.risk) problems.push({ field: 'risk', key: 'held.riskLong' })
  if (draft.roleSheetIds.length > LIMITS.roleSheets) problems.push({ field: 'roleSheetIds', key: 'held.roles' })
  if (draft.dueOn !== '' && !isDay(draft.dueOn)) problems.push({ field: 'dueOn', key: 'held.day' })
  else if (draft.dueOn !== '' && tooFar(draft.dueOn, today)) problems.push({ field: 'dueOn', key: 'refusal.DUE_TOO_FAR' })
  if (seesCost) {
    const minor = minorOf(draft.cost)
    if (minor !== null && (Number.isNaN(minor) || minor < 0 || minor > LIMITS.cost)) problems.push({ field: 'cost', key: 'held.cost' })
  }
  if (draft.note.trim().length > LIMITS.note) problems.push({ field: 'note', key: 'held.noteLong' })
  return problems
}

/** Whether an edit changes anything (Save is held "Nothing changed." otherwise). */
export const measureChanged = (measure: Measure, draft: MeasureDraft, seesCost: boolean, locale: string): boolean =>
  JSON.stringify(measureBodyOf(measureDraftOf(measure, locale), seesCost)) !== JSON.stringify(measureBodyOf(draft, seesCost))

/** Only the fields an edit changed (PATCH sends what changes). */
export function measureEditOf(measure: Measure, draft: MeasureDraft, seesCost: boolean, locale: string): Partial<MeasureBody> {
  const before = measureBodyOf(measureDraftOf(measure, locale), seesCost) as unknown as Record<string, unknown>
  const after = measureBodyOf(draft, seesCost) as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(after)) if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) out[key] = after[key]
  return out as Partial<MeasureBody>
}

/** A move that asks something first: done (what was done, evidence files) and cancelled (why). */
export const moveAsks = (to: MeasureStatus): 'evidence' | 'reason' | null => (to === 'DONE' ? 'evidence' : to === 'CANCELLED' ? 'reason' : null)

/** Why the move waits (null: it may run). */
export function moveHeld(to: MeasureStatus, draft: { evidenceNote: string; reason: string }, busy: boolean): string | null {
  if (busy) return 'held.saving'
  if (to === 'CANCELLED' && draft.reason.trim() === '') return 'held.reason'
  if (draft.reason.trim().length > LIMITS.reason) return 'held.reasonLong'
  if (draft.evidenceNote.trim().length > LIMITS.evidence) return 'held.evidenceLong'
  return null
}

/** The status a measure's row shows: its state, with late / soon from its due day. */
export const STATUS_TONE: Readonly<Record<MeasureStatus, 'neutral' | 'info' | 'success' | 'warning' | 'danger'>> = { PLANNED: 'neutral', IN_PROGRESS: 'info', DONE: 'success', VERIFIED: 'success', CANCELLED: 'neutral' }

/** Where a measure came from, in words: the DVR's version, an incident, an inspection, a meeting, another source. */
export function sourceWords(measure: Pick<Measure, 'source' | 'sourceVersion'>): { key: string; params: Record<string, string> } {
  if (measure.source === 'DVR' && measure.sourceVersion) return { key: 'source.dvrVersion', params: { version: `v${measure.sourceVersion.versionNo}` } }
  return { key: `source.${measure.source}`, params: {} }
}

// ---- New DVR version ------------------------------------------------------------------------------------------------------------

export interface VersionDraft {
  /** The assessment it is for; null: none chosen yet (or a new one for a site without). */
  assessmentId: string | null
  /** "Add the current DVR" for a site without an assessment: its site, name and next review. */
  newSiteId: string | null
  newName: string
  newReviewOn: string
  file: { name: string; type: string; size: number } | null
  /** The file's SHA-256 computed on this device (what the freeze will seal). */
  sha256: string | null
  label: string
  effectiveOn: string
  authorKind: AuthorKind
  authorName: string
  changeSummary: string
}

export const emptyVersionDraft = (assessmentId: string | null, today: string): VersionDraft => ({
  assessmentId,
  newSiteId: null,
  newName: '',
  newReviewOn: '',
  file: null,
  sha256: null,
  label: '',
  effectiveOn: today,
  authorKind: 'CONSULTANT',
  authorName: '',
  changeSummary: '',
})

export const MAX_DVR_BYTES = 50 * 1024 * 1024

/** Why "Add the assessment" waits (a site without one). */
export function newAssessmentHeld(draft: VersionDraft, today: string, busy: boolean): string | null {
  if (busy) return 'held.saving'
  if (!draft.newSiteId) return 'held.site'
  if (draft.newName.trim() === '') return 'held.assessmentName'
  if (draft.newName.trim().length > LIMITS.name) return 'held.nameLong'
  if (draft.newReviewOn !== '' && !isDay(draft.newReviewOn)) return 'held.day'
  if (draft.newReviewOn !== '' && tooFar(draft.newReviewOn, today)) return 'refusal.DUE_TOO_FAR'
  return null
}

/** Why "Freeze and send for signature" waits (null: it may run), in the order the person fills the dialog. */
export function freezeHeld(draft: VersionDraft, record: Pick<AssessmentRecord, 'versions' | 'next' | 'may'> | null, today: string, busy: boolean): string | null {
  if (busy) return 'held.saving'
  if (!draft.assessmentId) return 'held.assessment'
  const held = newVersionHeld(record)
  if (held) return held
  if (!draft.file) return 'held.file'
  if (draft.file.type && draft.file.type !== 'application/pdf') return 'refusal.NOT_PDF'
  if (draft.file.size > MAX_DVR_BYTES) return 'held.fileLarge'
  if (!draft.sha256) return 'held.fingerprint'
  if (draft.label.trim().length > LIMITS.label) return 'held.labelLong'
  if (!isDay(draft.effectiveOn)) return 'held.effectiveOn'
  if (tooFar(draft.effectiveOn, today)) return 'refusal.DUE_TOO_FAR'
  if (draft.authorName.trim() === '') return 'held.author'
  if (draft.authorName.trim().length > LIMITS.author) return 'held.authorLong'
  if (draft.changeSummary.trim().length > LIMITS.summary) return 'held.summaryLong'
  return null
}

/** The freeze's body once the PDF is on file. */
export const freezeBodyOf = (draft: VersionDraft, fileId: string): FreezeBody => ({
  fileId,
  label: draft.label.trim(),
  effectiveOn: draft.effectiveOn,
  authorKind: draft.authorKind,
  authorName: draft.authorName.trim(),
  changeSummary: orNull(draft.changeSummary),
})

/** The signers of a version frozen today, in the law's order, with who signs under an earlier role (art. 34). */
export const plannedSigners = (plan: SignerPlan) => byRole(plan.signers)

// ---- Sign version ---------------------------------------------------------------------------------------------------------------

export interface PaperDraft {
  signerName: string
  signedOn: string
  scan: { name: string; type: string; size: number } | null
}

export const paperDraftOf = (signer: Signer | null, today: string): PaperDraft => ({ signerName: signer?.holder?.name ?? '', signedOn: today, scan: null })

/** Why recording the paper waits: the name on it, its day (from the freeze to today), the scan first. */
export function paperHeld(draft: PaperDraft, version: Pick<DvrVersion, 'frozenAt' | 'status'>, today: string, busy: boolean): string | null {
  if (busy) return 'held.saving'
  if (version.status !== 'AWAITING_SIGNATURES') return 'held.notWaiting'
  if (draft.signerName.trim() === '') return 'held.signerName'
  if (!isDay(draft.signedOn)) return 'held.day'
  if (draft.signedOn > today) return 'refusal.SIGNED_IN_FUTURE'
  if (draft.signedOn < version.frozenAt.slice(0, 10)) return 'refusal.SIGNED_BEFORE_FROZEN'
  if (!draft.scan) return 'refusal.SCAN_MISSING'
  return null
}

// ---- role sheets -------------------------------------------------------------------------------------------------------------

export interface ItemRow {
  key: string
  kind: ItemKind
  title: string
  note: string
}
export interface KitRow {
  key: string
  ppeItemId: string
  quantity: string
  whenToWear: string
  note: string
}
export interface CourseRow {
  key: string
  courseId: string
  /** Days after taking the role; '' = before starting. */
  withinDays: string
  note: string
}

/** The WHOLE sheet as the editor holds it (B-W2b-128: the draft is the whole sheet; Apply writes only what differs). */
export interface SheetDraft {
  name: string
  description: string
  items: ItemRow[]
  kit: KitRow[]
  requirements: CourseRow[]
  /** Whether the role needs health surveillance (null: no plan yet, left unset). */
  needed: boolean | null
}

let rowKeys = 0
export const rowKey = (prefix: string): string => `${prefix}-${++rowKeys}`

export const sheetDraftOf = (sheet: RoleSheet): SheetDraft => ({
  name: sheet.name,
  description: sheet.description ?? '',
  items: [...sheet.items].sort((a, b) => a.seq - b.seq).map((item) => ({ key: item.id, kind: item.kind, title: item.title, note: item.note ?? '' })),
  kit: [...sheet.kit].sort((a, b) => a.seq - b.seq).map((line) => ({ key: line.id, ppeItemId: line.ppeItemId, quantity: String(line.quantity), whenToWear: line.whenToWear, note: line.note ?? '' })),
  requirements: sheet.requirements.map((line) => ({ key: line.id, courseId: line.courseId, withinDays: line.withinDays === null ? '' : String(line.withinDays), note: line.note ?? '' })),
  needed: sheet.plan.needed,
})

const whole = (text: string): number | null => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : null)

/** What the draft sends to preview and Apply (`surveillance` only when the person set it). */
export function sheetBodyOf(draft: SheetDraft, sheet: Pick<RoleSheet, 'plan'>): SheetDraftBody {
  const body: SheetDraftBody = {
    name: draft.name.trim(),
    description: orNull(draft.description),
    content: {
      items: draft.items.map((item) => ({ kind: item.kind, title: item.title.trim(), note: orNull(item.note) })),
      kit: draft.kit.map((line) => ({ ppeItemId: line.ppeItemId, quantity: whole(line.quantity) ?? 0, whenToWear: line.whenToWear.trim(), note: orNull(line.note) })),
      requirements: draft.requirements.map((line) => ({ courseId: line.courseId, withinDays: line.withinDays.trim() === '' ? null : (whole(line.withinDays) ?? -1), note: orNull(line.note) })),
    },
  }
  if (draft.needed !== null && draft.needed !== sheet.plan.needed) body.surveillance = { needed: draft.needed }
  return body
}

/** The parts of the sheet the draft changes (the EditModeBar counts them). */
export function sheetChangedParts(sheet: RoleSheet, draft: SheetDraft): string[] {
  const before = sheetBodyOf(sheetDraftOf(sheet), sheet)
  const after = sheetBodyOf(draft, sheet)
  const parts: string[] = []
  if (before.name !== after.name || before.description !== after.description) parts.push('header')
  if (JSON.stringify(before.content.items) !== JSON.stringify(after.content.items)) parts.push('items')
  if (JSON.stringify(before.content.kit) !== JSON.stringify(after.content.kit)) parts.push('kit')
  if (JSON.stringify(before.content.requirements) !== JSON.stringify(after.content.requirements)) parts.push('requirements')
  if (after.surveillance) parts.push('surveillance')
  return parts
}

/** What is wrong with the draft (the domain's contentProblems, mirrored), as message keys at their rows. */
export function sheetProblems(draft: SheetDraft): { field: string; key: string }[] {
  const problems: { field: string; key: string }[] = []
  if (draft.name.trim() === '') problems.push({ field: 'name', key: 'held.sheetName' })
  else if (draft.name.trim().length > LIMITS.sheetName) problems.push({ field: 'name', key: 'held.nameLong' })
  if (draft.description.trim().length > LIMITS.sheetDescription) problems.push({ field: 'description', key: 'held.noteLong' })
  if (draft.items.length > LIMITS.items) problems.push({ field: 'items', key: 'held.tooManyItems' })
  draft.items.forEach((item) => {
    if (item.title.trim() === '') problems.push({ field: `item:${item.key}`, key: 'held.itemTitle' })
    else if (item.title.trim().length > LIMITS.itemTitle) problems.push({ field: `item:${item.key}`, key: 'held.titleLong' })
  })
  if (draft.kit.length > LIMITS.kit) problems.push({ field: 'kit', key: 'held.tooManyKit' })
  const items = new Set<string>()
  draft.kit.forEach((line) => {
    if (!line.ppeItemId) problems.push({ field: `kit:${line.key}`, key: 'held.kitItem' })
    else if (items.has(line.ppeItemId)) problems.push({ field: `kit:${line.key}`, key: 'held.kitTwice' })
    items.add(line.ppeItemId)
    const quantity = whole(line.quantity)
    if (quantity === null || quantity < 1 || quantity > LIMITS.quantity) problems.push({ field: `kit:${line.key}`, key: 'held.quantity' })
    if (line.whenToWear.trim() === '') problems.push({ field: `kit:${line.key}`, key: 'held.whenToWear' })
  })
  if (draft.requirements.length > LIMITS.requirements) problems.push({ field: 'requirements', key: 'held.tooManyCourses' })
  const courses = new Set<string>()
  draft.requirements.forEach((line) => {
    if (!line.courseId) problems.push({ field: `course:${line.key}`, key: 'held.course' })
    else if (courses.has(line.courseId)) problems.push({ field: `course:${line.key}`, key: 'held.courseTwice' })
    courses.add(line.courseId)
    if (line.withinDays.trim() !== '') {
      const days = whole(line.withinDays)
      if (days === null || days > LIMITS.withinDays) problems.push({ field: `course:${line.key}`, key: 'held.withinDays' })
    }
  })
  if (draft.needed === true && !draft.items.some((item) => item.kind === 'SURVEILLANCE')) problems.push({ field: 'needed', key: 'held.surveillanceNeed' })
  return problems
}

/** Why "Add the first role" waits. */
export function newSheetHeld(draft: { siteId: string | null; code: string; name: string }, busy: boolean): string | null {
  if (busy) return 'held.saving'
  if (!draft.siteId) return 'held.site'
  const code = draft.code.trim().toUpperCase()
  if (code === '') return 'held.code'
  if (code.length > LIMITS.sheetCode || !SHEET_CODE.test(code)) return 'held.codeShape'
  if (draft.name.trim() === '') return 'held.sheetName'
  if (draft.name.trim().length > LIMITS.sheetName) return 'held.nameLong'
  return null
}

/** "Needed · every 12 months", "Not needed", "Not set yet" — a role's health surveillance as a message key and its months. */
export function surveillanceWords(surveillance: { needed: boolean | null; frequencyMonths: number | null }): { key: string; params: Record<string, number> } {
  if (surveillance.needed === null) return { key: 'surveillance.unset', params: {} }
  if (!surveillance.needed) return { key: 'surveillance.no', params: {} }
  return surveillance.frequencyMonths ? { key: 'surveillance.every', params: { count: surveillance.frequencyMonths } } : { key: 'surveillance.yes', params: {} }
}

/** A name in the page's language (a catalogue entry's own translation, else its name). */
export const localName = (entry: { name: string; nameI18n: Record<string, string> | null }, locale: string): string => entry.nameI18n?.[locale] || entry.name

/** Words the view says: a message key with its values, or a text as it came (a name, a risk in the sheet's own words). */
export type Said = { readonly text: string } | { readonly key: string; readonly params?: Readonly<Record<string, string | number>> }

/** "within 30 days" / "before starting" (a requirement's deadline). */
export const withinSaid = (days: number | null): Said => (days === null ? { key: 'within.before' } : { key: 'within.days', params: { count: days } })

/** One line of "What this changes" in words (design pop:impact): "3 people now need Specific training (high risk)". */
export function impactWords(line: ImpactLine, refs: ImpactRefs, locale: string): { key: string; params: Record<string, string | number>; within?: { from: Said; to: Said } } {
  const course = line.courseId ? refs.courses.find((entry) => entry.id === line.courseId) : undefined
  const item = line.ppeItemId ? refs.ppeItems.find((entry) => entry.id === line.ppeItemId) : undefined
  const courseName = course ? localName(course, locale) : '—'
  const itemName = item ? localName(item, locale) : '—'
  const count = line.people
  switch (line.kind) {
    case 'COURSE_NEEDED':
      return { key: 'impact.COURSE_NEEDED', params: { count, course: courseName, already: line.already } }
    case 'COURSE_NOT_NEEDED':
      return { key: 'impact.COURSE_NOT_NEEDED', params: { count, course: courseName } }
    case 'COURSE_DEADLINE':
      return { key: 'impact.COURSE_DEADLINE', params: { count, course: courseName }, within: { from: withinSaid(line.withinDays?.from ?? null), to: withinSaid(line.withinDays?.to ?? null) } }
    case 'KIT_TO_ISSUE':
      return { key: 'impact.KIT_TO_ISSUE', params: { count, item: itemName, quantity: line.quantity ?? 1, already: line.already } }
    case 'KIT_REMOVED':
      return { key: 'impact.KIT_REMOVED', params: { count, item: itemName } }
    case 'VISITS_NEEDED':
      return line.frequencyMonths ? { key: 'impact.VISITS_NEEDED', params: { count, months: line.frequencyMonths } } : { key: 'impact.VISITS_NEEDED_DOCTOR', params: { count } }
    case 'VISITS_NOT_NEEDED':
      return { key: 'impact.VISITS_NOT_NEEDED', params: { count } }
  }
}

/** The sheet's own changes as rows of the review (what · now · after), with the catalogue's names. */
export interface ChangeRow {
  id: string
  what: { key: string; params?: Record<string, string | number> }
  now: Said
  next: Said
}

const NONE: Said = { text: '—' }
const yesNo = (value: boolean | null): Said => (value === null ? NONE : { key: value ? 'common.yes' : 'common.no' })

export function changeRows(changes: SheetChanges, sheet: RoleSheet, refs: ImpactRefs, catalogue: Catalogue | null, locale: string): ChangeRow[] {
  const rows: ChangeRow[] = []
  const itemName = (id: string): Said => {
    const known = refs.ppeItems.find((entry) => entry.id === id) ?? catalogue?.ppeItems.find((entry) => entry.id === id) ?? sheet.kit.find((line) => line.ppeItemId === id)?.item
    return { text: known ? localName(known, locale) : '—' }
  }
  const courseName = (id: string): Said => {
    const known = refs.courses.find((entry) => entry.id === id) ?? catalogue?.courses.find((entry) => entry.id === id) ?? sheet.requirements.find((line) => line.courseId === id)?.course
    return { text: known ? localName(known, locale) : '—' }
  }
  const textOf = (said: Said): string => ('text' in said ? said.text : '')
  for (const field of changes.header) rows.push({ id: `header:${field}`, what: { key: `change.header.${field === 'nameI18n' ? 'name' : field}` }, now: NONE, next: { key: 'change.changed' } })
  changes.risks.added.forEach((words, index) => rows.push({ id: `risk+${index}`, what: { key: 'change.riskAdded' }, now: NONE, next: { text: words } }))
  changes.risks.removed.forEach((words, index) => rows.push({ id: `risk-${index}`, what: { key: 'change.riskRemoved' }, now: { text: words }, next: NONE }))
  changes.surveillanceNeeds.added.forEach((words, index) => rows.push({ id: `need+${index}`, what: { key: 'change.needAdded' }, now: NONE, next: { text: words } }))
  changes.surveillanceNeeds.removed.forEach((words, index) => rows.push({ id: `need-${index}`, what: { key: 'change.needRemoved' }, now: { text: words }, next: NONE }))
  for (const id of changes.kit.added) rows.push({ id: `kit+${id}`, what: { key: 'change.kitAdded' }, now: NONE, next: itemName(id) })
  for (const id of changes.kit.removed) rows.push({ id: `kit-${id}`, what: { key: 'change.kitRemoved' }, now: itemName(id), next: NONE })
  for (const change of changes.kit.changed) {
    const item = textOf(itemName(change.ppeItemId))
    if (change.quantity) rows.push({ id: `kitq${change.ppeItemId}`, what: { key: 'change.kitQuantity', params: { item } }, now: { text: String(change.quantity.from) }, next: { text: String(change.quantity.to) } })
    if (change.whenToWear) rows.push({ id: `kitw${change.ppeItemId}`, what: { key: 'change.kitWhen', params: { item } }, now: { text: change.whenToWear.from }, next: { text: change.whenToWear.to } })
  }
  for (const id of changes.courses.added) rows.push({ id: `course+${id}`, what: { key: 'change.courseAdded' }, now: NONE, next: courseName(id) })
  for (const id of changes.courses.removed) rows.push({ id: `course-${id}`, what: { key: 'change.courseRemoved' }, now: courseName(id), next: NONE })
  for (const change of changes.courses.changed) rows.push({ id: `coursed${change.courseId}`, what: { key: 'change.courseWithin', params: { course: textOf(courseName(change.courseId)) } }, now: withinSaid(change.withinDays.from), next: withinSaid(change.withinDays.to) })
  if (changes.surveillance) rows.push({ id: 'surveillance', what: { key: 'change.surveillance' }, now: yesNo(changes.surveillance.from), next: yesNo(changes.surveillance.to) })
  return rows
}

// ---- the API's answers in our words -----------------------------------------------------------------------------------------------

export interface Problem {
  readonly key: string
  readonly field: string | null
  readonly unknown?: boolean
}

const RISK_CODES = new Set<string>(RISK_REFUSALS)
const SHEET_CODES = new Set<string>(SHEET_REFUSALS)

/**
 * An API refusal or failure in our words. `family` names whose refusal codes are read: the risk module (`refusal.<CODE>`)
 * or the role sheets (`sheetRefusal.<CODE>`). A 400 names its field (`body/<field>`).
 */
export function problemOf(error: unknown, family: 'risk' | 'sheet' = 'risk'): Problem {
  if (!isApiError(error)) return { key: 'problem.unavailable', field: null, unknown: true }
  let refusal: string | null = null
  let field: string | null = null
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (path.startsWith('refusal/') && !refusal) {
      const code = path.slice('refusal/'.length)
      if (family === 'risk' ? RISK_CODES.has(code) : SHEET_CODES.has(code)) refusal = code
    } else if (/^body[./]/.test(path) && !field) {
      field = path.replace(/^body[./]/, '').replace(/\./g, '/') || null
    }
  }
  if (refusal) return { key: `${family === 'risk' ? 'refusal' : 'sheetRefusal'}.${refusal}`, field }
  switch (error.kind) {
    case 'invalid':
      return { key: 'problem.invalid', field }
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
    case 'unavailable':
      return error.code === 'network' ? { key: 'problem.noAnswer', field: null, unknown: true } : { key: 'problem.unavailable', field: null }
    default:
      return { key: 'problem.internal', field: null }
  }
}

/** A read that failed, in words (a section says it and offers Try again; never drawn as empty). */
export const readProblemOf = (error: unknown): string => {
  const problem = problemOf(error)
  return problem.key === 'problem.forbidden' || problem.key === 'problem.signedOut' || problem.key === 'problem.notFound' ? problem.key : 'problem.read'
}

/** The problem's words at a field, when it names that field (or a path under it). */
export const atField = (problem: Problem | null, ...fields: readonly string[]): string | null =>
  problem && problem.field && fields.some((field) => problem.field === field || problem.field!.startsWith(`${field}/`)) ? problem.key : null

// ---- live -------------------------------------------------------------------------------------------------------------------------

/** The page's live events (B-W2b-122, B-W2b-128): every one moves the tiles; each its own section. */
export const RISK_EVENTS = ['risk_assessment.changed', 'risk_assessment_version.changed', 'risk_signature.collected', 'risk_measure.changed', 'role_sheet.changed'] as const
export const isRiskChange = (change: { readonly type: string }): boolean => (RISK_EVENTS as readonly string[]).includes(change.type)

/** The record's live events that concern it (its assessment id, or a role sheet: the roles tab reads its site again). */
export function recordChangeOf(change: { readonly type: string; readonly fields: Record<string, unknown> }, assessmentId: string): 'record' | 'plan' | 'roles' | null {
  if (change.type === 'role_sheet.changed') return 'roles'
  if (change.fields.assessmentId !== assessmentId) return null
  if (change.type === 'risk_measure.changed') return 'plan'
  return isRiskChange(change) ? 'record' : null
}

// ---- the plan tab's chart ----------------------------------------------------------------------------------------------------------

/** "Open measures over time": a year ago, the highest, today (the line's words; the chart draws the 53 weekly points). */
export function burnSummary(burn: readonly { on: string; open: number }[]): { first: { on: string; open: number } | null; last: { on: string; open: number } | null; peak: number } {
  return { first: burn[0] ?? null, last: burn[burn.length - 1] ?? null, peak: burn.reduce((top, point) => Math.max(top, point.open), 0) }
}
