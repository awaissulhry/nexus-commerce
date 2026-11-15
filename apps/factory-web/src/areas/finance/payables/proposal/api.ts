import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * The weekly payment proposal on screen (B-W2b-425 on B-W2b-403's API; design finance.payables pop:proposal "Payment proposal
 * — week 46": invoices by due date and discount; total; IBAN checks (usable); approver ≠ the person who entered). Every
 * amount is a cost, absent without money.cost (never zero); an account is masked (country + last four), never an IBAN. The
 * lists mirror factory-domain payables/proposal (the tests hold them equal); the answers' words are never drawn.
 */

export const PROPOSAL_STATUSES = ['DRAFT', 'APPROVED', 'PAID', 'CANCELLED'] as const
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]
export const DUE_BUCKETS = ['OVERDUE', 'THIS_WEEK', 'LATER', 'NO_DUE_DATE'] as const
export type DueBucket = (typeof DUE_BUCKETS)[number]
export const PROPOSAL_REFUSALS = [
  'NOT_DRAFT',
  'NOT_APPROVED',
  'EMPTY',
  'HELD',
  'INVOICE_NOT_APPROVED',
  'INVOICE_PAID',
  'IN_ANOTHER_PROPOSAL',
  'CURRENCY',
  'NOT_A_SUPPLIER_INVOICE',
  'OTHER_COMPANY',
  'OWN_PROPOSAL',
  'SECOND_APPROVER',
  'TOO_MUCH',
  'NOT_PAID_YET',
] as const
export type ProposalRefusal = (typeof PROPOSAL_REFUSALS)[number]
/** A `may.*` hold: a refusal code, or no right. */
export type ProposalHold = ProposalRefusal | 'NO_PERMISSION'
export const DUAL_STEPS = ['SINGLE', 'FIRST', 'SECOND'] as const
export type DualStep = (typeof DUAL_STEPS)[number]
export const REMITTANCE_HELD = ['SWITCHED_OFF', 'NO_CONTACT', 'NOT_SENT'] as const
export const PROPOSAL_LIMITS = { lines: 500, note: 2000, reason: 2000, paymentRef: 120 } as const

const cost = <T extends z.ZodTypeAny>(schema: T) => schema.optional()
const person = z.object({ id: z.string(), name: z.string().nullable() })
const supplier = z.object({ id: z.string(), code: z.string(), name: z.string() })
const account = z.object({ id: z.string(), masked: z.string(), usable: z.boolean() })
const hold = z.enum([...PROPOSAL_REFUSALS, 'NO_PERMISSION'])

export const lineSchema = z.object({
  id: z.string(),
  invoice: z.object({ id: z.string(), number: z.string(), issueDate: z.string(), dueDate: z.string().nullable(), due: z.enum(DUE_BUCKETS), status: z.string(), grossTotal: cost(z.number()), withholdingAmount: cost(z.number()) }).nullable(),
  supplier,
  amount: cost(z.number()),
  discountAmount: cost(z.number()),
  account: account.nullable(),
  held: z.boolean(),
  problems: z.array(z.enum(PROPOSAL_REFUSALS)),
  version: z.number(),
})
export type ProposalLine = z.infer<typeof lineSchema>

export const proposalSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  weekStart: z.string(),
  weekEnd: z.string(),
  week: z.number(),
  currency: z.string(),
  status: z.enum(PROPOSAL_STATUSES),
  note: z.string().nullable(),
  createdBy: person.nullable(),
  createdAt: z.string(),
  approvedBy: person.nullable(),
  approvedAt: z.string().nullable(),
  paidAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  lines: z.array(lineSchema),
  totals: z.object({ amount: cost(z.number()), discount: cost(z.number()), lines: z.number(), held: z.number(), suppliers: z.number() }),
  approval: z.object({
    dual: z.object({ needed: z.boolean(), threshold: cost(z.number()), decided: z.boolean(), first: z.object({ by: person.nullable(), at: z.string(), standing: z.boolean() }).nullable() }),
  }),
  remittance: z.object({ on: z.boolean(), source: z.enum(['COMPANY', 'TENANT', 'NONE']) }),
  may: z.object({ change: hold.nullable(), approve: hold.nullable(), sendBack: hold.nullable(), cancel: hold.nullable(), pay: hold.nullable() }),
  version: z.number(),
})
export type Proposal = z.infer<typeof proposalSchema>
const oneProposal = z.object({ proposal: proposalSchema })

export const proposalRowSchema = z.object({ id: z.string(), companyId: z.string(), weekStart: z.string(), week: z.number(), currency: z.string(), status: z.enum(PROPOSAL_STATUSES), lines: z.number(), held: z.number(), total: cost(z.number()), approvedAt: z.string().nullable(), paidAt: z.string().nullable(), version: z.number() })
export type ProposalRow = z.infer<typeof proposalRowSchema>

export const candidatesSchema = z.object({
  companyId: z.string(),
  weekStart: z.string(),
  weekEnd: z.string(),
  week: z.number(),
  currency: z.string(),
  items: z.array(z.object({ invoiceId: z.string(), number: z.string(), supplier, issueDate: z.string(), dueDate: z.string().nullable(), due: z.enum(DUE_BUCKETS), grossTotal: cost(z.number()), payable: cost(z.number()), account: account.nullable(), held: z.boolean(), inProposal: z.object({ id: z.string(), status: z.string() }).nullable() })),
  waiting: z.array(z.object({ invoiceId: z.string(), number: z.string(), supplier, dueDate: z.string().nullable(), due: z.enum(DUE_BUCKETS), status: z.string() })),
  totals: z.object({ invoices: z.number(), held: z.number(), payable: cost(z.number()) }),
})
export type ProposalCandidates = z.infer<typeof candidatesSchema>
export type ProposalCandidate = ProposalCandidates['items'][number]

const remittancesSchema = z.array(z.object({ partyId: z.string(), sent: z.boolean(), held: z.enum(REMITTANCE_HELD).nullable(), recipients: z.number() }))
export type Remittances = z.infer<typeof remittancesSchema>

const enc = encodeURIComponent

/** GET /payables/proposals (payables.view): newest week first. */
export async function listProposals(api: ApiClient, query: { companyId: string; status?: ProposalStatus }, signal?: AbortSignal): Promise<ProposalRow[]> {
  return (await api.get('/payables/proposals', { query, schema: z.object({ items: z.array(proposalRowSchema) }), signal })).items
}

/** GET /payables/proposals/candidates (payables.view): the approved invoices due by the week's Sunday; the ones still waiting. */
export function proposalCandidates(api: ApiClient, query: { companyId: string; weekStart?: string; currency?: string }, signal?: AbortSignal): Promise<ProposalCandidates> {
  return api.get('/payables/proposals/candidates', { query, schema: candidatesSchema, signal })
}

export interface LineInput {
  invoiceId: string
  discountAmount?: number
}

/** POST /payables/proposals (payables.proposals.manage): a DRAFT of the week with the lines picked. */
export async function createProposal(api: ApiClient, body: { companyId: string; weekStart: string; currency?: string; lines: LineInput[]; note?: string | null }, idempotencyKey: string): Promise<Proposal> {
  return (await api.post('/payables/proposals', { body, schema: oneProposal, idempotencyKey })).proposal
}

/** GET /payables/proposals/:id (payables.view): the pop-up. */
export async function getProposal(api: ApiClient, proposalId: string, signal?: AbortSignal): Promise<Proposal> {
  return (await api.get(`/payables/proposals/${enc(proposalId)}`, { schema: oneProposal, signal })).proposal
}

/** PUT /payables/proposals/:id/lines (payables.proposals.manage): picked again while DRAFT. */
export async function putLines(api: ApiClient, proposal: Pick<Proposal, 'id' | 'version'>, lines: LineInput[], idempotencyKey: string): Promise<Proposal> {
  return (await api.request('PUT', `/payables/proposals/${enc(proposal.id)}/lines`, { body: { version: proposal.version, lines }, schema: oneProposal, idempotencyKey })).proposal
}

/** POST /payables/proposals/:id/approve (payables.proposals.approve + a fresh code): one person's yes (a second one above the amount). */
export function approveProposal(api: ApiClient, proposal: Pick<Proposal, 'id' | 'version'>, note: string | null, idempotencyKey: string): Promise<{ proposal: Proposal; step: DualStep }> {
  return api.post(`/payables/proposals/${enc(proposal.id)}/approve`, { body: { version: proposal.version, ...(note ? { note } : {}) }, schema: z.object({ proposal: proposalSchema, step: z.enum(DUAL_STEPS) }), idempotencyKey })
}

/** POST /payables/proposals/:id/send-back | cancel (payables.proposals.manage): with why. */
export async function reasonMove(api: ApiClient, proposal: Pick<Proposal, 'id' | 'version'>, move: 'send-back' | 'cancel', reason: string, idempotencyKey: string): Promise<Proposal> {
  return (await api.post(`/payables/proposals/${enc(proposal.id)}/${move}`, { body: { version: proposal.version, reason }, schema: oneProposal, idempotencyKey })).proposal
}

/** POST /payables/proposals/:id/paid (proposals.manage + payables.pay): the transfers left the bank — the day and the bank's reference. */
export function recordProposalPaid(api: ApiClient, proposal: Pick<Proposal, 'id' | 'version'>, body: { paidOn: string; paymentRef: string }, idempotencyKey: string): Promise<{ proposal: Proposal; remittances: Remittances }> {
  return api.post(`/payables/proposals/${enc(proposal.id)}/paid`, { body: { version: proposal.version, ...body }, schema: z.object({ proposal: proposalSchema, remittances: remittancesSchema }), idempotencyKey })
}
