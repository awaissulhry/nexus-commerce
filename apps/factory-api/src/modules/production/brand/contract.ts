import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { BRAND_HEALTHS, HEALTH_NOTE_MAX, HEALTH_REASON_CODES } from '@nexus/factory-domain/production-brand/health'
import { WAITING_ON } from '@nexus/factory-domain/production-brand/waiting'

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
