import { z } from 'zod'
import { defineEvent } from '../events/define'
import { DECISIONS, MAX_DECIDED_LINES } from './decisions'

/**
 * The planning module's events (plan A1 §3.4, §3.5; PLN-062; design 02 "What to buy & make", Live). apps/factory-api's
 * modules/planning emits them in the command that makes the change; the office screens that may see the site's plan
 * (planning.view) refresh the run strip, the tiles and the grid. Ids, counts and states only: no quantity, no money.
 *
 *   planning.run_finished            a run of a site is DONE (the older one is SUPERSEDED)
 *   planning.run_failed              a run could not be finished (the previous plan stays)
 *   planning.requirements_decided    lines of the latest plan were set aside, opened again, or ordered
 */
const live = { permission: 'planning.view', fields: ['runId', 'siteId'] } as const

export const events = [
  defineEvent({
    type: 'planning.run_finished',
    context: 'planning',
    description: "A planning run of a site finished: what the site's open orders need, netted against usable stock and open purchase orders.",
    payload: z.strictObject({
      runId: z.uuid(),
      siteId: z.uuid(),
      trigger: z.enum(['MANUAL', 'ORDER', 'SCHEDULED']),
      orderLines: z.number().int().min(0),
      requirements: z.number().int().min(0),
      short: z.number().int().min(0),
      warnings: z.number().int().min(0),
      supersededRunId: z.uuid().nullable(),
    }),
    live,
  }),
  defineEvent({
    type: 'planning.run_failed',
    context: 'planning',
    description: 'A planning run of a site could not be finished; the previous plan stays.',
    payload: z.strictObject({ runId: z.uuid(), siteId: z.uuid() }),
    live,
  }),
  defineEvent({
    type: 'planning.requirements_decided',
    context: 'planning',
    description: 'Lines of the latest plan were set aside, opened again, or ordered with a purchase order line.',
    payload: z.strictObject({
      runId: z.uuid(),
      siteId: z.uuid(),
      decision: z.enum(DECISIONS),
      requirementIds: z.array(z.uuid()).min(1).max(MAX_DECIDED_LINES),
    }),
    live: { ...live, fields: ['runId', 'siteId', 'decision'] },
  }),
] as const
