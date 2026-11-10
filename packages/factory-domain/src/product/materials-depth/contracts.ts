import { z } from 'zod'
import { id, input, instant, output } from '../../core/contracts'
import { ITEM_KINDS, MATERIAL_STATUSES } from '../materials/rules'
import { APPROVAL_NOTE_MAX, FIBRE_FINDINGS, MATERIAL_APPROVALS, PROPERTY_SHAPES, WHERE_USED_ROLES } from './rules'

/**
 * The contracts of materials in depth (B-W2b-238; PRD-029, PRD-033, PRD-035, PRD-036): what apps/factory-api's
 * modules/product/materials-depth accepts and answers, and what the web's typed client reads. No money (a material's cost
 * is W1's, behind the cost grain); the only person is who decided the approval, by id and display name, inside the
 * material's own record.
 */

const version = () => z.number().int().min(1)

export const materialParams = input({ materialId: id() })
export const revisionParams = input({ styleId: id(), revisionId: id() })

/**
 * The typed properties of the material's kind, all at once (what is left out is cleared; null clears them all). Decimals
 * as strings ("180", "150.5"); the rules per kind are factory-domain product/materials-depth/rules.
 */
export const propertiesBody = input({
  version: version(),
  properties: z.record(z.string().max(40), z.union([z.string().max(200), z.boolean(), z.null()])).nullable(),
  reason: z.string().trim().min(1).max(500).optional(),
})
export type PropertiesBody = z.output<typeof propertiesBody>

/** A decision on the material's approval: a condition and a block say why (`note`, one line). */
export const approvalBody = input({
  version: version(),
  approval: z.enum(MATERIAL_APPROVALS),
  note: z.string().max(APPROVAL_NOTE_MAX * 2).nullish(),
})
export type ApprovalBody = z.output<typeof approvalBody>

/** `?itemColourId=` only the lines that use that colour of the material. */
export const whereUsedQuery = input({ itemColourId: id().optional() })
export type WhereUsedQuery = z.output<typeof whereUsedQuery>

// ---- answers ----------------------------------------------------------------------------------------------------------

const materialRef = output({ id: id(), code: z.string(), name: z.string(), kind: z.enum(ITEM_KINDS), companyId: id().nullable(), status: z.enum(MATERIAL_STATUSES), version: z.number().int() })
const personRef = output({ id: id(), name: z.string() })

export const fibreReadingView = output({
  fibre: z.string(),
  percent: z.string(),
  annexFibre: z.string().nullable(),
  official: output({ it: z.string().nullable(), en: z.string().nullable() }).nullable(),
  finding: z.enum(FIBRE_FINDINGS).nullable(),
  message: z.string().nullable(),
})

/** Where a decision reaches: the revisions naming it and the open work orders of the released ones. */
export const approvalReachView = output({
  styles: z.number().int(),
  draftRevisions: z.number().int(),
  releasedRevisions: z.number().int(),
  /** null: the person does not read work orders. */
  openWorkOrders: z.number().int().nullable(),
})

export const approvalView = output({
  approval: z.enum(MATERIAL_APPROVALS),
  note: z.string().nullable(),
  decidedAt: instant().nullable(),
  /** Who decided (null: pending, or decided by a release before W2b-4 named nobody). */
  decidedBy: personRef.nullable(),
})

/** GET /product/materials/:materialId/depth — the material's properties of its kind, its fibres as the label reads them, its approval. */
export const materialDepthView = output({
  material: materialRef,
  properties: output({
    /** Which typed properties its kind has (null: none, its fields are W1's or Other attributes). */
    shape: z.enum(PROPERTY_SHAPES).nullable(),
    keys: z.array(z.string()),
    values: z.record(z.string(), z.union([z.string(), z.boolean()])).nullable(),
  }),
  fibres: z.array(fibreReadingView),
  approval: approvalView,
  reach: approvalReachView,
  /** What a block would do now, in words (English; the screens say their own from `reach`). */
  consequences: z.array(z.string()),
})
export type MaterialDepthView = z.infer<typeof materialDepthView>

export const colourRef = output({ id: id(), code: z.string(), name: z.string() })

/** One BOM line (or alternate on a line) that names the material. */
export const whereUsedRow = output({
  lineId: id(),
  role: z.enum(WHERE_USED_ROLES),
  /** An alternate's priority on its line (null for the line itself). */
  priority: z.number().int().nullable(),
  style: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), status: z.string() }),
  revision: output({ id: id(), revision: z.number().int(), status: z.string() }),
  seq: z.number().int(),
  placement: z.string().nullable(),
  section: z.string().nullable(),
  /** The material's colour the line takes for every colourway (null: per colourway, or none). */
  colour: colourRef.nullable(),
  /** Per colourway: the colourway and the material's colour it takes. */
  colourways: z.array(output({ colourwayId: id(), colourwayCode: z.string(), colour: colourRef })),
  /** The revision's open work orders (null: the person does not read work orders). */
  openWorkOrders: z.array(output({ id: id(), number: z.string(), status: z.string(), siteId: id() })).nullable(),
})
export type WhereUsedRow = z.infer<typeof whereUsedRow>

/** GET /product/materials/:materialId/where-used */
export const materialWhereUsedView = output({
  material: materialRef,
  /** False: the person reads no styles (product.styles.view): no row, no count. */
  stylesAllowed: z.boolean(),
  workOrdersAllowed: z.boolean(),
  summary: output({
    styles: z.number().int(),
    draftRevisions: z.number().int(),
    releasedRevisions: z.number().int(),
    obsoleteRevisions: z.number().int(),
    lines: z.number().int(),
    alternates: z.number().int(),
    openWorkOrders: z.number().int().nullable(),
  }),
  /** The material's colours with the lines that take each (the colour filter). */
  colours: z.array(output({ colour: colourRef, status: z.enum(MATERIAL_STATUSES), lines: z.number().int() })),
  itemColourId: id().nullable(),
  rows: z.array(whereUsedRow),
  more: z.boolean(),
})
export type MaterialWhereUsedView = z.infer<typeof materialWhereUsedView>

/** GET /product/styles/:styleId/revisions/:revisionId/material-approvals — the style's Compliance › Material checks. */
export const materialApprovalsView = output({
  style: output({ id: id(), code: z.string() }),
  revision: output({ id: id(), revision: z.number().int(), status: z.string() }),
  materials: z.array(
    output({
      itemId: id(),
      code: z.string(),
      name: z.string(),
      kind: z.enum(ITEM_KINDS),
      approval: z.enum(MATERIAL_APPROVALS),
      note: z.string().nullable(),
      isPpeComponent: z.boolean(),
      /** The lines that name it, by seq, and whether only as an alternate. */
      lines: z.array(z.number().int()),
      alternateOnly: z.boolean(),
    }),
  ),
  counts: output({ blocked: z.number().int(), conditional: z.number().int(), pending: z.number().int(), approved: z.number().int() }),
  /** No blocked material: what the database and the release gate need of the approvals. */
  releasable: z.boolean(),
})
export type MaterialApprovalsView = z.infer<typeof materialApprovalsView>
