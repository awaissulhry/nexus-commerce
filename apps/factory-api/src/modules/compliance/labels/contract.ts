import { z } from 'zod'
import { SOURCE_KINDS } from '@nexus/factory-domain/compliance/labels/render'
import {
  careSchema,
  compositionSchema,
  LABEL_FIELDS,
  LABEL_TEMPLATE_STATUSES,
  labelLayoutSchema,
  LAYOUT_PRESET_KEYS,
  MANUFACTURE_DATE_FORMATS,
  MAX_LANGUAGES,
} from '@nexus/factory-domain/compliance/labels/rules'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { LABEL_DPIS } from '@nexus/factory-domain/labels/zpl'
import { printJobView } from '../../../platform/print/contract'

/**
 * The garment label builder's contracts (B-W1-19; PRD-331; SCR-053). A draft is saved even when it breaks a rule: its
 * `problems` say what keeps it from ACTIVE; the bodies refuse only what is not well formed. Sizes are millimetres as
 * decimal strings ("50.00"). No field carries money.
 */

const status = z.enum(LABEL_TEMPLATE_STATUSES)
const version = () => z.number().int().min(1)
const issue = output({ path: z.string(), message: z.string() })
const text = (max: number) => z.string().trim().max(max)
const mm = () => z.string().trim().regex(/^\d{1,4}(?:\.\d{1,2})?$/, { message: 'Expected millimetres with at most 2 decimals, as "50" or "50.5".' })
const language = () => z.string().trim().toLowerCase().max(8)

const layoutView = output({
  preset: z.enum(LAYOUT_PRESET_KEYS),
  fields: z.array(z.enum(LABEL_FIELDS)),
  notifiedBodyNumber: z.string().nullable(),
  manufactureDate: z.enum(MANUFACTURE_DATE_FORMATS),
  texts: output({ animalOrigin: z.record(z.string(), z.string()) }),
})

export const templateView = output({
  id: id(),
  companyId: id().nullable(),
  code: z.string(),
  revision: z.number().int(),
  name: z.string(),
  styleId: id().nullable(),
  /** The style it is for, with the classification the label marks. */
  style: output({ id: id(), code: z.string(), name: z.string(), ppeCategory: z.string(), ppeStandard: z.string().nullable(), ppeClass: z.string().nullable() }).nullable(),
  status,
  languages: z.array(z.string()),
  makerPartyId: id().nullable(),
  makerName: z.string(),
  makerAddress: z.string(),
  importerName: z.string().nullable(),
  importerAddress: z.string().nullable(),
  composition: z.array(output({ part: z.string(), fibres: z.array(output({ fibre: z.string(), percent: z.string() })) })),
  animalOriginPhrase: z.boolean(),
  care: z.array(output({ symbol: z.string(), text: z.record(z.string(), z.string()).optional() })),
  layout: layoutView,
  widthMm: z.string(),
  heightMm: z.string(),
  nextStatuses: z.array(status),
  /** What keeps it from ACTIVE now (its content, its style's marking needs, the fit), each with its path. */
  problems: z.array(issue),
  warnings: z.array(issue),
  /** A DRAFT without problems. */
  activatable: z.boolean(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type TemplateView = z.infer<typeof templateView>

export const templateDetail = templateView.extend({
  /** Every revision of the code. */
  revisions: z.array(output({ id: id(), revision: z.number().int(), status, version: z.number().int(), updatedAt: instant() })),
  usage: output({
    styleRevisions: z.array(output({ id: id(), styleId: id(), styleCode: z.string(), revision: z.number().int(), status: z.string() })),
    /** Every work order released with it is counted; those the caller may view are listed (50 newest). */
    workOrders: output({ count: z.number().int(), shown: z.array(output({ id: id(), number: z.string(), status: z.string(), batchNumber: z.string().nullable() })) }),
  }),
})
export type TemplateDetail = z.infer<typeof templateDetail>

// ---- the rendered label ---------------------------------------------------------------------------------------------------

const sourceView = output({ kind: z.enum(SOURCE_KINDS), words: z.string(), recordType: z.string().nullable(), recordId: z.string().nullable() })
const graphicView = z
  .discriminatedUnion('kind', [
    output({ kind: z.literal('CE'), notifiedBodyNumber: z.string().nullable() }),
    output({ kind: z.literal('PICTOGRAM'), pictogram: z.enum(['MOTORCYCLIST', 'GLOVE', 'NONE']), standardCode: z.string().nullable(), ppeClass: z.string().nullable() }),
    output({ kind: z.literal('CARE'), symbols: z.array(output({ code: z.string(), mark: z.string(), words: z.string() })) }),
    output({ kind: z.literal('BARCODE'), value: z.string().nullable() }),
  ])
  .nullable()

export const renderedLabelView = output({
  template: output({ id: id(), code: z.string(), revision: z.number().int(), status, name: z.string() }),
  sample: z.boolean(),
  banner: z.array(z.string()),
  preset: z.enum(LAYOUT_PRESET_KEYS),
  languages: z.array(z.string()),
  blocks: z.array(
    output({
      field: z.enum(LABEL_FIELDS),
      value: z.string().nullable(),
      lines: z.array(output({ text: z.string(), language: z.string().nullable() })),
      graphic: graphicView,
      placeholder: z.boolean(),
      source: sourceView,
      /** Hundredths of a millimetre. */
      height: z.number().int(),
    }),
  ),
  fit: output({ widthMm: z.string(), heightMm: z.string(), neededMm: z.string(), availableMm: z.string(), charsPerLine: z.number().int(), fits: z.boolean() }).nullable(),
  problems: z.array(issue),
  warnings: z.array(issue),
  printable: z.boolean(),
})

const cellView = output({
  styleId: id(),
  styleCode: z.string(),
  styleRevisionId: id().nullable(),
  revision: z.number().int().nullable(),
  colourwayId: id().nullable(),
  size: z.string().nullable(),
  date: businessDate(),
  certificate: output({ outcome: z.enum(['covered', 'not_required', 'refused']), number: z.string().nullable(), reasons: z.array(z.string()) }).nullable(),
})

/**
 * The records' values the cell was rendered with (factory-domain `LabelValues` of a SAMPLE, without the batch or serial and
 * the date of manufacture, which a preview never has): with them and a template's content the browser renders a draft
 * as it is typed (`renderLabel`), the same blocks this answer's `label` holds for the saved content.
 */
const measureView = output({ min: z.string().nullable(), max: z.string().nullable(), unit: z.string() })
const valuesView = output({
  style: output({
    id: id(),
    code: z.string(),
    name: z.string(),
    companyId: id().nullable(),
    productType: z.string(),
    ppeCategory: z.string(),
    ppeStandard: z.string().nullable(),
    ppeClass: z.string().nullable(),
    brandPartyId: id().nullable(),
  }),
  colourway: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  size: output({ code: z.string(), label: z.string().nullable(), scaleId: id(), scaleCode: z.string(), bodyMeasures: z.record(z.string(), measureView).nullable() }).nullable(),
  certificate: output({
    outcome: z.enum(['covered', 'not_required', 'refused']),
    certificate: output({ id: id(), number: z.string(), standard: z.string(), ppeClass: z.string().nullable(), validTo: businessDate() }).nullable(),
    reasons: z.array(z.string()),
    date: businessDate(),
  }).nullable(),
  /** BATCH or SERIAL (the style's garment tracking); a preview has no value. */
  identification: output({ kind: z.enum(['BATCH', 'SERIAL']) }),
  date: businessDate(),
  /** The languages the buyer's market needs, as asked. */
  marketLanguages: z.array(z.string()),
})

// ---- routes ------------------------------------------------------------------------------------------------------------------

const templateParams = input({ templateId: id() })
const one = { 200: output({ template: templateDetail }) }

export const listTemplatesContract = defineContract({
  querystring: input({ status: status.optional(), styleId: id().optional(), code: text(32).optional() }),
  response: { 200: output({ templates: z.array(templateView), today: businessDate() }) },
})

export const getTemplateContract = defineContract({ params: templateParams, response: one })

const content = {
  name: text(120).optional(),
  languages: z.array(language()).max(MAX_LANGUAGES).optional(),
  makerPartyId: id().nullish(),
  makerName: text(120).optional(),
  makerAddress: text(300).optional(),
  importerName: text(120).nullish(),
  importerAddress: text(300).nullish(),
  composition: compositionSchema.optional(),
  animalOriginPhrase: z.boolean().optional(),
  care: careSchema.optional(),
  layout: labelLayoutSchema.optional(),
  widthMm: mm().optional(),
  heightMm: mm().optional(),
}

export const createTemplateContract = defineContract({
  body: input({
    /** Default: LBL-<style code> for a style's label; required for a shared one. */
    code: text(32).optional(),
    /** The style it is for; null or left out: shared by several styles. */
    styleId: id().nullish(),
    /** Default: the style's company; null: every company. */
    companyId: id().nullish(),
    /** Start from another template's content (another style's label, a company template). */
    fromTemplateId: id().optional(),
    ...content,
  }),
  response: { 201: output({ template: templateDetail }) },
})

export const updateTemplateContract = defineContract({
  params: templateParams,
  body: input({ version: version(), styleId: id().nullish(), ...content }),
  response: one,
})

export const activateTemplateContract = defineContract({ params: templateParams, body: input({ version: version() }), response: one })
export const retireTemplateContract = defineContract({ params: templateParams, body: input({ version: version(), reason: text(500).optional() }), response: one })
export const reviseTemplateContract = defineContract({ params: templateParams, body: input({}).optional(), response: { 201: output({ template: templateDetail }) } })

const cellQuery = {
  /** The style revision to preview with (its style); or the style; default: the label's own style. */
  styleRevisionId: id().optional(),
  styleId: id().optional(),
  /** Default: the style's first active colourway by code. */
  colourwayId: id().optional(),
  /** Default: the style's base size, else its first. */
  size: z.string().trim().min(1).max(10).optional(),
  /** The languages the buyer's market needs, comma-separated ("de,it"). */
  languages: z
    .string()
    .trim()
    .max(60)
    .regex(/^[a-z]{2}(,[a-z]{2})*$/, { message: 'Expected ISO 639-1 codes separated by commas, as "de,it".' })
    .optional(),
  /** The day of the certificate gate; default today (Europe/Rome). */
  date: businessDate().optional(),
}

export const previewContract = defineContract({
  params: templateParams,
  querystring: input({ ...cellQuery, dpi: z.coerce.number().int().refine((value) => (LABEL_DPIS as readonly number[]).includes(value), { message: `Expected ${LABEL_DPIS.join(', ')}.` }).default(203) }),
  response: { 200: output({ label: renderedLabelView, cell: cellView, values: valuesView, zpl: output({ dpi: z.number().int(), text: z.string() }).nullable() }) },
})

/** The PDF itself (an attachment, stored nowhere). */
export const previewPdfContract = defineContract({ params: templateParams, querystring: input(cellQuery), response: {} })

export const testPrintContract = defineContract({
  params: templateParams,
  body: input({ printerId: id(), copies: z.number().int().min(1).max(10).default(1), ...cellQuery }),
  response: { 201: output({ job: printJobView, label: renderedLabelView }) },
})

export const assignLabelContract = defineContract({
  params: input({ styleId: id(), revisionId: id() }),
  body: input({ labelTemplateId: id().nullable(), version: version() }),
  response: {
    200: output({
      revision: output({ id: id(), styleId: id(), revision: z.number().int(), status: z.string(), labelTemplateId: id().nullable(), version: z.number().int() }),
      template: templateView.nullable(),
      warnings: z.array(issue),
    }),
  },
})
