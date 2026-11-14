import type { FactoryClient } from '@nexus/factory-db'
import type { OptionParts } from '@nexus/factory-domain/costing/option-cost/rules'
import type { CommandTx } from '../../../core/command'

/**
 * A revision's parts only for options (B-W2b-423; FIN-018): its BOM lines for one option value (B-W2b-211 optionValueId) and its
 * routing steps only for some values (B-W2b-225 appliesToOptionValueIds). The cost sheet is the garment without options: the
 * components (B-W2b-418's loadComponentFacts) leave these out; the option's own cost (./costs.ts) puts them back per value.
 */
export async function optionPartsOf(db: FactoryClient | CommandTx, revisionId: string): Promise<OptionParts> {
  const lines = await db.bomLine.findMany({ where: { revisionId, optionValueId: { not: null } }, select: { id: true, optionValueId: true } })
  const steps = await db.routingOperation.findMany({ where: { revisionId, NOT: { appliesToOptionValueIds: { isEmpty: true } } }, select: { id: true, appliesToOptionValueIds: true } })
  return {
    lines: new Map(lines.map((line) => [line.id, line.optionValueId!])),
    steps: new Map(steps.map((step) => [step.id, [...step.appliesToOptionValueIds]])),
  }
}

/** The facts without the option-only parts (the garment without options). */
export function withoutOptionParts<Line extends { readonly id: string }, Step extends { readonly id: string }>(parts: OptionParts, lines: readonly Line[], steps: readonly Step[]): { lines: Line[]; steps: Step[] } {
  return { lines: lines.filter((line) => !parts.lines.has(line.id)), steps: steps.filter((step) => !parts.steps.has(step.id)) }
}
