import { z } from 'zod'
import { defineEvent } from '../events/define'
import { TIMER_KEY } from './rules'

/**
 * The date timers' events (B-W2a-33; PLT-100). apps/factory-api platform/timers emits it in the command that turns a
 * timer FIRED (the scheduler's cron `timers.fire`, one replica per tick).
 *
 *   timer.fired   a timer's time came. A DATE rule's timer raised its alert in the same command (alert.raised); a
 *                 module's own timer (no rule) is handled by that module's worker handler, which reads the timer's
 *                 payload by its id. Ids and the key only: no record words, no money, no person. Never on a screen.
 */
export const events = [
  defineEvent({
    type: 'timer.fired',
    context: 'timers',
    description: "A date timer's time came (a DATE rule's alert was raised with it, or a module's handler takes it).",
    payload: z.strictObject({
      timerId: z.uuid(),
      timerKey: z.string().regex(TIMER_KEY),
      ruleId: z.uuid().nullable(),
      recordType: z.string(),
      recordId: z.uuid(),
    }),
  }),
] as const
