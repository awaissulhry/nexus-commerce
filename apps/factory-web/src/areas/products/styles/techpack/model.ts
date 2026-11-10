import { isApiError, issuePath } from '../../../../lib/api/errors'
import { LEFT_OUT_KINDS, TECH_PACK_AUDIENCES, TECH_PACK_SECTIONS, type LeftOutKind, type TechPackAudience, type TechPackLanguage, type TechPackSection } from '@nexus/factory-domain/product/techpack/rules'
import { formatTechPackCode, readTechPackCode, SCAN_STATES, type ScanState } from '@nexus/factory-domain/product/techpack/scan'
import type { StyleTab } from '../model'
import type { CopyPartyRow, ScanView, TechPackPdfView, TechPackVersion, TechPackView } from './api'

/**
 * The tech pack screens' rules, pure (B-W2b-243; SCR-305 the Style › Tech pack tab and its Make tech pack PDF pop-up, SCR-306
 * the PDF window and the landing of a scanned QR): who may do what, the sections a person may see, the address terms, the
 * words of every state from codes and figures (never the API's English sentences), what holds Make PDF and why, a refusal in
 * our words. The containers and views use these; the tests hold them.
 */

export const NS = 'products-techpack'
export const NAMESPACES = [NS, 'products', 'products-prepacks'] as const

export { LEFT_OUT_KINDS, SCAN_STATES, TECH_PACK_AUDIENCES as AUDIENCES, TECH_PACK_SECTIONS as SECTIONS }
export type { LeftOutKind, ScanState, TechPackAudience, TechPackLanguage, TechPackSection }

export const LANGUAGES = ['it', 'en'] as const satisfies readonly TechPackLanguage[]

export interface Words {
  readonly key: string
  readonly params?: Record<string, string | number>
}

/** A read of the API: loading, its answer, or why not (a key of the catalogue). */
export type Read<T> = { readonly status: 'loading' } | { readonly status: 'ready'; readonly value: T } | { readonly status: 'error'; readonly problem: string }
export const reading = <T>(): Read<T> => ({ status: 'loading' })
export const ready = <T>(value: T): Read<T> => ({ status: 'ready', value })
export const failed = <T>(problem: string): Read<T> => ({ status: 'error', problem })
export const valueOf = <T>(read: Read<T> | null | undefined): T | null => (read && read.status === 'ready' ? read.value : null)

// ---- who may do what --------------------------------------------------------------------------------------------------------

export interface TechPackCan {
  /** The live tech pack and its versions: the revision's BOM (product.bom.view). */
  view: boolean
  /** Make tech pack PDF (product.techpacks.make: the production manager and the buyer; the owner). */
  make: boolean
  /** The construction section shows the routing (product.routing.view). */
  routing: boolean
  /** The protection and compliance sections show the certificates (compliance.certificates.view). */
  certificates: boolean
  /** A BOM line's cost on the INTERNAL preview (money.cost). */
  cost: boolean
  /** Name the party a partner copy is for (parties.view). */
  parties: boolean
}

export function techPackCan(permissions: readonly string[]): TechPackCan {
  const held = new Set(permissions)
  return {
    view: held.has('product.bom.view'),
    make: held.has('product.techpacks.make'),
    routing: held.has('product.routing.view'),
    certificates: held.has('compliance.certificates.view'),
    cost: held.has('money.cost'),
    parties: held.has('parties.view'),
  }
}

/** The sections this person may see (the API's rule: the construction needs the routing, protection and compliance the certificates). */
export function allowedSections(can: Pick<TechPackCan, 'routing' | 'certificates'>): TechPackSection[] {
  return TECH_PACK_SECTIONS.filter((section) => (section === 'CONSTRUCTION' ? can.routing : section === 'PROTECTION' || section === 'COMPLIANCE' ? can.certificates : true))
}

/** The chosen sections with one put in or left out, in the design's order, each once. */
export function withSection(chosen: readonly TechPackSection[], section: TechPackSection, on: boolean): TechPackSection[] {
  const set = new Set(chosen)
  if (on) set.add(section)
  else set.delete(section)
  return TECH_PACK_SECTIONS.filter((entry) => set.has(entry))
}

export const audienceOf = (value: string | null | undefined): TechPackAudience => ((TECH_PACK_AUDIENCES as readonly string[]).includes(value ?? '') ? (value as TechPackAudience) : 'INTERNAL')
export const languageOf = (value: string | null | undefined, fallback: TechPackLanguage): TechPackLanguage => ((LANGUAGES as readonly string[]).includes(value ?? '') ? (value as TechPackLanguage) : fallback)

/** The section's data lives on this tab of the style (design style.tp.outline "each section links to where its data lives"). */
export const SECTION_HOME: Readonly<Record<TechPackSection, StyleTab>> = {
  COVER: 'overview',
  SKETCHES: 'files',
  BOM: 'bom',
  COLOURWAYS: 'variants',
  SIZE_SPEC: 'sizes',
  CONSTRUCTION: 'routing',
  LABELS: 'compliance',
  PROTECTION: 'sizes',
  COMPLIANCE: 'compliance',
  REVISION_LOG: 'overview',
}

// ---- words from facts ------------------------------------------------------------------------------------------------------

/** Why a reader of this copy should look again: a draft revision, an obsolete one (with the revision in force). */
export function bannerWords(view: Pick<TechPackView, 'revision' | 'inForce'>): Words | null {
  if (view.revision.status === 'DRAFT') return { key: 'techpack.banner.draft', params: { revision: view.revision.revision } }
  if (view.revision.status === 'OBSOLETE') return view.inForce ? { key: 'techpack.banner.obsoleteInForce', params: { revision: view.revision.revision, inForce: view.inForce.revision } } : { key: 'techpack.banner.obsolete', params: { revision: view.revision.revision } }
  return null
}

/** "46–58", "50, 54", every size of the range in one run ("46–58"); empty: every size. */
export function sizesText(sizes: readonly string[], range: readonly string[]): string {
  if (sizes.length === 0) return ''
  const order = (size: string) => {
    const at = range.indexOf(size)
    return at < 0 ? range.length : at
  }
  const sorted = [...sizes].sort((a, b) => order(a) - order(b))
  const indices = sorted.map(order)
  const contiguous = sorted.length > 2 && indices.every((index, i) => index < range.length && (i === 0 || index === indices[i - 1]! + 1))
  return contiguous ? `${sorted[0]}–${sorted[sorted.length - 1]}` : sorted.join(', ')
}

/** What the release takes (B-W2b-231): every colourway and size, or the ones it names. */
export function scopeWords(revision: Pick<TechPackView['revision'], 'scopeColourways' | 'scopeSizes'>, range: readonly string[]): Words {
  const colourways = revision.scopeColourways
  const sizes = revision.scopeSizes
  if (colourways.length === 0 && sizes.length === 0) return { key: 'techpack.scope.whole' }
  if (colourways.length === 0) return { key: 'techpack.scope.sizes', params: { sizes: sizesText(sizes, range) } }
  if (sizes.length === 0) return { key: 'techpack.scope.colourways', params: { colourways: colourways.join(', ') } }
  return { key: 'techpack.scope.both', params: { colourways: colourways.join(', '), sizes: sizesText(sizes, range) } }
}

/** The certificate coverage in words (the API counts, we say). */
export function coverageWords(coverage: Pick<NonNullable<TechPackView['protection']>['coverage'], 'required' | 'covered' | 'notCovered'>): Words {
  if (!coverage.required) return { key: 'techpack.coverage.notRequired' }
  const offered = coverage.covered + coverage.notCovered
  if (offered === 0) return { key: 'techpack.coverage.noSkus' }
  if (coverage.notCovered === 0) return { key: 'techpack.coverage.all', params: { count: offered } }
  return { key: 'techpack.coverage.some', params: { covered: coverage.covered, count: offered, notCovered: coverage.notCovered } }
}

/** The code printed under the QR (`TP 7K3QM-2XA9B`), or the code as it came when it is not one. */
export function printedCode(code: string): string {
  return readTechPackCode(code) === null ? code : formatTechPackCode(code)
}

/** A stored version in a line: "v3 · Workshop copy · Italian · TP 0VCTY-7BFRV". */
export function versionWords(version: Pick<TechPackVersion, 'version' | 'audience' | 'language' | 'code'>): Words {
  return { key: version.audience ? 'techpack.version.line' : 'techpack.version.lineOther', params: { version: version.version, audience: version.audience ?? '', language: version.language, code: printedCode(version.code) } }
}

/** The versions newest first. */
export const newestFirst = (versions: readonly TechPackVersion[]): TechPackVersion[] => [...versions].sort((a, b) => b.version - a.version)

/** The version a window shows: the one asked, else the scanned one (by number), else the newest; null: none yet. */
export function pickVersion(versions: readonly TechPackVersion[], asked: string | null, scanned: number | null = null): TechPackVersion | null {
  if (asked) {
    const found = versions.find((entry) => entry.id === asked)
    if (found) return found
  }
  if (scanned !== null) {
    const found = versions.find((entry) => entry.version === scanned)
    if (found) return found
  }
  return newestFirst(versions)[0] ?? null
}

// ---- Make tech pack PDF --------------------------------------------------------------------------------------------------------

export interface MakeDraft {
  audience: TechPackAudience
  language: TechPackLanguage
  sections: TechPackSection[]
  /** Who a partner copy is for (printed on the cover); null: nobody named. */
  partyId: string | null
}

/** A private-label style's brand (its brand copy is for that brand only, and must name it). */
export interface PrivateLabel {
  id: string
  code: string
  name: string
}

/** What holds Make PDF (a key of the catalogue), or null: it may go. */
export function makeHeld(draft: MakeDraft, context: { can: Pick<TechPackCan, 'make'>; online: boolean; busy: boolean; revision: boolean; privateLabel: PrivateLabel | null; allowed: readonly TechPackSection[] }): string | null {
  if (!context.can.make) return 'techpack.held.noMake'
  if (!context.revision) return 'techpack.held.noRevision'
  if (!context.online) return 'techpack.held.offline'
  if (context.busy) return 'techpack.held.busy'
  if (draft.sections.length === 0) return 'techpack.held.noSections'
  if (draft.sections.some((section) => !context.allowed.includes(section))) return 'techpack.held.sectionNotYours'
  if (draft.audience === 'INTERNAL' && draft.partyId !== null) return 'techpack.held.internalParty'
  if (draft.audience === 'BRAND' && context.privateLabel && draft.partyId !== context.privateLabel.id) return 'techpack.held.privateLabel'
  return null
}

/** The party a new draft starts with: a private-label style's brand copy names its brand; anything else nobody. */
export function startParty(audience: TechPackAudience, privateLabel: PrivateLabel | null): string | null {
  return audience === 'BRAND' && privateLabel ? privateLabel.id : null
}

/** The parties a copy may be for: a private-label style's brand copy offers its brand only. */
export function partyChoices(audience: TechPackAudience, rows: readonly CopyPartyRow[] | null, privateLabel: PrivateLabel | null): CopyPartyRow[] {
  if (audience === 'INTERNAL') return []
  if (audience === 'BRAND' && privateLabel) return [{ id: privateLabel.id, code: privateLabel.code, legalName: privateLabel.name, tradeName: null }]
  return [...(rows ?? [])].sort((a, b) => a.code.localeCompare(b.code))
}

export const partyName = (row: Pick<CopyPartyRow, 'code' | 'legalName' | 'tradeName'>): string => `${row.code} · ${row.tradeName ?? row.legalName}`

/** A refused Make PDF (or a read) in our words: a key of the catalogue, by kind and by the place the API names. */
export function makeProblem(error: unknown): string {
  if (!isApiError(error)) return 'techpack.problem.make.internal'
  const paths = error.issues.map((issue) => issuePath(issue))
  if (error.kind === 'invalid') {
    if (paths.some((path) => path.includes('partyId'))) return 'techpack.problem.make.party'
    if (paths.some((path) => path.includes('sections'))) return 'techpack.problem.make.sections'
    if (paths.some((path) => path.includes('companyId'))) return 'techpack.problem.make.company'
    return 'techpack.problem.make.invalid'
  }
  if (error.kind === 'conflict') return 'techpack.problem.make.meanwhile'
  if (error.kind === 'forbidden') return 'techpack.problem.make.forbidden'
  if (error.kind === 'not_found') return 'techpack.problem.make.notFound'
  if (error.kind === 'signed_out' || error.kind === 'rate_limited' || error.kind === 'unavailable') return `techpack.problem.make.${error.kind}`
  return 'techpack.problem.make.internal'
}

/** A failed read in our words (a key of the catalogue). */
export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'techpack.problem.read.internal'
  return ['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'contract'].includes(error.kind) ? `techpack.problem.read.${error.kind}` : 'techpack.problem.read.internal'
}

/** What Make PDF did: a new version, or the newest again when nothing it says changed. */
export function madeWords(pdf: Pick<TechPackPdfView, 'made' | 'version'>): Words {
  const params = { version: pdf.version.version, code: printedCode(pdf.version.code) }
  return pdf.made ? { key: 'techpack.notice.made', params } : { key: 'techpack.notice.same', params }
}

// ---- the window and the scan --------------------------------------------------------------------------------------------------

/** The PDF window's company-free address (a window page, WINDOW_PAGES). */
export const WINDOW_PATH = '/products/styles/tech-pack'

export interface WindowTarget {
  styleId?: string | null
  revisionId?: string | null
  versionId?: string | null
  /** The scanned QR's code: the window says whether the page is current. */
  scan?: string | null
}

export function windowAddress(prefix: string, target: WindowTarget): string {
  const search = new URLSearchParams()
  if (target.styleId) search.set('style', target.styleId)
  if (target.revisionId) search.set('rev', target.revisionId)
  if (target.versionId) search.set('version', target.versionId)
  if (target.scan) search.set('scan', target.scan)
  const query = search.toString()
  return `${prefix}${WINDOW_PATH}${query ? `?${query}` : ''}`
}

/** The window's address terms. */
export function windowTargetOf(params: { get(name: string): string | null } | null): Required<WindowTarget> {
  return { styleId: params?.get('style') ?? null, revisionId: params?.get('rev') ?? null, versionId: params?.get('version') ?? null, scan: params?.get('scan') ?? null }
}

/** A scanned page's verdict in our words, with its tone. */
export function scanWords(scan: Pick<ScanView, 'state' | 'printed' | 'newer'>): Words & { tone: 'success' | 'info' | 'warning' | 'danger' } {
  const page = { version: scan.printed.version, revision: scan.printed.revision }
  switch (scan.state) {
    case 'CURRENT':
      return { key: 'techpack.scan.CURRENT', params: page, tone: 'success' }
    case 'DRAFT':
      return { key: 'techpack.scan.DRAFT', params: page, tone: 'info' }
    case 'NEWER_VERSION':
      return { key: 'techpack.scan.NEWER_VERSION', params: { ...page, newer: scan.newer?.version ?? '' }, tone: 'danger' }
    case 'NEWER_REVISION':
      return scan.newer?.version
        ? { key: 'techpack.scan.NEWER_REVISION', params: { ...page, inForce: scan.newer.revision, newer: scan.newer.version }, tone: 'danger' }
        : { key: 'techpack.scan.NEWER_REVISION_NONE', params: { ...page, inForce: scan.newer?.revision ?? '' }, tone: 'danger' }
    case 'OBSOLETE':
      return { key: 'techpack.scan.OBSOLETE', params: page, tone: 'warning' }
  }
}

/**
 * Where a scanned QR (`/tech-pack/<code>`, a company-free address) lands: the PDF window of the company this person works in
 * (the one they last chose, else their session's, else their first); null: no company to land in. A code that is not one is
 * still sent on: the window says so in words.
 */
export function scanLanding(code: string, company: string | null): string | null {
  if (!company) return null
  return windowAddress(`/w/${encodeURIComponent(company)}`, { scan: code.trim().slice(0, 200) })
}
