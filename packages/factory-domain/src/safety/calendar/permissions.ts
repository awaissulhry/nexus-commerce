import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Safety at work: the deadlines typed on the safety calendar (apps/factory-api modules/safety/calendar; B-W2b-120;
 * QHS-227; design plant.calendar "Add deadline", "Deadline"), in the safety area. Reading the calendar is safety.view
 * (../organisation/permissions.ts); the deadlines other pages own (training, visits, machine checks, the DVR, incidents)
 * are changed on their own pages, never here.
 */
export const SAFETY_CALENDAR_DEFINITIONS = definePermissions('safety', {
  'calendar.manage': {
    risk: 'write',
    description:
      'Add a deadline to the safety calendar (a drill, the periodic safety meeting, an inspection, a renewal, a report to an authority) with its owner, repeat and whether evidence is required; change it, upload its evidence, mark it done (a repeating one makes its next occurrence) or cancel it with the reason.',
  },
})

export const SAFETY_CALENDAR_MANAGE = 'safety.calendar.manage' satisfies Permission

export const SAFETY_CALENDAR_PERMISSIONS: readonly Permission[] = Object.freeze([SAFETY_CALENDAR_MANAGE])
