import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { MAX_PROOFS } from '@nexus/factory-domain/sales/quote-proofs/rules'
import { QUOTE_VERSION_STATUSES } from '@nexus/factory-domain/sales/quotes/quotes'
import { fileView, presignedView } from '../../../platform/files/contract'

/**
 * The proofs' contracts (B-W2b-165; SAL-199). No money anywhere: a proof is a file the customer accepts with the quote.
 * A file never passes through these routes but on the accept link (its bytes, for the page's viewer): an upload is
 * announced, PUT to the store with the presigned request, then confirmed.
 */

const shape = z.enum(['PDF', 'PICTURE'])

/** One proof as the customer's page shows it (GET /link/quote `quote.proofs`). */
export const linkProofView = output({ fileId: id(), name: z.string(), contentType: z.string(), shape, sizeBytes: z.number().int(), sha256: z.string(), versionNo: z.number().int() })

/** One proof as the acceptance's evidence names it. */
const acceptedProofView = output({ fileId: id(), name: z.string(), sha256: z.string(), versionNo: z.number().int(), sizeBytes: z.number().int(), contentType: z.string() })

const acceptedView = output({
  acceptanceId: id().nullable(),
  signerName: z.string().nullable(),
  acceptedAt: instant(),
  /** Each proof accepted: name, SHA-256 and its version (empty when the version had none). */
  proofs: z.array(acceptedProofView),
})

/** One proof of a version, as the office reads it: its newest version and its state. */
const proofView = output({
  fileId: id(),
  seriesId: id(),
  name: z.string(),
  contentType: z.string(),
  shape,
  sizeBytes: z.number().int(),
  sha256: z.string(),
  versionNo: z.number().int(),
  state: z.enum(['READY', 'UPLOADING', 'CHECKING', 'REFUSED']),
  /** The version the customer would see (null while the first one is not ready). */
  currentFileId: id().nullable(),
  /** Shared with the customer's portal and links (the send froze it). */
  sharedWithCustomer: z.boolean(),
  sourceFileId: id().nullable(),
  addedAt: instant(),
  addedBy: z.string().nullable(),
})

const versionView = output({
  versionId: id(),
  revision: z.number().int(),
  status: z.enum(QUOTE_VERSION_STATUSES),
  /** The quote's current version (the one the office works on). */
  current: z.boolean(),
  sentAt: instant().nullable(),
  /** Why its proofs cannot change, in words; null while they can. */
  frozen: z.string().nullable(),
  proofs: z.array(proofView),
  accepted: acceptedView.nullable(),
})

export const proofsView = output({
  quoteId: id(),
  versions: z.array(versionView),
  /** What the caller may do on the current version now, held with the reason before the click. */
  may: output({ change: z.boolean(), held: z.string().nullable() }),
  /** An earlier version whose proofs can be carried over to the current one (none: null). */
  carry: output({ fromVersionId: id(), revision: z.number().int(), count: z.number().int() }).nullable(),
  limits: output({ max: z.number().int(), contentTypes: z.array(z.string()) }),
  at: instant(),
})

const quoteParams = input({ quoteId: id() })
const proofParams = input({ quoteId: id(), fileId: id() })

const uploadBody = input({
  originalName: z.string().min(1).max(500),
  /** A PDF or a picture: application/pdf, image/jpeg, image/png, image/webp. */
  contentType: z.string().min(1).max(200),
  sizeBytes: z.number().int().min(1),
  sha256: z.string(),
})

export const listProofsContract = defineContract({ params: quoteParams, response: { 200: proofsView } })
export const announceProofContract = defineContract({ params: quoteParams, body: uploadBody, response: { 201: output({ file: fileView, upload: presignedView }) } })
export const announceProofVersionContract = defineContract({ params: proofParams, body: uploadBody, response: { 201: output({ file: fileView, upload: presignedView }) } })
export const completeProofContract = defineContract({ params: proofParams, response: { 200: proofsView } })
export const removeProofContract = defineContract({ params: proofParams, response: { 200: proofsView } })
export const carryProofsContract = defineContract({ params: quoteParams, body: input({ fromVersionId: id() }), response: { 200: proofsView } })

/** The proofs accepted with an order's quote version (the order and its work orders read them; never copied). */
const orderProofsView = output({
  orderId: id(),
  number: z.string(),
  quoteId: id().nullable(),
  quoteNumber: z.string().nullable(),
  revision: z.number().int().nullable(),
  accepted: acceptedView.nullable(),
})

export const orderProofsContract = defineContract({ params: input({ orderId: id() }), response: { 200: orderProofsView } })
export const workOrderProofsContract = defineContract({ params: input({ workOrderId: id() }), response: { 200: output({ workOrderId: id(), orders: z.array(orderProofsView) }) } })

/** One proof's bytes on the accept link (inline; a picture without its camera and position data). */
export const linkProofContract = defineContract({ params: input({ fileId: id() }), response: {} })

/** The accept's own field: the proofs the page showed (quotes/contract.ts acceptLinkQuoteContract). */
export const shownProofsField = z.array(id()).max(MAX_PROOFS).optional()
