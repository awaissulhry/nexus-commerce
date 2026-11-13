import { z } from 'zod'
import { currency, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { money } from '@nexus/factory-domain/money/marked'
import { MARK_LANGUAGE, PACKAGING_KINDS, PALLET_KINDS, SHIPPING_MARK_FIELDS } from '@nexus/factory-domain/shipping/packaging/rules'

/**
 * Packaging and carton marks (B-W2b-384; LOG-008, LOG-013; design warehouse.shipping "Packaging"). Sizes are centimetres
 * (2 decimals), weights kilograms (4 decimals), the cost per unit a decimal of its currency (6 decimals), as decimal
 * strings; a field left out of a change stays, null clears it. The cost is money.cost: dropped from the answer without the
 * grain, refused in a request without it.
 */

const version = z.number().int().min(1).optional()
const centimetres = z.string().trim().max(16)
const kilograms = z.string().trim().max(24)
const name = z.string().max(200)
const active = z.boolean().optional()

const typeSchema = output({
  id: id(),
  companyId: id(),
  kind: z.enum(PACKAGING_KINDS),
  name: z.string(),
  innerLengthCm: z.string().nullable(),
  innerWidthCm: z.string().nullable(),
  innerHeightCm: z.string().nullable(),
  tareKg: z.string().nullable(),
  maxWeightKg: z.string().nullable(),
  palletKind: z.enum(PALLET_KINDS).nullable(),
  /** What one unit costs us (FIN-011), or null: not recorded. */
  cost: money.cost(output({ perUnit: z.string(), currency: z.string() }).nullable()),
  active: z.boolean(),
  version: z.number().int(),
  updatedAt: instant(),
})

const typeFields = {
  innerLengthCm: centimetres.nullable().optional(),
  innerWidthCm: centimetres.nullable().optional(),
  innerHeightCm: centimetres.nullable().optional(),
  tareKg: kilograms.nullable().optional(),
  maxWeightKg: kilograms.nullable().optional(),
  palletKind: z.enum(PALLET_KINDS).nullable().optional(),
  cost: money.cost(input({ perUnit: z.string().trim().max(32), currency: currency() }).nullable()),
  active,
}

export const listTypesContract = defineContract({
  querystring: input({ companyId: id().optional(), kind: z.enum(PACKAGING_KINDS).optional(), active: z.enum(['true', 'false']).transform((value) => value === 'true').optional() }),
  response: { 200: output({ types: z.array(typeSchema) }) },
})

export const createTypeContract = defineContract({
  body: input({ companyId: id(), kind: z.enum(PACKAGING_KINDS), name, ...typeFields }),
  response: { 201: output({ type: typeSchema }) },
})

export const changeTypeContract = defineContract({
  params: input({ typeId: id() }),
  body: input({ version, name: name.optional(), ...typeFields }),
  response: { 200: output({ type: typeSchema }) },
})

const named = output({ code: z.string(), name: z.string() })

const defaultSchema = output({
  id: id(),
  companyId: id(),
  kind: z.enum(PACKAGING_KINDS),
  packagingTypeId: id(),
  packagingTypeName: z.string(),
  styleId: id().nullable(),
  style: named.nullable(),
  sizeScaleId: id().nullable(),
  sizeScale: named.nullable(),
  fromSize: z.string().nullable(),
  toSize: z.string().nullable(),
  active: z.boolean(),
  version: z.number().int(),
  updatedAt: instant(),
})

const sizeCode = z.string().trim().max(20)

export const listDefaultsContract = defineContract({
  querystring: input({ companyId: id().optional(), styleId: id().optional(), active: z.enum(['true', 'false']).transform((value) => value === 'true').optional() }),
  response: { 200: output({ defaults: z.array(defaultSchema) }) },
})

export const createDefaultContract = defineContract({
  body: input({
    companyId: id(),
    packagingTypeId: id(),
    /** The style (its size run over the style's own scale), or none: every style of the scale's run. */
    styleId: id().nullable().optional(),
    sizeScaleId: id().nullable().optional(),
    fromSize: sizeCode.nullable().optional(),
    toSize: sizeCode.nullable().optional(),
  }),
  response: { 201: output({ default: defaultSchema }) },
})

export const changeDefaultContract = defineContract({
  params: input({ defaultId: id() }),
  body: input({ version, packagingTypeId: id().optional(), active }),
  response: { 200: output({ default: defaultSchema }) },
})

const templateSchema = output({
  id: id(),
  companyId: id(),
  /** The customer or brand; null: the company's default. */
  partyId: id().nullable(),
  party: output({ code: z.string(), legalName: z.string() }).nullable(),
  fields: z.array(z.enum(SHIPPING_MARK_FIELDS)),
  language: z.string(),
  active: z.boolean(),
  version: z.number().int(),
  updatedAt: instant(),
})

const fields = z.array(z.enum(SHIPPING_MARK_FIELDS)).min(1).max(SHIPPING_MARK_FIELDS.length)
const language = z.string().regex(MARK_LANGUAGE, 'Expected a language of two lower-case letters (ISO 639-1).')

export const listTemplatesContract = defineContract({
  querystring: input({ companyId: id().optional(), partyId: id().optional(), active: z.enum(['true', 'false']).transform((value) => value === 'true').optional() }),
  response: { 200: output({ templates: z.array(templateSchema) }) },
})

export const createTemplateContract = defineContract({
  body: input({ companyId: id(), partyId: id().nullable().optional(), fields, language }),
  response: { 201: output({ template: templateSchema }) },
})

export const changeTemplateContract = defineContract({
  params: input({ templateId: id() }),
  body: input({ version, fields: fields.optional(), language: language.optional(), active }),
  response: { 200: output({ template: templateSchema }) },
})
