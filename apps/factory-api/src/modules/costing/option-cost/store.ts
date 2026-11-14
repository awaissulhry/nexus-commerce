import type { FactoryClient } from '@nexus/factory-db'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { EffectOperation, GarmentWithOptions, OptionValueCostFacts } from '@nexus/factory-domain/costing/option-cost/rules'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import type { CommandTx } from '../../../core/command'
import type { RevisionRow } from '../../product/bom/store'
import { effectFactsOf, readEffects } from '../../product/options/store'
import { loadComponentFacts, type ComponentCompany, type ComponentOptions, type LoadedComponents } from '../sheet-components/store'
import { readCostingMaterials, type CostingStyleRow } from '../store'

/**
 * What an option's own cost is computed from (B-W2b-423; FIN-018), read with one client, one query after another: the
 * components' facts with every line and step (B-W2b-418's loader with `withOptionParts`: the option-only ones too, each
 * sub-assembly rolled up), the values' typed deltas (office columns: the floor's grant leaves materialDelta out), their library
 * effects (B-W2b-229), the operations those effects name and the materials they put in. Reads only.
 */

type Reader = FactoryClient | CommandTx
const text = (value: { toString(): string }): string => decimalText(value.toString())

/** An option value's office columns (never selected for the floor). */
export const VALUE_COST_COLUMNS = { id: true, groupId: true, code: true, name: true, status: true, version: true, materialDelta: true, materialDeltaCurrency: true, minutesDelta: true } as const

export interface ValueCostRow extends OptionValueCostFacts {
  readonly status: 'ACTIVE' | 'ARCHIVED'
  readonly version: number
}

export async function readValueCosts(db: Reader, valueIds: readonly string[]): Promise<ValueCostRow[]> {
  if (valueIds.length === 0) return []
  const rows = await db.optionValue.findMany({ where: { id: { in: [...new Set(valueIds)] } }, select: VALUE_COST_COLUMNS, orderBy: [{ seq: 'asc' }, { code: 'asc' }] })
  return rows.map((row) => ({
    id: row.id,
    groupId: row.groupId,
    code: row.code,
    name: row.name,
    status: row.status,
    version: row.version,
    materialDelta: row.materialDelta === null ? null : text(row.materialDelta),
    materialDeltaCurrency: row.materialDeltaCurrency,
    minutesDelta: row.minutesDelta === null ? null : text(row.minutesDelta),
  }))
}

/** The values a style offers now (its ACTIVE offers' groups; their values, archived ones too), with their group. */
export async function offeredValues(db: Reader, styleId: string): Promise<{ values: ValueCostRow[]; groups: Map<string, { id: string; code: string; name: string }> }> {
  const offers = await db.styleOptionGroup.findMany({ where: { styleId, status: 'ACTIVE' }, select: { groupId: true }, orderBy: [{ seq: 'asc' }, { createdAt: 'asc' }] })
  const groupIds = offers.map((offer) => offer.groupId)
  if (groupIds.length === 0) return { values: [], groups: new Map() }
  const groups = await db.optionGroup.findMany({ where: { id: { in: groupIds } }, select: { id: true, code: true, name: true } })
  const ids = (await db.optionValue.findMany({ where: { groupId: { in: groupIds } }, select: { id: true } })).map((row) => row.id)
  const values = await readValueCosts(db, ids)
  const order = new Map(groupIds.map((id, index) => [id, index]))
  return { values: values.sort((a, b) => (order.get(a.groupId) ?? 0) - (order.get(b.groupId) ?? 0)), groups: new Map(groups.map((group) => [group.id, group])) }
}

/** The operations effects name, as costing reads them. */
export async function readEffectOperations(db: Reader, operationIds: readonly string[]): Promise<Map<string, EffectOperation>> {
  const ids = [...new Set(operationIds)]
  if (ids.length === 0) return new Map()
  const rows = await db.operation.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true, workCentreKind: true, standardMinutes: true } })
  return new Map(rows.map((row) => [row.id, { id: row.id, code: row.code, name: row.name, workCentreKind: row.workCentreKind, standardMinutes: text(row.standardMinutes) }]))
}

export interface LoadedGarment {
  readonly loaded: LoadedComponents
  readonly garment: GarmentWithOptions
}

/** One garment of a revision with everything its options are costed from, for these values. */
export async function loadGarment(db: Reader, style: CostingStyleRow, revision: RevisionRow, company: ComponentCompany, on: BusinessDate, options: ComponentOptions, valueIds: readonly string[]): Promise<LoadedGarment> {
  const loaded = await loadComponentFacts(db, style, revision, company, on, { ...options, withOptionParts: true })
  const effects = (await readEffects(db, valueIds)).map(effectFactsOf)
  const operations = await readEffectOperations(
    db,
    effects.flatMap((effect) => (effect.operationId ? [effect.operationId] : [])),
  )
  const added = effects.flatMap((effect) => (effect.itemId && !loaded.facts.materials.has(effect.itemId) ? [effect.itemId] : []))
  const extra = await readCostingMaterials(db, added)
  const materials = new Map([...loaded.facts.materials, ...extra])
  return { loaded, garment: { facts: { ...loaded.facts, materials }, parts: loaded.optionParts, effects, operations } }
}
