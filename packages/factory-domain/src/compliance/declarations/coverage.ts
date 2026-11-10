/**
 * Language coverage of declarations and user information (B-W2b-257; PRD-293, PRD-351; design compliance.declarations ›
 * Language coverage, tiles), pure. Rows: each PPE style × kind (DoC, user information); columns: the languages the
 * switched-on markets need (MarketProfile.docLanguages for the DoC, userInfoLanguages for the leaflet); a cell says what the
 * style's CURRENT revision (the newest released one, else the newest) has in that language: ISSUED (the signed document in
 * force), DRAFT (a draft: a generated one or a signed one waiting for its PDF), IN_TRANSLATION (a generated translation not
 * checked yet), CHECKED (a generated translation checked: still a draft until GATE-PPE-TEXTS), MISSING, or NOT_NEEDED (no
 * market of the style's company needs it).
 */

export const CELL_STATES = ['ISSUED', 'DRAFT', 'IN_TRANSLATION', 'CHECKED', 'MISSING', 'NOT_NEEDED'] as const
export type CoverageState = (typeof CELL_STATES)[number]
export const COVERAGE_KINDS = ['DECLARATION_OF_CONFORMITY', 'USER_INFORMATION'] as const
export type CoverageKind = (typeof COVERAGE_KINDS)[number]

export interface CoverageStyle {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly companyId: string | null
  /** The current revision's number (null: none). */
  readonly revision: number | null
}

export interface CoverageDocument {
  readonly id: string
  readonly styleId: string
  readonly kind: CoverageKind
  readonly language: string
  readonly revision: number
  readonly status: string
  readonly origin: 'SIGNED' | 'GENERATED'
  readonly translationStatus: string | null
  /** W1's: the signed PDF is confirmed (an issued document always has one). */
  readonly hasFile: boolean
}

export interface CoverageMarket {
  readonly code: string
  readonly companyId: string | null
  readonly docLanguages: readonly string[]
  readonly userInfoLanguages: readonly string[]
}

export interface CoverageCell {
  readonly language: string
  readonly state: CoverageState
  readonly documentId: string | null
  readonly revision: number | null
  readonly markets: readonly string[]
}

export interface CoverageRow {
  readonly style: CoverageStyle
  readonly kind: CoverageKind
  readonly cells: readonly CoverageCell[]
}

const RANK: Readonly<Record<CoverageState, number>> = { ISSUED: 5, CHECKED: 4, DRAFT: 3, IN_TRANSLATION: 2, MISSING: 1, NOT_NEEDED: 0 }

function stateOf(document: CoverageDocument): CoverageState | null {
  if (document.status === 'ISSUED' && document.origin === 'SIGNED') return 'ISSUED'
  if (document.status !== 'DRAFT') return null
  if (document.origin === 'GENERATED' && document.translationStatus === 'IN_TRANSLATION') return 'IN_TRANSLATION'
  if (document.origin === 'GENERATED' && document.translationStatus === 'CHECKED') return 'CHECKED'
  return 'DRAFT'
}

/** The markets that apply to a style: those of its company and those of every company. */
const marketsOf = (style: CoverageStyle, markets: readonly CoverageMarket[]) => markets.filter((market) => market.companyId === null || style.companyId === null || market.companyId === style.companyId)

/** The language matrix (columns in market order, then alphabetical) and its rows. */
export function coverageMatrix(styles: readonly CoverageStyle[], documents: readonly CoverageDocument[], markets: readonly CoverageMarket[]): { languages: string[]; rows: CoverageRow[] } {
  const languages: string[] = []
  for (const market of markets) for (const language of [...market.docLanguages, ...market.userInfoLanguages]) if (!languages.includes(language)) languages.push(language)
  const rows: CoverageRow[] = []
  for (const style of styles) {
    const applying = marketsOf(style, markets)
    for (const kind of COVERAGE_KINDS) {
      const cells = languages.map((language): CoverageCell => {
        const needing = applying.filter((market) => (kind === 'DECLARATION_OF_CONFORMITY' ? market.docLanguages : market.userInfoLanguages).includes(language)).map((market) => market.code)
        let best: { state: CoverageState; document: CoverageDocument } | null = null
        for (const document of documents) {
          if (document.styleId !== style.id || document.kind !== kind || document.language !== language || document.revision !== style.revision) continue
          const state = stateOf(document)
          if (state && (!best || RANK[state] > RANK[best.state])) best = { state, document }
        }
        if (best) return { language, state: best.state, documentId: best.document.id, revision: best.document.revision, markets: needing }
        return { language, state: needing.length > 0 ? 'MISSING' : 'NOT_NEEDED', documentId: null, revision: null, markets: needing }
      })
      rows.push({ style, kind, cells })
    }
  }
  return { languages, rows }
}

/** The tiles' counts (the design's "Issued", "Drafts", "Languages missing for markets sold"). */
export function coverageCounts(rows: readonly CoverageRow[], documents: readonly CoverageDocument[]): { issued: number; drafts: number; languagesMissing: number } {
  return {
    issued: documents.filter((document) => document.status === 'ISSUED').length,
    drafts: documents.filter((document) => document.status === 'DRAFT').length,
    languagesMissing: rows.reduce((sum, row) => sum + row.cells.filter((cell) => cell.state === 'MISSING').length, 0),
  }
}
