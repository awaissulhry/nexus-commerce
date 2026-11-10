import type { Prisma } from '@nexus/factory-db'
import type { DeclarationFacts, LibraryWords, PhraseBook, PpeCategoryCode, Source, StandardFact } from '@nexus/factory-domain/compliance/declarations/rules'
import { TEMPLATE_KEYS } from '@nexus/factory-domain/compliance/declarations/template'
import { namesEntry, standardLabel } from '@nexus/factory-domain/compliance/register-of-rules/rules'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { certificateFor, certificateValidOn, type CertificateFacts } from '@nexus/factory-domain/sales/portal-documents/conformity'
import { operatorsFor } from '../operators/operators'
import { dateDay, dayOf, type Reader, type StyleRow } from './common'

/**
 * The facts a generated DoC is composed from (B-W2b-257; PRD-292; Annex IX), read one query after another (one connection
 * runs one query at a time). Every value names its source:
 *
 *   manufacturer   the economic operators (B-W2b-249: the MANUFACTURER row that applies to the style in the market on the
 *                  day: style, brand, company, tenant; Owner 11-09: the brand for a style it sells under its own name, our
 *                  company otherwise) — when the row names the party the database expects as maker; else the brand's
 *                  registered address (a brand style), the revision's garment label template (W1: our company's maker
 *                  as printed), the company's registered address
 *   representative the AUTHORISED_REPRESENTATIVE row that applies (with its party)
 *   certificate    a certificate covering the style (ACTIVE coverage) that is valid today (B-W2b-178's rule: the newest
 *                  valid one), its notified body from the register when the certificate names one (B-W2b-216), else the
 *                  typed name and number
 *   legislation    the register's Reg. (EU) 2016/425 entry (its title per language)
 *   standards      the style's harmonised standard and the certificate's, each matched to the register's entry (code and
 *                  edition, with its Official Journal citation)
 *   phrases        the library's DOC phrases with the template's keys: the source words, or the approved translation of
 *                  the current revision (a stale one never prints)
 */

export const REVISION_SELECT = { id: true, revision: true, status: true, labelTemplateId: true, releasedColourwayIds: true, releasedSizes: true } as const satisfies Prisma.StyleRevisionSelect
export type RevisionRow = Prisma.StyleRevisionGetPayload<{ select: typeof REVISION_SELECT }>

/** The asked revision of the style, else the newest released one, else the newest draft, else the newest. */
export async function chosenRevision(db: Reader, styleId: string, revisionId: string | undefined | null): Promise<RevisionRow | null> {
  if (revisionId) {
    const asked = await db.styleRevision.findFirst({ where: { id: revisionId, styleId }, select: REVISION_SELECT })
    if (!asked) throw new ValidationError('The revision is not valid.', [{ path: 'body/revisionId', message: 'Not a revision of the style.' }])
    return asked
  }
  const revisions = await db.styleRevision.findMany({ where: { styleId }, select: REVISION_SELECT, orderBy: { revision: 'desc' } })
  return revisions.find((entry) => entry.status === 'RELEASED') ?? revisions.find((entry) => entry.status === 'DRAFT') ?? revisions[0] ?? null
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

/** A postal address on one line: "Via Esempio 1, 00000 Seedville (MI), IT". */
export function addressLine(value: { line1: string; line2?: string | null; postalCode: string; city: string; province?: string | null; country: string } | null): string | null {
  if (!value) return null
  return [value.line1, value.line2, `${value.postalCode} ${value.city}${value.province ? ` (${value.province})` : ''}`, value.country].filter((part): part is string => typeof part === 'string' && part.trim() !== '').join(', ')
}

function companyAddress(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const entry = value as Record<string, unknown>
  const line1 = text(entry.line1)
  const postalCode = text(entry.postalCode)
  const city = text(entry.city)
  const country = text(entry.country)
  if (!line1 || !postalCode || !city || !country) return null
  return addressLine({ line1, line2: text(entry.line2), postalCode, city, province: text(entry.province), country })
}

const src = (kind: string, recordType: string, recordId: string): Source => ({ kind, recordType, recordId })

/** The party the database wants as a generated document's maker: the brand that sells under its own name, else none. */
export const expectedMakerParty = (style: Pick<StyleRow, 'brandPartyId' | 'soldUnderOurName'>): string | null => (style.brandPartyId && !style.soldUnderOurName ? style.brandPartyId : null)

/** The manufacturer and the authorised representative as printed. */
async function readOperators(db: Reader, style: StyleRow, input: { companyId: string | null; marketCode: string | null; day: BusinessDate; labelTemplateId: string | null }) {
  const expected = expectedMakerParty(style)
  const { resolved } = await operatorsFor(db, style, { marketCode: input.marketCode, day: input.day, companyId: input.companyId })
  let maker: DeclarationFacts['maker'] = null
  const row = resolved.find((entry) => entry.role === 'MANUFACTURER')?.row
  if (row && row.partyId === expected) maker = { name: row.printedName, address: row.printedAddress, source: src('OPERATOR', 'EconomicOperatorRole', row.id) }
  if (!maker && expected) {
    const party = await db.party.findUnique({ where: { id: expected }, select: { id: true, legalName: true } })
    const address = party
      ? await db.partyAddress.findFirst({ where: { partyId: party.id, status: 'ACTIVE', kinds: { has: 'REGISTERED' } }, select: { line1: true, line2: true, postalCode: true, city: true, province: true, country: true }, orderBy: { createdAt: 'asc' } })
      : null
    const line = addressLine(address)
    if (party && line) maker = { name: party.legalName, address: line, source: src('PARTY', 'Party', party.id) }
  }
  if (!maker && !expected && input.labelTemplateId) {
    const label = await db.labelTemplate.findUnique({ where: { id: input.labelTemplateId }, select: { id: true, makerPartyId: true, makerName: true, makerAddress: true } })
    if (label && label.makerPartyId === null && text(label.makerName) && text(label.makerAddress)) maker = { name: label.makerName, address: label.makerAddress, source: src('LABEL', 'LabelTemplate', label.id) }
  }
  if (!maker && !expected && input.companyId) {
    const company = await db.company.findUnique({ where: { id: input.companyId }, select: { id: true, legalName: true, address: true } })
    const line = company ? companyAddress(company.address) : null
    if (company && line) maker = { name: company.legalName, address: line, source: src('COMPANY', 'Company', company.id) }
  }
  const representativeRow = resolved.find((entry) => entry.role === 'AUTHORISED_REPRESENTATIVE')?.row
  const representative = representativeRow ? { name: representativeRow.printedName, address: representativeRow.printedAddress, source: src('OPERATOR', 'EconomicOperatorRole', representativeRow.id) } : null
  return { maker, representative }
}

const CERTIFICATE_SELECT = {
  id: true,
  number: true,
  standard: true,
  ppeClass: true,
  notifiedBodyName: true,
  notifiedBodyNumber: true,
  notifiedBodyId: true,
  validFrom: true,
  validTo: true,
  status: true,
  statusChangedAt: true,
} as const satisfies Prisma.CertificateSelect
type CertificateRow = Prisma.CertificateGetPayload<{ select: typeof CERTIFICATE_SELECT }>

export const certificateFactsOf = (row: CertificateRow): CertificateFacts => ({
  id: row.id,
  number: row.number,
  standard: row.standard,
  ppeClass: row.ppeClass,
  notifiedBodyName: row.notifiedBodyName,
  notifiedBodyNumber: row.notifiedBodyNumber,
  validFrom: dateDay(row.validFrom),
  validTo: dateDay(row.validTo),
  status: row.status,
  statusChangedOn: row.statusChangedAt ? dayOf(row.statusChangedAt) : null,
})

/** The certificates covering a style (ACTIVE coverage rows), each once. */
export async function coveringCertificates(db: Reader, styleId: string): Promise<CertificateRow[]> {
  const coverage = await db.certificateCoverage.findMany({ where: { styleId, status: 'ACTIVE' }, select: { certificateId: true } })
  const ids = [...new Set(coverage.map((row) => row.certificateId))]
  return ids.length === 0 ? [] : db.certificate.findMany({ where: { id: { in: ids } }, select: CERTIFICATE_SELECT, orderBy: [{ validFrom: 'desc' }, { id: 'asc' }] })
}

/** The certificate a new DoC cites (valid on the day, covering the style), or why there is none. */
async function readCertificate(db: Reader, styleId: string, day: BusinessDate, cited: string | null): Promise<{ certificate: DeclarationFacts['certificate']; problem: string | null; row: CertificateRow | null }> {
  const covering = await coveringCertificates(db, styleId)
  const citedRow = cited ? (covering.find((row) => row.id === cited) ?? (await db.certificate.findUnique({ where: { id: cited }, select: CERTIFICATE_SELECT }))) : null
  const facts = covering.map(certificateFactsOf)
  const chosen = certificateFor(citedRow ? certificateFactsOf(citedRow) : null, facts, day)
  if (!chosen || !certificateValidOn(chosen, day)) {
    const problem =
      covering.length === 0
        ? null
        : `No certificate covering the style is valid on ${day}: ${covering.map((row) => `${row.number} is ${row.status}, valid ${dateDay(row.validFrom)} to ${dateDay(row.validTo)}`).join('; ')}.`
    return { certificate: null, problem, row: null }
  }
  const row = (covering.find((entry) => entry.id === chosen.id) ?? citedRow)!
  const body = row.notifiedBodyId ? await db.notifiedBody.findUnique({ where: { id: row.notifiedBodyId }, select: { id: true, name: true, number: true } }) : null
  return {
    certificate: { id: row.id, number: row.number, bodyName: body?.name ?? row.notifiedBodyName, bodyNumber: body?.number ?? row.notifiedBodyNumber, bodyId: body?.id ?? null },
    problem: null,
    row,
  }
}

/** Reg. (EU) 2016/425 in the register, and each typed standard matched to its entry. */
async function readRegister(db: Reader, typed: readonly { typed: string; source: Source }[]): Promise<{ legislation: DeclarationFacts['legislation']; standards: StandardFact[] }> {
  const entries = await db.regulationOrStandard.findMany({ select: { id: true, code: true, edition: true, kind: true, status: true, title: true, titleI18n: true, ojReference: true }, orderBy: [{ code: 'asc' }, { edition: 'asc' }] })
  const regulation = entries.find((entry) => entry.kind === 'REGULATION' && /2016\/425/.test(entry.code))
  const labels: Record<string, string> = {}
  if (regulation?.titleI18n && typeof regulation.titleI18n === 'object' && !Array.isArray(regulation.titleI18n)) {
    for (const [language, value] of Object.entries(regulation.titleI18n as Record<string, unknown>)) if (typeof value === 'string' && value.trim() !== '') labels[language] = value.trim()
  }
  const legislation = regulation ? { id: regulation.id, label: regulation.title || regulation.code, labels } : null
  const standards = typed.map(({ typed: value, source }): StandardFact => {
    const entry = entries.find((candidate) => candidate.kind !== 'REGULATION' && namesEntry(value, candidate))
    return { typed: value, entry: entry ? { id: entry.id, label: standardLabel(entry.code, entry.edition), ojReference: entry.ojReference, status: entry.status } : null, source }
  })
  return { legislation, standards }
}

export interface FactsInput {
  readonly style: StyleRow
  readonly revision: RevisionRow | null
  /** The company whose declaration it is (the maker's, for our styles). */
  readonly companyId: string | null
  readonly marketCode: string | null
  readonly day: BusinessDate
  /** A refresh keeps the certificate the draft cites while it stays valid. */
  readonly citedCertificateId?: string | null
  readonly signatory?: DeclarationFacts['signatory']
}

export interface ReadFacts {
  readonly facts: DeclarationFacts
  /** The certificate the composition cites (its id goes on the document). */
  readonly certificateId: string | null
  readonly makerPartyId: string | null
  /** The standards as printed (ComplianceDocument.standards). */
  readonly standardLabels: string[]
}

/** Every fact of one style revision for its DoC. */
export async function readDeclarationFacts(db: Reader, input: FactsInput): Promise<ReadFacts> {
  const { style, revision } = input
  const colourwayRows = await db.colourway.findMany({ where: { styleId: style.id, status: 'ACTIVE' }, select: { id: true, code: true, name: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  const released = revision?.releasedColourwayIds ?? []
  const colourways = released.length > 0 ? colourwayRows.filter((row) => released.includes(row.id)) : colourwayRows
  const sizes = revision && revision.releasedSizes.length > 0 ? revision.releasedSizes : style.sizes
  const { maker, representative } = await readOperators(db, style, { companyId: input.companyId, marketCode: input.marketCode, day: input.day, labelTemplateId: revision?.labelTemplateId ?? null })
  const certified = style.ppeCategory === 'CATEGORY_II' || style.ppeCategory === 'CATEGORY_III'
  const { certificate, problem, row } = certified ? await readCertificate(db, style.id, input.day, input.citedCertificateId ?? null) : { certificate: null, problem: null, row: null }
  const typed: { typed: string; source: Source }[] = []
  const push = (value: string | null | undefined, source: Source) => {
    const clean = text(value)
    if (clean && !typed.some((entry) => entry.typed.replace(/\s+/g, '').toUpperCase() === clean.replace(/\s+/g, '').toUpperCase())) typed.push({ typed: clean, source })
  }
  push(style.ppeStandard, src('STYLE', 'Style', style.id))
  if (row) push(row.standard, src('CERTIFICATE', 'Certificate', row.id))
  const { legislation, standards } = await readRegister(db, typed)
  const nameI18n: Record<string, string> = {}
  if (style.nameI18n && typeof style.nameI18n === 'object' && !Array.isArray(style.nameI18n)) {
    for (const [language, value] of Object.entries(style.nameI18n as Record<string, unknown>)) if (typeof value === 'string' && value.trim() !== '') nameI18n[language] = value.trim()
  }
  const facts: DeclarationFacts = {
    style: { id: style.id, code: style.code, name: style.name, nameI18n, ppeCategory: style.ppeCategory as PpeCategoryCode, ppeStandard: style.ppeStandard, ppeClass: style.ppeClass },
    revision: revision ? { id: revision.id, revision: revision.revision, sizes } : null,
    colourways,
    maker,
    representative,
    certificate,
    certificateProblem: problem,
    legislation,
    standards,
    signatory: input.signatory ?? { name: null, function: null, place: null, on: null },
  }
  return {
    facts,
    certificateId: certificate?.id ?? null,
    makerPartyId: expectedMakerParty(style),
    standardLabels: standards.map((standard) => (standard.entry ? standard.entry.label : standard.typed)),
  }
}

/** The phrase library's words for the template's keys in the languages asked (ACTIVE phrases of the company or every company). */
export async function readPhraseBook(db: Reader, companyId: string | null, languages: readonly string[]): Promise<PhraseBook> {
  const phrases = await db.phrase.findMany({
    where: { key: { in: [...TEMPLATE_KEYS] }, status: 'ACTIVE', OR: [{ companyId: null }, ...(companyId ? [{ companyId }] : [])] },
    select: { id: true, key: true, sourceLanguage: true, sourceText: true, revision: true },
  })
  const translations = phrases.length === 0 ? [] : await db.phraseTranslation.findMany({ where: { phraseId: { in: phrases.map((row) => row.id) }, status: 'APPROVED', language: { in: [...languages] } }, select: { phraseId: true, language: true, text: true, sourceRevision: true } })
  const words = new Map<string, LibraryWords>()
  for (const phrase of phrases) {
    words.set(`${phrase.key}|${phrase.sourceLanguage}`, { text: phrase.sourceText, phraseId: phrase.id, revision: phrase.revision })
    for (const translation of translations) {
      // A stale translation (of older source words) never prints.
      if (translation.phraseId === phrase.id && translation.sourceRevision === phrase.revision) words.set(`${phrase.key}|${translation.language}`, { text: translation.text, phraseId: phrase.id, revision: phrase.revision })
    }
  }
  return (key, language) => words.get(`${key}|${language}`) ?? null
}

/** The style revision's facts and the library, for one or more languages. */
export async function readComposition(db: Reader, input: FactsInput, languages: readonly string[]) {
  const read = await readDeclarationFacts(db, input)
  const book = await readPhraseBook(db, input.companyId, languages)
  return { ...read, book }
}

/** The style's revision by id, of this style. */
export async function readRevision(db: Reader, styleId: string, revision: number): Promise<RevisionRow> {
  const row = await db.styleRevision.findFirst({ where: { styleId, revision }, select: REVISION_SELECT })
  if (!row) throw new NotFoundError(`Revision ${revision} of the style is gone.`)
  return row
}
