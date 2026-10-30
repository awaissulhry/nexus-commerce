import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * Security & health's events (plan A1 §3.4; B-W2a-36):
 *
 *   security.drill_recorded        a person recorded a restore drill (its result, the day it was done): the page's
 *                                  status line and All settings › Needs attention read it again
 *   security.two_factor_changed    a role's two-factor rule changed (asked or no longer asked): the Security page and the
 *                                  role's record read it again; its holders are asked at their next sign-in
 *
 * Ids, days and states only: never a checksum, a name or a note.
 */
export const events = [
  defineEvent({
    type: 'security.drill_recorded',
    context: 'ops',
    description: 'A restore drill was recorded: a backup restored somewhere other than production and its key records compared.',
    payload: z.strictObject({
      drillId: z.uuid(),
      result: z.enum(['PASSED', 'FAILED']),
      drilledOn: z.iso.date(),
    }),
    live: { permission: 'security.view', fields: ['result'] },
  }),
  defineEvent({
    type: 'security.two_factor_changed',
    context: 'ops',
    description: "A role's two-factor rule changed: its holders are asked for two-factor from their next sign-in, or no longer.",
    payload: z.strictObject({
      roleId: z.uuid(),
      requireMfa: z.boolean(),
    }),
    live: { permission: 'roles.view', fields: ['requireMfa'] },
  }),
] as const
