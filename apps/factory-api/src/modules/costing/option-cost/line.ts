import type { FactoryClient } from '@nexus/factory-db'
import { Decimal } from 'decimal.js'
import { DomainError } from '@nexus/factory-domain/core/errors'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { chosenTotal, optionCosts } from '@nexus/factory-domain/costing/option-cost/rules'
import type { CommandTx } from '../../../core/command'
import { findRevision } from '../../product/bom/store'
import { STYLE_COLUMNS } from '../store'
import { loadGarment, readValueCosts } from './store'

/**
 * A quote or order line's options cost (B-W2b-423; follow-up KS4:01 "An option's own cost joins the line margin on the quote
 * and the order"): the chosen values' own costs (./costs.ts, FIN-018) added up per size of the line, in the line's company,
 * colourway and revision, today. sales/quotes/pricing.ts adds it to the cost of each size of the line (a quote line's cost,
 * cost amount and snapshot; the order copies them when it is made). A size where one of them cannot be known makes the line's
 * cost incomplete (said in words in the snapshot), never a 0.
 */

type Reader = FactoryClient | CommandTx

export interface LineOptionsCost {
  /** Per size: what the options add to one garment; null: not known. */
  readonly bySize: ReadonlyMap<string, Decimal | null>
  /** What the line's cost snapshot keeps of it (a cost-grain column). */
  readonly snapshot: {
    readonly valueIds: readonly string[]
    readonly values: readonly { readonly valueId: string; readonly code: string; readonly bySize: readonly { readonly size: string; readonly total: string | null }[] }[]
    readonly complete: boolean
    readonly missing: readonly string[]
  }
}

/** The values chosen on a quote line (its QuoteLineOption rows). */
export async function quoteLineValues(db: Reader, lineId: string): Promise<string[]> {
  return (await db.quoteLineOption.findMany({ where: { lineId }, select: { valueId: true } })).map((row) => row.valueId)
}

export async function lineOptionsCost(
  db: Reader,
  input: { readonly styleId: string; readonly revisionId: string; readonly companyId: string; readonly currency: string; readonly colourwayId: string; readonly sizes: readonly string[]; readonly valueIds: readonly string[]; readonly on: BusinessDate },
): Promise<LineOptionsCost> {
  const valueIds = [...new Set(input.valueIds)]
  const unknown = (message: string): LineOptionsCost => ({ bySize: new Map(input.sizes.map((size) => [size, null])), snapshot: { valueIds, values: [], complete: false, missing: [message] } })
  const style = await db.style.findUnique({ where: { id: input.styleId }, select: STYLE_COLUMNS })
  if (!style) return unknown('The style could not be read: the options are not costed.')
  try {
    const revision = await findRevision(db, style.id, input.revisionId)
    const { garment } = await loadGarment(db, style, revision, { id: input.companyId, currency: input.currency }, input.on, { colourwayId: input.colourwayId }, valueIds)
    const values = await readValueCosts(db, valueIds)
    const costs = optionCosts(garment, values)
    const sizes = input.sizes.filter((size) => style.sizes.includes(size))
    const totals = chosenTotal(costs.values, valueIds, sizes)
    const missing = [...new Set(costs.values.flatMap((cost) => cost.missing))]
    return {
      bySize: new Map(input.sizes.map((size) => [size, totals.get(size) == null ? null : new Decimal(totals.get(size)!)])),
      snapshot: {
        valueIds,
        values: costs.values.map((cost) => ({ valueId: cost.valueId, code: values.find((value) => value.id === cost.valueId)?.code ?? '?', bySize: cost.bySize.filter((entry) => sizes.includes(entry.size)).map((entry) => ({ size: entry.size, total: entry.total })) })),
        complete: input.sizes.every((size) => totals.get(size) != null),
        missing,
      },
    }
  } catch (error) {
    // A colourway no longer active, a revision gone: the line keeps its cost unknown, in words (never a 500 in a recompute).
    if (error instanceof DomainError) return unknown(`The options are not costed: ${error.message}`)
    throw error
  }
}
