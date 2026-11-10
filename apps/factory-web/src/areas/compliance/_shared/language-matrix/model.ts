/**
 * LanguageMatrix (design part "LanguageMatrix (new)", an area part of Compliance: Rules & markets › Markets, and the
 * Declarations' language coverage), pure: which language each market needs for which document — the label, the declaration
 * of conformity, the user information — and, per language, how many phrases of the library print in it (approved for the
 * current source words, or the source itself). The data is B-W2b-249's `GET /compliance/rules/markets(/languages)` matrix.
 */

export const MATRIX_DOCUMENTS = ['LABEL', 'DOC', 'USER_INFO'] as const
export type MatrixDocument = (typeof MATRIX_DOCUMENTS)[number]

export interface MatrixMarket {
  readonly code: string
  readonly name: string
  readonly switchedOn: boolean
  readonly needs: readonly { readonly language: string; readonly documents: readonly MatrixDocument[] }[]
}

export interface MatrixData {
  readonly languages: readonly string[]
  readonly markets: readonly MatrixMarket[]
}

/** Per language, the phrases that print in it (ready), wait for a second person (proposed), are stale or missing. */
export interface MatrixCoverage {
  readonly language: string
  readonly inLibrary: number
  readonly ready: number
  readonly proposed: number
  readonly stale: number
  readonly missing: number
}

/** The documents a market needs in a language (empty: none). */
export function documentsOf(market: MatrixMarket, language: string): MatrixDocument[] {
  const need = market.needs.find((entry) => entry.language === language)
  return need ? MATRIX_DOCUMENTS.filter((document) => need.documents.includes(document)) : []
}

/** How many switched-on markets need a language for any document. */
export const marketsNeeding = (data: MatrixData, language: string): number => data.markets.filter((market) => market.switchedOn && documentsOf(market, language).length > 0).length

/** A language's coverage state: every phrase prints (complete), some wait (partial), some are missing or stale (missing). */
export function coverageState(coverage: MatrixCoverage | undefined): 'none' | 'complete' | 'partial' | 'missing' {
  if (!coverage || coverage.inLibrary === 0) return 'none'
  if (coverage.missing > 0 || coverage.stale > 0) return 'missing'
  if (coverage.ready < coverage.inLibrary) return 'partial'
  return 'complete'
}

/** The languages shown: those a switched-on market needs first (the API's order), the rest after. */
export function shownLanguages(data: MatrixData, onlySwitchedOn: boolean): string[] {
  return data.languages.filter((language) => !onlySwitchedOn || marketsNeeding(data, language) > 0)
}
