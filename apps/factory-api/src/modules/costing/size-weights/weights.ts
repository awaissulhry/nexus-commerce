import { Decimal } from 'decimal.js'
import { ForbiddenError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { isCurrencyCode } from '@nexus/factory-domain/core/money'
import { COSTING_SHEETS_MANAGE } from '@nexus/factory-domain/costing/sheet-components/permissions'
import type { PutSizeWeightsBody, SizeWeightsQuery } from '@nexus/factory-domain/costing/size-weights/contracts'
import { normalWeights, sizeSurcharges, sizeWeightKey, SURCHARGE_FROM_PCT, weightedCost, weightsProblems } from '@nexus/factory-domain/costing/size-weights/rules'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { contextOf } from '../../product/bom/store'
import { mayWrite } from '../../product/materials/store'
import { refused } from '../sheet-versions/refusals'
import { costsOf, linesOf, readSheetFor, splitView, textOrNull, weightSourceOf, weightsFor, type Reader } from '../sheet-versions/store'
import { readStyleFor } from '../store'

/**
 * Size weights and the cost by size (B-W2b-420; FIN-016; design products.styles › Cost "Cost by size"): a style's size mix per
 * season or for every season (read with costing.view, kept with costing.sheets.manage over the style's company — every
 * company's style without a season: a grant over every company), and a version's cost per size with its weighted cost and
 * the surcharges suggested for the big sizes (a suggestion: the style's surcharges are sales' PUT
 * /sales/styles/:styleId/size-surcharges). A weight is no money; costs need the cost grain, a price surcharge the price grain.
 */

const text = (value: { toString(): string }): string => decimalText(value.toString())

async function setsOf(db: Reader, styleId: string) {
  const rows = await db.sizeWeight.findMany({ where: { styleId }, select: { id: true, seasonId: true, size: true, weight: true }, orderBy: [{ seasonId: 'asc' }, { size: 'asc' }] })
  const seasonIds = [...new Set(rows.flatMap((row) => (row.seasonId ? [row.seasonId] : [])))]
  const seasons = seasonIds.length === 0 ? [] : await db.season.findMany({ where: { id: { in: seasonIds } }, select: { id: true, code: true, status: true } })
  return { rows, seasons }
}

/** GET /costing/size-weights?styleId[&seasonId] — the style's size mixes, and the one in force for the season asked. */
export async function sizeWeights(caller: CommandCaller, query: SizeWeightsQuery) {
  const style = await readStyleFor(caller, query.styleId)
  return caller.withClient(async (db) => {
    const { rows, seasons } = await setsOf(db, style.id)
    const keys = [...new Set(rows.map((row) => row.seasonId))]
    const sets = keys.map((seasonId) => {
      const weights = normalWeights(Object.fromEntries(rows.filter((row) => row.seasonId === seasonId).map((row) => [row.size, text(row.weight)])), style.sizes)
      const season = seasonId ? seasons.find((row) => row.id === seasonId) : undefined
      return { seasonId, season: season ? { code: season.code, status: season.status } : null, weights, shares: [...weightedCost([], weights).shares] }
    })
    const inForce = query.seasonId ? await weightsFor(db, style, query.seasonId, null) : null
    return {
      style: { id: style.id, code: style.code, name: style.name, companyId: style.companyId, sizes: [...style.sizes] },
      sets,
      inForce: inForce && inForce.weights ? { seasonId: inForce.source === 'SEASON' ? query.seasonId! : null, source: inForce.source, weights: inForce.weights } : null,
    }
  })
}

/**
 * costing.setSizeWeights — PUT /costing/size-weights: a style's size mix for a season (or every season) set as sent (sizes
 * left out removed; empty: cleared). A version keeps the weights it was made with until it is told to read them again.
 */
export async function setSizeWeights(caller: CommandCaller, body: PutSizeWeightsBody, idempotencyKey?: string) {
  const context = contextOf(caller)
  const style = await readStyleFor(caller, body.styleId)
  const season = body.seasonId ? await caller.withClient((db) => db.season.findUnique({ where: { id: body.seasonId! }, select: { id: true, companyId: true } })) : null
  if (body.seasonId && (!season || (style.companyId !== null && season.companyId !== style.companyId))) throw new ValidationError("Not a season of the style's company.", [{ path: 'body/seasonId', message: "Expected a season of the style's company." }])
  if (!mayWrite(actorOf(context), COSTING_SHEETS_MANAGE, style.companyId ?? season?.companyId ?? null)) throw new ForbiddenError(style.companyId === null && season === null ? "Every company's size mix is kept only by a role over every company." : undefined)
  const issues = Object.keys(body.weights).length === 0 ? [] : weightsProblems(body.weights, style.sizes)
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  const wanted = normalWeights(body.weights, style.sizes)
  const seasonId = body.seasonId
  const { result } = await command(caller, { name: 'costing.setSizeWeights', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const tenantId = 'tenantId' in tools.context ? tools.context.tenantId : ''
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.size-weights', ${tenantId}::text, ${style.id}::text, ${seasonId ?? 'all'}::text), 0))`
    const rows = await tx.sizeWeight.findMany({ where: { styleId: style.id, seasonId }, select: { id: true, size: true, weight: true } })
    const before = normalWeights(Object.fromEntries(rows.map((row) => [row.size, text(row.weight)])), style.sizes)
    const gone = rows.filter((row) => wanted[row.size] === undefined)
    const changed = rows.filter((row) => wanted[row.size] !== undefined && !new Decimal(wanted[row.size]!).equals(row.weight.toString()))
    const added = Object.keys(wanted).filter((size) => !rows.some((row) => row.size === size))
    if (gone.length === 0 && changed.length === 0 && added.length === 0) throw refused('NOTHING_CHANGES')
    if (gone.length > 0) await tx.sizeWeight.deleteMany({ where: { id: { in: gone.map((row) => row.id) } } })
    for (const row of changed) await tx.sizeWeight.update({ where: { id: row.id }, data: { weight: wanted[row.size]!, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
    if (added.length > 0) {
      await tx.sizeWeight.createMany({ data: added.map((size) => ({ id: newId(), styleId: style.id, seasonId, key: sizeWeightKey(style.id, seasonId, size), size, weight: wanted[size]!, createdAt: now, updatedAt: now, createdById })) })
    }
    tools.audit({ recordType: 'Style', recordId: style.id, companyId: style.companyId ?? season?.companyId ?? null, before: { seasonId, weights: before }, after: { seasonId, weights: wanted } })
    tools.emit({ type: 'size_weights.changed', subject: style.id, companyId: style.companyId ?? season?.companyId ?? null, payload: { styleId: style.id, seasonId, sizes: Object.keys(wanted).length } })
    return { styleId: style.id }
  })
  return result
}

/** GET /costing/cost-sheets/:sheetId/by-size — a version's cost per size, its weighted cost and the surcharges suggested. */
export async function costBySize(caller: CommandCaller, sheetId: string) {
  const sheet = await readSheetFor(caller, sheetId)
  return caller.withClient(async (db) => {
    const style = await db.style.findUniqueOrThrow({ where: { id: sheet.styleId }, select: { sizes: true } })
    const lines = await linesOf(db, sheet.id)
    const { split, weights, weighted, baseCost } = costsOf(sheet, lines, style.sizes)
    const currency = isCurrencyCode(sheet.currency) ? sheet.currency : 'EUR'
    const suggested = sizeSurcharges({ totals: split, sizes: style.sizes, baseSize: sheet.baseSize, targetMarginPct: textOrNull(sheet.targetMarginPct), currency })
    const current = suggested.length === 0 ? [] : await db.sizeSurcharge.findMany({ where: { styleId: sheet.styleId, versionId: null, size: { in: suggested.map((row) => row.size) } }, select: { size: true, surchargeAmount: true, currency: true, surchargePct: true } })
    const words =
      baseCost === null
        ? `The base size ${sheet.baseSize} misses an input: no surcharge is suggested until its cost is complete.`
        : suggested.length === 0
          ? `No size after the base size ${sheet.baseSize} costs ${SURCHARGE_FROM_PCT} % or more above it: no surcharge is suggested.`
          : `${suggested.length === 1 ? '1 size costs' : `${suggested.length} sizes cost`} ${SURCHARGE_FROM_PCT} % or more above the base size ${sheet.baseSize}: a surcharge is suggested${sheet.targetMarginPct === null ? ' (give the version a target margin to see the price surcharge that keeps it)' : ''}.`
    return {
      sheet: { id: sheet.id, sheetVersion: sheet.sheetVersion, state: sheet.state, currency: sheet.currency, baseSize: sheet.baseSize, styleId: sheet.styleId },
      sizes: [...style.sizes],
      baseSize: sheet.baseSize,
      split: splitView(split),
      weights: { source: weightSourceOf(sheet.inputs), weights, shares: [...weighted.shares], weighted: asMoney('cost', weighted.weighted), missing: [...weighted.missing] },
      fromPct: SURCHARGE_FROM_PCT,
      surcharges: suggested.map((row) => {
        const now = current.find((entry) => entry.size === row.size)
        return {
          size: row.size,
          extraCost: asMoney('cost', row.extraCost),
          extraPct: asMoney('cost', row.extraPct),
          priceSurcharge: asMoney('price', row.priceSurcharge),
          current: now ? { amount: asMoney('price', textOrNull(now.surchargeAmount)), currency: now.currency, pct: asMoney('price', textOrNull(now.surchargePct)) } : null,
        }
      }),
      words,
    }
  })
}
