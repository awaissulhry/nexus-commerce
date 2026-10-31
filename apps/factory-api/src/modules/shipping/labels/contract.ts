import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { MAX_LABEL_COPIES } from '@nexus/factory-domain/labels/zpl'
import { MAX_PARCELS } from '@nexus/factory-domain/shipping/shipments'
import { TRACKING_SOURCES, TRACKING_STATUSES } from '@nexus/factory-domain/shipping/labels/tracking'
import { statusSchema, transportBySchema } from '../views'

/**
 * The carrier label and tracking routes (B-W1-48; LOG-025, LOG-032, LOG-059; A2 SCR-067, SCR-098). A version is the
 * SHIPMENT's version as read (COL-078). No money anywhere: the label's price is Sendcloud's invoice to the company.
 */

const version = z.number().int().min(1).optional()
const shipmentParams = input({ shipmentId: id() })
const parcelIds = z.array(id()).min(1).max(MAX_PARCELS).optional()

const labelsView = {
  shipment: output({
    id: id(),
    number: z.string(),
    status: statusSchema,
    version: z.number().int(),
    transportBy: transportBySchema,
    carrierCode: z.string().nullable(),
    carrierName: z.string().nullable(),
    serviceCode: z.string().nullable(),
  }),
  /** The site's label printer (shipping settings), or null: the labels print from the browser as PDFs. */
  labelPrinterId: id().nullable(),
  /** Today's carrier cut-off of the site (Europe/Rome): after it, a parcel leaves the next working day. */
  cutOff: output({ time: z.string(), at: instant(), passed: z.boolean() }).nullable(),
  /** Parcels without a label yet. */
  toLabel: z.number().int(),
  parcels: z.array(
    output({
      parcelId: id(),
      seq: z.number().int(),
      version: z.number().int(),
      grossWeightKg: z.string().nullable(),
      trackingNumber: z.string().nullable(),
      labelledAt: instant().nullable(),
      /** The current label's files: the PDF (any browser prints it) and, with a label printer, the ZPL. */
      files: z.array(output({ fileId: id(), format: z.enum(['PDF', 'ZPL']), name: z.string() })),
      /** The latest print job of the parcel's label. */
      print: output({ jobId: id(), status: z.string(), createdAt: instant() }).nullable(),
    }),
  ),
  /**
   * B-W2b-19: the voided labels, newest first (the design's "Voided" rows): the tracking number and label time each
   * had, when and by whom it was voided, the carrier's answer, the reason, its files. Null for a floor device.
   */
  voided: z
    .array(
      output({
        parcelId: id(),
        seq: z.number().int(),
        trackingNumber: z.string().nullable(),
        labelledAt: instant().nullable(),
        voidedAt: instant(),
        voidedById: id().nullable(),
        carrier: z.enum(['CANCELLED', 'QUEUED', 'NOT_SENT']).nullable(),
        reason: z.string().nullable(),
        files: z.array(output({ fileId: id(), format: z.enum(['PDF', 'ZPL']), name: z.string() })),
      }),
    )
    .nullable(),
}

const outcome = output({ parcelId: id(), seq: z.number().int(), ok: z.boolean(), problem: z.string().optional() })

export const getLabelsContract = defineContract({ params: shipmentParams, response: { 200: output(labelsView) } })

const bought = output({
  ...labelsView,
  /** One per parcel the buy tried: bought, or why not (a partial buy keeps what it bought). */
  outcomes: z.array(outcome),
  /** In words, when a parcel still needs its label; null when every one was bought. */
  problem: z.string().nullable(),
})

export const buyLabelsContract = defineContract({
  params: shipmentParams,
  body: input({ version, parcelIds }),
  response: { 200: bought, 201: bought },
})

export const voidLabelContract = defineContract({
  params: input({ shipmentId: id(), parcelId: id() }),
  body: input({ version, reason: z.string().trim().min(3).max(500) }),
  response: { 200: output({ ...labelsView, voided: output({ parcelId: id(), seq: z.number().int(), carrier: z.enum(['CANCELLED', 'QUEUED', 'NOT_SENT']), words: z.string() }) }) },
})

/** B-W2a-48 (LOG-028): every labelled parcel of the shipment, voided together. */
export const voidAllLabelsContract = defineContract({
  params: shipmentParams,
  body: input({ version, reason: z.string().trim().min(3).max(500) }),
  response: {
    200: output({
      ...labelsView,
      outcomes: z.array(output({ parcelId: id(), seq: z.number().int(), ok: z.boolean(), carrier: z.enum(['CANCELLED', 'QUEUED', 'NOT_SENT']).nullable(), problem: z.string().nullable(), words: z.string().nullable() })),
      problem: z.string().nullable(),
    }),
  },
})

export const printLabelsContract = defineContract({
  params: shipmentParams,
  body: input({ parcelIds, printerId: id().optional(), copies: z.number().int().min(1).max(MAX_LABEL_COPIES).optional() }),
  response: { 201: output({ jobs: z.array(output({ jobId: id(), parcelId: id(), seq: z.number().int(), status: z.string() })) }) },
})

export const trackingContract = defineContract({
  params: shipmentParams,
  response: {
    200: output({
      shipment: output({
        id: id(),
        number: z.string(),
        status: statusSchema,
        carrierCode: z.string().nullable(),
        carrierName: z.string().nullable(),
        shippedAt: instant().nullable(),
        deliveredAt: instant().nullable(),
        returnedAt: instant().nullable(),
      }),
      parcels: z.array(
        output({ parcelId: id(), seq: z.number().int(), trackingNumber: z.string().nullable(), labelledAt: instant().nullable(), status: z.enum(TRACKING_STATUSES).nullable(), lastEventAt: instant().nullable() }),
      ),
      events: z.array(
        output({
          id: id(),
          parcelId: id().nullable(),
          seq: z.number().int().nullable(),
          status: z.enum(TRACKING_STATUSES),
          carrierStatusCode: z.string().nullable(),
          description: z.string().nullable(),
          location: z.string().nullable(),
          occurredAt: instant(),
          recordedAt: instant(),
          source: z.enum(TRACKING_SOURCES),
        }),
      ),
      /** Partly delivered and partly returned, or arrived before it was marked handed over: what a person does. */
      problem: z.string().nullable(),
    }),
  },
})
