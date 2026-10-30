import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { EVIDENCE_KINDS, TRANSPORT_EVIDENCE_STATUSES } from '@nexus/factory-domain/shipping/evidence/evidence'
import { attachDocumentsAnswer, linkDocumentsView, renewAnswer, sendLinkAnswer, sendLinkBody, shipmentDocumentsView } from '@nexus/factory-domain/shipping/documents/contracts'
import { fileView, presignedView } from '../../../platform/files/contract'

/**
 * The routes of a shipment's documents (B-W1-49; A2 SCR-067 Documents tab, SCR-101 the link page). No money, and never a
 * link's token: it is in the mail only.
 */

const shipmentParams = input({ shipmentId: id() })

export const documentsContract = defineContract({ params: shipmentParams, response: { 200: output({ documents: shipmentDocumentsView }) } })

export const attachContract = defineContract({ params: shipmentParams, body: input({}), response: { 200: attachDocumentsAnswer } })

const skipped = z.array(output({ email: z.string(), reason: z.enum(['SUPPRESSED', 'ALREADY_SENT', 'ASKED_RECENTLY']) }))

export const sendLinkContract = defineContract({ params: shipmentParams, body: sendLinkBody, response: { 201: sendLinkAnswer.extend({ skipped }) } })

export const linkDocumentsContract = defineContract({ response: { 200: linkDocumentsView } })

export const linkDownloadContract = defineContract({ params: input({ fileId: id() }), body: input({}), response: { 200: output({ file: fileView, download: presignedView }) } })

export const renewContract = defineContract({ body: input({}).optional(), response: { 202: renewAnswer } })

// ---- B-W2a-48 (LOG-090): intra-EU transport evidence ----------------------------------------------------------------

const evidenceView = output({
  shipmentId: id(),
  number: z.string(),
  shipmentStatus: z.string(),
  /** The shipment's version (the next write's edit guard). */
  version: z.number().int(),
  status: z.enum(TRANSPORT_EVIDENCE_STATUSES),
  completedAt: instant().nullable(),
  completedById: id().nullable(),
  /** The office's note on what is on file and what is missing. */
  note: z.string().nullable(),
  /** Why the sale does (or does not) need the evidence, in words. */
  need: z.string(),
  neededBySale: z.boolean(),
  onFile: z.string().nullable(),
  missing: z.string().nullable(),
  papers: z.array(
    output({
      fileId: id(),
      kind: z.enum(EVIDENCE_KINDS),
      kindWords: z.string(),
      originalName: z.string(),
      contentType: z.string(),
      sizeBytes: z.number().int(),
      status: z.string(),
      createdAt: instant(),
    }),
  ),
})

const oneEvidence = output({ evidence: evidenceView })
const version = z.number().int().min(1).optional()

export const evidenceContract = defineContract({ params: shipmentParams, response: { 200: oneEvidence } })

export const announcePaperContract = defineContract({
  params: shipmentParams,
  body: input({
    kind: z.enum(EVIDENCE_KINDS),
    originalName: z.string().min(1).max(500),
    contentType: z.string().min(1).max(200),
    sizeBytes: z.number().int().min(1),
    sha256: z.string(),
  }),
  response: { 201: output({ file: fileView, upload: presignedView }) },
})

export const completePaperContract = defineContract({
  params: input({ shipmentId: id(), fileId: id() }),
  body: input({ version }).optional(),
  response: { 200: output({ file: fileView, evidence: evidenceView }) },
})

export const completeEvidenceContract = defineContract({ params: shipmentParams, body: input({ version, note: z.string().trim().max(2000).nullish() }), response: { 200: oneEvidence } })

export const reopenEvidenceContract = defineContract({ params: shipmentParams, body: input({ version, reason: z.string().trim().min(3).max(500) }), response: { 200: oneEvidence } })

export const evidenceNeededContract = defineContract({ params: shipmentParams, body: input({ version, needed: z.boolean(), reason: z.string().trim().min(3).max(500) }), response: { 200: oneEvidence } })
