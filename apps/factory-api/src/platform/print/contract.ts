import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { LABEL_FIELDS, LABEL_KINDS, LABEL_LANGUAGES } from '@nexus/factory-domain/labels/model'
import { MAX_LABEL_COPIES, MAX_LABEL_MM, MIN_LABEL_HEIGHT_MM, MIN_LABEL_WIDTH_MM } from '@nexus/factory-domain/labels/zpl'
import { PRINT_RELAY_KINDS } from '../../adapters/print-relay/port'
import { RECORD_TYPE } from '../files/rules'
import { MODULE_LABEL_KINDS, PAYLOAD_KINDS, PRINT_JOB_STATUSES, PRINTER_CODE, PRINTER_KINDS, PRINTER_STATUSES } from './rules'

/**
 * The print routes' contracts (plan A1 §3.9; GAP-007). A floor device's view of a printer leaves out where the relay
 * reaches it; a job's ZPL is only in the answer about that one job.
 */

export const printerView = output({
  id: id(),
  companyId: id(),
  siteId: id(),
  code: z.string(),
  name: z.string(),
  kind: z.enum(PRINTER_KINDS),
  relay: z.enum(PRINT_RELAY_KINDS),
  relayTarget: z.string().optional(),
  dpi: z.number().int().nullable(),
  labelWidthMm: z.number().int().nullable(),
  labelHeightMm: z.number().int().nullable(),
  status: z.enum(PRINTER_STATUSES),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type PrinterView = z.infer<typeof printerView>

export const printJobView = output({
  id: id(),
  companyId: id(),
  siteId: id(),
  printerId: id(),
  recordType: z.string(),
  recordId: id(),
  payloadKind: z.enum(PAYLOAD_KINDS),
  labelKind: z.enum([...LABEL_KINDS, ...MODULE_LABEL_KINDS]).nullable(),
  scanId: z.string().nullable(),
  fileId: id().nullable(),
  copies: z.number().int(),
  status: z.enum(PRINT_JOB_STATUSES),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  relayJobId: z.string().nullable(),
  sentAt: instant().nullable(),
  printedAt: instant().nullable(),
  failedAt: instant().nullable(),
  requestedById: id().nullable(),
  deviceId: id().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
  /** Only in the answer about one job. */
  zpl: z.string().nullable().optional(),
})
export type PrintJobView = z.infer<typeof printJobView>

const FIELD_KEYS = [...new Set(Object.values(LABEL_FIELDS).flat())] as [string, ...string[]]

/** A label as a module (or a floor screen) asks for it; checked and worded by factory-domain composeLabel. */
export const labelBody = input({
  kind: z.enum(LABEL_KINDS),
  language: z.enum(LABEL_LANGUAGES).default('it'),
  /** The thing's scannable id (`HD-7K-0003RJ-M`): it must be this tenant's, of the label's kind. */
  scanId: z.string().min(1).max(40),
  maker: z.string().max(80).nullish(),
  title: z.string().min(1).max(200),
  fields: z.partialRecord(z.enum(FIELD_KEYS), z.string().max(200).nullable()).optional(),
})

const copies = () => z.number().int().min(1).max(MAX_LABEL_COPIES).default(1)
const stockMm = (min: number) => z.number().int().min(min).max(MAX_LABEL_MM)
const one = { 200: output({ printer: printerView }) }

export const listPrintersContract = defineContract({
  querystring: input({ siteId: id().optional(), includeArchived: z.coerce.boolean().default(false) }),
  response: { 200: output({ printers: z.array(printerView) }) },
})

export const createPrinterContract = defineContract({
  body: input({
    siteId: id(),
    code: z.string().regex(PRINTER_CODE),
    name: z.string().trim().min(1).max(120),
    kind: z.enum(PRINTER_KINDS),
    relay: z.enum(PRINT_RELAY_KINDS),
    relayTarget: z.string().trim().min(1).max(200),
    dpi: z.number().int().nullish(),
    labelWidthMm: stockMm(MIN_LABEL_WIDTH_MM).nullish(),
    labelHeightMm: stockMm(MIN_LABEL_HEIGHT_MM).nullish(),
  }),
  response: { 201: output({ printer: printerView }) },
})

export const updatePrinterContract = defineContract({
  params: input({ printerId: id() }),
  body: input({
    version: z.number().int().min(1),
    name: z.string().trim().min(1).max(120).optional(),
    relayTarget: z.string().trim().min(1).max(200).optional(),
    dpi: z.number().int().nullish(),
    labelWidthMm: stockMm(MIN_LABEL_WIDTH_MM).nullish(),
    labelHeightMm: stockMm(MIN_LABEL_HEIGHT_MM).nullish(),
    status: z.enum(PRINTER_STATUSES).optional(),
  }),
  response: one,
})

export const queueLabelContract = defineContract({
  body: input({
    printerId: id(),
    /** The record the label is for (`Hide`, `Bundle`…). */
    recordType: z.string().regex(RECORD_TYPE),
    recordId: id(),
    copies: copies(),
    label: labelBody,
  }),
  response: { 201: output({ job: printJobView }) },
})

export const queueDocumentContract = defineContract({
  body: input({ printerId: id(), fileId: id(), copies: copies() }),
  response: { 201: output({ job: printJobView }) },
})

export const listJobsContract = defineContract({
  querystring: input({
    printerId: id().optional(),
    siteId: id().optional(),
    status: z.enum(PRINT_JOB_STATUSES).optional(),
    recordType: z.string().regex(RECORD_TYPE).optional(),
    recordId: id().optional(),
  }),
  response: { 200: output({ jobs: z.array(printJobView) }) },
})

export const getJobContract = defineContract({ params: input({ jobId: id() }), response: { 200: output({ job: printJobView }) } })

export const retryJobContract = defineContract({
  params: input({ jobId: id() }),
  body: input({ version: z.number().int().min(1) }),
  response: { 200: output({ job: printJobView }) },
})

/** The browser fallback for labels: the PDF itself, on the stock given (default 100 × 50 mm), stored nowhere. */
export const labelPdfContract = defineContract({
  body: input({
    label: labelBody,
    widthMm: stockMm(MIN_LABEL_WIDTH_MM).default(100),
    heightMm: stockMm(MIN_LABEL_HEIGHT_MM).default(50),
    copies: copies(),
  }),
  response: {},
})
