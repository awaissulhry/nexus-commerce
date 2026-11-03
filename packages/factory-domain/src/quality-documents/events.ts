import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The quality documents for a customer (B-W2b-123; QHS-055 inspection report PDF and share link, QHS-059 certificate of
 * conformity per shipment). apps/factory-api's modules/quality/inspection-docs emits them in the commands that keep a
 * version (a GeneratedDocument with its PDF) or put one on a shipment's documents link. Its own module folder: the quality
 * events file is other steps'.
 *
 *   inspection_report.made          a version of a signed final inspection's report was kept
 *   inspection_report.shared        a kept version was put on a shipment's documents link (older copies of it withdrawn)
 *   conformity_certificate.made     a version of a shipment's certificate of conformity was kept
 *   conformity_certificate.shared   a kept version was put on the shipment's documents link
 *
 * The inspection's screens (quality.inspections.view) and the shipment's (shipping.view: its Documents tab lists what the
 * link shows) read them again. Ids, numbers and counts only; never money, never a person.
 */

const kept = { documentId: z.uuid(), version: z.number().int().min(1), language: z.string().regex(/^[a-z]{2}$/) }
const shared = { shipmentId: z.uuid(), fileId: z.uuid(), version: z.number().int().min(1), withdrawn: z.number().int().min(0) }

export const events = [
  defineEvent({
    type: 'inspection_report.made',
    context: 'quality-documents',
    description: "A version of a signed final inspection's report was kept as a PDF.",
    payload: z.strictObject({ inspectionId: z.uuid(), workOrderId: z.uuid(), number: z.string(), ...kept }),
    live: { permission: 'quality.inspections.view', fields: ['inspectionId', 'workOrderId', 'documentId', 'version'] },
  }),
  defineEvent({
    type: 'inspection_report.shared',
    context: 'quality-documents',
    description: "A kept inspection report was put on a shipment's documents link; the copies of its older versions there were withdrawn from the link.",
    payload: z.strictObject({ inspectionId: z.uuid(), number: z.string(), ...shared }),
    live: { permission: 'shipping.view', fields: ['inspectionId', 'shipmentId', 'fileId', 'version'] },
  }),
  defineEvent({
    type: 'conformity_certificate.made',
    context: 'quality-documents',
    description: "A version of a shipment's certificate of conformity was kept as a PDF.",
    payload: z.strictObject({ shipmentId: z.uuid(), number: z.string(), ...kept }),
    live: { permission: 'shipping.view', fields: ['shipmentId', 'documentId', 'version'] },
  }),
  defineEvent({
    type: 'conformity_certificate.shared',
    context: 'quality-documents',
    description: "A kept certificate of conformity was put on its shipment's documents link; the copies of its older versions there were withdrawn from the link.",
    payload: z.strictObject({ number: z.string(), ...shared }),
    live: { permission: 'shipping.view', fields: ['shipmentId', 'fileId', 'version'] },
  }),
] as const
