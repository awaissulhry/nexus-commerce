import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { notMoney } from '@nexus/factory-domain/money/marked'
import { LATE_REASONS, LATE_STATES } from '@nexus/factory-domain/production/baskets/signals'

/**
 * The Baskets board, the leader's team home and From the floor (owb- order workflow, S5 fl4; `_owb-fl-common.md` § 3 "fl2 / fl4").
 * No money anywhere. The floor reads the customer's CODE only; the office reads its name, and only for a customer the reader
 * reaches (the brand wall: another customer's basket is not listed at all). A worker is named only where the site allows it
 * (the office: the people worker gate; the floor: the site's scanSubject). S2's order Production tab reads the board with
 * `salesOrderId`: keep this answer stable.
 */

export const departmentLook = output({
  id: id(),
  number: z.number().int(),
  name: z.string(),
  shortName: z.string(),
  tone: z.string(),
  icon: z.string(),
  nameI18n: z.record(z.string(), z.string()),
})

const teamLook = output({ id: id(), name: z.string(), pictureKind: z.string(), pictureIcon: z.string().nullable(), pictureColour: z.string().nullable() })

/** One basket as a row (the team home, the phone's lists). */
export const basketRow = output({
  bundleId: id(),
  code: z.string(),
  /** The order's picture as the reader may see it (the small preview); null: none. */
  picture: output({ fileId: id(), src: z.string().nullable() }).nullable(),
  customerCode: z.string().nullable(),
  step: output({ operationId: id().nullable(), department: departmentLook.nullable() }),
  state: z.enum(['WAITING', 'WORKING', 'PAUSED']),
  flags: output({
    first: z.boolean(),
    late: z.boolean(),
    problem: output({ callId: id(), typeCode: z.string(), minutes: z.number().int(), escalated: z.boolean() }).nullable(),
  }),
  salesOrderId: id().nullable(),
})

/** One basket as a board card: the row and its customer, team, worker, progress and late warning. */
export const basketCard = basketRow.extend({
  /** The customer: its code always; its name only in the office for a reader who reaches it. */
  customer: output({ code: z.string().nullable(), name: z.string().nullable() }),
  team: teamLook.nullable(),
  worker: output({ name: z.string() }).nullable(),
  /** "k of n": steps of its route done, of all. */
  progress: output({ done: z.number().int(), total: notMoney(z.number().int()) }),
  late: output({ days: z.number().int(), reason: z.enum(LATE_REASONS), state: z.enum(LATE_STATES) }).nullable(),
})

export const boardContract = defineContract({
  querystring: input({
    /** team: the reader's team (floor) or `teamId`; floor: every basket in reach. Default: floor (office), team (a leader's phone). */
    scope: z.enum(['team', 'floor']).optional(),
    teamId: id().optional(),
    departmentId: id().optional(),
    salesOrderId: id().optional(),
  }),
  response: {
    200: output({
      columns: z.array(output({ department: departmentLook, baskets: z.array(basketCard) })),
      readyToShip: z.array(basketCard),
      /** Baskets at a step of no department (an outside step): kept, never lost. */
      elsewhere: z.array(basketCard),
      /** The list was cut at its limit (oldest first). */
      more: z.boolean(),
      /** The office's "Give it to": the site's people by name, only where the worker gate lets names through; else null. */
      people: z.array(output({ workerId: id(), name: z.string() })).nullable(),
      asOf: instant(),
    }),
  },
})

const forYouItem = output({
  kind: z.enum(['CHANGED_DESIGN', 'ANSWER', 'SOLVED', 'HANDOVER', 'PROBLEM', 'ASK']),
  bundleId: id().nullable(),
  code: z.string().nullable(),
  words: z.string(),
  at: instant(),
})

export const teamContract = defineContract({
  response: {
    200: output({
      team: teamLook.extend({ lineId: id().nullable() }).nullable(),
      /** The sentence when there is nothing to show (no team led, or no order given to the team yet); null otherwise. */
      empty: z.string().nullable(),
      numbers: output({ working: z.number().int(), waiting: z.number().int(), late: z.number().int(), problem: z.number().int() }),
      forYou: z.array(forYouItem),
      orders: z.array(output({ salesOrderId: id().nullable(), customerCode: z.string().nullable(), picture: output({ fileId: id(), src: z.string().nullable() }).nullable(), baskets: z.array(basketRow) })),
      /** Who has what: the team's people and the basket they hold now (names only where the site names workers). */
      people: z.array(output({ key: z.string(), name: z.string().nullable(), holds: output({ bundleId: id(), code: z.string() }).nullable() })),
      /** Team members not signed in to any device now (a count, never who). */
      missing: z.number().int(),
      /** Baskets of the team reported at their last step today. */
      doneToday: z.number().int(),
      handover: output({ id: id(), shiftDate: z.string(), shiftLabel: z.string(), text: z.string().nullable(), writtenAt: instant() }).nullable(),
      more: z.boolean(),
    }),
  },
})

export const fromTheFloorContract = defineContract({
  querystring: input({ salesOrderId: id() }),
  response: {
    200: output({
      photos: z.array(output({ fileId: id(), src: z.string().nullable(), at: instant(), basketCode: z.string().nullable(), workOrderId: id(), shared: z.boolean() })),
      changes: z.array(output({ at: instant(), kind: z.enum(['BACK', 'ROUTE']), basketCodes: z.array(z.string()), words: z.string(), reason: z.string().nullable(), who: z.string() })),
      late: z.array(output({ id: id(), days: z.number().int(), reason: z.enum(LATE_REASONS), state: z.enum(LATE_STATES), at: instant(), basketCodes: z.array(z.string()), version: z.number().int() })),
    }),
  },
})

export const lateAnswerContract = defineContract({
  params: input({ id: id() }),
  body: input({ state: z.enum(['KEPT', 'CHANGED']), version: z.number().int().min(1).optional() }),
  response: { 200: output({ late: output({ id: id(), state: z.enum(LATE_STATES), answeredAt: instant() }), replayed: z.boolean() }) },
})
