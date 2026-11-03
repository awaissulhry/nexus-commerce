import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { DOCUMENT_LANGUAGES } from '@nexus/factory-domain/documents/model'
import { sendLinkBody, sentLinkView } from '@nexus/factory-domain/shipping/documents/contracts'

/**
 * The quality documents for a customer (B-W2b-123; QHS-055, QHS-059). Office only; every write takes an Idempotency-Key.
 * Refusals in words: 409 with `held/<CODE>` in issues[0].path (NOT_SIGNED, NO_VERSION, NO_SUCH_VERSION, NO_SHIPMENT,
 * NOT_ON_SHIPMENT, NOT_CERTIFIABLE) or the letterhead's missing fields; a shipment not packed yet: 409 invalid_state. No
 * price, cost or pay figure anywhere; never a link's token (it is in the mail only).
 */

const person = output({ id: id(), name: z.string().nullable() })
const issue = output({ path: z.string(), message: z.string() })
const language = input({ language: z.enum(DOCUMENT_LANGUAGES).optional() })
const inspectionParams = input({ inspectionId: id() })
const shipmentParams = input({ shipmentId: id() })

export const versionView = output({ id: id(), version: z.number().int(), language: z.string(), number: z.string().nullable(), fileId: id(), createdAt: instant(), createdBy: person.nullable() })

/** A copy of a version on a shipment: live = shared with the shipment's documents link; a withdrawn one stays as evidence. */
export const shareView = output({ shipmentId: id(), shipmentNumber: z.string().nullable(), fileId: id(), version: z.number().int(), live: z.boolean(), sharedAt: instant() })

const ready = output({ ok: z.boolean(), held: z.array(issue) })
const may = output({ make: z.boolean(), share: z.boolean() })

export const previewReportContract = defineContract({ params: inspectionParams, querystring: language, response: {} })
export const previewCertificateContract = defineContract({ params: shipmentParams, querystring: language, response: {} })

export const reportsContract = defineContract({
  params: inspectionParams,
  response: {
    200: output({
      inspection: output({ id: id(), number: z.string(), status: z.string(), workOrderId: id(), signed: z.boolean() }),
      versions: z.array(versionView),
      /** The shipments that carry garments of the inspection's work order (those the caller sees). */
      shipments: z.array(output({ id: id(), number: z.string(), status: z.string(), customer: z.string().nullable(), shareable: z.boolean(), problem: z.string().nullable() })),
      shares: z.array(shareView),
      ready,
      may,
      asOf: instant(),
    }),
  },
})

export const certificatesContract = defineContract({
  params: shipmentParams,
  response: {
    200: output({
      shipment: output({ id: id(), number: z.string(), status: z.string() }),
      versions: z.array(versionView),
      shares: z.array(shareView),
      /** What the certificate states per cell: the work order, the final inspections and releases that stand. */
      lines: z.array(
        output({
          style: output({ code: z.string(), name: z.string(), revision: z.number().int().nullable() }),
          colourway: z.string(),
          size: z.string(),
          garments: z.number().int(),
          workOrder: z.string(),
          batchNumber: z.string().nullable(),
          inspections: z.array(z.string()),
          releases: z.array(z.string()),
        }),
      ),
      ready,
      may,
      asOf: instant(),
    }),
  },
})

export const makeReportContract = defineContract({ params: inspectionParams, body: language, response: { 201: output({ report: versionView, made: z.boolean() }) } })
export const makeCertificateContract = defineContract({ params: shipmentParams, body: language, response: { 201: output({ certificate: versionView, made: z.boolean() }) } })

const shareBody = {
  version: z.number().int().min(1).optional(),
  /** Mail the shipment's documents link after (shipping.manage), as the shipment's "Send link". */
  send: sendLinkBody.nullable().optional(),
}
const shareAnswer = output({
  shared: output({ shipmentId: id(), shipmentNumber: z.string(), fileId: id(), version: z.number().int(), copied: z.boolean(), withdrawn: z.number().int() }),
  link: output({ links: z.array(sentLinkView), skipped: z.array(output({ email: z.string(), reason: z.enum(['SUPPRESSED', 'ALREADY_SENT', 'ASKED_RECENTLY']) })) }).nullable(),
})
export const shareReportContract = defineContract({ params: inspectionParams, body: input({ shipmentId: id(), ...shareBody }), response: { 201: shareAnswer } })
export const shareCertificateContract = defineContract({ params: shipmentParams, body: input(shareBody), response: { 201: shareAnswer } })
