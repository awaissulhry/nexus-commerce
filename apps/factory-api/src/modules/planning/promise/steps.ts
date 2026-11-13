import { ValidationError } from '@nexus/factory-domain/core/errors'
import { offeredValuesOf } from '../../product/options/offers'
import type { Reader } from '../store'

/**
 * Only the steps a cell is for, in promises (B-W2b-365; follow-up of B-W2b-F40; B-W2b-225's PRD-128). The capable-to-promise
 * walk (./engine `stepsFor`) already counts a step only for some sizes or colourways on those garments only; a step only for
 * some options counts when the garment asked has one of them (product/routing-depth `stepIsFor`), else it is left out of the
 * walk, as a work order's release leaves it out:
 *
 *   quote line     the options chosen on it (QuoteLineOption)
 *   order line     the options chosen on it (SalesOrderLineOption; planned-orders/steps `lineOptionsOf`)
 *   calculator     the options asked (`optionValueIds`: active values of groups the style offers); none: a garment without
 *                  options, so a step only for options is not counted
 */

/** The options chosen on each quote line. */
export async function quoteLineOptionsOf(db: Reader, lineIds: readonly string[]): Promise<Map<string, string[]>> {
  const ids = [...new Set(lineIds)]
  if (ids.length === 0) return new Map()
  const rows = await db.quoteLineOption.findMany({ where: { lineId: { in: ids } }, select: { lineId: true, valueId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const out = new Map<string, string[]>()
  for (const row of rows) {
    const values = out.get(row.lineId) ?? []
    if (!values.includes(row.valueId)) values.push(row.valueId)
    out.set(row.lineId, values)
  }
  return out
}

/** The calculator's options: each once, each an active value of a group the style offers (refused in words otherwise). */
export async function askedOptions(db: Reader, styleId: string, asked: readonly string[] | undefined): Promise<string[]> {
  if (!asked || asked.length === 0) return []
  const offered = new Set((await offeredValuesOf(db, styleId)).map((value) => value.id))
  const problems = asked.flatMap((valueId, index) =>
    asked.indexOf(valueId) !== index
      ? [{ path: `body/optionValueIds/${index}`, message: 'This option is named twice.' }]
      : offered.has(valueId)
        ? []
        : [{ path: `body/optionValueIds/${index}`, message: 'Not an option the style offers (an active option of a group offered on the style).' }],
  )
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  return [...asked]
}

/** The routing steps a garment with these options gets: a step only for some options when one of them is chosen. */
export const stepsForOptions = <Step extends { readonly appliesToOptionValueIds: readonly string[] }>(routing: readonly Step[], optionValueIds: readonly string[] | null | undefined): Step[] =>
  routing.filter((step) => step.appliesToOptionValueIds.length === 0 || step.appliesToOptionValueIds.some((valueId) => (optionValueIds ?? []).includes(valueId)))
