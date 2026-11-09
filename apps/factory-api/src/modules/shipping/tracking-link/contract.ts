import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { TRACKING_STATUSES } from '@nexus/factory-domain/shipping/labels/tracking'
import { SHIPMENT_STATUSES } from '@nexus/factory-domain/shipping/shipments'
import { CLAIM_HELD, MAKE_HELD, PAPER_KINDS, SEARCH_LIMITS, STEP_STATES, TRACKING_PILLS, TRACKING_PROBLEMS, TRACKING_STEPS, TRACKING_VIAS } from '@nexus/factory-domain/shipping/tracking-link/rules'
import { proofBody } from '../../../platform/abuse/contract'
import { presignedView } from '../../../platform/files/contract'

/**
 * Track an order (B-W2b-170; LOG-062; design links.tracking, SCR-194). Codes and numbers only: the pages say every word in
 * the reader's language. No money anywhere, no street, no name; a link's token only in the answer that made it, once.
 */

const shipmentParams = input({ shipmentId: id() })
const linkState = z.enum(['LIVE', 'REVOKED', 'USED_UP', 'EXPIRED', 'ENDED'])

// ---- the office (warehouse › shipment › Tracking & delivery) -----------------------------------------------------------

const officeLink = output({
  id: id(),
  /** The address it was mailed to; null: a link to pass on (copied by the office or in the portal). */
  email: z.string().nullable(),
  via: z.enum(TRACKING_VIAS).nullable(),
  state: linkState,
  createdAt: instant(),
  /** When the page stops answering (the link's expiry, or 60 days after delivery). */
  endsAt: instant(),
  lastOpenedAt: instant().nullable(),
  revokedAt: instant().nullable(),
  /** Made by the system (when the goods left, asked again, the search). */
  automatic: z.boolean(),
})

export const trackingLinksView = output({
  shipment: output({ id: id(), number: z.string(), status: z.enum(SHIPMENT_STATUSES), partyId: id() }),
  /** The customer's ORDERS contacts with an address: who the link goes to by default. */
  recipients: z.array(output({ contactId: id(), name: z.string(), email: z.string() })),
  links: z.array(officeLink),
  /** Links found by the public search (one-day links for one visit): how many, and the last. */
  searches: output({ count: z.number().int(), lastAt: instant().nullable() }),
  /** Why no link can be made now (null: one can). */
  held: z.enum(MAKE_HELD).nullable(),
  mayManage: z.boolean(),
})

export const trackingLinksContract = defineContract({ params: shipmentParams, response: { 200: output({ tracking: trackingLinksView }) } })

const madeLink = output({ id: id(), email: z.string().nullable(), expiresAt: instant(), delivery: z.enum(['QUEUED', 'SENT', 'FAILED']).nullable() })
const skipped = z.array(output({ email: z.string(), reason: z.enum(['SUPPRESSED', 'ALREADY_SENT', 'ASKED_RECENTLY']) }))

export const makeLinksBody = input({
  /** Mail it: to the customer's ORDERS contacts (`default`), to some of its contacts, or to one address. */
  send: z.boolean(),
  contactIds: z.array(id()).min(1).max(20).optional(),
  email: z.string().trim().min(3).max(254).optional(),
  language: z.enum(['it', 'en']).optional(),
})

export const makeLinksContract = defineContract({
  params: shipmentParams,
  body: makeLinksBody,
  response: { 201: output({ links: z.array(madeLink), skipped, url: z.string().nullable(), tracking: trackingLinksView }) },
})

export const revokeLinkContract = defineContract({ params: input({ shipmentId: id(), linkId: id() }), body: input({}).optional(), response: { 200: output({ tracking: trackingLinksView }) } })

// ---- the link page --------------------------------------------------------------------------------------------------

export const trackingPageView = output({
  shipment: output({
    number: z.string(),
    status: z.enum(SHIPMENT_STATUSES),
    transportBy: z.enum(['SENDER', 'RECIPIENT', 'CARRIER']),
    carrierName: z.string().nullable(),
    packedAt: instant().nullable(),
    shippedAt: instant().nullable(),
    deliveredAt: instant().nullable(),
    returnedAt: instant().nullable(),
    /** While packed or on the way only. */
    expectedDeliveryAt: instant().nullable(),
  }),
  /** "Your order 4500-1234": the customer's own reference first, then ours. */
  order: output({ customerRef: z.string().nullable(), number: z.string().nullable() }),
  pill: z.enum(TRACKING_PILLS),
  problem: z.enum(TRACKING_PROBLEMS).nullable(),
  steps: z.array(output({ code: z.enum(TRACKING_STEPS), state: z.enum(STEP_STATES), at: instant().nullable() })),
  parcels: z.array(output({ seq: z.number().int(), trackingNumber: z.string().nullable(), carrierPage: z.string().nullable(), status: z.enum(TRACKING_STATUSES).nullable() })),
  /** The carrier's events, newest first, as codes (the page says them in the reader's language) with the place. */
  events: z.array(output({ id: id(), status: z.enum(TRACKING_STATUSES), place: z.string().nullable(), occurredAt: instant(), parcelSeq: z.number().int().nullable() })),
  delivery: output({ city: z.string().nullable(), postcode: z.string().nullable(), country: z.string().nullable() }),
  papers: output({
    shown: z.boolean(),
    files: z.array(
      output({
        fileId: id(),
        kind: z.enum(PAPER_KINDS),
        number: z.string().nullable(),
        style: output({ code: z.string(), name: z.string() }).nullable(),
        language: z.string().nullable(),
        originalName: z.string(),
        contentType: z.string(),
        sizeBytes: z.number().int(),
      }),
    ),
  }),
  claim: output({ held: z.enum(CLAIM_HELD).nullable() }),
  link: output({ endsAt: instant(), via: z.enum(TRACKING_VIAS).nullable() }),
  /** The sending site's time zone: every time is shown in it. */
  timeZone: z.string(),
})

export const trackingPageContract = defineContract({ response: { 200: trackingPageView } })

export const paperDownloadContract = defineContract({ params: input({ fileId: id() }), body: input({}).optional(), response: { 200: output({ fileId: id(), name: z.string(), download: presignedView }) } })

// ---- the public search ----------------------------------------------------------------------------------------------

export const searchContract = defineContract({
  body: input({
    tenant: z.string().trim().min(1).max(63),
    company: z.string().trim().min(1).max(32).optional(),
    reference: z.string().max(SEARCH_LIMITS.reference * 2),
    postcode: z.string().max(SEARCH_LIMITS.postcode * 2),
    proof: proofBody.optional(),
  }),
  /** One answer for a miss (no shipment), whatever was wrong; a hit: a one-day link per shipment, its token once. */
  response: { 200: output({ shipments: z.array(output({ token: z.string(), number: z.string(), status: z.enum(SHIPMENT_STATUSES), shippedAt: instant().nullable() })) }) },
})

// ---- the portal ("Copy tracking link") --------------------------------------------------------------------------------

export const portalLinkContract = defineContract({
  params: input({ orderId: id(), shipmentId: id() }),
  body: input({}).optional(),
  response: { 201: output({ link: output({ id: id(), expiresAt: instant() }), url: z.string().nullable() }) },
})
