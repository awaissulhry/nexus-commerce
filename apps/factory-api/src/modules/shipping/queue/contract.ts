import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { SHIPMENT_HOLD_REASONS } from '@nexus/factory-domain/shipping/holds/holds'
import { CUT_OFF_LIMITS, CUT_OFF_SOURCES, ISO_WEEKDAYS } from '@nexus/factory-domain/shipping/queue/cutoff'
import { AT_RISK_MINUTES_RANGE, QUEUE_RISKS } from '@nexus/factory-domain/shipping/queue/risk'
import { SEARCH_LIMITS, SEARCH_MATCHES } from '@nexus/factory-domain/shipping/queue/search'
import { SHIPMENT_STATUSES } from '@nexus/factory-domain/shipping/shipments'
import { statusSchema, transportBySchema } from '../views'

/**
 * The shipment queue (B-W2b-386; LOG-018, LOG-110, LOG-120; design warehouse.shipments "Carrier cut-offs today", the views
 * Ship today and At risk of missing the promise, the search box, the history export). No money, no person. Times are UTC
 * instants; a site's day and a cut-off's HH:MM are the site's own (its zone in `site.timeZone`).
 */

/** A carrier's cut-off today at a site: its time (the site's clock), the instant, where it comes from, minutes left. */
export const queueCutOffSchema = output({
  time: z.string(),
  at: instant(),
  /** CARRIER: the site's cut-off of that carrier on this weekday; SITE: the site's default. */
  source: z.enum(CUT_OFF_SOURCES),
  /** Whole minutes from now (below 0: passed). */
  minutesLeft: z.number().int(),
  passed: z.boolean(),
})

const risk = z.enum(QUEUE_RISKS)
const holdReason = z.enum(SHIPMENT_HOLD_REASONS)
const warnMinutes = z.coerce.number().int().min(AT_RISK_MINUTES_RANGE.min).max(AT_RISK_MINUTES_RANGE.max).optional()

const siteDaySchema = output({
  siteId: id(),
  companyId: id(),
  code: z.string(),
  name: z.string(),
  timeZone: z.string(),
  today: businessDate(),
  /** The site works today (its calendar). */
  open: z.boolean(),
  /** Why it does not (the calendar's reason and the day's name). */
  closed: output({ reason: z.string(), name: z.string().nullable() }).nullable(),
  nextWorkingDay: businessDate().nullable(),
})

const queueRowSchema = output({
  id: id(),
  number: z.string(),
  status: statusSchema,
  version: z.number().int(),
  companyId: id(),
  siteId: id(),
  partyId: id(),
  salesOrderId: id(),
  salesOrderNumber: z.string(),
  customerRef: z.string().nullable(),
  partyCode: z.string(),
  partyName: z.string(),
  /** Its card: the carrier's code, SENDER (own van), RECIPIENT (the customer collects) or none. */
  carrierKey: z.string(),
  transportBy: transportBySchema,
  carrierCode: z.string().nullable(),
  carrierName: z.string().nullable(),
  serviceCode: z.string().nullable(),
  shipTo: output({ city: z.string().nullable(), country: z.string().nullable() }),
  splitFromId: id().nullable(),
  garments: z.number().int(),
  parcels: z.number().int(),
  labelled: z.number().int(),
  /** The day it must leave: the earliest current promise of its garments (null: none known). */
  shipBy: businessDate().nullable(),
  cutOff: queueCutOffSchema.nullable(),
  risk,
  /** LATE, HELD or MISSED_CUT_OFF: it misses its promise unless something changes. */
  willMiss: z.boolean(),
  held: z.boolean(),
  holdReasons: z.array(holdReason),
})

export const shipTodayContract = defineContract({
  querystring: input({ siteId: id(), warnMinutes }),
  response: {
    200: output({
      site: siteDaySchema,
      now: instant(),
      carriers: z.array(
        output({
          key: z.string(),
          transportBy: transportBySchema,
          carrierCode: z.string().nullable(),
          carrierName: z.string().nullable(),
          cutOff: queueCutOffSchema.nullable(),
          shipments: z.number().int(),
          packed: z.number().int(),
          toPack: z.number().int(),
          labelled: z.number().int(),
          held: z.number().int(),
          willMiss: z.number().int(),
          parcels: z.number().int(),
          garments: z.number().int(),
        }),
      ),
      tiles: output({ dueToday: z.number().int(), toPack: z.number().int(), packed: z.number().int(), held: z.number().int(), atRisk: z.number().int(), willMiss: z.number().int(), late: z.number().int(), notDue: z.number().int() }),
      shipments: z.array(queueRowSchema),
      truncated: z.boolean(),
    }),
  },
})

export const atRiskContract = defineContract({
  querystring: input({ siteId: id().optional(), warnMinutes }),
  response: {
    200: output({
      now: instant(),
      sites: z.array(siteDaySchema),
      tiles: output({ late: z.number().int(), held: z.number().int(), missedCutOff: z.number().int(), atRisk: z.number().int(), notPlanned: z.number().int() }),
      shipments: z.array(queueRowSchema),
      notPlanned: z.array(
        output({
          salesOrderId: id(),
          number: z.string(),
          customerRef: z.string().nullable(),
          partyCode: z.string(),
          partyName: z.string(),
          siteId: id().nullable(),
          shipBy: businessDate().nullable(),
          cutOff: queueCutOffSchema.nullable(),
          risk,
          /** Released garments on no shipment yet. */
          garments: z.number().int(),
        }),
      ),
    }),
  },
})

export const searchContract = defineContract({
  querystring: input({
    /** A shipment, order or tracking number, the customer's PO or name, a carton's marks code or a serial. */
    q: z.string().max(SEARCH_LIMITS.max * 2).optional(),
    siteId: id().optional(),
    status: z.enum(SHIPMENT_STATUSES).optional(),
    shippedFrom: businessDate().optional(),
    shippedTo: businessDate().optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: {
    200: output({
      term: z.string().nullable(),
      notKept: z.array(z.enum(['SSCC'])),
      shipments: z.array(
        output({
          id: id(),
          number: z.string(),
          status: statusSchema,
          siteId: id(),
          siteCode: z.string(),
          salesOrderId: id(),
          salesOrderNumber: z.string(),
          customerRef: z.string().nullable(),
          partyCode: z.string(),
          partyName: z.string(),
          transportBy: transportBySchema,
          carrierCode: z.string().nullable(),
          carrierName: z.string().nullable(),
          serviceCode: z.string().nullable(),
          trackingNumbers: z.array(z.string()),
          parcels: z.number().int(),
          garments: z.number().int(),
          ddtNumber: z.string().nullable(),
          splitFrom: output({ id: id(), number: z.string(), reason: z.string().nullable() }).nullable(),
          holdReasons: z.array(holdReason),
          createdAt: instant(),
          packedAt: instant().nullable(),
          shippedAt: instant().nullable(),
          deliveredAt: instant().nullable(),
          returnedAt: instant().nullable(),
          cancelledAt: instant().nullable(),
          matchedBy: z.array(z.enum(SEARCH_MATCHES)),
          matchedSerials: z.array(z.string()),
        }),
      ),
      nextCursor: id().nullable(),
    }),
  },
})

const cutOffTable = output({
  siteId: id(),
  defaultCutOff: z.string().nullable(),
  defaultCarrierCode: z.string().nullable(),
  cutOffs: z.array(output({ id: id(), carrierCode: z.string(), weekday: z.enum(ISO_WEEKDAYS), time: z.string() })),
})

const siteParams = input({ siteId: id() })

export const getCutOffsContract = defineContract({ params: siteParams, response: { 200: cutOffTable } })

export const saveCutOffsContract = defineContract({
  params: siteParams,
  body: input({ cutOffs: z.array(input({ carrierCode: z.string().max(80), weekday: z.enum(ISO_WEEKDAYS), time: z.string().max(10) })).max(CUT_OFF_LIMITS.rows) }),
  response: { 200: cutOffTable },
})
