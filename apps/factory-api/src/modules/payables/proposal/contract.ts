import { z } from 'zod'
import { periodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import { businessDate, currency, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { DUAL_STEPS } from '@nexus/factory-domain/payables/proposal/approvals'
import { DUE_BUCKETS, PROPOSAL_LIMITS, PROPOSAL_REFUSALS, PROPOSAL_STATUSES } from '@nexus/factory-domain/payables/proposal/rules'
import { MONEY_ACTIONS } from './controls'

/**
 * The weekly payment proposal's contracts, the remittance switch, the money controls and the invoice's dual approval
 * (B-W2b-403; FIN-140, FIN-142, FIN-167, FIN-169; PQ1:01, PQ1:02). Every amount is money.cost (minor units of the
 * proposal's currency), dropped for a reader without the cost grain. Never an IBAN: an account is masked (country + last 4).
 */

const version = () => z.number().int().min(1)
const words = output({ en: z.string(), it: z.string() })
const person = output({ id: id(), name: z.string().nullable() })
const supplier = output({ id: id(), code: z.string(), name: z.string() })
const account = output({ id: id(), masked: z.string(), usable: z.boolean() })
const held = z.enum([...PROPOSAL_REFUSALS, 'NO_PERMISSION'])
const reason = () => z.string().trim().min(1).max(PROPOSAL_LIMITS.reason)

const lineView = output({
  id: id(),
  invoice: output({ id: id(), number: z.string(), issueDate: businessDate(), dueDate: businessDate().nullable(), due: z.enum(DUE_BUCKETS), status: z.string(), grossTotal: money.cost(z.number().int()), withholdingAmount: money.cost(z.number().int()) }).nullable(),
  supplier,
  amount: money.cost(z.number().int()),
  discountAmount: money.cost(z.number().int()),
  account: account.nullable(),
  held: z.boolean(),
  heldWords: words.nullable(),
  problems: z.array(z.enum(PROPOSAL_REFUSALS)),
  version: z.number().int(),
})

const remittance = output({ on: z.boolean(), source: z.enum(['COMPANY', 'TENANT', 'NONE']), settingsId: id().nullable(), version: z.number().int().nullable(), words })

export const proposalView = output({
  id: id(),
  companyId: id(),
  weekStart: businessDate(),
  weekEnd: businessDate(),
  week: z.number().int(),
  title: words,
  currency: z.string(),
  status: z.enum(PROPOSAL_STATUSES),
  note: z.string().nullable(),
  createdBy: person.nullable(),
  createdAt: instant(),
  approvedBy: person.nullable(),
  approvedAt: instant().nullable(),
  paidAt: instant().nullable(),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  lines: z.array(lineView),
  totals: notMoney(output({ amount: money.cost(z.number().int()), discount: money.cost(z.number().int()), lines: z.number().int(), held: z.number().int(), suppliers: z.number().int() })),
  approval: output({
    fourEyes: words,
    dual: output({ needed: z.boolean(), threshold: money.cost(z.number().int()), decided: z.boolean(), words, first: output({ by: person.nullable(), at: instant(), standing: z.boolean() }).nullable(), waiting: words.nullable() }),
  }),
  remittance,
  may: output({ change: held.nullable(), approve: held.nullable(), sendBack: held.nullable(), cancel: held.nullable(), pay: held.nullable() }),
  version: z.number().int(),
})
const one = { 200: output({ proposal: proposalView }) }
const params = input({ proposalId: id() })
const lineInput = input({ invoiceId: id(), discountAmount: money.cost(z.number().int().min(0).max(2_147_483_647).optional()) })

export const listProposalsContract = defineContract({
  querystring: input({ companyId: id().optional(), status: z.enum(PROPOSAL_STATUSES).optional() }),
  response: {
    200: output({
      items: z.array(output({ id: id(), companyId: id(), weekStart: businessDate(), week: z.number().int(), currency: z.string(), status: z.enum(PROPOSAL_STATUSES), lines: z.number().int(), held: z.number().int(), total: money.cost(z.number().int()), approvedAt: instant().nullable(), paidAt: instant().nullable(), version: z.number().int() })),
    }),
  },
})

export const candidatesContract = defineContract({
  querystring: input({ companyId: id(), weekStart: businessDate().optional(), currency: currency().optional() }),
  response: {
    200: output({
      companyId: id(),
      weekStart: businessDate(),
      weekEnd: businessDate(),
      week: z.number().int(),
      currency: z.string(),
      items: z.array(output({ invoiceId: id(), number: z.string(), supplier, issueDate: businessDate(), dueDate: businessDate().nullable(), due: z.enum(DUE_BUCKETS), grossTotal: money.cost(z.number().int()), payable: money.cost(z.number().int()), account: account.nullable(), held: z.boolean(), inProposal: output({ id: id(), status: z.string() }).nullable() })),
      waiting: z.array(output({ invoiceId: id(), number: z.string(), supplier, dueDate: businessDate().nullable(), due: z.enum(DUE_BUCKETS), status: z.string(), words })),
      totals: notMoney(output({ invoices: z.number().int(), held: z.number().int(), payable: money.cost(z.number().int()) })),
    }),
  },
})

export const createProposalContract = defineContract({
  body: input({ companyId: id(), weekStart: businessDate().optional(), currency: currency().optional(), lines: z.array(lineInput).max(PROPOSAL_LIMITS.lines).optional(), note: z.string().trim().max(PROPOSAL_LIMITS.note).nullish() }),
  response: { 201: output({ proposal: proposalView }) },
})
export const getProposalContract = defineContract({ params, response: one })
export const putLinesContract = defineContract({ params, body: input({ version: version(), lines: z.array(lineInput).max(PROPOSAL_LIMITS.lines), note: z.string().trim().max(PROPOSAL_LIMITS.note).nullish() }), response: one })
export const approveProposalContract = defineContract({
  params,
  body: input({ version: version(), note: z.string().trim().max(PROPOSAL_LIMITS.note).nullish() }),
  response: { 200: output({ proposal: proposalView, step: z.enum(DUAL_STEPS) }) },
})
export const reasonProposalContract = defineContract({ params, body: input({ version: version(), reason: reason() }), response: one })
export const paidProposalContract = defineContract({
  params,
  body: input({ version: version(), paidOn: businessDate(), paymentRef: z.string().trim().min(1).max(PROPOSAL_LIMITS.paymentRef), periodLockOverride: periodLockOverride.optional() }),
  response: {
    200: output({
      proposal: proposalView,
      remittances: z.array(output({ partyId: id(), sent: z.boolean(), held: z.enum(['SWITCHED_OFF', 'NO_CONTACT', 'NOT_SENT']).nullable(), emailId: id().nullable(), recipients: z.number().int(), words: z.string().nullable() })),
    }),
  },
})

const remittanceAnswer = output({ companyId: id().nullable(), on: z.boolean(), source: z.enum(['COMPANY', 'TENANT', 'NONE']), settingsId: id().nullable(), version: z.number().int().nullable(), words, mayChange: z.boolean() })
export const getRemittanceContract = defineContract({ querystring: input({ companyId: id().optional() }), response: { 200: remittanceAnswer } })
export const putRemittanceContract = defineContract({ body: input({ companyId: id().nullable(), remittanceMailOn: z.boolean(), version: version().optional() }), response: { 200: remittanceAnswer } })

export const moneyControlsContract = defineContract({
  querystring: input({ companyId: id() }),
  response: {
    200: output({
      companyId: id(),
      currency: z.string(),
      actions: z.array(
        output({
          code: z.enum(MONEY_ACTIONS),
          kind: output({ code: z.string(), registered: z.boolean(), rules: z.number().int(), active: z.number().int() }).nullable(),
          stepUp: output({ action: z.string(), on: z.boolean() }).nullable(),
          dual: output({ amount: money.cost(z.number().int()), decided: z.boolean() }).nullable(),
          words,
        }),
      ),
      notifications: z.array(output({ code: z.string(), rule: z.string(), audience: z.string() })),
      remittance,
    }),
  },
})

export const invoiceDualContract = defineContract({
  params: input({ invoiceId: id() }),
  response: {
    200: output({
      invoiceId: id(),
      needed: z.boolean(),
      threshold: output({ amount: money.cost(z.number().int()), currency: z.string(), decided: z.boolean(), words }),
      first: output({ by: person, at: instant(), standing: z.boolean() }).nullable(),
      step: z.enum(DUAL_STEPS),
      held: z.enum(['NOT_OPEN', 'NO_PERMISSION', 'SECOND_APPROVER']).nullable(),
      words: words.nullable(),
    }),
  },
})
