import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { isCurrencyCode } from '@nexus/factory-domain/core/money'
import type { GoalSeekQuery } from '@nexus/factory-domain/costing/goal-seek/contracts'
import { GOAL_WORDS, goalLinesOf, goalSeek, type GoalBasis } from '@nexus/factory-domain/costing/goal-seek/rules'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { contextOf } from '../../product/bom/store'
import { costsOf, linesOf, readSheetFor, textOrNull } from '../sheet-versions/store'

/**
 * Target price and goal-seek (B-W2b-420; FIN-013; design products.styles › Cost "Target price"): GET
 * /costing/cost-sheets/:sheetId/goal-seek — a version's cost at a basis (the weighted cost of its size mix, the base size's or
 * one size's) against a target price and margin (the ones asked, else the version's own): the allowed cost, the gap and the
 * biggest lines with the cut each needs. Reads only (costing.view). A target the caller may not see is not used: the version's
 * target price needs the price grain, its margin the margin grain (the answer says so in `held`). The target is kept on a
 * draft with PATCH /costing/cost-sheets/:sheetId.
 */

export async function goalSeekOf(caller: CommandCaller, sheetId: string, query: GoalSeekQuery) {
  const grains = heldGrains(actorOf(contextOf(caller)))
  const sheet = await readSheetFor(caller, sheetId)
  return caller.withClient(async (db) => {
    const style = await db.style.findUniqueOrThrow({ where: { id: sheet.styleId }, select: { sizes: true } })
    const lines = await linesOf(db, sheet.id)
    const { split, weights, weighted } = costsOf(sheet, lines, style.sizes)
    const kind: GoalBasis = query.basis ?? (weights ? 'WEIGHTED' : 'BASE_SIZE')
    if (kind === 'WEIGHTED' && !weights) throw new ValidationError('This version keeps no size mix: read the base size or one size.', [{ path: 'querystring/basis', message: 'No size mix on this version.' }])
    const size = kind === 'SIZE' ? (query.size ?? '') : kind === 'BASE_SIZE' ? sheet.baseSize : null
    if (kind === 'SIZE' && !style.sizes.includes(size ?? '')) throw new ValidationError("Say a size of the style's range.", [{ path: 'querystring/size', message: "Expected a size of the style's range." }])
    const cost = size === null ? weighted.weighted : (split.find((entry) => entry.size === size)?.total ?? null)
    const ownPrice = grains.has('price') ? textOrNull(sheet.targetPrice) : null
    const ownMargin = grains.has('margin') ? textOrNull(sheet.targetMarginPct) : null
    const targetPrice = query.targetPrice ?? ownPrice
    const targetMarginPct = query.targetMarginPct ?? ownMargin
    const held = [
      sheet.targetPrice !== null && !grains.has('price') && query.targetPrice === undefined ? "The version's target price needs the price grain: it is not used." : null,
      sheet.targetMarginPct !== null && !grains.has('margin') && query.targetMarginPct === undefined ? "The version's target margin needs the margin grain: it is not used." : null,
    ].filter((entry): entry is string => entry !== null)
    const at = size === null ? { weights: weights! } : { size }
    const result = goalSeek({
      cost,
      targetPrice,
      targetMarginPct,
      currency: isCurrencyCode(sheet.currency) ? sheet.currency : 'EUR',
      lines: goalLinesOf(lines, at),
    })
    const asked = query.targetPrice !== undefined || query.targetMarginPct !== undefined
    return {
      sheet: { id: sheet.id, sheetVersion: sheet.sheetVersion, state: sheet.state, currency: sheet.currency, baseSize: sheet.baseSize },
      basis: { kind, size },
      target: { price: asMoney('price', targetPrice), marginPct: asMoney('margin', targetMarginPct), from: asked ? ('ASKED' as const) : targetPrice !== null || targetMarginPct !== null ? ('SHEET' as const) : ('NONE' as const) },
      cost: asMoney('cost', cost),
      allowedCost: asMoney('cost', result.allowedCost),
      gap: asMoney('cost', result.gap),
      marginAtCost: asMoney('margin', result.marginAtCost),
      priceForMargin: asMoney('price', result.priceForMargin),
      state: result.state,
      lines: result.lines.map((line) => ({
        lineId: line.id,
        seq: line.seq,
        category: line.category,
        label: line.label,
        cost: asMoney('cost', line.cost),
        sharePct: asMoney('cost', line.sharePct),
        cutAlonePct: asMoney('cost', line.cutAlonePct),
        cutShared: asMoney('cost', line.cutShared),
      })),
      words: GOAL_WORDS[result.state],
      held: held.length === 0 ? null : held.join(' '),
    }
  })
}
