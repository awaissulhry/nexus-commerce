import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The events of a shipment's labels and documents (B-W2b-391; LOG-027, LOG-031, LOG-058; apps/factory-api
 * modules/shipping/{reprint,shipment-pack,proforma}). Context `shipping-documents`, its own module folder (the shipping
 * events file is W1's). The reprint and the pack reach the office's shipment record (shipping.view) and the packing benches of
 * the shipment's site (shipping.pack); a proforma reaches the office only. No party, no address, no person, no money.
 *
 *   shipping.label_reprinted   labels of a shipment were printed again with a reason (new print jobs naming the originals)
 *   shipping.pack_made         a new version of the shipment's one PDF (its labels and papers merged) was kept
 *   shipping.proforma_made     a new version of a record's proforma invoice was kept
 */
export const events = [
  defineEvent({
    type: 'shipping.label_reprinted',
    context: 'shipping-documents',
    description: 'Labels of a shipment were printed again with a reason: new print jobs copy the originals, nothing is bought again.',
    payload: z.strictObject({
      shipmentId: z.uuid(),
      number: z.string(),
      jobs: z.number().int().min(1),
    }),
    live: { permission: 'shipping.view', floor: 'shipping.pack', fields: ['shipmentId', 'number', 'jobs'] },
  }),
  defineEvent({
    type: 'shipping.pack_made',
    context: 'shipping-documents',
    description: "A new version of a shipment's one PDF was kept: its carrier labels, packing list, DDT and other papers merged in one print job.",
    payload: z.strictObject({
      shipmentId: z.uuid(),
      number: z.string(),
      documentId: z.uuid(),
      version: z.number().int().min(1),
      pages: z.number().int().min(1),
    }),
    live: { permission: 'shipping.view', floor: 'shipping.pack', fields: ['shipmentId', 'number', 'documentId', 'version'] },
  }),
  defineEvent({
    type: 'shipping.proforma_made',
    context: 'shipping-documents',
    description: 'A new version of the proforma invoice of a shipment, a sample shipment or a deposit request was kept, with its own number.',
    payload: z.strictObject({
      recordType: z.enum(['Shipment', 'SampleShipment', 'DepositRequest']),
      recordId: z.uuid(),
      documentId: z.uuid(),
      number: z.string(),
      version: z.number().int().min(1),
    }),
    live: { permission: 'shipping.proforma.issue', fields: ['recordType', 'recordId', 'documentId', 'number', 'version'] },
  }),
] as const
