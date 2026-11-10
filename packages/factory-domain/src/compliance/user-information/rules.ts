import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import {
  checkRefusal as pointCheckRefusal,
  productName,
  sourceWords as declarationSourceWords,
  startingState as pointStartingState,
  translationRefusal as declarationTranslationRefusal,
  typedBy,
  type DeclarationFacts,
  type PhraseBook,
  type PointValue,
  type Problem,
  type Source,
  type TranslationState,
  type Wording,
} from '../declarations/rules'
import { fillWords } from '../declarations/template'
import { WARNING_PHRASE_KEYS, warningsAsked } from '../label-rules/marking'
import { levelServes, standardFamily } from '../../product/protectors/rules'
import { builtInWords, missingPlaceholders, SECTION_KEYS, TEMPLATE_ID, zoneKey, type SectionKey } from './template'

/**
 * The user information builder's rules (B-W2b-258; PRD-350, PRD-353, PRD-354; Reg. (EU) 2016/425 art. 8(7), Annex II 1.4 and
 * 1.3.1), pure. The API reads the facts of one style revision — the DoC generator's (B-W2b-257: the style, its revision,
 * colourways and sizes, the manufacturer and authorised representative from the economic operators, the certificate with
 * its notified body, the Regulation and the harmonised standards from the register), the market's importer, the notified
 * body's address, the printed class, the protector placement of the revision (B-W2b-233) with its findings, the spare
 * protectors that fit (the placed protectors and their approved BOM alternates, each with the certificates covering it),
 * the market's markings and the public DoC address (B-W2b-166) — and the phrase library; `composeUserInformation` writes
 * the leaflet's sections in one language (template.ts), each with where its value came from (B-W2b-218's shape: `{ key,
 * text, source }`, plus the words it used and every value it filled in, as the DoC's points), the protector positions
 * (PRD-353) and the compatible spare protectors with their levels (PRD-354).
 *
 * Refusals (`blocking`): not PPE, no revision, no manufacturer's name and address, a category II or III style without a
 * valid certificate covering it, a template phrase missing in the language of an original. Warnings: a standard not in the
 * register or not in force, no standard, no class, a garment whose class needs protectors with none placed, the placement's
 * findings (B-W2b-233), a protector without a valid certificate at its level (not listed as a spare), a class warning the
 * library lacks in the language, a position note printed as typed (its language unknown), a phrase that lost a placeholder.
 *
 * Translations (PRD-351): the same facts composed in another language; a section whose words the library does not have in
 * that language (or that a person typed in the original) keeps the original's words with the source kind UNTRANSLATED and
 * the translation starts IN_TRANSLATION for a translator to type them. A translation is checked by a second person (the DoC
 * generator's rule: never its author, nor anyone who typed its words, never with a section still to type).
 */

export const WORDS_MAX = 8000
export const LANGUAGES_MAX = 10
export const POSITIONS_MAX = 50
export const SPARES_MAX = 50

/** The source kinds this builder writes beyond the DoC generator's (the database takes any word in capitals). */
export const LEAFLET_SOURCE_KINDS = ['PROTECTOR_PLACEMENT', 'MATERIAL', 'MARKET', 'PUBLIC_DOC'] as const

export interface Section {
  readonly key: string
  readonly text: string
  readonly source: Source
  readonly wording?: Wording | null
  readonly values?: readonly PointValue[]
}

/** A protector's place in the garment (PRD-353; Annex II 1.3.1): the zone, what it must be, for which sizes, where it sits. */
export interface ProtectorPosition {
  /** The zone as the database names it ("shoulder"). */
  readonly zone: string
  readonly pocket: string
  readonly placementId: string
  readonly seq: number
  readonly protector: { readonly id: string; readonly code: string; readonly name: string }
  readonly standard: string
  readonly level: string
  /** The sizes it is for; empty: every size. */
  readonly sizes: readonly string[]
  readonly note: string | null
}

/** A spare protector that fits (PRD-354; Annex II 1.4(c)): certified for the zones it serves at their level. */
export interface SpareProtector {
  readonly name: string
  readonly code: string
  readonly itemId: string
  readonly zones: readonly string[]
  readonly standard: string
  readonly level: string
  readonly certificate: { readonly id: string; readonly number: string; readonly validTo: BusinessDate }
  /** The protector the garment is made with (true) or an approved alternate of its BOM line (false). */
  readonly placed: boolean
}

export interface LeafletContent {
  readonly template: string
  readonly sections: readonly Section[]
  readonly protectorPositions: readonly ProtectorPosition[]
  readonly spareProtectors: readonly SpareProtector[]
}

export interface PlacementFact {
  readonly id: string
  readonly seq: number
  /** ProtectorPocket: SHOULDER, ELBOW, BACK, CHEST, HIP, KNEE. */
  readonly pocket: string
  readonly protector: { readonly id: string; readonly code: string; readonly name: string }
  readonly standard: string
  readonly level: string
  readonly sizes: readonly string[]
  readonly note: string | null
}

export interface CandidateCertificate {
  readonly id: string
  readonly number: string
  readonly standard: string
  /** The level it grants (EN 1621: "1" or "2"). */
  readonly ppeClass: string | null
  readonly validTo: BusinessDate
  /** Valid on the leaflet's day (B-W2b-178's rule). */
  readonly valid: boolean
}

/** A protector that could go in the garment's pockets: a placed one, or an approved alternate of its BOM line. */
export interface SpareCandidate {
  readonly itemId: string
  readonly code: string
  readonly name: string
  readonly placed: boolean
  /** The placed protectors it stands in for (an alternate: its line's material); a placed one: itself. */
  readonly replaces: readonly string[]
  readonly certificates: readonly CandidateCertificate[]
}

export interface LeafletFacts {
  /** The DoC generator's facts of the revision (B-W2b-257). */
  readonly declaration: DeclarationFacts
  /** The market's importer (Reg. (EU) 2019/1020 art. 4), when the economic operators name one. */
  readonly importer: { readonly name: string; readonly address: string; readonly source: Source } | null
  /** The notified body's address from the register, when the certificate names an entry with one. */
  readonly bodyAddress: string | null
  /** The class as printed: the certificate's, else the style's. */
  readonly ppeClass: { readonly value: string; readonly source: Source } | null
  readonly placements: readonly PlacementFact[]
  /** The placement's findings (B-W2b-233): never blocking. */
  readonly placementFindings: readonly { readonly code: string; readonly placementId: string | null; readonly message: string }[]
  readonly spareCandidates: readonly SpareCandidate[]
  /** The market's marks ("CE"), with where they came from. */
  readonly markings: { readonly values: readonly string[]; readonly source: Source }
  /** The style's public DoC page (Annex II 1.4(l)). */
  readonly docAddress: { readonly address: string; readonly source: Source } | null
}

export interface Composition {
  readonly language: string
  readonly content: LeafletContent
  readonly blocking: readonly Problem[]
  readonly warnings: readonly Problem[]
  /** The template keys the language had no usable words for (filled from the original in a translation). */
  readonly missingPhrases: readonly string[]
}

const source = (kind: string, recordType?: string, recordId?: string): Source => ({ kind, ...(recordType ? { recordType } : {}), ...(recordId ? { recordId } : {}) })

/** The words of a template key in a language: the library's (with every placeholder), else the built-in words. */
export function wordsFor(book: PhraseBook, key: string, language: string): { words: string | null; wording: Wording | null; problem: string | null } {
  const library = book(key, language)
  const builtIn = builtInWords(key, language)
  if (library) {
    const lacking = missingPlaceholders(key, library.text)
    if (lacking.length === 0) return { words: library.text, wording: { key, kind: 'PHRASE', phraseId: library.phraseId, revision: library.revision }, problem: null }
    const problem = `Phrase ${key} in ${language} lacks ${lacking.map((name) => `{${name}}`).join(', ')}`
    return builtIn ? { words: builtIn, wording: { key, kind: 'TEMPLATE' }, problem } : { words: null, wording: null, problem }
  }
  return builtIn ? { words: builtIn, wording: { key, kind: 'TEMPLATE' }, problem: null } : { words: null, wording: null, problem: null }
}

const CATEGORY_WORDS: Readonly<Record<string, string>> = Object.freeze({ CATEGORY_I: 'I', CATEGORY_II: 'II', CATEGORY_III: 'III' })

/**
 * The spare protectors that fit (PRD-354): a candidate is listed for the placements it stands in for when a certificate
 * valid on the day covers it for the placement's standard (its family: "EN 1621-1") at the placement's level or higher.
 * A candidate no valid certificate qualifies is named as uncertified (a warning, never printed as a spare).
 */
export function spareProtectors(placements: readonly PlacementFact[], candidates: readonly SpareCandidate[]): { spares: SpareProtector[]; uncertified: { itemId: string; code: string; placed: boolean; zones: string[] }[] } {
  const spares: SpareProtector[] = []
  const uncertified: { itemId: string; code: string; placed: boolean; zones: string[] }[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (seen.has(candidate.itemId)) continue
    seen.add(candidate.itemId)
    const served = placements.filter((placement) => candidate.replaces.includes(placement.protector.id))
    if (served.length === 0) continue
    const zones = [...new Set(served.map((placement) => placement.pocket.toLowerCase()))]
    // The certificate that serves every placement it stands in for: same standard family, a level at least the one asked.
    const certificate = candidate.certificates
      .filter((entry) => entry.valid)
      .filter((entry) => served.every((placement) => standardFamily(entry.standard) === standardFamily(placement.standard) && levelServes(entry.ppeClass, placement.level)))
      .sort((a, b) => b.validTo.localeCompare(a.validTo) || a.number.localeCompare(b.number))[0]
    if (!certificate) {
      uncertified.push({ itemId: candidate.itemId, code: candidate.code, placed: candidate.placed, zones })
      continue
    }
    spares.push({
      name: candidate.name,
      code: candidate.code,
      itemId: candidate.itemId,
      zones,
      standard: certificate.standard,
      level: certificate.ppeClass!,
      certificate: { id: certificate.id, number: certificate.number, validTo: certificate.validTo },
      placed: candidate.placed,
    })
  }
  spares.sort((a, b) => Number(b.placed) - Number(a.placed) || a.zones.join(',').localeCompare(b.zones.join(',')) || a.code.localeCompare(b.code))
  return { spares: spares.slice(0, SPARES_MAX), uncertified }
}

/**
 * The leaflet's sections of a style revision in one language. `original`: the original's sections when this is a
 * translation (a section the library cannot give in this language keeps the original's words, UNTRANSLATED).
 */
export function composeUserInformation(facts: LeafletFacts, language: string, book: PhraseBook, original: readonly Section[] | null = null): Composition {
  const blocking: Problem[] = []
  const warnings: Problem[] = []
  const missing: string[] = []
  const sections: Section[] = []
  const declaration = facts.declaration
  const { style } = declaration
  const category = style.ppeCategory
  const product = productName(style, language)
  const styleSource = source('STYLE', 'Style', style.id)

  if (category === 'NOT_PPE') blocking.push({ code: 'NOT_PPE', point: null, message: `Style ${style.code} is not PPE: it has no PPE user information (Annex II 1.4).` })
  if (!declaration.revision) blocking.push({ code: 'NO_REVISION', point: null, message: `Style ${style.code} has no revision to write the user information of.` })
  if (!declaration.maker) {
    blocking.push({
      code: 'NO_MAKER',
      point: 'maker',
      message: `The manufacturer of ${style.code} is not known: add a MANUFACTURER row in Rules & markets › Operators, or give the company or brand its registered address (Annex II 1.4).`,
    })
  }
  const certified = category === 'CATEGORY_II' || category === 'CATEGORY_III'
  if (certified && !declaration.certificate) {
    blocking.push({ code: 'NO_CERTIFICATE', point: 'notifiedBody', message: declaration.certificateProblem ?? `No valid EU type-examination certificate covers ${style.code}: register one before generating its user information (Annex II 1.4(j)).` })
  }

  /** One section built from one or more template keys: the library's or built-in words, filled; else the original's words. */
  const put = (key: SectionKey, main: Source | ((wording: Wording | null) => Source), filled: readonly PointValue[], build: (words: (phraseKey: string, values?: Readonly<Record<string, string>>) => string) => string) => {
    const lacking: string[] = []
    let first: Wording | null = null
    const words = (phraseKey: string, values: Readonly<Record<string, string>> = {}): string => {
      const choice = wordsFor(book, phraseKey, language)
      if (choice.problem) warnings.push({ code: 'PHRASE_PLACEHOLDERS', point: key, message: `${choice.problem}: fix the translation in Rules & markets › Phrases.` })
      if (choice.words === null) {
        lacking.push(phraseKey)
        return ''
      }
      first ??= choice.wording
      return fillWords(choice.words, values)
    }
    const text = build(words).trim()
    const fromOriginal = original?.find((entry) => entry.key === key) ?? null
    if (lacking.length > 0 || (fromOriginal && fromOriginal.source.kind === 'TYPED')) {
      missing.push(...lacking)
      if (fromOriginal) {
        sections.push({ key, text: fromOriginal.text, source: source('UNTRANSLATED'), wording: null, values: filled })
        return
      }
      if (!original) {
        for (const phraseKey of new Set(lacking)) {
          blocking.push({ code: 'PHRASE_MISSING', point: key, message: `Phrase ${phraseKey} has no words in ${language}: add its translation in Rules & markets › Phrases (or generate the original in Italian or English and translate it).` })
        }
      }
      return
    }
    const wording: Wording | null = first
    sections.push({ key, text, source: typeof main === 'function' ? main(wording) : main, wording, values: filled })
  }
  const phraseSource = (wording: Wording | null): Source => (wording?.kind === 'PHRASE' && wording.phraseId ? source('PHRASE', 'Phrase', wording.phraseId) : source('TEMPLATE'))

  // The standards with their dates (the register's entry: its Official Journal citation), used by several sections.
  const listed = declaration.standards.map((standard) => (standard.entry ? `${standard.entry.label}${standard.entry.ojReference ? ` (${standard.entry.ojReference})` : ''}` : standard.typed))
  const short = declaration.standards.map((standard) => (standard.entry ? standard.entry.label : standard.typed))
  const standardsWords = listed.length > 0 ? listed.join('; ') : '—'
  const shortWords = short.length > 0 ? short.join(', ') : '—'
  const standardValues: PointValue[] = declaration.standards.map((standard, index) => ({ field: 'standard', value: listed[index]!, source: standard.entry ? source('REGISTER', 'RegulationOrStandard', standard.entry.id) : standard.source }))
  const firstStandard = declaration.standards[0]
  const standardSource = firstStandard ? (firstStandard.entry ? source('REGISTER', 'RegulationOrStandard', firstStandard.entry.id) : firstStandard.source) : styleSource
  for (const standard of declaration.standards) {
    if (!standard.entry) warnings.push({ code: 'STANDARD_NOT_IN_REGISTER', point: 'standards', message: `${standard.typed} is not in the register of laws and standards: its date is the edition typed.` })
    else if (standard.entry.status !== 'IN_FORCE') warnings.push({ code: 'STANDARD_NOT_IN_FORCE', point: 'standards', message: `${standard.entry.label} is ${standard.entry.status} in the register.` })
  }
  if (declaration.standards.length === 0 && category !== 'NOT_PPE') warnings.push({ code: 'NO_STANDARD', point: 'standards', message: `Style ${style.code} names no harmonised standard: type the standards section.` })

  const sizes = declaration.revision && declaration.revision.sizes.length > 0 ? declaration.revision.sizes.join(', ') : '—'
  const ppeClass = facts.ppeClass
  const standardCode = style.ppeStandard ? standardCodeOf(style.ppeStandard) : null
  const motorcycleGarment = standardCode === 'EN 17092'
  if (motorcycleGarment && !ppeClass) warnings.push({ code: 'NO_CLASS', point: 'performance', message: `Style ${style.code} is made to EN 17092 but names no class (AAA, AA, A, B or C): give it its class.` })

  // product — what it is, its revision, sizes and colours (art. 8(7): the leaflet goes with this product).
  if (declaration.revision) {
    const revision = declaration.revision
    const revisionSource = source('STYLE_REVISION', 'StyleRevision', revision.id)
    const colourways = declaration.colourways.length > 0 ? declaration.colourways.map((colourway) => (colourway.name && colourway.name !== colourway.code ? `${colourway.code} ${colourway.name}` : colourway.code)).join(', ') : '—'
    const categoryWords = CATEGORY_WORDS[category] ?? '—'
    put(
      'product',
      styleSource,
      [
        { field: 'product', value: product, source: styleSource },
        { field: 'code', value: style.code, source: styleSource },
        { field: 'revision', value: String(revision.revision), source: revisionSource },
        { field: 'category', value: categoryWords, source: styleSource },
        { field: 'sizes', value: sizes, source: revisionSource },
        { field: 'colourways', value: colourways, source: styleSource },
      ],
      (words) => words('userinfo.product', { product, code: style.code, revision: String(revision.revision), category: categoryWords, sizes, colourways }),
    )
  }

  // maker — the manufacturer, and the authorised representative and the importer the operators name for the market.
  if (declaration.maker) {
    const maker = declaration.maker
    const representative = declaration.representative
    const importer = facts.importer
    put(
      'maker',
      maker.source,
      [
        { field: 'maker', value: maker.name, source: maker.source },
        { field: 'makerAddress', value: maker.address, source: maker.source },
        ...(representative ? [{ field: 'representative', value: representative.name, source: representative.source }, { field: 'representativeAddress', value: representative.address, source: representative.source }] : []),
        ...(importer ? [{ field: 'importer', value: importer.name, source: importer.source }, { field: 'importerAddress', value: importer.address, source: importer.source }] : []),
      ],
      (words) =>
        [
          words('userinfo.maker', { maker: maker.name, makerAddress: maker.address }),
          representative ? words('userinfo.maker-representative', { representative: representative.name, representativeAddress: representative.address }) : '',
          importer ? words('userinfo.maker-importer', { importer: importer.name, importerAddress: importer.address }) : '',
        ]
          .filter((line) => line !== '')
          .join('\n'),
    )
  }

  // storage, use, cleaning — the library's words (Annex II 1.4(a)).
  put('storage', phraseSource, [], (words) => words('userinfo.storage'))
  put('use', phraseSource, [], (words) => words('userinfo.use'))
  put('cleaning', phraseSource, [], (words) => words('userinfo.cleaning'))

  // performance — the standards and the class (1.4(b)).
  if (category !== 'NOT_PPE') {
    const classValue: PointValue[] = ppeClass ? [{ field: 'ppeClass', value: ppeClass.value, source: ppeClass.source }] : []
    put('performance', standardSource, [...standardValues, ...classValue], (words) =>
      ppeClass ? words('userinfo.performance', { standards: shortWords, ppeClass: ppeClass.value }) : words('userinfo.performance-no-class', { standards: shortWords }),
    )
  }

  // protectors — each pocket's protector: zone, standard, level, sizes, where it sits; how to fit (1.3.1, PRD-353).
  const positions: ProtectorPosition[] = facts.placements.slice(0, 50).map((placement) => ({
    zone: placement.pocket.toLowerCase(),
    pocket: placement.pocket,
    placementId: placement.id,
    seq: placement.seq,
    protector: { ...placement.protector },
    standard: placement.standard,
    level: placement.level,
    sizes: [...placement.sizes],
    note: placement.note,
  }))
  if (declaration.revision) {
    const revisionSource = source('PROTECTOR_PLACEMENT', 'StyleRevision', declaration.revision.id)
    const noted = facts.placements.filter((placement) => placement.note !== null && placement.note.trim() !== '')
    // A note is the person's words in the language they typed it: never translated, so it is named in every language.
    if (noted.length > 0) {
      warnings.push({ code: 'POSITION_NOTE_AS_TYPED', point: 'protectors', message: `The position note${noted.length > 1 ? 's' : ''} of placement ${noted.map((placement) => placement.seq).join(', ')} ${noted.length > 1 ? 'print' : 'prints'} as typed in Products › Styles › Sizes › Protectors: check ${noted.length > 1 ? 'their' : 'its'} language.` })
    }
    put(
      'protectors',
      revisionSource,
      facts.placements.map((placement) => ({ field: 'position', value: `${placement.pocket.toLowerCase()} ${placement.standard} ${placement.level}${placement.sizes.length > 0 ? ` (${placement.sizes.join(', ')})` : ''}`, source: source('PROTECTOR_PLACEMENT', 'ProtectorPlacement', placement.id) })),
      (words) => {
        const lines = facts.placements.map((placement) => {
          const sizeWords = placement.sizes.length === 0 ? words('userinfo.sizes-every') : words('userinfo.sizes-some', { sizes: placement.sizes.join(', ') })
          const line = words('userinfo.protector-line', { zone: words(zoneKey(placement.pocket)), standard: placement.standard, level: placement.level, sizes: sizeWords })
          // The note's own full stop would stand before the list's separator: dropped.
          const note = placement.note?.trim().replace(/[.;]+$/, '') ?? ''
          return note !== '' ? `${line} – ${note}` : line
        })
        const held = lines.length > 0 ? words('userinfo.protectors', { positions: lines.join('; ') }) : words('userinfo.protectors-none')
        return `${held}\n${words('userinfo.protectors-fit', { sizes })}`
      },
    )
    if (facts.placements.length === 0 && motorcycleGarment && ppeClass && ppeClass.value !== 'B') {
      warnings.push({ code: 'NO_PROTECTORS', point: 'protectors', message: `Class ${ppeClass.value} of EN 17092 holds with its impact protectors, and revision ${declaration.revision.revision} places none: record them in Products › Styles › Sizes › Protectors.` })
    }
  }
  for (const finding of facts.placementFindings) warnings.push({ code: `PLACEMENT_${finding.code}`, point: 'protectors', message: finding.message })

  // spares — the protectors that fit, certified at the level each zone asks (1.4(c), PRD-354).
  const { spares, uncertified } = spareProtectors(facts.placements, facts.spareCandidates)
  for (const entry of uncertified) {
    warnings.push({
      code: 'SPARE_NOT_CERTIFIED',
      point: 'spares',
      message: `${entry.placed ? 'Protector' : 'Alternate protector'} ${entry.code} has no certificate valid today for the standard and level of the ${entry.zones.join(', ')}: it is not listed as a spare.`,
    })
  }
  if (declaration.revision && facts.placements.length > 0) {
    put(
      'spares',
      source('MATERIAL', 'StyleRevision', declaration.revision.id),
      spares.map((spare) => ({ field: 'spare', value: `${spare.code} ${spare.standard} ${spare.level} ${spare.certificate.number}`, source: source('CERTIFICATE', 'Certificate', spare.certificate.id) })),
      (words) =>
        spares.length === 0
          ? words('userinfo.spares-none')
          : words('userinfo.spares', {
              spares: spares
                .map((spare) => words('userinfo.spare-line', { zone: spare.zones.map((zone) => words(zoneKey(zone))).join(', '), name: spare.name, standard: spare.standard, level: spare.level, certificate: spare.certificate.number }))
                .join('; '),
            }),
    )
  }

  // limits — the limits of use and the class warnings of EN 17092 (1.4(d); the library's WARNING phrases, B-W2b-253).
  {
    const asked = warningsAsked({ standardCode, ppeClass: ppeClass?.value ?? null, protectorPockets: facts.placements.map((placement) => placement.pocket) })
    const present: string[] = []
    for (const reason of asked) {
      const key = WARNING_PHRASE_KEYS[reason]
      const library = book(key, language)
      if (library) present.push(library.text)
      else warnings.push({ code: 'CLASS_WARNING_MISSING', point: 'limits', message: `Phrase ${key} has no words in ${language}: the class warning is missing from the limits of use until it is added in Rules & markets › Phrases.` })
    }
    put('limits', phraseSource, [], (words) => [words('userinfo.limits'), ...present].join('\n'))
  }

  // obsolescence (1.4(e)).
  put('obsolescence', phraseSource, [], (words) => words('userinfo.obsolescence'))

  // markings — the market's marks, the pictogram with the standard and the class (1.4(g)).
  if (category !== 'NOT_PPE') {
    const marks = facts.markings.values.length > 0 ? facts.markings.values.join(', ') : 'CE'
    put(
      'markings',
      facts.markings.source,
      [{ field: 'markings', value: marks, source: facts.markings.source }, ...(ppeClass ? [{ field: 'ppeClass', value: ppeClass.value, source: ppeClass.source }] : [])],
      (words) => words('userinfo.markings', { markings: marks, standard: style.ppeStandard ? (standardCodeOf(style.ppeStandard) ?? style.ppeStandard) : '—', ppeClass: ppeClass?.value ?? '—' }),
    )
  }

  // risks — what it protects against, as the standards test it (1.4(h)).
  if (category !== 'NOT_PPE') {
    put('risks', standardSource, standardValues, (words) => [words('userinfo.risks', { standards: shortWords }), ...(facts.placements.length > 0 ? [words('userinfo.risks-impact')] : [])].join('\n'))
  }

  // regulation (1.4(i)).
  {
    const label = declaration.legislation ? (declaration.legislation.labels[language] ?? declaration.legislation.label) : language === 'it' ? 'Regolamento (UE) 2016/425' : 'Regulation (EU) 2016/425'
    const main = declaration.legislation ? source('REGISTER', 'RegulationOrStandard', declaration.legislation.id) : source('TEMPLATE')
    if (!declaration.legislation) warnings.push({ code: 'LEGISLATION_NOT_IN_REGISTER', point: 'regulation', message: 'Reg. (EU) 2016/425 is not in the register of laws and standards: the builder wrote its name itself.' })
    put('regulation', main, [{ field: 'legislation', value: label, source: main }], (words) => words('userinfo.regulation', { legislation: label }))
  }

  // notifiedBody — the body's name, address and number, and the certificate (1.4(j)).
  if (certified) {
    if (declaration.certificate) {
      const certificate = declaration.certificate
      const certificateSource = source('CERTIFICATE', 'Certificate', certificate.id)
      const bodySource = certificate.bodyId ? source('NOTIFIED_BODY', 'NotifiedBody', certificate.bodyId) : certificateSource
      if (!facts.bodyAddress) warnings.push({ code: 'NO_BODY_ADDRESS', point: 'notifiedBody', message: `The notified body ${certificate.bodyName} (${certificate.bodyNumber}) has no address in the register: Annex II 1.4(j) asks for it.` })
      put(
        'notifiedBody',
        certificateSource,
        [
          { field: 'body', value: certificate.bodyName, source: bodySource },
          ...(facts.bodyAddress ? [{ field: 'bodyAddress', value: facts.bodyAddress, source: bodySource }] : []),
          { field: 'bodyNumber', value: certificate.bodyNumber, source: bodySource },
          { field: 'certificate', value: certificate.number, source: certificateSource },
        ],
        (words) =>
          facts.bodyAddress
            ? words('userinfo.notified-body', { body: certificate.bodyName, bodyAddress: facts.bodyAddress, bodyNumber: certificate.bodyNumber, certificate: certificate.number })
            : words('userinfo.notified-body-no-address', { body: certificate.bodyName, bodyNumber: certificate.bodyNumber, certificate: certificate.number }),
      )
    }
  } else if (category === 'CATEGORY_I') {
    put('notifiedBody', styleSource, [], (words) => words('userinfo.notified-body-category-one'))
  }

  // standards (1.4(k)).
  if (category !== 'NOT_PPE') put('standards', standardSource, standardValues, (words) => words('userinfo.standards', { standards: standardsWords }))

  // docAddress — where the DoC is (1.4(l)): the style's public DoC page.
  if (facts.docAddress) {
    const address = facts.docAddress
    put('docAddress', address.source, [{ field: 'address', value: address.address, source: address.source }], (words) => words('userinfo.doc-address', { address: address.address }))
  }

  return { language, content: { template: TEMPLATE_ID, sections: orderSections(sections), protectorPositions: positions, spareProtectors: spares }, blocking, warnings, missingPhrases: [...new Set(missing)] }
}

/** "EN 17092-3:2020" → "EN 17092" (the standard's code without its part and edition). */
export function standardCodeOf(standard: string): string | null {
  const match = /^(.*?\d)(?:-(\d+))?(?::(\d{4}))?$/.exec(standard.trim())
  return match ? match[1]!.replace(/\s+/g, ' ').toUpperCase() : standard.trim().toUpperCase() || null
}

const sectionOrder = (key: string): number => {
  const index = (SECTION_KEYS as readonly string[]).indexOf(key)
  return index === -1 ? SECTION_KEYS.length : index
}

/** Sections in the template's order (a key it does not know goes last, in the order given). */
export const orderSections = <T extends { readonly key: string }>(sections: readonly T[]): T[] => [...sections].map((section, index) => ({ section, index })).sort((a, b) => sectionOrder(a.section.key) - sectionOrder(b.section.key) || a.index - b.index).map(({ section }) => section)

// ---- typed edits --------------------------------------------------------------------------------------------------------

export interface SectionEdit {
  readonly key: string
  readonly text: string
}

/** What is wrong with typed section words (paths under `body/sections`). */
export function sectionEditProblems(edits: readonly SectionEdit[]): Issue[] {
  const problems: Issue[] = []
  const seen = new Set<string>()
  edits.forEach((edit, index) => {
    if (!(SECTION_KEYS as readonly string[]).includes(edit.key)) problems.push({ path: `body/sections/${index}/key`, message: `A section of the leaflet: ${SECTION_KEYS.join(', ')}.` })
    else if (seen.has(edit.key)) problems.push({ path: `body/sections/${index}/key`, message: `Section ${edit.key} is given twice.` })
    seen.add(edit.key)
    if (edit.text.trim() === '' || edit.text.length > WORDS_MAX) problems.push({ path: `body/sections/${index}/text`, message: `The words: 1 to ${WORDS_MAX} characters.` })
  })
  return problems
}

/** The sections with the typed words in place (a section not there yet is added in its place), each TYPED by `userId`. */
export function applyEdits(sections: readonly Section[], edits: readonly SectionEdit[], userId: string | null): Section[] {
  const byKey = new Map(sections.map((section) => [section.key, section]))
  for (const edit of edits) {
    const before = byKey.get(edit.key)
    if (before && before.text === edit.text.trim()) continue
    byKey.set(edit.key, { key: edit.key, text: edit.text.trim(), source: typedBy(userId), wording: null, values: before?.values ?? [] })
  }
  return orderSections([...byKey.values()])
}

/** A refresh that keeps the typed sections: the fresh composition, with each TYPED section of the draft put back. */
export function keepTyped(fresh: readonly Section[], draft: readonly Section[]): Section[] {
  const typed = new Map(draft.filter((section) => section.source.kind === 'TYPED').map((section) => [section.key, section]))
  const merged = new Map(fresh.map((section) => [section.key, typed.get(section.key) ?? section]))
  for (const [key, value] of typed) if (!merged.has(key)) merged.set(key, value)
  return orderSections([...merged.values()])
}

export interface SectionDifference {
  readonly key: string
  readonly stored: string | null
  readonly fresh: string | null
}

/** Where the stored sections differ from what the records give now (typed and untranslated sections are never stale). */
export function differences(stored: readonly Section[], fresh: readonly Section[]): SectionDifference[] {
  const out: SectionDifference[] = []
  const keys = orderSections([...new Set([...stored.map((section) => section.key), ...fresh.map((section) => section.key)])].map((key) => ({ key })))
  for (const { key } of keys) {
    const before = stored.find((entry) => entry.key === key) ?? null
    const now = fresh.find((entry) => entry.key === key) ?? null
    if (before && (before.source.kind === 'TYPED' || before.source.kind === 'UNTRANSLATED')) continue
    if ((before?.text ?? null) !== (now?.text ?? null)) out.push({ key, stored: before?.text ?? null, fresh: now?.text ?? null })
  }
  return out
}

/** Whether the spare protectors or the protector positions changed against the records (a certificate expired, a placement moved). */
export function listsChanged(stored: Pick<LeafletContent, 'protectorPositions' | 'spareProtectors'>, fresh: Pick<LeafletContent, 'protectorPositions' | 'spareProtectors'>): { positions: boolean; spares: boolean } {
  const positionKey = (entry: ProtectorPosition) => `${entry.placementId}|${entry.protector.id}|${entry.standard}|${entry.level}|${entry.sizes.join(',')}|${entry.note ?? ''}`
  const spareKey = (entry: SpareProtector) => `${entry.itemId}|${entry.zones.join(',')}|${entry.standard}|${entry.level}|${entry.certificate.id}`
  const same = <T>(a: readonly T[], b: readonly T[], key: (entry: T) => string) => a.length === b.length && a.map(key).join('\n') === b.map(key).join('\n')
  return { positions: !same(stored.protectorPositions, fresh.protectorPositions, positionKey), spares: !same(stored.spareProtectors, fresh.spareProtectors, spareKey) }
}

// ---- reading and writing the stored JSON ---------------------------------------------------------------------------------

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)

function sourceOf(value: unknown): Source {
  if (!isObject(value) || typeof value.kind !== 'string') return { kind: 'TYPED' }
  return { kind: value.kind, ...(typeof value.recordType === 'string' ? { recordType: value.recordType } : {}), ...(typeof value.recordId === 'string' ? { recordId: value.recordId } : {}) }
}

/** The leaflet of a stored `sections` value (W1's signed leaflets have none: empty lists). Read loosely: what is not readable is left out. */
export function sectionsOf(value: unknown): LeafletContent {
  if (!isObject(value)) return { template: TEMPLATE_ID, sections: [], protectorPositions: [], spareProtectors: [] }
  const sections: Section[] = []
  for (const entry of Array.isArray(value.sections) ? value.sections : []) {
    if (!isObject(entry) || typeof entry.key !== 'string' || typeof entry.text !== 'string') continue
    const wording: Wording | null =
      isObject(entry.wording) && typeof entry.wording.key === 'string' && (entry.wording.kind === 'PHRASE' || entry.wording.kind === 'TEMPLATE')
        ? {
            key: entry.wording.key,
            kind: entry.wording.kind as Wording['kind'],
            ...(typeof entry.wording.phraseId === 'string' ? { phraseId: entry.wording.phraseId } : {}),
            ...(typeof entry.wording.revision === 'number' ? { revision: entry.wording.revision } : {}),
          }
        : null
    const values = Array.isArray(entry.values)
      ? entry.values.filter(isObject).filter((item) => typeof item.field === 'string' && typeof item.value === 'string').map((item) => ({ field: item.field as string, value: item.value as string, source: sourceOf(item.source) }))
      : []
    sections.push({ key: entry.key, text: entry.text, source: sourceOf(entry.source), wording, values })
  }
  const protectorPositions: ProtectorPosition[] = []
  for (const entry of Array.isArray(value.protectorPositions) ? value.protectorPositions : []) {
    if (!isObject(entry) || typeof entry.zone !== 'string') continue
    const protector = isObject(entry.protector) ? entry.protector : {}
    protectorPositions.push({
      zone: entry.zone,
      pocket: text(entry.pocket) ?? entry.zone.toUpperCase(),
      placementId: text(entry.placementId) ?? '',
      seq: typeof entry.seq === 'number' ? entry.seq : protectorPositions.length + 1,
      protector: { id: text(protector.id) ?? '', code: text(protector.code) ?? '', name: text(protector.name) ?? '' },
      standard: text(entry.standard) ?? '',
      level: text(entry.level) ?? '',
      sizes: Array.isArray(entry.sizes) ? entry.sizes.filter((size): size is string => typeof size === 'string') : [],
      note: text(entry.note),
    })
  }
  const spareProtectors: SpareProtector[] = []
  for (const entry of Array.isArray(value.spareProtectors) ? value.spareProtectors : []) {
    if (!isObject(entry) || typeof entry.name !== 'string') continue
    const certificate = isObject(entry.certificate) ? entry.certificate : {}
    spareProtectors.push({
      name: entry.name,
      code: text(entry.code) ?? '',
      itemId: text(entry.itemId) ?? '',
      zones: Array.isArray(entry.zones) ? entry.zones.filter((zone): zone is string => typeof zone === 'string') : [],
      standard: text(entry.standard) ?? '',
      level: text(entry.level) ?? '',
      certificate: { id: text(certificate.id) ?? '', number: text(certificate.number) ?? '', validTo: text(certificate.validTo) ?? '' },
      placed: entry.placed === true,
    })
  }
  return { template: typeof value.template === 'string' ? value.template : TEMPLATE_ID, sections, protectorPositions, spareProtectors }
}

/** The JSON stored in ComplianceDocument.sections. */
export const sectionsJson = (content: LeafletContent) => ({
  template: content.template,
  sections: content.sections.map((section) => ({
    key: section.key,
    text: section.text,
    source: { ...section.source },
    ...(section.wording ? { wording: { ...section.wording } } : {}),
    values: (section.values ?? []).map((value) => ({ field: value.field, value: value.value, source: { ...value.source } })),
  })),
  protectorPositions: content.protectorPositions.map((entry) => ({ ...entry, protector: { ...entry.protector }, sizes: [...entry.sizes] })),
  spareProtectors: content.spareProtectors.map((entry) => ({ ...entry, zones: [...entry.zones], certificate: { ...entry.certificate } })),
})

/** Where a value came from, in words (the SourceIndicator's line): the DoC generator's words, and this builder's own kinds. */
export function sourceWords(value: Source, names: Readonly<Record<string, string>> = {}): string {
  const named = value.recordId ? names[value.recordId] : undefined
  switch (value.kind) {
    case 'PROTECTOR_PLACEMENT':
      return value.recordType === 'ProtectorPlacement' ? (named ? `from protector placement ${named}` : 'from the protector placement') : named ? `from the protector placement of revision ${named}` : 'from the protector placement'
    case 'MATERIAL':
      return named ? `from the protectors of revision ${named} and their certificates` : 'from the protectors and their certificates'
    case 'MARKET':
      return named ? `from market ${named}` : 'from the market (Rules & markets)'
    case 'PUBLIC_DOC':
      return "from the style's public DoC page"
    case 'TEMPLATE':
      return "from the builder's built-in Annex II words"
    case 'UNTRANSLATED':
      return "the original's words: to translate"
    default:
      return declarationSourceWords(value, names)
  }
}

// ---- translations ------------------------------------------------------------------------------------------------------

/** The sections as the DoC generator's translation rules read them (`point` = the section's key). */
const asPoints = (sections: readonly Section[]) => sections.map((section) => ({ point: section.key, text: section.text, source: section.source }))

/** The state a new translation starts in: DRAFT when the library gave every section, IN_TRANSLATION when words wait. */
export const startingState = (sections: readonly Section[]): TranslationState => pointStartingState(asPoints(sections))

/** The sections still holding the original's words or words to type. */
export const sectionsToType = (sections: readonly Section[]): string[] => sections.filter((section) => section.source.kind === 'UNTRANSLATED' || section.source.kind === 'TO_TYPE').map((section) => section.key)

/** Why a language cannot be added to an original, in words (null: fine). */
export function translationRefusal(input: { readonly originalLanguage: string; readonly language: string; readonly taken: readonly string[] }): { code: string; message: string } | null {
  const refusal = declarationTranslationRefusal(input)
  if (refusal?.code === 'TAKEN') return { code: 'TAKEN', message: `This revision already has generated user information in ${input.language}: open it.` }
  return refusal
}

/** Why a translation cannot be checked by this person (null: fine): the DoC generator's rule, with the leaflet's words. */
export function checkRefusal(input: { readonly status: string; readonly translationState: TranslationState | null; readonly authorId: string | null; readonly checkerId: string; readonly sections: readonly Section[] }): { code: string; message: string } | null {
  const refusal = pointCheckRefusal({ status: input.status, translationState: input.translationState, authorId: input.authorId, checkerId: input.checkerId, points: asPoints(input.sections) })
  if (refusal?.code === 'WORDS_MISSING') {
    const open = sectionsToType(input.sections)
    return { code: 'WORDS_MISSING', message: `Section${open.length > 1 ? 's' : ''} ${open.join(', ')} still ${open.length > 1 ? 'hold' : 'holds'} the original's words: type ${open.length > 1 ? 'them' : 'it'} first.` }
  }
  return refusal
}
