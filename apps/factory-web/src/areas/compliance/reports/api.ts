import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'

/**
 * Every call of Compliance › Reports (SCR-261, B-W2b-272), with the answer's shape checked (zod; unknown fields are dropped).
 * The shapes mirror apps/factory-api modules/compliance/reports/contract.ts; the lists mirror factory-domain
 * compliance/reports/rules (reports.vitest.test.ts holds them equal). Read only: no call writes. A figure the reader may not see
 * is null with its `sight` false; nothing names a person.
 */

export const KPI_KEYS = ['coverage', 'shipped', 'gaps', 'refusals', 'registerOpen', 'crViLots'] as const
export type KpiKey = (typeof KPI_KEYS)[number]
export const GAP_TYPES = ['certificate', 'docLanguage', 'label', 'crVi', 'operator', 'other'] as const
export type GapType = (typeof GAP_TYPES)[number]
export const GATES = ['WORK_ORDER_RELEASE', 'LABEL_PRINT', 'FINAL_RELEASE', 'SHIPMENT'] as const
export type Gate = (typeof GATES)[number]
export const REGISTER_KINDS = ['COMPLAINT', 'NON_CONFORMITY', 'RECALL', 'WITHDRAWAL', 'AUTHORITY_REQUEST'] as const
export type RegisterKind = (typeof REGISTER_KINDS)[number]

const one = z.string().nullable()
const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })
export type Ref = z.infer<typeof ref>
const head = {
  company: ref.nullable(),
  brand: ref.nullable(),
  from: z.string(),
  to: z.string(),
  today: z.string(),
  asOf: z.string(),
}
const sight = z.object({ certificates: z.boolean(), register: z.boolean(), lots: z.boolean(), shipments: z.boolean() })
export type Sight = z.infer<typeof sight>
const styles = z.object({ read: z.number(), more: z.boolean(), markets: z.array(z.object({ code: z.string(), name: z.string() })) }).nullable()
export type StylesRead = z.infer<typeof styles>

const kpisSchema = z.object({
  ...head,
  sight,
  styles,
  brands: z.array(ref),
  kpis: z.object({
    coverage: z.object({ covered: z.number(), needing: z.number(), expiring: z.number(), pct: one, cells: z.number() }).nullable(),
    shipped: z.object({ pairs: z.number(), needing: z.number(), covered: z.number(), unknown: z.number(), pct: one, shipments: z.number() }).nullable(),
    gaps: z.object({ count: z.number(), crViCounted: z.boolean() }).nullable(),
    refusals: z.object({ count: z.number(), overridden: z.number(), byGate: z.array(z.object({ gate: z.enum(GATES), count: z.number() })) }).nullable(),
    registerOpen: z.object({ count: z.number(), risk: z.number() }).nullable(),
    crViLots: z.object({ lots: z.number(), withEvidence: z.number(), pct: one }).nullable(),
  }),
})
export type Kpis = z.infer<typeof kpisSchema>

const gapRow = z.object({ type: z.enum(GAP_TYPES), count: z.number(), styles: z.number().nullable(), markets: z.number().nullable(), blocking: z.number().nullable(), requirements: z.array(z.string()) })
export type GapRow = z.infer<typeof gapRow>
const gapsSchema = z.object({ ...head, sight, styles, rows: z.array(gapRow) })
export type Gaps = z.infer<typeof gapsSchema>

const expiryItem = z.object({
  recordType: z.enum(['Certificate', 'SupplierDeclarationRequest']),
  recordId: z.string(),
  label: z.string(),
  validTo: z.string(),
  status: z.string(),
  detail: z.string().nullable(),
  party: z.string().nullable(),
  endsWithBase: z.boolean(),
})
export type ExpiryItem = z.infer<typeof expiryItem>
const expiriesSchema = z.object({ ...head, sight, months: z.array(z.object({ month: z.string(), count: z.number(), items: z.array(expiryItem) })), count: z.number() })
export type Expiries = z.infer<typeof expiriesSchema>

const supplierRow = z.object({
  party: ref.nullable(),
  lots: z.number(),
  results: z.number(),
  measured: z.number(),
  belowDetection: z.number(),
  median: one,
  highest: one,
  fails: z.number(),
  limit: one,
  lotReports: z.number(),
  supplierReports: z.number(),
})
export type CrViSupplier = z.infer<typeof supplierRow>
const cr6Schema = z.object({ ...head, sight, unit: z.literal('mg/kg'), results: z.number(), suppliers: z.array(supplierRow) })
export type Cr6 = z.infer<typeof cr6Schema>

const registerRow = { opened: z.number(), closed: z.number(), openAtEnd: z.number(), medianDaysToClose: one, months: z.array(z.number()) }
const registerSchema = z.object({
  ...head,
  sight,
  months: z.array(z.string()),
  kinds: z.array(z.object({ kind: z.enum(REGISTER_KINDS), ...registerRow })),
  all: z.object(registerRow).nullable(),
  notices: z.object({ sent: z.number(), drafts: z.number() }).nullable(),
  recalls: z.object({ active: z.number(), closed: z.number(), unitsStillOut: z.number() }).nullable(),
  requests: z.object({ received: z.number(), answered: z.number(), onTime: z.number(), onTimePct: one, open: z.number(), overdue: z.number() }).nullable(),
})
export type Register = z.infer<typeof registerSchema>
export type RegisterRow = Register['kinds'][number]

export interface Scope {
  readonly from: string | null
  readonly to: string | null
  readonly brandId: string | null
}
const periodQuery = (scope: Pick<Scope, 'from' | 'to'>) => ({ from: scope.from ?? undefined, to: scope.to ?? undefined })
const brandQuery = (scope: Pick<Scope, 'brandId'>) => ({ brandId: scope.brandId ?? undefined })

export const getKpis = (api: ApiClient, scope: Scope, signal?: AbortSignal): Promise<Kpis> => api.get('/compliance/reports/kpis', { query: { ...periodQuery(scope), ...brandQuery(scope) }, schema: kpisSchema, signal })

export const getGaps = (api: ApiClient, scope: Pick<Scope, 'brandId'>, signal?: AbortSignal): Promise<Gaps> => api.get('/compliance/reports/gaps', { query: brandQuery(scope), schema: gapsSchema, signal })

export const getExpiries = (api: ApiClient, scope: Pick<Scope, 'brandId'>, signal?: AbortSignal): Promise<Expiries> => api.get('/compliance/reports/expiries', { query: brandQuery(scope), schema: expiriesSchema, signal })

export const getCr6 = (api: ApiClient, scope: Pick<Scope, 'from' | 'to'>, signal?: AbortSignal): Promise<Cr6> => api.get('/compliance/reports/cr6', { query: periodQuery(scope), schema: cr6Schema, signal })

export const getRegister = (api: ApiClient, scope: Scope, signal?: AbortSignal): Promise<Register> => api.get('/compliance/reports/register', { query: { ...periodQuery(scope), ...brandQuery(scope) }, schema: registerSchema, signal })
