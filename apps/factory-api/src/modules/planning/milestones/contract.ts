import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { GATE_KINDS, GATE_LIMITS, GATE_REFUSALS, GATE_STATES, LEATHER_STATES, MILESTONE_KINDS, MILESTONE_STATES, PASS_VIAS, WAITING_TILES } from '@nexus/factory-domain/planning/milestones/rules'

/**
 * Time & action (B-W2b-263; PLN-186; design planning.milestones, SCR-253). Dates are the site's business days (YYYY-MM-DD,
 * Europe/Rome), times UTC. One read gives the page everything: the tiles of "Waiting on a gate", every open order the caller
 * plans for with its gates and its milestones (gates, production start, ship). Each gate carries what may happen now, each
 * action allowed or refused in words with a stable code and the permission it needs. No money; a gate's planner is named
 * inside the gate only (never a filter, a group or a total).
 */

const person = output({ id: id(), name: z.string() })
const refusal = output({ code: z.enum(GATE_REFUSALS), message: z.string() })
const action = output({ allowed: z.boolean(), refusal: refusal.nullable(), needs: z.string().nullable() })

export const gateView = output({
  id: id(),
  salesOrderId: id(),
  kind: z.enum(GATE_KINDS),
  label: z.string().nullable(),
  targetDate: businessDate().nullable(),
  /** The round a sample gate waits for (its decision: null = not decided yet). */
  sampleRound: output({ id: id(), number: z.string(), kind: z.string(), decision: z.string().nullable() }).nullable(),
  /** The gate's planner (null: its maker); `ownerId` and `makerId` say who may not start before it. */
  owner: person.nullable(),
  ownerId: id().nullable(),
  makerId: id().nullable(),
  state: z.enum(GATE_STATES),
  passedOn: businessDate().nullable(),
  passedAt: instant().nullable(),
  /** The person who marked it done (null when its event passed it: `via` says which). */
  passedBy: person.nullable(),
  via: z.enum(PASS_VIAS).nullable(),
  startedBefore: output({ at: instant(), by: person.nullable(), reason: z.string() }).nullable(),
  /** LEATHER_APPROVED: the order's reserved leather (none, not all released, all released); null for the other kinds. */
  leather: z.enum(LEATHER_STATES).nullable(),
  /** The order's production work orders that have not started (never a sample or a repair, B-W2b-F22): the planning board holds a drop of them while the gate waits. */
  holds: z.number().int().min(0),
  version: z.number().int(),
  actions: output({ pass: action, startBefore: action, edit: action, remove: action }),
})
export type GateView = z.infer<typeof gateView>

export const milestoneView = output({
  /** `gate:<gate id>`, `start:<order id>`, `ship:<order id>`. */
  id: z.string(),
  kind: z.enum(MILESTONE_KINDS),
  gateId: id().nullable(),
  gateKind: z.enum(GATE_KINDS).nullable(),
  label: z.string().nullable(),
  salesOrderId: id(),
  target: businessDate().nullable(),
  actual: businessDate().nullable(),
  state: z.enum(MILESTONE_STATES),
  /** Days late (done after the target, or not done and the target passed); null: on time or no target. */
  late: z.number().int().nullable(),
  owner: person.nullable(),
})
export type MilestoneView = z.infer<typeof milestoneView>

export const orderView = output({
  id: id(),
  number: z.string(),
  companyId: id(),
  customer: output({ id: id(), code: z.string(), name: z.string() }),
  status: z.string(),
  promiseDate: businessDate().nullable(),
  customerRef: z.string().nullable(),
  workOrders: output({ count: z.number().int(), notStarted: z.number().int() }),
  gates: z.array(gateView),
  milestones: z.array(milestoneView),
  /** The kinds of the gates that wait (the order cannot be put on the planning board while one does). */
  waiting: z.array(z.enum(GATE_KINDS)),
  /** Milestones late. */
  late: z.number().int(),
  /** The next milestone not done (by target date). */
  next: z.string().nullable(),
  /** The caller may add gates to this order. */
  mayAddGate: output({ allowed: z.boolean(), needs: z.string().nullable(), refusal: refusal.nullable() }),
})
export type OrderView = z.infer<typeof orderView>

export const milestonesContract = defineContract({
  querystring: input({ companyId: id().optional(), orderId: id().optional(), q: z.string().max(100).optional() }),
  response: {
    200: output({
      today: businessDate(),
      timeZone: z.string(),
      /** Orders waiting on a gate, per tile (distinct orders). */
      tiles: z.record(z.enum(WAITING_TILES), z.number().int()),
      orders: z.array(orderView),
      /** More open orders than one read covers: the oldest promise dates first. */
      truncated: z.boolean(),
    }),
  },
})

const orderParams = input({ salesOrderId: id() })
const gateParams = input({ gateId: id() })

export const choicesContract = defineContract({
  params: orderParams,
  response: {
    200: output({
      order: output({ id: id(), number: z.string(), kinds: z.array(z.enum(GATE_KINDS)) }),
      /** Sample rounds of the order's styles for its customer (or internal), not cancelled, newest first. */
      rounds: z.array(output({ id: id(), number: z.string(), kind: z.string(), roundNo: z.number().int(), decision: z.string().nullable(), stage: z.string(), style: output({ id: id(), code: z.string() }) })),
      /** Active people who may keep this order's gates (by name; the caller marked). */
      owners: z.array(output({ id: id(), name: z.string(), me: z.boolean() })),
    }),
  },
})

const label = () => z.string().max(GATE_LIMITS.label)

export const addGateContract = defineContract({
  body: input({
    salesOrderId: id(),
    kind: z.enum(GATE_KINDS),
    label: label().nullable().optional(),
    targetDate: businessDate().nullable().optional(),
    sampleRoundId: id().nullable().optional(),
    /** The planner who owns it (default: the person adding it). */
    ownerId: id().nullable().optional(),
  }),
  response: { 201: output({ gate: gateView }) },
})

export const editGateContract = defineContract({
  params: gateParams,
  body: input({
    version: z.number().int().min(1),
    label: label().nullable().optional(),
    targetDate: businessDate().nullable().optional(),
    sampleRoundId: id().nullable().optional(),
    ownerId: id().nullable().optional(),
  }),
  response: { 200: output({ gate: gateView }) },
})

export const removeGateContract = defineContract({
  params: gateParams,
  body: input({ version: z.number().int().min(1) }),
  response: { 200: output({ removed: id() }) },
})

export const passGatesContract = defineContract({
  body: input({
    gates: z.array(input({ id: id(), version: z.number().int().min(1) })).min(1).max(GATE_LIMITS.perBatch),
    /** The day it was passed (default today; never a day to come). */
    on: businessDate().optional(),
  }),
  response: { 200: output({ passed: z.array(output({ id: id(), version: z.number().int() })) }) },
})

export const startBeforeContract = defineContract({
  params: gateParams,
  body: input({ version: z.number().int().min(1), reason: z.string().max(GATE_LIMITS.reason) }),
  response: { 200: output({ gate: gateView }) },
})
