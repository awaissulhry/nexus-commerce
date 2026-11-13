import { ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { effectivePicks } from '@nexus/factory-domain/product/options/rules'
import type { Reader } from '../../production/work-orders/store'

/**
 * The configuration a sample round samples (B-W2b-365; follow-up of B-W2b-F40; B-W2b-225's PRD-128 "Only for sizes, colours
 * or options"). A sample work order's cells carry the option values of the configuration sampled
 * (WorkOrderSize.optionValueIds), so its release copies a routing step only for some options when the sample has one of them,
 * as an order's work order does (B-W2b-340):
 *
 *   on order lines      each cell takes the options chosen on its order line (W1's create, production/work-orders: the
 *                       line's picks travel; none is named here)
 *   without a line      B-W2b-284's internal or uncharged round: the options named when the work order is made
 *                       (`optionValueIds`: active values of groups the style offers, each once, at most a group's
 *                       maximum); every cell of the work order carries them. None named: no option (a step only for
 *                       options is left out of its release)
 *
 * GET …/work-order-options lists the style's offered groups (`withoutLine.options`) for the dialog.
 */

export interface SampleOptionGroup {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly minPicks: number
  /** null: as many as it has. */
  readonly maxPicks: number | null
  readonly defaultValueId: string | null
  readonly values: { readonly id: string; readonly code: string; readonly name: string }[]
}

/** The groups the style offers now (ACTIVE offers of ACTIVE groups), in the style's order, with their active values. */
export async function sampleOptionGroups(db: Reader, styleId: string): Promise<SampleOptionGroup[]> {
  const offers = await db.styleOptionGroup.findMany({ where: { styleId, status: 'ACTIVE' }, select: { groupId: true, minPicks: true, maxPicks: true, defaultValueId: true }, orderBy: [{ seq: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] })
  if (offers.length === 0) return []
  const groupIds = offers.map((offer) => offer.groupId)
  const groups = new Map((await db.optionGroup.findMany({ where: { id: { in: groupIds }, status: 'ACTIVE' }, select: { id: true, code: true, name: true, minPicks: true, maxPicks: true } })).map((group) => [group.id, group]))
  const values = await db.optionValue.findMany({ where: { groupId: { in: groupIds }, status: 'ACTIVE' }, select: { id: true, groupId: true, code: true, name: true }, orderBy: [{ seq: 'asc' }, { code: 'asc' }] })
  return offers.flatMap((offer) => {
    const group = groups.get(offer.groupId)
    if (!group) return []
    const picks = effectivePicks(group, offer)
    return [{ id: group.id, code: group.code, name: group.name, minPicks: picks.minPicks, maxPicks: picks.maxPicks, defaultValueId: offer.defaultValueId, values: values.filter((value) => value.groupId === group.id).map(({ id, code, name }) => ({ id, code, name })) }]
  })
}

/** The configuration named for a sample work order without an order line: checked against the style's offer (refused in words). */
export async function sampleOptionValues(db: Reader, styleId: string, asked: readonly string[] | undefined, path: string): Promise<string[]> {
  if (!asked || asked.length === 0) return []
  const groups = await sampleOptionGroups(db, styleId)
  const groupOf = new Map(groups.flatMap((group) => group.values.map((value) => [value.id, group] as const)))
  const problems: Issue[] = []
  asked.forEach((valueId, index) => {
    if (asked.indexOf(valueId) !== index) problems.push({ path: `${path}/${index}`, message: 'This option is named twice.' })
    else if (!groupOf.has(valueId)) problems.push({ path: `${path}/${index}`, message: 'Not an option the style offers (an active option of a group offered on the style).' })
  })
  for (const group of groups) {
    const named = asked.filter((valueId, index) => asked.indexOf(valueId) === index && groupOf.get(valueId) === group).length
    if (group.maxPicks !== null && named > group.maxPicks) problems.push({ path, message: `${group.code} takes ${group.maxPicks} option${group.maxPicks === 1 ? '' : 's'} at most (${named} named).` })
  }
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  return [...asked]
}
