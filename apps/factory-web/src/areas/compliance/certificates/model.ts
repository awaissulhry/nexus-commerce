import { addDays, addYears, certificateProblems, daysBetween, en17092ClassOf, MAX_VALIDITY_YEARS, type CertificateFields } from '@nexus/factory-domain/compliance/certificates/rules'
import { isBusinessDate } from '@nexus/factory-domain/core/time'
import type { LiveState, Notice, Read } from '../../quality/_shared/model'
import type { BrandOption, Certificate, CertificateDetail, CertificateFile, CertificateInput, CertificateStatus, Coverage, GateReasonCode, GateResult, MaterialOption, StyleFacts, StyleOption } from './api'
import type { RenewalsModel } from './renewals/model'

/**
 * The certificate register's rules without a screen (SCR-050, SCR-051; Reg. (EU) 2016/425 Annex V, EN 17092): who may do
 * what, the saved views and tiles (one filter model: a tile IS a view), the kind a standard names, the validity in words,
 * the notices, the Add certificate draft and its checks (the domain's own `certificateProblems`, turned into this app's
 * words), the register checklist, the coverage grid of a style, and the lapse check (what the gate refuses on a later
 * day). Pure: no React, no API client.
 */

// ---- who may do what ------------------------------------------------------------------------------------------------------

export const CERT_PERMISSIONS = {
  view: 'compliance.certificates.view',
  manage: 'compliance.certificates.manage',
  upload: 'files.upload',
  filesRead: 'files.read',
  styles: 'product.styles.view',
  materials: 'product.materials.view',
  parties: 'parties.view',
  threads: 'threads.read',
} as const

export type CertAbility = keyof typeof CERT_PERMISSIONS
export type CertCan = Readonly<Record<CertAbility, boolean>>

export function certCan(permissions: readonly string[]): CertCan {
  const held = new Set(permissions)
  return Object.fromEntries(Object.entries(CERT_PERMISSIONS).map(([name, permission]) => [name, held.has(permission)])) as unknown as CertCan
}

/** Today in Europe/Rome (the register's business date), YYYY-MM-DD. */
export const todayInRome = (now: Date = new Date()): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)

// ---- kinds and states -----------------------------------------------------------------------------------------------------

export const CERTIFICATE_KINDS = ['GARMENT', 'PROTECTOR', 'GLOVE', 'OTHER'] as const
export type CertificateKind = (typeof CERTIFICATE_KINDS)[number]

/** What the standard certifies: an EN 17092 garment, an EN 1621 protector, an EN 13594 glove, or another standard. */
export function kindOf(standard: string): CertificateKind {
  const text = standard.trim().toUpperCase().replace(/\s+/g, ' ')
  if (/^EN ?17092\b/.test(text)) return 'GARMENT'
  if (/^EN ?1621\b/.test(text)) return 'PROTECTOR'
  if (/^EN ?13594\b/.test(text)) return 'GLOVE'
  return 'OTHER'
}

export const STATUS_TONE: Record<CertificateStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  DRAFT: 'neutral',
  VALID: 'success',
  SUSPENDED: 'warning',
  WITHDRAWN: 'danger',
  EXPIRED: 'danger',
}

/** Past its last valid day (whether or not the night's run has marked it EXPIRED yet). */
export const isPastValidity = (certificate: Pick<Certificate, 'daysToExpiry'>): boolean => certificate.daysToExpiry < 0

/** Only a draft is edited; a registered certificate changes only its status. */
export const isRegistered = (status: CertificateStatus): boolean => status !== 'DRAFT'

/** A coverage is recorded on a draft, a valid or a suspended certificate (the domain's `acceptsCoverage`). */
export const acceptsCoverage = (status: CertificateStatus): boolean => status === 'DRAFT' || status === 'VALID' || status === 'SUSPENDED'

/** The PDF can be added while the certificate still counts (not on a withdrawn or expired one). */
export const acceptsPdf = (status: CertificateStatus): boolean => status === 'DRAFT' || status === 'VALID' || status === 'SUSPENDED'

// ---- validity in words ----------------------------------------------------------------------------------------------------

export type LeftTone = 'success' | 'info' | 'warning' | 'danger' | 'neutral'

export type Left =
  | { kind: 'withdrawn'; tone: LeftTone }
  | { kind: 'notRegistered'; tone: LeftTone; years: number; months: number; days: number }
  | { kind: 'expired'; tone: LeftTone; days: number }
  | { kind: 'lastDay'; tone: LeftTone }
  | { kind: 'days'; tone: LeftTone; days: number }
  | { kind: 'span'; tone: LeftTone; years: number; months: number }

/** Whole months from `from` to `to` (the day of the month counts: 12 Mar → 11 Apr is 0 months). */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number]
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number]
  let months = (ty - fy) * 12 + (tm - fm)
  if (td < fd) months -= 1
  return Math.max(0, months)
}

/** The days a tone warns at: 30 (danger), 90 (warning), 180 (the tile's horizon). */
export const EXPIRY_HORIZONS = [180, 90, 30] as const

/** How long the certificate still holds, in words the screen draws ("3 years 4 months left", "Expired 12 days ago"). */
export function leftOf(certificate: Pick<Certificate, 'status' | 'validFrom' | 'validTo'>, today: string): Left {
  if (certificate.status === 'WITHDRAWN') return { kind: 'withdrawn', tone: 'neutral' }
  const days = daysBetween(today, certificate.validTo)
  if (certificate.status === 'DRAFT') {
    const from = daysBetween(today, certificate.validFrom) > 0 ? certificate.validFrom : today
    const months = monthsBetween(from, certificate.validTo)
    return { kind: 'notRegistered', tone: 'neutral', years: Math.floor(months / 12), months: months % 12, days }
  }
  if (days < 0) return { kind: 'expired', tone: 'danger', days: -days }
  if (days === 0) return { kind: 'lastDay', tone: 'danger' }
  const tone: LeftTone = days <= 30 ? 'danger' : days <= 90 ? 'warning' : days <= 180 ? 'info' : 'success'
  if (days < 61) return { kind: 'days', tone, days }
  const months = monthsBetween(today, certificate.validTo)
  return { kind: 'span', tone, years: Math.floor(months / 12), months: months % 12 }
}

// ---- views and tiles (one filter model) -----------------------------------------------------------------------------------

// W2a (B-W2a-66): `changes` = the certificates with a change to the approved type waiting for the notified body.
export const CERT_VIEWS = ['all', 'valid', 'expiring', 'suspended', 'drafts', 'expired', 'changes'] as const
export type CertView = (typeof CERT_VIEWS)[number]
/** The tiles: each one a saved view (pressing it shows that view; its number is that view's count). */
export const CERT_TILES = ['valid', 'expiring', 'suspended', 'drafts'] as const satisfies readonly CertView[]
export type CertTile = (typeof CERT_TILES)[number]

export interface CertFilters {
  view: CertView
  kind: CertificateKind | 'all'
  q: string
}

export const NO_FILTERS: CertFilters = { view: 'all', kind: 'all', q: '' }

/** `waiting`: the changes to the approved type waiting for the notified body, per certificate (the `changes` view). */
export function inView(certificate: Certificate, view: CertView, waiting: Readonly<Record<string, number>> = {}): boolean {
  switch (view) {
    case 'changes':
      return (waiting[certificate.id] ?? 0) > 0
    case 'all':
      return true
    case 'valid':
      return certificate.status === 'VALID' && !isPastValidity(certificate)
    case 'expiring':
      return certificate.status === 'VALID' && certificate.daysToExpiry >= 0 && certificate.daysToExpiry <= 180
    case 'suspended':
      return certificate.status === 'SUSPENDED' || certificate.status === 'WITHDRAWN'
    case 'drafts':
      return certificate.status === 'DRAFT'
    case 'expired':
      return certificate.status === 'EXPIRED' || ((certificate.status === 'VALID' || certificate.status === 'SUSPENDED') && isPastValidity(certificate))
  }
}

/** The search: number, standard, class, notified body (name or number), model reference. */
export function matchesQuery(certificate: Certificate, q: string): boolean {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const text = [certificate.number, certificate.standard, certificate.ppeClass, certificate.notifiedBodyName, certificate.notifiedBodyNumber, certificate.modelReference].filter(Boolean).join(' ').toLowerCase()
  return words.every((word) => text.includes(word))
}

export function filterRows(certificates: readonly Certificate[], filters: CertFilters, waiting: Readonly<Record<string, number>> = {}): Certificate[] {
  return certificates.filter((certificate) => inView(certificate, filters.view, waiting) && (filters.kind === 'all' || kindOf(certificate.standard) === filters.kind) && matchesQuery(certificate, filters.q))
}

export const isFiltered = (filters: CertFilters): boolean => filters.view !== 'all' || filters.kind !== 'all' || filters.q.trim() !== ''

/** The filters in the address (`?view=expiring&kind=PROTECTOR&q=0000`), so a filtered register can be shared. */
export function filtersFromAddress(params: URLSearchParams | null): CertFilters {
  const view = params?.get('view') ?? ''
  const kind = params?.get('kind') ?? ''
  return {
    view: (CERT_VIEWS as readonly string[]).includes(view) ? (view as CertView) : 'all',
    kind: (CERTIFICATE_KINDS as readonly string[]).includes(kind) ? (kind as CertificateKind) : 'all',
    q: params?.get('q') ?? '',
  }
}

export function addressOf(filters: CertFilters): string {
  const search = new URLSearchParams()
  if (filters.view !== 'all') search.set('view', filters.view)
  if (filters.kind !== 'all') search.set('kind', filters.kind)
  if (filters.q.trim()) search.set('q', filters.q.trim())
  const text = search.toString()
  return text ? `?${text}` : ''
}

export interface TileCounts {
  valid: number
  expiring: number
  suspended: number
  drafts: number
  /** For the expiring tile's hint. */
  within90: number
  within30: number
}

export function tileCounts(certificates: readonly Certificate[]): TileCounts {
  const valid = certificates.filter((certificate) => inView(certificate, 'expiring'))
  return {
    valid: certificates.filter((certificate) => inView(certificate, 'valid')).length,
    expiring: valid.length,
    suspended: certificates.filter((certificate) => inView(certificate, 'suspended')).length,
    drafts: certificates.filter((certificate) => inView(certificate, 'drafts')).length,
    within90: valid.filter((certificate) => certificate.daysToExpiry <= 90).length,
    within30: valid.filter((certificate) => certificate.daysToExpiry <= 30).length,
  }
}

/**
 * The register's notices, the most serious first (the page shows one, the rest behind "N more notices"): a suspended
 * certificate (the gate refuses what it covered), one past its last valid day not yet marked expired, one within 30 days.
 */
export function noticesOf(certificates: readonly Certificate[]): Array<Notice & { certificateId: string }> {
  const out: Array<Notice & { certificateId: string }> = []
  for (const certificate of certificates.filter((entry) => entry.status === 'SUSPENDED'))
    out.push({ key: 'notice.suspended', tone: 'danger', params: { number: certificate.number, body: certificate.notifiedBodyNumber, count: certificate.coverageCount }, certificateId: certificate.id, ...(certificate.statusReason ? { detail: [certificate.statusReason] } : {}) })
  for (const certificate of certificates.filter((entry) => entry.status === 'VALID' && isPastValidity(entry)))
    out.push({ key: 'notice.pastValidity', tone: 'danger', params: { number: certificate.number, date: certificate.validTo }, certificateId: certificate.id })
  for (const certificate of certificates.filter((entry) => entry.status === 'VALID' && entry.daysToExpiry >= 0 && entry.daysToExpiry <= 30))
    out.push({ key: 'notice.expiringSoon', tone: 'warning', params: { number: certificate.number, count: certificate.daysToExpiry, date: certificate.validTo }, certificateId: certificate.id })
  return out
}

// ---- holder ----------------------------------------------------------------------------------------------------------------

export interface Holder {
  kind: 'company' | 'brand'
  /** Null while its name is not known here (a brand without parties.view). */
  name: string | null
}

export function holderOf(certificate: Pick<Certificate, 'companyId' | 'holderPartyId'>, companies: ReadonlyArray<{ id: string; name: string }>, brands: readonly BrandOption[] | null): Holder {
  if (certificate.holderPartyId) {
    const brand = brands?.find((entry) => entry.id === certificate.holderPartyId)
    return { kind: 'brand', name: brand ? (brand.tradeName ?? brand.legalName) : null }
  }
  return { kind: 'company', name: companies.find((company) => company.id === certificate.companyId)?.name ?? null }
}

// ---- the CSV of a view ----------------------------------------------------------------------------------------------------

export function certificatesCsv(
  certificates: readonly Certificate[],
  header: readonly string[],
  words: { status: (certificate: Certificate) => string; kind: (certificate: Certificate) => string; holder: (certificate: Certificate) => string },
): (string | number | null)[][] {
  return [
    [...header],
    ...certificates.map((certificate) => [
      certificate.number,
      certificate.standard,
      certificate.ppeClass,
      words.kind(certificate),
      words.holder(certificate),
      certificate.notifiedBodyName,
      certificate.notifiedBodyNumber,
      certificate.modelReference,
      certificate.coverageCount,
      certificate.validFrom,
      certificate.validTo,
      certificate.daysToExpiry,
      words.status(certificate),
    ]),
  ]
}

// ---- the Add certificate draft --------------------------------------------------------------------------------------------

/** The standards the Add dialog offers first (any other standard with its edition may be typed). */
export const STANDARD_SUGGESTIONS = ['EN 17092-2:2020', 'EN 17092-3:2020', 'EN 17092-4:2020', 'EN 17092-5:2020', 'EN 17092-6:2020', 'EN 1621-1:2012', 'EN 1621-2:2014', 'EN 13594:2015'] as const

export interface CertificateDraft {
  standard: string
  /** For a standard other than EN 17092 (whose class follows the part). */
  ppeClass: string
  number: string
  notifiedBodyName: string
  notifiedBodyNumber: string
  /** `company:<id>` or `brand:<party id>`. */
  holder: string
  modelReference: string
  validFrom: string
  validTo: string
  note: string
}

export type DraftField = keyof CertificateDraft

export const blankDraft = (companyId: string | null): CertificateDraft => ({
  standard: 'EN 17092-4:2020',
  ppeClass: '',
  number: '',
  notifiedBodyName: '',
  notifiedBodyNumber: '',
  holder: companyId ? `company:${companyId}` : '',
  modelReference: '',
  validFrom: '',
  validTo: '',
  note: '',
})

export const draftOf = (certificate: Certificate): CertificateDraft => ({
  standard: certificate.standard,
  ppeClass: certificate.ppeClass ?? '',
  number: certificate.number,
  notifiedBodyName: certificate.notifiedBodyName,
  notifiedBodyNumber: certificate.notifiedBodyNumber,
  holder: certificate.holderPartyId ? `brand:${certificate.holderPartyId}` : certificate.companyId ? `company:${certificate.companyId}` : '',
  modelReference: certificate.modelReference ?? '',
  validFrom: certificate.validFrom,
  validTo: certificate.validTo,
  note: certificate.note ?? '',
})

/** The class an EN 17092 part grants (the field follows the part), else null. */
export const grantedClass = (standard: string): string | null => en17092ClassOf(standard)

export function inputOf(draft: CertificateDraft): CertificateInput {
  const [holderKind, holderId] = draft.holder.split(':') as [string, string | undefined]
  const granted = grantedClass(draft.standard)
  const blank = (value: string) => (value.trim() === '' ? null : value.trim())
  return {
    companyId: holderKind === 'company' && holderId ? holderId : null,
    holderPartyId: holderKind === 'brand' && holderId ? holderId : null,
    standard: draft.standard.trim(),
    ppeClass: granted ?? blank(draft.ppeClass.toUpperCase()),
    number: draft.number.trim(),
    notifiedBodyName: draft.notifiedBodyName.trim(),
    notifiedBodyNumber: draft.notifiedBodyNumber.trim(),
    modelReference: blank(draft.modelReference),
    validFrom: draft.validFrom,
    validTo: draft.validTo,
    note: blank(draft.note),
  }
}

export interface FieldProblem {
  key: string
  params?: Record<string, string | number>
}

/**
 * What is wrong with the draft, by field, in this app's words — the domain's own checks (certificateProblems: the
 * notified body's 4 digits, the class an EN 17092 part grants, an EN 1621 level, the five-year rule of Annex V).
 */
export function draftProblems(draft: CertificateDraft): Partial<Record<DraftField, FieldProblem>> {
  const input = inputOf(draft)
  const fields: CertificateFields = { ...input, companyId: input.companyId, holderPartyId: input.holderPartyId }
  const out: Partial<Record<DraftField, FieldProblem>> = {}
  const put = (field: DraftField, problem: FieldProblem) => {
    if (!out[field]) out[field] = problem
  }
  for (const issue of certificateProblems(fields)) {
    switch (issue.path) {
      case 'holderPartyId':
        put('holder', { key: 'add.problem.holder' })
        break
      case 'number':
        put('number', { key: 'add.problem.number' })
        break
      case 'notifiedBodyName':
        put('notifiedBodyName', { key: 'add.problem.bodyName' })
        break
      case 'notifiedBodyNumber':
        put('notifiedBodyNumber', { key: 'add.problem.bodyNumber' })
        break
      case 'standard':
        put('standard', { key: /part of EN 17092/.test(issue.message) ? 'add.problem.standardPart' : 'add.problem.standard' })
        break
      case 'ppeClass': {
        const kind = kindOf(input.standard)
        put('ppeClass', kind === 'PROTECTOR' ? { key: 'add.problem.level' } : { key: 'add.problem.class' })
        break
      }
      case 'validFrom':
        put('validFrom', { key: 'add.problem.validFrom' })
        break
      case 'validTo': {
        if (!isBusinessDate(input.validTo)) put('validTo', { key: 'add.problem.validTo' })
        else if (isBusinessDate(input.validFrom) && daysBetween(input.validFrom, input.validTo) <= 0) put('validTo', { key: 'add.problem.validToOrder' })
        else if (isBusinessDate(input.validFrom)) put('validTo', { key: 'add.problem.fiveYears', params: { years: MAX_VALIDITY_YEARS, latest: addYears(input.validFrom, MAX_VALIDITY_YEARS) } })
        else put('validTo', { key: 'add.problem.validTo' })
        break
      }
    }
  }
  return out
}

/** The order the fields are asked in (the first problem holds Create). */
export const DRAFT_FIELDS: readonly DraftField[] = ['standard', 'ppeClass', 'number', 'notifiedBodyName', 'notifiedBodyNumber', 'holder', 'modelReference', 'validFrom', 'validTo', 'note']

export function firstProblem(problems: Partial<Record<DraftField, FieldProblem>>): FieldProblem | null {
  for (const field of DRAFT_FIELDS) if (problems[field]) return problems[field]!
  return null
}

/** The span in whole years and months a draft's dates describe (the five-year rule said in words). */
export function draftSpan(draft: Pick<CertificateDraft, 'validFrom' | 'validTo'>): { years: number; months: number } | null {
  if (!isBusinessDate(draft.validFrom) || !isBusinessDate(draft.validTo) || daysBetween(draft.validFrom, draft.validTo) <= 0) return null
  const months = monthsBetween(draft.validFrom, addDays(draft.validTo, 1))
  return { years: Math.floor(months / 12), months: months % 12 }
}

/** The API's field of a refusal (`body/validTo`) → the draft's field. */
export function draftFieldOf(path: string): DraftField | null {
  const field = path.replace(/^body[./]/, '').split(/[./]/)[0] ?? ''
  if (field === 'holderPartyId' || field === 'companyId') return 'holder'
  return (DRAFT_FIELDS as readonly string[]).includes(field) ? (field as DraftField) : null
}

// ---- the register checklist (Register certificate) ---------------------------------------------------------------------

export type RegisterCheckId = 'pdf' | 'data' | 'validity' | 'coverage'

export interface RegisterCheck {
  id: RegisterCheckId
  ok: boolean
  /** The data checks still open (their words), for `data`. */
  problems?: FieldProblem[]
}

/**
 * What a draft needs before it is registered (design ce-register): the notified body's PDF on the record, every data
 * check passing (the five-year rule among them), a validity that has not ended, and at least one style or part covered.
 */
export function registerChecks(certificate: CertificateDetail, today: string): RegisterCheck[] {
  const problems = Object.values(draftProblems(draftOf(certificate))).filter((entry): entry is FieldProblem => !!entry)
  return [
    { id: 'pdf', ok: certificate.hasPdf },
    { id: 'data', ok: problems.length === 0, problems },
    { id: 'validity', ok: isBusinessDate(certificate.validTo) && daysBetween(today, certificate.validTo) >= 0 },
    { id: 'coverage', ok: certificate.coverage.some((entry) => entry.status === 'ACTIVE') },
  ]
}

/** Why Register is held now (a `certificates` key), or null when it may be pressed. */
export function registerHeld(certificate: CertificateDetail, can: CertCan, today: string): string | null {
  if (!can.manage) return 'held.manage'
  if (certificate.status !== 'DRAFT') return 'held.notDraft'
  const open = registerChecks(certificate, today).find((check) => !check.ok)
  return open ? `register.held.${open.id}` : null
}

// ---- the coverage grid of a style -----------------------------------------------------------------------------------------

export type CellState = 'covered' | 'notCovered' | 'notOffered'

export interface CoverageGrid {
  allColours: boolean
  wholeRange: boolean
  sizes: string[]
  rows: Array<{ id: string; code: string; name: string; archived: boolean; cells: Array<{ size: string; state: CellState }> }>
  covered: number
  offered: number
}

/** Whether the style draws its SKU grid at all (no colourway offers a size yet: every cell counts as offered). */
const offersAny = (style: StyleFacts): boolean => style.colourways.some((colourway) => colourway.offeredSizes.length > 0)

/**
 * One style's coverage as the grid draws it: the style's colourways (the archived ones only when the coverage names
 * them) × its size range; a cell is covered when the coverage takes every colourway or names this one AND the whole
 * range or this size; not offered when the colourway has no SKU in that size.
 */
export function coverageGrid(coverage: Pick<Coverage, 'colourwayIds' | 'sizes'>, style: StyleFacts): CoverageGrid {
  const allColours = coverage.colourwayIds.length === 0
  const wholeRange = coverage.sizes.length === 0
  const any = offersAny(style)
  const colourways = style.colourways.filter((colourway) => colourway.status === 'ACTIVE' || coverage.colourwayIds.includes(colourway.id))
  let covered = 0
  let offered = 0
  const rows = colourways.map((colourway) => ({
    id: colourway.id,
    code: colourway.code,
    name: colourway.name,
    archived: colourway.status === 'ARCHIVED',
    cells: style.sizes.map((size) => {
      const isOffered = colourway.status === 'ACTIVE' && (!any || colourway.offeredSizes.includes(size))
      const isCovered = (allColours || coverage.colourwayIds.includes(colourway.id)) && (wholeRange || coverage.sizes.includes(size))
      if (isOffered) offered++
      if (isOffered && isCovered) covered++
      const state: CellState = !isOffered ? 'notOffered' : isCovered ? 'covered' : 'notCovered'
      return { size, state }
    }),
  }))
  return { allColours, wholeRange, sizes: style.sizes, rows, covered, offered }
}

/** The sizes a coverage names, or the range's words when it takes them all. */
export const rangeText = (sizes: readonly string[]): string => (sizes.length <= 2 ? sizes.join(', ') : `${sizes[0]}–${sizes[sizes.length - 1]}`)

// ---- the lapse check: what the gate refuses on a later day ------------------------------------------------------------

export interface LapseCell {
  styleId: string
  styleCode: string
  colourwayId: string
  colourwayCode: string
  size: string
}

/** At most this many garments are asked about in one check (a gate call each). */
export const LAPSE_MAX = 200

/** The day after the last valid day: the first day the gate refuses what only this certificate covers. */
export const defaultLapseDate = (validTo: string): string => (isBusinessDate(validTo) ? addDays(validTo, 1) : validTo)

/** Every garment this certificate covers today (active colourways, offered sizes), at most LAPSE_MAX. */
export function lapseCells(certificate: Pick<CertificateDetail, 'coverage'>, styles: Readonly<Record<string, StyleFacts | undefined>>): { cells: LapseCell[]; capped: boolean } {
  const cells: LapseCell[] = []
  for (const coverage of certificate.coverage) {
    if (coverage.status !== 'ACTIVE' || !coverage.styleId) continue
    const style = styles[coverage.styleId]
    if (!style) continue
    const grid = coverageGrid(coverage, style)
    for (const row of grid.rows) for (const cell of row.cells) if (cell.state === 'covered') cells.push({ styleId: style.id, styleCode: style.code, colourwayId: row.id, colourwayCode: row.code, size: cell.size })
  }
  return { cells: cells.slice(0, LAPSE_MAX), capped: cells.length > LAPSE_MAX }
}

export interface LapseAnswer {
  cell: LapseCell
  /** Null: the gate could not be asked for this garment. */
  result: GateResult | null
}

export interface LapseGroup {
  styleId: string
  styleCode: string
  colourwayCode: string
  sizes: string[]
  outcome: 'refused' | 'covered' | 'not_required' | 'unknown'
  /** The covering certificate on that day, when another one covers it. */
  coveredBy: string | null
  codes: GateReasonCode[]
  /** The API's own sentences (data, English), once each. */
  messages: string[]
}

export interface LapseSummary {
  total: number
  refused: number
  /** Still covered on that day by another certificate (or this one, before it lapses). */
  covered: number
  unknown: number
  groups: LapseGroup[]
}

/** The gate's answers grouped by style, colourway and why, sizes listed together (the panel's sentences). */
export function lapseSummary(answers: readonly LapseAnswer[]): LapseSummary {
  const groups = new Map<string, LapseGroup>()
  let refused = 0
  let covered = 0
  let unknown = 0
  for (const { cell, result } of answers) {
    const outcome: LapseGroup['outcome'] = result ? result.outcome : 'unknown'
    if (outcome === 'refused') refused++
    else if (outcome === 'unknown') unknown++
    else covered++
    const codes = result ? [...new Set(result.reasons.map((reason) => reason.code))].sort() : []
    const coveredBy = result?.certificate?.number ?? null
    const key = [cell.styleId, cell.colourwayId, outcome, codes.join(','), coveredBy ?? ''].join('|')
    const group = groups.get(key) ?? { styleId: cell.styleId, styleCode: cell.styleCode, colourwayCode: cell.colourwayCode, sizes: [], outcome, coveredBy, codes, messages: [] }
    group.sizes.push(cell.size)
    for (const reason of result?.reasons ?? []) if (!group.messages.includes(reason.message)) group.messages.push(reason.message)
    groups.set(key, group)
  }
  const order: Record<LapseGroup['outcome'], number> = { refused: 0, unknown: 1, covered: 2, not_required: 3 }
  return { total: answers.length, refused, covered, unknown, groups: [...groups.values()].sort((a, b) => order[a.outcome] - order[b.outcome] || a.styleCode.localeCompare(b.styleCode) || a.colourwayCode.localeCompare(b.colourwayCode)) }
}

/** What a refusal of the gate stops (design: the three places the gate acts). */
export const GATE_STOPS = ['release', 'label', 'ship'] as const

// ---- retention ---------------------------------------------------------------------------------------------------------

/** The PDF is kept 10 years after the last valid day (Reg. 2016/425 art. 8(3)). */
export const RETENTION_YEARS = 10
export const retainUntil = (validTo: string): string | null => (isBusinessDate(validTo) ? addYears(validTo, RETENTION_YEARS) : null)

// ---- the screens' models ----------------------------------------------------------------------------------------------

export type ListDialog = { kind: 'add' } | { kind: 'check' } | { kind: 'shortcuts' }

export interface AddModel {
  draft: CertificateDraft
  /** The fields left once (their problems show from then on). */
  touched: readonly DraftField[]
  /** The chosen PDF's name (its bytes stay in the container). */
  fileName: string | null
  busy: boolean
  problem: string | null
  /** The API's sentences of a refusal (data). */
  lines: readonly string[]
  /** The fields the API refused. */
  refused: readonly DraftField[]
}

export interface CheckModel {
  query: string
  /** The styles matching the words; null before a search. */
  styles: Read<StyleOption[]> | null
  style: Read<StyleFacts> | null
  colourwayId: string
  size: string
  date: string
  busy: boolean
  result: GateResult | null
  problem: string | null
}

export const blankCheck = (today: string): CheckModel => ({ query: '', styles: null, style: null, colourwayId: '', size: '', date: today, busy: false, result: null, problem: null })

/** Why the check cannot run yet (a `certificates` key), or null. */
export function checkHeld(model: CheckModel, can: CertCan): string | null {
  if (!can.styles) return 'check.held.styles'
  if (!model.style?.value) return 'check.held.style'
  if (!model.colourwayId) return 'check.held.colourway'
  if (!model.size) return 'check.held.size'
  if (!isBusinessDate(model.date)) return 'check.held.date'
  if (model.busy) return 'held.busy'
  return null
}

export interface CertificatesListModel {
  prefix: string
  can: CertCan
  companies: ReadonlyArray<{ id: string; name: string }>
  brands: readonly BrandOption[] | null
  filters: CertFilters
  /** The whole register read (≤ REGISTER_MAX); the view's rows are filtered here. */
  rows: Read<Certificate[]>
  /** W2a: the changes to the approved type waiting for the notified body, per certificate id (null: not read). */
  waiting: Read<Record<string, number>> | null
  today: string | null
  asOf: string | null
  live: LiveState
  updates: number
  selected: readonly string[]
  notice: Notice | null
  dialog: ListDialog | null
  add: AddModel | null
  check: CheckModel | null
  /** Design cases: the explainer open, the focused row, the notices list opened. */
  explainerOpen?: boolean
  noticesOpen?: boolean
  focusRow?: number
}

// W2a (B-W2a-66): Renewals (the validity, the expiry alerts, the renewal, the changes to the approved type).
export const RECORD_TABS = ['coverage', 'renewals', 'body', 'files', 'activity'] as const
export type RecordTab = (typeof RECORD_TABS)[number]

export type RecordDialog =
  | { kind: 'register' }
  | { kind: 'status'; move: 'suspend' | 'withdraw' | 'reinstate' }
  | { kind: 'coverage' }
  | { kind: 'endCoverage'; coverageId: string }
  | { kind: 'check' }
  | { kind: 'shortcuts' }

export interface CoverageDraft {
  target: 'style' | 'item'
  query: string
  styles: Read<StyleOption[]> | null
  style: Read<StyleFacts> | null
  materials: Read<MaterialOption[]> | null
  item: MaterialOption | null
  allColours: boolean
  colourwayIds: string[]
  wholeRange: boolean
  sizes: string[]
  allowsMadeToMeasure: boolean
  note: string
}

export const blankCoverage = (): CoverageDraft => ({ target: 'style', query: '', styles: null, style: null, materials: null, item: null, allColours: true, colourwayIds: [], wholeRange: true, sizes: [], allowsMadeToMeasure: false, note: '' })

/** Why Add coverage cannot run yet (a `certificates` key), or null. */
export function coverageHeld(draft: CoverageDraft, certificate: Pick<CertificateDetail, 'coverage'>, busy: boolean): string | null {
  if (draft.target === 'style') {
    const style = draft.style?.value
    if (!style) return 'coverage.held.style'
    if (certificate.coverage.some((entry) => entry.status === 'ACTIVE' && entry.styleId === style.id)) return 'coverage.held.already'
    if (!draft.allColours && draft.colourwayIds.length === 0) return 'coverage.held.colourways'
    if (!draft.wholeRange && draft.sizes.length === 0) return 'coverage.held.sizes'
  } else {
    if (!draft.item) return 'coverage.held.item'
    if (certificate.coverage.some((entry) => entry.status === 'ACTIVE' && entry.itemId === draft.item!.id)) return 'coverage.held.already'
  }
  if (draft.note.trim().length > 500) return 'held.long'
  return busy ? 'held.busy' : null
}

export interface LapseModel {
  date: string
  state: 'idle' | 'running' | 'done' | 'failed'
  done: number
  total: number
  capped: boolean
  summary: LapseSummary | null
}

export interface CertificateRecordModel {
  prefix: string
  tab: RecordTab
  can: CertCan
  today: string
  companies: ReadonlyArray<{ id: string; name: string }>
  brands: readonly BrandOption[] | null
  detail: Read<CertificateDetail>
  /** The covered styles' colourways and sizes, by style id (a failed read: null). */
  styles: Readonly<Record<string, StyleFacts | null | undefined>>
  /** The rest of the register from the same notified body (the Notified body tab). */
  sameBody: Read<Certificate[]> | null
  files: Read<CertificateFile[]> | null
  asOf: string | null
  live: LiveState
  notice: Notice | null
  dialog: RecordDialog | null
  /** The draft's details being edited (Draft only). */
  edit: { draft: CertificateDraft; touched: readonly DraftField[]; busy: boolean; problem: string | null; lines: readonly string[] } | null
  statusReason: string
  coverageDraft: CoverageDraft
  endReason: string
  check: CheckModel | null
  lapse: LapseModel
  busy: boolean
  dialogProblem: string | null
  dialogLines: readonly string[]
  dockOpen: boolean
  /** W2a: the Renewals tab (read while it is open); null: not mounted. */
  renewals: RenewalsModel | null
}
