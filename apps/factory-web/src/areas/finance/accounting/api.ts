import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'
import { presignedSchema, type Presigned } from '../../../record-panels/api'

/**
 * Every call of Finance › Close › Accounting export (SCR-156, design finance.accounting; B-W2a-39's API): the batches
 * (history), one batch with its files, the twelve months of a year, the wizard's month (checks, contents, review, the
 * number it will get), the Intrastat rows, the export (a first export or a re-export of the changes), cancelling a
 * draft, a file's download link, the period locks (soft or hard with the typed phrase) and lifting one. The answers'
 * shapes are checked (zod; unknown fields are dropped); they mirror factory-domain accounting/contracts.ts, and the enum
 * lists mirror factory-domain accounting (accounting.vitest.test.ts holds them equal). Amounts carry a grain (journals,
 * payments and Intrastat: price; the purchases journal and the year-end stock pack: cost): the API drops an amount the
 * person's grains do not reach, so every amount is optional (absent, never zero). The API's English words are never
 * drawn: the screens say their own from the codes.
 */

export const ACCOUNTING_PACKAGES = ['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS', 'COST_OF_SALES', 'VAT_REGISTERS', 'INTRASTAT', 'YEAR_END_STOCK'] as const
export type AccountingPackage = (typeof ACCOUNTING_PACKAGES)[number]
export const EXPORT_STATUSES = ['DRAFT', 'EXPORTED', 'CANCELLED'] as const
export type ExportStatus = (typeof EXPORT_STATUSES)[number]
export const LOCK_LEVELS = ['SOFT', 'HARD'] as const
export type LockLevel = (typeof LOCK_LEVELS)[number]
export const LOCK_STATUSES = ['LOCKED', 'UNLOCKED'] as const
export type LockStatus = (typeof LOCK_STATUSES)[number]
export const CHECK_CODES = [
  'PERIOD_ENDED',
  'SHIPMENTS_INVOICED',
  'NO_INVOICE_REJECTED',
  'PAYMENTS_PLACED',
  'PLACEMENTS_WITHIN_PAYMENTS',
  'TOTALS_EQUAL_ROWS',
  'INTRASTAT_COMPLETE',
  'YEAR_END_SIGNED_OFF',
  'STOCK_VALUED',
] as const
export type CheckCode = (typeof CHECK_CODES)[number]
export const INTRASTAT_FLAG_CODES = ['NOT_EUR', 'NO_STYLE', 'CN_CODE_MISSING', 'CN_CODE_SHORT', 'ORIGIN_MISSING', 'NET_MASS_MISSING', 'VAT_ID_MISSING', 'DELIVERY_TERMS_MISSING', 'DESTINATION_FROM_BILL_TO'] as const
export type IntrastatFlagCode = (typeof INTRASTAT_FLAG_CODES)[number]
export const MANIFEST_CHANGES = ['NEW', 'CHANGED', 'REMOVED'] as const
/** A failing check's explanation, at most (factory-domain accounting/checks MAX_EXPLANATION). */
export const MAX_EXPLANATION = 2000

/** What each package is (factory-domain accounting/packages PACKAGE_RULES): its wave, the grain of its amounts, a re-export's reach. */
export const PACKAGE_RULES: Readonly<Record<AccountingPackage, { readonly wave: 'W2a' | 'W2b'; readonly grain: 'price' | 'cost'; readonly scope: 'DOCUMENTS' | 'WHOLE' }>> = Object.freeze({
  SALES_JOURNAL: { wave: 'W2a', grain: 'price', scope: 'DOCUMENTS' },
  PURCHASES_JOURNAL: { wave: 'W2a', grain: 'cost', scope: 'DOCUMENTS' },
  PAYMENTS: { wave: 'W2a', grain: 'price', scope: 'DOCUMENTS' },
  COST_OF_SALES: { wave: 'W2b', grain: 'cost', scope: 'WHOLE' },
  VAT_REGISTERS: { wave: 'W2b', grain: 'price', scope: 'WHOLE' },
  INTRASTAT: { wave: 'W2a', grain: 'price', scope: 'WHOLE' },
  YEAR_END_STOCK: { wave: 'W2a', grain: 'cost', scope: 'WHOLE' },
})

const company = z.object({ id: z.string(), code: z.string(), name: z.string() })
const person = z.object({ id: z.string(), name: z.string().nullable() })
export const periodSchema = z.object({ month: z.string(), start: z.string(), end: z.string(), label: z.string(), labelIt: z.string() })
export type PeriodView = z.infer<typeof periodSchema>
const exportRef = z.object({ id: z.string(), number: z.string().nullable(), status: z.enum(EXPORT_STATUSES) })
export type ExportRef = z.infer<typeof exportRef>
const pkg = z.enum(ACCOUNTING_PACKAGES)

export const fixSchema = z.object({ recordType: z.string(), recordId: z.string(), number: z.string().nullable(), field: z.string().nullable() })
export type CheckFix = z.infer<typeof fixSchema>

export const checkSchema = z.object({
  code: z.enum(CHECK_CODES),
  passed: z.boolean(),
  count: z.number(),
  fixes: z.array(fixSchema),
  /** As the export kept it (a failing check's explanation), or null. */
  explanation: z.string().nullable(),
})
export type Check = z.infer<typeof checkSchema>

export const exportFileSchema = z.object({
  id: z.string(),
  seq: z.number(),
  package: pkg,
  format: z.string(),
  rowCount: z.number(),
  file: z.object({ id: z.string(), name: z.string(), contentType: z.string(), sizeBytes: z.number(), sha256: z.string() }),
})
export type ExportFile = z.infer<typeof exportFileSchema>

const differenceSchema = z.object({ package: pkg, documents: z.number(), new: z.number(), changed: z.number(), removed: z.number(), same: z.number() })
export type Difference = z.infer<typeof differenceSchema>

export const exportRowSchema = z.object({
  id: z.string(),
  number: z.string().nullable(),
  company,
  period: periodSchema,
  packages: z.array(pkg),
  status: z.enum(EXPORT_STATUSES),
  layout: z.string(),
  supersedes: exportRef.nullable(),
  supersededBy: exportRef.nullable(),
  files: z.array(exportFileSchema),
  contents: z.array(z.object({ package: pkg, new: z.number(), changed: z.number(), removed: z.number() })),
  madeBy: person.nullable(),
  createdAt: z.string(),
  exportedAt: z.string().nullable(),
  exportedBy: person.nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  note: z.string().nullable(),
  /** The latest exported batch of its period: the documents changed since (null otherwise). */
  changedSince: z.object({ count: z.number(), packages: z.array(differenceSchema) }).nullable(),
  version: z.number(),
})
export type ExportRow = z.infer<typeof exportRowSchema>

const heldSchema = z.object({ allowed: z.boolean() })

export const exportRecordSchema = exportRowSchema.extend({
  checks: z.array(checkSchema),
  lock: z.object({ id: z.string(), level: z.enum(LOCK_LEVELS), status: z.enum(LOCK_STATUSES) }).nullable(),
  actions: z.object({ reExport: heldSchema, cancel: heldSchema, lock: heldSchema, download: heldSchema }),
})
export type ExportRecord = z.infer<typeof exportRecordSchema>

const exportsSchema = z.object({ rows: z.array(exportRowSchema), nextCursor: z.string().nullable() })
export type ExportsPage = z.infer<typeof exportsSchema>
const exportAnswer = z.object({ export: exportRecordSchema })

export const lockSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  period: periodSchema,
  level: z.enum(LOCK_LEVELS),
  status: z.enum(LOCK_STATUSES),
  lockedAt: z.string(),
  lockedBy: person,
  note: z.string().nullable(),
  export: exportRef.nullable(),
  unlockedAt: z.string().nullable(),
  unlockedBy: person.nullable(),
  unlockReason: z.string().nullable(),
  version: z.number(),
})
export type PeriodLock = z.infer<typeof lockSchema>

const lockRef = z.object({ id: z.string(), level: z.enum(LOCK_LEVELS), status: z.enum(LOCK_STATUSES), version: z.number() })
export type LockRef = z.infer<typeof lockRef>

export const monthSchema = z.object({
  period: periodSchema,
  ended: z.boolean(),
  lock: lockRef.nullable(),
  exports: z.array(z.object({ id: z.string(), number: z.string().nullable(), status: z.enum(EXPORT_STATUSES), exportedAt: z.string().nullable(), supersedesId: z.string().nullable() })),
  latest: exportRef.nullable(),
})
export type MonthView = z.infer<typeof monthSchema>

export const periodsSchema = z.object({ company, year: z.number(), yearEndMonth: z.string(), months: z.array(monthSchema) })
export type Periods = z.infer<typeof periodsSchema>

/** One sum of a package (TAXABLE, VAT, GROSS, RECEIVED, REFUNDED, NOT_PLACED, VALUE): its amount absent without the grain. */
const sumSchema = z.object({ key: z.string(), currency: z.string().nullable(), amount: z.number().optional() })
export type PackageSum = z.infer<typeof sumSchema>

export const contentSchema = z.object({
  package: pkg,
  available: z.boolean(),
  grain: z.enum(['price', 'cost']),
  scope: z.enum(['DOCUMENTS', 'WHOLE']),
  documents: differenceSchema,
  rows: z.number(),
  priceTotals: z.array(sumSchema),
  costTotals: z.array(sumSchema),
})
export type PackageContent = z.infer<typeof contentSchema>

export const periodAnswerSchema = z.object({
  company,
  period: periodSchema,
  ended: z.boolean(),
  yearEnd: z.boolean(),
  lock: lockSchema.nullable(),
  exports: z.array(exportRef.extend({ exportedAt: z.string().nullable() })),
  reExportOf: exportRef.nullable(),
  draft: exportRef.nullable(),
  nextNumber: z.string().nullable(),
  packages: z.array(pkg),
  checks: z.array(checkSchema),
  failing: z.number(),
  contents: z.array(contentSchema),
  intrastat: z.object({ rows: z.number(), fileRows: z.number(), blocking: z.number(), warnings: z.number() }).nullable(),
  changes: z.number(),
  layout: z.string(),
})
export type PeriodAnswer = z.infer<typeof periodAnswerSchema>

export const intrastatFlagSchema = z.object({
  code: z.enum(INTRASTAT_FLAG_CODES),
  severity: z.enum(['BLOCKING', 'WARNING']),
  fix: z.object({ recordType: z.string(), recordId: z.string(), field: z.string().nullable() }).nullable(),
})
export type IntrastatFlag = z.infer<typeof intrastatFlagSchema>

export const intrastatRowSchema = z.object({
  invoice: z.object({ id: z.string(), number: z.string(), docType: z.string(), issueDate: z.string() }),
  line: z.object({ id: z.string(), seq: z.number(), description: z.string() }),
  style: z.object({ id: z.string(), code: z.string() }).nullable(),
  partner: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  partnerVatId: z.string().nullable(),
  destinationCountry: z.string().nullable(),
  cnCode: z.string().nullable(),
  originCountry: z.string().nullable(),
  value: z.number().optional(),
  currency: z.string(),
  netMassKg: z.string().nullable(),
  supplementaryUnits: z.string(),
  nature: z.enum(['SALE', 'RETURN']),
  suggestedNatureCode: z.string(),
  deliveryTerms: z.string().nullable(),
  transportMode: z.string().nullable(),
  flags: z.array(intrastatFlagSchema),
})
export type IntrastatRow = z.infer<typeof intrastatRowSchema>

export const intrastatSchema = z.object({
  period: periodSchema,
  rows: z.array(intrastatRowSchema),
  fileRows: z.array(z.object({ partnerVatId: z.string().nullable(), destinationCountry: z.string().nullable(), cnCode: z.string().nullable(), documents: z.array(z.string()) })),
  blocking: z.number(),
  warnings: z.number(),
  values: z.array(z.object({ currency: z.string(), value: z.number().optional() })),
})
export type Intrastat = z.infer<typeof intrastatSchema>

const lockAnswer = z.object({ lock: lockSchema, warnings: z.array(z.object({ code: z.string() })) })
export type LockAnswer = z.infer<typeof lockAnswer>

const seg = (value: string) => encodeURIComponent(value)
const clean = (query: Readonly<Record<string, string | number | null | undefined>>) => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== null && value !== undefined && value !== ''))

// ---- reads ---------------------------------------------------------------------------------------------------------------

export interface ExportsQuery {
  readonly companyId: string | null
  readonly status?: ExportStatus | null
  readonly year?: number | null
  readonly cursor?: string | null
}

/** GET /accounting/exports: the batches, newest month first (50 a page). */
export function listExports(api: ApiClient, query: ExportsQuery, signal?: AbortSignal): Promise<ExportsPage> {
  return api.get('/accounting/exports', { query: clean({ companyId: query.companyId, status: query.status, year: query.year, cursor: query.cursor, limit: 50 }), schema: exportsSchema, signal })
}

/** GET /accounting/exports/:id: one batch with its checks as kept, its files and what may be done with it. */
export function getExport(api: ApiClient, exportId: string, signal?: AbortSignal): Promise<ExportRecord> {
  return api.get(`/accounting/exports/${seg(exportId)}`, { schema: exportAnswer, signal }).then((answer) => answer.export)
}

/** GET /accounting/periods?year: the twelve months, each with its lock and batches (1 · Period). */
export function getPeriods(api: ApiClient, companyId: string, year: number, signal?: AbortSignal): Promise<Periods> {
  return api.get('/accounting/periods', { query: { companyId, year }, schema: periodsSchema, signal })
}

/** GET /accounting/periods/:month?packages: the wizard's month — checks, contents, review, the number it will get. */
export function getPeriod(api: ApiClient, companyId: string, month: string, packages: readonly AccountingPackage[], signal?: AbortSignal): Promise<PeriodAnswer> {
  return api.get(`/accounting/periods/${seg(month)}`, { query: clean({ companyId, packages: packages.join(',') }), schema: periodAnswerSchema, signal })
}

/** GET /accounting/intrastat: the month's EU sale rows, each flag with what fixes it. */
export function getIntrastat(api: ApiClient, companyId: string, month: string, signal?: AbortSignal): Promise<Intrastat> {
  return api.get('/accounting/intrastat', { query: { companyId, month }, schema: intrastatSchema, signal })
}

/** GET /accounting/locks: the period locks of the company, newest month first. */
export function listLocks(api: ApiClient, companyId: string, signal?: AbortSignal): Promise<PeriodLock[]> {
  return api.get('/accounting/locks', { query: { companyId }, schema: z.object({ locks: z.array(lockSchema) }), signal }).then((answer) => answer.locks)
}

/** GET …/files/:fileId/download: a 60-second link to a file of a batch (its package's grain). */
export function fileLink(api: ApiClient, exportId: string, fileId: string): Promise<Presigned> {
  return api.get(`/accounting/exports/${seg(exportId)}/files/${seg(fileId)}/download`, { schema: z.object({ download: presignedSchema }) }).then((answer) => answer.download)
}

// ---- writes (each with its own Idempotency-Key: a repeat answers the same) ------------------------------------------------

export interface CreateExportBody {
  readonly companyId: string
  readonly month: string
  readonly packages: readonly AccountingPackage[]
  readonly explanations: ReadonlyArray<{ readonly code: CheckCode; readonly explanation: string }>
  /** A re-export: the month's latest batch it amends (only the changes go). */
  readonly supersedesId?: string
  readonly note?: string
  readonly language: 'it' | 'en'
}

/** POST /accounting/exports: the month's numbered batch, made in the request (files first, then the number). */
export function createExport(api: ApiClient, body: CreateExportBody, idempotencyKey = newIdempotencyKey()): Promise<ExportRecord> {
  return api.post('/accounting/exports', { body, schema: exportAnswer, idempotencyKey }).then((answer) => answer.export)
}

/** POST /accounting/exports/:id/cancel: a draft abandoned, with the reason. */
export function cancelExport(api: ApiClient, exportId: string, body: { version: number; reason: string }, idempotencyKey = newIdempotencyKey()): Promise<ExportRecord> {
  return api.post(`/accounting/exports/${seg(exportId)}/cancel`, { body, schema: exportAnswer, idempotencyKey }).then((answer) => answer.export)
}

export interface LockBody {
  readonly companyId: string
  readonly month: string
  readonly level: LockLevel
  /** A hard lock: `close October 2026` or `chiudi ottobre 2026`. */
  readonly phrase?: string
  readonly note?: string
  /** The month's lock row when it has one (a soft lock made hard, a lifted lock locked again). */
  readonly version?: number
}

/** POST /accounting/locks: the month locked soft (warnings say what a hard lock would wait for) or hard (the typed phrase). */
export function lockMonth(api: ApiClient, body: LockBody, idempotencyKey = newIdempotencyKey()): Promise<LockAnswer> {
  return api.post('/accounting/locks', { body, schema: lockAnswer, idempotencyKey })
}

/** POST /accounting/locks/:id/lift: a lock lifted with a reason (a hard one: accounting.unlock and a fresh step-up). */
export function liftLock(api: ApiClient, lockId: string, body: { version: number; reason: string }, idempotencyKey = newIdempotencyKey()): Promise<PeriodLock> {
  return api.post(`/accounting/locks/${seg(lockId)}/lift`, { body, schema: z.object({ lock: lockSchema }), idempotencyKey }).then((answer) => answer.lock)
}
