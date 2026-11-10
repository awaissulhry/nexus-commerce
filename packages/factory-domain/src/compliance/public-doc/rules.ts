import { CERTIFIED_CATEGORIES } from '../cert-gate/gate'
import { isUsableDocument, type DocumentKind, type DocumentStatus } from '../../product/compliance/rules'
import type { PpeCategory } from '../../product/styles/rules'
import { certificateFor, certificateValidOn, type CertificateFacts } from '../../sales/portal-documents/conformity'
import { businessDate, type BusinessDate } from '../../core/time'
import { formatPublicDocCode, readPublicDocCode, type PublicDocKind } from './code'
import type { BatchSpan, CareLine, PublicDocFile, PublicDocPage } from './contracts'
// B-W2b-260 (RG1:01): the recall notices the API read for the page (compliance/recall/public-notice noticesForPage).
import type { PublicSafetyNotice } from '../recall/public-notice'

/**
 * The public DoC page (B-W2b-166; PRD-294, PRD-356; design links.doc; Reg. (EU) 2016/425 art. 8(8), art. 15, Annex II 1.4;
 * Reg. (EU) 2023/988 (GPSR) art. 19), pure: from what the API read of one batch or style, what the page shows.
 *
 *   The revision   a batch: the style revision its work order froze at release (the garments are made to it);
 *                  a style: its CURRENT revision — the newest released revision with a published declaration (else the
 *                  newest with one, a style whose first revision is not released yet but whose declaration is issued).
 *   Declaration    per language, the declaration issued for exactly that revision with its signed PDF (product/compliance
 *                  `isUsableDocument`, the rule the shipment follows, B-W1-49): an older revision's never stands in.
 *   Standing       CURRENT when no later RELEASED revision has its own declaration; else EARLIER, "for batches before" the
 *                  day the first such revision was released.
 *   Certificate    the EU type-examination certificate the declaration cites when it was valid on the day (the batch's
 *                  release day, or today for a style), else one covering the style valid that day, else the cited one
 *                  shown as not valid then (sales/portal-documents `certificateFor`, as the customer portal names it).
 *   Instructions   the user information of the same revision per language, and the garment label's care lines.
 *   Versions       every older revision with a published declaration, newest first, with the batches made to it.
 * No price, no person.
 */

/** A signed file of a declaration or leaflet: the newest confirmed PDF of its document. */
export interface FileFacts {
  readonly id: string
  readonly name: string
  readonly sizeBytes: number
  readonly sha256: string
}

/** A ComplianceDocument as the API read it (any status: the rules keep the usable ones). */
export interface DocOnFile {
  readonly id: string
  readonly kind: DocumentKind
  /** ISO 639-1. */
  readonly language: string
  /** The style revision NUMBER it is for. */
  readonly revision: number
  readonly status: DocumentStatus
  readonly number: string | null
  readonly issuedAt: Date | null
  readonly certificateId: string | null
  readonly makerName: string
  readonly makerAddress: string
  /** Its newest confirmed PDF; null: none confirmed yet. */
  readonly file: FileFacts | null
}

/** A garment label template (the batch's frozen one, or a revision's). */
export interface LabelFacts {
  readonly makerName: string
  readonly makerAddress: string
  readonly importerName: string | null
  readonly importerAddress: string | null
  /** The languages it prints, in order: the markets the style is sold in. */
  readonly languages: readonly string[]
  readonly care: readonly CareLine[]
}

export interface RevisionFacts {
  readonly revision: number
  /** Set from its release on; null: never released. */
  readonly releasedAt: Date | null
  readonly label: LabelFacts | null
}

export interface PublicDocFacts {
  readonly kind: PublicDocKind
  readonly code: string
  readonly style: {
    readonly code: string
    readonly name: string
    readonly names: Readonly<Record<string, string>>
    readonly category: PpeCategory
    readonly standard: string | null
    readonly ppeClass: string | null
    /** Made for a brand (private label): the brand is the legal maker. */
    readonly privateLabel: boolean
  }
  /** BATCH codes: the work order's batch number, its frozen revision number (null: none frozen) and its frozen label. */
  readonly batch: { readonly number: string; readonly revision: number | null; readonly releasedAt: Date; readonly label: LabelFacts | null } | null
  readonly revisions: readonly RevisionFacts[]
  readonly documents: readonly DocOnFile[]
  /** The release days of the style's batches per revision number. */
  readonly batches: ReadonlyMap<number, BatchSpan>
  /** The certificates the documents cite, by id, and those covering the style (ACTIVE coverage). */
  readonly cited: ReadonlyMap<string, CertificateFacts>
  readonly covering: readonly CertificateFacts[]
  /** Today in Europe/Rome. */
  readonly today: BusinessDate
  /** B-W2b-260: the safety notices of the batch or style (published, not taken down), newest first; none when left out. */
  readonly notices?: readonly PublicSafetyNotice[]
}

/** product/compliance `isUsableDocument`: issued (or superseded by a newer revision's) with its signed PDF confirmed. */
const usable = (document: DocOnFile): boolean => isUsableDocument({ status: document.status, currentFile: document.file === null ? null : { ...document.file, originalName: document.file.name, availableAt: '' } })

/** The revisions with a published declaration (any language). */
function publishedRevisions(documents: readonly DocOnFile[]): Set<number> {
  return new Set(documents.filter((document) => document.kind === 'DECLARATION_OF_CONFORMITY' && usable(document)).map((document) => document.revision))
}

/**
 * The revision a STYLE code shows: the newest released revision with a published declaration; else the newest with one
 * (issued before its revision's release); null when the style has none published (the code then answers "not found").
 */
export function currentRevisionOf(revisions: readonly RevisionFacts[], documents: readonly DocOnFile[]): number | null {
  const published = publishedRevisions(documents)
  const released = revisions.filter((revision) => revision.releasedAt !== null && published.has(revision.revision)).map((revision) => revision.revision)
  if (released.length > 0) return Math.max(...released)
  return published.size > 0 ? Math.max(...published) : null
}

/** CURRENT, or EARLIER with the day the next released revision with its own declaration took over. */
export function standingOf(revision: number, revisions: readonly RevisionFacts[], documents: readonly DocOnFile[]): { standing: 'CURRENT' | 'EARLIER'; before: BusinessDate | null } {
  const published = publishedRevisions(documents)
  const later = revisions
    .filter((entry) => entry.revision > revision && entry.releasedAt !== null && published.has(entry.revision))
    .sort((a, b) => a.releasedAt!.getTime() - b.releasedAt!.getTime())
  return later.length === 0 ? { standing: 'CURRENT', before: null } : { standing: 'EARLIER', before: businessDate(later[0]!.releasedAt!) }
}

/** The languages first that the label prints (the markets), then the others alphabetically. */
export function languageOrder(languages: readonly string[], printed: readonly string[]): string[] {
  const wanted = printed.map((language) => language.trim().toLowerCase())
  const rank = (language: string) => {
    const at = wanted.indexOf(language)
    return at < 0 ? wanted.length : at
  }
  return [...new Set(languages)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

const fileOf = (document: DocOnFile): PublicDocFile => ({
  language: document.language,
  fileId: document.file!.id,
  name: document.file!.name,
  sizeBytes: document.file!.sizeBytes,
  sha256: document.file!.sha256,
  number: document.number,
  issuedOn: document.issuedAt ? businessDate(document.issuedAt) : null,
})

/** The usable documents of one kind for exactly this revision, one per language, in the label's language order. */
export function filesFor(documents: readonly DocOnFile[], kind: DocumentKind, revision: number, printed: readonly string[]): PublicDocFile[] {
  const own = documents.filter((document) => document.kind === kind && document.revision === revision && usable(document))
  const byLanguage = new Map<string, DocOnFile>()
  for (const document of own) if (!byLanguage.has(document.language)) byLanguage.set(document.language, document)
  return languageOrder([...byLanguage.keys()], printed).map((language) => fileOf(byLanguage.get(language)!))
}

/** The page of one record (`n` of the matches under its code, `others` the rest). */
export function publicDocPage(facts: PublicDocFacts, sender: PublicDocPage['sender'], contact: PublicDocPage['contact'], n = 0, others: PublicDocPage['others'] = []): PublicDocPage {
  const code = readPublicDocCode(facts.code)
  if (code === null) throw new RangeError(`not a public DoC code: ${facts.code}`)
  const isPpe = facts.style.category !== 'NOT_PPE'
  const certificateRequired = CERTIFIED_CATEGORIES.includes(facts.style.category)
  const revision = facts.kind === 'BATCH' ? (facts.batch?.revision ?? null) : currentRevisionOf(facts.revisions, facts.documents)
  const revisionFacts = revision === null ? null : (facts.revisions.find((entry) => entry.revision === revision) ?? null)
  const label = facts.kind === 'BATCH' ? (facts.batch?.label ?? revisionFacts?.label ?? null) : (revisionFacts?.label ?? null)
  const printed = label?.languages ?? []

  const declarations = revision === null ? [] : filesFor(facts.documents, 'DECLARATION_OF_CONFORMITY', revision, printed)
  const leaflets = revision === null ? [] : filesFor(facts.documents, 'USER_INFORMATION', revision, printed)
  const shown = revision === null ? [] : facts.documents.filter((document) => document.kind === 'DECLARATION_OF_CONFORMITY' && document.revision === revision && usable(document))
  const first = shown.find((document) => document.language === declarations[0]?.language) ?? null

  const declaration =
    isPpe && revision !== null && declarations.length > 0
      ? { revision, ...standingOf(revision, facts.revisions, facts.documents), batches: facts.batches.get(revision) ?? null, files: declarations }
      : null
  const missing = declaration ? null : isPpe ? 'NOT_PUBLISHED' : 'NOT_PPE'

  // The certificate: the one the declaration cites (its first language that cites one), else a covering one, on the day.
  const day = facts.kind === 'BATCH' && facts.batch ? businessDate(facts.batch.releasedAt) : facts.today
  const citedId = languageOrder(shown.map((document) => document.language), printed)
    .map((language) => shown.find((document) => document.language === language)?.certificateId ?? null)
    .find((value): value is string => value !== null)
  const cited = citedId ? (facts.cited.get(citedId) ?? null) : null
  const chosen = isPpe && certificateRequired ? certificateFor(cited, facts.covering, day) : null

  const versions =
    revision === null || !isPpe
      ? []
      : [...publishedRevisions(facts.documents)]
          .filter((older) => older < revision)
          .sort((a, b) => b - a)
          .map((older) => {
            const own = facts.documents.filter((document) => document.kind === 'DECLARATION_OF_CONFORMITY' && document.revision === older && usable(document) && document.issuedAt !== null)
            const issued = own.map((document) => document.issuedAt!.getTime())
            const olderPrinted = facts.revisions.find((entry) => entry.revision === older)?.label?.languages ?? printed
            return {
              revision: older,
              issuedOn: issued.length > 0 ? businessDate(new Date(Math.min(...issued))) : null,
              batches: facts.batches.get(older) ?? null,
              declarations: filesFor(facts.documents, 'DECLARATION_OF_CONFORMITY', older, olderPrinted),
              instructions: filesFor(facts.documents, 'USER_INFORMATION', older, olderPrinted),
            }
          })

  const makerName = first?.makerName ?? label?.makerName ?? null
  const makerAddress = first?.makerAddress ?? label?.makerAddress ?? null

  return {
    code: formatPublicDocCode(code),
    path: code,
    kind: facts.kind,
    sender,
    contact,
    product: {
      style: { code: facts.style.code, name: facts.style.name, names: { ...facts.style.names } },
      batch: facts.kind === 'BATCH' && facts.batch ? { number: facts.batch.number, releasedOn: businessDate(facts.batch.releasedAt) } : null,
      maker: makerName && makerAddress ? { name: makerName, address: makerAddress, role: facts.style.privateLabel ? 'BRAND' : 'COMPANY' } : null,
      importer: label?.importerName && label.importerAddress ? { name: label.importerName, address: label.importerAddress } : null,
    },
    ppe: { category: facts.style.category, standard: facts.style.standard, ppeClass: facts.style.ppeClass, certificateRequired },
    declaration,
    missing,
    certificate: chosen
      ? {
          number: chosen.number,
          notifiedBody: { name: chosen.notifiedBodyName, number: chosen.notifiedBodyNumber },
          standard: chosen.standard,
          ppeClass: chosen.ppeClass,
          validFrom: chosen.validFrom,
          validTo: chosen.validTo,
          day,
          validOnDay: certificateValidOn(chosen, day),
        }
      : null,
    instructions: { files: leaflets, care: (label?.care ?? []).map((line) => ({ symbol: line.symbol, text: { ...line.text } })) },
    versions,
    n,
    others,
    // B-W2b-260 (RG1:01): first on the page.
    notices: (facts.notices ?? []).map((notice) => ({ ...notice, batches: [...notice.batches], words: { ...notice.words } })),
  }
}

/** Every file id the page serves (GET /public/doc/:code/files/:fileId answers only these). */
export function servedFileIds(page: Pick<PublicDocPage, 'declaration' | 'instructions' | 'versions'>): Set<string> {
  return new Set([
    ...(page.declaration?.files ?? []).map((file) => file.fileId),
    ...page.instructions.files.map((file) => file.fileId),
    ...page.versions.flatMap((version) => [...version.declarations, ...version.instructions].map((file) => file.fileId)),
  ])
}

/**
 * A garment label's care column as stored (`[{ symbol, text: { en: 'Do not wash' } }]`), kept only where it is that
 * shape; anything else reads as no care line.
 */
export function careLinesOf(value: unknown): CareLine[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object') return []
    const { symbol, text } = entry as { symbol?: unknown; text?: unknown }
    if (typeof symbol !== 'string' || symbol.trim() === '' || text === null || typeof text !== 'object' || Array.isArray(text)) return []
    const words = Object.fromEntries(Object.entries(text as Record<string, unknown>).filter((pair): pair is [string, string] => typeof pair[1] === 'string' && pair[1].trim() !== ''))
    return [{ symbol: symbol.trim(), text: words }]
  })
}

/** The style's name per language as stored (`{ "it": "Giacca …" }`): strings only. */
export function namesOf(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((pair): pair is [string, string] => typeof pair[1] === 'string' && pair[1].trim() !== ''))
}

/** The batches of a style per revision as release-day spans (the work orders' release days). */
export function batchSpans(batches: readonly { readonly revision: number | null; readonly releasedAt: Date | null }[]): Map<number, BatchSpan> {
  const spans = new Map<number, BatchSpan>()
  for (const batch of batches) {
    if (batch.revision === null || batch.releasedAt === null) continue
    const day = businessDate(batch.releasedAt)
    const span = spans.get(batch.revision)
    spans.set(batch.revision, span ? { first: day < span.first ? day : span.first, last: day > span.last ? day : span.last } : { first: day, last: day })
  }
  return spans
}

/**
 * The page `n` among the records one code names (oldest record first), naming the others so the reader can pick the
 * product on their label; null when there is no such page.
 */
export function pickPage(pages: readonly PublicDocPage[], n: number): PublicDocPage | null {
  const chosen = pages[n]
  if (!chosen) return null
  const others = pages.flatMap((page, index) => (index === n ? [] : [{ n: index, style: { code: page.product.style.code, name: page.product.style.name }, batch: page.product.batch?.number ?? null }]))
  return { ...chosen, n, others }
}
