import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
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
