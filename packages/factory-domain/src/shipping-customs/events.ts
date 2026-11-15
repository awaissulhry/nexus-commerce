import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The events of export and customs (B-W2b-409; LOG-086, LOG-087, LOG-088, LOG-089, LOG-095, LOG-097; apps/factory-api
 * modules/shipping/{customs,broker-pack}). Context `shipping-customs`. A shipment's events reach the office's shipping screens
 * (shipping.view); the settings' the shipping settings (shipping.settings.view). No person, no address, no money, no MRN:
 * ids, numbers, kinds and states.
 *
 *   customs.document_made         a commercial invoice, CN 22 or CN 23 version of a shipment was made
 *   customs.declaration_changed   an export declaration was opened (its pack sent to the broker or the carrier, by link or
 *                                 as a download), filed (its MRN: typed in, or answered by the broker's link), named its
 *                                 invoice, had its exit confirmed with its proof, or was removed while its pack was sent
 *   customs.settings_changed      a company's EORI, or a site's broker-pack switch (OFF by default), changed
 */

const shipmentLive = { permission: 'shipping.view' } as const

export const DECLARATION_CHANGES = ['OPENED', 'FILED', 'INVOICE_NAMED', 'EXITED', 'REMOVED', 'PACK_LINKED'] as const

export const events = [
  defineEvent({
    type: 'customs.document_made',
    context: 'shipping-customs',
    description: "A version of a shipment's customs paper was made: its commercial invoice, or the CN 22 or CN 23 of its parcels.",
    payload: z.strictObject({ shipmentId: z.uuid(), number: z.string(), kind: z.enum(['COMMERCIAL_INVOICE', 'CN22', 'CN23']), documentId: z.uuid(), version: z.number().int().min(1) }),
    live: { ...shipmentLive, fields: ['shipmentId', 'number', 'kind', 'version'] },
  }),
  defineEvent({
    type: 'customs.declaration_changed',
    context: 'shipping-customs',
    description:
      "A shipment's export declaration changed: opened with its data pack sent (to the broker or the carrier), its pack sent by link, filed with its MRN (typed in or answered by the broker), its invoice named, its exit confirmed with the proof, or removed while its pack was merely sent.",
    payload: z.strictObject({
      shipmentId: z.uuid(),
      number: z.string(),
      declarationId: z.uuid(),
      change: z.enum(DECLARATION_CHANGES),
      status: z.enum(['PACK_SENT', 'FILED', 'EXITED']).nullable(),
      via: z.enum(['OFFICE', 'LINK']),
    }),
    live: { ...shipmentLive, fields: ['shipmentId', 'number', 'declarationId', 'change', 'status'] },
  }),
  defineEvent({
    type: 'customs.settings_changed',
    context: 'shipping-customs',
    description: "A company's EORI for customs papers, or a site's switch for sending the broker's pack by link, changed.",
    payload: z.strictObject({ companyId: z.uuid(), siteId: z.uuid().nullable(), what: z.enum(['EORI', 'BROKER_PACK']), on: z.boolean().nullable() }),
    live: { permission: 'shipping.settings.view', fields: ['companyId', 'siteId', 'what', 'on'] },
  }),
] as const
