import { z } from 'zod'
import { amountMinor, businessDate, currency, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { LINK_STATES } from '@nexus/factory-domain/links/purposes'
import { money } from '@nexus/factory-domain/money/marked'
import { CHECK_PLACES, PAYROLL_CHECKS } from '@nexus/factory-domain/people/payroll/checks'
import { CODE_LIMITS, PAYROLL_CODE_KINDS } from '@nexus/factory-domain/people/payroll/codes'
import { COLUMN_KEYS, LAYOUT_LIMITS, LAYOUT_STARTERS, PAYROLL_FORMATS } from '@nexus/factory-domain/people/payroll/layouts'
import { MONTH_STATES, PAYROLL_EXPORT_STATUSES, PAYROLL_LIMITS, PAYROLL_LINK_TERMS } from '@nexus/factory-domain/people/payroll/rules'
import { VALUE_UNITS } from '@nexus/factory-domain/people/payroll/values'

/**
 * The payroll export (B-W2b-54; MES-267 to MES-274; design people.payroll: the five steps, "Exports", pop-ups "CSV columns", "Send
 * to the labour consultant", "Make correction export"). The views are states, counts and files: no person, no figure. The
 * values per employee code come only from the two recorded POSTs, for people.payroll.records; every amount in them is
 * `money.pay` (the API drops it for everyone else). A list never names a person (Owner answer W1); the file is by employee
 * code, never by name.
 */

const month = z.string().regex(/^\d{4}-\d{2}$/)
const count = z.number().int().min(0)
const version = z.number().int().min(1)
const reason = z.string().trim().min(PAYROLL_LIMITS.reasonMin).max(PAYROLL_LIMITS.reasonMax)
const note = z.string().trim().max(PAYROLL_LIMITS.note)
const kind = z.enum(PAYROLL_CODE_KINDS)
const unit = z.enum(VALUE_UNITS).nullable()
const quantityText = z.string().nullable()
const exportParams = input({ exportId: id() })
const held = output({ allowed: z.boolean(), reason: z.string().nullable() })

export const monthQuery = input({ companyId: id(), month: month.optional(), layoutId: id().optional() })
export type MonthQuery = z.infer<typeof monthQuery>

const checkView = output({ code: z.enum(PAYROLL_CHECKS), blocking: z.boolean(), passed: z.boolean(), count, words: z.string(), place: z.enum(CHECK_PLACES) })

const exportRow = output({
  id: id(),
  companyId: id(),
  company: output({ code: z.string(), legalName: z.string() }),
  month,
  label: z.string(),
  number: z.string().nullable(),
  /** 1 for the first file; a correction is v2, v3 … */
  revision: z.number().int(),
  status: z.enum(PAYROLL_EXPORT_STATUSES),
  correctionOfId: id().nullable(),
  /** The correction that replaced it. */
  correctedById: id().nullable(),
  layout: output({ id: id(), name: z.string(), format: z.enum(PAYROLL_FORMATS), provider: z.string().nullable(), confirmed: z.boolean(), words: z.string().nullable() }),
  madeBy: output({ id: id(), name: z.string().nullable() }).nullable(),
  createdAt: instant(),
  exportedAt: instant().nullable(),
  /** The SHA-256 of the data file: the DocumentSeal. */
  seal: z.string().nullable(),
  /** Who it went to by secure link. */
  sentTo: z.array(z.string()),
  downloadedAt: instant().nullable(),
  /** What this file changed against the one before: "3 people, 7 values". */
  changed: output({ people: count, values: count }).nullable(),
  version: z.number().int(),
})

const monthView = output({
  companyId: id(),
  company: output({ code: z.string(), legalName: z.string() }),
  month,
  label: z.string(),
  sites: z.array(output({ siteId: id(), code: z.string(), name: z.string(), gateOpen: z.boolean() })),
  state: z.enum(MONTH_STATES),
  words: z.string(),
  /** The month close (Attendance): it must be closed. */
  close: output({ state: z.enum(['OPEN', 'CLOSED']), closeId: id().nullable(), words: z.string() }),
  checks: z.array(checkView),
  /** How many blocking checks stand in the way ("Continue" is held with this). */
  blocking: count,
  /** People on the file. A count: their figures open only with the right. */
  people: count,
  piecePayOn: z.boolean(),
  payPeriodId: id().nullable(),
  /** The latest file of the month, and what stands different from it now. */
  latest: exportRow.nullable(),
  correction: output({ people: count, values: count, corrections: count }).nullable(),
  /** What the labour consultant must confirm (GATE-PAYROLL). */
  toConfirm: z.array(z.string()),
  /** The file carries amounts: making it asks the pay grain. */
  carriesPay: z.boolean(),
  actions: output({ export: held, correct: held, preview: held }),
})
export const monthContract = defineContract({ querystring: monthQuery, response: { 200: monthView } })

export const showBody = input({ companyId: id(), month, code: z.enum(PAYROLL_CHECKS) })
export type ShowBody = z.infer<typeof showBody>
export const showContract = defineContract({
  body: showBody,
  response: {
    200: output({
      code: z.enum(PAYROLL_CHECKS),
      place: z.enum(CHECK_PLACES),
      people: z.array(output({ employeeId: id(), name: z.string(), employeeCode: z.string().nullable(), lastDay: businessDate().nullable() })),
      codes: z.array(output({ kind, ourCode: z.string(), meaning: z.string() })),
    }),
  },
})

const valueCell = output({
  kind,
  code: z.string(),
  providerCode: z.string().nullable(),
  meaning: z.string(),
  unit,
  quantity: quantityText,
  minutes: z.number().int().nullable(),
  amount: money.pay(amountMinor().nullable()),
  currency: currency().nullable(),
})
const personRow = output({ employeeId: id().nullable(), employeeCode: z.string().nullable(), lastDay: businessDate().nullable(), cells: z.array(valueCell) })
const codeSum = output({ kind, code: z.string(), providerCode: z.string().nullable(), meaning: z.string(), unit, quantity: quantityText, amount: money.pay(amountMinor().nullable()), currency: currency().nullable(), people: count })
const changeRow = output({
  employeeCode: z.string(),
  kind,
  code: z.string(),
  meaning: z.string(),
  unit,
  change: z.enum(['ADDED', 'REMOVED', 'CHANGED']),
  fromQuantity: quantityText,
  toQuantity: quantityText,
  fromAmount: money.pay(amountMinor().nullable()),
  toAmount: money.pay(amountMinor().nullable()),
  fromProviderCode: z.string().nullable(),
  toProviderCode: z.string().nullable(),
  currency: currency().nullable(),
})
const valuesView = output({
  month,
  label: z.string(),
  people: z.array(personRow),
  /** Sums per company, per code. */
  sums: z.array(codeSum),
  /** A correction: what differs from the file before. */
  changes: output({ people: count, values: count, rows: z.array(changeRow) }).nullable(),
  /** The amounts were left out: the caller does not hold the pay grain. */
  payShown: z.boolean(),
})
export const previewBody = input({ companyId: id(), month })
export type PreviewBody = z.infer<typeof previewBody>
export const previewContract = defineContract({ body: previewBody, response: { 200: valuesView } })
export const exportValuesContract = defineContract({ params: exportParams, response: { 200: valuesView } })

// ---- the code mapping --------------------------------------------------------------------------------------------------

const codeRow = output({
  id: id().nullable(),
  kind,
  ourCode: z.string(),
  meaning: z.string(),
  providerCode: z.string().nullable(),
  /** A code Nexus no longer writes (kept: a mapping is never deleted). */
  inUse: z.boolean(),
  updatedAt: instant().nullable(),
  version: z.number().int().nullable(),
})
export const codesQuery = input({ companyId: id() })
export type CodesQuery = z.infer<typeof codesQuery>
export const codesContract = defineContract({ querystring: codesQuery, response: { 200: output({ companyId: id(), codes: z.array(codeRow), unmapped: count }) } })
export const putCodeBody = input({
  companyId: id(),
  kind,
  ourCode: z.string().trim().min(1).max(CODE_LIMITS.code),
  providerCode: z.string().trim().min(1).max(CODE_LIMITS.providerCode).nullable(),
  meaning: z.string().trim().min(1).max(CODE_LIMITS.meaning).optional(),
  /** The version read; none for a code with no row yet. */
  version: version.optional(),
})
export type PutCodeBody = z.infer<typeof putCodeBody>
export const putCodeContract = defineContract({ body: putCodeBody, response: { 200: codeRow } })

// ---- layouts -----------------------------------------------------------------------------------------------------------

const columnBody = input({
  key: z.enum(COLUMN_KEYS),
  header: z.string().trim().min(1).max(LAYOUT_LIMITS.header).optional(),
  width: z.number().int().optional(),
  format: z.string().max(20).optional(),
  value: z.string().max(LAYOUT_LIMITS.value).optional(),
})
const definitionBody = input({
  columns: z.array(columnBody).min(1).max(LAYOUT_LIMITS.columns),
  delimiter: z.string().max(1).optional(),
  decimalSeparator: z.string().max(1).optional(),
  dateFormat: z.string().max(12).optional(),
  encoding: z.string().max(12).optional(),
  headerRow: z.boolean().optional(),
  companyCode: z.string().trim().min(1).max(LAYOUT_LIMITS.companyCode).optional(),
})
const confirmationBody = input({ on: businessDate(), by: z.string().trim().min(1).max(LAYOUT_LIMITS.confirmedBy) })
const columnView = output({ key: z.enum(COLUMN_KEYS), header: z.string().optional(), width: z.number().int().optional(), format: z.string().optional(), value: z.string().optional() })
const definitionView = output({
  columns: z.array(columnView),
  delimiter: z.string().optional(),
  decimalSeparator: z.string().optional(),
  dateFormat: z.string().optional(),
  encoding: z.string().optional(),
  headerRow: z.boolean().optional(),
  companyCode: z.string().optional(),
  confirmation: output({ on: businessDate(), by: z.string() }).optional(),
})
const layoutRow = output({
  id: id(),
  companyId: id(),
  name: z.string(),
  format: z.enum(PAYROLL_FORMATS),
  provider: z.string().nullable(),
  definition: definitionView,
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  note: z.string().nullable(),
  confirmed: z.boolean(),
  /** "Not confirmed by the labour consultant …" for a provider layout. */
  words: z.string().nullable(),
  updatedAt: instant(),
  version: z.number().int(),
})
export const layoutsQuery = input({ companyId: id() })
export type LayoutsQuery = z.infer<typeof layoutsQuery>
export const layoutsContract = defineContract({
  querystring: layoutsQuery,
  response: {
    200: output({
      companyId: id(),
      layouts: z.array(layoutRow),
      starters: z.array(output({ key: z.enum(LAYOUT_STARTERS), name: z.string(), format: z.enum(PAYROLL_FORMATS), provider: z.string().nullable(), note: z.string().nullable() })),
      toConfirm: z.array(z.string()),
    }),
  },
})
export const createLayoutBody = input({
  companyId: id(),
  /** Start from one of the starters, or give the whole layout. */
  starter: z.enum(LAYOUT_STARTERS).optional(),
  name: z.string().trim().min(1).max(LAYOUT_LIMITS.name).optional(),
  format: z.enum(PAYROLL_FORMATS).optional(),
  provider: z.string().trim().min(1).max(LAYOUT_LIMITS.provider).nullable().optional(),
  definition: definitionBody.optional(),
  note: note.optional(),
})
export type CreateLayoutBody = z.infer<typeof createLayoutBody>
export const createLayoutContract = defineContract({ body: createLayoutBody, response: { 201: layoutRow } })
export const patchLayoutBody = input({
  version,
  name: z.string().trim().min(1).max(LAYOUT_LIMITS.name).optional(),
  provider: z.string().trim().min(1).max(LAYOUT_LIMITS.provider).nullable().optional(),
  definition: definitionBody.optional(),
  /** Who confirmed the layout against the consultant's sample; null takes it back. */
  confirmation: confirmationBody.nullable().optional(),
  note: note.nullable().optional(),
})
export type PatchLayoutBody = z.infer<typeof patchLayoutBody>
const layoutParams = input({ layoutId: id() })
export const patchLayoutContract = defineContract({ params: layoutParams, body: patchLayoutBody, response: { 200: layoutRow } })
export const archiveLayoutContract = defineContract({ params: layoutParams, body: input({ version }), response: { 200: layoutRow } })

// ---- exports -------------------------------------------------------------------------------------------------------------

export const exportsQuery = input({ companyId: id(), year: z.coerce.number().int().min(2000).max(2100).optional(), limit: z.coerce.number().int().min(1).max(PAYROLL_LIMITS.list).default(PAYROLL_LIMITS.listDefault), cursor: id().optional() })
export type ExportsQuery = z.infer<typeof exportsQuery>
export const exportsContract = defineContract({ querystring: exportsQuery, response: { 200: output({ rows: z.array(exportRow), nextCursor: id().nullable() }) } })

const fileRow = output({ id: id(), seq: z.number().int(), kind: z.enum(['DATA', 'SUMMARY']), format: z.string(), rowCount: count, name: z.string(), contentType: z.string(), sizeBytes: z.number().int(), sha256: z.string() })
const linkRow = output({
  id: id(),
  email: z.string().nullable(),
  state: z.enum(LINK_STATES),
  expiresAt: instant(),
  maxUses: z.number().int(),
  uses: count,
  revokedAt: instant().nullable(),
  createdAt: instant(),
  downloads: z.array(output({ at: instant(), fileId: id() })),
})
const exportRecord = exportRow.extend({
  payPeriodId: id().nullable(),
  checks: z.array(output({ code: z.enum(PAYROLL_CHECKS), blocking: z.boolean(), passed: z.boolean(), count, words: z.string() })),
  files: z.array(fileRow),
  links: z.array(linkRow),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  note: z.string().nullable(),
  carriesPay: z.boolean(),
  words: z.string(),
  actions: output({ correct: held, cancel: held, send: held, open: held }),
})
export const createExportBody = input({
  companyId: id(),
  month,
  /** A correction's default: the layout of the file it replaces. */
  layoutId: id().optional(),
  /** A correction: the month's latest export. */
  correctionOfId: id().optional(),
  note: note.optional(),
})
export type CreateExportBody = z.infer<typeof createExportBody>
export const createExportContract = defineContract({ body: createExportBody, response: { 201: exportRecord } })
export const exportContract = defineContract({ params: exportParams, response: { 200: exportRecord } })
export const cancelBody = input({ version, reason })
export type CancelBody = z.infer<typeof cancelBody>
export const cancelContract = defineContract({ params: exportParams, body: cancelBody, response: { 200: exportRecord } })
export const openFileContract = defineContract({
  params: input({ exportId: id(), fileId: id() }),
  response: { 200: output({ fileId: id(), fileName: z.string(), sha256: z.string(), download: output({ method: z.string(), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: instant() }) }) },
})

export const sendBody = input({
  /** The consultant's address (the mail carries a link, never the file). */
  email: z.string().trim().min(3).max(254),
  expiresInDays: z.number().int().min(1).max(PAYROLL_LINK_TERMS.expiryDays.max).optional(),
  maxUses: z.number().int().min(1).max(PAYROLL_LINK_TERMS.uses.max).optional(),
  message: z.string().trim().max(PAYROLL_LIMITS.message).optional(),
  language: z.enum(['it', 'en']).optional(),
})
export type SendBody = z.infer<typeof sendBody>
export const sendContract = defineContract({
  params: exportParams,
  body: sendBody,
  response: { 201: output({ link: output({ id: id(), email: z.string(), expiresAt: instant(), maxUses: z.number().int() }), withdrawn: z.array(id()), delivery: z.string() }) },
})
export const withdrawBody = input({ reason: reason.optional() })
export type WithdrawBody = z.infer<typeof withdrawBody>
export const withdrawContract = defineContract({ params: input({ exportId: id(), linkId: id() }), body: withdrawBody, response: { 200: output({ id: id(), state: z.enum(LINK_STATES), revokedAt: instant() }) } })

// ---- the link's page ---------------------------------------------------------------------------------------------------------

export const linkFilesContract = defineContract({
  response: {
    200: output({
      sender: z.string(),
      month,
      label: z.string(),
      number: z.string().nullable(),
      revision: z.number().int(),
      link: output({ expiresAt: instant(), usesLeft: count }),
      files: z.array(output({ id: id(), kind: z.enum(['DATA', 'SUMMARY']), name: z.string(), sizeBytes: z.number().int(), sha256: z.string() })),
    }),
  },
})
export const linkDownloadContract = defineContract({
  params: input({ fileId: id() }),
  response: { 200: output({ fileId: id(), fileName: z.string(), usesLeft: count, download: output({ method: z.string(), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: instant() }) }) },
})
