/**
 * Reviews › Insights — fit by size, in words (Phase 3, PR J): the Themes fit table and the product pop-up (Summary
 * "Size fit", Sizes tab). Pure, tested in fitView.vitest.test.ts. The numbers and verdicts are the API's
 * (`apps/api/src/services/reviews/review-fit.ts`): a size gets a verdict only from 5 fit mentions (reviews that say how
 * it fits, returns marked "too small" / "too large"); below that it is "Too few", never a verdict.
 */

// ── The API's answer ────────────────────────────────────────────────

export type FitVerdict = 'small' | 'true' | 'large' | 'mixed' | 'too_few'

export interface FitCell {
  size: string
  total: number
  small: number
  true: number
  large: number
  reviews: number
  returns: number
  verdict: FitVerdict
  shares: { small: number; true: number; large: number } | null
  share: number | null
  words: string
}

export type FitTableCell = FitCell | { size: string; verdict: 'not_sold' }

export interface FitFamilyRow {
  familyId: string
  name: string
  sku: string
  signals: number
  reviews: number
  returns: number
  noSize: number
  cells: FitTableCell[]
  advice: string
}

export interface FitTable {
  sizes: string[]
  families: FitFamilyRow[]
  moreFamilies: number
  summary: { reviews: number; returns: number; unclearReturns: number; noSize: number; minimum: number }
  words: string
}

export interface ProductFit {
  family: { id: string; name: string }
  sizes: FitCell[]
  variants: Array<FitCell & { productId: string; label: string }>
  reviews: number
  returns: number
  unclearReturns: number
  noSize: number
  advice: string
  words: string
  minimum: number
}

// ── Words ───────────────────────────────────────────────────────────

export type FitTone = 'warning' | 'success' | 'info' | 'neutral'

export interface FitPillView {
  text: string
  tone: FitTone
  /** The line under the pill: what the verdict rests on. */
  note: string
  /** The whole verdict in words (hover, screen readers). */
  words: string
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString('en-IE')} ${n === 1 ? one : many}`

/** "9 reviews, 3 returns"; "1 review"; "nothing yet". */
export function fitBasis(c: Pick<FitCell, 'reviews' | 'returns'>): string {
  const parts = [c.reviews ? count(c.reviews, 'review', 'reviews') : null, c.returns ? count(c.returns, 'return', 'returns') : null].filter(Boolean)
  return parts.length ? parts.join(', ') : 'nothing yet'
}

/** One cell of the Themes table: "Runs small 58%" over "of 12 · 9 reviews, 3 returns"; "Too few" over "3 of 5 needed". */
export function fitPill(cell: FitTableCell, minimum = 5): FitPillView {
  if (cell.verdict === 'not_sold') return { text: 'Not sold', tone: 'neutral', note: `no ${cell.size} in this family`, words: `This family sells no size ${cell.size}.` }
  const of = `of ${cell.total} · ${fitBasis(cell)}`
  if (cell.verdict === 'too_few') return { text: 'Too few', tone: 'neutral', note: `${cell.total} of ${minimum} needed`, words: cell.words }
  if (cell.verdict === 'mixed') return { text: 'Mixed', tone: 'neutral', note: of, words: cell.words }
  const share = cell.share ?? 0
  if (cell.verdict === 'small') return { text: `Runs small ${share}%`, tone: 'warning', note: of, words: cell.words }
  if (cell.verdict === 'large') return { text: `Runs large ${share}%`, tone: 'info', note: of, words: cell.words }
  return { text: `True to size ${share}%`, tone: 'success', note: of, words: cell.words }
}

/** The pop-up's Verdict column (the product-detail board): what to do, or why there is no verdict. */
export function fitVerdictPill(cell: FitCell, minimum = 5): { text: string; tone: FitTone; note: string | null } {
  if (cell.verdict === 'too_few') return { text: 'Too few', tone: 'neutral', note: `${cell.total} of ${minimum} needed` }
  if (cell.verdict === 'mixed') return { text: 'Buyers disagree', tone: 'neutral', note: null }
  if (cell.verdict === 'small') return { text: 'Order one size up', tone: 'warning', note: null }
  if (cell.verdict === 'large') return { text: 'Order one size down', tone: 'info', note: null }
  return { text: 'True to size', tone: 'success', note: null }
}

/** A direction's share of one size, or null below the minimum (no bar, no number). */
export function fitShare(cell: FitCell, direction: 'small' | 'true' | 'large'): number | null {
  return cell.shares ? cell.shares[direction] : null
}

/** "12 fit mentions" under a family's name (placed ones only), with the ones that name no size. */
export function familyMentions(row: Pick<FitFamilyRow, 'signals' | 'noSize'>): string {
  const base = count(row.signals, 'fit mention', 'fit mentions')
  return row.noSize ? `${base} · ${row.noSize} ${row.noSize === 1 ? 'names' : 'name'} no size` : base
}

/** "from 79 reviews and 34 returns that mention fit" (the pop-up's Size fit header). */
export function fitHeaderWords(fit: Pick<ProductFit, 'reviews' | 'returns'>): string {
  if (fit.reviews + fit.returns === 0) return 'no review or return says how it fits yet'
  return `from ${count(fit.reviews, 'review', 'reviews')} and ${count(fit.returns, 'return', 'returns')} that mention fit`
}

/** The Sizes tab's count: fit mentions placed on a size. */
export function fitMentions(fit: Pick<ProductFit, 'reviews' | 'returns'> | null | undefined): number | null {
  return fit ? fit.reviews + fit.returns : null
}

/** Under the Themes table: what it rests on, and the families that did not fit. */
export function fitTableFootnote(table: Pick<FitTable, 'words' | 'moreFamilies'>): string {
  if (!table.moreFamilies) return table.words
  return `${table.words} ${count(table.moreFamilies, 'more family has', 'more families have')} fewer fit mentions and ${table.moreFamilies === 1 ? 'is' : 'are'} not shown.`
}
