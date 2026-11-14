import { z } from 'zod'
import { businessDate, defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { DECLARATION_STATES, MAX_REVOKE_REASON } from '@nexus/factory-domain/invoicing/intent/intent'
import { money } from '@nexus/factory-domain/money/marked'
import { invoiceView } from '../contract'

/**
 * The contracts of the customers' declarations of intent (B-W2b-392; FIN-100): the list and the record, a new declaration,
 * the check on the tax agency's site with its receipt, a revocation, and naming one on a draft invoice. Amounts are
 * marked money.price (the API drops them for staff without the grain and refuses a body that sends one: the amount
 * declared is typed by finance, who hold it). A version is the edit-conflict guard.
 */

const version = z.number().int().min(1)
const declarationParams = input({ declarationId: id() })

export const declarationView = output({
  id: id(),
  version: z.number().int(),
  companyId: id(),
  partyId: id(),
  party: output({ code: z.string(), legalName: z.string() }),
  protocolNumber: z.string(),
  protocolDate: businessDate(),
  year: z.number().int(),
  amount: money.price(z.number().int()),
  usedAmount: money.price(z.number().int()),
  /** What is left to use. */
  leftAmount: money.price(z.number().int()),
  state: z.enum(DECLARATION_STATES),
  checkedAt: z.string().nullable(),
  checkedById: id().nullable(),
  receiptFileId: id().nullable(),
  revokedAt: z.string().nullable(),
  revokeReason: z.string().nullable(),
  /** The company's declarations switch is off: what waits for the accountant, in words; null when on. */
  waits: z.string().nullable(),
  /** The issued invoices that rest on it and the credit notes that gave some back. */
  invoices: z.array(output({ id: id(), docType: z.string(), number: z.string().nullable(), issueDate: businessDate().nullable(), intentAmount: money.price(z.number().int()) })),
})

export const listDeclarationsContract = defineContract({
  querystring: input({ companyId: id().optional(), partyId: id().optional(), year: z.coerce.number().int().min(2000).max(2100).optional(), state: z.enum(DECLARATION_STATES).optional() }),
  response: { 200: output({ declarations: z.array(declarationView) }) },
})

export const getDeclarationContract = defineContract({ params: declarationParams, response: { 200: output({ declaration: declarationView }) } })

export const createDeclarationContract = defineContract({
  body: input({
    companyId: id(),
    partyId: id(),
    protocolNumber: z.string().trim().max(30),
    protocolDate: businessDate(),
    /** The protocol's year when left out. */
    year: z.number().int().min(2000).max(2100).optional(),
    amount: money.price(z.number().int().min(1)),
  }),
  response: { 201: output({ declaration: declarationView }) },
})

export const checkDeclarationContract = defineContract({
  params: declarationParams,
  /** The receipt the tax agency's site printed: a file uploaded on this declaration (POST /files, recordType DeclarationOfIntent). */
  body: input({ version, receiptFileId: id() }),
  response: { 200: output({ declaration: declarationView }) },
})

export const revokeDeclarationContract = defineContract({
  params: declarationParams,
  body: input({ version, reason: z.string().trim().min(3).max(MAX_REVOKE_REASON) }),
  response: { 200: output({ declaration: declarationView }) },
})

export const nameDeclarationContract = defineContract({
  params: input({ invoiceId: id() }),
  /** The declaration the draft rests on (its taxable lines become N3.5), or null to let it go (they take the buyer's VAT again). */
  body: input({ version: version.optional(), declarationOfIntentId: id().nullable() }),
  response: { 200: output({ invoice: invoiceView, declarationOfIntentId: id().nullable() }) },
})
