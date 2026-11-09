import { z } from 'zod'
import { id, input, output } from '../../core/contracts'
import { MAX_BOM_LINES } from '../bom/rules'
import { ITEM_KINDS, ITEM_SOURCINGS, MATERIAL_STATUSES } from '../materials/rules'
import { MASTER_STATUSES } from '../sizes/rules'
import { REVISION_STATUSES } from '../styles/revisions'
import { STYLE_STATUSES } from '../styles/rules'
import { UOMS } from '../units/units'
import { BOM_CHECK_CODES, BOM_CHECK_COLUMNS, BOM_CHECK_SEVERITIES } from './check'
import { EXPLODE_PROBLEMS } from './explode'
import { BOM_SECTIONS, MATERIAL_APPROVALS } from './rules'

/**
 * The BOM structure's contracts (B-W2b-223; PRD-077, PRD-078, PRD-087, PRD-106; design style.bom: the Section column and
 * group rows, the Sub-assemblies tree, the BOM check): what apps/factory-api's modules/product/bom-structure accepts and
 * answers. No money (a cost is the cost sheet's). Every write sends the revision's `version` (COL-078): the BOM of a revision
 * is one versioned record, as W1's lines.
 */

const version = () => z.number().int().min(1)
const section = z.enum(BOM_SECTIONS)
const subAssembly = input({ styleId: id(), revisionId: id() })

/**
 * One line's structure: its section (null: not filed), the line it is grouped under (null: not grouped), the revision of
 * another style it takes as a sub-assembly (null: none). What is left out stays.
 */
export const setLineStructureBody = input({
  version: version(),
  section: section.nullable().optional(),
  parentLineId: id().nullable().optional(),
  subAssembly: subAssembly.nullable().optional(),
}).refine((body) => body.section !== undefined || body.parentLineId !== undefined || body.subAssembly !== undefined, {
  message: 'Send a section, a group row or a sub-assembly.',
})
export type SetLineStructureBody = z.output<typeof setLineStructureBody>

/** The list's selection (Owner rule 2026-10-29): several lines filed under one section and/or grouped under one line (null: ungrouped). */
export const changeStructureBody = input({
  version: version(),
  lineIds: z.array(id()).min(1).max(MAX_BOM_LINES),
  section: section.nullable().optional(),
  parentLineId: id().nullable().optional(),
}).refine((body) => body.section !== undefined || body.parentLineId !== undefined, { message: 'Send a section or a group row.' })
export type ChangeStructureBody = z.output<typeof changeStructureBody>

/** Comma-separated ids or size codes in a query string ("a,b"); empty: none. */
const list = (max: number) =>
  z
    .string()
    .max(4000)
    .transform((value) => [...new Set(value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== ''))])
    .refine((values) => values.length <= max, { message: `At most ${max}.` })

/** The explosion of one colourway (default: the style's first active one), the sizes asked (default: the range), the options chosen. */
export const explosionQuery = input({
  colourwayId: id().optional(),
  sizes: list(60).optional(),
  options: list(50).refine((values) => values.every((value) => z.uuid().safeParse(value).success), { message: 'Option values are ids.' }).optional(),
})
export type ExplosionQuery = z.output<typeof explosionQuery>

// ---- answers ------------------------------------------------------------------------------------------------------------

const revisionRef = output({ id: id(), styleId: id(), revision: z.number().int(), status: z.enum(REVISION_STATUSES), version: z.number().int() })
const styleRef = output({ id: id(), code: z.string(), name: z.string() })
const itemRef = output({ id: id(), code: z.string(), name: z.string(), kind: z.enum(ITEM_KINDS) })

export const bomCheckItemView = output({
  code: z.enum(BOM_CHECK_CODES),
  severity: z.enum(BOM_CHECK_SEVERITIES),
  message: z.string(),
  /** Where "Show me" lands: the line and its column, the size, the colourway, the alternate or the routing step. */
  cell: output({
    lineId: id().nullable(),
    column: z.enum(BOM_CHECK_COLUMNS).nullable(),
    size: z.string().nullable(),
    colourwayId: id().nullable(),
    alternateId: id().nullable(),
    stepId: id().nullable(),
  }),
})

/**
 * THE BOM check of a revision (PRD-087): W1's release check (BOM and routing) and the structure's, each problem with its
 * cell; exactly what the release refuses (blockers) and shows (warnings). Only a draft is checked: a released revision is
 * frozen (`checked` false).
 */
export const bomCheckView = output({
  revision: revisionRef,
  checked: z.boolean(),
  blockers: z.array(bomCheckItemView),
  warnings: z.array(bomCheckItemView),
  /** The tab's problem mark: blockers and warnings. */
  count: z.number().int(),
  /** A draft of a style that is not archived, with no blocker: the release would pass the check. */
  releasable: z.boolean(),
})
export type BomCheckView = z.infer<typeof bomCheckView>

const subAssemblyRef = output({
  style: output({ id: id(), code: z.string(), name: z.string(), status: z.enum(STYLE_STATUSES) }),
  revision: output({ id: id(), revision: z.number().int(), status: z.enum(REVISION_STATUSES) }),
  /** What its BOM makes. */
  outputQuantity: z.number().int(),
  outputUom: z.enum(UOMS),
})

export const structureLineView = output({
  id: id(),
  seq: z.number().int(),
  item: output({ id: id(), code: z.string(), name: z.string(), kind: z.enum(ITEM_KINDS), sourcing: z.enum(ITEM_SOURCINGS), status: z.enum(MATERIAL_STATUSES), approval: z.enum(MATERIAL_APPROVALS) }),
  placement: z.string().nullable(),
  qty: z.string(),
  uom: z.enum(UOMS),
  /** The section it is shown under: its own (`filed`), else its material's kind's. */
  section: z.enum(BOM_SECTIONS),
  filed: z.boolean(),
  /** The line it is grouped under (null: not grouped); its depth in the group rows (0: not grouped), and the lines grouped under it. */
  parentLineId: id().nullable(),
  depth: z.number().int(),
  groupedLineIds: z.array(id()),
  subAssembly: subAssemblyRef.nullable(),
  /** B-W2b-211's other columns, read only here (B-W2b-228 and B-W2b-229 write them). */
  customerSuppliedByPartyId: id().nullable(),
  issueToSubcontract: z.boolean(),
  sourceKey: z.string().nullable(),
  optionValueId: id().nullable(),
  alternates: z.number().int(),
})

/** One row of the sub-assembly tree (depth first): a sub-assembly line at its level, under the lines in `via`. */
export const subAssemblyNodeView = output({
  level: z.number().int(),
  /** The sub-assembly lines above it, top first (empty on level 1). */
  via: z.array(id()),
  /** The revision the line is in, and the line. */
  revisionId: id(),
  lineId: id(),
  seq: z.number().int(),
  item: itemRef,
  qty: z.string(),
  uom: z.enum(UOMS),
  subAssembly: subAssemblyRef,
  /** Its own BOM's lines and sub-assemblies. */
  lines: z.number().int(),
  subAssemblies: z.number().int(),
})

/**
 * The structure of one revision's BOM (design style.bom: Section column, group rows, Sub-assemblies): its lines in the
 * order a grouped BOM is read, the sections with their lines, the sub-assembly tree to its deepest level, what the revision
 * makes, and the BOM check.
 */
export const bomStructureView = output({
  revision: revisionRef,
  style: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), status: z.enum(STYLE_STATUSES) }),
  /** A draft of a style that is not archived: the structure can be changed. */
  editable: z.boolean(),
  outputQuantity: z.number().int(),
  outputUom: z.enum(UOMS),
  lines: z.array(structureLineView),
  /** Every section in BOM order with its lines (by id, in the grouped order); empty sections left out. */
  sections: z.array(output({ section: z.enum(BOM_SECTIONS), lineIds: z.array(id()) })),
  /** The tree of sub-assemblies, depth first; the deepest level. */
  tree: z.array(subAssemblyNodeView),
  levels: z.number().int(),
  check: bomCheckView,
})
export type BomStructureView = z.infer<typeof bomStructureView>

const explodedRow = {
  level: z.number().int(),
  revisionId: id(),
  lineId: id(),
  via: z.array(id()),
  item: itemRef,
  itemColourId: id().nullable(),
  /** The material's base unit. */
  uom: z.enum(UOMS),
  /** Per output batch of the revision asked (its lines as written), waste included, rounded half up to 4 decimals. */
  quantity: z.string(),
  customerSupplied: z.boolean(),
  issueToSubcontract: z.boolean(),
}

/**
 * The multi-level explosion of one revision (PRD-078): per size, every material down to the deepest sub-assembly (each row
 * at its level, under the lines in `via`), every sub-assembly (the component we make, how many of its batches, in which of
 * its sizes and colourways), each material summed (byMaterial), and what could not be walked. Planning, kits and cost read it.
 */
export const explosionView = output({
  revision: revisionRef,
  style: styleRef,
  colourway: output({ id: id(), code: z.string(), status: z.enum(MASTER_STATUSES) }),
  options: z.array(id()),
  outputQuantity: z.number().int(),
  outputUom: z.enum(UOMS),
  sizes: z.array(
    output({
      size: z.string(),
      materials: z.array(output(explodedRow)),
      subAssemblies: z.array(
        output({
          ...explodedRow,
          subAssembly: output({ style: styleRef, revision: output({ id: id(), revision: z.number().int(), status: z.enum(REVISION_STATUSES) }) }),
          size: z.string().nullable(),
          colourwayId: id().nullable(),
          batches: z.string().nullable(),
        }),
      ),
      /** Each material summed over every level (its colour, who supplies it), the levels it comes from. */
      byMaterial: z.array(
        output({
          item: itemRef,
          itemColourId: id().nullable(),
          uom: z.enum(UOMS),
          quantity: z.string(),
          customerSupplied: z.boolean(),
          levels: z.array(z.number().int()),
        }),
      ),
      problems: z.array(output({ code: z.enum(EXPLODE_PROBLEMS), level: z.number().int(), revisionId: id(), lineId: id(), message: z.string() })),
    }),
  ),
})
export type ExplosionView = z.infer<typeof explosionView>

/** Where a style is used as a sub-assembly ("made once, used in several jackets"): every line of another style's revision that takes one of its revisions. */
export const usedInView = output({
  style: output({ id: id(), code: z.string(), name: z.string(), status: z.enum(STYLE_STATUSES) }),
  usedIn: z.array(
    output({
      style: output({ id: id(), code: z.string(), name: z.string(), status: z.enum(STYLE_STATUSES) }),
      revision: output({ id: id(), revision: z.number().int(), status: z.enum(REVISION_STATUSES) }),
      lineId: id(),
      seq: z.number().int(),
      qty: z.string(),
      uom: z.enum(UOMS),
      /** The revision of this style it takes. */
      takes: output({ id: id(), revision: z.number().int(), status: z.enum(REVISION_STATUSES) }),
    }),
  ),
})
export type UsedInView = z.infer<typeof usedInView>
