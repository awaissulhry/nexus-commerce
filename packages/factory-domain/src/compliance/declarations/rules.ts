import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { builtInWords, fillWords, missingPlaceholders, TEMPLATE_ID } from './template'

/**
 * The DoC generator's rules (B-W2b-257; PRD-292, PRD-293; Reg. (EU) 2016/425 art. 15, Annex IX), pure. The API reads the
 * facts of one style revision (the style, the revision and its colourways and sizes, the manufacturer from the economic
 * operators, the certificate that covers it with its notified body, the regulation and the harmonised standards from the
 * register, the typed signatory) and the phrase library; `composeDeclaration` writes the nine Annex IX points in one
 * language, each with where its value came from (`source`, as B-W2b-218's content shape wants it: { kind, recordType?,
 * recordId? }), the words it used (`wording`: a phrase of the library or the built-in template) and every value it filled
 * in (`values`, each with its own source: what the screen's SourceIndicator shows).
 *
 * The points (Annex IX): 1 the PPE (product, model, batch or serial); 2 the manufacturer and, where there is one, the
 * authorised representative; 3 the sole-responsibility sentence; 4 the object of the declaration (revision, colours,
 * sizes; the colour image is not generated); 5 the Union legislation; 6 the harmonised standards with their dates; 7 the
 * notified body and the EU type-examination certificate (category II and III; category I: not applicable, module A); 8 the
 * production-phase module under a notified body's surveillance (category III: typed by a person; otherwise not applicable);
 * 9 additional information and "signed for and on behalf of" with the typed signatory.
 *
 * Refusals (`blocking`): not PPE, no revision, no manufacturer's name and address, a category II or III style without a
 * valid certificate covering it, a template phrase missing (or without its placeholders) in the language of an original.
 * Warnings: a standard not in the register or no longer in force, point 8 to type, the signatory to type, a phrase taken
 * from the built-in words.
 *
 * Translations (PRD-293): the same facts composed in another language; a point whose words the library does not have in
 * that language (or that a person typed in the original) keeps the original's words with the source kind UNTRANSLATED,
 * and the translation starts IN_TRANSLATION for a translator to type them. A translation is checked by a second person:
 * never its author, nor anyone who typed its words (a typed point names its typist: { kind: TYPED, recordType: "User",
 * recordId }), and never while a point is UNTRANSLATED or still to type.
 */

export const POINT_IDS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const
export type PointId = (typeof POINT_IDS)[number]

export const WORDS_MAX = 4000
export const NOTE_MAX = 2000
export const REASON_MIN = 3
export const REASON_MAX = 500
export const LANGUAGE = /^[a-z]{2,3}$/
export const NAME_MAX = 200
export const PLACE_MAX = 200
export const NUMBER_MAX = 60

/** The source kinds this generator writes (the database takes any word in capitals). */
export const SOURCE_KINDS = ['STYLE', 'STYLE_REVISION', 'OPERATOR', 'PARTY', 'COMPANY', 'LABEL', 'CERTIFICATE', 'NOTIFIED_BODY', 'REGISTER', 'PHRASE', 'TEMPLATE', 'TYPED', 'UNTRANSLATED', 'TO_TYPE'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

export interface Source {
  readonly kind: string
  readonly recordType?: string
  readonly recordId?: string
}

export interface PointValue {
  readonly field: string
  readonly value: string
  readonly source: Source
}

export interface Wording {
  readonly key: string
  readonly kind: 'PHRASE' | 'TEMPLATE'
  readonly phraseId?: string
  readonly revision?: number
}

export interface AnnexPoint {
  readonly point: string
  readonly text: string
  readonly source: Source
  readonly wording?: Wording | null
  readonly values?: readonly PointValue[]
}

export interface DeclarationContent {
  readonly template: string
  readonly points: readonly AnnexPoint[]
}

export type PpeCategoryCode = 'NOT_PPE' | 'CATEGORY_I' | 'CATEGORY_II' | 'CATEGORY_III'

export interface DeclarationFacts {
  readonly style: {
    readonly id: string
    readonly code: string
    readonly name: string
    /** The name per language ({ "de": "…" }); the style's name when a language has none. */
    readonly nameI18n: Readonly<Record<string, string>> | null
    readonly ppeCategory: PpeCategoryCode
    readonly ppeStandard: string | null
    readonly ppeClass: string | null
  }
  readonly revision: { readonly id: string; readonly revision: number; readonly sizes: readonly string[] } | null
  readonly colourways: readonly { readonly id: string; readonly code: string; readonly name: string }[]
  /** The manufacturer as printed (Annex IX 2), with where it came from; null: not known. */
  readonly maker: { readonly name: string; readonly address: string; readonly source: Source } | null
  readonly representative: { readonly name: string; readonly address: string; readonly source: Source } | null
  /** The certificate the DoC cites (valid today, covering the style), or null. */
  readonly certificate: {
    readonly id: string
    readonly number: string
    readonly bodyName: string
    readonly bodyNumber: string
    /** The register's notified body, when the certificate names one. */
    readonly bodyId: string | null
  } | null
  /** Why no certificate is cited, in words (a covering one expired, none covers it), when there is none. */
  readonly certificateProblem: string | null
  /** Reg. (EU) 2016/425 as the register names it (per language), or null when the register has no entry. */
  readonly legislation: { readonly id: string; readonly label: string; readonly labels: Readonly<Record<string, string>> } | null
  readonly standards: readonly StandardFact[]
  readonly signatory: { readonly name: string | null; readonly function: string | null; readonly place: string | null; readonly on: BusinessDate | null }
}

export interface StandardFact {
  /** As typed on the style or the certificate ("EN 17092-3:2020"). */
  readonly typed: string
  /** The register's entry it names, when there is one. */
  readonly entry: { readonly id: string; readonly label: string; readonly ojReference: string | null; readonly status: string } | null
  /** Where it was typed (the style or the certificate). */
  readonly source: Source
}

export interface LibraryWords {
  readonly text: string
  readonly phraseId: string
  readonly revision: number
}

/** The phrase library's words for a key in a language (the source words or the approved translation), or null. */
export type PhraseBook = (key: string, language: string) => LibraryWords | null

export interface Problem {
  readonly code: string
  readonly point: string | null
  readonly message: string
}

export interface Composition {
  readonly language: string
  readonly content: DeclarationContent
  readonly blocking: readonly Problem[]
  readonly warnings: readonly Problem[]
  /** The template keys the language had no usable words for (filled from the original in a translation). */
  readonly missingPhrases: readonly string[]
}

const source = (kind: SourceKind, recordType?: string, recordId?: string): Source => ({ kind, ...(recordType ? { recordType } : {}), ...(recordId ? { recordId } : {}) })
export const typedBy = (userId: string | null): Source => (userId ? source('TYPED', 'User', userId) : source('TYPED'))

/** Days as a reader of the language writes them (it 10/11/2026, de 10.11.2026, else 2026-11-10). */
export function dayWords(day: BusinessDate, language: string): string {
  const [year, month, date] = day.split('-')
  if (language === 'it' || language === 'fr' || language === 'es') return `${date}/${month}/${year}`
  if (language === 'de' || language === 'nl') return `${date}.${month}.${year}`
  return day
}

export const productName = (style: DeclarationFacts['style'], language: string): string => {
  const named = style.nameI18n?.[language]
  return typeof named === 'string' && named.trim() !== '' ? named.trim() : style.name
}

/** The number a generated DoC carries (the design's "DoC-JK100-DE-r3"). */
export const declarationNumber = (code: string, language: string, revision: number): string => `DoC-${code}-${language.toUpperCase()}-r${revision}`.slice(0, NUMBER_MAX)

interface PhraseChoice {
  readonly words: string | null
  readonly wording: Wording | null
  readonly problem: string | null
}

/** The words of a template key in a language: the library's (with every placeholder), else the built-in words. */
export function wordsFor(book: PhraseBook, key: string, language: string): PhraseChoice {
  const library = book(key, language)
  if (library) {
    const lacking = missingPlaceholders(key, library.text)
    if (lacking.length === 0) return { words: library.text, wording: { key, kind: 'PHRASE', phraseId: library.phraseId, revision: library.revision }, problem: null }
    const builtIn = builtInWords(key, language)
    const problem = `Phrase ${key} in ${language} lacks ${lacking.map((name) => `{${name}}`).join(', ')}`
    return builtIn ? { words: builtIn, wording: { key, kind: 'TEMPLATE' }, problem } : { words: null, wording: null, problem }
  }
  const builtIn = builtInWords(key, language)
  return builtIn ? { words: builtIn, wording: { key, kind: 'TEMPLATE' }, problem: null } : { words: null, wording: null, problem: null }
}

/**
 * The nine Annex IX points of a style revision in one language. `original`: the original's points when this is a
 * translation (a point the library cannot give in this language keeps the original's words, UNTRANSLATED).
 */
export function composeDeclaration(facts: DeclarationFacts, language: string, book: PhraseBook, original: readonly AnnexPoint[] | null = null): Composition {
  const blocking: Problem[] = []
  const warnings: Problem[] = []
  const missing: string[] = []
  const points: AnnexPoint[] = []
  const { style } = facts
  const category = style.ppeCategory
  const product = productName(style, language)

  if (category === 'NOT_PPE') blocking.push({ code: 'NOT_PPE', point: null, message: `Style ${style.code} is not PPE: it has no Declaration of Conformity.` })
  if (!facts.revision) blocking.push({ code: 'NO_REVISION', point: null, message: `Style ${style.code} has no revision to declare.` })
  if (!facts.maker) {
    blocking.push({
      code: 'NO_MAKER',
      point: '2',
      message: `The manufacturer of ${style.code} is not known: add a MANUFACTURER row in Rules & markets › Operators, or give the company or brand its registered address (Annex IX 2).`,
    })
  }
  const certified = category === 'CATEGORY_II' || category === 'CATEGORY_III'
  if (certified && !facts.certificate) {
    blocking.push({ code: 'NO_CERTIFICATE', point: '7', message: facts.certificateProblem ?? `No valid EU type-examination certificate covers ${style.code}: register one before generating its DoC (Annex IX 7).` })
  }

  /** One point from a template key: the library's or built-in words, filled; else the original's words (a translation). */
  const put = (point: PointId, key: string, values: Readonly<Record<string, string>>, main: Source, filled: readonly PointValue[], suffix?: { key: string; values: Readonly<Record<string, string>> } | null) => {
    const keys = [key, ...(suffix ? [suffix.key] : [])]
    const choices = keys.map((entry) => ({ entry, choice: wordsFor(book, entry, language) }))
    for (const { entry, choice } of choices) {
      if (choice.problem) warnings.push({ code: 'PHRASE_PLACEHOLDERS', point, message: `${choice.problem}: fix the translation in Rules & markets › Phrases.` })
      if (choice.words === null) missing.push(entry)
    }
    const fromOriginal = original?.find((entry) => entry.point === point) ?? null
    if (choices.some(({ choice }) => choice.words === null) || (fromOriginal && fromOriginal.source.kind === 'TYPED')) {
      if (fromOriginal) {
        points.push({ point, text: fromOriginal.text, source: source('UNTRANSLATED'), wording: null, values: filled })
        return
      }
      if (!original) {
        for (const { entry, choice } of choices) {
          if (choice.words === null) blocking.push({ code: 'PHRASE_MISSING', point, message: `Phrase ${entry} has no words in ${language}: add its translation in Rules & markets › Phrases (or generate the original in Italian or English and translate it).` })
        }
      }
      return
    }
    const words = choices.map(({ choice }, index) => fillWords(choice.words!, index === 0 ? values : suffix!.values)).join('\n')
    const wording = choices[0]!.choice.wording
    if (wording?.kind === 'TEMPLATE' && !['it', 'en'].includes(language)) warnings.push({ code: 'PHRASE_BUILT_IN', point, message: `Phrase ${key} in ${language} came from the built-in words.` })
    points.push({ point, text: words, source: main, wording, values: filled })
  }

  // 1 — the PPE: product, model; the batch or serial is on each item's label.
  const styleSource = source('STYLE', 'Style', style.id)
  put('1', 'doc.point1', { product, code: style.code }, styleSource, [
    { field: 'product', value: product, source: styleSource },
    { field: 'code', value: style.code, source: styleSource },
  ])

  // 2 — the manufacturer (and the authorised representative).
  if (facts.maker) {
    const maker = facts.maker
    const representative = facts.representative
    put(
      '2',
      'doc.point2',
      { maker: maker.name, makerAddress: maker.address },
      maker.source,
      [
        { field: 'maker', value: maker.name, source: maker.source },
        { field: 'makerAddress', value: maker.address, source: maker.source },
        ...(representative
          ? [
              { field: 'representative', value: representative.name, source: representative.source },
              { field: 'representativeAddress', value: representative.address, source: representative.source },
            ]
          : []),
      ],
      representative ? { key: 'doc.point2-representative', values: { representative: representative.name, representativeAddress: representative.address } } : null,
    )
  }

  // 3 — the sole-responsibility sentence (the words are the source).
  {
    const choice = wordsFor(book, 'doc.sole-responsibility', language)
    const main = choice.wording?.kind === 'PHRASE' ? source('PHRASE', 'Phrase', choice.wording.phraseId) : source('TEMPLATE')
    put('3', 'doc.sole-responsibility', {}, main, [])
  }

  // 4 — the object of the declaration: revision, colours, sizes.
  if (facts.revision) {
    const revisionSource = source('STYLE_REVISION', 'StyleRevision', facts.revision.id)
    const colourways = facts.colourways.length > 0 ? facts.colourways.map((colourway) => (colourway.name && colourway.name !== colourway.code ? `${colourway.code} ${colourway.name}` : colourway.code)).join(', ') : '—'
    const sizes = facts.revision.sizes.length > 0 ? facts.revision.sizes.join(', ') : '—'
    put('4', 'doc.point4', { product, code: style.code, revision: String(facts.revision.revision), colourways, sizes }, revisionSource, [
      { field: 'revision', value: String(facts.revision.revision), source: revisionSource },
      { field: 'colourways', value: colourways, source: styleSource },
      { field: 'sizes', value: sizes, source: revisionSource },
    ])
  }

  // 5 — the Union legislation (the register's entry, else the Regulation's name).
  {
    const label = facts.legislation ? (facts.legislation.labels[language] ?? facts.legislation.label) : language === 'it' ? 'Regolamento (UE) 2016/425' : 'Regulation (EU) 2016/425'
    const main = facts.legislation ? source('REGISTER', 'RegulationOrStandard', facts.legislation.id) : source('TEMPLATE')
    if (!facts.legislation) warnings.push({ code: 'LEGISLATION_NOT_IN_REGISTER', point: '5', message: 'Reg. (EU) 2016/425 is not in the register of laws and standards: the generator wrote its name itself.' })
    put('5', 'doc.point5', { legislation: label }, main, [{ field: 'legislation', value: label, source: main }])
  }

  // 6 — the harmonised standards with their dates (the register's entry: its Official Journal citation).
  {
    const listed = facts.standards.map((standard) => (standard.entry ? `${standard.entry.label}${standard.entry.ojReference ? ` (${standard.entry.ojReference})` : ''}` : standard.typed))
    for (const standard of facts.standards) {
      if (!standard.entry) warnings.push({ code: 'STANDARD_NOT_IN_REGISTER', point: '6', message: `${standard.typed} is not in the register of laws and standards: its date is the edition typed.` })
      else if (standard.entry.status !== 'IN_FORCE') warnings.push({ code: 'STANDARD_NOT_IN_FORCE', point: '6', message: `${standard.entry.label} is ${standard.entry.status} in the register.` })
    }
    if (facts.standards.length === 0 && category !== 'NOT_PPE') warnings.push({ code: 'NO_STANDARD', point: '6', message: `Style ${style.code} names no harmonised standard: type point 6.` })
    const first = facts.standards[0]
    const main = first ? (first.entry ? source('REGISTER', 'RegulationOrStandard', first.entry.id) : first.source) : styleSource
    put(
      '6',
      'doc.point6',
      { standards: listed.length > 0 ? listed.join('; ') : '—' },
      main,
      facts.standards.map((standard, index) => ({ field: 'standard', value: listed[index]!, source: standard.entry ? source('REGISTER', 'RegulationOrStandard', standard.entry.id) : standard.source })),
    )
  }

  // 7 — the notified body and the EU type-examination certificate (category II and III).
  if (certified) {
    if (facts.certificate) {
      const certificate = facts.certificate
      const certificateSource = source('CERTIFICATE', 'Certificate', certificate.id)
      const bodySource = certificate.bodyId ? source('NOTIFIED_BODY', 'NotifiedBody', certificate.bodyId) : certificateSource
      put('7', 'doc.point7', { body: certificate.bodyName, bodyNumber: certificate.bodyNumber, certificate: certificate.number }, certificateSource, [
        { field: 'body', value: certificate.bodyName, source: bodySource },
        { field: 'bodyNumber', value: certificate.bodyNumber, source: bodySource },
        { field: 'certificate', value: certificate.number, source: certificateSource },
      ])
    }
  } else if (category === 'CATEGORY_I') {
    put('7', 'doc.point7-category-one', {}, styleSource, [])
  }

  // 8 — the production-phase module under surveillance (category III: typed by a person).
  if (category === 'CATEGORY_III') {
    put('8', 'doc.point8-to-type', {}, source('TO_TYPE'), [])
    if (points.find((point) => point.point === '8')?.source.kind === 'TO_TYPE') {
      warnings.push({ code: 'POINT8_TO_TYPE', point: '8', message: 'Category III PPE: type point 8 (Module C2 or D and the notified body under whose surveillance it is).' })
    }
  } else if (category !== 'NOT_PPE') {
    put('8', 'doc.point8-not-applicable', {}, styleSource, [])
  }

  // 9 — additional information, signed for and on behalf of; the signatory's line (place, day, name, function) is typed
  // in the draft's fields and has no words of its own.
  if (facts.maker) {
    const signatory = facts.signatory
    const makerValue: PointValue = { field: 'maker', value: facts.maker.name, source: facts.maker.source }
    if (signatory.name !== null && signatory.function !== null && signatory.place !== null && signatory.on !== null) {
      const line = `${signatory.place}, ${dayWords(signatory.on, language)}. ${signatory.name}, ${signatory.function}.`
      const before = points.length
      put('9', 'doc.point9', { maker: facts.maker.name }, facts.maker.source, [makerValue, { field: 'signatory', value: line, source: source('TYPED') }])
      const last = points[points.length - 1]
      if (points.length > before && last && last.source.kind !== 'UNTRANSLATED') points[points.length - 1] = { ...last, text: `${last.text}\n${line}` }
    } else {
      warnings.push({ code: 'SIGNATORY_TO_TYPE', point: '9', message: 'The signatory (name, function, place and date of issue) is typed when the DoC is signed.' })
      put('9', 'doc.point9', { maker: facts.maker.name }, facts.maker.source, [makerValue], { key: 'doc.point9-to-sign', values: {} })
    }
  }

  return { language, content: { template: TEMPLATE_ID, points }, blocking, warnings, missingPhrases: [...new Set(missing)] }
}

// ---- typed edits --------------------------------------------------------------------------------------------------------

export interface PointEdit {
  readonly point: string
  readonly text: string
}

/** What is wrong with typed point words (paths under `body/points`). */
export function pointEditProblems(edits: readonly PointEdit[]): Issue[] {
  const problems: Issue[] = []
  const seen = new Set<string>()
  edits.forEach((edit, index) => {
    if (!(POINT_IDS as readonly string[]).includes(edit.point)) problems.push({ path: `body/points/${index}/point`, message: 'An Annex IX point, "1" to "9".' })
    else if (seen.has(edit.point)) problems.push({ path: `body/points/${index}/point`, message: `Point ${edit.point} is given twice.` })
    seen.add(edit.point)
    if (edit.text.trim() === '' || edit.text.length > WORDS_MAX) problems.push({ path: `body/points/${index}/text`, message: `The words: 1 to ${WORDS_MAX} characters.` })
  })
  return problems
}

/** The points with the typed words in place (a point not there yet is added in its place), each TYPED by `userId`. */
export function applyEdits(points: readonly AnnexPoint[], edits: readonly PointEdit[], userId: string | null): AnnexPoint[] {
  const byPoint = new Map(points.map((point) => [point.point, point]))
  for (const edit of edits) {
    const before = byPoint.get(edit.point)
    if (before && before.text === edit.text.trim()) continue
    byPoint.set(edit.point, { point: edit.point, text: edit.text.trim(), source: typedBy(userId), wording: null, values: before?.values ?? [] })
  }
  return [...byPoint.values()].sort((a, b) => a.point.localeCompare(b.point, 'en', { numeric: true }))
}

/** A refresh that keeps the typed points: the fresh composition, with each TYPED point of the draft put back. */
export function keepTyped(fresh: readonly AnnexPoint[], draft: readonly AnnexPoint[]): AnnexPoint[] {
  const typed = new Map(draft.filter((point) => point.source.kind === 'TYPED').map((point) => [point.point, point]))
  const merged = new Map(fresh.map((point) => [point.point, typed.get(point.point) ?? point]))
  for (const [point, value] of typed) if (!merged.has(point)) merged.set(point, value)
  return [...merged.values()].sort((a, b) => a.point.localeCompare(b.point, 'en', { numeric: true }))
}

export interface PointDifference {
  readonly point: string
  readonly stored: string | null
  readonly fresh: string | null
}

/** Where the stored points differ from what the records give now (typed points are the person's: never stale). */
export function differences(stored: readonly AnnexPoint[], fresh: readonly AnnexPoint[]): PointDifference[] {
  const out: PointDifference[] = []
  const all = [...new Set([...stored.map((point) => point.point), ...fresh.map((point) => point.point)])].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  for (const point of all) {
    const before = stored.find((entry) => entry.point === point) ?? null
    const now = fresh.find((entry) => entry.point === point) ?? null
    if (before && (before.source.kind === 'TYPED' || before.source.kind === 'UNTRANSLATED')) continue
    if ((before?.text ?? null) !== (now?.text ?? null)) out.push({ point, stored: before?.text ?? null, fresh: now?.text ?? null })
  }
  return out
}

// ---- reading stored content ----------------------------------------------------------------------------------------------

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

function sourceOf(value: unknown): Source {
  if (!isObject(value) || typeof value.kind !== 'string') return { kind: 'TYPED' }
  return {
    kind: value.kind,
    ...(typeof value.recordType === 'string' ? { recordType: value.recordType } : {}),
    ...(typeof value.recordId === 'string' ? { recordId: value.recordId } : {}),
  }
}

/** The points of a stored content (W1's signed documents have none: an empty list). */
export function contentOf(value: unknown): DeclarationContent {
  if (!isObject(value) || !Array.isArray(value.points)) return { template: TEMPLATE_ID, points: [] }
  const points: AnnexPoint[] = []
  for (const entry of value.points) {
    if (!isObject(entry) || typeof entry.point !== 'string' || typeof entry.text !== 'string') continue
    const wording: Wording | null = isObject(entry.wording) && typeof entry.wording.key === 'string' && (entry.wording.kind === 'PHRASE' || entry.wording.kind === 'TEMPLATE')
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
    points.push({ point: entry.point, text: entry.text, source: sourceOf(entry.source), wording, values })
  }
  return { template: typeof value.template === 'string' ? value.template : TEMPLATE_ID, points }
}

/** The JSON stored in ComplianceDocument.content. */
export const contentJson = (content: DeclarationContent) => ({
  template: content.template,
  points: content.points.map((point) => ({
    point: point.point,
    text: point.text,
    source: { ...point.source },
    ...(point.wording ? { wording: { ...point.wording } } : {}),
    values: (point.values ?? []).map((value) => ({ field: value.field, value: value.value, source: { ...value.source } })),
  })),
})

/** Where a value came from, in words (the SourceIndicator's line). */
export function sourceWords(value: Source, names: Readonly<Record<string, string>> = {}): string {
  const named = value.recordId ? names[value.recordId] : undefined
  switch (value.kind) {
    case 'STYLE':
      return named ? `from style ${named}` : 'from the style'
    case 'STYLE_REVISION':
      return named ? `from revision ${named}` : 'from the style revision'
    case 'OPERATOR':
      return 'from the economic operators (Rules & markets)'
    case 'PARTY':
      return named ? `from ${named}'s registered address` : "from the brand's registered address"
    case 'COMPANY':
      return named ? `from company ${named}` : 'from the company'
    case 'LABEL':
      return named ? `from label template ${named}` : 'from the garment label template'
    case 'CERTIFICATE':
      return named ? `from certificate ${named}` : 'from the certificate'
    case 'NOTIFIED_BODY':
      return named ? `from notified body ${named}` : 'from the notified body register'
    case 'REGISTER':
      return named ? `from the register: ${named}` : 'from the register of laws and standards'
    case 'PHRASE':
      return named ? `from phrase ${named}` : 'from the phrase library'
    case 'TEMPLATE':
      return "from the generator's built-in Annex IX words"
    case 'TYPED':
      return 'typed'
    case 'UNTRANSLATED':
      return "the original's words: to translate"
    case 'TO_TYPE':
      return 'to type'
    default:
      return value.kind.toLowerCase()
  }
}

// ---- translations ------------------------------------------------------------------------------------------------------

export const TRANSLATION_STATES = ['DRAFT', 'IN_TRANSLATION', 'CHECKED'] as const
export type TranslationState = (typeof TRANSLATION_STATES)[number]

/** The state a new translation starts in: DRAFT when the library gave every point, IN_TRANSLATION when words wait. */
export const startingState = (points: readonly AnnexPoint[]): TranslationState => (points.some((point) => point.source.kind === 'UNTRANSLATED' || point.source.kind === 'TO_TYPE') ? 'IN_TRANSLATION' : 'DRAFT')

/** Why a language cannot be added to an original, in words (null: fine). */
export function translationRefusal(input: { readonly originalLanguage: string; readonly language: string; readonly taken: readonly string[] }): { code: string; message: string } | null {
  if (!LANGUAGE.test(input.language)) return { code: 'LANGUAGE', message: `"${input.language}" is not a language code (ISO 639: "de").` }
  if (input.language === input.originalLanguage) return { code: 'SOURCE_LANGUAGE', message: `The original is in ${input.language}.` }
  if (input.taken.includes(input.language)) return { code: 'TAKEN', message: `This revision already has a generated DoC in ${input.language}: open it.` }
  return null
}

/** Why a translation's state cannot move (null: fine). CHECKED is the check's own step. */
export function stateMoveRefusal(from: TranslationState, to: Exclude<TranslationState, 'CHECKED'>): { code: string; message: string } | null {
  if (from === to) return { code: 'SAME_STATE', message: `The translation is ${from} already.` }
  return null
}

/** Why a translation cannot be checked by this person (null: fine). */
export function checkRefusal(input: { readonly status: string; readonly translationState: TranslationState | null; readonly authorId: string | null; readonly checkerId: string; readonly points: readonly AnnexPoint[] }): { code: string; message: string } | null {
  if (input.translationState === null) return { code: 'NOT_A_TRANSLATION', message: 'This is an original: only a translation is checked.' }
  if (input.status !== 'DRAFT') return { code: 'NOT_DRAFT', message: `This translation is ${input.status}: it is checked no more.` }
  if (input.translationState === 'CHECKED') return { code: 'CHECKED', message: 'This translation is checked already.' }
  const open = input.points.filter((point) => point.source.kind === 'UNTRANSLATED' || point.source.kind === 'TO_TYPE').map((point) => point.point)
  if (open.length > 0) return { code: 'WORDS_MISSING', message: `Point${open.length > 1 ? 's' : ''} ${open.join(', ')} still ${open.length > 1 ? 'hold' : 'holds'} the original's words or words to type: type ${open.length > 1 ? 'them' : 'it'} first.` }
  if (input.authorId !== null && input.authorId === input.checkerId) return { code: 'OWN_TRANSLATION', message: 'You started this translation: a second person checks it.' }
  const typists = new Set(input.points.filter((point) => point.source.kind === 'TYPED' && point.source.recordType === 'User' && point.source.recordId).map((point) => point.source.recordId!))
  if (typists.has(input.checkerId)) return { code: 'OWN_WORDS', message: 'You typed words of this translation: a second person checks it.' }
  return null
}

// ---- the draft's own fields ------------------------------------------------------------------------------------------------

export interface DraftFields {
  readonly number?: string | null | undefined
  readonly signedByName?: string | null | undefined
  readonly signedByFunction?: string | null | undefined
  readonly signedPlace?: string | null | undefined
  readonly marketCode?: string | null | undefined
}

/** What is wrong with a draft's typed fields (paths under `body/`). Only the fields given are checked. */
export function draftFieldProblems(fields: DraftFields): Issue[] {
  const problems: Issue[] = []
  const words = (value: string | null | undefined, max: number, path: string, what: string) => {
    if (value !== undefined && value !== null && (value.trim() === '' || value.length > max)) problems.push({ path: `body/${path}`, message: `${what}: 1 to ${max} characters, or none.` })
  }
  words(fields.number, NUMBER_MAX, 'number', 'The number')
  words(fields.signedByName, NAME_MAX, 'signedByName', "The signatory's name")
  words(fields.signedByFunction, NAME_MAX, 'signedByFunction', "The signatory's function")
  words(fields.signedPlace, PLACE_MAX, 'signedPlace', 'The place of issue')
  if (fields.marketCode !== undefined && fields.marketCode !== null && !/^[A-Z]{2}(-[A-Za-z0-9]{1,8})*$/.test(fields.marketCode)) problems.push({ path: 'body/marketCode', message: 'A market code ("DE", "CH"), or none.' })
  return problems
}

/** Why a withdrawal is refused (null: fine): words of 3 to 500 characters. */
export function withdrawRefusal(input: { readonly status: string; readonly reason: string }): { code: string; message: string } | null {
  if (input.status !== 'DRAFT') return { code: 'NOT_DRAFT', message: `This document is ${input.status}: only a generated draft is withdrawn here.` }
  const reason = input.reason.trim()
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) return { code: 'REASON', message: `Say why it is withdrawn: ${REASON_MIN} to ${REASON_MAX} characters.` }
  return null
}
