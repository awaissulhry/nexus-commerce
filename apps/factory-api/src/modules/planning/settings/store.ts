import type { Prisma } from '@nexus/factory-db'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { DEFAULT_EFFICIENCY_PCT, DEFAULT_PLANNING_SETTINGS, type PlanningSettingsValues } from '@nexus/factory-domain/planning/settings/settings'
import { EMPTY_ITEM_PLANNING, QUANTITY_FIELDS, type ItemPlanningValues } from '@nexus/factory-domain/planning/settings/items'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { IdempotencyKeyReusedError, requestHash, type CommandCaller, type CommandRecord } from '../../../core/command'
import type { Reader, SiteRow } from '../store'
import type { ItemParametersView, SettingsView } from './contract'

/**
 * What planning settings read (B-W2a-16), on one client (a command's transaction or a read-only one), one query after
 * another. Every read names its columns; no money column is ever read (an item's standard cost stays where it is).
 */

export const siteViewOf = (site: SiteRow) => ({ id: site.id, companyId: site.companyId, code: site.code, name: site.name, kind: site.kind, timeZone: site.timezone })

// ---- settings -------------------------------------------------------------------------------------------------------------

export const SETTINGS_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  horizonWeeks: true,
  dayBucketWeeks: true,
  weekBucketWeeks: true,
  defaultEfficiencyPct: true,
  scheduledRunTime: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.PlanningSettingsSelect
export type SettingsRow = Prisma.PlanningSettingsGetPayload<{ select: typeof SETTINGS_SELECT }>

export const readSettings = (db: Reader, siteId: string): Promise<SettingsRow | null> => db.planningSettings.findUnique({ where: { id: siteId }, select: SETTINGS_SELECT })

export const pct = (value: { toString(): string }): string => new Dec(value.toString()).toFixed(2)

export function settingsValuesOf(row: SettingsRow | null): PlanningSettingsValues {
  if (!row) return DEFAULT_PLANNING_SETTINGS
  return { horizonWeeks: row.horizonWeeks, dayBucketWeeks: row.dayBucketWeeks, weekBucketWeeks: row.weekBucketWeeks, defaultEfficiencyPct: pct(row.defaultEfficiencyPct), scheduledRunTime: row.scheduledRunTime }
}

export const settingsViewOf = (row: SettingsRow | null): SettingsView => ({
  ...settingsValuesOf(row),
  isDefault: row === null,
  version: row?.version ?? null,
  updatedAt: row ? toUtcIso(row.updatedAt) : null,
})

/** The efficiency of a lane without its own: the site's default (SITE), else 100 % (DEFAULT). */
export const defaultEfficiencyOf = (row: SettingsRow | null): { efficiencyPct: string; source: 'SITE' | 'DEFAULT' } =>
  row ? { efficiencyPct: pct(row.defaultEfficiencyPct), source: 'SITE' } : { efficiencyPct: DEFAULT_EFFICIENCY_PCT, source: 'DEFAULT' }

// ---- item parameters --------------------------------------------------------------------------------------------------

export const ITEM_PLANNING_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  itemId: true,
  itemColourId: true,
  method: true,
  source: true,
  supplierId: true,
  makeSiteId: true,
  buyLeadTimeDays: true,
  makeLeadTimeDays: true,
  safetyLeadTimeDays: true,
  safetyStock: true,
  reorderPoint: true,
  lotSize: true,
  minStock: true,
  maxStock: true,
  minOrderQty: true,
  orderMultiple: true,
  maxOrderQty: true,
  note: true,
  version: true,
  updatedAt: true,
  item: { select: { id: true, code: true, name: true, baseUom: true } },
  itemColour: { select: { id: true, code: true, name: true } },
  supplier: { select: { id: true, code: true, legalName: true, tradeName: true } },
  makeSite: { select: { id: true, code: true, name: true } },
} as const satisfies Prisma.ItemPlanningSelect
export type ItemPlanningRow = Prisma.ItemPlanningGetPayload<{ select: typeof ITEM_PLANNING_SELECT }>

const q4 = (value: { toString(): string } | null): string | null => (value === null ? null : new Dec(value.toString()).toFixed(4))

export function itemPlanningValuesOf(row: ItemPlanningRow): ItemPlanningValues {
  const values: Record<string, unknown> = { ...EMPTY_ITEM_PLANNING }
  for (const key of Object.keys(EMPTY_ITEM_PLANNING) as (keyof ItemPlanningValues)[]) values[key] = row[key]
  for (const key of QUANTITY_FIELDS) values[key] = q4(row[key])
  return values as unknown as ItemPlanningValues
}

export const itemParametersViewOf = (row: ItemPlanningRow): ItemParametersView => {
  const values = itemPlanningValuesOf(row)
  return {
    id: row.id,
    siteId: row.siteId,
    item: row.item,
    colour: row.itemColour,
    ...values,
    supplier: row.supplier ? { id: row.supplier.id, code: row.supplier.code, name: row.supplier.tradeName ?? row.supplier.legalName } : null,
    makeSite: row.makeSite,
    version: row.version,
    updatedAt: toUtcIso(row.updatedAt),
  }
}

/** The audit row's view of a row's values (no names: ids only). */
export const auditValuesOf = (values: ItemPlanningValues | null) => (values ? { ...values } : null)

export const readItemPlanning = (db: Reader, id: string): Promise<ItemPlanningRow | null> => db.itemPlanning.findUnique({ where: { id }, select: ITEM_PLANNING_SELECT })

export const ITEM_SELECT = {
  id: true,
  companyId: true,
  code: true,
  name: true,
  kind: true,
  tracking: true,
  sourcing: true,
  status: true,
  baseUom: true,
  purchaseUom: true,
  defaultSupplierId: true,
  leadTimeDays: true,
  minOrderQty: true,
  orderMultiple: true,
  defaultSupplier: { select: { id: true, code: true, legalName: true, tradeName: true, leadTimeDays: true } },
  colours: { where: { status: 'ACTIVE' }, select: { id: true, code: true, name: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] },
} as const satisfies Prisma.ItemSelect
export type ItemRow = Prisma.ItemGetPayload<{ select: typeof ITEM_SELECT }>

/** An item's own terms, as stored (its default supplier's), for the screen's "default" hints. */
export const itemDefaultsOf = (item: ItemRow) => ({
  sourcing: item.sourcing,
  supplier: item.defaultSupplier ? { id: item.defaultSupplier.id, code: item.defaultSupplier.code, name: item.defaultSupplier.tradeName ?? item.defaultSupplier.legalName } : null,
  leadTimeDays: item.leadTimeDays ?? item.defaultSupplier?.leadTimeDays ?? null,
  purchaseUom: item.purchaseUom,
  minOrderQty: q4(item.minOrderQty),
  orderMultiple: q4(item.orderMultiple),
})

// ---- a repeated Idempotency-Key -------------------------------------------------------------------------------------

/**
 * The stored answer of a repeated Idempotency-Key, for a write that answers "nothing changed" without a command: a
 * retry of a save that went through finds its row already as asked, and must still get the first answer (A1 §3.2). The
 * first request named the record or not (a first save makes the row), so both shapes are tried; a key used for another
 * request is refused (409), as command() refuses it.
 */
export async function storedAnswer<Result>(caller: CommandCaller, spec: { readonly name: Permission; readonly idempotencyKey?: string | undefined; readonly input: unknown }, records: readonly (CommandRecord | undefined)[]): Promise<Result | undefined> {
  const key = spec.idempotencyKey
  const context = caller.factoryContext
  if (!key || !context) return undefined
  const stored = await caller.withClient((client) => client.idempotencyReceipt.findFirst({ where: { scope: spec.name, key }, select: { requestHash: true, response: true } }))
  if (!stored) return undefined
  const hashes = records.map((record) => requestHash({ name: spec.name, idempotencyKey: key, input: spec.input, ...(record ? { record } : {}) }, context))
  if (!hashes.includes(stored.requestHash)) throw new IdempotencyKeyReusedError()
  return (stored.response as { result: Result }).result
}
