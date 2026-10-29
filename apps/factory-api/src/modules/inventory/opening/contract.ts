import { z } from 'zod'
import { amountMinor, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { NUMBER_FORMATS } from '@nexus/factory-domain/imports/cells'
import { money } from '@nexus/factory-domain/money/marked'
import { fileView, presignedView } from '../../../platform/files/contract'

/**
 * Opening stock (B-W1-35; SCM-288, QHS-029; A2 SCR-017, SCR-060): the import's template, the company's opening-stock
 * reports (the existing chromium VI reports' files, uploaded before the sheet that names them), and the summary of a
 * site's opening stock. The import itself runs on the imports routes (`POST /imports` with importer
 * `inventory.opening`). Quantities are decimal strings in the material's base unit; values are the cost grain.
 */

const companyQuery = input({ companyId: id() })

export const templateContract = defineContract({
  querystring: input({ format: z.enum(['csv', 'xlsx']).optional(), numberFormat: z.enum(NUMBER_FORMATS).optional() }),
  response: {},
})

const upload = input({
  companyId: id(),
  originalName: z.string().min(1).max(500),
  /** A PDF, or a scan (JPEG, PNG): the CERTIFICATE kind's types. */
  contentType: z.string().min(1).max(200),
  sizeBytes: z.number().int().min(1),
  sha256: z.string(),
})

export const announceReportContract = defineContract({ body: upload, response: { 201: output({ file: fileView, upload: presignedView }) } })
export const completeReportContract = defineContract({ params: input({ fileId: id() }), response: { 200: output({ file: fileView }) } })

const reportView = output({
  id: id(),
  originalName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  status: z.string(),
  createdAt: instant(),
  /** How many lab results of lots rest on it. */
  results: z.number().int(),
})
export const listReportsContract = defineContract({ querystring: companyQuery, response: { 200: output({ reports: z.array(reportView) }) } })

const value = money.cost(output({ currency: z.string(), valueAmount: money.cost(amountMinor()) }).nullable())
const ref = output({ id: id(), code: z.string() })
const lotStatus = z.enum(['QUARANTINE', 'RELEASED', 'REJECTED', 'BLOCKED'])
const crViStatus = z.enum(['NOT_REQUIRED', 'PENDING', 'PASS', 'FAIL'])
const WAITING = ['CR_VI_RESULT', 'CR_VI_FAILED', 'PPE_DOCUMENTS', 'RELEASE'] as const

const materialView = output({
  item: output({ id: id(), code: z.string(), name: z.string(), baseUom: z.string() }),
  colour: ref.nullable(),
  /** In the base unit, what the opening moves put in (less their reversals). */
  quantity: z.string(),
  hides: z.number().int(),
  lots: z.number().int(),
  words: z.string(),
  value,
})
const lotView = output({
  id: id(),
  code: z.string(),
  item: ref,
  colour: ref.nullable(),
  supplierLotRef: z.string().nullable(),
  dyeBatch: z.string().nullable(),
  qualityStatus: lotStatus,
  crViStatus,
  /** "In quarantine: waits for its chromium VI result …" */
  words: z.string(),
  quantity: z.string(),
  hides: z.number().int(),
  /** Why it waits (QUARANTINE only): its Cr VI result, a failed result to reject, a PPE component's documents, or only the release by a quality person. */
  waitsFor: z.enum(WAITING).nullable(),
  importedById: id().nullable(),
  importedAt: instant(),
})
const jobView = output({
  id: id(),
  status: z.string(),
  rowCount: z.number().int(),
  createCount: z.number().int(),
  unchangedCount: z.number().int(),
  errorCount: z.number().int(),
  appliedCount: z.number().int(),
  skippedCount: z.number().int(),
  createdAt: instant(),
  appliedAt: instant().nullable(),
})

export const summaryContract = defineContract({
  querystring: input({ siteId: id() }),
  response: {
    200: output({
      site: output({ id: id(), code: z.string(), name: z.string(), companyId: id() }),
      lines: z.number().int(),
      /** "37 hides · 412.5 m² · 120 m": never across units. */
      words: z.string(),
      byMaterial: z.array(materialView),
      lots: z.array(lotView),
      waiting: output({ lots: z.number().int(), hides: z.number().int(), byReason: z.record(z.enum(WAITING), z.number().int()), words: z.string() }),
      /** Opening moves no unit cost or standard cost valued. */
      unvaluedLines: z.number().int(),
      value,
      jobs: z.array(jobView),
    }),
  },
})

export { WAITING }
