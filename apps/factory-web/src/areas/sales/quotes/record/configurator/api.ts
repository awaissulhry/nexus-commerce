import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'
import { completeUpload, fileSchema, presignedSchema } from '../../../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../../../record-panels/store'
import { quoteSchema, type QuoteDetail } from '../../api'

/**
 * The configurator on a quote or order line (B-W2b-340) on its own API (modules/sales/configurator) and B-W2b-229's check
 * of a style (the bench). Money is ABSENT (never 0) when the person's grains do not reach it: a surcharge, a price and the
 * waterfall are the price grain, the unit cost the cost grain, the margin the margin grain. The API's English sentences are
 * never shown: rules, checks and refusals come as { it, en } words or as codes the screen says itself.
 */

const enc = encodeURIComponent
const words = z.object({ it: z.string(), en: z.string() })
const names = z.record(z.string(), z.string()).nullable()
export type Words2 = z.infer<typeof words>

const surcharge = z.object({ delta: z.string().nullable(), currency: z.string().nullable(), percent: z.string().nullable() }).nullable().optional()

const valueSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  nameI18n: names,
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  freeText: z.boolean(),
  freeTextMaxLength: z.number().nullable(),
  freeTextPattern: z.string().nullable(),
  outsideCertificate: z.boolean(),
  certificateNote: z.string().nullable(),
  surcharge,
})
export type OptionValueView = z.infer<typeof valueSchema>

const ruleSchema = z.object({ ruleId: z.string(), valueId: z.string().nullable(), kind: z.enum(['REQUIRES', 'EXCLUDES']), otherValueId: z.string(), severity: z.enum(['BLOCK', 'WARN']), words, broken: words })
export type OptionRuleView = z.infer<typeof ruleSchema>

const groupSchema = z.object({
  groupId: z.string(),
  code: z.string(),
  name: z.string(),
  nameI18n: names,
  kind: z.enum(['SINGLE', 'MULTI', 'FREE_TEXT']),
  minPicks: z.number(),
  maxPicks: z.number().nullable(),
  picks: words,
  defaultValueId: z.string().nullable(),
  values: z.array(valueSchema),
  rules: z.array(ruleSchema),
  /** B-W2b-374 (XF3:05): what a chosen value takes: COLOUR (the colour picker), MATERIAL (the material picker), none (both). */
  takes: z.enum(['COLOUR', 'MATERIAL']).nullable().optional(),
})
export type OptionGroupView = z.infer<typeof groupSchema>

const choicesSchema = z.object({
  colours: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), nameI18n: names, hex: z.string().nullable() })),
  leathers: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), colours: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), hex: z.string().nullable() })) })),
})
export type Choices = z.infer<typeof choicesSchema>

export const styleConfiguratorSchema = z.object({
  style: z.object({ id: z.string(), code: z.string(), name: z.string(), companyId: z.string().nullable(), status: z.string() }),
  colourway: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  picture: z.object({ fileId: z.string(), name: z.string(), contentType: z.string(), source: z.enum(['COLOURWAY', 'STYLE']) }).nullable(),
  groups: z.array(groupSchema),
  choices: choicesSchema,
})
export type StyleConfigurator = z.infer<typeof styleConfiguratorSchema>

const findingSchema = z.object({ code: z.string(), severity: z.enum(['BLOCK', 'WARN']), path: z.string(), groupId: z.string().nullable(), valueId: z.string().nullable(), ruleId: z.string().nullable(), message: words })
export type Finding = z.infer<typeof findingSchema>

const chosenSchema = z.object({
  id: z.string().nullable(),
  groupId: z.string(),
  valueId: z.string(),
  text: z.string().nullable(),
  byDefault: z.boolean(),
  colourId: z.string().nullable(),
  itemId: z.string().nullable(),
  itemColourId: z.string().nullable(),
  surchargeAmount: z.string().nullable().optional(),
  surchargePct: z.string().nullable().optional(),
})
export type Chosen = z.infer<typeof chosenSchema>

const checkPart = {
  ok: z.boolean(),
  blocks: z.array(findingSchema),
  warnings: z.array(findingSchema),
  outsideCertificate: z.boolean(),
  certificateNotes: z.array(z.object({ valueId: z.string(), note: z.string() })),
}

export const REPRICE_HELD = ['NO_START', 'NOT_SIZE_GRID', 'FEE'] as const

const artworkSchema = z.object({
  fileId: z.string(),
  name: z.string(),
  contentType: z.string(),
  sizeBytes: z.number(),
  status: z.string(),
  createdAt: z.string(),
  from: z.enum(['LINE', 'QUOTE_LINE']),
  /** B-W2b-374 (XF3:04): shown in the customer's portal. */
  portal: z.boolean().optional(),
})
export type ArtworkFile = z.infer<typeof artworkSchema>

export const lineConfiguratorSchema = styleConfiguratorSchema.extend({
  document: z.object({ kind: z.enum(['QUOTE', 'ORDER']), id: z.string(), number: z.string(), version: z.number(), status: z.string(), revision: z.number().nullable(), currency: z.string(), priceBasis: z.enum(['NET', 'GROSS']) }),
  line: z.object({
    id: z.string(),
    seq: z.number(),
    kind: z.string(),
    quantity: z.number(),
    unitPrice: z.string().optional(),
    listUnitPrice: z.string().nullable().optional(),
    unitCost: z.string().nullable().optional(),
    marginPct: z.string().nullable().optional(),
    optionsTotal: z.string().optional(),
  }),
  chosen: z.array(chosenSchema),
  check: z.object(checkPart),
  pricing: z.object({ holdsOptions: z.boolean(), held: z.enum(REPRICE_HELD).nullable(), manualKept: z.boolean() }),
  artwork: z.array(artworkSchema),
  /** B-W2b-374: share = may show an order line's artwork in the portal. */
  may: z.object({ configure: z.boolean(), held: words.nullable(), artwork: z.boolean(), share: z.boolean().optional() }),
})
export type LineConfigurator = z.infer<typeof lineConfiguratorSchema>

export const checkAnswerSchema = z.object({
  ...checkPart,
  chosen: z.array(chosenSchema),
  pricing: z.object({
    repriced: z.boolean(),
    held: z.enum(REPRICE_HELD).nullable(),
    manualKept: z.boolean(),
    unitPrice: z.string().optional(),
    before: z.string().optional(),
    optionsTotal: z.string().optional(),
    change: z.string().nullable().optional(),
    steps: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
    marginPct: z.string().nullable().optional(),
    marginBefore: z.string().nullable().optional(),
  }),
  problem: words.nullable(),
})
export type CheckAnswer = z.infer<typeof checkAnswerSchema>

/** A value chosen as the API takes it. */
export interface PickBody {
  valueId: string
  text?: string | null
  colourId?: string | null
  itemId?: string | null
  itemColourId?: string | null
}

export type LineTarget = { kind: 'QUOTE'; quoteId: string; lineId: string } | { kind: 'ORDER'; orderId: string; lineId: string }
const base = (target: LineTarget) => (target.kind === 'QUOTE' ? `/sales/quotes/${enc(target.quoteId)}/lines/${enc(target.lineId)}` : `/sales/orders/${enc(target.orderId)}/lines/${enc(target.lineId)}`)

export function readLineConfigurator(api: ApiClient, target: LineTarget, signal?: AbortSignal): Promise<LineConfigurator> {
  return api.get(`${base(target)}/configurator`, { schema: lineConfiguratorSchema, signal })
}

export function checkLine(api: ApiClient, target: LineTarget, picks: readonly PickBody[], signal?: AbortSignal): Promise<CheckAnswer> {
  return api.post(`${base(target)}/configurator/check`, { body: { picks }, schema: checkAnswerSchema, signal })
}

export function saveQuoteOptions(api: ApiClient, target: Extract<LineTarget, { kind: 'QUOTE' }>, version: number, picks: readonly PickBody[], idempotencyKey = newIdempotencyKey()): Promise<{ quote: QuoteDetail; line: LineConfigurator }> {
  return api.request('PUT', `${base(target)}/options`, { body: { version, picks }, schema: z.object({ quote: quoteSchema, line: lineConfiguratorSchema }), idempotencyKey })
}

export function saveOrderOptions(api: ApiClient, target: Extract<LineTarget, { kind: 'ORDER' }>, version: number, picks: readonly PickBody[], keepPrice: boolean, idempotencyKey = newIdempotencyKey()): Promise<{ line: LineConfigurator }> {
  return api.request('PUT', `${base(target)}/options`, { body: { version, picks, ...(keepPrice ? { keepPrice: true } : {}) }, schema: z.object({ line: lineConfiguratorSchema }), idempotencyKey })
}

/** One artwork file onto the line: announced (category ARTWORK), its bytes to the store, confirmed. */
export async function uploadArtwork(api: ApiClient, target: LineTarget, file: File): Promise<void> {
  const bytes = await file.arrayBuffer()
  const announced = await api.post(`${base(target)}/artwork`, {
    body: { originalName: file.name || 'artwork', contentType: file.type, sizeBytes: bytes.byteLength, sha256: await sha256Hex(bytes) },
    schema: z.object({ file: fileSchema, upload: presignedSchema }),
    idempotencyKey: newIdempotencyKey(),
  })
  await putToStore(announced.upload, bytes)
  await completeUpload(api, announced.file.id)
}

/** DELETE /files/:fileId (files.delete): an artwork file of the line removed. */
export function removeArtwork(api: ApiClient, fileId: string): Promise<unknown> {
  return api.request('DELETE', `/files/${enc(fileId)}`, { idempotencyKey: newIdempotencyKey() })
}

// ---- the bench (Test a combination, SAL-249) --------------------------------------------------------------------------

export function readStyleConfigurator(api: ApiClient, styleId: string, signal?: AbortSignal, /** B-W2b-374: the line's colourway (its picture). */ colourwayId?: string): Promise<StyleConfigurator> {
  return api.get(`/sales/configurator/styles/${enc(styleId)}`, { schema: styleConfiguratorSchema, signal, ...(colourwayId ? { query: { colourwayId } } : {}) })
}

const effectRef = z.object({ effectId: z.string(), valueId: z.string(), kind: z.string(), words })
export const benchCheckSchema = z.object({
  ok: z.boolean(),
  blocks: z.array(findingSchema),
  warnings: z.array(findingSchema),
  chosen: z.array(z.object({ valueId: z.string(), groupId: z.string(), code: z.string(), groupCode: z.string(), text: z.string().nullable(), byDefault: z.boolean() })),
  effects: z.object({
    bom: z.array(effectRef),
    operations: z.array(effectRef),
    minutes: z.array(effectRef),
    minutesAdded: z.string(),
    operationsAtStandard: z.number(),
    price: z.object({ byCurrency: z.array(z.object({ currency: z.string(), delta: z.string() })), percent: z.string().nullable() }).nullable().optional(),
    outsideCertificate: z.boolean(),
    certificateNotes: z.array(z.object({ valueId: z.string(), note: z.string() })),
  }),
  bom: z.object({ revision: z.object({ id: z.string(), revision: z.number(), status: z.string() }), notes: z.array(words) }).passthrough().nullable(),
})
export type BenchCheck = z.infer<typeof benchCheckSchema>

/** POST /product/styles/:styleId/options/check (B-W2b-229): the combination checked on the style (a read). */
export function checkCombination(api: ApiClient, styleId: string, picks: readonly { valueId: string; text?: string | null }[], signal?: AbortSignal): Promise<BenchCheck> {
  return api.post(`/product/styles/${enc(styleId)}/options/check`, { body: { picks, useDefaults: true }, schema: z.object({ check: benchCheckSchema }), signal }).then((answer) => answer.check)
}
