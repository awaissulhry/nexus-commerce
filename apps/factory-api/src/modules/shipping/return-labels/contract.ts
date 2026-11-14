import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { RETURN_LABEL_MODES, RETURN_LABEL_REFUSALS, RETURN_LABEL_STATUSES } from '@nexus/factory-domain/shipping/return-labels/rules'

/**
 * Return labels (B-W2b-398; LOG-112; design sales.returns RMA › Shipments, the Return label PDF window; the customer's page
 * SCR-436). Codes only (statuses, modes, refusals): the screens say them. No money.
 */

const returnParams = input({ returnId: id() })

const labelSchema = output({
  id: id(),
  status: z.enum(RETURN_LABEL_STATUSES),
  mode: z.enum(RETURN_LABEL_MODES),
  carrierCode: z.string(),
  /** The carrier's reference (its tracking number), from BOOKED on. */
  bookingReference: z.string().nullable(),
  file: output({ id: id(), name: z.string() }).nullable(),
  /** An offered label's link: to whom, until when, withdrawn, last opened. Never its address. */
  link: output({ email: z.string().nullable(), expiresAt: instant(), revoked: z.boolean(), lastOpenedAt: instant().nullable() }).nullable(),
  usedAt: instant().nullable(),
  createdAt: instant(),
  changedAt: instant(),
})

const labelsSchema = output({
  return: output({ id: id(), number: z.string(), status: z.string() }),
  labels: z.array(labelSchema),
  make: output({
    /** Why no label can be made now (null: one can). */
    held: z.enum(RETURN_LABEL_REFUSALS).nullable(),
    /** The shipment whose addresses a new label swaps (the newest of the order's that left). */
    shipment: output({ id: id(), number: z.string() }).nullable(),
    shipments: z.array(output({ id: id(), number: z.string() })),
    carrierCode: z.string().nullable(),
    /** How long a link offers its label. */
    linkDays: z.number().int(),
  }),
  recipients: z.array(output({ contactId: id(), name: z.string(), email: z.string() })),
  mayManage: z.boolean(),
})

export const returnLabelsContract = defineContract({ params: returnParams, response: { 200: labelsSchema } })

export const makeReturnLabelContract = defineContract({
  params: returnParams,
  body: input({
    mode: z.enum(RETURN_LABEL_MODES),
    shipmentId: id().optional(),
    /** LINK: mail it (default) or one link to pass on (false). */
    send: z.boolean().optional(),
    contactIds: z.array(id()).min(1).max(20).optional(),
  }),
  /** `url`: the link to pass on, in this answer only. */
  response: { 201: output({ url: z.string().nullable(), labels: labelsSchema }) },
})

export const cancelReturnLabelContract = defineContract({
  params: input({ returnId: id(), labelId: id() }),
  body: input({ reason: z.string().max(500).optional() }),
  response: { 200: output({ labels: labelsSchema }) },
})

export const returnLabelPdfContract = defineContract({ params: input({ returnId: id(), labelId: id() }), response: {} })

const pageSchema = output({
  return: output({ number: z.string(), customerRef: z.string().nullable(), status: z.string(), goodsDueBy: businessDate().nullable() }),
  companyName: z.string(),
  lines: z.array(output({ seq: z.number().int(), description: z.string(), size: z.string().nullable(), quantity: z.number().int() })),
  label: output({ status: z.enum(RETURN_LABEL_STATUSES), carrierCode: z.string(), bookingReference: z.string().nullable(), hasPdf: z.boolean(), usedAt: instant().nullable() }),
  bookHeld: z.enum(RETURN_LABEL_REFUSALS).nullable(),
  /** Where the parcel leaves from: the customer's town, postcode and country only. */
  from: output({ city: z.string(), postalCode: z.string(), country: z.string() }).nullable(),
  /** Where it comes back to: our return address. */
  to: output({ name: z.string(), companyName: z.string().nullable(), line1: z.string(), line2: z.string().nullable(), postalCode: z.string(), city: z.string(), province: z.string().nullable(), country: z.string() }).nullable(),
  link: output({ expiresAt: instant() }),
})

export const returnLabelPageContract = defineContract({ response: { 200: pageSchema } })
export const bookReturnLabelContract = defineContract({ response: { 200: pageSchema } })
export const downloadReturnLabelContract = defineContract({
  response: { 200: output({ fileId: id(), name: z.string(), download: output({ method: z.enum(['PUT', 'GET']), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: instant() }) }) },
})
