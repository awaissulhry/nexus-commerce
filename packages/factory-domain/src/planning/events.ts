import { z } from 'zod'
import { defineEvent } from '../events/define'
import { DECISIONS, MAX_DECIDED_LINES } from './decisions'
import { ITEM_PLANNING_METHODS } from './settings/items'
import { LANE_KINDS } from './capacity/load'
// B-W2a-22: MRP every day (firm planned orders, the exception list).
import { MAX_EXCEPTIONS_PER_ACTION } from './exceptions/lifecycle'
// B-W2a-34: the planning board (the working plan's changes, a published version).
import { SCHEDULE_CHANGES } from './schedule/changes'
import { SLOT_LIMITS } from './schedule/slots'

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
 *
 * B-W2a-22 (MRP every day; PLN-075, PLN-193; design planning.mrp, planning.exceptions):
 *   planning.requirement_firmed      a line of the latest plan was made firm (or changed), or planned again
 *   planning.exceptions_found        a run refreshed the site's exception list: raised, still open, cleared
 *   planning.exceptions_changed      exceptions were acknowledged, snoozed or resolved by a person
 *
 * B-W2a-34 (the planning board; PLN-131, PLN-147, PLN-160; design planning.board "planning.board.moved (another planner)
 * → the bar moves", floor.mywork "Dispatch published from the planning board → List changed · Show"):
 *   planning.schedule_changed        the site's shared working plan changed: slots placed, moved or removed, work orders
 *                                    allocated, or placed by their due dates (the board and the allocation board read
 *                                    again; never the bar being dragged)
 *   planning.schedule_published      a numbered version of the working plan was published to the floor: the floor
 *                                    devices of the site get it too (their dispatch lists say "List changed")
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
  // ---- B-W2a-22: MRP every day ---------------------------------------------------------------------------------------
  defineEvent({
    type: 'planning.requirement_firmed',
    context: 'planning',
    description: 'A line of the latest plan was made a firm planned order (or its firm quantity, date or supplier changed), or made planned again.',
    payload: z.strictObject({ runId: z.uuid(), siteId: z.uuid(), requirementId: z.uuid(), firm: z.boolean() }),
    live: { permission: 'planning.view', fields: ['runId', 'siteId', 'requirementId', 'firm'] },
  }),
  defineEvent({
    type: 'planning.exceptions_found',
    context: 'planning',
    description: "A planning run refreshed the site's exception list: the conditions it raised, those still open, and those it no longer found.",
    payload: z.strictObject({ runId: z.uuid(), siteId: z.uuid(), raised: z.number().int().min(0), stillOpen: z.number().int().min(0), cleared: z.number().int().min(0) }),
    live,
  }),
  defineEvent({
    type: 'planning.exceptions_changed',
    context: 'planning',
    description: "Exceptions of a site's planning runs were acknowledged, snoozed or resolved.",
    payload: z.strictObject({
      siteId: z.uuid(),
      change: z.enum(['ACKNOWLEDGED', 'SNOOZED', 'RESOLVED']),
      exceptionIds: z.array(z.uuid()).min(1).max(MAX_EXCEPTIONS_PER_ACTION),
    }),
    live: { permission: 'planning.view', fields: ['siteId', 'change'] },
  }),
  // ---- B-W2a-34: the planning board -------------------------------------------------------------------------------
  defineEvent({
    type: 'planning.schedule_changed',
    context: 'planning',
    description: "The site's shared working plan changed: slots were placed, moved or removed, work orders allocated to lines or workshops, or placed by their due dates. The floor sees none of it until a publish.",
    payload: z.strictObject({
      siteId: z.uuid(),
      planVersionId: z.uuid(),
      /** The working plan's version after the change (a board that read an older one reads again). */
      planVersion: z.number().int().min(1),
      change: z.enum(SCHEDULE_CHANGES),
      /** How many slots changed; `slotIds` and `workOrderIds` name the first 200. */
      slots: z.number().int().min(0),
      slotIds: z.array(z.uuid()).max(SLOT_LIMITS.perBatch),
      workOrderIds: z.array(z.uuid()).min(1).max(SLOT_LIMITS.perBatch),
    }),
    live: { permission: 'planning.view', fields: ['siteId', 'planVersionId', 'planVersion', 'change'] },
  }),
  defineEvent({
    type: 'planning.schedule_published',
    context: 'planning',
    description: "A numbered version of the site's working plan was published to the floor for the days it covers: the lines' and stations' dispatch lists change to it from its start.",
    payload: z.strictObject({
      siteId: z.uuid(),
      planVersionId: z.uuid(),
      number: z.number().int().min(1),
      previousId: z.uuid().nullable(),
      coversFrom: z.iso.date(),
      coversTo: z.iso.date(),
      effectiveFrom: z.iso.datetime(),
      slots: z.number().int().min(0),
      moved: z.number().int().min(0),
      added: z.number().int().min(0),
      removed: z.number().int().min(0),
    }),
    live: { permission: 'planning.view', floor: true, fields: ['siteId', 'planVersionId', 'number', 'effectiveFrom'] },
  }),
] as const
