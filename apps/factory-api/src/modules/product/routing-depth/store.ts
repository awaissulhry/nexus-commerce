import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ConflictError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { CheckpointView, SettingView } from '@nexus/factory-domain/product/routing-depth/contracts'
import { checkpointWords, settingLine, variantWords, type CheckpointFacts, type RevisionDays, type SettingData, type StepVariants } from '@nexus/factory-domain/product/routing-depth/rules'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import type { Frequency, PlanStage } from '@nexus/factory-domain/quality/plans/rules'
import type { CommandTx } from '../../../core/command'

/**
 * A routing in depth (B-W2b-225): the reads every part of it shares (factory-db `RoutingOperation`'s W2b-4 columns,
 * `OperationMachineSetting`, `MachineClass`, `InspectionPlan`/`InspectionPlanVersion`, `StyleRevision`'s effective days),
 * and the last net under a database refusal. Every read names its columns and selects no relation (inside a command's
 * transaction Prisma would send them at once on its one connection). The floor reads these tables in its own scope
 * (ownership: product.json, instructions.json, inspection-plans.json, plant.json grant it SELECT; never a step's fee).
 */

export type Db = FactoryClient | CommandTx

/** A step's W2b-4 columns this step reads and writes, with what the views name. */
export const DEPTH_COLUMNS = {
  id: true,
  styleId: true,
  revisionId: true,
  seq: true,
  operationId: true,
  code: true,
  name: true,
  workCentreKind: true,
  scanRequired: true,
  standardMinutes: true,
  instructions: true,
  appliesToSizes: true,
  appliesToColourwayIds: true,
  appliesToOptionValueIds: true,
  inspectionPlanId: true,
  setupMinutes: true,
  waitMinutes: true,
  moveMinutes: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.RoutingOperationSelect
export type DepthRow = Prisma.RoutingOperationGetPayload<{ select: typeof DEPTH_COLUMNS }>

export const variantsOfRow = (row: Pick<DepthRow, 'appliesToSizes' | 'appliesToColourwayIds' | 'appliesToOptionValueIds'>): StepVariants => ({
  sizes: [...row.appliesToSizes],
  colourwayIds: [...row.appliesToColourwayIds],
  optionValueIds: [...row.appliesToOptionValueIds],
})

export const textOrNull = (value: { toString(): string } | null): string | null => (value === null ? null : decimalText(value.toString()))

export const readDepthSteps = (db: Db, revisionId: string): Promise<DepthRow[]> => db.routingOperation.findMany({ where: { revisionId }, select: DEPTH_COLUMNS, orderBy: { seq: 'asc' } })

// ---- machine and stitch settings ------------------------------------------------------------------------------------------

export const SETTING_COLUMNS = {
  id: true,
  operationId: true,
  routingOperationId: true,
  seq: true,
  machineClassId: true,
  stitchType: true,
  needle: true,
  thread: true,
  stitchesPerCm: true,
  tension: true,
  foot: true,
  notes: true,
} as const satisfies Prisma.OperationMachineSettingSelect
export type SettingRow = Prisma.OperationMachineSettingGetPayload<{ select: typeof SETTING_COLUMNS }>

export const settingDataOf = (row: SettingRow): SettingData => ({
  seq: row.seq,
  machineClassId: row.machineClassId,
  stitchType: row.stitchType,
  needle: row.needle,
  thread: row.thread,
  stitchesPerCm: textOrNull(row.stitchesPerCm),
  tension: row.tension,
  foot: row.foot,
  notes: row.notes,
})

/** The settings of these library operations (`by: 'operation'`) or routing steps (`by: 'step'`), each list in order. */
export async function readSettings(db: Db, by: 'operation' | 'step', ids: readonly string[]): Promise<Map<string, SettingRow[]>> {
  const keys = [...new Set(ids)].filter(isUuid)
  const out = new Map<string, SettingRow[]>()
  if (keys.length === 0) return out
  const rows = await db.operationMachineSetting.findMany({
    where: by === 'operation' ? { operationId: { in: keys } } : { routingOperationId: { in: keys } },
    select: SETTING_COLUMNS,
    orderBy: [{ seq: 'asc' }, { id: 'asc' }],
  })
  for (const row of rows) {
    const key = (by === 'operation' ? row.operationId : row.routingOperationId)!
    out.set(key, [...(out.get(key) ?? []), row])
  }
  return out
}

export interface MachineClassRow {
  readonly id: string
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  readonly active: boolean
}

export async function readMachineClasses(db: Db, ids: readonly (string | null)[]): Promise<Map<string, MachineClassRow>> {
  const keys = [...new Set(ids.filter((value): value is string => value !== null && isUuid(value)))]
  if (keys.length === 0) return new Map()
  const rows = await db.machineClass.findMany({ where: { id: { in: keys } }, select: { id: true, code: true, labelIt: true, labelEn: true, active: true } })
  return new Map(rows.map((row) => [row.id, row]))
}

export function settingViewOf(row: SettingRow, classes: ReadonlyMap<string, MachineClassRow>): SettingView {
  const machineClass = row.machineClassId ? (classes.get(row.machineClassId) ?? null) : null
  const data = settingDataOf(row)
  return {
    id: row.id,
    seq: row.seq,
    machineClass: machineClass ? { id: machineClass.id, code: machineClass.code, label: { it: machineClass.labelIt, en: machineClass.labelEn }, active: machineClass.active } : null,
    stitchType: data.stitchType,
    needle: data.needle,
    thread: data.thread,
    stitchesPerCm: data.stitchesPerCm,
    tension: data.tension,
    foot: data.foot,
    notes: data.notes,
    line: { ...settingLine(data, machineClass) },
  }
}

/** A list as the audit row keeps it. */
export const auditedSettings = (settings: readonly SettingData[]): Record<string, unknown>[] => settings.map((setting) => ({ ...setting }))

// ---- checkpoints ----------------------------------------------------------------------------------------------------------

export interface PlanRow extends CheckpointFacts {
  readonly id: string
  readonly approved: { readonly id: string; readonly number: number; readonly frequency: Frequency | null; readonly frequencyValue: number | null } | null
}

/** The plans by id with their APPROVED version (at most one per plan). */
export async function readPlans(db: Db, planIds: readonly (string | null)[]): Promise<Map<string, PlanRow>> {
  const ids = [...new Set(planIds.filter((value): value is string => value !== null && isUuid(value)))]
  if (ids.length === 0) return new Map()
  const plans = await db.inspectionPlan.findMany({ where: { id: { in: ids } }, select: { id: true, companyId: true, code: true, name: true, stage: true } })
  const approved = await db.inspectionPlanVersion.findMany({ where: { planId: { in: ids }, status: 'APPROVED' }, select: { id: true, planId: true, number: true, frequency: true, frequencyValue: true } })
  const versionOf = new Map(approved.map((row) => [row.planId, row]))
  return new Map(
    plans.map((plan) => {
      const version = versionOf.get(plan.id)
      return [
        plan.id,
        {
          id: plan.id,
          companyId: plan.companyId,
          code: plan.code,
          name: plan.name,
          stage: plan.stage as PlanStage,
          approved: version ? { id: version.id, number: version.number, frequency: (version.frequency as Frequency | null) ?? null, frequencyValue: version.frequencyValue } : null,
        },
      ]
    }),
  )
}

export function checkpointViewOf(plan: PlanRow): CheckpointView {
  const words = checkpointWords(plan)
  return {
    plan: { id: plan.id, code: plan.code, name: plan.name, stage: plan.stage, companyId: plan.companyId },
    approvedVersion: plan.approved ? { ...plan.approved } : null,
    kind: words.kind,
    does: { ...words.does },
    warning: words.warning ? { ...words.warning } : null,
  }
}

// ---- variants -------------------------------------------------------------------------------------------------------------

export interface ColourwayRow {
  readonly id: string
  readonly code: string
  readonly name: string
}

/** The style's colourways in code order. */
export const readColourwaysOf = (db: Db, styleId: string): Promise<ColourwayRow[]> =>
  db.colourway.findMany({ where: { styleId }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } })

export function variantsViewOf(variants: StepVariants, sizeLabels: ReadonlyMap<string, string>, colourways: readonly ColourwayRow[]) {
  const colourwayOf = new Map(colourways.map((row) => [row.id, row]))
  const words = variantWords(variants, (id) => colourwayOf.get(id)?.code ?? '?')
  return {
    sizes: variants.sizes.map((code) => ({ code, label: sizeLabels.get(code) ?? code })),
    colourways: variants.colourwayIds.map((id) => colourwayOf.get(id) ?? { id, code: '?', name: '' }),
    optionValueIds: [...variants.optionValueIds],
    words: words ? { ...words } : null,
  }
}

// ---- a revision's effective days ------------------------------------------------------------------------------------------

export const REVISION_DAY_COLUMNS = { id: true, revision: true, status: true, effectiveFrom: true, effectiveTo: true, releasedAt: true, version: true } as const satisfies Prisma.StyleRevisionSelect
export type RevisionDayRow = Prisma.StyleRevisionGetPayload<{ select: typeof REVISION_DAY_COLUMNS }>

/** A @db.Date as its calendar day. */
export const dayOf = (value: Date | null): BusinessDate | null => (value === null ? null : value.toISOString().slice(0, 10))
export const asDate = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)

export const revisionDaysOf = (row: RevisionDayRow): RevisionDays => ({
  id: row.id,
  revision: row.revision,
  status: row.status,
  effectiveFrom: dayOf(row.effectiveFrom),
  effectiveTo: dayOf(row.effectiveTo),
  releasedOn: row.releasedAt === null ? null : businessDate(row.releasedAt),
})

// ---- the last net -----------------------------------------------------------------------------------------------------------

/**
 * The API checks every rule first and answers in words; should the database still refuse (a row changed between the check
 * and the write), its own words come back as a 409, never a 500 (lead 11-09). Only the product rules' refusals
 * (…_routings_instructions_w2b_guards and W1's …_product_guards: "product: …").
 */
export async function depthGuarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause
    if ((cause?.originalCode === '23514' || cause?.originalCode === '23001') && typeof cause.originalMessage === 'string' && cause.originalMessage.startsWith('product: ')) {
      const words = cause.originalMessage.slice('product: '.length)
      throw new ConflictError(`${words.charAt(0).toUpperCase()}${words.slice(1)}. Load the routing again.`)
    }
    throw error
  }
}
