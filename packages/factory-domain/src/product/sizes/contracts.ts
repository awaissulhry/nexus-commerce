import { z } from 'zod'
import { id, input, instant, output } from '../../core/contracts'
import { fitsDecimal } from '../../core/money'
import { BODY_MEASURE_UNITS, MASTER_STATUSES, MAX_SCALE_SIZES, SCALE_CODE, SCALE_CODE_RULE, SIZE_CODE, SIZE_CODE_RULE } from './rules'

/**
 * The size scale library's contracts (A2 SCR-049 "Libraries", size scales tab; PRD-047): what apps/factory-api's
 * modules/product/styles accepts and answers for scales, and what the web's typed client reads. No money here.
 * Decimals travel as plain decimal strings ("102.5").
 */

const text = (max: number) => z.string().trim().min(1).max(max)
const version = () => z.number().int().min(1)

export const scaleCode = () => z.string().trim().toUpperCase().regex(SCALE_CODE, { message: `Expected ${SCALE_CODE_RULE}.` })
export const sizeCode = () => z.string().trim().toUpperCase().regex(SIZE_CODE, { message: `Expected ${SIZE_CODE_RULE}.` })

const measureValue = () =>
  z.string().refine((value) => /^\d+(?:\.\d+)?$/.test(value) && fitsDecimal(value, 8, 2), { message: 'Expected a number with at most 6 digits and 2 decimals.' })

/** One body measure of a size: its range (at least one end) and unit. */
export const bodyMeasure = input({ min: measureValue().nullable(), max: measureValue().nullable(), unit: z.enum(BODY_MEASURE_UNITS) })
/** Body measures by measurement point code: { "chest": { "min": "100", "max": "104", "unit": "cm" } }. */
export const bodyMeasures = () => z.record(z.string().max(40), bodyMeasure)

/** A size of a new scale, or one added to a scale. */
export const sizeBody = input({
  code: sizeCode(),
  /** How it is shown when not by its code ("52 (L)"). */
  label: text(40).nullish(),
  bodyMeasures: bodyMeasures().nullish(),
})
export type SizeBody = z.output<typeof sizeBody>

export const createScaleBody = input({
  /** The company it belongs to; left out or null: tenant-wide (every company of the tenant). */
  companyId: id().nullish(),
  code: scaleCode(),
  name: text(120),
  /** From small to large. */
  sizes: z.array(sizeBody).min(1).max(MAX_SCALE_SIZES),
})
export type CreateScaleBody = z.output<typeof createScaleBody>

/** The name always; the code only while no style uses the scale. */
export const updateScaleBody = input({ version: version(), code: scaleCode().optional(), name: text(120).optional() })
export type UpdateScaleBody = z.output<typeof updateScaleBody>

/** Sizes added to a scale (also one in use): before the size `before`, or at the end. */
export const addSizesBody = input({ version: version(), sizes: z.array(sizeBody).min(1).max(MAX_SCALE_SIZES), before: sizeCode().optional() })
export type AddSizesBody = z.output<typeof addSizesBody>

/** The order of every size of a scale no style uses yet. */
export const reorderSizesBody = input({ version: version(), codes: z.array(sizeCode()).min(1).max(MAX_SCALE_SIZES) })
export type ReorderSizesBody = z.output<typeof reorderSizesBody>

/** A size's label and measures always; its code only while unused; ARCHIVED takes it out of new ranges, ACTIVE restores it. */
export const updateSizeBody = input({
  version: version(),
  code: sizeCode().optional(),
  label: text(40).nullish(),
  bodyMeasures: bodyMeasures().nullish(),
  status: z.enum(MASTER_STATUSES).optional(),
})
export type UpdateSizeBody = z.output<typeof updateSizeBody>

export const scaleStatusBody = input({ version: version(), reason: text(500).optional() })

export const listScalesQuery = input({
  /** Over code and name. */
  q: z.string().trim().max(100).optional(),
  status: z.enum([...MASTER_STATUSES, 'ALL']).default('ACTIVE'),
  /** Exactly this company's scales and the tenant-wide ones. */
  companyId: id().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
})
export type ListScalesQuery = z.output<typeof listScalesQuery>

// ---- answers ----------------------------------------------------------------------------------------------------------

const bodyMeasureView = output({ min: z.string().nullable(), max: z.string().nullable(), unit: z.enum(BODY_MEASURE_UNITS) })

export const sizeView = output({
  id: id(),
  code: z.string(),
  label: z.string().nullable(),
  /** Its place in the scale, from 1. */
  seq: z.number().int(),
  bodyMeasures: z.record(z.string(), bodyMeasureView).nullable(),
  status: z.enum(MASTER_STATUSES),
  version: z.number().int(),
  /** A style, SKU, BOM, certificate or order line names it: its code never changes. */
  inUse: z.boolean(),
})
export type SizeView = z.infer<typeof sizeView>

const summary = {
  id: id(),
  companyId: id().nullable(),
  code: z.string(),
  name: z.string(),
  /** The active size codes, from small to large. */
  codes: z.array(z.string()),
  /** The styles that use it (any status): while there are none, its codes and order may change. */
  styleCount: z.number().int(),
  status: z.enum(MASTER_STATUSES),
  version: z.number().int(),
  updatedAt: instant(),
}

/** A row of the size scale list (SCR-049). */
export const scaleRow = output(summary)
export type ScaleRow = z.infer<typeof scaleRow>

/** A size scale with every size, archived ones included (SCR-049). */
export const scaleView = output({
  ...summary,
  sizes: z.array(sizeView),
  /** The units its sizes measure each point in. */
  measureUnits: z.record(z.string(), z.enum(BODY_MEASURE_UNITS)),
  createdAt: instant(),
  createdById: id().nullable(),
})
export type ScaleView = z.infer<typeof scaleView>
