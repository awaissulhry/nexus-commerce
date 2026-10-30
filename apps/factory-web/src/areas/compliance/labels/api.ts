import { z } from 'zod'
import { SOURCE_KINDS } from '@nexus/factory-domain/compliance/labels/render'
import { LABEL_FIELDS, LABEL_TEMPLATE_STATUSES, LAYOUT_PRESET_KEYS, MANUFACTURE_DATE_FORMATS } from '@nexus/factory-domain/compliance/labels/rules'
import { styleRow, styleView, type StyleRow, type StyleView } from '@nexus/factory-domain/product/styles/contracts'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * Every call Labels & marking makes (SCR-053): the garment label templates (apps/factory-api modules/compliance/labels —
 * its contract lives in the API source, so the answers are checked here against local schemas that mirror
 * `templateView`, `templateDetail`, `renderedLabelView` and the preview's `values`; unknown fields are ignored, so a new
 * field never breaks the page), the print service (printers, a test print's job, the label's test prints) and the
 * styles a label is for. Every write sends the version it was made on (COL-078) and an idempotency key.
 */

const issue = z.object({ path: z.string(), message: z.string() })
const status = z.enum(LABEL_TEMPLATE_STATUSES)

export const layoutSchema = z.object({
  preset: z.enum(LAYOUT_PRESET_KEYS),
  fields: z.array(z.enum(LABEL_FIELDS)),
  notifiedBodyNumber: z.string().nullable(),
  manufactureDate: z.enum(MANUFACTURE_DATE_FORMATS),
  texts: z.object({ animalOrigin: z.record(z.string(), z.string()) }),
})

export const templateSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  code: z.string(),
  revision: z.number().int(),
  name: z.string(),
  styleId: z.string().nullable(),
  style: z.object({ id: z.string(), code: z.string(), name: z.string(), ppeCategory: z.string(), ppeStandard: z.string().nullable(), ppeClass: z.string().nullable() }).nullable(),
  status,
  languages: z.array(z.string()),
  makerPartyId: z.string().nullable(),
  makerName: z.string(),
  makerAddress: z.string(),
  importerName: z.string().nullable(),
  importerAddress: z.string().nullable(),
  composition: z.array(z.object({ part: z.string(), fibres: z.array(z.object({ fibre: z.string(), percent: z.string() })) })),
  animalOriginPhrase: z.boolean(),
  care: z.array(z.object({ symbol: z.string(), text: z.record(z.string(), z.string()).optional() })),
  layout: layoutSchema,
  widthMm: z.string(),
  heightMm: z.string(),
  nextStatuses: z.array(status),
  problems: z.array(issue),
  warnings: z.array(issue),
  activatable: z.boolean(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type LabelTemplate = z.infer<typeof templateSchema>
export type LabelIssue = z.infer<typeof issue>

export const detailSchema = templateSchema.extend({
  revisions: z.array(z.object({ id: z.string(), revision: z.number().int(), status, version: z.number().int(), updatedAt: z.string() })),
  usage: z.object({
    styleRevisions: z.array(z.object({ id: z.string(), styleId: z.string(), styleCode: z.string(), revision: z.number().int(), status: z.string() })),
    workOrders: z.object({ count: z.number().int(), shown: z.array(z.object({ id: z.string(), number: z.string(), status: z.string(), batchNumber: z.string().nullable() })) }),
  }),
})
export type LabelDetail = z.infer<typeof detailSchema>

const graphic = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('CE'), notifiedBodyNumber: z.string().nullable() }),
    z.object({ kind: z.literal('PICTOGRAM'), pictogram: z.enum(['MOTORCYCLIST', 'GLOVE', 'NONE']), standardCode: z.string().nullable(), ppeClass: z.string().nullable() }),
    z.object({ kind: z.literal('CARE'), symbols: z.array(z.object({ code: z.string(), mark: z.string(), words: z.string() })) }),
    z.object({ kind: z.literal('BARCODE'), value: z.string().nullable() }),
  ])
  .nullable()

export const renderedSchema = z.object({
  template: z.object({ id: z.string(), code: z.string(), revision: z.number().int(), status, name: z.string() }),
  sample: z.boolean(),
  banner: z.array(z.string()),
  preset: z.enum(LAYOUT_PRESET_KEYS),
  languages: z.array(z.string()),
  blocks: z.array(
    z.object({
      field: z.enum(LABEL_FIELDS),
      value: z.string().nullable(),
      lines: z.array(z.object({ text: z.string(), language: z.string().nullable() })),
      graphic,
      placeholder: z.boolean(),
      source: z.object({ kind: z.enum(SOURCE_KINDS), words: z.string(), recordType: z.string().nullable(), recordId: z.string().nullable() }),
      height: z.number().int(),
    }),
  ),
  fit: z.object({ widthMm: z.string(), heightMm: z.string(), neededMm: z.string(), availableMm: z.string(), charsPerLine: z.number().int(), fits: z.boolean() }).nullable(),
  problems: z.array(issue),
  warnings: z.array(issue),
  printable: z.boolean(),
})
export type Rendered = z.infer<typeof renderedSchema>
export type RenderedBlock = Rendered['blocks'][number]

const measure = z.object({ min: z.string().nullable(), max: z.string().nullable(), unit: z.string() })

/** What the server rendered the cell with: the browser renders a draft being typed with the same values. */
export const valuesSchema = z.object({
  style: z.object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    companyId: z.string().nullable(),
    productType: z.string(),
    ppeCategory: z.string(),
    ppeStandard: z.string().nullable(),
    ppeClass: z.string().nullable(),
    brandPartyId: z.string().nullable(),
  }),
  colourway: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  size: z.object({ code: z.string(), label: z.string().nullable(), scaleId: z.string(), scaleCode: z.string(), bodyMeasures: z.record(z.string(), measure).nullable() }).nullable(),
  certificate: z
    .object({
      outcome: z.enum(['covered', 'not_required', 'refused']),
      certificate: z.object({ id: z.string(), number: z.string(), standard: z.string(), ppeClass: z.string().nullable(), validTo: z.string() }).nullable(),
      reasons: z.array(z.string()),
      date: z.string(),
    })
    .nullable(),
  identification: z.object({ kind: z.enum(['BATCH', 'SERIAL']) }),
  date: z.string(),
  marketLanguages: z.array(z.string()),
})
export type CellValues = z.infer<typeof valuesSchema>

export const cellSchema = z.object({
  styleId: z.string(),
  styleCode: z.string(),
  styleRevisionId: z.string().nullable(),
  revision: z.number().int().nullable(),
  colourwayId: z.string().nullable(),
  size: z.string().nullable(),
  date: z.string(),
  certificate: z.object({ outcome: z.enum(['covered', 'not_required', 'refused']), number: z.string().nullable(), reasons: z.array(z.string()) }).nullable(),
})
export type PreviewCell = z.infer<typeof cellSchema>

const previewSchema = z.object({ label: renderedSchema, cell: cellSchema, values: valuesSchema })
export type Preview = z.infer<typeof previewSchema>

export const PRINT_JOB_STATUSES = ['QUEUED', 'SENT', 'PRINTED', 'FAILED'] as const
export const printJobSchema = z.object({
  id: z.string(),
  printerId: z.string(),
  recordType: z.string(),
  recordId: z.string(),
  copies: z.number().int(),
  status: z.enum(PRINT_JOB_STATUSES),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  sentAt: z.string().nullable(),
  printedAt: z.string().nullable(),
  failedAt: z.string().nullable(),
  createdAt: z.string(),
})
export type PrintJob = z.infer<typeof printJobSchema>

export const printerSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  code: z.string(),
  name: z.string(),
  kind: z.string(),
  dpi: z.number().int().nullable(),
  labelWidthMm: z.number().int().nullable(),
  labelHeightMm: z.number().int().nullable(),
  status: z.string(),
})
export type Printer = z.infer<typeof printerSchema>

export type { StyleRow, StyleView }

const enc = encodeURIComponent
const labelPath = (id: string) => `/compliance/labels/${enc(id)}`
const key = () => ({ idempotencyKey: newIdempotencyKey() })
const one = z.object({ template: detailSchema })

// ---- reads -------------------------------------------------------------------------------------------------------------------

export function listTemplates(api: ApiClient, query: { status?: LabelTemplate['status'] | null; styleId?: string | null } = {}, signal?: AbortSignal): Promise<{ templates: LabelTemplate[]; today: string }> {
  return api.get('/compliance/labels', { query: { status: query.status ?? undefined, styleId: query.styleId ?? undefined }, schema: z.object({ templates: z.array(templateSchema), today: z.string() }), signal })
}

export function getTemplate(api: ApiClient, templateId: string, signal?: AbortSignal): Promise<LabelDetail> {
  return api.get(labelPath(templateId), { schema: one, signal }).then((answer) => answer.template)
}

/** The cell a preview is drawn for; left out: the label's style, its first active colourway, its base size, today. */
export interface PreviewAsk {
  styleId?: string | null
  colourwayId?: string | null
  size?: string | null
  languages?: readonly string[]
  date?: string | null
}

const cellQuery = (ask: PreviewAsk) => ({
  styleId: ask.styleId ?? undefined,
  colourwayId: ask.colourwayId ?? undefined,
  size: ask.size ?? undefined,
  languages: ask.languages && ask.languages.length > 0 ? ask.languages.join(',') : undefined,
  date: ask.date ?? undefined,
})

export function previewLabel(api: ApiClient, templateId: string, ask: PreviewAsk, signal?: AbortSignal): Promise<Preview> {
  return api.get(`${labelPath(templateId)}/preview`, { query: cellQuery(ask), schema: previewSchema, signal })
}

/** The print sheet: the SAMPLE label as a PDF of its size (an attachment the API stores nowhere). */
export function previewPdf(api: ApiClient, templateId: string, ask: PreviewAsk): Promise<Uint8Array> {
  return api.bytes(`${labelPath(templateId)}/preview/pdf`, { query: cellQuery(ask) })
}

/** Styles a label may be for (a search over code and name; product.styles.view). */
export function findStyles(api: ApiClient, q: string, signal?: AbortSignal): Promise<StyleRow[]> {
  return api
    .get('/product/styles', { query: { q: q.trim() || undefined, status: 'OPEN', limit: 20 }, schema: z.object({ styles: z.array(styleRow) }), signal })
    .then((answer) => answer.styles)
}

/** The label's style with its colourways and range (the preview's cell choices). */
export function getStyle(api: ApiClient, styleId: string, signal?: AbortSignal): Promise<StyleView> {
  return api.get(`/product/styles/${enc(styleId)}`, { schema: z.object({ style: styleView }), signal }).then((answer) => answer.style)
}

export function listPrinters(api: ApiClient, signal?: AbortSignal): Promise<Printer[]> {
  return api.get('/print/printers', { schema: z.object({ printers: z.array(printerSchema) }), signal }).then((answer) => answer.printers)
}

/** The label's test prints (the print service keeps every job of the record; garment labels are their work orders'). */
export function listTestPrints(api: ApiClient, templateId: string, signal?: AbortSignal): Promise<PrintJob[]> {
  return api.get('/print/jobs', { query: { recordType: 'LabelTemplate', recordId: templateId }, schema: z.object({ jobs: z.array(printJobSchema) }), signal }).then((answer) => answer.jobs)
}

export function getPrintJob(api: ApiClient, jobId: string, signal?: AbortSignal): Promise<PrintJob> {
  return api.get(`/print/jobs/${enc(jobId)}`, { schema: z.object({ job: printJobSchema }), signal }).then((answer) => answer.job)
}

export function retryPrintJob(api: ApiClient, jobId: string): Promise<PrintJob> {
  return api.post(`/print/jobs/${enc(jobId)}/retry`, { body: {}, schema: z.object({ job: printJobSchema }), ...key() }).then((answer) => answer.job)
}

// ---- writes ------------------------------------------------------------------------------------------------------------------

export interface NewLabelInput {
  code?: string
  styleId: string | null
  fromTemplateId?: string
  languages: string[]
  widthMm: string
  heightMm: string
}

export function createTemplate(api: ApiClient, input: NewLabelInput): Promise<LabelDetail> {
  return api
    .post('/compliance/labels', {
      body: {
        ...(input.code ? { code: input.code } : {}),
        styleId: input.styleId,
        ...(input.fromTemplateId ? { fromTemplateId: input.fromTemplateId } : {}),
        languages: input.languages,
        widthMm: input.widthMm,
        heightMm: input.heightMm,
      },
      schema: one,
      ...key(),
    })
    .then((answer) => answer.template)
}

/** The content fields a draft's save sends (only those that changed). */
export type ContentPatch = Partial<Pick<LabelTemplate, 'name' | 'languages' | 'makerName' | 'makerAddress' | 'importerName' | 'importerAddress' | 'composition' | 'animalOriginPhrase' | 'care' | 'layout' | 'widthMm' | 'heightMm'>>

export function updateTemplate(api: ApiClient, template: Pick<LabelTemplate, 'id' | 'version'>, patch: ContentPatch): Promise<LabelDetail> {
  return api.request('PATCH', labelPath(template.id), { body: { ...patch, version: template.version }, schema: one, ...key() }).then((answer) => answer.template)
}

export function activateTemplate(api: ApiClient, template: Pick<LabelTemplate, 'id' | 'version'>): Promise<LabelDetail> {
  return api.post(`${labelPath(template.id)}/activate`, { body: { version: template.version }, schema: one, ...key() }).then((answer) => answer.template)
}

export function retireTemplate(api: ApiClient, template: Pick<LabelTemplate, 'id' | 'version'>, reason: string): Promise<LabelDetail> {
  return api.post(`${labelPath(template.id)}/retire`, { body: { version: template.version, ...(reason.trim() ? { reason: reason.trim() } : {}) }, schema: one, ...key() }).then((answer) => answer.template)
}

export function reviseTemplate(api: ApiClient, templateId: string): Promise<LabelDetail> {
  return api.post(`${labelPath(templateId)}/revisions`, { body: {}, schema: one, ...key() }).then((answer) => answer.template)
}

export function testPrint(api: ApiClient, templateId: string, input: { printerId: string; copies: number } & PreviewAsk): Promise<{ job: PrintJob; label: Rendered }> {
  const cell = cellQuery(input)
  return api.post(`${labelPath(templateId)}/test-print`, {
    body: { printerId: input.printerId, copies: input.copies, ...Object.fromEntries(Object.entries(cell).filter(([, value]) => value !== undefined)) },
    schema: z.object({ job: printJobSchema, label: renderedSchema }),
    ...key(),
  })
}
