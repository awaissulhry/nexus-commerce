/**
 * P0 #27 / MCP full control T4 — the business's glossary (TerminologyPreference): the words to use and the words to
 * avoid, per brand, marketplace and language ("Giacca", not "Giubbotto").
 *
 *   listTerminology    the rows `GET /api/terminology` lists (moved here from the route, answer unchanged), and what
 *                      Claude's content-guidelines tool reads
 *   effectiveGlossary  the rows that apply to one brand: most specific wins
 *   glossaryHits       the avoid words a new text contains, for a change tool's preview
 *
 * Brand voice (tone, not words) is its sister: brand-voice.service.ts.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'

export interface TerminologyFilter {
  /** Omitted or `*`: every brand. A brand: its own rows and the all-brand defaults. `__none__`: the defaults only. */
  brand?: string
  marketplace?: string
  /** Not a filter of the route; Claude's tool narrows to one language with it. */
  language?: string
}

/** The glossary rows for a filter, in the route's order: marketplace, then brand (defaults last), then preferred word. */
export async function listTerminology(filter: TerminologyFilter = {}) {
  const { brand, marketplace, language } = filter
  const where: Prisma.TerminologyPreferenceWhereInput = {}
  if (marketplace) {
    where.marketplace = marketplace.toUpperCase()
  }
  if (language) {
    where.language = language.toLowerCase()
  }
  if (brand === '__none__') {
    where.brand = null
  } else if (brand && brand !== '*') {
    // Brand specified — include both brand-specific and defaults
    // (defaults apply to all brands in the marketplace).
    where.OR = [{ brand }, { brand: null }]
  }
  return prisma.terminologyPreference.findMany({
    where,
    orderBy: [{ marketplace: 'asc' }, { brand: 'asc' }, { preferred: 'asc' }],
  })
}

export interface GlossaryRow {
  brand: string | null
  marketplace: string
  language: string
  preferred: string
  avoid: string[]
  context: string | null
}

const fold = (word: string) => word.trim().toLocaleLowerCase()
const place = (row: Pick<GlossaryRow, 'marketplace' | 'language'>) => `${row.marketplace.toUpperCase()}|${row.language.toLowerCase()}`

/**
 * The rows that apply to `brand`, most specific first and most specific winning, per marketplace + language:
 *   · a brand's own row about a preferred word replaces the all-brand row about the same word;
 *   · a word the brand's own rows prefer is never an avoid word for it, whatever an all-brand row says.
 * With no brand, every row stands as stored (each names its brand).
 */
export function effectiveGlossary<T extends GlossaryRow>(rows: readonly T[], brand?: string | null): T[] {
  if (!brand) return [...rows]
  const own = rows.filter((row) => row.brand === brand)
  const ownPreferred = new Set(own.map((row) => `${place(row)}|${fold(row.preferred)}`))
  const defaults = rows
    .filter((row) => row.brand == null && !ownPreferred.has(`${place(row)}|${fold(row.preferred)}`))
    .map((row) => ({ ...row, avoid: row.avoid.filter((word) => !ownPreferred.has(`${place(row)}|${fold(word)}`)) }))
  return [...own, ...defaults]
}

export interface GlossaryHit {
  /** The avoid word, as the glossary writes it. */
  avoid: string
  /** What the glossary says to use instead. */
  use: string
  context: string | null
  brand: string | null
  marketplace: string
  language: string
}

const escaped = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The glossary's avoid words found in `text` (a text or a list of texts), as whole words in any case — "Giubbotto" is
 * found in "giubbotto in pelle", not in "Giubbottone". Pass the rows that apply (effectiveGlossary). One hit per
 * avoid word and row.
 */
export function glossaryHits(text: string | readonly string[], rows: readonly GlossaryRow[]): GlossaryHit[] {
  const haystack = (Array.isArray(text) ? text : [text]).filter((part): part is string => typeof part === 'string').join('\n')
  if (!haystack.trim()) return []
  const hits: GlossaryHit[] = []
  for (const row of rows) {
    for (const word of new Set(row.avoid.map((w) => w.trim()).filter(Boolean))) {
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped(word)}(?![\\p{L}\\p{N}])`, 'iu')
      if (pattern.test(haystack)) {
        hits.push({ avoid: word, use: row.preferred, context: row.context, brand: row.brand, marketplace: row.marketplace, language: row.language })
      }
    }
  }
  return hits
}
