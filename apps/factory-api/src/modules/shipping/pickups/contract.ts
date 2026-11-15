import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { ISO_WEEKDAYS } from '@nexus/factory-domain/shipping/queue/cutoff'
import { PICKUP_LIMITS, PICKUP_MOVES, PICKUP_REFUSALS, PICKUP_STATUSES, PICKUP_VIAS } from '@nexus/factory-domain/shipping/pickups/rules'
import { shippingAddress } from '../settings/contract'

/**
 * Carrier pickups (B-W2b-395; LOG-048; design warehouse.shipments pop-up "Book a pickup", the cut-off strip's "pickup booked
 * 16:00"). A version is the PickupRequest's version as read (COL-078). No money, no person in a list (who booked it is in the
 * one request only).
 */

const allowance = output({ allowed: z.boolean(), refusal: output({ code: z.enum(PICKUP_REFUSALS), message: z.string() }).nullable() })

const pickupRow = output({
  id: id(),
  companyId: id(),
  siteId: id(),
  site: output({ code: z.string(), name: z.string() }),
  carrierCode: z.string(),
  carrierName: z.string(),
  /** When the goods are ready (the first time, for a recurring pickup). */
  readyAt: instant(),
  /** The ready time on the site's clock ("HH:MM"); on a day asked for (`day`), that day's. */
  readyTime: z.string(),
  parcels: z.number().int(),
  pallets: z.number().int(),
  /** Where the driver collects (as sent). */
  address: z.record(z.string(), z.unknown()),
  repeatWeekdays: z.array(z.enum(ISO_WEEKDAYS)),
  recurring: z.boolean(),
  status: z.enum(PICKUP_STATUSES),
  /** SENDCLOUD (or the TEST pickup of test mode: `test`), or PHONE (the note says with whom). */
  via: z.enum(PICKUP_VIAS),
  test: z.boolean(),
  providerReference: z.string().nullable(),
  /** Why it failed (FAILED only): a failure stays visible on the request. */
  errorWords: z.string().nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  /** What may move now (each refusal in words; the permission is the screen's to know). */
  may: output({ confirm: allowance, fail: allowance, cancel: allowance }),
})

const pickupDetail = output({ ...pickupRow.shape, createdById: id().nullable() })

export const listPickupsContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    status: z.enum(PICKUP_STATUSES).optional(),
    carrierCode: z.string().max(40).optional(),
    /** The pickups that come on that day (the site's zone): one-offs of that day, recurring ones on their weekdays. */
    day: businessDate().optional(),
    /** Ready from / to (days, the site's zone), newest first. Not with `day`. */
    from: businessDate().optional(),
    to: businessDate().optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: { 200: output({ pickups: z.array(pickupRow), nextCursor: z.string().nullable() }) },
})

export const pickupDraftContract = defineContract({
  querystring: input({
    siteId: id(),
    carrierCode: z.string().max(40).optional(),
    /** The selected shipments (comma-separated ids, at most 100): their parcels, pallets and weight. */
    shipmentIds: z.string().max(3800).optional(),
  }),
  response: {
    200: output({
      siteId: id(),
      companyId: id(),
      site: output({ code: z.string(), name: z.string(), timeZone: z.string() }),
      /** The site's sender address (null: no shipping settings). */
      address: z.record(z.string(), z.unknown()).nullable(),
      carrierCode: z.string().nullable(),
      carrierName: z.string().nullable(),
      parcels: z.number().int(),
      pallets: z.number().int(),
      /** Kilograms (3 places) of the selection's parcels; null when a parcel is not weighed. */
      weightKg: z.string().nullable(),
      /** A ready time to start from: the next half hour. */
      readyAt: instant(),
      shipments: z.array(output({ id: id(), number: z.string(), parcels: z.number().int(), pallets: z.number().int() })),
      /** Selected shipments left out, each with why. */
      skipped: z.array(output({ id: id(), number: z.string().nullable(), words: z.string() })),
      testMode: z.boolean(),
      vias: output({ SENDCLOUD: allowance.extend({ test: z.boolean(), recurring: z.boolean() }), PHONE: allowance.extend({ recurring: z.boolean() }) }),
      /** The pickups that already come that day for the carrier (a second one is rarely meant). */
      alreadyToday: z.array(pickupRow),
    }),
  },
})

export const getPickupContract = defineContract({ params: input({ pickupId: id() }), response: { 200: output({ pickup: pickupDetail }) } })

const text = (max: number) => z.string().max(max)

export const bookPickupContract = defineContract({
  body: input({
    siteId: id(),
    via: z.enum(PICKUP_VIAS),
    carrierCode: text(40),
    readyAt: instant(),
    parcels: z.number().int(),
    pallets: z.number().int(),
    /** Another address than the site's sender address. */
    address: shippingAddress.nullish(),
    /** PHONE only: the carrier's regular round. */
    repeatWeekdays: z.array(z.string().max(20)).max(7).optional(),
    /** PHONE: with whom it was booked (required). */
    note: text(PICKUP_LIMITS.note * 2).nullish(),
    /** PHONE: the carrier's reference, when it gave one. */
    providerReference: text(PICKUP_LIMITS.reference * 2).nullish(),
    /** SENDCLOUD: the total weight told to the carrier (kilograms). */
    weightKg: text(20).nullish(),
  }),
  response: { 201: output({ pickup: pickupDetail, replayed: z.boolean() }) },
})

export const movePickupContract = defineContract({
  params: input({ pickupId: id() }),
  body: input({
    version: z.number().int().min(1).optional(),
    status: z.enum(PICKUP_MOVES),
    providerReference: text(PICKUP_LIMITS.reference * 2).nullish(),
    words: text(PICKUP_LIMITS.words * 2).nullish(),
  }),
  response: {
    200: output({
      pickup: pickupDetail,
      /** A call-off of a pickup booked through Sendcloud: whether Sendcloud was told; else what to do, in words. Null otherwise. */
      carrier: output({ told: z.boolean(), words: z.string().nullable() }).nullable(),
    }),
  },
})
