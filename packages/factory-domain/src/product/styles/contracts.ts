import { z } from 'zod'
import { id, input, instant, output } from '../../core/contracts'
import { GARMENT_TRACKINGS } from '../../production/serials/rules'
import { localisedNames } from '../materials/contracts'
import { sizeCode } from '../sizes/contracts'
import { BODY_MEASURE_UNITS, MASTER_STATUSES } from '../sizes/rules'
import { COLOURWAY_CODE, COLOURWAY_CODE_RULE, MAX_COLOURWAYS } from './colourways'
import { COPY_PARTS, COPYABLE_PARTS } from './copy'
import { REVISION_STATUSES } from './revisions'
import { MAX_RANGE_SIZES, PPE_CATEGORIES, PRODUCT_TYPES, STYLE_CODE, STYLE_CODE_RULE, STYLE_STATUSES, STYLE_WARNINGS } from './rules'

/**
 * The style library's contracts (plan A1 D2; A2 SCR-040 "Styles", SCR-041 "Style › Overview & variants"): what
 * apps/factory-api's modules/product/styles accepts and answers for styles, colourways, SKUs and revision shells, and
 * what the web's typed client reads. No money here (costing is B-W1-15).
 */

const text = (max: number) => z.string().trim().min(1).max(max)
const version = () => z.number().int().min(1)
export const styleCode = () => z.string().trim().toUpperCase().regex(STYLE_CODE, { message: `Expected ${STYLE_CODE_RULE}.` })
export const colourwayCode = () => z.string().trim().toUpperCase().regex(COLOURWAY_CODE, { message: `Expected ${COLOURWAY_CODE_RULE}.` })

/** A colourway of a new style, or one added to a style. */
export const colourwayBody = input({
  code: colourwayCode(),
  name: text(120),
  /** The library colour of its main material. */
  colourId: id().nullish(),
  /** Its contrast panels, stitching and logos. */
  description: text(1000).nullish(),
})
export type ColourwayBody = z.output<typeof colourwayBody>

/** The fields a person types for a style, all optional on a change. */
const editable = {
  name: text(200),
  nameI18n: localisedNames().nullish(),
  description: text(4000).nullish(),
  productType: z.enum(PRODUCT_TYPES),
  season: text(20).nullish(),
  /** The brand it is made for (a party with the BRAND role); null: our own collection. */
  brandPartyId: id().nullish(),
  sizeScaleId: id(),
  /** The range: codes of the scale's sizes (put in the scale's order). */
  sizes: z.array(sizeCode()).max(MAX_RANGE_SIZES),
  /** The base (sample) size: one of `sizes`. */
  baseSize: sizeCode().nullish(),
  ppeCategory: z.enum(PPE_CATEGORIES),
  /** The harmonised standard with its edition ("EN 17092-4:2020"); none when not PPE. */
  ppeStandard: text(40).nullish(),
  /** The class it is made for (EN 17092: AAA … C, set by the part when left out; EN 13594: 1, 2, 1KP, 2KP). */
  ppeClass: text(20).nullish(),
  mtmAllowed: z.boolean(),
  measurementTemplateId: id().nullish(),
  /** W2a customs (PRD-018): the commodity code, HS 6, CN 8 or TARIC 10 digits (dots and spaces are taken out). */
  hsCode: text(20).nullish(),
  /** The country of origin, ISO 3166-1 alpha-2 ("IT"). */
  originCountry: z.string().trim().length(2).nullish(),
  /** The net mass of one garment in kilograms ("1.85"), above 0, at most 3 decimals. */
  netMassKg: text(20).nullish(),
}

export const createStyleBody = input({
  /** The company it belongs to; left out or null: tenant-wide (made by every company of the tenant). */
  companyId: id().nullish(),
  code: styleCode(),
  ...editable,
  sizes: editable.sizes.optional(),
  ppeCategory: editable.ppeCategory.optional(),
  mtmAllowed: editable.mtmAllowed.optional(),
  colourways: z.array(colourwayBody).max(MAX_COLOURWAYS).optional(),
  /** Make the SKU matrix at once (default false: generate it later from the style page). */
  generateSkus: z.boolean().optional(),
})
export type CreateStyleBody = z.output<typeof createStyleBody>

/** A change: only the fields sent change (null clears an optional one). Colourways and SKUs have their own routes. */
export const updateStyleBody = input(editable)
  .partial()
  .extend({
    /** The version the change was made on (COL-078). */
    version: version(),
    code: styleCode().optional(),
  })
export type UpdateStyleBody = z.output<typeof updateStyleBody>

export const styleStatusBody = input({ version: version(), reason: text(500).optional() })

/**
 * How the garments of a style are numbered on their labels (Q31: both are built, a setting per style): BATCH = the
 * work order's batch number on every label; SERIAL = one serial per garment. It changes until the style's work orders
 * print their first garment label, give a serial or release a garment (rules `garmentTrackingRefusal`; the database's
 * factory_style_garment_tracking_guard holds the same rule).
 */
export const garmentTrackingBody = input({ version: version(), tracking: z.enum(GARMENT_TRACKINGS) })
export type GarmentTrackingBody = z.infer<typeof garmentTrackingBody>

export const updateColourwayBody = input({
  version: version(),
  /** Only while nothing uses the colourway (no SKU, BOM colour or order line). */
  code: colourwayCode().optional(),
  name: text(120).optional(),
  colourId: id().nullish(),
  description: text(1000).nullish(),
  /** ARCHIVED takes it out of new use (its SKUs go off); ACTIVE restores it (its SKUs in the range come back). */
  status: z.enum(MASTER_STATUSES).optional(),
})
export type UpdateColourwayBody = z.output<typeof updateColourwayBody>

/** Make a SKU for every colourway and size of the range that has none; `dryRun` only says which. */
export const generateSkusBody = input({ dryRun: z.boolean().optional() })
export type GenerateSkusBody = z.output<typeof generateSkusBody>

export const updateSkuBody = input({
  version: version(),
  /** GTIN-8, -12, -13 or -14 with its check digit (stored in its canonical form); null removes it. */
  gtin: z.string().trim().min(1).max(20).nullish(),
  /** One cell off (ARCHIVED) or on again (ACTIVE: only a colourway and size the style offers). */
  status: z.enum(MASTER_STATUSES).optional(),
})
export type UpdateSkuBody = z.output<typeof updateSkuBody>

export const createRevisionBody = input({
  /** What will change against the previous revision. */
  changeNote: text(2000).optional(),
})
export type CreateRevisionBody = z.output<typeof createRevisionBody>

const listOf = <Value extends string>(values: readonly Value[], what: string) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value.trim() === '') return undefined
      const given = [...new Set(value.split(',').map((part) => part.trim().toUpperCase()))]
      if (given.some((entry) => !(values as readonly string[]).includes(entry))) {
        ctx.addIssue({ code: 'custom', message: `Expected ${what} from ${values.join(', ')}.` })
        return z.NEVER
      }
      return given as Value[]
    })

/** The style list's filters (SCR-040): a search over code, name and season; lists as `JACKET,TROUSERS`. */
export const listStylesQuery = input({
  q: z.string().trim().max(100).optional(),
  /** OPEN: DRAFT and ACTIVE. */
  status: z.enum([...STYLE_STATUSES, 'OPEN', 'ALL']).default('OPEN'),
  productType: listOf(PRODUCT_TYPES, 'product types'),
  ppeCategory: listOf(PPE_CATEGORIES, 'PPE categories'),
  season: z.string().trim().max(20).optional(),
  brandPartyId: id().optional(),
  sizeScaleId: id().optional(),
  mtmAllowed: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  /** true: a DRAFT revision is waiting for its release (SCR-040 "Waiting for release"); false: none is. */
  draftRevision: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  /** Exactly this company's styles and the tenant-wide ones. */
  companyId: id().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
})
export type ListStylesQuery = z.output<typeof listStylesQuery>

// ---- answers ----------------------------------------------------------------------------------------------------------

const ref = output({ id: id(), code: z.string(), name: z.string() })

export const colourRef = output({ id: id(), code: z.string(), name: z.string(), hex: z.string().nullable() })

/** The colour library's filters (a colourway's main colour, SCR-041): a search over code and name. */
export const listColoursQuery = input({
  q: z.string().trim().max(100).optional(),
  status: z.enum([...MASTER_STATUSES, 'ALL']).default('ACTIVE'),
  /** Exactly this company's colours and the tenant-wide ones. */
  companyId: id().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})
export type ListColoursQuery = z.output<typeof listColoursQuery>

/** A colour of the library, as a colourway picks it. */
export const colourRow = colourRef.extend({ companyId: id().nullable(), status: z.enum(MASTER_STATUSES) })
export type ColourRow = z.infer<typeof colourRow>

export const colourwayView = output({
  id: id(),
  code: z.string(),
  name: z.string(),
  colour: colourRef.nullable(),
  description: z.string().nullable(),
  status: z.enum(MASTER_STATUSES),
  version: z.number().int(),
  /** The range's sizes it has a SKU ON in (what the size grid offers for it). */
  offeredSizes: z.array(z.string()),
  /** Its SKUs, BOM colours or order lines name it: its code never changes. */
  inUse: z.boolean(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type ColourwayView = z.infer<typeof colourwayView>

export const skuView = output({
  id: id(),
  colourwayId: id(),
  colourwayCode: z.string(),
  size: z.string(),
  sku: z.string(),
  gtin: z.string().nullable(),
  status: z.enum(MASTER_STATUSES),
  version: z.number().int(),
  /** Its colourway is active and its size in the range. */
  offered: z.boolean(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type SkuView = z.infer<typeof skuView>

/** One cell of the colour x size grid: offered or not, and its SKU when it has one. */
export const matrixCell = output({
  size: z.string(),
  offered: z.boolean(),
  sku: output({ id: id(), sku: z.string(), gtin: z.string().nullable(), status: z.enum(MASTER_STATUSES), version: z.number().int() }).nullable(),
})

export const matrixView = output({
  /** The range, in the scale's order, with the labels the grid's columns show. */
  sizes: z.array(output({ code: z.string(), label: z.string() })),
  rows: z.array(output({ colourwayId: id(), code: z.string(), name: z.string(), status: z.enum(MASTER_STATUSES), cells: z.array(matrixCell) })),
  /** The SKU matrix was generated (the style has a SKU): changes of the range and colourways now move the SKUs. */
  generated: z.boolean(),
  /** Offered cells without a SKU. */
  missing: z.number().int(),
})
export type MatrixView = z.infer<typeof matrixView>

export const revisionView = output({
  id: id(),
  revision: z.number().int(),
  status: z.enum(REVISION_STATUSES),
  changeNote: z.string().nullable(),
  labelTemplateId: id().nullable(),
  releasedAt: instant().nullable(),
  releasedById: id().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  createdById: id().nullable(),
  updatedAt: instant(),
})
export type RevisionView = z.infer<typeof revisionView>

const summary = {
  id: id(),
  companyId: id().nullable(),
  code: z.string(),
  name: z.string(),
  nameI18n: localisedNames().nullable(),
  productType: z.enum(PRODUCT_TYPES),
  season: z.string().nullable(),
  brand: ref.nullable(),
  sizeScale: ref,
  sizes: z.array(z.string()),
  baseSize: z.string().nullable(),
  ppeCategory: z.enum(PPE_CATEGORIES),
  ppeStandard: z.string().nullable(),
  ppeClass: z.string().nullable(),
  mtmAllowed: z.boolean(),
  /** W2a customs and origin data (PRD-018; exports and Intrastat): null when not on record. */
  hsCode: z.string().nullable(),
  originCountry: z.string().nullable(),
  netMassKg: z.string().nullable(),
  status: z.enum(STYLE_STATUSES),
  version: z.number().int(),
  updatedAt: instant(),
  /** Its active colourways and its SKUs ON. */
  colourwayCount: z.number().int(),
  skuCount: z.number().int(),
  /** RELEASED: it has a current revision; DRAFT: one is being prepared; NONE. */
  revisionState: z.enum(['RELEASED', 'DRAFT', 'NONE']),
  /** The number of its RELEASED revision and of its open DRAFT one ("Rev 3 released · Rev 4 draft"); null: none. */
  releasedRevision: z.number().int().nullable(),
  draftRevision: z.number().int().nullable(),
  /** What the list's completeness column shows. */
  completeness: output({ colourways: z.boolean(), sizeRange: z.boolean(), baseSize: z.boolean(), skus: z.boolean(), releasedRevision: z.boolean() }),
}

/** A row of the style list (SCR-040). */
export const styleRow = output(summary)
export type StyleRow = z.infer<typeof styleRow>

/** The style record (SCR-041): identity, colourways, range, the colour x size SKUs and the revisions. */
export const styleView = output({
  ...summary,
  description: z.string().nullable(),
  measurementTemplate: ref.nullable(),
  /** How its garments are traced (PRD-025; Reg. (EU) 2016/425 art. 8(5)): by lot when PPE. */
  tracking: z.enum(['LOT', 'NONE']),
  /** How its garments are numbered on their labels (Q31): the batch number, or one serial per garment. */
  garmentTracking: z.enum(GARMENT_TRACKINGS),
  /** The range with each size's label and body measures. */
  range: z.array(
    output({
      code: z.string(),
      label: z.string().nullable(),
      status: z.enum(MASTER_STATUSES),
      bodyMeasures: z.record(z.string(), output({ min: z.string().nullable(), max: z.string().nullable(), unit: z.enum(BODY_MEASURE_UNITS) })).nullable(),
    }),
  ),
  colourways: z.array(colourwayView),
  matrix: matrixView,
  /** Every SKU of the style, also the ones outside the range or switched off. */
  skus: z.array(skuView),
  revisions: z.array(revisionView),
  warnings: z.array(output({ code: z.enum(STYLE_WARNINGS), message: z.string() })),
  createdAt: instant(),
  createdById: id().nullable(),
})
export type StyleView = z.infer<typeof styleView>

/** What generating the SKUs made (or, in a dry run, would make). */
export const generatedSkus = output({
  dryRun: z.boolean(),
  skus: z.array(output({ colourwayId: id(), colourwayCode: z.string(), size: z.string(), sku: z.string() })),
  style: styleView,
})
export type GeneratedSkus = z.infer<typeof generatedSkus>

// ---- copy a style (W2a, PRD-011) ---------------------------------------------------------------------------------------

/**
 * A copy of a style (design products.styles pop:styles.duplicate): a new style with its own code and name, a DRAFT linked
 * to its source, with the parts picked (./copy). The rest of its identity and its colourways are the source's.
 */
export const duplicateStyleBody = input({
  code: styleCode(),
  name: text(200),
  /** Left out: the source's season. */
  season: text(20).nullish(),
  /** Left out: the source's brand; null: our own collection. */
  brandPartyId: id().nullish(),
  /** The parts copied into the copy's revision 1 (BOM, ROUTING, LABELS) and its made-to-measure set-up (MEASUREMENTS). */
  parts: z.array(z.enum(COPYABLE_PARTS)).max(COPYABLE_PARTS.length).default([]),
  /** The source revision the parts come from; left out: its released revision, else its newest. */
  fromRevisionId: id().optional(),
  /** The copy's first revision's change note; left out: "Copied from <code> revision <n>." */
  changeNote: text(2000).optional(),
  /** Make the copy's SKU matrix at once (default false). */
  generateSkus: z.boolean().optional(),
})
export type DuplicateStyleBody = z.output<typeof duplicateStyleBody>

export const duplicateOfferQuery = input({ fromRevisionId: id().optional() })
export type DuplicateOfferQuery = z.output<typeof duplicateOfferQuery>

const partOffer = output({
  part: z.enum(COPY_PARTS),
  /** It can be picked: the source has it and the caller may copy it. */
  available: z.boolean(),
  /** What it holds (BOM lines, routing steps); null where a count says nothing or the caller may not see it. */
  count: z.number().int().nullable(),
  /** Why it cannot be picked, in words; null when it can. */
  reason: z.string().nullable(),
})

/** What the Duplicate dialog offers for a style: its revisions' parts, and what a copy would leave out. */
export const duplicateOfferView = output({
  source: output({ id: id(), code: z.string(), name: z.string(), status: z.enum(STYLE_STATUSES) }),
  /** The revision the parts come from; null: the style has none yet. */
  revision: output({ id: id(), revision: z.number().int(), status: z.enum(REVISION_STATUSES) }).nullable(),
  parts: z.array(partOffer),
  colourways: z.number().int(),
  /** Range sizes archived in the scale since: the copy's range leaves them out. */
  droppedSizes: z.array(z.string()),
})
export type DuplicateOfferView = z.infer<typeof duplicateOfferView>

/** What a copy made. */
export const duplicatedView = output({
  style: styleView,
  /** The copy's revision 1 (DRAFT) with the parts; null when no BOM, routing or label was copied. */
  revision: revisionView.nullable(),
  copied: output({
    from: output({ styleId: id(), code: z.string(), revisionId: id().nullable(), revision: z.number().int().nullable() }),
    parts: z.array(z.enum(COPYABLE_PARTS)),
    colourways: z.number().int(),
    bomLines: z.number().int(),
    routingSteps: z.number().int(),
    label: z.boolean(),
    skus: z.number().int(),
  }),
  /** What the copy left out, in words (an archived size, an archived library colour). */
  notes: z.array(z.string()),
})
export type DuplicatedView = z.infer<typeof duplicatedView>
