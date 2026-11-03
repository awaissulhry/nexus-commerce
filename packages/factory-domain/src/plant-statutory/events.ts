import { z } from 'zod'
import { defineEvent } from '../events/define'
import { CHECK_INTERVAL_UNITS, CHECK_OUTCOMES } from '../plant/statutory/rules'

/**
 * Statutory periodic checks of machines (B-W2b-124; QHS-205; D.Lgs. 81/2008 art. 71; design plant.preventive "Live":
 * "check.due → tones", plant.settings "settings.changed"). apps/factory-api's modules/plant/statutory emits them in the
 * commands that make the change, and the reminders' cron in its system command. Its own module folder: the plant events
 * file is other steps' (B-W2a-35, B-W2b-96), as quality-incoming (B-W2b-98).
 *
 *   machine_check_type.changed   a check type of the group was added, changed, retired or made active again
 *   machine_check_plan.changed   a machine's check plan was made (maybe in place of an ended one), changed, moved to
 *                                another due date or ended
 *   machine_check.recorded       a check's result went into the register (maybe a correction), with the plan's next due
 *                                date, and the job it made and the lock it put on the machine in the same step
 *   machine_check.due            the reminder of a plan's next due date: its window opened (or it is overdue already)
 *
 * Reach the office's plant screens (plant.view); never a tablet (checks are the office's). Ids, codes, dates and states
 * only: no words a person typed, no person (the plan's owner is read on the plan).
 */

const live = { permission: 'plant.view', fields: ['planId', 'machineId', 'checkTypeId'] } as const
const day = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const events = [
  defineEvent({
    type: 'machine_check_type.changed',
    context: 'plant-statutory',
    description: 'A statutory check type of the group was added, changed, retired or made active again (its code and what changed).',
    payload: z.strictObject({ checkTypeId: z.uuid(), code: z.string(), change: z.enum(['ADDED', 'CHANGED', 'RETIRED', 'RESTORED']) }),
    live: { permission: 'plant.view', fields: ['checkTypeId', 'code', 'change'] },
  }),
  defineEvent({
    type: 'machine_check_plan.changed',
    context: 'plant-statutory',
    description: "A machine's check plan was made (maybe in place of an ended one), changed, moved to another due date or ended, with its next due date.",
    payload: z.strictObject({
      planId: z.uuid(),
      machineId: z.uuid(),
      assetNumber: z.string(),
      checkTypeId: z.uuid(),
      change: z.enum(['CREATED', 'CHANGED', 'MOVED', 'ENDED']),
      nextDueOn: day(),
      interval: z.number().int().min(1),
      intervalUnit: z.enum(CHECK_INTERVAL_UNITS),
      /** The ACTIVE plan it ended in the same command (CREATED in place of another), else null. */
      replacedPlanId: z.uuid().nullable(),
      fields: z.array(z.string()),
    }),
    live: { ...live, fields: ['planId', 'machineId', 'checkTypeId', 'change', 'nextDueOn'] },
  }),
  defineEvent({
    type: 'machine_check.recorded',
    context: 'plant-statutory',
    description: "A check's result went into the register (maybe a correction of an earlier one), with the next due date of its plan, and the maintenance job and the unsafe lock it made in the same step.",
    payload: z.strictObject({
      resultId: z.uuid(),
      machineId: z.uuid(),
      assetNumber: z.string(),
      checkTypeId: z.uuid(),
      planId: z.uuid().nullable(),
      performedOn: day(),
      outcome: z.enum(CHECK_OUTCOMES),
      correctsId: z.uuid().nullable(),
      /** The plan's next due date after it (null: no plan, or the plan did not move). */
      planNextDueOn: day().nullable(),
      jobId: z.uuid().nullable(),
      /** The unsafe request that locks the machine (Owner answer H1), when the check locked it. */
      lockRequestId: z.uuid().nullable(),
    }),
    live: { permission: 'plant.view', fields: ['resultId', 'planId', 'machineId', 'checkTypeId', 'outcome'] },
  }),
  defineEvent({
    type: 'machine_check.due',
    context: 'plant-statutory',
    description: "The reminder of a check plan's next due date: its reminder window opened, or the check is overdue already (once per due date).",
    payload: z.strictObject({
      planId: z.uuid(),
      machineId: z.uuid(),
      assetNumber: z.string(),
      checkTypeId: z.uuid(),
      nextDueOn: day(),
      reminderDays: z.number().int().min(0),
      overdue: z.boolean(),
    }),
    live: { ...live, fields: ['planId', 'machineId', 'checkTypeId', 'nextDueOn', 'overdue'] },
  }),
] as const
