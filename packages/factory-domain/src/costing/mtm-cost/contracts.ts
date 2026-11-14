import { z } from 'zod'
import { businessDate, id, input, instant, output } from '../../core/contracts'
import { money } from '../../money/marked'
import { mtmCheckBody } from '../../product/mtm-rules/contracts'
import { WORK_CENTRE_KINDS } from '../../product/routing/operations'
import { REVISION_STATUSES } from '../../product/styles/revisions'
import { MAX_ALTERATIONS } from './rules'

/**
 * The contracts of one made-to-measure unit's cost (B-W2b-423; FIN-017): the base size's cost, the extra material of the lines
 * that scale with the rider's measures, the alteration minutes and the unit's options. Every cost is money.cost; the base
 * size, the scaled quantities, minutes and words stay. Body measures are read from a rider's profile (sales.measurements.view)
 * or typed; none is ever answered back.
 */

export const mtmCostBody = input({
  styleId: id(),
  /** The company costed: the style's own; for a tenant-wide style, required. */
  companyId: id().optional(),
  colourwayId: id().optional(),
  revisionId: id().optional(),
  /** A rider's measurement profile revision (its customer's measurements right), or typed measures: one of the two. */
  measurementProfileId: id().optional(),
  measurements: mtmCheckBody.shape.measurements,
  /** The base size (left out: the one the measures point to). */
  baseSize: mtmCheckBody.shape.baseSize,
  /** The unit's options (its special parts). */
  optionValueIds: z.array(id()).max(40).optional(),
  /** How many garments an export carton holds (the carton's share, as B-W2b-418's components ask it). */
  piecesPerCarton: z.number().int().min(1).max(10000).optional(),
  /** The minutes the pattern maker and the floor add for this unit, per kind of work centre. */
  alterations: z.array(input({ workCentreKind: z.enum(WORK_CENTRE_KINDS), minutes: z.string() })).max(MAX_ALTERATIONS).optional(),
})
export type MtmCostBody = z.output<typeof mtmCostBody>

export const mtmScaledLineView = output({
  lineId: id(),
  seq: z.number().int(),
  itemCode: z.string(),
  uom: z.string(),
  baseQty: z.string().nullable(),
  unitQty: z.string().nullable(),
  detail: z.string(),
})

export const mtmCostView = output({
  style: output({ id: id(), code: z.string(), name: z.string() }),
  revision: output({ id: id(), revision: z.number().int(), status: z.enum(REVISION_STATUSES) }),
  template: output({ id: id(), code: z.string(), rulesOn: z.boolean() }),
  companyId: id(),
  currency: z.string(),
  on: businessDate(),
  colourway: output({ id: id(), code: z.string(), name: z.string() }),
  baseSize: output({ size: z.string(), how: z.string() }),
  scaled: z.array(mtmScaledLineView),
  alterations: z.array(output({ workCentreKind: z.enum(WORK_CENTRE_KINDS), minutes: z.string() })),
  options: z.array(output({ valueId: id(), code: z.string(), name: z.string(), atBaseSize: money.cost(z.string().nullable()) })),
  breakdown: output({
    base: money.cost(z.string().nullable()),
    extraMaterial: money.cost(z.string().nullable()),
    alteration: money.cost(z.string().nullable()),
    options: money.cost(z.string().nullable()),
    total: money.cost(z.string().nullable()),
  }),
  complete: z.boolean(),
  missing: z.array(z.string()),
  /** The check's findings that would hold the unit (outside the certified range, a rule broken), in words. */
  holds: z.array(z.string()),
  notes: z.array(z.string()),
  computedAt: instant(),
})
export type MtmCostView = z.infer<typeof mtmCostView>
