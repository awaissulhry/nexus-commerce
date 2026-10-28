import { z } from 'zod'
import { currency, id, input, instant, output, unitPrice } from '../../core/contracts'
import { fitsDecimal } from '../../core/money'
import { LOCALES } from '../../email/rules'
import { money } from '../../money/marked'
import { UOMS } from '../units/units'
import { ITEM_KINDS, ITEM_SOURCINGS, ITEM_TRACKINGS, MATERIAL_CODE, MATERIAL_CODE_RULE, MATERIAL_STATUSES, MATERIAL_WARNINGS, TANNAGES } from './rules'

/**
 * The material library's contracts (plan A1 D2; A2 SCR-047 "Materials & trims", SCR-048 "Material record"): what
 * apps/factory-api's modules/product/materials accepts and answers, and what the web's typed client reads.
 *
 * Money (A1 §3.11): the standard purchase price (`standardCost`, per base unit, GAP-006) and what one purchase or
 * consumption unit costs at it are marked `money.cost`: the API drops them from the answer of a caller without the cost
 * grain and refuses a request that sends one without it. Decimals travel as plain decimal strings ("52.5").
 */

const decimal = (precision: number, scale: number) =>
  z.string().refine((value) => /^\d+(?:\.\d+)?$/.test(value) && fitsDecimal(value, precision, scale), {
    message: `Expected a number with at most ${precision - scale} digits and ${scale} decimals.`,
  })
const text = (max: number) => z.string().trim().min(1).max(max)
const code = () => z.string().trim().toUpperCase().regex(MATERIAL_CODE, { message: `Expected ${MATERIAL_CODE_RULE}.` })

export const localisedNames = () => z.partialRecord(z.enum(LOCALES), text(200))
export const fibreShare = input({ fibre: text(60), percent: decimal(5, 2) })
export const attributes = () => z.record(z.string().max(60), z.string().max(500))

/** A colour of a new material, or one added to a material. */
export const colourBody = input({
  code: code(),
  name: text(120),
  supplierColourCode: text(64).nullish(),
  /** The library colour it matches. */
  colourId: id().nullish(),
})

/** The fields a person types for a material, all optional on a change. */
const editable = {
  name: text(200),
  nameI18n: localisedNames().nullish(),
  kind: z.enum(ITEM_KINDS),
  sourcing: z.enum(ITEM_SOURCINGS),
  tracking: z.enum(ITEM_TRACKINGS),
  baseUom: z.enum(UOMS),
  purchaseUom: z.enum(UOMS),
  /** How many base units one purchase unit holds; leave it out when the units derive it (FT2 in M2). */
  purchaseFactor: decimal(18, 8).nullish(),
  consumptionUom: z.enum(UOMS),
  consumptionFactor: decimal(18, 8).nullish(),
  defaultSupplierId: id().nullish(),
  supplierArticleCode: text(64).nullish(),
  animalSpecies: text(60).nullish(),
  tannage: z.enum(TANNAGES).nullish(),
  grade: text(40).nullish(),
  finish: text(80).nullish(),
  thicknessMinMm: decimal(6, 2).nullish(),
  thicknessMaxMm: decimal(6, 2).nullish(),
  composition: z.array(fibreShare).max(10).nullish(),
  animalOrigin: z.boolean(),
  attributes: attributes().nullish(),
  isPpeComponent: z.boolean(),
  requiresCrViTest: z.boolean(),
  /** mg/kg; set exactly when requiresCrViTest; at most 3 (REACH Annex XVII entry 47). */
  crViLimitMgKg: decimal(8, 3).nullish(),
}

export const createMaterialBody = input({
  /** The company it belongs to; left out or null: tenant-wide (every company of the tenant). */
  companyId: id().nullish(),
  code: code(),
  ...editable,
  sourcing: editable.sourcing.optional(),
  tracking: editable.tracking.optional(),
  purchaseUom: editable.purchaseUom.optional(),
  consumptionUom: editable.consumptionUom.optional(),
  animalOrigin: editable.animalOrigin.optional(),
  isPpeComponent: editable.isPpeComponent.optional(),
  requiresCrViTest: editable.requiresCrViTest.optional(),
  /** Per base unit; needs product.materials.cost and the cost grain. */
  standardCost: money.cost(unitPrice().nullable()),
  currency: currency().optional(),
  colours: z.array(colourBody).max(200).optional(),
})
export type CreateMaterialBody = z.output<typeof createMaterialBody>

/** A change: only the fields sent change (null clears an optional one). The standard cost has its own route. */
export const updateMaterialBody = input(editable)
  .partial()
  .extend({
    /** The version the change was made on (COL-078). */
    version: z.number().int().min(1),
    code: code().optional(),
  })
export type UpdateMaterialBody = z.output<typeof updateMaterialBody>

export const standardCostBody = input({
  version: z.number().int().min(1),
  /** Per base unit; null removes it. */
  standardCost: money.cost(unitPrice().nullable()),
  currency: currency().optional(),
  /** Why it changed (a new price list, a quote from the tannery): kept in the audit row. */
  reason: text(500).optional(),
})
export type StandardCostBody = z.output<typeof standardCostBody>

export const statusBody = input({ version: z.number().int().min(1), reason: text(500).optional() })

export const updateColourBody = input({
  version: z.number().int().min(1),
  name: text(120).optional(),
  supplierColourCode: text(64).nullish(),
  colourId: id().nullish(),
  /** ARCHIVED removes the colour from new use; ACTIVE restores it. */
  status: z.enum(MATERIAL_STATUSES).optional(),
})
export type UpdateColourBody = z.output<typeof updateColourBody>

/** The list's filters (SCR-047): a search over code, name and supplier article code; kinds as `LEATHER,LINING`. */
export const listMaterialsQuery = input({
  q: z.string().trim().max(100).optional(),
  kind: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value.trim() === '') return undefined
      const kinds = [...new Set(value.split(',').map((part) => part.trim().toUpperCase()))]
      const unknown = kinds.filter((kind) => !(ITEM_KINDS as readonly string[]).includes(kind))
      if (unknown.length > 0) {
        ctx.addIssue({ code: 'custom', message: `Expected kinds from ${ITEM_KINDS.join(', ')}.` })
        return z.NEVER
      }
      return kinds as (typeof ITEM_KINDS)[number][]
    }),
  status: z.enum([...MATERIAL_STATUSES, 'ALL']).default('ACTIVE'),
  sourcing: z.enum(ITEM_SOURCINGS).optional(),
  tracking: z.enum(ITEM_TRACKINGS).optional(),
  supplierId: id().optional(),
  requiresCrViTest: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  /** Exactly this company's materials and the tenant-wide ones (null: every company the caller sees). */
  companyId: id().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** `nextCursor` of the previous page, as it came. */
  cursor: z.string().max(200).optional(),
})
export type ListMaterialsQuery = z.output<typeof listMaterialsQuery>

// ---- answers ----------------------------------------------------------------------------------------------------------

export const supplierRef = output({ id: id(), code: z.string(), name: z.string() })

export const colourView = output({
  id: id(),
  code: z.string(),
  name: z.string(),
  supplierColourCode: z.string().nullable(),
  colourId: id().nullable(),
  status: z.enum(MATERIAL_STATUSES),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type ColourView = z.infer<typeof colourView>

/** One unit of the material: how many base units it holds, and whether that is fixed by the units (FT2 in M2). */
export const unitView = output({ uom: z.enum(UOMS), factor: z.string(), fixed: z.boolean() })

const summary = {
  id: id(),
  companyId: id().nullable(),
  code: z.string(),
  name: z.string(),
  nameI18n: localisedNames().nullable(),
  kind: z.enum(ITEM_KINDS),
  sourcing: z.enum(ITEM_SOURCINGS),
  tracking: z.enum(ITEM_TRACKINGS),
  baseUom: z.enum(UOMS),
  purchaseUom: z.enum(UOMS),
  consumptionUom: z.enum(UOMS),
  defaultSupplier: supplierRef.nullable(),
  supplierArticleCode: z.string().nullable(),
  isPpeComponent: z.boolean(),
  requiresCrViTest: z.boolean(),
  crViLimitMgKg: z.string().nullable(),
  /** Per base unit, in `currency`; only with the cost grain. */
  standardCost: money.cost(z.string().nullable()),
  currency: z.string(),
  /** Its active colours. */
  colourCount: z.number().int(),
  status: z.enum(MATERIAL_STATUSES),
  version: z.number().int(),
  updatedAt: instant(),
}

/** A row of the material list (SCR-047). */
export const materialRow = output(summary)
export type MaterialRow = z.infer<typeof materialRow>

/** The material record (SCR-048). */
export const materialView = output({
  ...summary,
  units: output({ base: unitView, purchase: unitView, consumption: unitView }),
  /** What one purchase unit and one consumption unit cost at the standard cost; only with the cost grain. */
  standardCostPerPurchaseUnit: money.cost(z.string().nullable()),
  standardCostPerConsumptionUnit: money.cost(z.string().nullable()),
  animalSpecies: z.string().nullable(),
  tannage: z.enum(TANNAGES).nullable(),
  grade: z.string().nullable(),
  finish: z.string().nullable(),
  thicknessMinMm: z.string().nullable(),
  thicknessMaxMm: z.string().nullable(),
  composition: z.array(output({ fibre: z.string(), percent: z.string() })).nullable(),
  animalOrigin: z.boolean(),
  attributes: attributes().nullable(),
  colours: z.array(colourView),
  /** What the page points out without refusing it (no default supplier, leather without a Cr VI test). */
  warnings: z.array(output({ code: z.enum(MATERIAL_WARNINGS), message: z.string() })),
  createdAt: instant(),
  createdById: id().nullable(),
})
export type MaterialView = z.infer<typeof materialView>
