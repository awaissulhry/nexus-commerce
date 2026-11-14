import { ForbiddenError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import type { MtmCostBody, MtmCostView } from '@nexus/factory-domain/costing/mtm-cost/contracts'
import { alterationProblems, alterationSteps, mtmCostOf, scaledLines, type Alteration, type MtmCostRefusal } from '@nexus/factory-domain/costing/mtm-cost/rules'
import { chosenTotal, configured, optionCosts } from '@nexus/factory-domain/costing/option-cost/rules'
import { componentsOf } from '@nexus/factory-domain/costing/sheet-components/components'
import { COMPONENT_REFUSAL_WORDS } from '@nexus/factory-domain/costing/sheet-components/rules'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { notStartedProblem } from '@nexus/factory-domain/sales/mtm/rules'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { findRevision, readColourways } from '../../product/bom/store'
import { checkMeasures } from '../../product/mtm-rules/check'
import { loadGarment, readValueCosts } from '../option-cost/store'
import { refused } from '../sheet-components/refusals'
import { companyFor, readStyleFor } from '../store'

/**
 * POST /costing/made-to-measure/cost (B-W2b-423; FIN-017): one made-to-measure unit costed from its measures and options, read
 * only. B-W2b-248's one check (`checkMeasures`: the template, the base size the measures point to or the one typed, the BOM lines
 * scaled to the rider's measures, the certificate for the colourway) gives the base size and the unit's quantities; the cost is
 * B-W2b-418's components of the garment without options at the base size, the scaled lines' extra material, the alteration
 * minutes typed (per kind of work centre, at its rate and overhead) and the unit's options at their own cost (./option-cost).
 *
 * GATE-MTM: refused in words (409 MTM_NOT_STARTED) while made-to-measure has not started for the style's template (the style
 * flagged, its template's rules on), exactly as a quote's unit is. Permissions: costing.view over the style's company (the
 * company asked for a tenant-wide style), and what the check asks — product.styles.view, sales.measurements.view over the
 * profile's customer (body measures are personal data), product.bom.view for the scaled lines. No measure is answered back.
 */

const notCosted = (code: MtmCostRefusal, words: string) => refused(code, words)
const invalid = (issues: Issue[]): ValidationError => new ValidationError(issues.length === 1 ? issues[0]!.message : 'The unit cannot be costed like this.', issues)

export async function unitCost(caller: CommandCaller, body: MtmCostBody): Promise<MtmCostView> {
  const issues: Issue[] = []
  if ((body.measurementProfileId === undefined) === (body.measurements === undefined)) issues.push({ path: 'body/measurements', message: 'Send the measures, or name a measurement profile: one of the two.' })
  const alterations: Alteration[] = (body.alterations ?? []).map((entry) => ({ workCentreKind: entry.workCentreKind, minutes: entry.minutes }))
  issues.push(...alterationProblems(alterations).map((issue) => ({ path: `body/${issue.path}`, message: issue.message })))
  if (issues.length > 0) throw invalid(issues)
  const style = await readStyleFor(caller, body.styleId)
  const company = await companyFor(caller, style, body.companyId, 'body/companyId')
  if (company.id === null) throw new ValidationError(COMPONENT_REFUSAL_WORDS.NO_COMPANY, [{ path: 'body/companyId', message: COMPONENT_REFUSAL_WORDS.NO_COMPANY }])
  const companyId = company.id
  const now = serverClock.now()
  const on = businessDate(now)

  // The colourway costed and checked: the one named, else the style's first active one.
  const colourways = await caller.withClient((db) => readColourways(db, style.id))
  const colourway = body.colourwayId === undefined ? colourways.find((entry) => entry.status === 'ACTIVE') : colourways.find((entry) => entry.id === body.colourwayId && entry.status === 'ACTIVE')
  if (!colourway) throw invalid([{ path: 'body/colourwayId', message: body.colourwayId === undefined ? 'The style has no active colourway to cost.' : 'Not an active colourway of this style.' }])

  // GATE-MTM: made to measure only where it has started (the style's own template, its rules on).
  const flags = await caller.withClient((db) => db.style.findUniqueOrThrow({ where: { id: style.id }, select: { mtmAllowed: true, measurementTemplate: { select: { code: true, rulesOn: true } } } }))
  const check = await checkMeasures(caller, {
    styleId: style.id,
    ...(body.measurementProfileId ? { measurementProfileId: body.measurementProfileId } : {}),
    ...(body.measurements ? { measurements: body.measurements } : {}),
    ...(body.baseSize ? { baseSize: body.baseSize } : {}),
    colourwayId: colourway.id,
    ...(body.revisionId ? { revisionId: body.revisionId } : {}),
  })
  const notStarted = notStartedProblem({ style: { code: style.code, mtmAllowed: flags.mtmAllowed }, template: flags.measurementTemplate, garmentType: check.profile?.garmentType ?? null })
  if (notStarted) throw notCosted('MTM_NOT_STARTED', notStarted)
  if (check.consumptionHidden) throw new ForbiddenError("The unit's extra material reads the BOM: it needs product.bom.view.")
  const revisionRef = check.style?.revision ?? null
  if (!revisionRef) throw notCosted('NO_REVISION', `${style.code} has no revision to cost.`)
  const baseSize = check.baseSize.used
  if (baseSize === null) throw notCosted('NO_BASE_SIZE', 'No base size: type one, or measure the points its base size rule reads.')

  return caller.withClient(async (db) => {
    const revision = await findRevision(db, style.id, revisionRef.id)
    const valueIds = [...new Set(body.optionValueIds ?? [])]
    const { loaded, garment } = await loadGarment(db, style, revision, { id: companyId, currency: company.currency }, on, { colourwayId: colourway.id, piecesPerCarton: body.piecesPerCarton }, valueIds)
    const base = configured(garment, new Set()).facts
    const rows = check.consumption ?? []
    const scaled = scaledLines(base.lines, rows, baseSize)
    const scaledFacts = { ...base, lines: scaled.lines }
    const alteredFacts = { ...scaledFacts, steps: [...scaledFacts.steps, ...alterationSteps(alterations)] }
    const values = await readValueCosts(db, valueIds)
    const offered = new Set((await db.styleOptionGroup.findMany({ where: { styleId: style.id, status: 'ACTIVE' }, select: { groupId: true } })).map((row) => row.groupId))
    const outside = values.filter((value) => !offered.has(value.groupId))
    if (values.length !== valueIds.length || outside.length > 0) throw invalid([{ path: 'body/optionValueIds', message: 'Options of the groups the style offers.' }])
    const costs = valueIds.length === 0 ? null : optionCosts(garment, values)
    const optionTotal = costs === null ? undefined : (chosenTotal(costs.values, valueIds, [baseSize]).get(baseSize) ?? null)
    const result = mtmCostOf({
      sizes: base.sizes,
      baseSize,
      base: componentsOf(base),
      scaled: componentsOf(scaledFacts),
      altered: componentsOf(alteredFacts),
      options: optionTotal,
      optionMissing: costs?.values.flatMap((cost) => cost.missing) ?? [],
    })
    return {
      style: { id: style.id, code: style.code, name: style.name },
      revision: { id: revision.id, revision: revision.revision, status: revision.status },
      template: { id: check.template.id, code: check.template.code, rulesOn: check.template.rulesOn },
      companyId,
      currency: company.currency,
      on,
      colourway: loaded.colourway,
      baseSize: { size: baseSize, how: check.baseSize.typed !== null ? 'TYPED' : (check.baseSize.how ?? 'SUGGESTED') },
      scaled: rows.filter((row) => row.scaled !== null).map((row) => ({ lineId: row.lineId, seq: row.seq, itemCode: row.item.code, uom: row.uom, baseQty: row.baseQty, unitQty: row.unitQty, detail: row.detail })),
      alterations,
      options: (costs?.values ?? []).map((cost) => {
        const value = values.find((entry) => entry.id === cost.valueId)!
        return { valueId: value.id, code: value.code, name: value.name, atBaseSize: asMoney('cost', cost.bySize.find((entry) => entry.size === baseSize)?.total ?? null) }
      }),
      breakdown: {
        base: asMoney('cost', result.base),
        extraMaterial: asMoney('cost', result.extraMaterial),
        alteration: asMoney('cost', result.alteration),
        options: asMoney('cost', result.options),
        total: asMoney('cost', result.total),
      },
      complete: result.complete,
      missing: [...result.missing],
      holds: check.blocks.map((finding) => finding.message),
      notes: [...check.notes, ...(scaled.scaled === 0 ? ['No BOM line scales with the measures: the unit takes the base size’s quantities.'] : [])],
      computedAt: toUtcIso(now),
    }
  })
}
