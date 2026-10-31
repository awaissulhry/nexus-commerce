import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { WORK_ORDER_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'
import { HOLD_LIMITS, HOLD_QUARANTINE, HOLD_SOURCE_TYPES, HOLD_STATUSES, HOLD_SUBJECT_TYPES, RELEASE_CHECKS } from '@nexus/factory-domain/quality/holds/rules'

/**
 * Quality holds (B-W2a-26; QHS-074, MES-008; design quality.holds SCR-078: qh-metrics, qh-grid, the Hold record,
 * qh-place, qh-release; production.workorders wo-hold). Office routes; every write takes an Idempotency-Key and (a change
 * or a release) the version read. Refusals in words: `body/<field>` (400), `release/<CHECK>` (409). No worker's name.
 */

const kind = z.enum(HOLD_SUBJECT_TYPES)
const status = z.enum(HOLD_STATUSES)
const quarantine = z.enum(HOLD_QUARANTINE)
const woStatus = z.enum(WORK_ORDER_STATUSES)
const flag = z.enum(['true', 'false']).optional()
const by = output({ kind: z.enum(['USER', 'WORKER', 'SYSTEM']), userId: id().nullable() })

export const holdView = output({
  id: id(),
  companyId: id(),
  siteId: id(),
  /** B-W2a-67: the site in words. */
  site: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  status,
  subjectType: kind,
  /** The held records: id, label (code, number, serial; null when not visible), state. */
  subjects: z.array(output({ id: id(), label: z.string().nullable(), state: z.string().nullable() })),
  subjectWords: z.string(),
  /** What they amount to ("412.0000 FT2", "30 garments"). */
  quantity: z.string().nullable(),
  blocks: z.string(),
  reasonCode: z.string(),
  reason: z.string(),
  reasonNote: z.string().nullable(),
  sourceType: z.string().nullable(),
  sourceId: id().nullable(),
  placedAt: instant(),
  placedBy: by,
  ownerId: id().nullable(),
  /** B-W2a-67: the owner, an office user by name (the Holds list's Owner column). */
  owner: output({ id: id(), name: z.string() }).nullable(),
  expectedReleaseOn: z.string().nullable(),
  overdue: z.boolean(),
  ageDays: z.number().int(),
  quarantine,
  quarantineLocation: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  quarantineMovedAt: instant().nullable(),
  ncrId: id().nullable(),
  releasedAt: instant().nullable(),
  releasedBy: output({ kind: z.enum(['USER', 'WORKER']), userId: id().nullable() }).nullable(),
  releaseNote: z.string().nullable(),
  closedAt: instant().nullable(),
  closedById: id().nullable(),
  closeNote: z.string().nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})

const check = output({ key: z.enum(RELEASE_CHECKS), ok: z.boolean(), words: z.string() })
const workOrderMove = output({ id: id(), number: z.string() })

export const listContract = defineContract({
  querystring: input({
    status: z.enum([...HOLD_STATUSES, 'ALL']).optional(),
    subjectType: kind.optional(),
    subjectId: id().optional(),
    siteId: id().optional(),
    ownerId: z.string().max(40).optional(),
    overdue: flag,
    system: flag,
    quarantine: quarantine.optional(),
  }),
  response: { 200: output({ holds: z.array(holdView), truncated: z.boolean() }) },
})

export const countsContract = defineContract({
  querystring: input({ siteId: id().optional() }),
  response: { 200: output({ counts: output({ open: z.number().int(), overdue: z.number().int(), system: z.number().int(), mine: z.number().int(), waitingQuarantine: z.number().int() }) }) },
})

/** B-W2a-67: who may own a hold of the site (the owner picker of the Holds screens). */
export const peopleContract = defineContract({
  querystring: input({ siteId: id() }),
  response: { 200: output({ people: z.array(output({ id: id(), name: z.string(), me: z.boolean() })) }) },
})

export const getContract = defineContract({
  params: input({ holdId: id() }),
  response: {
    200: output({
      hold: holdView,
      workOrders: z.array(output({ id: id(), number: z.string(), status: woStatus, heldFromStatus: woStatus.nullable(), holdReason: z.string().nullable(), heldByThis: z.boolean(), /** B-W2a-67: its batch (the evidence trail opens from it). */ batchNumber: z.string().nullable() })),
      /** What must be true to release it, for the caller (the GateExplainer; STATEMENT is signed in the release). */
      release: output({ checks: z.array(check), releasable: z.boolean(), mayRelease: z.boolean() }),
      canChange: z.boolean(),
    }),
  },
})

export const previewContract = defineContract({
  body: input({ subjectType: kind, subjectIds: z.array(id()).max(HOLD_LIMITS.subjects).optional(), codes: z.array(z.string().min(1).max(80)).max(HOLD_LIMITS.subjects).optional() }),
  response: {
    200: output({
      siteId: id().nullable(),
      subjects: z.array(output({ id: id().nullable(), code: z.string().nullable(), label: z.string().nullable(), state: z.string().nullable(), quantity: z.string().nullable(), problem: z.string().nullable() })),
      /** "Blocks issuing and cutting of 3 lots (412.0000 FT2)." */
      words: z.string().nullable(),
      quantity: z.string().nullable(),
      workOrders: z.array(output({ id: id(), number: z.string(), status: woStatus, move: z.enum(['HOLD', 'ALREADY', 'KEEP', 'REFUSED']) })),
      quarantinePlaces: z.array(output({ id: id(), code: z.string(), name: z.string() })),
    }),
  },
})

export const placeContract = defineContract({
  body: input({
    subjectType: kind,
    subjectIds: z.array(id()).min(1).max(HOLD_LIMITS.subjects),
    reasonCode: z.string().min(1).max(40),
    reasonNote: z.string().max(HOLD_LIMITS.reasonNote * 2).nullable().optional(),
    sourceType: z.enum(HOLD_SOURCE_TYPES).nullable().optional(),
    sourceId: id().nullable().optional(),
    ownerId: id().nullable().optional(),
    expectedReleaseOn: businessDate().nullable().optional(),
    /** Ask the floor to move the stock to quarantine (lots, hides only). */
    askQuarantine: z.boolean().optional(),
    quarantineLocationId: id().nullable().optional(),
    note: z.string().max(HOLD_LIMITS.note * 2).nullable().optional(),
  }),
  response: { 201: output({ hold: holdView, workOrdersHeld: z.array(workOrderMove.extend({ from: woStatus })) }) },
})

export const editContract = defineContract({
  params: input({ holdId: id() }),
  body: input({
    version: z.number().int().min(1),
    ownerId: id().nullable().optional(),
    expectedReleaseOn: businessDate().nullable().optional(),
    note: z.string().max(HOLD_LIMITS.note * 2).nullable().optional(),
    reasonNote: z.string().max(HOLD_LIMITS.reasonNote * 2).nullable().optional(),
  }),
  response: { 200: output({ hold: holdView }) },
})

export const releaseContract = defineContract({
  params: input({ holdId: id() }),
  body: input({
    version: z.number().int().min(1),
    note: z.string().max(HOLD_LIMITS.note * 2).nullable().optional(),
    /** "I made none of these garments" where the floor records name stations only. */
    notMakerStatement: z.boolean().optional(),
  }),
  response: { 200: output({ hold: holdView, workOrdersLifted: z.array(workOrderMove.extend({ to: woStatus })), checks: z.array(check) }) },
})
