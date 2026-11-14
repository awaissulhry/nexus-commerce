import { Decimal } from 'decimal.js'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { costingCurrency, pickRate } from '@nexus/factory-domain/costing/inputs'
import type { GroupCostsQuery, GroupCostsView, SetValueDeltaBody, StyleOptionCostsQuery, StyleOptionCostsView, ValueDeltaView } from '@nexus/factory-domain/costing/option-cost/contracts'
import { optionCosts, typedDeltaProblems } from '@nexus/factory-domain/costing/option-cost/rules'
import { COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import { COSTING_SHEETS_MANAGE } from '@nexus/factory-domain/costing/sheet-components/permissions'
import { COMPONENT_REFUSAL_WORDS, six } from '@nexus/factory-domain/costing/sheet-components/rules'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { effectWords } from '@nexus/factory-domain/product/options/rules'
import { baseFactor, decimalText } from '@nexus/factory-domain/product/units/units'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { contextOf, findRevision } from '../../product/bom/store'
import { mayWrite } from '../../product/materials/store'
import { bumpValue, effectFactsOf, lockGroupShared, readEffects, valueIn } from '../../product/options/store'
import { processCostingInputs } from '../inputs'
import { refused } from '../sheet-components/refusals'
import { companyFor, readCostingMaterials, readStyleFor } from '../store'
import { loadGarment, offeredValues, readEffectOperations, readValueCosts, VALUE_COST_COLUMNS } from './store'

/**
 * An option's own cost (B-W2b-423; FIN-018; design products.options › Price & BOM effects "Cost delta (cost)", and the
 * configurator's margin "with these options", KS4:01):
 *
 *   GET /costing/styles/:styleId/option-costs            what each value the style offers adds to one garment of each size,
 *                                                        against the garment without options (costing.view)
 *   GET /costing/option-groups/:groupId/costs            the library's view of a group (the Effects tab): what can be costed
 *                                                        without a style — the typed material delta, materials added per
 *                                                        garment, operations and minutes at an operation; the rest is said to
 *                                                        depend on the style (costing.view)
 *   PUT /costing/option-groups/:groupId/values/:valueId/cost   a value's typed material delta (with its currency) and minutes
 *                                                        delta, or none (costing.sheets.manage + the cost grain)
 *
 * Reads check costing.view over the style's or the group's company; the write costing.sheets.manage over the group's company
 * (a tenant-wide group: a grant over every company). Figures are money.cost.
 */

const text = (value: { toString(): string }): string => decimalText(value.toString())
const WORDS = Object.freeze({
  it: "Il costo proprio di ogni opzione su un capo della taglia, rispetto al capo senza opzioni: le sue righe di distinta, gli effetti della libreria, le sue fasi, i minuti; un delta scritto sull'opzione prende il posto della parte calcolata.",
  en: 'Each option’s own cost on one garment of the size, against the garment without options: its BOM lines, the library’s effects, its own steps, its minutes; a delta typed on the option takes the place of the part worked out.',
})

/** The revision costed: the one named (of the style), else the released one, else the newest draft. */
async function revisionOf(db: Parameters<typeof findRevision>[0], styleId: string, revisionId: string | undefined) {
  if (revisionId !== undefined) return findRevision(db, styleId, revisionId)
  const released = await db.styleRevision.findFirst({ where: { styleId, status: 'RELEASED' }, select: { id: true }, orderBy: { revision: 'desc' } })
  const draft = released ? null : await db.styleRevision.findFirst({ where: { styleId, status: 'DRAFT' }, select: { id: true }, orderBy: { revision: 'desc' } })
  const id = released?.id ?? draft?.id
  if (!id) throw new NotFoundError('The style has no revision to cost.')
  return findRevision(db, styleId, id)
}

/** GET /costing/styles/:styleId/option-costs */
export async function styleOptionCosts(caller: CommandCaller, styleId: string, query: StyleOptionCostsQuery): Promise<StyleOptionCostsView> {
  const style = await readStyleFor(caller, styleId)
  const company = await companyFor(caller, style, query.companyId, 'querystring/companyId')
  if (company.id === null) throw new ValidationError(COMPONENT_REFUSAL_WORDS.NO_COMPANY, [{ path: 'querystring/companyId', message: COMPONENT_REFUSAL_WORDS.NO_COMPANY }])
  const companyId = company.id
  const now = serverClock.now()
  const on = businessDate(now)
  return caller.withClient(async (db) => {
    const revision = await revisionOf(db, styleId, query.revisionId)
    const { values, groups } = await offeredValues(db, style.id)
    const { loaded, garment } = await loadGarment(db, style, revision, { id: companyId, currency: company.currency }, on, { colourwayId: query.colourwayId }, values.map((value) => value.id))
    const costs = optionCosts(garment, values)
    const baseSize = style.baseSize ?? style.sizes[0] ?? null
    return {
      style: { id: style.id, code: style.code, name: style.name, companyId: style.companyId, baseSize: style.baseSize },
      revision: { id: revision.id, revision: revision.revision, status: revision.status },
      companyId,
      currency: company.currency,
      on,
      colourway: loaded.colourway,
      sizes: [...style.sizes],
      values: costs.values.map((cost) => {
        const value = values.find((entry) => entry.id === cost.valueId)!
        const group = groups.get(value.groupId)
        return {
          valueId: value.id,
          groupId: value.groupId,
          groupCode: group?.code ?? '?',
          code: value.code,
          name: value.name,
          status: value.status,
          material: { source: cost.material.source, typed: asMoney('cost', cost.material.typed), currency: cost.material.currency },
          making: { ...cost.making },
          bySize: cost.bySize.map((entry) => ({ size: entry.size, material: asMoney('cost', entry.material), making: asMoney('cost', entry.making), total: asMoney('cost', entry.total) })),
          atBaseSize: asMoney('cost', cost.bySize.find((entry) => entry.size === baseSize)?.total ?? null),
          complete: cost.complete,
          missing: [...cost.missing],
        }
      }),
      words: { ...WORDS },
      computedAt: toUtcIso(now),
    }
  })
}

const GROUP_COLUMNS = { id: true, code: true, name: true, companyId: true } as const

/** GET /costing/option-groups/:groupId/costs — the library's view: what can be costed without a style. */
export async function groupOptionCosts(caller: CommandCaller, groupId: string, query: GroupCostsQuery): Promise<GroupCostsView> {
  const actor = actorOf(contextOf(caller))
  const group = isUuid(groupId) ? await caller.withClient((db) => db.optionGroup.findUnique({ where: { id: groupId }, select: GROUP_COLUMNS })) : null
  if (!group || !can(actor, COSTING_VIEW, { companyId: group.companyId })) throw new NotFoundError('Option group not found.')
  if (group.companyId !== null && query.companyId !== undefined && query.companyId !== group.companyId) {
    throw new ValidationError('The group belongs to one company.', [{ path: 'querystring/companyId', message: "This group belongs to one company: its options are costed with that company's rates." }])
  }
  const companyId = group.companyId ?? query.companyId ?? null
  if (companyId !== null && !can(actor, COSTING_VIEW, { companyId })) throw new NotFoundError('Company not found.')
  const now = serverClock.now()
  const on = businessDate(now)
  return caller.withClient(async (db) => {
    const companyRow = companyId === null ? null : await db.company.findUnique({ where: { id: companyId }, select: { currency: true } })
    if (companyId !== null && !companyRow) throw new NotFoundError('Company not found.')
    const currency = costingCurrency(companyRow?.currency ?? null)
    const valueIds = (await db.optionValue.findMany({ where: { groupId: group.id }, select: { id: true } })).map((row) => row.id)
    const values = await readValueCosts(db, valueIds)
    const effects = (await readEffects(db, valueIds)).map(effectFactsOf)
    const operations = await readEffectOperations(db, effects.flatMap((effect) => (effect.operationId ? [effect.operationId] : [])))
    const materials = await readCostingMaterials(db, effects.flatMap((effect) => (effect.itemId ? [effect.itemId] : [])))
    const rates = await processCostingInputs().labourRates(db, companyId)
    const code = (itemId: string | null) => (itemId ? (materials.get(itemId)?.code ?? '?') : null)
    const minutesCost = (kind: Parameters<typeof pickRate>[1], minutes: string): Decimal | null => {
      const rate = pickRate(rates, kind, companyId, on)
      if (rate === null || rate.currency !== currency || !new Decimal(rate.plannedEfficiencyPct).gt(0)) return null
      return new Decimal(minutes).times(rate.costPerMinute).div(new Decimal(rate.plannedEfficiencyPct).div(100))
    }
    return {
      group: { id: group.id, code: group.code, name: group.name, companyId: group.companyId },
      companyId,
      currency,
      on,
      values: values.map((value) => {
        const rows = effects
          .filter((effect) => effect.valueId === value.id && effect.kind !== 'PRICE' && effect.kind !== 'CERTIFICATE')
          .map((effect) => {
            const operation = effect.operationId ? operations.get(effect.operationId) : undefined
            let amount: Decimal | null = null
            let onStyle = false
            let minutes: string | null = null
            if (effect.kind === 'BOM_ADD') {
              const material = effect.itemId ? materials.get(effect.itemId) : undefined
              const factor = material && effect.uom ? baseFactor(effect.uom as Parameters<typeof baseFactor>[0], material.units) : null
              if (effect.sizeQuantities !== null || effect.qty === null) onStyle = true
              else if (material && material.standardCost !== null && material.currency === currency && factor !== null) amount = new Decimal(effect.qty).times(factor).times(material.standardCost)
            } else if (effect.kind === 'OPERATION_ADD' || (effect.kind === 'MINUTES' && operation)) {
              minutes = effect.kind === 'OPERATION_ADD' ? (effect.minutes ?? operation?.standardMinutes ?? null) : effect.minutes
              amount = operation && minutes !== null ? minutesCost(operation.workCentreKind, minutes) : null
            } else {
              onStyle = true
              minutes = effect.kind === 'MINUTES' ? effect.minutes : null
            }
            return {
              effectId: effect.id,
              kind: effect.kind,
              amount: asMoney('cost', amount === null ? null : six(amount)),
              minutes,
              onStyle,
              words: { ...effectWords(effect, { item: code(effect.itemId), target: code(effect.targetItemId), operation: operation?.code ?? null }) },
              _amount: amount,
            }
          })
        const materialRows = rows.filter((row) => row.kind === 'BOM_ADD' && !row.onStyle)
        const minuteRows = rows.filter((row) => row.kind === 'OPERATION_ADD' || (row.kind === 'MINUTES' && !row.onStyle))
        const sum = (list: typeof rows): Decimal | null => (list.some((row) => row._amount === null) ? null : list.reduce((total, row) => total.plus(row._amount ?? 0), new Decimal(0)))
        const material = value.materialDelta !== null ? (value.materialDeltaCurrency === currency ? new Decimal(value.materialDelta) : null) : sum(materialRows)
        const making = value.minutesDelta !== null ? new Decimal(0) : sum(minuteRows)
        const dependsOnStyle = value.minutesDelta !== null || rows.some((row) => row.onStyle && (value.materialDelta === null || (row.kind !== 'BOM_REPLACE' && row.kind !== 'BOM_REMOVE' && row.kind !== 'BOM_ADD')))
        return {
          valueId: value.id,
          code: value.code,
          name: value.name,
          status: value.status,
          version: value.version,
          typed: { materialDelta: asMoney('cost', value.materialDelta), materialDeltaCurrency: value.materialDeltaCurrency, minutesDelta: value.minutesDelta },
          effects: rows.map(({ _amount: _ignored, ...row }) => row),
          known: asMoney('cost', material === null || making === null ? null : six(material.plus(making))),
          dependsOnStyle,
          words: dependsOnStyle
            ? { it: 'Una parte si calcola solo su uno stile (righe sostituite o tolte, minuti sul capo, i minuti scritti): vedi i costi delle opzioni dello stile.', en: 'Part of it is costed only on a style (lines replaced or left out, minutes on the garment, the typed minutes): see the style’s option costs.' }
            : { it: 'Tutto il costo proprio si conosce senza uno stile.', en: 'Its whole own cost is known without a style.' },
        }
      }),
    }
  })
}

/** costing.setOptionValueDelta — PUT /costing/option-groups/:groupId/values/:valueId/cost */
export async function setValueDelta(caller: CommandCaller, groupId: string, valueId: string, body: SetValueDeltaBody, idempotencyKey?: string): Promise<ValueDeltaView> {
  const actor = actorOf(contextOf(caller))
  const seen = isUuid(groupId) ? await caller.withClient((db) => db.optionGroup.findUnique({ where: { id: groupId }, select: GROUP_COLUMNS })) : null
  if (!seen || !can(actor, COSTING_VIEW, { companyId: seen.companyId })) throw new NotFoundError('Option group not found.')
  if (!mayWrite(actor, COSTING_SHEETS_MANAGE, seen.companyId)) throw new ForbiddenError(seen.companyId === null ? "An option of every company's library is costed only by a role over every company." : undefined)
  if (!heldGrains(actor).has('cost')) throw new ForbiddenError('A cost delta is a cost: it needs the cost grain.')
  const materialDelta = body.materialDelta === null || body.materialDelta === undefined ? null : decimalText(body.materialDelta)
  const minutesDelta = body.minutesDelta === null ? null : decimalText(body.minutesDelta)
  const problems = typedDeltaProblems({ materialDelta, materialDeltaCurrency: body.materialDeltaCurrency, minutesDelta })
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The cost delta is not valid.', problems.map((issue) => ({ path: `body/${issue.path}`, message: issue.message })))
  const { result } = await command(caller, { name: 'costing.setOptionValueDelta', idempotencyKey, input: { groupId, valueId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const group = await lockGroupShared(tx, groupId)
    const value = await valueIn(tx, groupId, valueId)
    if (group.status === 'ARCHIVED' || value.status === 'ARCHIVED') throw refused('ARCHIVED', `Option ${value.code} (or its group) is archived: restore it before costing it.`)
    const before = await tx.optionValue.findUniqueOrThrow({ where: { id: valueId }, select: VALUE_COST_COLUMNS })
    const was = { materialDelta: before.materialDelta === null ? null : text(before.materialDelta), materialDeltaCurrency: before.materialDeltaCurrency, minutesDelta: before.minutesDelta === null ? null : text(before.minutesDelta) }
    const parts: ('material' | 'minutes')[] = []
    if (was.materialDelta !== materialDelta || was.materialDeltaCurrency !== body.materialDeltaCurrency) parts.push('material')
    if (was.minutesDelta !== minutesDelta) parts.push('minutes')
    if (parts.length === 0) throw refused('NOTHING_CHANGES', COMPONENT_REFUSAL_WORDS.NOTHING_CHANGES)
    const version = await bumpValue(tx, groupId, valueId, body.version, now)
    await tx.optionValue.update({ where: { id: valueId }, data: { materialDelta, materialDeltaCurrency: body.materialDeltaCurrency, minutesDelta, updatedAt: now }, select: { id: true } })
    tools.audit({
      recordType: 'OptionValue',
      recordId: valueId,
      companyId: group.companyId,
      before: { materialDelta: markMoney('cost', was.materialDelta), materialDeltaCurrency: was.materialDeltaCurrency, minutesDelta: was.minutesDelta },
      after: { materialDelta: markMoney('cost', materialDelta), materialDeltaCurrency: body.materialDeltaCurrency, minutesDelta },
    })
    tools.emit({ type: 'option_value.delta_changed', subject: valueId, companyId: group.companyId, payload: { groupId, valueId, parts } })
    return { value: { id: valueId, groupId, code: value.code, version, materialDelta: asMoney('cost', materialDelta), materialDeltaCurrency: body.materialDeltaCurrency, minutesDelta } }
  })
  return result as ValueDeltaView
}
