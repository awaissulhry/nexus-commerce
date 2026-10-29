import { z } from 'zod'
import { id, input, instant, output } from '../../core/contracts'
import { fitsDecimal } from '../../core/money'
import { ITEM_KINDS, MATERIAL_STATUSES } from '../materials/rules'
import { sizeCode } from '../sizes/contracts'
import { MASTER_STATUSES } from '../sizes/rules'
import { MAX_COLOURWAYS } from '../styles/colourways'
import { REVISION_STATUSES } from '../styles/revisions'
import { MAX_RANGE_SIZES, STYLE_STATUSES } from '../styles/rules'
import { ROUTING_ISSUE_CODES } from '../routing/rules'
import { UOMS } from '../units/units'
import { BOM_ISSUE_CODES, MAX_SEQ } from './rules'

/**
 * The BOM's contracts (plan A1 D2; A2 SCR-042 "Style › BOM", SCR-046 "Style release & versions"): what
 * apps/factory-api's modules/product/bom accepts and answers, and what the web's typed client reads. No money: a cost
 * is the cost sheet's (B-W1-16). Decimals travel as plain decimal strings ("45", "1.8"). Every write sends the
 * revision's `version` (COL-078): the whole BOM of a revision is one versioned record.
 */

const text = (max: number) => z.string().trim().min(1).max(max)
const version = () => z.number().int().min(1)
/** A decimal of 0 or more, with at most `precision - scale` digits and `scale` decimals. */
const decimal = (precision: number, scale: number) =>
  z.string().refine((value) => /^\d+(?:\.\d+)?$/.test(value) && fitsDecimal(value, precision, scale), {
    message: `Expected a number of 0 or more with at most ${precision - scale} digits and ${scale} decimals.`,
  })
/** A quantity per garment: Decimal(18,4). */
const quantity = () => decimal(18, 4)
/** A percentage: Decimal(7,4). */
const percent = () => decimal(7, 4)

const sizeQuantity = input({ size: sizeCode(), qty: quantity().nullable() })
const colourCell = input({ colourwayId: id(), itemColourId: id().nullable() })

const lineFields = {
  /** The material (ACTIVE when chosen). */
  itemId: id(),
  /** Where it goes: front panel, sleeve, lining, armour pocket. */
  placement: text(120).nullish(),
  /** One the material converts to its base unit; default the material's consumption unit. */
  uom: z.enum(UOMS),
  /** Per garment, above 0: a line that is not size-dependent. */
  qty: quantity(),
  /** 0 to 60 %: waste and, on leather, the hide's yield. */
  wastagePct: percent(),
  sizeDependent: z.boolean(),
  /** Merged into the line's quantity per size: a quantity sets it (0: the size does not use the line), null clears it. */
  sizes: z.array(sizeQuantity).max(MAX_RANGE_SIZES),
  colourDependent: z.boolean(),
  /** The one material colour of every colourway (a line that is not colour-dependent). */
  itemColourId: id().nullish(),
  /** Merged into the colour grid: a colour sets the colourway's cell, null clears it. */
  colours: z.array(colourCell).max(MAX_COLOURWAYS),
  /** Only in this colourway (PRD-100); null: every colourway. */
  colourwayId: id().nullish(),
  /** Bought from this supplier when it is not the material's default. */
  supplierId: id().nullish(),
  note: text(1000).nullish(),
  /** Its place in the BOM; default after the last line. */
  seq: z.number().int().min(1).max(MAX_SEQ),
}

export const addLineBody = input({
  version: version(),
  itemId: lineFields.itemId,
  placement: lineFields.placement,
  uom: lineFields.uom.optional(),
  qty: lineFields.qty.optional(),
  wastagePct: lineFields.wastagePct.optional(),
  sizeDependent: lineFields.sizeDependent.optional(),
  sizes: lineFields.sizes.optional(),
  colourDependent: lineFields.colourDependent.optional(),
  itemColourId: lineFields.itemColourId,
  colours: lineFields.colours.optional(),
  colourwayId: lineFields.colourwayId,
  supplierId: lineFields.supplierId,
  note: lineFields.note,
  seq: lineFields.seq.optional(),
})
export type AddLineBody = z.output<typeof addLineBody>

/** A change to a line: only what it names; null clears an optional field. */
export const updateLineBody = input({
  version: version(),
  itemId: lineFields.itemId.optional(),
  placement: lineFields.placement,
  uom: lineFields.uom.optional(),
  qty: lineFields.qty.optional(),
  wastagePct: lineFields.wastagePct.optional(),
  sizeDependent: lineFields.sizeDependent.optional(),
  sizes: lineFields.sizes.optional(),
  colourDependent: lineFields.colourDependent.optional(),
  itemColourId: lineFields.itemColourId,
  colours: lineFields.colours.optional(),
  colourwayId: lineFields.colourwayId,
  supplierId: lineFields.supplierId,
  note: lineFields.note,
  seq: lineFields.seq.optional(),
})
export type UpdateLineBody = z.output<typeof updateLineBody>

/** The quantity per size of a size-dependent line (the size grid), merged. */
export const setSizesBody = input({ version: version(), sizes: lineFields.sizes.min(1) })
export type SetSizesBody = z.output<typeof setSizesBody>

/** The colour grid of a colour-dependent line (PRD-043), merged. */
export const setColoursBody = input({ version: version(), colours: lineFields.colours.min(1) })
export type SetColoursBody = z.output<typeof setColoursBody>

/** A line out of the draft BOM: the revision's version in the query. */
export const removeLineQuery = input({ version: z.coerce.number().int().min(1) })
export type RemoveLineQuery = z.output<typeof removeLineQuery>

/** A draft revision's own fields. */
export const updateRevisionBody = input({
  version: version(),
  /** What changed against the previous revision. */
  changeNote: text(2000).nullish(),
  /** The share of a hide's area the cutting plan expects to use, above 0 and at most 100 % (PRD-082). */
  plannedHideYieldPct: percent().nullish(),
})
export type UpdateRevisionBody = z.output<typeof updateRevisionBody>

/** A frozen revision copied into the style's next revision, a DRAFT. */
export const copyRevisionBody = input({ changeNote: text(2000).optional() })
export type CopyRevisionBody = z.output<typeof copyRevisionBody>

export const releaseBody = input({ version: version(), changeNote: text(2000).optional() })
export type ReleaseBody = z.output<typeof releaseBody>

export const obsoleteBody = input({ version: version(), reason: text(500).optional() })
export type ObsoleteBody = z.output<typeof obsoleteBody>

/** Two revisions of one style: what changed from the first to the second. */
export const compareQuery = input({ from: id(), to: id() })
export type CompareQuery = z.output<typeof compareQuery>

// ---- answers ----------------------------------------------------------------------------------------------------------

const ref = output({ id: id(), code: z.string(), name: z.string() })
const colourRef = output({ id: id(), code: z.string(), name: z.string(), status: z.enum(MASTER_STATUSES) })
/** A release-check finding: of the BOM (a line, a size, a colourway) or of the revision's routing (a step). */
const issue = output({
  code: z.enum([...BOM_ISSUE_CODES, ...ROUTING_ISSUE_CODES]),
  lineId: id().nullable(),
  size: z.string().nullable(),
  colourwayId: id().nullable(),
  stepId: id().nullable(),
  message: z.string(),
})

export const bomLineView = output({
  id: id(),
  seq: z.number().int(),
  item: output({ id: id(), code: z.string(), name: z.string(), kind: z.enum(ITEM_KINDS), status: z.enum(MATERIAL_STATUSES), baseUom: z.enum(UOMS) }),
  placement: z.string().nullable(),
  /** Per garment in `uom`: its one quantity, or the base size's when size-dependent. */
  qty: z.string(),
  uom: z.enum(UOMS),
  wastagePct: z.string(),
  sizeDependent: z.boolean(),
  colourDependent: z.boolean(),
  itemColour: colourRef.nullable(),
  colourway: ref.nullable(),
  supplier: ref.nullable(),
  note: z.string().nullable(),
  /** A size-dependent line's quantities, in the range's order. */
  sizes: z.array(output({ size: z.string(), qty: z.string() })),
  /** A colour-dependent line's grid, in the colourways' order. */
  colours: z.array(output({ colourwayId: id(), itemColour: colourRef })),
  /**
   * For each size of the range, per garment: `qty` before wastage and `gross` with it in the line's unit, `base` with it
   * in the material's base unit (rounded half up to 4 decimals); null where the line has no quantity for the size.
   */
  bySize: z.array(output({ size: z.string(), qty: z.string().nullable(), gross: z.string().nullable(), base: z.string().nullable() })),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type BomLineView = z.infer<typeof bomLineView>

export const bomRevisionView = output({
  id: id(),
  styleId: id(),
  revision: z.number().int(),
  status: z.enum(REVISION_STATUSES),
  changeNote: z.string().nullable(),
  plannedHideYieldPct: z.string().nullable(),
  labelTemplateId: id().nullable(),
  releasedAt: instant().nullable(),
  releasedById: id().nullable(),
  /** Sent back with every write to this revision's BOM. */
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type BomRevisionView = z.infer<typeof bomRevisionView>

/**
 * The BOM of one revision (SCR-042): its lines with their size quantities and colour grid, what one garment of each size
 * needs in each colourway (each material in its colour, in its base unit, waste included), and what still blocks the
 * release.
 */
export const bomView = output({
  revision: bomRevisionView,
  style: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), status: z.enum(STYLE_STATUSES), baseSize: z.string().nullable() }),
  /** The style's range, in the scale's order. */
  sizes: z.array(output({ code: z.string(), label: z.string() })),
  colourways: z.array(output({ id: id(), code: z.string(), name: z.string(), status: z.enum(MASTER_STATUSES) })),
  lines: z.array(bomLineView),
  /** Per ACTIVE colourway: each material (in its colour) per size of the range, in its base unit, rounded half up to 4 decimals. */
  requirements: z.array(
    output({
      colourwayId: id(),
      code: z.string(),
      materials: z.array(
        output({
          itemId: id(),
          code: z.string(),
          itemColourId: id().nullable(),
          itemColourCode: z.string().nullable(),
          uom: z.enum(UOMS),
          bySize: z.array(output({ size: z.string(), qty: z.string() })),
        }),
      ),
    }),
  ),
  /**
   * What stops the release: the BOM's blockers and the routing's (B-W1-14), exactly what the release refuses (a draft
   * only; a frozen revision is not checked again). Warnings of both are shown, never refused.
   */
  issues: z.array(issue),
  warnings: z.array(issue),
  /** A draft of a style that is not archived, with no issue: the release would pass. */
  releasable: z.boolean(),
})
export type BomView = z.infer<typeof bomView>

const fieldValue = z.union([z.string(), z.number(), z.boolean(), z.null()])
const fieldChange = output({ field: z.string(), from: fieldValue, to: fieldValue })
const lineRef = output({ lineId: id(), seq: z.number().int(), itemId: id(), code: z.string(), placement: z.string().nullable(), colourwayId: id().nullable() })
const revisionRef = output({ id: id(), revision: z.number().int(), status: z.enum(REVISION_STATUSES) })

/** What changed from one revision's BOM to another's. */
export const bomDiffView = output({
  from: revisionRef,
  to: revisionRef,
  revision: z.array(fieldChange),
  added: z.array(lineRef),
  removed: z.array(lineRef),
  changed: z.array(
    output({
      from: lineRef,
      to: lineRef,
      fields: z.array(fieldChange),
      sizes: z.array(output({ size: z.string(), from: z.string().nullable(), to: z.string().nullable() })),
      colours: z.array(output({ colourwayId: id(), from: id().nullable(), to: id().nullable() })),
    }),
  ),
  unchanged: z.number().int(),
})
export type BomDiffView = z.infer<typeof bomDiffView>
