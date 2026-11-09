import { z } from 'zod'
import { id, input, instant, output } from '../../core/contracts'
import { ROW_OUTCOMES } from './rules'

/**
 * The contracts of GTINs in depth (B-W2b-227; PRD-006): GS1 ranges, assigning from one (preview, then confirm), and a list
 * of a brand's own barcodes typed or imported. No money; a GTIN is a product code, not personal data.
 */

const version = () => z.number().int().min(1)
const reason = () => z.string().trim().min(1).max(500)
const MASTER_STATUSES = ['ACTIVE', 'ARCHIVED'] as const

export const rangeParams = input({ rangeId: id() })
export const styleParams = input({ styleId: id() })
export const rangesQuery = input({ companyId: id().optional(), status: z.enum(MASTER_STATUSES).optional() })

const reference = () => z.number().int().min(0).max(99_999_999)

export const createRangeBody = input({
  companyId: id(),
  name: z.string().max(200),
  gs1Prefix: z.string().trim().max(20),
  firstReference: reference(),
  lastReference: reference(),
  reason: reason().optional(),
})
export type CreateRangeBody = z.output<typeof createRangeBody>

/** A range changed at its version: its name always; its prefix and limits only while no number was given. */
export const updateRangeBody = input({
  version: version(),
  name: z.string().max(200).optional(),
  gs1Prefix: z.string().trim().max(20).optional(),
  firstReference: reference().optional(),
  lastReference: reference().optional(),
  reason: reason().optional(),
})
export type UpdateRangeBody = z.output<typeof updateRangeBody>

export const rangeStatusBody = input({ version: version(), reason: reason().optional() })
export type RangeStatusBody = z.output<typeof rangeStatusBody>

export const rangeView = output({
  id: id(),
  companyId: id(),
  name: z.string(),
  gs1Prefix: z.string(),
  firstReference: z.number().int(),
  lastReference: z.number().int(),
  nextReference: z.number().int(),
  /** References still to give. */
  left: z.number().int(),
  /** A number was given: the prefix and limits are fixed. */
  used: z.boolean(),
  /** The GTIN the next reference makes (null: used up). */
  nextGtin: z.string().nullable(),
  status: z.enum(MASTER_STATUSES),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type RangeView = z.infer<typeof rangeView>

/** Whether assigning from a range is open in this environment (GATE-SPEND), in words. */
export const allocationGateView = output({ open: z.boolean(), refusal: z.enum(['GATE_SPEND']).nullable(), message: z.string().nullable() })

export const rangesView = output({ ranges: z.array(rangeView), allocation: allocationGateView })
export type RangesView = z.infer<typeof rangesView>

/**
 * GTINs for a style's SKUs from a range. `skuIds` left out: every SKU switched on without a GTIN. `dryRun: true` is the
 * preview (nothing written); the confirm sends the preview's `rangeVersion` and `count` back, so a range another person used
 * meanwhile, or SKUs that changed, are refused rather than given other numbers than shown.
 */
export const assignBody = input({
  rangeId: id(),
  skuIds: z.array(id()).min(1).max(500).optional(),
  dryRun: z.boolean(),
  rangeVersion: version().optional(),
  count: z.number().int().min(1).optional(),
  reason: reason().optional(),
})
export type AssignBody = z.output<typeof assignBody>

export const assignView = output({
  dryRun: z.boolean(),
  range: rangeView,
  /** The range's version the preview read (send it back with the confirm). */
  rangeVersion: z.number().int(),
  assignments: z.array(output({ skuId: id(), sku: z.string(), reference: z.number().int(), gtin: z.string() })),
  /** References passed over: their GTIN is on a SKU already. */
  skipped: z.array(output({ reference: z.number().int(), gtin: z.string() })),
  count: z.number().int(),
  /** SKUs the range has no number left for. */
  short: z.number().int(),
  /** SKUs asked for that are not given one, and why (a GTIN already, switched off, not of this style). */
  notNumbered: z.array(output({ skuId: id(), sku: z.string(), message: z.string() })),
  allocation: allocationGateView,
})
export type AssignView = z.infer<typeof assignView>

/** A brand's own barcodes: SKU code + GTIN (null or "": remove it), typed or read from the brand's sheet. */
export const importBody = input({
  rows: z
    .array(input({ sku: z.string().trim().min(1).max(80), gtin: z.string().max(40).nullable() }))
    .min(1)
    .max(2000),
  dryRun: z.boolean(),
  reason: reason().optional(),
})
export type ImportBody = z.output<typeof importBody>

export const importView = output({
  dryRun: z.boolean(),
  /** Every row's verdict in the order sent. */
  rows: z.array(
    output({
      line: z.number().int(),
      sku: z.string(),
      skuId: id().nullable(),
      styleId: id().nullable(),
      gtin: z.string().nullable(),
      before: z.string().nullable(),
      outcome: z.enum(ROW_OUTCOMES),
      message: z.string().nullable(),
    }),
  ),
  counts: output({ set: z.number().int(), cleared: z.number().int(), unchanged: z.number().int(), refused: z.number().int() }),
  /** Written (false for a dry run, or while a row is refused: the list is written all together or not at all). */
  applied: z.boolean(),
})
export type ImportView = z.infer<typeof importView>
