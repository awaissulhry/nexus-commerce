import { z } from 'zod'
import { periodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { ELSEWHERE_LIMITS, ELSEWHERE_PROBLEMS } from '@nexus/factory-domain/shipping/elsewhere'
import { OWN_TRANSPORT_LIMITS } from '@nexus/factory-domain/shipping/own-transport/rules'
import { MAX_LINES_PER_REQUEST } from '@nexus/factory-domain/shipping/shipments'
import { oneShipment, transportBySchema } from '../views'

/**
 * B-OP-032 (order page N5; R-2, R-9, R-10, R-23): "Record a shipment made elsewhere" — goods that left with a paper DDT written
 * outside Nexus, recorded in ONE command (a shipment ELSEWHERE, its lines, how it travelled, its paper DDT, SHIPPED at the time
 * it left). The preview says, before anything is written, what the recording would say: every problem with its code, the
 * release that covers each line, the customer's holds and whether this person may record over them, whether the paper DDT is
 * recorded already, whether the site tells the customer. No money.
 */

const garments = () => z.number().int().min(1).max(100_000)
const serial = () => z.string().trim().min(1).max(100)

export const elsewhereBody = input({
  /** The order the shipment is made for (its first order). */
  salesOrderId: id(),
  /** Every order of the shipment, the first = salesOrderId (each checked against it by the join rules; B-OP-047: N6 on). */
  salesOrderIds: z.array(id()).min(1).max(20).optional(),
  /** The site the goods left from (default: the one site of the lines). */
  siteId: id().optional(),
  /** Another delivery address of the customer (default: the order's ship-to). */
  shipToAddressId: id().optional(),
  /** The garments that left: released ones only; a serial-tracked style names each garment's serial (Q31). */
  lines: z.array(input({ workOrderSizeId: id(), quantity: garments(), serials: z.array(serial()).max(100_000).optional() })).min(1).max(MAX_LINES_PER_REQUEST),
  /** How they travelled: a carrier booked by hand (its name and the tracking number when there is one), our van, the customer. */
  transportBy: transportBySchema,
  carrierName: z.string().trim().max(OWN_TRANSPORT_LIMITS.carrierName).nullable().optional(),
  trackingNumber: z.string().trim().max(OWN_TRANSPORT_LIMITS.trackingNumber).nullable().optional(),
  /** The paper DDT that went with the goods, as printed; null only when an immediate invoice travelled instead (ddtRequired false, R-23). */
  externalDdt: input({ number: z.string().max(ELSEWHERE_LIMITS.ddtNumber + 20), date: businessDate() }).nullable(),
  ddtRequired: z.boolean().default(true),
  /** When the goods left: not in the future, at most 60 days back, not before their release. */
  shippedAt: instant(),
  /** R-9: the customer is on hold — a person with shipping.holds.release records it anyway, saying why. */
  holdReason: z.string().trim().min(1).max(ELSEWHERE_LIMITS.reason).optional(),
  internalNote: z.string().max(ELSEWHERE_LIMITS.note).nullable().optional(),
  /** A month locked SOFT: why the stock moves into it (the recording day's month, D5). */
  periodLockOverride: periodLockOverride.optional(),
})
export type ElsewhereBody = z.infer<typeof elsewhereBody>

const problemView = output({ code: z.enum(ELSEWHERE_PROBLEMS), path: z.string(), message: z.string() })

export const elsewherePreviewContract = defineContract({
  body: elsewhereBody,
  response: {
    200: output({
      order: output({ id: id(), number: z.string() }),
      siteId: id(),
      lines: z.array(
        output({
          workOrderSizeId: id(),
          label: z.string(),
          quantity: z.number().int(),
          /** Garments of this cell released and on no shipment now. */
          shippable: z.number().int(),
          /** The release that covers these garments (the day the goods may have left from); null: not released enough. */
          releasedAt: instant().nullable(),
          serialTracked: z.boolean(),
        }),
      ),
      /** The earliest the goods may have left (the latest covering release); null: a line is not released enough. */
      earliest: instant().nullable(),
      /** Every problem of the fields, with its code (the screens word it). */
      problems: z.array(problemView),
      /** R-9: the customer's account hold (its words) and credit hold now; whether this person may record over them (with a reason). */
      holds: output({ held: z.boolean(), accountHold: z.string().nullable(), creditHeld: z.boolean(), mayRelease: z.boolean() }),
      /** R-10: that paper DDT (number and date) is recorded already for this customer. */
      ddtUsed: z.boolean(),
      /** The site tells the customer when goods leave (ShippingSettings.customerNoticeOn): the recording does too. */
      noticeOn: z.boolean(),
      /** The paper DDT number fits the e-invoice's DDT reference (FatturaPA: 20 characters) — else the invoice cannot cite it. */
      ddtCitable: z.boolean(),
    }),
  },
})

export const recordElsewhereContract = defineContract({
  body: elsewhereBody,
  response: { 201: output({ ...oneShipment.shape, warnings: z.array(z.string()) }) },
})
