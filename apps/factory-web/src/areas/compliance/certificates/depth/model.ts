import { bodyProblems, cleanScopes, nandoLink, scopeCheck, type CertificateKind } from '@nexus/factory-domain/compliance/certificates-depth/bodies'
import { ARTICLE_CODE_MAX } from '@nexus/factory-domain/compliance/certificates-depth/bought-in'
import { cleanLevels, levelsProblems, sameLevels } from '@nexus/factory-domain/compliance/certificates-depth/levels'
import { fiveYearCheck, type Span } from '@nexus/factory-domain/compliance/certificates-depth/validity'
import type { Read } from '../../../quality/_shared/model'
import type { CertCan } from '../model'
import type { BodyInput, BoughtInPart, CertificateSummary, Depth, Directory, NotifiedBody, ScopeCheckView, SupplierOption } from './api'

/**
 * Certificates in depth without a screen (B-W2b-255; SCR-050, SCR-051, SCR-291): who may do what, why each write is held
 * (a `compliance-certificates-depth` key), the drafts of the dialogs, the five-year words, the saved views' words, and the
 * Notified bodies directory's filter. Pure: no React, no API client. The domain (factory-domain
 * compliance/certificates-depth) holds the rules; this turns them into this app's keys.
 */

export const DEPTH_NS = 'compliance-certificates-depth'

// ---- the five-year check (PRD-282) -------------------------------------------------------------------------------------

/** The span's parts that are not zero, for the words ("5 years 2 months"); all zero: no parts. */
export function spanParts(span: Span): Array<{ unit: 'years' | 'months' | 'days'; count: number }> {
  return (['years', 'months', 'days'] as const).filter((unit) => span[unit] > 0).map((unit) => ({ unit, count: span[unit] }))
}

/** The Add certificate (and a draft's Details) words for a validity too long, or null when it holds. */
export function fiveYearWords(validFrom: string, validTo: string): { span: Span; latest: string; years: number } | null {
  const check = fiveYearCheck(validFrom, validTo)
  return check.state === 'TOO_LONG' ? { span: check.span!, latest: check.latest!, years: check.maxYears } : null
}

// ---- the record's Notified body tab, levels, own brand, bought-in parts -------------------------------------------------

export type DepthDialog =
  | { kind: 'pickBody' }
  | { kind: 'levels' }
  | { kind: 'base' }
  | { kind: 'supplier'; coverageId: string }

export interface DepthDraft {
  bodyId: string
  levels: Record<string, string>
  baseId: string
  supplierId: string
  articleCode: string
}

export const blankDepthDraft = (): DepthDraft => ({ bodyId: '', levels: {}, baseId: '', supplierId: '', articleCode: '' })

export interface DepthModel {
  depth: Read<Depth>
  /** The directory's active bodies (read when a body is picked). */
  bodies: Read<NotifiedBody[]> | null
  /** The suppliers a bought-in part may name (parties.view; null while unread). */
  suppliers: Read<SupplierOption[]> | null
  dialog: DepthDialog | null
  draft: DepthDraft
  busy: boolean
  /** A `compliance-certificates-depth` key for a refused write, and the API's sentences under it. */
  problem: string | null
  lines: readonly string[]
}

/** Why a depth write is held now (a key), or null: manage, a registered certificate's filled-once rule, a withdrawn one. */
export function writeHeld(depth: Depth, can: CertCan, what: 'body' | 'levels' | 'base'): string | null {
  if (!can.manage || !depth.mayManage) return 'held.manage'
  const { certificate } = depth
  if (certificate.status === 'WITHDRAWN' || certificate.status === 'EXPIRED') return 'held.final'
  if (!certificate.registered) return what === 'levels' && depth.levels.family === null ? 'levels.held.none' : what === 'base' && !depth.ownBrand.brandHeld ? 'base.held.notBrand' : null
  if (what === 'body') return depth.body.directory ? 'held.filledOnce' : depth.body.matching.length === 0 ? 'body.held.noMatch' : null
  if (what === 'levels') return depth.levels.family === null ? 'levels.held.none' : depth.levels.values ? 'held.filledOnce' : null
  if (!depth.ownBrand.brandHeld) return 'base.held.notBrand'
  return depth.ownBrand.base ? 'held.filledOnce' : null
}

/** The bodies Pick from the directory offers: a registered certificate only the body its typed number names. */
export function pickableBodies(depth: Depth, bodies: readonly NotifiedBody[] | null): NotifiedBody[] {
  if (depth.certificate.registered) return depth.body.matching
  return (bodies ?? []).filter((body) => body.status === 'ACTIVE')
}

/** Why Pick is held in the dialog, or null. */
export function pickHeld(depth: Depth, draft: DepthDraft, busy: boolean): string | null {
  if (!draft.bodyId) return 'body.held.pick'
  if (draft.bodyId === depth.body.directory?.id) return 'body.held.same'
  return busy ? 'held.busy' : null
}

/** The levels a dialog starts from: the stored ones, or the vocabulary's required properties empty. */
export function levelsDraftOf(depth: Depth): Record<string, string> {
  return { ...(depth.levels.values ?? {}) }
}

/** What is wrong with the levels being typed (the domain's own check), by property; `_` for the whole. */
export function levelsDraftProblems(depth: Depth, levels: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const problem of levelsProblems(depth.certificate.standard, depth.certificate.ppeClass, cleanLevels(levels))) {
    const key = problem.path.replace(/^levels\/?/, '') || '_'
    if (!out[key]) out[key] = problem.message
  }
  return out
}

export function levelsHeld(depth: Depth, levels: Record<string, string>, busy: boolean): string | null {
  if (Object.keys(levelsDraftProblems(depth, levels)).length > 0) return 'levels.held.invalid'
  if (sameLevels(cleanLevels(levels), depth.levels.values)) return 'levels.held.same'
  return busy ? 'held.busy' : null
}

export function baseHeld(depth: Depth, draft: DepthDraft, busy: boolean): string | null {
  if (!draft.baseId) return 'base.held.pick'
  if (draft.baseId === depth.ownBrand.base?.id) return 'base.held.same'
  return busy ? 'held.busy' : null
}

/** The base candidates the dialog offers, the same standard first (the API sorts them so). */
export const baseCandidates = (depth: Depth): CertificateSummary[] => depth.ownBrand.candidates

/** Why naming a part's supplier is held (a key), or null. */
export function supplierHeld(part: BoughtInPart, draft: DepthDraft, can: CertCan, busy: boolean): string | null {
  if (!can.manage) return 'held.manage'
  if (!can.parties) return 'supplier.held.parties'
  if (!draft.supplierId) return 'supplier.held.pick'
  if (part.supplier && part.supplier.id !== draft.supplierId) return 'supplier.held.once'
  if (draft.articleCode.length > ARTICLE_CODE_MAX) return 'held.long'
  if (part.supplier?.id === draft.supplierId && (part.supplierArticleCode ?? '') === draft.articleCode.trim()) return 'supplier.held.same'
  return busy ? 'held.busy' : null
}

/** The row verb's state for a part: name its supplier, or change its article code (the supplier stays). */
export const supplierVerb = (part: BoughtInPart): 'name' | 'code' => (part.supplier ? 'code' : 'name')

/** A supplier's name as the screens show it. */
export const supplierName = (supplier: SupplierOption): string => supplier.tradeName?.trim() || supplier.legalName

/** A body's scope check for the certificate's kind (another standard is checked as clothing). */
export const bodyScopeFor = (body: Pick<NotifiedBody, 'scopes'>, kind: CertificateKind): ScopeCheckView => scopeCheck(body.scopes, kind === 'OTHER' ? 'GARMENT' : kind)

/** The NANDO address to open in a new tab (only an https one). */
export const nandoHref = (body: Pick<NotifiedBody, 'nandoUrl'> | null): string | null => (body ? nandoLink(body.nandoUrl) : null)

// ---- the Notified bodies pop-up (SCR-291) ------------------------------------------------------------------------------

export type BodiesFilter = 'ACTIVE' | 'ARCHIVED' | 'ALL'

export interface BodyDraft {
  number: string
  name: string
  address: string
  country: string
  nandoUrl: string
  /** One scope per line. */
  scopes: string
  contactEmail: string
  contactPhone: string
  note: string
}

export const blankBodyDraft = (): BodyDraft => ({ number: '', name: '', address: '', country: 'IT', nandoUrl: '', scopes: '', contactEmail: '', contactPhone: '', note: '' })

export const bodyDraftOf = (body: NotifiedBody): BodyDraft => ({
  number: body.number,
  name: body.name,
  address: body.address,
  country: body.country,
  nandoUrl: body.nandoUrl ?? '',
  scopes: body.scopes.join('\n'),
  contactEmail: body.contactEmail ?? '',
  contactPhone: body.contactPhone ?? '',
  note: body.note ?? '',
})

const blankToNull = (value: string): string | null => (value.trim() === '' ? null : value.trim())

export function bodyInputOf(draft: BodyDraft): BodyInput {
  return {
    number: draft.number.trim(),
    name: draft.name.trim(),
    address: draft.address.trim(),
    country: draft.country.trim().toUpperCase(),
    nandoUrl: blankToNull(draft.nandoUrl),
    scopes: cleanScopes(draft.scopes.split('\n')),
    contactEmail: blankToNull(draft.contactEmail),
    contactPhone: blankToNull(draft.contactPhone),
    note: blankToNull(draft.note),
  }
}

export type BodyField = keyof BodyDraft

/** What is wrong with the body being typed, by field (the domain's own check; the field's words are this app's). */
export function bodyDraftProblems(draft: BodyDraft): Partial<Record<BodyField, string>> {
  const out: Partial<Record<BodyField, string>> = {}
  const input = bodyInputOf(draft)
  for (const problem of bodyProblems(input)) {
    const field = problem.path.split('/')[0] as BodyField
    if (!out[field]) out[field] = `bodyForm.problem.${field}`
  }
  if (!input.name) out.name = 'bodyForm.problem.name'
  if (!input.address) out.address = 'bodyForm.problem.address'
  return out
}

export const BODY_FIELDS: readonly BodyField[] = ['number', 'name', 'address', 'country', 'nandoUrl', 'scopes', 'contactEmail', 'contactPhone', 'note']

export interface BodiesModel {
  open: boolean
  filter: BodiesFilter
  q: string
  directory: Read<Directory> | null
  selected: readonly string[]
  /** The body being added (`new`) or edited (its id); null: the list. */
  form: { mode: 'new' | 'edit'; bodyId: string | null; draft: BodyDraft; touched: readonly BodyField[] } | null
  busy: boolean
  problem: string | null
  lines: readonly string[]
  notice: { key: string; params?: Record<string, string | number> } | null
}

export const closedBodies = (): BodiesModel => ({ open: false, filter: 'ACTIVE', q: '', directory: null, selected: [], form: null, busy: false, problem: null, lines: [], notice: null })

/** The rows the pop-up shows: the filter's status, then the words (number, name, country, a scope). */
export function bodyRows(bodies: readonly NotifiedBody[], filter: BodiesFilter, q: string): NotifiedBody[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return bodies.filter(
    (body) =>
      (filter === 'ALL' || body.status === filter) &&
      words.every((word) => [body.number, body.name, body.country, ...body.scopes].join(' ').toLowerCase().includes(word)),
  )
}

/** Why Add / Save is held (a key), or null. */
export function bodyFormHeld(model: BodiesModel, can: CertCan, mayManage: boolean): string | null {
  if (!can.manage || !mayManage) return 'bodies.held.manage'
  if (!model.form) return null
  const problems = bodyDraftProblems(model.form.draft)
  const first = BODY_FIELDS.find((field) => problems[field])
  if (first) return problems[first]!
  return model.busy ? 'held.busy' : null
}

/** The number may change only while no certificate links the body (the database's rule, said here first). */
export const numberFixed = (body: NotifiedBody | null): boolean => !!body && body.linked > 0

/** The CSV of the directory's selected (or shown) rows. */
export function bodiesCsv(bodies: readonly NotifiedBody[], header: readonly string[], words: { status: (body: NotifiedBody) => string; scope: (body: NotifiedBody) => string }): (string | number | null)[][] {
  return [
    [...header],
    ...bodies.map((body) => [body.number, body.name, body.country, body.address.replace(/\s*\n\s*/g, ', '), body.scopes.join('; '), words.scope(body), body.nandoUrl, body.contactEmail, body.contactPhone, body.certificates, words.status(body)]),
  ]
}
