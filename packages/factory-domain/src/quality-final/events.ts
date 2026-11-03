import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The final inspection by plan (B-W2b-97; QHS-014, QHS-023, QHS-049, QHS-052, QHS-053, QHS-054; design floor.final "aql"
 * and quality.inspections "Counts arrive live from the bench (AqlCounter on floor.final)"). apps/factory-api's
 * modules/quality/final emits it in the commands that record on an inspection opened on a plan. Its own module folder:
 * the quality events file is other steps' (B-W1-45's inspection_opened / _decided / _cancelled stay there).
 *
 *   final_inspection.recorded   a result, a measurement, the serial or batch check, the units inspected or a photo was
 *                               recorded on an OPEN inspection on a plan: the office's Sample & AQL and Measurements tabs
 *                               and another bench open on the same lot read it again ("Also open on Bench 2")
 *
 * Reaches the office's inspection screens (quality.inspections.view) and the site's benches (the floor inspector holds
 * quality.inspections.view). Ids, counts and the verdict only, never a person or a measured value.
 */

export const RECORDED_WHAT = ['RESULTS', 'MEASUREMENTS', 'IDENTITY', 'COUNT', 'PHOTO'] as const
export type RecordedWhat = (typeof RECORDED_WHAT)[number]

export const events = [
  defineEvent({
    type: 'final_inspection.recorded',
    context: 'quality-final',
    description: 'Results, measurements, the serial or batch check, the units inspected or a photo were recorded on an open final inspection run on its plan.',
    payload: z.strictObject({
      inspectionId: z.uuid(),
      workOrderId: z.uuid(),
      what: z.enum(RECORDED_WHAT),
      /** Units of the sample inspected so far, and the sample. */
      inspected: z.number().int().min(0),
      sampleSize: z.number().int().min(1),
      /** The counter's verdict as it stands (accept only with the whole sample). */
      verdict: z.enum(['open', 'accept', 'reject']),
    }),
    live: { permission: 'quality.inspections.view', floor: 'quality.inspections.view', fields: ['inspectionId', 'workOrderId', 'what', 'inspected', 'sampleSize', 'verdict'] },
  }),
] as const
