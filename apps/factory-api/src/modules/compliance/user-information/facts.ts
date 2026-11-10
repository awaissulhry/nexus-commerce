import type { LibraryWords, PhraseBook, Source } from '@nexus/factory-domain/compliance/declarations/rules'
import { WARNING_PHRASE_KEYS } from '@nexus/factory-domain/compliance/label-rules/marking'
import { approvedText, type TranslationStatus } from '@nexus/factory-domain/compliance/phrases/rules'
import { publicDocAddress, publicDocCodeOf } from '@nexus/factory-domain/compliance/public-doc/code'
import type { LeafletFacts, PlacementFact, SpareCandidate } from '@nexus/factory-domain/compliance/user-information/rules'
import { TEMPLATE_KEYS } from '@nexus/factory-domain/compliance/user-information/template'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { certificateValidOn } from '@nexus/factory-domain/sales/portal-documents/conformity'
import { processEmail } from '../../../platform/email-out/service'
import { STYLE_COLUMNS, findRevision } from '../../product/bom/store'
import { placementView, readItems } from '../../product/protectors/store'
import type { Reader, StyleRow } from '../declarations/common'
import { certificateFactsOf, readDeclarationFacts, type FactsInput, type ReadFacts } from '../declarations/facts'
import { operatorsFor } from '../operators/operators'
import { translationsOf } from '../phrases/store'

/**
 * The facts a generated leaflet is composed from (B-W2b-258; PRD-350, PRD-353, PRD-354; Annex II 1.4), read one query after
 * another (one connection runs one query at a time). The DoC generator's facts first (B-W2b-257 `readDeclarationFacts`:
 * the style, the revision with its colourways and sizes, the manufacturer and the authorised representative from the
 * economic operators, the certificate valid today with its notified body, the Regulation and the standards from the
 * register), then what the leaflet adds, each value with its source:
 *
 *   importer      the IMPORTER row of the economic operators that applies in the leaflet's market (B-W2b-249)
 *   body address  the register's notified body named by the certificate (B-W2b-216)
 *   class         the certificate's class, else the style's
 *   protectors    the revision's protector placement with its findings (B-W2b-233 `placementView`)
 *   spares        the placed protectors and the approved alternates of their BOM lines (B-W2b-228), each with the
 *                 certificates covering it (ACTIVE coverage) and whether each is valid today
 *   markings      the market's marks (B-W2b-249); none named: CE
 *   DoC address   the style's public DoC page (B-W2b-166)
 *   phrases       the library's words for the template's keys and the class warnings (B-W2b-249: the source words, or
 *                 the approved translation of the current revision; a stale one never prints)
 */

const src = (kind: string, recordType?: string, recordId?: string): Source => ({ kind, ...(recordType ? { recordType } : {}), ...(recordId ? { recordId } : {}) })

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
} as const

/** The spare protectors that could fit: the placed protectors and the approved PROTECTOR alternates of their BOM lines. */
async function readSpareCandidates(db: Reader, revisionId: string, placements: readonly PlacementFact[], day: BusinessDate): Promise<SpareCandidate[]> {
  const placedIds = [...new Set(placements.map((placement) => placement.protector.id))]
  if (placedIds.length === 0) return []
  const lines = await db.bomLine.findMany({ where: { revisionId, itemId: { in: placedIds } }, select: { id: true, itemId: true } })
  const alternates = lines.length === 0 ? [] : await db.bomLineAlternate.findMany({ where: { revisionId, bomLineId: { in: lines.map((line) => line.id) } }, select: { bomLineId: true, itemId: true, priority: true }, orderBy: [{ priority: 'asc' }, { itemId: 'asc' }] })
  const items = await readItems(db, [...placedIds, ...alternates.map((entry) => entry.itemId)])
  const replaces = new Map<string, Set<string>>()
  for (const id of placedIds) replaces.set(id, new Set([id]))
  for (const alternate of alternates) {
    const item = items.get(alternate.itemId)
    const line = lines.find((entry) => entry.id === alternate.bomLineId)
    if (!item || !line || String(item.kind) !== 'PROTECTOR' || item.status !== 'ACTIVE' || item.approval === 'BLOCKED') continue
    const set = replaces.get(alternate.itemId) ?? new Set<string>()
    set.add(line.itemId)
    replaces.set(alternate.itemId, set)
  }
  const candidateIds = [...replaces.keys()]
  const coverage = await db.certificateCoverage.findMany({ where: { itemId: { in: candidateIds }, status: 'ACTIVE' }, select: { certificateId: true, itemId: true } })
  const certificateIds = [...new Set(coverage.map((row) => row.certificateId))]
  const certificates = certificateIds.length === 0 ? [] : await db.certificate.findMany({ where: { id: { in: certificateIds } }, select: CERTIFICATE_SELECT, orderBy: [{ number: 'asc' }] })
  return candidateIds.map((itemId) => {
    const item = items.get(itemId)
    const own = coverage.filter((row) => row.itemId === itemId).map((row) => certificates.find((entry) => entry.id === row.certificateId)).filter((row): row is (typeof certificates)[number] => row !== undefined)
    return {
      itemId,
      code: item?.code ?? '?',
      name: item?.name ?? '?',
      placed: placedIds.includes(itemId),
      replaces: [...(replaces.get(itemId) ?? [])],
      certificates: [...new Map(own.map((row) => [row.id, row])).values()].map((row) => {
        const facts = certificateFactsOf(row)
        return { id: row.id, number: row.number, standard: row.standard, ppeClass: row.ppeClass, validTo: facts.validTo, valid: certificateValidOn(facts, day) }
      }),
    }
  })
}

export interface LeafletRead {
  /** The DoC generator's read (the certificate cited, the maker party, the standards as printed). */
  readonly read: ReadFacts
  readonly facts: LeafletFacts
}

/** Every fact of one style revision for its user information in a market (null: every market of its language). */
export async function readLeafletFacts(db: Reader, input: FactsInput & { readonly style: StyleRow }): Promise<LeafletRead> {
  const read = await readDeclarationFacts(db, input)
  const { style } = input
  const { resolved } = await operatorsFor(db, style, { marketCode: input.marketCode, day: input.day, companyId: input.companyId })
  const importerRow = resolved.find((entry) => entry.role === 'IMPORTER')?.row
  const importer = importerRow ? { name: importerRow.printedName, address: importerRow.printedAddress, source: src('OPERATOR', 'EconomicOperatorRole', importerRow.id) } : null

  const certificate = read.facts.certificate
  const body = certificate?.bodyId ? await db.notifiedBody.findUnique({ where: { id: certificate.bodyId }, select: { address: true } }) : null
  const certificateRow = certificate ? await db.certificate.findUnique({ where: { id: certificate.id }, select: { ppeClass: true } }) : null
  const ppeClass = certificate && certificateRow?.ppeClass?.trim()
    ? { value: certificateRow.ppeClass.trim(), source: src('CERTIFICATE', 'Certificate', certificate.id) }
    : style.ppeClass?.trim()
      ? { value: style.ppeClass.trim(), source: src('STYLE', 'Style', style.id) }
      : null

  let placements: PlacementFact[] = []
  let findings: LeafletFacts['placementFindings'] = []
  let spareCandidates: SpareCandidate[] = []
  if (input.revision) {
    const bomStyle = await db.style.findUnique({ where: { id: style.id }, select: STYLE_COLUMNS })
    if (bomStyle) {
      const view = await placementView(db, bomStyle, await findRevision(db, style.id, input.revision.id))
      placements = view.placements.map((placement) => ({
        id: placement.id,
        seq: placement.seq,
        pocket: placement.pocket,
        protector: { id: placement.protector.id, code: placement.protector.code, name: placement.protector.name },
        standard: placement.standard,
        level: placement.level,
        sizes: [...placement.sizes],
        note: placement.positionNote,
      }))
      findings = view.findings.map((finding) => ({ code: finding.code, placementId: finding.placementId, message: finding.message }))
      spareCandidates = await readSpareCandidates(db, input.revision.id, placements, input.day)
    }
  }

  const market = input.marketCode ? await db.marketProfile.findFirst({ where: { code: input.marketCode }, select: { id: true, markings: true } }) : null
  const markings = market ? { values: [...market.markings], source: src('MARKET', 'MarketProfile', market.id) } : { values: ['CE'], source: src('TEMPLATE') }
  const docAddress = { address: publicDocAddress(processEmail().webOrigin, publicDocCodeOf(style.id)), source: src('PUBLIC_DOC', 'Style', style.id) }

  return {
    read,
    facts: { declaration: read.facts, importer, bodyAddress: body?.address?.trim() || null, ppeClass, placements, placementFindings: findings, spareCandidates, markings, docAddress },
  }
}

/** The phrase keys a leaflet reads: the template's and the class warnings (B-W2b-253's WARNING phrases). */
export const LEAFLET_PHRASE_KEYS: readonly string[] = Object.freeze([...TEMPLATE_KEYS, ...Object.values(WARNING_PHRASE_KEYS)])

/** The phrase library's words for the leaflet's keys in the languages asked (ACTIVE phrases of the company or every company). */
export async function readLeafletBook(db: Reader, companyId: string | null, languages: readonly string[]): Promise<PhraseBook> {
  const phrases = await db.phrase.findMany({
    where: { key: { in: [...LEAFLET_PHRASE_KEYS] }, status: 'ACTIVE', OR: [{ companyId: null }, ...(companyId ? [{ companyId }] : [])] },
    select: { id: true, key: true, companyId: true, sourceLanguage: true, sourceText: true, revision: true },
    // The company's own phrase wins over every company's.
    orderBy: [{ companyId: { sort: 'asc', nulls: 'first' } }],
  })
  const translations = await translationsOf(db, phrases.map((row) => row.id))
  const words = new Map<string, LibraryWords>()
  for (const phrase of phrases) {
    const own = (translations.get(phrase.id) ?? []).map((row) => ({ ...row, status: row.status as TranslationStatus }))
    for (const language of new Set([phrase.sourceLanguage, ...languages])) {
      const text = approvedText(phrase, language, own)
      if (text !== null) words.set(`${phrase.key}|${language}`, { text, phraseId: phrase.id, revision: phrase.revision })
    }
  }
  return (key, language) => words.get(`${key}|${language}`) ?? null
}

/** The facts and the library, for one or more languages. */
export async function readLeafletComposition(db: Reader, input: FactsInput & { readonly style: StyleRow }, languages: readonly string[]) {
  const read = await readLeafletFacts(db, input)
  const book = await readLeafletBook(db, input.companyId, languages)
  return { ...read, book }
}
