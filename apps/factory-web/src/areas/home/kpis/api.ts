import { z } from 'zod'
import { CALC_KINDS } from '@nexus/factory-domain/insights/kpis/calc'
import { KPI_DRILL_KINDS, KPI_GRAINS, KPI_STATES, KPI_UNITS, KPI_USE_KINDS } from '@nexus/factory-domain/insights/kpis/catalogue'
import { LEAD_KINDS } from '@nexus/factory-domain/insights/kpis/lead-times'
import { OTIF_OUTCOMES, OTIF_PROMISES } from '@nexus/factory-domain/insights/kpis/otif'
import { WIP_AGE_BUCKETS } from '@nexus/factory-domain/insights/kpis/wip'
import { PERIOD_KINDS } from '@nexus/factory-domain/insights/periods/periods'
import { ITEM_KINDS } from '@nexus/factory-domain/product/materials/rules'
import { PRODUCT_TYPES } from '@nexus/factory-domain/product/styles/rules'
import { SALES_ORDER_PRIORITY_LEVELS } from '@nexus/factory-domain/sales/orders-depth/rules'
import type { ApiClient } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'

/**
 * Every call of Home › Insights › KPI library (SCR-249, the KPI record SCR-470, the records behind a KPI SCR-471) on
 * B-W2b-428's metric layer and B-W2b-429's drills, the answers checked with zod (unknown fields dropped). The shapes mirror
 * apps/factory-api modules/insights/kpis/contract.ts and kpis/drills/contract.ts. A KPI's name, definition and formula are
 * DATA of its version (Italian and English); units, states, problems, period kinds, measures, records and every code are
 * said by this app's catalogue `home-kpis`. A value marked with a money grain is dropped by the API's grain filter for
 * anyone without it: an absent value reads as null (the KPI's `problem` says why).
 */

export { CALC_KINDS, KPI_DRILL_KINDS, KPI_GRAINS, KPI_STATES, KPI_UNITS, KPI_USE_KINDS, PERIOD_KINDS }
export type KpiUnit = (typeof KPI_UNITS)[number]
export type KpiGrain = (typeof KPI_GRAINS)[number]
export type KpiState = (typeof KPI_STATES)[number]
export type KpiUseKind = (typeof KPI_USE_KINDS)[number]
export type PeriodKind = (typeof PERIOD_KINDS)[number]

/** apps/factory-api insights/kpis/value.ts KPI_PROBLEMS: why a KPI has no value for me. */
export const KPI_PROBLEMS = ['NO_CALCULATION', 'NO_ACCESS', 'NEEDS_GRAIN', 'NOT_BUILT', 'MIXED_CURRENCIES'] as const
export type KpiProblem = (typeof KPI_PROBLEMS)[number]

/** A grain-filtered decimal: absent (filtered) or null both read as "no value". */
const marked = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((value) => (value === undefined || value === null ? null : String(value)))

const versionSchema = z.object({
  id: z.string(),
  kpiVersion: z.number(),
  state: z.enum(KPI_STATES),
  nameIt: z.string(),
  nameEn: z.string(),
  definitionIt: z.string(),
  definitionEn: z.string(),
  formulaIt: z.string(),
  formulaEn: z.string(),
  sourceRecords: z.array(z.string()),
  measureKeys: z.array(z.string()),
  owner: z.object({ roleId: z.string(), key: z.string().nullable(), name: z.string().nullable() }),
  unit: z.enum(KPI_UNITS),
  grain: z.enum(KPI_GRAINS).nullable(),
  basedOnId: z.string().nullable(),
  changeNote: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  activatedAt: z.string().nullable(),
  activatedBy: z.string().nullable(),
  endedAt: z.string().nullable(),
  endedBy: z.string().nullable(),
  version: z.number(),
})
export type KpiVersion = z.infer<typeof versionSchema>

const wordsSchema = z.object({ nameIt: z.string(), nameEn: z.string(), definitionIt: z.string(), definitionEn: z.string(), formulaIt: z.string(), formulaEn: z.string() })
export type KpiWords = z.infer<typeof wordsSchema>

const drillSchema = z.object({ kind: z.enum(KPI_DRILL_KINDS), key: z.string().nullable(), api: z.string().nullable(), terms: z.record(z.string(), z.string()) })
export type KpiDrill = z.infer<typeof drillSchema>

const calculationSchema = z.object({
  kind: z.enum(CALC_KINDS),
  measures: z.array(z.string()),
  period: z.enum(PERIOD_KINDS),
  unit: z.enum(KPI_UNITS),
  grain: z.enum(KPI_GRAINS).nullable(),
  ownerRole: z.string(),
  drill: drillSchema.nullable(),
})
export type KpiCalculation = z.infer<typeof calculationSchema>

const periodSchema = z.object({ kind: z.enum(PERIOD_KINDS), key: z.string(), from: z.string(), to: z.string() })
export type KpiPeriod = z.infer<typeof periodSchema>

const valueSchema = z.object({
  period: periodSchema.nullable(),
  value: marked,
  currency: z.string().nullable(),
  converted: z.array(z.string()),
  asOf: z.string().nullable(),
  stale: z.boolean(),
  live: z.boolean(),
  missingDays: z.number(),
  problem: z.enum(KPI_PROBLEMS).nullable(),
  periods: z.array(periodSchema.extend({ value: marked })),
})
export type KpiValue = z.infer<typeof valueSchema>

const itemShape = {
  key: z.string(),
  calculation: calculationSchema.nullable(),
  shown: versionSchema.nullable(),
  inForce: z.object({ id: z.string(), kpiVersion: z.number() }).nullable(),
  drafts: z.number(),
  measuresDiffer: z.boolean(),
  standardWords: wordsSchema.nullable(),
  uses: z.number(),
  value: valueSchema,
}

const librarySchema = z.object({ asOf: z.string(), kpis: z.array(z.object(itemShape)) })
export type KpiLibrary = z.infer<typeof librarySchema>
export type KpiItem = KpiLibrary['kpis'][number]

const useSchema = z.object({ usedIn: z.enum(KPI_USE_KINDS), useKey: z.string(), since: z.string() })
export type KpiUse = z.infer<typeof useSchema>

const recordSchema = z.object({ ...itemShape, versions: z.array(versionSchema), usedIn: z.array(useSchema) })
export type KpiRecord = z.infer<typeof recordSchema>

/** Where the value is read: the address's company (fiscal periods need it), over a period kind. */
export interface KpiScope {
  readonly companyId?: string | null
  readonly period?: PeriodKind | null
}

const scopeQuery = (scope: KpiScope) => ({ companyId: scope.companyId ?? undefined, period: scope.period ?? undefined })

/** GET /insights/kpis: every KPI with its value now (its own period, current) in my scope. */
export function getLibrary(api: ApiClient, scope: KpiScope, signal?: AbortSignal): Promise<KpiLibrary> {
  return api.get('/insights/kpis', { query: { companyId: scope.companyId ?? undefined }, schema: librarySchema, signal })
}

/** GET /insights/kpis/:key: one KPI with its versions, where it is used and 12 periods of its value. */
export function getKpi(api: ApiClient, key: string, scope: KpiScope, signal?: AbortSignal): Promise<KpiRecord> {
  return api.get(`/insights/kpis/${encodeURIComponent(key)}`, { query: scopeQuery(scope), schema: recordSchema, signal })
}

// ---- the owner's writes (home.kpis.manage) --------------------------------------------------------------------------------

const useRef = z.object({ kpiKey: z.string(), usedIn: z.enum(KPI_USE_KINDS), useKey: z.string() })
const syncSchema = z.object({ installed: z.array(z.string()), skipped: z.array(z.string()), usesAdded: z.array(useRef), usesRemoved: z.array(useRef) })
export type SyncResult = z.infer<typeof syncSchema>

/** POST /insights/kpis/sync: installs the standard KPIs the company has no version of (v1 in force) and keeps the uses in step. */
export function installStandard(api: ApiClient): Promise<SyncResult> {
  return api.post('/insights/kpis/sync', { schema: syncSchema, idempotencyKey: newIdempotencyKey() })
}

/** The fields a version's form writes (measures, unit and grain only to match the calculation). */
export interface VersionFields {
  nameIt?: string
  nameEn?: string
  definitionIt?: string
  definitionEn?: string
  formulaIt?: string
  formulaEn?: string
  sourceRecords?: string[]
  measureKeys?: string[]
  ownerRoleId?: string
  unit?: KpiUnit
  grain?: KpiGrain | null
  changeNote?: string
}

const writtenSchema = z.object({ id: z.string(), kpiKey: z.string(), kpiVersion: z.number(), version: z.number() })
export type Written = z.infer<typeof writtenSchema>

/** POST /insights/kpis/:key/versions: a DRAFT numbered after the newest, made from one version, with what changed. */
export function draftVersion(api: ApiClient, key: string, body: VersionFields & { basedOnId: string; changeNote: string }): Promise<Written> {
  return api.post(`/insights/kpis/${encodeURIComponent(key)}/versions`, { body, schema: writtenSchema, idempotencyKey: newIdempotencyKey() })
}

/** PATCH /insights/kpis/versions/:id: a draft's fields, at the version read. */
export function editVersion(api: ApiClient, id: string, body: VersionFields & { version: number }): Promise<Written> {
  return api.request('PATCH', `/insights/kpis/versions/${encodeURIComponent(id)}`, { body, schema: writtenSchema, idempotencyKey: newIdempotencyKey() })
}

/** POST /insights/kpis/versions/:id/activate: the draft in force, the one before superseded. */
export function activateVersion(api: ApiClient, version: Pick<KpiVersion, 'id' | 'version'>): Promise<Written & { supersededId: string | null }> {
  return api.post(`/insights/kpis/versions/${encodeURIComponent(version.id)}/activate`, {
    body: { version: version.version },
    schema: writtenSchema.extend({ supersededId: z.string().nullable() }),
    idempotencyKey: newIdempotencyKey(),
  })
}

/** POST /insights/kpis/:key/retire: the version in force withdrawn; the KPI's uses go with it. */
export function retireKpi(api: ApiClient, key: string, version: Pick<KpiVersion, 'version'>): Promise<Written & { usesRemoved: number }> {
  return api.post(`/insights/kpis/${encodeURIComponent(key)}/retire`, {
    body: { version: version.version },
    schema: writtenSchema.extend({ usesRemoved: z.number() }),
    idempotencyKey: newIdempotencyKey(),
  })
}

/** DELETE /insights/kpis/versions/:id: only a draft. */
export function deleteDraft(api: ApiClient, version: Pick<KpiVersion, 'id' | 'version'>): Promise<{ id: string; deleted: true }> {
  return api.request('DELETE', `/insights/kpis/versions/${encodeURIComponent(version.id)}`, {
    query: { version: version.version },
    schema: z.object({ id: z.string(), deleted: z.literal(true) }),
    idempotencyKey: newIdempotencyKey(),
  })
}

const roleSchema = z.object({ id: z.string(), key: z.string(), name: z.string(), system: z.boolean(), audience: z.string(), archivedAt: z.string().nullable() })
export type OfficeRole = z.infer<typeof roleSchema>

/** GET /auth/roles (roles.view): the office roles a KPI may be owned by (not archived). */
export async function officeRoles(api: ApiClient, signal?: AbortSignal): Promise<OfficeRole[]> {
  const answer = await api.get('/auth/roles', { schema: z.object({ roles: z.array(roleSchema) }), signal })
  return answer.roles.filter((role) => role.audience === 'office' && role.archivedAt === null)
}

// ---- the records behind a KPI (B-W2b-429's drills) ------------------------------------------------------------------------

export { ITEM_KINDS, LEAD_KINDS, OTIF_OUTCOMES, OTIF_PROMISES, PRODUCT_TYPES, SALES_ORDER_PRIORITY_LEVELS, WIP_AGE_BUCKETS }

const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })
export type DrillRef = z.infer<typeof ref>
const record = z.object({ type: z.string(), id: z.string(), label: z.string() })
export type DrillRecord = z.infer<typeof record>
const span = z.object({ from: z.string(), to: z.string() })
const rate = { due: z.number(), onTime: z.number(), pct: z.string().nullable() }
const cents = z.number().nullable().optional().transform((value) => value ?? null)
const pct = z.string().nullable().optional().transform((value) => value ?? null)

const otifDrillSchema = z.object({
  kpiKey: z.string(),
  promise: z.enum(OTIF_PROMISES),
  period: span,
  asOf: z.string(),
  overall: z.object({ ...rate, late: z.number() }),
  byCustomer: z.array(z.object({ customer: ref.nullable(), ...rate })),
  bySite: z.array(z.object({ site: ref.nullable(), ...rate })),
  byMonth: z.array(z.object({ month: z.string(), ...rate })),
  rows: z.array(
    z.object({
      record,
      lineId: z.string(),
      seq: z.number(),
      order: z.object({ id: z.string(), number: z.string() }),
      customer: ref.nullable(),
      style: ref.nullable(),
      family: z.enum(PRODUCT_TYPES).nullable(),
      site: ref.nullable(),
      season: ref.nullable(),
      priority: z.enum(SALES_ORDER_PRIORITY_LEVELS),
      due: z.number(),
      firstPromise: z.string().nullable(),
      currentPromise: z.string().nullable(),
      promise: z.string(),
      shippedByPromise: z.number(),
      completeOn: z.string().nullable(),
      outcome: z.enum(OTIF_OUTCOMES),
      lateDays: z.number(),
    }),
  ),
  more: z.number(),
})

const summary = {
  orders: z.number(),
  medianDays: z.string().nullable(),
  p25Days: z.string().nullable(),
  p75Days: z.string().nullable(),
  spreadDays: z.string().nullable(),
  averageDays: z.string().nullable(),
  minDays: z.number().nullable(),
  maxDays: z.number().nullable(),
}

const leadDrillSchema = z.object({
  kpiKey: z.string(),
  kind: z.enum(LEAD_KINDS),
  period: span,
  asOf: z.string(),
  overall: z.object(summary),
  families: z.array(z.object({ family: z.enum(PRODUCT_TYPES).nullable(), ...summary })),
  rows: z.array(
    z.object({
      record,
      order: z.object({ id: z.string(), number: z.string(), orderDate: z.string() }),
      customer: ref.nullable(),
      family: z.enum(PRODUCT_TYPES).nullable(),
      season: ref.nullable(),
      priority: z.enum(SALES_ORDER_PRIORITY_LEVELS),
      fromDay: z.string(),
      toDay: z.string(),
      days: z.number(),
    }),
  ),
  more: z.number(),
})

const ageing = z.object(Object.fromEntries(WIP_AGE_BUCKETS.map((bucket) => [bucket, z.number()])) as Record<(typeof WIP_AGE_BUCKETS)[number], z.ZodNumber>)

const wipDrillSchema = z.object({
  kpiKey: z.string(),
  asOf: z.string(),
  overall: z.object({ workOrders: z.number(), pieces: z.number(), waiting: z.number(), value: cents, currency: z.string().nullable() }),
  stages: z.array(z.object({ line: ref.nullable(), operation: z.object({ code: z.string(), name: z.string() }), workOrders: z.number(), waiting: z.number(), ageing })),
  rows: z.array(
    z.object({
      record,
      workOrder: z.object({ id: z.string(), number: z.string(), status: z.string() }),
      site: ref.nullable(),
      line: ref.nullable(),
      style: ref.nullable(),
      releasedOn: z.string(),
      week: z.string(),
      pieces: z.number(),
      ageDays: z.number(),
      waitedDays: z.number(),
      band: z.enum(WIP_AGE_BUCKETS),
      value: cents,
      currency: z.string().nullable(),
      stages: z.array(z.object({ code: z.string(), name: z.string(), waiting: z.number() })),
    }),
  ),
  more: z.number(),
})

const areas = { cutM2: z.string(), patternM2: z.string(), wasteM2: z.string(), yieldPct: z.string().nullable(), wastePct: z.string().nullable(), hides: z.number() }
const lot = z.object({ id: z.string(), code: z.string(), supplierLotRef: z.string().nullable() })

const leatherDrillSchema = z.object({
  kpiKey: z.string(),
  period: span,
  asOf: z.string(),
  overall: z.object(areas),
  byGrade: z.array(z.object({ grade: z.string().nullable(), ...areas })),
  byLot: z.array(z.object({ lot, supplier: ref.nullable(), ...areas })),
  byStyle: z.array(z.object({ style: ref.nullable(), ...areas })),
  rows: z.array(
    z.object({
      record,
      hide: z.object({ id: z.string(), code: z.string(), grade: z.string().nullable() }),
      lot,
      supplier: ref.nullable(),
      site: ref.nullable(),
      workOrder: z.object({ id: z.string(), number: z.string() }),
      style: ref.nullable(),
      lastCutOn: z.string(),
      cutM2: z.string(),
      patternM2: z.string(),
      yieldPct: z.string().nullable(),
    }),
  ),
  more: z.number(),
})

const figures = { value: cents, quotedCost: cents, actualCost: cents, quotedMargin: cents, actualMargin: cents, quotedPct: pct, actualPct: pct, changePts: pct }

const marginDrillSchema = z.object({
  kpiKey: z.string(),
  period: span,
  asOf: z.string(),
  currency: z.string().nullable(),
  converted: z.array(z.string()),
  unconverted: z.number(),
  overall: z.object({ ...figures, garments: z.number(), orders: z.number() }),
  byCustomer: z.array(z.object({ customer: ref.nullable(), orders: z.number(), garments: z.number(), ...figures })),
  byStyle: z.array(z.object({ style: ref.nullable(), garments: z.number(), ...figures })),
  rows: z.array(z.object({ record, order: z.object({ id: z.string(), number: z.string() }), customer: ref.nullable(), season: ref.nullable(), lastShippedOn: z.string(), garments: z.number(), ...figures })),
  more: z.number(),
})

const supplyDrillSchema = z.object({
  kpiKey: z.string(),
  period: span,
  asOf: z.string(),
  overall: z.object({ received: z.number(), onTime: z.number(), late: z.number(), pct: z.string().nullable() }),
  bySupplier: z.array(z.object({ supplier: ref.nullable(), received: z.number(), onTime: z.number(), pct: z.string().nullable(), worstLateDays: z.number() })),
  rows: z.array(
    z.object({
      record,
      purchaseOrder: z.object({ id: z.string(), number: z.string() }),
      seq: z.number(),
      receipt: z.object({ id: z.string(), number: z.string() }),
      supplier: ref.nullable(),
      item: ref.nullable(),
      category: z.enum(ITEM_KINDS),
      site: ref.nullable(),
      due: z.string(),
      postedOn: z.string(),
      onTime: z.boolean(),
      lateDays: z.number(),
    }),
  ),
  more: z.number(),
  shortages: z
    .object({
      workOrders: z.array(z.object({ record, workOrder: z.object({ id: z.string(), number: z.string(), status: z.string() }), site: ref.nullable(), style: ref.nullable(), shortages: z.number(), materials: z.array(z.string()), neededBy: z.string() })),
      materials: z.number(),
      more: z.number(),
    })
    .nullable(),
  cover: z
    .object({
      windowDays: z.number(),
      rows: z.array(
        z.object({
          site: ref.nullable(),
          item: ref.nullable(),
          colour: ref.nullable(),
          uom: z.string(),
          onHand: z.string(),
          hides: z.number(),
          usedInWindow: z.string(),
          perDay: z.string(),
          coverDays: z.string().nullable(),
          oldestLotDays: z.number().nullable(),
        }),
      ),
    })
    .nullable(),
})

/** The six drills by their API path's last part, each with its answer's shape. */
const DRILL_SCHEMAS = {
  otif: otifDrillSchema,
  'lead-times': leadDrillSchema,
  wip: wipDrillSchema,
  'leather-yield': leatherDrillSchema,
  margin: marginDrillSchema,
  supply: supplyDrillSchema,
} as const
export type DrillName = keyof typeof DRILL_SCHEMAS
export const DRILL_NAMES = Object.keys(DRILL_SCHEMAS) as DrillName[]

export type DrillAnswer =
  | { readonly name: 'otif'; readonly data: z.infer<typeof otifDrillSchema> }
  | { readonly name: 'lead-times'; readonly data: z.infer<typeof leadDrillSchema> }
  | { readonly name: 'wip'; readonly data: z.infer<typeof wipDrillSchema> }
  | { readonly name: 'leather-yield'; readonly data: z.infer<typeof leatherDrillSchema> }
  | { readonly name: 'margin'; readonly data: z.infer<typeof marginDrillSchema> }
  | { readonly name: 'supply'; readonly data: z.infer<typeof supplyDrillSchema> }

/** GET /insights/kpis/drills/<name>: the KPI's records with the filters it needs (its terms plus the period read). */
export async function getDrill(api: ApiClient, name: DrillName, query: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<DrillAnswer> {
  const data = await api.get(`/insights/kpis/drills/${name}`, { query, schema: DRILL_SCHEMAS[name] as z.ZodType<unknown>, signal })
  return { name, data } as DrillAnswer
}
