import { certificateGate, CERTIFIED_CATEGORIES, type GateReason, type SizeGateRequest } from '../../compliance/cert-gate/gate'
import { daysToExpiry, type CertificateStatus } from '../../compliance/certificates/rules'
import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { isLanguageCode } from '../../parties/geo'
import { certificateCheck, labelCheck, revisionCheck, type CellGate, type LabelFacts, type ReleaseCheck, type RevisionFacts } from '../../production/work-orders/release'
import { classOfStandard, type PpeCategory, type ProductType } from '../styles/rules'

/**
 * The style's compliance (B-W1-20; A2 SCR-045 "Style › Compliance"; features PRD-270, PRD-288, QHS-103, LOG-020;
 * Reg. (EU) 2016/425 arts. 8, 15, 18, Annex I, Annex II 1.4, Annex IX; EN 17092, EN 13594), pure. The API reads the
 * facts; these rules answer what the tab shows:
 *
 *   classification  PPE or not, its category, the standard with its part and edition, the class, who is the legal maker
 *                   (the brand with a brand label, else our company: PLAN §2.8), and what that asks for: a category II or
 *                   III garment needs a notified body's certificate (the gate); every PPE category needs its EU
 *                   Declaration of Conformity (art. 15) and its user information (art. 8(7), Annex II 1.4)
 *   coverage        per colourway × size, the certificate gate's answer on the day (B-W1-12's `certificateGate`, never
 *                   re-implemented here): COVERED (with the certificate, its last day and "expiring soon" within 60 days),
 *                   EXPIRED or SUSPENDED (a certificate would cover the cell but for its status), NOT_COVERED (no
 *                   certificate covers it, with the gate's reasons) or NOT_REQUIRED (not PPE, or category I)
 *   documents       per kind and language, for one style revision: CURRENT (an issued document of THIS revision with a
 *                   confirmed file), OLDER_REVISION (only an older revision's is on file) or MISSING
 *   checks          what blocks production, garment labels and shipping, in the work-order release's own words for the
 *                   revision, the garment label and the certificate (production/work-orders/release), and the documents
 *
 * A DoC or leaflet is a ComplianceDocument per style, kind, language and style revision NUMBER (`revision`: the
 * schema has no style revision column yet), DRAFT until its signed PDF is confirmed, then ISSUED; an older revision's
 * issued one becomes SUPERSEDED; a replacement is a new file on the same document (the old one is kept).
 */

// ---- documents: kinds, words, retention ----------------------------------------------------------------------------

export const DOCUMENT_KINDS = ['DECLARATION_OF_CONFORMITY', 'USER_INFORMATION'] as const
export type DocumentKind = (typeof DOCUMENT_KINDS)[number]
export const DOCUMENT_STATUSES = ['DRAFT', 'ISSUED', 'SUPERSEDED', 'WITHDRAWN'] as const
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number]

/** The document in words, for the person. */
export const DOCUMENT_WORDS: Readonly<Record<DocumentKind, string>> = Object.freeze({
  DECLARATION_OF_CONFORMITY: 'EU Declaration of Conformity',
  USER_INFORMATION: 'user information leaflet',
})
/** Where the law asks for it. */
const DOCUMENT_LAW: Readonly<Record<DocumentKind, string>> = Object.freeze({
  DECLARATION_OF_CONFORMITY: 'Reg. (EU) 2016/425 art. 8(8), art. 15',
  USER_INFORMATION: 'Reg. (EU) 2016/425 art. 8(7), Annex II 1.4',
})

/** A signed DoC and a leaflet are PDF files. */
export const DOCUMENT_CONTENT_TYPE = 'application/pdf'
/**
 * Reg. (EU) 2016/425 art. 8(3): the DoC (and the technical documentation it belongs to) is kept ten years after the PPE
 * was placed on the market. A confirmed file is kept ten years from its confirmation at least; the shipping step that
 * sends it with the goods (B-W1-49) moves the date to ten years after that shipment.
 */
export const DOCUMENT_RETENTION_YEARS = 10
/** The coverage grid's "expiring soon" tone (design 02, Style › Compliance › Certificate coverage). */
export const EXPIRING_SOON_DAYS = 60

/** The problems of a DoC or leaflet upload as announced (empty when it may be uploaded). Paths are body fields. */
export function documentUploadProblems(input: { readonly language: string; readonly contentType: string }): Issue[] {
  const problems: Issue[] = []
  if (!isLanguageCode(input.language)) problems.push({ path: 'language', message: 'Expected an ISO 639-1 language code (it, en, de…).' })
  if (input.contentType.split(';')[0]!.trim().toLowerCase() !== DOCUMENT_CONTENT_TYPE) {
    problems.push({ path: 'contentType', message: 'A signed Declaration of Conformity or a user information leaflet is a PDF (application/pdf).' })
  }
  return problems
}

// ---- classification (PRD-270) ----------------------------------------------------------------------------------------

export interface StyleFacts {
  readonly id: string
  readonly code: string
  readonly productType: ProductType
  readonly ppeCategory: PpeCategory
  readonly ppeStandard: string | null
  readonly ppeClass: string | null
  readonly brandPartyId: string | null
}

/** A standard as written ("EN 17092-4:2020"): its number, its part and its edition. */
export interface StandardParts {
  /** "EN 17092", "EN 13594", "EN 1621". */
  readonly code: string
  /** "4" for EN 17092-4; null when the standard has no part. */
  readonly part: string | null
  /** "2020"; null when not written. */
  readonly edition: string | null
}

export function standardParts(standard: string | null): StandardParts | null {
  if (standard === null) return null
  const match = /^(.*?\d)(?:-(\d+))?(?::(\d{4}))?$/.exec(standard.trim())
  if (!match) return { code: standard.trim(), part: null, edition: null }
  return { code: match[1]!, part: match[2] ?? null, edition: match[3] ?? null }
}

export type LegalMaker = 'BRAND' | 'COMPANY'

export interface Classification {
  readonly isPpe: boolean
  readonly category: PpeCategory
  readonly standard: string | null
  readonly standardCode: string | null
  readonly part: string | null
  readonly edition: string | null
  readonly ppeClass: string | null
  /** The class an EN 17092 part sets (part 4 → A); null for other standards. */
  readonly partClass: string | null
  /** Category II or III: a notified body's EU type-examination certificate covers every garment (the gate). */
  readonly certificateRequired: boolean
  /** Any PPE category: its EU Declaration of Conformity and its user information travel with the goods. */
  readonly documentsRequired: boolean
  /** With a brand label the brand is the legal PPE maker (PLAN §2.8), else our company. */
  readonly legalMaker: LegalMaker
  /** The classification and what it asks for, in words. */
  readonly message: string
}

export function classificationOf(style: StyleFacts): Classification {
  const isPpe = style.ppeCategory !== 'NOT_PPE'
  const parts = standardParts(style.ppeStandard)
  const certificateRequired = CERTIFIED_CATEGORIES.includes(style.ppeCategory)
  const made = style.ppeStandard ? ` made to ${style.ppeStandard}${style.ppeClass ? `, class ${style.ppeClass}` : ''}` : ''
  const message = !isPpe
    ? `Style ${style.code} is not PPE: no certificate, Declaration of Conformity or user information leaflet is needed.`
    : certificateRequired
      ? `Style ${style.code} is ${style.ppeCategory === 'CATEGORY_III' ? 'category III' : 'category II'} PPE${made}: a valid EU type-examination certificate must cover every colourway and size, and its EU Declaration of Conformity and user information travel with the goods (Reg. (EU) 2016/425).`
      : `Style ${style.code} is category I PPE${made}: it is self-certified (no notified body), and its EU Declaration of Conformity and user information travel with the goods (Reg. (EU) 2016/425 Annex I, art. 15).`
  return {
    isPpe,
    category: style.ppeCategory,
    standard: style.ppeStandard,
    standardCode: parts?.code ?? null,
    part: parts?.part ?? null,
    edition: parts?.edition ?? null,
    ppeClass: style.ppeClass,
    partClass: classOfStandard(style.ppeStandard),
    certificateRequired,
    documentsRequired: isPpe,
    legalMaker: style.brandPartyId ? 'BRAND' : 'COMPANY',
    message,
  }
}

// ---- coverage per colourway × size ---------------------------------------------------------------------------------

export const CELL_STATUSES = ['COVERED', 'NOT_COVERED', 'EXPIRED', 'SUSPENDED', 'NOT_REQUIRED'] as const
export type CellStatus = (typeof CELL_STATUSES)[number]

export interface CellCertificate {
  readonly id: string
  readonly number: string
  readonly standard: string
  readonly ppeClass: string | null
  readonly notifiedBodyNumber: string
  readonly validFrom: BusinessDate
  readonly validTo: BusinessDate
  readonly status: CertificateStatus
}

/** One cell of the grid as the API read it: a colourway in a size of the style's range, and whether its SKU is on. */
export interface GridCell {
  readonly colourwayId: string
  readonly colourwayCode: string
  readonly size: string
  /** The SKU is on (an ACTIVE variant): an offered cell blocks release, labels and shipping when not covered. */
  readonly offered: boolean
}

export interface CoverageCell {
  readonly colourwayId: string
  readonly size: string
  /** "BLK 52", as the work-order release names a cell. */
  readonly label: string
  readonly offered: boolean
  readonly status: CellStatus
  /** The covering certificate; the expired or suspended one that would cover it; null otherwise. */
  readonly certificate: CellCertificate | null
  readonly coverageId: string | null
  /** Days to the certificate's last valid day (0 on that day, negative once expired); null without a certificate. */
  readonly daysToExpiry: number | null
  /** Covered, but the certificate ends within EXPIRING_SOON_DAYS. */
  readonly expiringSoon: boolean
  /** One sentence for the person. */
  readonly message: string
  /** Every reason the gate gave (refused cells). */
  readonly reasons: readonly GateReason[]
}

/** The reasons that are about a certificate's status only: without them, that certificate would cover the cell. */
const STATUS_REASONS: ReadonlySet<GateReason['code']> = new Set(['certificate_expired', 'certificate_not_valid', 'certificate_not_yet_valid'])

/**
 * The gate's answer for one cell, from the style's gate request (read once by the API) with the cell's colourway and
 * size: B-W1-12's certificateGate decides, this only sorts a refusal into EXPIRED, SUSPENDED or NOT_COVERED.
 */
export function coverageCell(base: SizeGateRequest, cell: GridCell): CoverageCell {
  const label = `${cell.colourwayCode} ${cell.size}`
  const result = certificateGate({ ...base, colourwayId: cell.colourwayId, size: cell.size })
  const certificateOf = (id: string): CellCertificate | null => {
    const found = base.covers.find((cover) => cover.certificate.id === id)?.certificate
    return found
      ? { id: found.id, number: found.number, standard: found.standard, ppeClass: found.ppeClass, notifiedBodyNumber: found.notifiedBodyNumber, validFrom: found.validFrom, validTo: found.validTo, status: found.status }
      : null
  }
  const common = { colourwayId: cell.colourwayId, size: cell.size, label, offered: cell.offered }

  if (result.outcome === 'not_required') {
    return { ...common, status: 'NOT_REQUIRED', certificate: null, coverageId: null, daysToExpiry: null, expiringSoon: false, message: result.message, reasons: [] }
  }
  if (result.outcome === 'covered') {
    const certificate = certificateOf(result.certificate.id)
    const days = daysToExpiry(result.certificate.validTo, base.date)
    return {
      ...common,
      status: 'COVERED',
      certificate,
      coverageId: result.coverageId,
      daysToExpiry: days,
      expiringSoon: days <= EXPIRING_SOON_DAYS,
      message: `Covered by certificate ${result.certificate.number} (${result.certificate.standard}${result.certificate.ppeClass ? `, class ${result.certificate.ppeClass}` : ''}), valid until ${result.certificate.validTo}.`,
      reasons: [],
    }
  }

  // Refused: is there a certificate that covers this colourway and size but for its status?
  const byCertificate = new Map<string, GateReason[]>()
  for (const reason of result.reasons) {
    if (reason.certificateId) byCertificate.set(reason.certificateId, [...(byCertificate.get(reason.certificateId) ?? []), reason])
  }
  const wouldCover = [...byCertificate.entries()].filter(([, reasons]) => reasons.every((reason) => STATUS_REASONS.has(reason.code)))
  const latestFirst = (a: { certificate: CellCertificate }, b: { certificate: CellCertificate }) => (a.certificate.validTo < b.certificate.validTo ? 1 : a.certificate.validTo > b.certificate.validTo ? -1 : 0)
  const pick = (test: (certificate: CellCertificate, reasons: readonly GateReason[]) => boolean, code: GateReason['code']) =>
    wouldCover
      .flatMap(([id, reasons]) => {
        const certificate = certificateOf(id)
        const reason = reasons.find((entry) => entry.code === code)
        return certificate && reason && test(certificate, reasons) ? [{ certificate, reason }] : []
      })
      .sort(latestFirst)[0]
  const expired = pick(() => true, 'certificate_expired')
  const suspended = expired ? undefined : pick((certificate) => certificate.status === 'SUSPENDED', 'certificate_not_valid')
  const chosen = expired ?? suspended
  const reasons = [...result.reasons]
  if (chosen) {
    return {
      ...common,
      status: expired ? 'EXPIRED' : 'SUSPENDED',
      certificate: chosen.certificate,
      coverageId: null,
      daysToExpiry: daysToExpiry(chosen.certificate.validTo, base.date),
      expiringSoon: false,
      message: chosen.reason.message,
      reasons,
    }
  }
  return { ...common, status: 'NOT_COVERED', certificate: null, coverageId: null, daysToExpiry: null, expiringSoon: false, message: reasons[0]?.message ?? `No certificate covers ${label}.`, reasons }
}

export interface CoverageCounts {
  readonly cells: number
  readonly offered: number
  readonly covered: number
  readonly expiringSoon: number
  readonly notCovered: number
  readonly expired: number
  readonly suspended: number
}

/** The counts of the offered cells (the grid's legend). */
export function coverageCounts(cells: readonly CoverageCell[]): CoverageCounts {
  const offered = cells.filter((cell) => cell.offered)
  const count = (status: CellStatus) => offered.filter((cell) => cell.status === status).length
  return {
    cells: cells.length,
    offered: offered.length,
    covered: count('COVERED'),
    expiringSoon: offered.filter((cell) => cell.expiringSoon).length,
    notCovered: count('NOT_COVERED'),
    expired: count('EXPIRED'),
    suspended: count('SUSPENDED'),
  }
}

/** The cells the release check and the blockers look at: the offered ones; every cell while the style has no SKU on. */
export const checkedCells = (cells: readonly CoverageCell[]): readonly CoverageCell[] => (cells.some((cell) => cell.offered) ? cells.filter((cell) => cell.offered) : cells)

/** A cell as the work-order release's certificate check reads it; its problems' paths are `cells/<colourway>/<size>/certificate`. */
export const cellGateOf = (cell: CoverageCell): CellGate => ({
  cellId: `${cell.colourwayId}/${cell.size}`,
  label: cell.label,
  outcome: cell.status === 'COVERED' ? 'covered' : cell.status === 'NOT_REQUIRED' ? 'not_required' : 'refused',
  certificateNumber: cell.status === 'COVERED' ? (cell.certificate?.number ?? null) : null,
  validTo: cell.status === 'COVERED' ? (cell.certificate?.validTo ?? null) : null,
  reasons: cell.reasons.map((reason) => reason.message),
  message: cell.status === 'NOT_REQUIRED' ? cell.message : null,
})

// ---- documents per language (DoC and leaflet) ------------------------------------------------------------------------

export interface DocumentFile {
  readonly id: string
  readonly originalName: string
  readonly sizeBytes: number
  readonly sha256: string
  readonly availableAt: string
}

export interface DocumentFacts {
  readonly id: string
  readonly kind: DocumentKind
  readonly language: string
  /** The style revision NUMBER it is for. */
  readonly revision: number
  readonly status: DocumentStatus
  readonly number: string | null
  readonly issuedAt: string | null
  /** The newest confirmed (AVAILABLE) file: the version in force. */
  readonly currentFile: DocumentFile | null
  /** How many confirmed files it has (the versions, the current one included). */
  readonly versions: number
  /** A newer upload was announced and not confirmed yet. */
  readonly pendingUpload: boolean
}

/** It can travel with the goods: issued (or superseded by a newer revision's) and its signed file confirmed. */
export const isUsableDocument = (document: Pick<DocumentFacts, 'status' | 'currentFile'>): boolean =>
  (document.status === 'ISSUED' || document.status === 'SUPERSEDED') && document.currentFile !== null

/**
 * The document that goes with garments of this style revision (by its number), in this kind and language: the one
 * issued for exactly that revision, with its confirmed file; null when there is none. An older revision's document
 * never counts: the revision may have changed what the declaration declares.
 */
export function currentDocument<Document extends Pick<DocumentFacts, 'kind' | 'language' | 'revision' | 'status' | 'currentFile'>>(
  documents: readonly Document[],
  revision: number,
  kind: DocumentKind,
  language: string,
): Document | null {
  return documents.find((document) => document.kind === kind && document.language === language && document.revision === revision && isUsableDocument(document)) ?? null
}

export const DOCUMENT_STATES = ['CURRENT', 'OLDER_REVISION', 'MISSING'] as const
export type DocumentState = (typeof DOCUMENT_STATES)[number]

export interface LanguageStatus {
  readonly kind: DocumentKind
  readonly language: string
  readonly state: DocumentState
  /** The style revision asked about (its number); null when the style has none. */
  readonly revision: number | null
  /** The document that counts: the current one, or the older revision's one; null when missing. */
  readonly document: DocumentFacts | null
  /** An upload for the revision waits to be confirmed. */
  readonly pendingUpload: boolean
  readonly message: string
}

/** The state of one kind in one language for a style revision. */
export function documentStatus(kind: DocumentKind, language: string, revision: number | null, documents: readonly DocumentFacts[]): LanguageStatus {
  const words = DOCUMENT_WORDS[kind]
  if (revision === null) {
    return { kind, language, state: 'MISSING', revision, document: null, pendingUpload: false, message: `The style has no revision yet, so no ${words} in ${language} is on file for it.` }
  }
  const own = documents.find((document) => document.kind === kind && document.language === language && document.revision === revision) ?? null
  const pendingUpload = own !== null && (own.pendingUpload || (own.status === 'DRAFT' && own.currentFile === null))
  const current = currentDocument(documents, revision, kind, language)
  if (current) {
    return { kind, language, state: 'CURRENT', revision, document: current, pendingUpload: current.pendingUpload, message: `The ${words} in ${language} for revision ${revision} is on file${current.number ? ` (${current.number})` : ''}.` }
  }
  const older = documents
    .filter((document) => document.kind === kind && document.language === language && document.revision < revision && isUsableDocument(document))
    .sort((a, b) => b.revision - a.revision)[0]
  if (older) {
    return {
      kind,
      language,
      state: 'OLDER_REVISION',
      revision,
      document: older,
      pendingUpload,
      message: `The ${words} in ${language} is for revision ${older.revision}, an older revision: upload the signed one for revision ${revision}.`,
    }
  }
  return {
    kind,
    language,
    state: 'MISSING',
    revision,
    document: null,
    pendingUpload,
    message: `No signed ${words} in ${language} is on file for revision ${revision}${pendingUpload ? ': an upload waits to be confirmed' : ''}.`,
  }
}

/**
 * The languages to show for a kind: the ones the revision's garment label prints (the markets' languages, until W2b's
 * market rules), then any other language a document of that kind exists in (not withdrawn), alphabetically.
 */
export function documentLanguages(kind: DocumentKind, documents: readonly Pick<DocumentFacts, 'kind' | 'language' | 'status'>[], expected: readonly string[]): string[] {
  const languages = [...new Set(expected.map((language) => language.trim().toLowerCase()).filter((language) => language !== ''))]
  const others = [...new Set(documents.filter((document) => document.kind === kind && document.status !== 'WITHDRAWN').map((document) => document.language))]
    .filter((language) => !languages.includes(language))
    .sort()
  return [...languages, ...others]
}

/**
 * What issuing a document changes beside it: the issued documents of the same kind and language for an OLDER style
 * revision become SUPERSEDED; when one for a NEWER revision is already issued, the new one is superseded at once (a
 * late upload kept for the garments of its revision).
 */
export function issuePlan(
  documents: readonly Pick<DocumentFacts, 'id' | 'kind' | 'language' | 'revision' | 'status'>[],
  issuing: Pick<DocumentFacts, 'id' | 'kind' | 'language' | 'revision'>,
): { readonly supersede: string[]; readonly supersededAtOnce: boolean } {
  const same = documents.filter((document) => document.id !== issuing.id && document.kind === issuing.kind && document.language === issuing.language)
  return {
    supersede: same.filter((document) => document.status === 'ISSUED' && document.revision < issuing.revision).map((document) => document.id).sort(),
    supersededAtOnce: same.some((document) => (document.status === 'ISSUED' || document.status === 'SUPERSEDED') && document.revision > issuing.revision),
  }
}

// ---- the legal maker named on a DoC (Annex IX 2) --------------------------------------------------------------------

export interface PostalAddress {
  readonly line1: string
  readonly line2?: string | null
  readonly postalCode: string
  readonly city: string
  readonly province?: string | null
  readonly country: string
}

export const addressText = (address: PostalAddress): string =>
  [address.line1, address.line2, `${address.postalCode} ${address.city}${address.province ? ` (${address.province})` : ''}`, address.country]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(', ')

export interface Maker {
  readonly makerPartyId: string | null
  readonly makerName: string
  readonly makerAddress: string
}

/**
 * The maker a DoC names (Annex IX 2; PLAN §2.8): the one the revision's garment label names (art. 8(6), as printed),
 * else the style's brand (its legal name and registered office), else the style's company; null when the one that
 * applies has no address on record.
 */
export function makerOf(input: {
  readonly label: Maker | null
  readonly brand: { readonly id: string; readonly legalName: string; readonly address: PostalAddress | null } | null
  readonly company: { readonly legalName: string; readonly address: PostalAddress | null } | null
}): Maker | null {
  if (input.label) return input.label
  if (input.brand) return input.brand.address ? { makerPartyId: input.brand.id, makerName: input.brand.legalName, makerAddress: addressText(input.brand.address) } : null
  if (input.company?.address) return { makerPartyId: null, makerName: input.company.legalName, makerAddress: addressText(input.company.address) }
  return null
}

// ---- what blocks production, labels and shipping -------------------------------------------------------------------

export const COMPLIANCE_CHECKS = ['REVISION', 'LABEL_TEMPLATE', 'CERTIFICATE', 'DECLARATION_OF_CONFORMITY', 'USER_INFORMATION'] as const
export type ComplianceCheckCode = (typeof COMPLIANCE_CHECKS)[number]
export const BLOCKED_STEPS = ['PRODUCTION', 'LABELS', 'SHIPPING'] as const
export type BlockedStep = (typeof BLOCKED_STEPS)[number]
export const COMPLIANCE_CHECK_STATES = ['OK', 'BLOCKED', 'NOT_REQUIRED'] as const
export type ComplianceCheckState = (typeof COMPLIANCE_CHECK_STATES)[number]

export interface ComplianceCheck {
  readonly code: ComplianceCheckCode
  readonly state: ComplianceCheckState
  /** What it holds up when BLOCKED: the work-order release, garment labels, shipping. */
  readonly blocks: readonly BlockedStep[]
  readonly message: string
  readonly problems: readonly Issue[]
}

const BLOCKS: Readonly<Record<ComplianceCheckCode, readonly BlockedStep[]>> = Object.freeze({
  REVISION: ['PRODUCTION'],
  LABEL_TEMPLATE: ['PRODUCTION', 'LABELS'],
  CERTIFICATE: ['PRODUCTION', 'LABELS', 'SHIPPING'],
  DECLARATION_OF_CONFORMITY: ['SHIPPING'],
  USER_INFORMATION: ['SHIPPING'],
})

const fromRelease = (check: ReleaseCheck, code: ComplianceCheckCode): ComplianceCheck => ({
  code,
  state: check.state === 'BLOCKED' ? 'BLOCKED' : check.state === 'NOT_REQUIRED' ? 'NOT_REQUIRED' : 'OK',
  blocks: BLOCKS[code],
  message: check.message,
  problems: check.state === 'BLOCKED' ? check.problems : [],
})

function documentCheck(kind: DocumentKind, classification: Classification, revision: number | null, statuses: readonly LanguageStatus[]): ComplianceCheck {
  const words = DOCUMENT_WORDS[kind]
  const done = (state: ComplianceCheckState, message: string, problems: readonly Issue[] = []): ComplianceCheck => ({
    code: kind,
    state,
    blocks: BLOCKS[kind],
    message,
    problems: state === 'BLOCKED' && problems.length === 0 ? [{ path: `documents/${kind}`, message }] : problems,
  })
  if (!classification.documentsRequired) return done('NOT_REQUIRED', `Not PPE: no ${words} is needed.`)
  if (revision === null) return done('BLOCKED', `The style has no revision yet, so no ${words} can be on file for it (${DOCUMENT_LAW[kind]}).`)
  if (statuses.length === 0) {
    return done('BLOCKED', `No signed ${words} is on file for revision ${revision}: PPE is shipped only with it (${DOCUMENT_LAW[kind]}).`)
  }
  const open = statuses.filter((status) => status.state !== 'CURRENT')
  if (open.length > 0) {
    return done(
      'BLOCKED',
      `The ${words} for revision ${revision} is not on file in ${open.map((status) => status.language).join(', ')} (${DOCUMENT_LAW[kind]}): ${open.length} of ${statuses.length} language(s).`,
      open.map((status) => ({ path: `documents/${kind}/${status.language}`, message: status.message })),
    )
  }
  return done('OK', `The ${words} for revision ${revision} is on file in ${statuses.map((status) => status.language).join(', ')}.`)
}

export interface ChecksInput {
  readonly styleId: string
  readonly classification: Classification
  /** The revision the tab looks at (asked, else the released one, else the newest draft). */
  readonly revision: RevisionFacts | null
  /** The style's released revision. */
  readonly released: Pick<RevisionFacts, 'id' | 'revision'> | null
  readonly label: LabelFacts | null
  readonly cells: readonly CoverageCell[]
  readonly documents: Readonly<Record<DocumentKind, readonly LanguageStatus[]>>
}

/**
 * Every check of the tab, in a fixed order. The revision, the garment label and the certificate use the work-order
 * release's own checks and words (production/work-orders/release), so the tab never says a release would pass that
 * the release refuses; the DoC and the leaflet hold up shipping (art. 8(7)(8)).
 */
export function complianceChecks(input: ChecksInput): ComplianceCheck[] {
  const { classification } = input
  const certificate: ComplianceCheck = classification.certificateRequired
    ? fromRelease(certificateCheck(checkedCells(input.cells).map(cellGateOf)), 'CERTIFICATE')
    : {
        code: 'CERTIFICATE',
        state: 'NOT_REQUIRED',
        blocks: BLOCKS.CERTIFICATE,
        message: classification.isPpe ? 'Category I PPE is self-certified: no notified body certificate is needed.' : 'Not PPE: no certificate is needed.',
        problems: [],
      }
  const revision = input.revision?.revision ?? null
  return [
    fromRelease(revisionCheck(input.styleId, input.revision, input.released), 'REVISION'),
    fromRelease(labelCheck(input.revision, input.label), 'LABEL_TEMPLATE'),
    certificate,
    documentCheck('DECLARATION_OF_CONFORMITY', classification, revision, input.documents.DECLARATION_OF_CONFORMITY),
    documentCheck('USER_INFORMATION', classification, revision, input.documents.USER_INFORMATION),
  ]
}

/** The checks that block something now. */
export const blockersOf = (checks: readonly ComplianceCheck[]): ComplianceCheck[] => checks.filter((check) => check.state === 'BLOCKED')
