import type { Issue } from '@nexus/factory-domain/core/errors'
import { exchangeSizeProblems, type ExchangeFacts } from '@nexus/factory-domain/sales/returns-outcomes/rules'
import type { ReturnDisposition } from '@nexus/factory-domain/sales/returns/rules'
import type { LineRow, Reader, SoldFacts } from '../returns/store'

/**
 * The size exchange's facts (B-W2b-346; SAL-351): the size that came back and the style's size range (Style.sizes, the
 * SKU matrix's sizes). W2a's decision (`returns/decide.ts` planDecisions) asks `exchangeProblemsFor` for every line it
 * decides: a SIZE_EXCHANGE names another size of the style; no other disposition names one.
 */

/** The size ranges of these styles (id → sizes in the range's order). */
export async function styleSizesOf(db: Reader, styleIds: readonly string[]): Promise<Map<string, string[]>> {
  const ids = [...new Set(styleIds)]
  if (ids.length === 0) return new Map()
  const rows = await db.style.findMany({ where: { id: { in: ids } }, select: { id: true, sizes: true } })
  return new Map(rows.map((row) => [row.id, [...row.sizes]]))
}

export const exchangeFactsOf = (line: Pick<LineRow, 'seq' | 'size'>, sold: SoldFacts | undefined, sizes: ReadonlyMap<string, readonly string[]>): ExchangeFacts => ({
  seq: line.seq,
  size: sold?.orderLine ? line.size : null,
  sizes: sold?.orderLine ? (sizes.get(sold.orderLine.styleId) ?? null) : null,
})

/** The problems of a decision's exchange size, and the size it writes (null unless a SIZE_EXCHANGE). */
export async function exchangeProblemsFor(db: Reader, line: Pick<LineRow, 'seq' | 'size'>, sold: SoldFacts | undefined, disposition: ReturnDisposition, exchangeSize: string | null | undefined, at: string): Promise<{ problems: Issue[]; size: string | null }> {
  const asked = (exchangeSize ?? '').trim()
  if (disposition !== 'SIZE_EXCHANGE') return { problems: asked === '' ? [] : [{ path: `${at}/exchangeSize`, message: 'Only a size exchange names another size.' }], size: null }
  const sizes = await styleSizesOf(db, sold?.orderLine ? [sold.orderLine.styleId] : [])
  const problems = exchangeSizeProblems(exchangeFactsOf(line, sold, sizes), asked, `${at}/exchangeSize`)
  return { problems, size: problems.length === 0 ? asked : null }
}
