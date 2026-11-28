import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { overridesSchema } from '@nexus/factory-domain/sales/warnings/kinds'
import { LEG_STATES } from '@nexus/factory-domain/shipping/warehouse-leg/rules'

/**
 * Our warehouse first (owb- order workflow, S3 ss1; the Shape of build/briefs/owb-ss1.md, FIXED: web A ss3 and S1 po6 code against
 * it). A version is the SHIPMENT's version as read (COL-078), as every shipping act's. No money, no person, no hold. A refusal is a
 * 409 whose issue path names its code (`refusal/<CODE>`, factory-domain shipping/warehouse-leg LEG_REFUSALS); a payment due is the
 * base's 409 of warnings (issue path `warning/PAYMENT_DUE_AT_SHIP`) until the body passes it on in `overrides`.
 */

const version = z.number().int().min(1).optional()
const shipmentParams = input({ shipmentId: id() })

// ---- the acts -------------------------------------------------------------------------------------------------------------------

export const arrivedContract = defineContract({
  params: shipmentParams,
  body: input({ version }),
  response: { 200: output({ shipmentId: id(), arrivedAt: instant(), version: z.number().int() }) },
})

export const forwardContract = defineContract({
  params: shipmentParams,
  body: input({
    version,
    /** Who carries the goods on from our warehouse (words, as typed); null: not said. */
    carrier: z.string().trim().max(200).nullable(),
    trackingNumber: z.string().trim().max(100).nullable(),
    /** The warnings the person saw and goes on with (PAYMENT_DUE_AT_SHIP). */
    overrides: overridesSchema,
  }),
  response: { 200: output({ shipmentId: id(), forwardedAt: instant(), forwardedWithoutLabel: z.boolean(), version: z.number().int() }) },
})

export const customerLabelContract = defineContract({
  params: shipmentParams,
  body: input({ version, fileId: id() }),
  response: { 200: output({ shipmentId: id(), labelSentAt: instant(), version: z.number().int() }) },
})

// ---- the reads ----------------------------------------------------------------------------------------------------------------

const legView = output({
  shipmentId: id(),
  /** The shipment's version (the acts take it). */
  version: z.number().int(),
  warehouse: output({ siteId: id(), name: z.string(), city: z.string().nullable() }),
  /** ON_THE_WAY: not arrived yet (the shipment's own status says whether it left) · AT_OUR_WAREHOUSE · SENT_ON. */
  state: z.enum(LEG_STATES),
  arrivedAt: instant().nullable(),
  forwardedAt: instant().nullable(),
  forwardedWithoutLabel: z.boolean(),
  label: output({ sentAt: instant(), byCustomer: z.boolean(), fileId: id() }).nullable(),
  /** arrived and sendOn: shipping.manage; label: shipping.plan or shipping.manage (and only while it may happen). */
  may: output({ arrived: z.boolean(), sendOn: z.boolean(), label: z.boolean() }),
})

export const orderLegsContract = defineContract({
  querystring: input({ salesOrderId: id() }),
  response: { 200: output({ legs: z.array(legView) }) },
})

const customer = output({ partyId: id(), code: z.string(), name: z.string() })

export const ourWarehousesContract = defineContract({
  response: {
    200: output({
      warehouses: z.array(
        output({
          siteId: id(),
          code: z.string(),
          name: z.string(),
          city: z.string().nullable(),
          country: z.string(),
          atWarehouse: z.array(
            output({ shipmentId: id(), number: z.string(), customer, salesOrders: z.array(output({ id: id(), number: z.string() })), pieces: z.number().int(), arrivedAt: instant(), labelSentAt: instant().nullable() }),
          ),
          onTheWay: z.array(output({ shipmentId: id(), number: z.string(), customer, pieces: z.number().int(), shippedAt: instant() })),
        }),
      ),
    }),
  },
})

// ---- the portal ---------------------------------------------------------------------------------------------------------------

export const portalLabelContract = defineContract({
  params: input({ orderId: id(), shipmentId: id() }),
  body: input({ fileId: id(), version }),
  response: { 200: output({ shipmentId: id(), labelSentAt: instant() }) },
})
