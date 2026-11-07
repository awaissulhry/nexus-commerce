import { z } from 'zod'
import { LINK_STATES } from '@nexus/factory-domain/links/purposes'
import { CHECK_PLACES, PAYROLL_CHECKS } from '@nexus/factory-domain/people/payroll/checks'
import { PAYROLL_CODE_KINDS } from '@nexus/factory-domain/people/payroll/codes'
import { COLUMN_KEYS, LAYOUT_STARTERS, PAYROLL_FORMATS } from '@nexus/factory-domain/people/payroll/layouts'
import { MONTH_STATES, PAYROLL_EXPORT_STATUSES } from '@nexus/factory-domain/people/payroll/rules'
import { VALUE_UNITS } from '@nexus/factory-domain/people/payroll/values'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * Every call of People › Payroll export (SCR-159; B-W2b-63 on the API of B-W2b-54), with the answer's shape checked (zod;
 * unknown fields are dropped). Nexus does not run payroll: it makes a file for the labour consultant. The views are states,
 * counts and files. The values per employee code come only from the two recorded POSTs (`previewMonth`, `exportValues`) and
 * "Show me" (`showCheck`), each on a person's click; every amount is under the pay grain, so the API may leave it out
 * (optional here). The API's English `words` and `reason` are not read: the screens say their own words from codes.
 */

export type CheckCode = (typeof PAYROLL_CHECKS)[number]
export type CheckPlace = (typeof CHECK_PLACES)[number]
export type CodeKind = (typeof PAYROLL_CODE_KINDS)[number]
export type MonthState = (typeof MONTH_STATES)[number]
export type ExportStatus = (typeof PAYROLL_EXPORT_STATUSES)[number]
export type PayrollFormat = (typeof PAYROLL_FORMATS)[number]
export type ColumnKey = (typeof COLUMN_KEYS)[number]
export type LayoutStarter = (typeof LAYOUT_STARTERS)[number]
export type LinkState = (typeof LINK_STATES)[number]

const seg = (value: string) => encodeURIComponent(value)
const held = z.object({ allowed: z.boolean() })
const pay = z.number().nullable().optional()

// ---- the month -----------------------------------------------------------------------------------------------------------------

const check = z.object({ code: z.enum(PAYROLL_CHECKS), blocking: z.boolean(), passed: z.boolean(), count: z.number(), place: z.enum(CHECK_PLACES) })
export type Check = z.infer<typeof check>

const exportRow = z.object({
  id: z.string(),
  companyId: z.string(),
  company: z.object({ code: z.string(), legalName: z.string(), payrollCode: z.string().nullable() }),
  month: z.string(),
  number: z.string().nullable(),
  revision: z.number(),
  status: z.enum(PAYROLL_EXPORT_STATUSES),
  correctionOfId: z.string().nullable(),
  correctedById: z.string().nullable(),
  layout: z.object({ id: z.string(), name: z.string(), format: z.enum(PAYROLL_FORMATS), provider: z.string().nullable(), confirmed: z.boolean() }),
  madeBy: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  createdAt: z.string(),
  exportedAt: z.string().nullable(),
  seal: z.string().nullable(),
  sentTo: z.array(z.string()),
  downloadedAt: z.string().nullable(),
  changed: z.object({ people: z.number(), values: z.number() }).nullable(),
  version: z.number(),
})
export type ExportRow = z.infer<typeof exportRow>

const monthSchema = z.object({
  companyId: z.string(),
  company: z.object({ code: z.string(), legalName: z.string(), payrollCode: z.string().nullable() }),
  month: z.string(),
  sites: z.array(z.object({ siteId: z.string(), code: z.string(), name: z.string(), gateOpen: z.boolean() })),
  state: z.enum(MONTH_STATES),
  close: z.object({ state: z.enum(['OPEN', 'CLOSED']), closeId: z.string().nullable() }),
  checks: z.array(check),
  blocking: z.number(),
  people: z.number(),
  piecePayOn: z.boolean(),
  payPeriodId: z.string().nullable(),
  latest: exportRow.nullable(),
  correction: z.object({ people: z.number(), values: z.number(), corrections: z.number() }).nullable(),
  carriesPay: z.boolean(),
  actions: z.object({ export: held, correct: held, preview: held }),
})
export type PayrollMonth = z.infer<typeof monthSchema>

export const getMonth = (api: ApiClient, query: { companyId: string; month?: string | null; layoutId?: string | null }) =>
  api.get('/people/payroll/month', { query: { companyId: query.companyId, ...(query.month ? { month: query.month } : {}), ...(query.layoutId ? { layoutId: query.layoutId } : {}) }, schema: monthSchema })

const showSchema = z.object({
  code: z.enum(PAYROLL_CHECKS),
  place: z.enum(CHECK_PLACES),
  people: z.array(z.object({ employeeId: z.string(), name: z.string(), employeeCode: z.string().nullable(), lastDay: z.string().nullable() })),
  codes: z.array(z.object({ kind: z.enum(PAYROLL_CODE_KINDS), ourCode: z.string(), meaning: z.string() })),
})
export type ShowAnswer = z.infer<typeof showSchema>

/** "Show me": recorded when it lists people. On the person's click only; the names live in the dialog's state. */
export const showCheck = (api: ApiClient, body: { companyId: string; month: string; code: CheckCode }) => api.request('POST', '/people/payroll/month/show', { body, schema: showSchema, idempotencyKey: newIdempotencyKey() })

// ---- the values ------------------------------------------------------------------------------------------------------------------

const unit = z.enum(VALUE_UNITS).nullable()
const cell = z.object({ kind: z.enum(PAYROLL_CODE_KINDS), code: z.string(), providerCode: z.string().nullable(), meaning: z.string(), unit, quantity: z.string().nullable(), minutes: z.number().nullable(), amount: pay, currency: z.string().nullable() })
export type ValueCell = z.infer<typeof cell>
const person = z.object({ employeeId: z.string().nullable(), employeeCode: z.string().nullable(), lastDay: z.string().nullable(), cells: z.array(cell) })
export type PersonRow = z.infer<typeof person>
const sum = z.object({ kind: z.enum(PAYROLL_CODE_KINDS), code: z.string(), providerCode: z.string().nullable(), meaning: z.string(), unit, quantity: z.string().nullable(), amount: pay, currency: z.string().nullable(), people: z.number() })
export type CodeSum = z.infer<typeof sum>
const change = z.object({
  employeeCode: z.string(),
  kind: z.enum(PAYROLL_CODE_KINDS),
  code: z.string(),
  meaning: z.string(),
  unit,
  change: z.enum(['ADDED', 'REMOVED', 'CHANGED']),
  fromQuantity: z.string().nullable(),
  toQuantity: z.string().nullable(),
  fromAmount: pay,
  toAmount: pay,
  fromProviderCode: z.string().nullable(),
  toProviderCode: z.string().nullable(),
  currency: z.string().nullable(),
})
export type ChangeRow = z.infer<typeof change>
const valuesSchema = z.object({ month: z.string(), people: z.array(person), sums: z.array(sum), changes: z.object({ people: z.number(), values: z.number(), rows: z.array(change) }).nullable(), payShown: z.boolean() })
export type PayrollValues = z.infer<typeof valuesSchema>

/** The numbers that would be sent: recorded, on the person's step. By employee code, never a name; held in the page's memory only. */
export const previewMonth = (api: ApiClient, body: { companyId: string; month: string }) => api.request('POST', '/people/payroll/preview', { body, schema: valuesSchema, idempotencyKey: newIdempotencyKey() })
/** What a file sent, against the file it replaced: recorded. */
export const exportValues = (api: ApiClient, exportId: string) => api.request('POST', `/people/payroll/exports/${seg(exportId)}/values`, { schema: valuesSchema, idempotencyKey: newIdempotencyKey() })

// ---- the code mapping --------------------------------------------------------------------------------------------------------------

const codeRow = z.object({ id: z.string().nullable(), kind: z.enum(PAYROLL_CODE_KINDS), ourCode: z.string(), meaning: z.string(), providerCode: z.string().nullable(), inUse: z.boolean(), updatedAt: z.string().nullable(), version: z.number().nullable() })
export type CodeRow = z.infer<typeof codeRow>
const codesSchema = z.object({ companyId: z.string(), codes: z.array(codeRow), unmapped: z.number() })
export type CodesAnswer = z.infer<typeof codesSchema>

export const getCodes = (api: ApiClient, companyId: string) => api.get('/people/payroll/codes', { query: { companyId }, schema: codesSchema })
export interface PutCode {
  companyId: string
  kind: CodeKind
  ourCode: string
  providerCode: string | null
  version?: number
}
export const putCode = (api: ApiClient, body: PutCode) => api.request('PUT', '/people/payroll/codes', { body, schema: codeRow, idempotencyKey: newIdempotencyKey() })

// ---- layouts --------------------------------------------------------------------------------------------------------------------

const column = z.object({ key: z.enum(COLUMN_KEYS), header: z.string().optional(), width: z.number().optional(), format: z.string().optional(), value: z.string().optional() })
export type LayoutColumn = z.infer<typeof column>
const definition = z.object({
  columns: z.array(column),
  delimiter: z.string().optional(),
  decimalSeparator: z.string().optional(),
  dateFormat: z.string().optional(),
  encoding: z.string().optional(),
  headerRow: z.boolean().optional(),
})
export type LayoutDefinition = z.infer<typeof definition>
/** Who confirmed a provider layout against the consultant's sample, and when (the layout's columns, B-W2b-89). */
const confirmation = z.object({ on: z.string(), by: z.string() })
const layoutRow = z.object({ id: z.string(), companyId: z.string(), name: z.string(), format: z.enum(PAYROLL_FORMATS), provider: z.string().nullable(), definition, confirmation: confirmation.nullable(), status: z.enum(['ACTIVE', 'ARCHIVED']), note: z.string().nullable(), confirmed: z.boolean(), updatedAt: z.string(), version: z.number() })
export type Layout = z.infer<typeof layoutRow>
const layoutsSchema = z.object({ companyId: z.string(), layouts: z.array(layoutRow), starters: z.array(z.object({ key: z.enum(LAYOUT_STARTERS), name: z.string(), format: z.enum(PAYROLL_FORMATS), provider: z.string().nullable() })) })
export type LayoutsAnswer = z.infer<typeof layoutsSchema>

export const getLayouts = (api: ApiClient, companyId: string) => api.get('/people/payroll/layouts', { query: { companyId }, schema: layoutsSchema })
export const createLayout = (api: ApiClient, body: { companyId: string; starter: LayoutStarter; name?: string }) => api.request('POST', '/people/payroll/layouts', { body, schema: layoutRow, idempotencyKey: newIdempotencyKey() })
export type DefinitionBody = LayoutDefinition
export interface PatchLayout {
  version: number
  name?: string
  definition?: DefinitionBody
  confirmation?: { on: string; by: string } | null
}
export const patchLayout = (api: ApiClient, layoutId: string, body: PatchLayout) => api.request('PATCH', `/people/payroll/layouts/${seg(layoutId)}`, { body, schema: layoutRow, idempotencyKey: newIdempotencyKey() })
export const archiveLayout = (api: ApiClient, layoutId: string, version: number) => api.request('POST', `/people/payroll/layouts/${seg(layoutId)}/archive`, { body: { version }, schema: layoutRow, idempotencyKey: newIdempotencyKey() })

// ---- exports ---------------------------------------------------------------------------------------------------------------------

const exportsSchema = z.object({ rows: z.array(exportRow), nextCursor: z.string().nullable() })
export const listExports = (api: ApiClient, query: { companyId: string; year?: number | null; cursor?: string | null }) =>
  api.get('/people/payroll/exports', { query: { companyId: query.companyId, ...(query.year ? { year: String(query.year) } : {}), ...(query.cursor ? { cursor: query.cursor } : {}) }, schema: exportsSchema })

const fileRow = z.object({ id: z.string(), seq: z.number(), kind: z.enum(['DATA', 'SUMMARY']), format: z.string(), rowCount: z.number(), name: z.string(), contentType: z.string(), sizeBytes: z.number(), sha256: z.string() })
export type ExportFile = z.infer<typeof fileRow>
const linkRow = z.object({
  id: z.string(),
  email: z.string().nullable(),
  state: z.enum(LINK_STATES),
  expiresAt: z.string(),
  maxUses: z.number(),
  uses: z.number(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
  downloads: z.array(z.object({ at: z.string(), fileId: z.string() })),
})
export type ExportLink = z.infer<typeof linkRow>
const exportRecord = exportRow.extend({
  payPeriodId: z.string().nullable(),
  checks: z.array(z.object({ code: z.enum(PAYROLL_CHECKS), blocking: z.boolean(), passed: z.boolean(), count: z.number() })),
  files: z.array(fileRow),
  links: z.array(linkRow),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  note: z.string().nullable(),
  carriesPay: z.boolean(),
  /** The company's labour consultant (People settings, B-W2b-89): Send's address by default. */
  consultant: z.object({ partyId: z.string(), name: z.string().nullable(), email: z.string().nullable() }).nullable(),
  actions: z.object({ correct: held, cancel: held, send: held, open: held }),
})
export type ExportRecord = z.infer<typeof exportRecord>

export const getExport = (api: ApiClient, exportId: string) => api.get(`/people/payroll/exports/${seg(exportId)}`, { schema: exportRecord })

export interface CreateExport {
  companyId: string
  month: string
  layoutId?: string
  correctionOfId?: string
  note?: string
}
/** One request: it answers when the two files are made and the number given. The key stays with the attempt: a repeat finishes the same export. */
export const createExport = (api: ApiClient, body: CreateExport, key: string) => api.request('POST', '/people/payroll/exports', { body, schema: exportRecord, idempotencyKey: key })
export const cancelExport = (api: ApiClient, exportId: string, body: { version: number; reason: string }) => api.request('POST', `/people/payroll/exports/${seg(exportId)}/cancel`, { body, schema: exportRecord, idempotencyKey: newIdempotencyKey() })

const openSchema = z.object({ fileId: z.string(), fileName: z.string(), sha256: z.string(), download: z.object({ method: z.enum(['GET', 'PUT']), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.string() }) })

/** A 60-second link to a file: recorded, on the person's click (amounts ask the pay grain). */
export const openFile = (api: ApiClient, exportId: string, fileId: string) => api.request('POST', `/people/payroll/exports/${seg(exportId)}/files/${seg(fileId)}/open`, { schema: openSchema, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.download)

export interface SendBody {
  email: string
  expiresInDays: number
  maxUses: number
  message?: string
  language: 'it' | 'en'
}
const sendSchema = z.object({ link: z.object({ id: z.string(), email: z.string(), expiresAt: z.string(), maxUses: z.number() }), withdrawn: z.array(z.string()), delivery: z.string() })
export type SendAnswer = z.infer<typeof sendSchema>
export const sendExport = (api: ApiClient, exportId: string, body: SendBody, key: string) => api.request('POST', `/people/payroll/exports/${seg(exportId)}/send`, { body, schema: sendSchema, idempotencyKey: key })
export const withdrawLink = (api: ApiClient, exportId: string, linkId: string) =>
  api.request('POST', `/people/payroll/exports/${seg(exportId)}/links/${seg(linkId)}/withdraw`, { body: {}, schema: z.object({ id: z.string(), state: z.enum(LINK_STATES), revokedAt: z.string() }), idempotencyKey: newIdempotencyKey() })
