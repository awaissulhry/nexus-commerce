import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { BANK_ACCOUNT_STATUSES, BANK_LIMITS, BANK_PILLS, BANK_SOURCES } from '@nexus/factory-domain/purchasing/bank/rules'

/**
 * Supplier bank details (B-W2b-315; SCM-007; design purchasing.suppliers › Bank details, portal.supplier.profile › Bank
 * details + New bank details). Every write names the account's `version` it read; a proposal names none (it is new). No
 * IBAN in any answer but the reveal's; no money here.
 */

const version = z.number().int().min(1)
const partyParams = input({ partyId: id() })
const accountParams = input({ partyId: id(), accountId: id() })
const person = output({ id: id(), name: z.string().nullable() }).nullable()

const onFileView = output({ kind: z.enum(['CONTACT', 'ADDRESS']), id: id(), label: z.string(), phone: z.string().nullable() })

const approvalView = output({
  taskId: id(),
  status: z.string(),
  requestedAt: instant(),
  approverRoleId: id().nullable(),
  approverUserId: id().nullable(),
  dueAt: instant().nullable(),
}).nullable()

const accountView = output({
  id: id(),
  /** "IT** **** **** 3456": the full IBAN only through …/reveal. */
  masked: z.string(),
  ibanCountry: z.string(),
  ibanLast4: z.string(),
  bic: z.string().nullable(),
  bankName: z.string().nullable(),
  holder: z.string(),
  currency: z.string(),
  status: z.enum(BANK_ACCOUNT_STATUSES),
  /** The design's pill: Waiting call-back check · Waiting second approval · Usable (and the final ones). */
  pill: z.enum(BANK_PILLS),
  pillWords: z.string(),
  source: z.enum(BANK_SOURCES),
  replacesId: id().nullable(),
  proposedAt: instant(),
  proposedBy: person,
  callBack: output({ at: instant(), by: person, kind: z.enum(['CONTACT', 'ADDRESS']), onFileId: id(), label: z.string().nullable(), phone: z.string().nullable() }).nullable(),
  verified: output({ at: instant(), by: person }).nullable(),
  activatedAt: instant().nullable(),
  refused: output({ at: instant(), by: person, reason: z.string().nullable() }).nullable(),
  retired: output({ at: instant(), reason: z.string().nullable() }).nullable(),
  /** The supplier's letter and other files of this account. */
  files: z.array(output({ id: id(), name: z.string(), status: z.string() })),
  /** The request for a second approval a SUPPLIER_BANK_CHANGE rule asked, the newest. */
  approval: approvalView,
  /** While it waits for its call-back: the numbers on file before the proposal it may dial, and the ones left out with why. */
  callBackCandidates: output({ usable: z.array(onFileView), held: z.array(onFileView.extend({ hold: z.string(), words: z.string() })) }).nullable(),
  may: output({ callBack: z.boolean(), verify: z.boolean(), refuse: z.boolean(), retire: z.boolean(), reveal: z.boolean() }),
  /** Why the step is held for this person, in words (null: it may). */
  heldWhy: output({ callBack: z.string().nullable(), verify: z.string().nullable() }),
  version: z.number().int(),
})

const bankView = output({
  supplier: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable() }),
  accounts: z.array(accountView),
  /** The account payments use, per currency (one ACTIVE each). */
  payable: z.array(output({ currency: z.string(), accountId: id() })),
  /** "No bank account — payments to this supplier are held" when none is active; null otherwise. */
  emptyWords: z.string().nullable(),
  may: output({ propose: z.boolean() }),
})

export const getBankContract = defineContract({ params: partyParams, response: { 200: bankView } })

export const proposeBankContract = defineContract({
  params: partyParams,
  body: input({
    /** As typed (spaces allowed); upper-cased and checked (format, the country's length, the check digits). */
    iban: z.string().min(1).max(60),
    holder: z.string().min(1).max(BANK_LIMITS.holder + 20),
    bankName: z.string().max(BANK_LIMITS.bankName).nullable().optional(),
    bic: z.string().max(20).nullable().optional(),
    currency: z.string().length(3).optional(),
  }),
  response: { 201: bankView.extend({ accountId: id() }) },
})

export const callBackContract = defineContract({
  params: accountParams,
  body: input({
    version,
    /** Exactly one: the contact or the address of the supplier whose number on file was dialled. */
    contactId: id().optional(),
    addressId: id().optional(),
    /** The number as dialled (its digits are the record's). */
    phone: z.string().min(1).max(BANK_LIMITS.phone),
  }),
  response: { 200: bankView },
})

const approvalAsked = output({ taskId: id(), approverRoleId: id().nullable(), approverUserId: id().nullable(), dueAt: instant().nullable() })

export const verifyContract = defineContract({
  params: accountParams,
  body: input({ version }),
  /** 200: checked, payments use it now; 202: a switched-on rule asks a second approval (it waits in Approvals). */
  response: { 200: bankView.extend({ approval: approvalAsked.nullable() }), 202: bankView.extend({ approval: approvalAsked.nullable() }) },
})

export const refuseContract = defineContract({
  params: accountParams,
  body: input({ version, reason: z.string().min(1).max(BANK_LIMITS.refuseReason) }),
  response: { 200: bankView },
})

export const retireContract = defineContract({
  params: accountParams,
  body: input({ version, reason: z.string().min(1).max(BANK_LIMITS.retireReason) }),
  response: { 200: bankView },
})

export const revealContract = defineContract({
  params: accountParams,
  response: { 200: output({ accountId: id(), iban: z.string(), grouped: z.string() }) },
})

// ---- the supplier's portal ---------------------------------------------------------------------------------------------

const portalAccountView = output({
  id: id(),
  masked: z.string(),
  bankName: z.string().nullable(),
  holder: z.string(),
  currency: z.string(),
  /** USABLE (payments go to it), WAITING (we call you back, then a second person checks it), REFUSED, RETIRED. */
  state: z.enum(['USABLE', 'WAITING', 'REFUSED', 'RETIRED']),
  proposedAt: instant(),
  /** "Last changed …": when it became the account payments use. */
  activatedAt: instant().nullable(),
  refusedAt: instant().nullable(),
  reason: z.string().nullable(),
  retiredAt: instant().nullable(),
})

const portalBankView = output({
  accounts: z.array(portalAccountView),
  /** The words while a change waits (the design's "Waiting: we call you on your registered number …"). */
  waitingWords: z.string().nullable(),
  mayPropose: z.boolean(),
  live: output({ events: z.array(z.string()) }),
})

export const portalBankContract = defineContract({ response: { 200: portalBankView } })

export const portalProposeContract = defineContract({
  body: input({
    iban: z.string().min(1).max(60),
    holder: z.string().min(1).max(BANK_LIMITS.holder + 20),
    bankName: z.string().max(BANK_LIMITS.bankName).nullable().optional(),
    bic: z.string().max(20).nullable().optional(),
    currency: z.string().length(3).optional(),
  }),
  response: { 201: portalBankView.extend({ accountId: id() }) },
})
