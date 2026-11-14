import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { COPY_STATES } from '@nexus/factory-domain/invoicing/archive-copy/archive-copy'

/**
 * The contracts of our own copies of every send to SDI (B-W2b-401; FIN-097): a company's readiness to swap its intermediary
 * with its newest sends' copies, an invoice's copies, making the missing ones. Codes and the words built from them; no money.
 */

const companyParams = input({ companyId: id() })
const invoiceParams = input({ invoiceId: id() })

// ---- our own copies (FIN-097) ----------------------------------------------------------------------------------------------

const sendCopy = output({
  submissionId: id(),
  invoiceId: id(),
  attempt: z.number().int(),
  fileName: z.string(),
  status: z.string(),
  copy: output({ state: z.enum(COPY_STATES), words: z.string() }),
  providerName: z.string().nullable(),
  xmlFileId: id().nullable(),
  receipts: z.array(output({ fileId: id(), notificationId: id(), type: z.string() })),
  notifications: z.number().int(),
  copiedAt: instant().nullable(),
})
const readiness = output({ ready: z.boolean(), open: z.number().int(), missing: z.number().int(), copied: z.number().int(), words: z.string(), providers: z.array(z.string()) })

export const companyCopiesContract = defineContract({ querystring: input({ companyId: id() }), response: { 200: output({ companyId: id(), readiness, sends: z.array(sendCopy) }) } })

export const invoiceCopiesContract = defineContract({ params: invoiceParams, response: { 200: output({ invoiceId: id(), sends: z.array(sendCopy) }) } })

export const makeCopiesContract = defineContract({ params: companyParams, response: { 200: output({ companyId: id(), made: z.number().int(), completed: z.number().int(), remaining: z.number().int(), readiness }) } })
