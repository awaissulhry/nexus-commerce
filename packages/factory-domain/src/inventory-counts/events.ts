import { z } from 'zod'
import { defineEvent } from '../events/define'
import { ABC_CLASSES } from '../inventory/counts-depth/schedules'
import { SCAN_PASSES } from '../inventory/counts-depth/scans'

/**
 * The events of counts in depth (B-W2b-299; SCM-227, SCM-228; apps/factory-api modules/inventory/counts-depth). Context
 * `inventory-counts`, its own module folder (as inventory-locations and inventory-tasks: the inventory events file is other
 * steps'). They reach the counts screens (inventory.counts.view). Never a cost, never a person.
 *
 *   inventory.count_scanned            once per unit scanned into a running count (the floor's or a phone's "Scan every
 *                                      unit"): the line, the pass and how many units it holds now (the office's Lines read
 *                                      again); a finished bin also emits inventory.count_recorded (COUNTED, and
 *                                      RECOUNT_ASKED for the recounts the rule asks)
 *   inventory.count_schedule_changed   once per schedule made, changed, retired or made active again, and when a count that
 *                                      covered it closed (COUNTED: its next date moved)
 */

export const SCHEDULE_CHANGES = ['CREATED', 'CHANGED', 'RETIRED', 'REACTIVATED', 'COUNTED'] as const
export type ScheduleChange = (typeof SCHEDULE_CHANGES)[number]

export const events = [
  defineEvent({
    type: 'inventory.count_scanned',
    context: 'inventory-counts',
    description: 'A unit was scanned into a running stock count (a hide with its area, a roll with its length, pieces typed): the line it counts, the pass and how many units the line holds now.',
    payload: z.strictObject({
      countId: z.uuid(),
      number: z.string(),
      lineId: z.uuid(),
      locationId: z.uuid(),
      pass: z.enum(SCAN_PASSES),
      /** The line's scans of the pass after this one. */
      scans: z.number().int().min(1),
      /** The unit was not expected there: its line was added (ADDED) with this scan. */
      added: z.boolean(),
    }),
    live: { permission: 'inventory.counts.view', fields: ['countId', 'number', 'lineId', 'locationId', 'pass', 'scans', 'added'] },
  }),
  defineEvent({
    type: 'inventory.count_schedule_changed',
    context: 'inventory-counts',
    description: 'A count schedule was made, changed, retired or made active again, or a count that covered it closed and moved its next date.',
    payload: z.strictObject({
      scheduleId: z.uuid(),
      siteId: z.uuid(),
      change: z.enum(SCHEDULE_CHANGES),
      active: z.boolean(),
      nextDueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      locationId: z.uuid().nullable(),
      abcClass: z.enum(ABC_CLASSES).nullable(),
      itemKind: z.string().nullable(),
      /** COUNTED: the count that covered it. */
      countId: z.uuid().nullable(),
    }),
    live: { permission: 'inventory.counts.view', fields: ['scheduleId', 'siteId', 'change', 'active', 'nextDueOn'] },
  }),
] as const
