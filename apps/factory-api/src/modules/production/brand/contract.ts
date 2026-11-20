import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { BRAND_HEALTHS, HEALTH_NOTE_MAX, HEALTH_REASON_CODES } from '@nexus/factory-domain/production-brand/health'
import { WAITING_ON } from '@nexus/factory-domain/production-brand/waiting'
// B-PR-22b: the customer's urgency as the office steers it.
import { BRAND_URGENCIES, URGENCY_ACTORS, URGENCY_LOCK_REASON_MAX, URGENCY_OFFICE_BATCH_MAX, URGENCY_OUTCOMES } from '@nexus/factory-domain/production-brand/urgency'
// B-MS-005: the stage set by hand.
import { HAND_STAGES, STAGE_SET_REASON_CODES } from '@nexus/factory-domain/production-brand/stage-set'
import { BRAND_STAGES } from '@nexus/factory-domain/production-brand/stages'

/**
 * The customer's production state of one sales order, as the OFFICE reads and steers it (production plan §4 "Health"; review fix
 * R-10, decision D3). B-PR-35: the factory raises an order's health to At risk with a curated reason code and an office-only note,
 * reads it, and clears it. Every write takes an Idempotency-Key and, optionally, the version of the production state read.
 * Refusals in words: `body/<field>` (400), a state that takes no raise (409), a stale version (409). The customer reads the chip
 * and the reason code through its own portal reads (B-PR-18), never the note: no route here is a portal route.
 */

const orderParams = input({ orderId: id() })
const person = output({ id: id(), name: z.string() })

/** One order's production health as the office reads it. */
export const brandHealthView = output({
  orderId: id(),
  /** The order's number (the office's). */
  number: z.string(),
  partyId: id(),
  /** The keeper made the order's production state (B-PR-17: at CONFIRMED); false: nothing below is known yet. */
  kept: z.boolean(),
  /** The computed health (the keeper's; null: nothing left to make, or not kept yet). */
  computed: z.enum(BRAND_HEALTHS).nullable(),
  /** The health the customer reads: the computed one, raised to AT_RISK while a raise stands (never lowered). */
  health: z.enum(BRAND_HEALTHS).nullable(),
  /** The reason the customer reads beside the chip (only while a raise counts). */
  reasonCode: z.enum(HEALTH_REASON_CODES).nullable(),
  /** The factory's raise: its reason, the office's own note (never the customer's to read), when, by whom, its last day. */
  raise: output({
    reasonCode: z.enum(HEALTH_REASON_CODES),
    note: z.string().nullable(),
    setAt: instant(),
    /** An office person (null: no longer a user of the tenant). */
    setBy: person.nullable(),
    /** The first day it no longer stands (set day + 7); it also drops as soon as the computed health changes. */
    until: businessDate(),
    /** It still counts today (false: past its days, the keeper drops it on its next pass). */
    stands: z.boolean(),
  }).nullable(),
  /** Who the order waits on (the office reads the four) and since when. */
  waitingOn: z.enum(WAITING_ON).nullable(),
  waitingSince: instant().nullable(),
  /** The production state's version (send it back with a raise or a clear); null: not kept yet. */
  version: z.number().int().nullable(),
})

const oneHealth = output({ health: brandHealthView })

export const getHealthContract = defineContract({ params: orderParams, response: { 200: oneHealth } })

export const raiseHealthContract = defineContract({
  params: orderParams,
  body: input({
    /** One of the curated reasons (the customer reads it in the promise's own words). */
    reasonCode: z.enum(HEALTH_REASON_CODES),
    /** The office's own words beside it: one line of at most 200 characters; never the customer's to read. */
    note: z.string().trim().max(HEALTH_NOTE_MAX).nullish(),
    /** The production state's version as read (optional). */
    version: z.number().int().min(1).optional(),
  }),
  response: { 200: oneHealth },
})

export const clearHealthContract = defineContract({
  params: orderParams,
  querystring: input({ version: z.coerce.number().int().min(1).optional() }),
  response: { 200: oneHealth },
})

// ── B-PR-22b ──
/**
 * B-PR-22b: the customer's urgency as the office steers it (./urgency.ts). The factory sets orders back to Regular and locks them
 * with a reason the customer reads, or unlocks them (production.brand.override, step-up, no second person); per row a result —
 * done, or why not in words (NOT_OPEN, NOT_KEPT, UNCHANGED, NO_RIGHT: seen but not ours to change); an order of a customer the
 * caller does not reach is only counted (`notFound`), never named. Refusals that change nothing: 409 with each row's words at
 * `body/orderIds/<index>/<outcome>`. Every write takes an Idempotency-Key.
 */
const urgencyWords = output({ it: z.string(), en: z.string() })

const officeUrgencyResult = output({
  orderId: id(),
  number: z.string(),
  customerRef: z.string().nullable(),
  outcome: z.enum(URGENCY_OUTCOMES),
  done: z.boolean(),
  words: urgencyWords.nullable(),
  ask: urgencyWords.nullable(),
  urgency: z.enum(BRAND_URGENCIES).nullable(),
  urgentRank: z.number().int().nullable(),
})

const officeUrgencyAnswer = output({
  results: z.array(officeUrgencyResult),
  /** One batch per customer that changed (a batch never spans two customers). */
  batches: z.array(output({ partyId: id(), batchId: id() })),
  notFound: z.number().int(),
  replayed: z.boolean(),
})

const officeOrderIds = z.array(id()).min(1).max(URGENCY_OFFICE_BATCH_MAX)

export const setBackUrgencyContract = defineContract({
  body: input({
    orderIds: officeOrderIds,
    /** One line (≤ 500): the customer reads it beside "Set to Regular by us" while the order is locked; always in the audit. */
    reason: z.string().max(URGENCY_LOCK_REASON_MAX + 20),
    /** Lock it at Regular too (the customer can no longer mark it Urgent until we unlock it). */
    lock: z.boolean().default(false),
  }),
  response: { 200: officeUrgencyAnswer },
})

export const unlockUrgencyContract = defineContract({
  body: input({ orderIds: officeOrderIds }),
  response: { 200: officeUrgencyAnswer },
})

const urgentUse = output({ used: z.number().int(), max: z.number().int(), agreed: z.number().int(), left: z.number().int(), over: z.boolean(), words: urgencyWords })

export const customerUrgencyContract = defineContract({
  params: input({ partyId: id() }),
  response: {
    200: output({
      asOf: instant(),
      customer: output({ id: id(), code: z.string(), name: z.string() }),
      /** The customer's switch and quota; while off, the marks are kept but count for nothing (`dormant` says so). */
      urgency: output({ on: z.boolean(), max: z.number().int(), dormant: urgencyWords.nullable() }),
      /** Per company the caller reaches: its open orders in the customer's own list's order. */
      companies: z.array(
        output({
          company: output({ id: id(), code: z.string(), name: z.string() }),
          use: urgentUse,
          /** The caller may set back, lock or unlock here (production.brand.override). */
          mayOverride: z.boolean(),
          orders: z.array(
            output({
              id: id(),
              number: z.string(),
              customerRef: z.string().nullable(),
              status: z.string(),
              orderDate: businessDate(),
              urgency: z.enum(BRAND_URGENCIES),
              /** It counts in our plan now (Urgent while the switch is on). */
              counted: z.boolean(),
              urgentRank: z.number().int().nullable(),
              setBy: z.enum(URGENCY_ACTORS).nullable(),
              setAt: instant().nullable(),
              /** Who set it last (the office's card only; the customer reads "Changed by us", never a name). */
              setByPerson: person.nullable(),
              locked: z.boolean(),
              lockReason: z.string().nullable(),
              lockedAt: instant().nullable(),
              lockedBy: person.nullable(),
              words: urgencyWords,
            }),
          ),
        }),
      ),
    }),
  },
})
// ── end B-PR-22b ──

// ── B-MS-005 ──
/**
 * B-MS-005 (set the stage by hand, plan.md D1–D9; review fixes R1, R4, R9, R11, R12, R19): the office sets an order's stage by hand
 * while the floor cannot record the work — Cutting, Sewing or Quality check, only ahead of the live floor, with a reason and an
 * office-only note — changes it (the same PUT while one stands; it may go lower while it stays above the floor), or clears it.
 * production.brand.manage over the order's company and customer. Every write takes an Idempotency-Key and the production state's
 * version as read: a required key, null only while the order has no production state yet (R1: the set makes it). Refusals in words:
 * `body/<field>` (400: Preparing or Ready asked, a reason not in the list, Something else without a note, a note of two lines or
 * too long), the order's state (409: not In production or Partly shipped, nothing left to make, the customer's own pause, the floor
 * already there; a Clear with none standing), a stale version (409, path `version`). The customer never reads any of it: its portal
 * reads the plain stage only (no route here is a portal route).
 */
export const stageByHandView = output({
  orderId: id(),
  /** The floor's own stage as read under the keeper's lock (null: no goods line is open). */
  floor: z.enum(BRAND_STAGES).nullable(),
  /** The stage the customer reads (the keeper's shown stage: the floor's, or the one set by hand while it leads). */
  stage: z.enum(BRAND_STAGES),
  /** The stage set by hand while it stands: why, the office's own note, when and by whom (null: no longer a user of the tenant). */
  byHand: output({ stage: z.enum(HAND_STAGES), reasonCode: z.enum(STAGE_SET_REASON_CODES), note: z.string().nullable(), setAt: instant(), setBy: person.nullable() }).nullable(),
  /** The production state's version (send it back with the next change or clear). */
  version: z.number().int(),
})

export const setStageContract = defineContract({
  params: orderParams,
  body: input({
    /** Any stage: only Cutting, Sewing and Quality check are taken (Preparing and Ready are refused in words). */
    stage: z.enum(BRAND_STAGES),
    /** Why the floor could not record it (office only). */
    reasonCode: z.enum(STAGE_SET_REASON_CODES),
    /** The office's own words: one line of at most 200 characters, required for OTHER (judged in words); never the customer's. */
    note: z.string().max(1000).nullish(),
    /** The production state's version as read; null only while the order has none yet. */
    version: z.number().int().min(1).nullable(),
  }),
  response: { 200: stageByHandView },
})

export const clearStageContract = defineContract({
  params: orderParams,
  querystring: input({ version: z.coerce.number().int().min(1) }),
  response: { 200: stageByHandView },
})
// ── end B-MS-005 ──
