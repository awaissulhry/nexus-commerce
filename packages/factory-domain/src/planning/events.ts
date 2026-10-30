import { z } from 'zod'
import { defineEvent } from '../events/define'
import { DECISIONS, MAX_DECIDED_LINES } from './decisions'
import { ITEM_PLANNING_METHODS } from './settings/items'
import { LANE_KINDS } from './capacity/load'

/**
 * The planning module's events (plan A1 §3.4, §3.5; PLN-062; design 02 "What to buy & make", Live). apps/factory-api's
 * modules/planning emits them in the command that makes the change; the office screens that may see the site's plan
 * (planning.view) refresh the run strip, the tiles and the grid. Ids, counts and states only: no quantity, no money.
 *
 *   planning.run_finished            a run of a site is DONE (the older one is SUPERSEDED)
 *   planning.run_failed              a run could not be finished (the previous plan stays)
 *   planning.requirements_decided    lines of the latest plan were set aside, opened again, or ordered
 *
 * B-W2a-16 (planning settings and capacity; design planning.settings "settings.changed → Changed by … · Reload",
 * planning.capacity): the screens that show the site's settings, item parameters, lanes and capacity read again.
 *   planning.settings_changed        a site's horizon, buckets, default efficiency or nightly run time changed
 *   planning.item_parameters_changed how a site plans an item (and colour) was set, changed or removed
 *   planning.capacity_changed        the planned efficiency, people (a line) or units (a work centre) of a lane changed
 */
const live = { permission: 'planning.view', fields: ['runId', 'siteId'] } as const
const SETTINGS_FIELDS = ['horizonWeeks', 'dayBucketWeeks', 'weekBucketWeeks', 'defaultEfficiencyPct', 'scheduledRunTime'] as const

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
  // ---- B-W2a-16: planning settings and capacity -------------------------------------------------------------------
  defineEvent({
    type: 'planning.settings_changed',
    context: 'planning',
    description: "A site's planning settings changed: how far the plan looks ahead, its buckets, the default efficiency or the nightly run's time.",
    payload: z.strictObject({
      siteId: z.uuid(),
      /** The site had no settings before (the defaults applied). */
      created: z.boolean(),
      /** The fields that differ from before (the defaults, when created). */
      changed: z.array(z.enum(SETTINGS_FIELDS)).max(SETTINGS_FIELDS.length),
    }),
    live: { permission: 'planning.view', fields: ['siteId'] },
  }),
  defineEvent({
    type: 'planning.item_parameters_changed',
    context: 'planning',
    description: 'How a site plans an item (and colour) was set, changed or removed: its method, lead times, safety stock, reorder rule, order sizes or source.',
    payload: z.strictObject({
      itemPlanningId: z.uuid(),
      siteId: z.uuid(),
      itemId: z.uuid(),
      itemColourId: z.uuid().nullable(),
      /** The method after the change (before a removal). */
      method: z.enum(ITEM_PLANNING_METHODS),
      change: z.enum(['CREATED', 'EDITED', 'DELETED']),
    }),
    live: { permission: 'planning.view', fields: ['itemPlanningId', 'siteId', 'itemId', 'change'] },
  }),
  defineEvent({
    type: 'planning.capacity_changed',
    context: 'planning',
    description: 'The planned efficiency, the people (a line) or the units (a work centre) a lane is planned with changed: its available minutes may differ.',
    payload: z.strictObject({
      siteId: z.uuid(),
      laneKind: z.enum(LANE_KINDS),
      laneId: z.uuid(),
      change: z.enum(['CREATED', 'EDITED']),
      changed: z.array(z.enum(['plannedEfficiencyPct', 'people', 'note'])).min(1).max(3),
    }),
    live: { permission: 'planning.view', fields: ['siteId', 'laneKind', 'laneId', 'change'] },
  }),
] as const
