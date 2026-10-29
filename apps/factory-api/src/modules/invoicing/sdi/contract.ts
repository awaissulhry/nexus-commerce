import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { INVOICE_STATUSES, MAX_CAUSALE, MAX_INVOICE_LINES } from '@nexus/factory-domain/invoicing/invoices'
import { SDI_SEND_STATUSES } from '@nexus/factory-domain/invoicing/sdi/states'
import { SDI_NEXT_ACTIONS, SDI_STATE_CODES } from '@nexus/factory-domain/invoicing/sdi/words'
import { SDI_NOTIFICATION_TYPES } from '@nexus/factory-domain/ports/sdi'
import { invoiceView, lineInput, paymentInput, refInput } from '../contract'

/**
 * The SDI routes' contracts (B-W1-50; A2 SCR-081 tab "SDI status", "Fix and resend"; SCR-080 SDI column): the status
 * of an invoice at SDI, sending it (step-up), correcting a rejected one (step-up). No amount travels in the SDI status;
 * the correction answers the invoice (its money marked with the price grain, as the invoicing routes do).
 */

const invoiceParams = input({ invoiceId: id() })
const problem = output({ code: z.string(), path: z.string(), message: z.string() })

const sdiErrorView = output({ code: z.string(), description: z.string(), hint: z.string().nullable(), words: z.string(), fix: z.enum(['party', 'company', 'lines', 'text', 'none']), known: z.boolean() })

export const sdiView = output({
  invoiceId: id(),
  number: z.string().nullable(),
  issueDate: z.string().nullable(),
  invoiceStatus: z.enum(INVOICE_STATUSES),
  version: z.number().int(),
  /** Where it stands in words, and the next step. */
  state: output({ code: z.enum(SDI_STATE_CODES), title: z.string(), explanation: z.string(), next: output({ action: z.enum(SDI_NEXT_ACTIONS), words: z.string() }) }),
  canSend: z.boolean(),
  /** REJECTED: the last day to send the corrected file again (five working days after the NS). */
  deadline: output({ deadline: z.string(), workingDaysLeft: z.number().int(), overdue: z.boolean() }).nullable(),
  /** REJECTED: the checks the resend runs, each with where to fix it. */
  resend: output({ ready: z.boolean(), problems: z.array(problem) }).nullable(),
  sends: z.array(
    output({
      id: id(),
      attempt: z.number().int(),
      fileName: z.string(),
      status: z.enum(SDI_SEND_STATUSES),
      sdiIdentifier: z.string().nullable(),
      sentAt: instant().nullable(),
      outcomeAt: instant().nullable(),
      /** FAILED: why, and whether the file may have reached SDI. */
      failure: output({ code: z.string(), uncertain: z.boolean(), words: z.string() }).nullable(),
      createdAt: instant(),
      notifications: z.array(
        output({
          id: id(),
          type: z.enum(SDI_NOTIFICATION_TYPES),
          words: z.string(),
          receivedAt: instant(),
          recordedAt: instant(),
          source: z.enum(['webhook', 'poll']),
          errors: z.array(sdiErrorView),
        }),
      ),
    }),
  ),
  /** The legal archive (conservazione) at the intermediary, once the file reached the customer's side. */
  archive: output({ submissionId: id(), archiveRef: z.string(), archivedAt: z.string() }).nullable(),
  /** NOT_DELIVERABLE: the copies e-mailed to the customer, or why none could be. */
  courtesyCopies: output({ queued: z.array(output({ emailId: id(), status: z.string(), queuedAt: instant() })), missing: z.string().nullable() }),
})

const one = output({ sdi: sdiView })

export const getSdiContract = defineContract({ params: invoiceParams, response: { 200: one } })

export const sendSdiContract = defineContract({ params: invoiceParams, body: input({ version: z.number().int().min(1).optional() }), response: { 200: one } })

export const correctSdiContract = defineContract({
  params: invoiceParams,
  body: input({
    version: z.number().int().min(1).optional(),
    lines: z.array(lineInput).min(1).max(MAX_INVOICE_LINES).optional(),
    causale: z.string().trim().max(MAX_CAUSALE).nullish(),
    documentRefs: z.array(refInput).max(20).nullish(),
    payment: paymentInput.nullish(),
  }),
  response: { 200: output({ invoice: invoiceView, resend: output({ ready: z.boolean(), problems: z.array(problem) }) }) },
})
