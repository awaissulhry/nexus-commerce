import { LANGUAGE_CODE, type ReasonWords } from '../../reasons/rules'

/**
 * The defect vocabulary read in the person's language (B-W2b-90; QHS-007; design floor.reasons "Icons and photos first,
 * words second" and "One code, shown in each worker's language, read in the office's own"), pure. The defect library,
 * the cause codes and the leather grades keep ONE code each, with Italian and English words and the words of the other
 * floor languages (Site.floorLocales); a picker shows each code in the language of the person reading it:
 *
 *   language   the one asked (`?language=`, an ISO 639 code), else the person's own (the worker's on the floor, the
 *              user's in the office), else Italian;
 *   words      the words of that language; a code with none in it shows its English words and says so (`missing`), so
 *              the office sees what to fill (the coverage below) and a tile never shows nothing;
 *   coverage   per floor language the tenant's sites read, the active codes of each list with no words in it.
 *
 * The events of the two new lists (quality.vocabulary_changed) name the list and the change with these values.
 */

/** The lists the vocabulary event names (the defect library keeps its own event, quality.defects_changed). */
export const VOCABULARY_LISTS = ['CAUSES', 'GRADES'] as const
export type VocabularyList = (typeof VOCABULARY_LISTS)[number]

export const VOCABULARY_CHANGES = ['CREATED', 'EDITED', 'RETIRED', 'REACTIVATED', 'DELETED', 'STARTER_ADDED'] as const
export type VocabularyChange = (typeof VOCABULARY_CHANGES)[number]

/** The lists the coverage counts. */
export const COVERAGE_LISTS = ['DEFECTS', 'CAUSES', 'GRADES'] as const
export type CoverageList = (typeof COVERAGE_LISTS)[number]

export interface Worded {
  readonly labelIt: string
  readonly labelEn: string
  readonly labelI18n?: ReasonWords | null | undefined
}

export interface WordsIn {
  /** The words shown. */
  readonly label: string
  /** The language of those words (the one asked, or English when it has none). */
  readonly language: string
  /** The code has no words in the language asked: its English words stand in. */
  readonly missing: boolean
}

/** The words of a code in a language (Italian, English, else the other languages), else its English words. */
export function wordsIn(row: Worded, language: string): WordsIn {
  if (language === 'it') return { label: row.labelIt, language: 'it', missing: false }
  if (language === 'en') return { label: row.labelEn, language: 'en', missing: false }
  const words = row.labelI18n?.[language]
  return words !== undefined && words.trim() !== '' ? { label: words, language, missing: false } : { label: row.labelEn, language: 'en', missing: true }
}

/** The language a picker answers in: the one asked when it is an ISO 639 code, else the person's, else Italian. */
export function languageOf(asked: string | null | undefined, personal: string | null | undefined): string {
  if (asked && LANGUAGE_CODE.test(asked)) return asked
  if (personal && LANGUAGE_CODE.test(personal)) return personal
  return 'it'
}

/** The tenant's other floor languages: every site's floorLocales but Italian and English, once each, sorted. */
export function otherFloorLanguages(sites: readonly { readonly floorLocales: readonly string[] }[]): string[] {
  return [...new Set(sites.flatMap((site) => site.floorLocales))].filter((language) => language !== 'it' && language !== 'en' && LANGUAGE_CODE.test(language)).sort()
}

/** The other floor languages a code has no words in. */
export function missingLanguages(row: Pick<Worded, 'labelI18n'>, languages: readonly string[]): string[] {
  return languages.filter((language) => language !== 'it' && language !== 'en' && !(row.labelI18n?.[language]?.trim()))
}

export interface CoverageRow extends Pick<Worded, 'labelI18n'> {
  readonly code: string
  readonly active: boolean
}

export interface LanguageCoverage {
  readonly language: string
  /** How many sites read it. */
  readonly sites: number
  /** The active codes of each list with no words in it, in the list's order. */
  readonly missing: Record<CoverageList, string[]>
  /** Every active code has words in it. */
  readonly complete: boolean
}

/**
 * Per other floor language of the tenant's sites: the active codes of each list with no words in it. Italian and English
 * are always complete (every code has both: the database's rule) and are not listed.
 */
export function coverageOf(lists: Readonly<Record<CoverageList, readonly CoverageRow[]>>, sites: readonly { readonly floorLocales: readonly string[] }[]): LanguageCoverage[] {
  return otherFloorLanguages(sites).map((language) => {
    const missing = Object.fromEntries(COVERAGE_LISTS.map((list) => [list, lists[list].filter((row) => row.active && missingLanguages(row, [language]).length > 0).map((row) => row.code)])) as Record<CoverageList, string[]>
    return {
      language,
      sites: sites.filter((site) => site.floorLocales.includes(language)).length,
      missing,
      complete: COVERAGE_LISTS.every((list) => missing[list].length === 0),
    }
  })
}
