import { z } from 'zod'
import { periodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import { amountMinor, businessDate, defineContract, id, input, instant, output, quantity, unitPrice } from '@nexus/factory-domain/core/contracts'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { LINE_KINDS, MATCH_BASES, MATCH_STATUSES } from '@nexus/factory-domain/payables/match'
import { INVOICE_KINDS, INVOICE_SOURCES, INVOICE_STATUSES, PAYABLES_LIMITS, TILES } from '@nexus/factory-domain/payables/rules'
import { PAYABLES_SDI_APPROVALS } from '@nexus/factory-domain/payables/settings'

/**
 * The supplier invoices' contracts (B-W2a-62; FIN-136, FIN-137; design finance.payables, SCR-153). What a supplier
 * charges is a cost: every amount and price is marked money.cost, so the API drops it for a caller without the cost
 * grain (a planner, the warehouse) and refuses a body that sends one. Quantities are decimal strings (four places),
 * prices six, percentages four; amounts integer minor units of the invoice's currency.
 */

const version = () => z.number().int().min(1)
const invoiceParams = input({ invoiceId: id() })
const lineParams = input({ invoiceId: id(), lineId: id() })
const matchParams = input({ invoiceId: id(), matchId: id() })
const docType = () => z.string().regex(/^TD\d{2}$/, 'Expected a TipoDocumento TDnn.')
const vatRate = () => z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, 'Expected a VAT rate in percent, e.g. 22 or 22.00.')
const vatNature = () => z.string().regex(/^N[1-7](\.[0-9])?$/, 'Expected a Natura N1 … N7 (e.g. N6.1).')
const percent = () => z.string().regex(/^\d{1,2}(\.\d{1,4})?$/, 'Expected a percentage above 0 and below 100.').refine((value) => /[1-9]/.test(value), 'Above 0.')
const positiveQuantity = () => quantity().refine((value) => !value.startsWith('-') && /[1-9]/.test(value), 'A quantity above 0.')
const reason = () => z.string().trim().min(1).max(PAYABLES_LIMITS.reason)
const words = output({ en: z.string(), it: z.string() })
const named = output({ id: id(), code: z.string(), name: z.string() })
const person = output({ id: id(), name: z.string().nullable() })
const refusal = output({ code: z.string(), message: z.string() })

const summary = {
  id: id(),
  company: named,
  supplier: output({ id: id(), code: z.string(), name: z.string(), country: z.string() }),
  source: z.enum(INVOICE_SOURCES),
  kind: z.enum(INVOICE_KINDS),
  docType: z.string().nullable(),
  number: z.string(),
  issueDate: businessDate(),
  receivedOn: businessDate(),
  currency: z.string(),
  netTotal: money.cost(z.number().int()),
  vatTotal: money.cost(z.number().int()),
  grossTotal: money.cost(z.number().int()),
  status: z.enum(INVOICE_STATUSES),
  matchStatus: z.enum(MATCH_STATUSES),
  /** Differences outside the tolerance nobody accepted yet. */
  differencesToCheck: z.number().int(),
  approved: z.boolean(),
  approvedAt: instant().nullable(),
  dueDate: businessDate().nullable(),
  paidOn: businessDate().nullable(),
  lines: z.number().int(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
}
export const invoiceRow = output(summary)

const fileRef = output({ id: id(), originalName: z.string(), contentType: z.string(), sizeBytes: z.number().int(), sha256: z.string(), status: z.string(), kind: z.string() })

const lineView = output({
  id: id(),
  seq: z.number().int(),
  kind: z.enum(LINE_KINDS),
  description: z.string(),
  itemCode: z.string().nullable(),
  quantity: z.string().nullable(),
  uom: z.string().nullable(),
  unitPrice: money.cost(z.string().nullable()),
  discountPct: z.string().nullable(),
  netAmount: money.cost(z.number().int()),
  vatRatePct: z.string(),
  vatNature: z.string().nullable(),
  siteId: id().nullable(),
  purchaseOrderLine: output({ id: id(), orderId: id(), orderNumber: z.string(), seq: z.number().int(), item: output({ code: z.string(), name: z.string() }), quantity: z.string(), uom: z.string() }).nullable(),
  subcontractOrder: output({ id: id(), number: z.string(), workOrderId: id() }).nullable(),
  version: z.number().int(),
})

const matchView = output({
  id: id(),
  invoiceLineId: id(),
  lineSeq: z.number().int(),
  purchaseOrderLineId: id().nullable(),
  subcontractOrderId: id().nullable(),
  order: output({ kind: z.enum(['PURCHASE_ORDER', 'SUBCONTRACT_ORDER']), id: id(), number: z.string(), lineSeq: z.number().int().nullable(), item: output({ code: z.string(), name: z.string() }).nullable() }).nullable(),
  /** The receipt line the match names (the latest POSTED one of the order line). */
  receipt: output({ receiptLineId: id(), receiptId: id(), number: z.string(), supplierDdtNumber: z.string().nullable(), supplierDdtDate: businessDate().nullable() }).nullable(),
  /** The order line's unit (pieces for subcontract work): every quantity here is in it. */
  unit: z.string(),
  orderedQuantity: z.string().nullable(),
  orderedUnitPrice: money.cost(z.string()),
  /** Received and not billed yet by the supplier's other invoices. */
  receivedQuantity: z.string(),
  invoicedQuantity: z.string(),
  invoicedUnitPrice: money.cost(z.string()),
  /** What the invoice asks beyond (or below) what was received at the order's price. */
  differenceAmount: money.cost(z.number().int()),
  quantityTolerancePct: z.string(),
  priceTolerancePct: notMoney(z.string()),
  withinTolerance: z.boolean(),
  verdict: z.enum(['WITHIN', 'DIFFERENCE', 'WAITING']),
  /** "Matched · Price differs +0.20/FT2 · Quantity differs −12 FT2" (prices only with the cost grain). */
  words,
  /** The goods, the order or other invoices changed since: match again. */
  stale: z.boolean(),
  accepted: output({ at: instant(), by: person, note: z.string() }).nullable(),
  version: z.number().int(),
})

const vatRow = output({ rate: z.string().nullable(), nature: z.string().nullable(), taxable: z.number().int(), vat: z.number().int() })
const terms = output({ condition: z.string().nullable(), installments: z.array(output({ method: z.string().nullable(), amount: money.cost(z.number().int().nullable()), dueDate: businessDate().nullable(), iban: z.string().nullable() })) })
const held = output({ edit: z.string().nullable(), map: z.string().nullable(), dispute: z.string().nullable(), reopen: z.string().nullable(), withdraw: z.string().nullable(), pay: z.string().nullable(), void: z.string().nullable() })

export const invoiceDetail = output({
  ...summary,
  sdiIdentifier: z.string().nullable(),
  sdiFileName: z.string().nullable(),
  withholdingAmount: money.cost(z.number().int().nullable()),
  stampDutyAmount: money.cost(z.number().int().nullable()),
  vatSummary: money.cost(z.array(vatRow)),
  paymentTerms: terms.nullable(),
  creditOf: output({ id: id(), number: z.string(), issueDate: businessDate() }).nullable(),
  credits: z.array(output({ id: id(), number: z.string(), issueDate: businessDate(), status: z.enum(INVOICE_STATUSES) })),
  /** B-W2b-21 (Z8:05): the SDI file of several invoices (a lotto) it came in, and which of its bodies it is. */
  sdiFile: output({ id: id(), sdiIdentifier: z.string(), fileName: z.string(), invoiceCount: z.number().int(), bodyIndex: z.number().int(), xmlFileId: id().nullable() }).nullable(),
  /** B-W2b-21 (Z8:07): a credit note, the supplier claim it settles. */
  claim: output({ id: id(), number: z.string(), status: z.string() }).nullable(),
  files: output({ xml: fileRef.nullable(), pdf: fileRef.nullable() }),
  /** Who registered it; null: SDI delivered it (nobody of the office). */
  registeredBy: person.nullable(),
  lines: z.array(lineView),
  matches: z.array(matchView),
  /** The match's settings as they apply (B-W2b-21: the company's payables settings; none set: the W2a rule, not decided). */
  tolerance: output({ basis: z.enum(MATCH_BASES), quantityTolerancePct: z.string(), priceTolerancePct: notMoney(z.string()), differenceToleranceAmount: money.cost(z.number().int()), decided: z.boolean(), words }),
  approval: output({ approvedAt: instant().nullable(), approvedBy: person.nullable(), note: z.string().nullable(), ready: z.boolean(), problems: z.array(refusal) }),
  dispute: output({ at: instant(), by: person.nullable(), reason: z.string() }).nullable(),
  payment: output({ dueDate: businessDate().nullable(), paidOn: businessDate().nullable(), paymentRef: z.string().nullable() }),
  voided: output({ at: instant(), reason: z.string() }).nullable(),
  internalNote: z.string().nullable(),
  /** What may not be done now, in words (null: it may). */
  actions: held,
})
const one = { 200: output({ invoice: invoiceDetail }) }
const created = { 201: output({ invoice: invoiceDetail }) }

// ---- reads --------------------------------------------------------------------------------------------------------------

export const listContract = defineContract({
  querystring: input({
    companyId: id().optional(),
    partyId: id().optional(),
    status: z.enum(INVOICE_STATUSES).optional(),
    matchStatus: z.enum(MATCH_STATUSES).optional(),
    source: z.enum(INVOICE_SOURCES).optional(),
    kind: z.enum(INVOICE_KINDS).optional(),
    /** A tile clicked: New from SDI, Differences to check, To approve, Due this week (overdue included). */
    tile: z.enum(TILES).optional(),
    /** The PO's Invoices tab (B-W2a-81): only invoices with a line mapped to one of this purchase order's lines. */
    purchaseOrderId: id().optional(),
    q: z.string().trim().max(100).optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: { 200: output({ items: z.array(invoiceRow), nextCursor: id().nullable(), count: z.number().int() }) },
})

export const countsContract = defineContract({
  querystring: input({ companyId: id().optional(), partyId: id().optional() }),
  response: { 200: output({ newFromSdi: z.number().int(), differences: z.number().int(), toApprove: z.number().int(), dueThisWeek: z.number().int(), weekEnds: businessDate(), readAt: instant() }) },
})

export const getContract = defineContract({ params: invoiceParams, response: one })

export const xmlContract = defineContract({
  params: invoiceParams,
  response: {
    200: output({
      fileName: z.string(),
      fileId: id(),
      /** B-W2b-21: an invoice of a file of several (a lotto): which body of the XML is this invoice (1 …); null: the only one. */
      bodyIndex: z.number().int().nullable(),
      /** The XML as SDI delivered it: it holds the prices, so only with the cost grain. */
      xml: money.cost(z.string()),
      /** What it names, read from it (no amounts): the parties, the orders and delivery notes it refers to, the reason. */
      read: output({
        format: z.string().nullable(),
        supplier: output({ vatNumber: z.string().nullable(), fiscalCode: z.string().nullable(), name: z.string().nullable() }),
        buyer: output({ vatNumber: z.string().nullable(), fiscalCode: z.string().nullable(), name: z.string().nullable() }),
        documents: z.array(output({ docType: z.string(), number: z.string(), issueDate: businessDate(), causale: z.array(z.string()), orders: z.array(output({ document: z.string().nullable(), date: businessDate().nullable(), lines: z.array(z.number().int()) })), ddts: z.array(output({ number: z.string(), date: businessDate().nullable(), lines: z.array(z.number().int()) })), lines: z.number().int(), attachments: z.array(z.string()) })),
      }).nullable(),
    }),
  },
})

export const candidatesContract = defineContract({
  params: invoiceParams,
  querystring: input({ q: z.string().trim().max(100).optional() }),
  response: {
    200: output({
      purchaseOrderLines: z.array(output({ id: id(), orderId: id(), orderNumber: z.string(), orderStatus: z.string(), seq: z.number().int(), siteId: id(), item: output({ code: z.string(), name: z.string() }), supplierArticleCode: z.string().nullable(), quantity: z.string(), uom: z.string() })),
      subcontractOrders: z.array(output({ id: id(), number: z.string(), status: z.string(), siteId: id(), workOrderId: id() })),
    }),
  },
})

const lastPickup = output({
  at: instant(),
  byPerson: z.boolean(),
  listed: z.number().int(),
  recorded: z.number().int(),
  waiting: z.array(output({ sdiIdentifier: z.string(), fileName: z.string(), receivedAt: instant(), problem: z.string() })),
})
export const sdiStatusContract = defineContract({
  querystring: input({ companyId: id().optional() }),
  response: {
    200: output({
      companies: z.array(
        output({
          company: named,
          account: output({ id: id(), mode: z.string(), status: z.string() }).nullable(),
          picksUp: z.boolean(),
          /** B-W2b-21: its `waiting` are the SDI inbox's OPEN items (oldest 50). */
          lastPickup: lastPickup.nullable(),
          /** B-W2b-21 (Z8:06): how many deliveries wait in the SDI inbox (GET /payables/sdi/inbox). */
          inboxOpen: z.number().int(),
        }),
      ),
    }),
  },
})

// ---- writes -------------------------------------------------------------------------------------------------------------

const mappingFields = {
  kind: z.enum(LINE_KINDS).optional(),
  purchaseOrderLineId: id().nullish(),
  subcontractOrderId: id().nullish(),
}
const lineInput = input({
  ...mappingFields,
  description: z.string().trim().min(1).max(PAYABLES_LIMITS.description),
  itemCode: z.string().trim().max(60).nullish(),
  quantity: positiveQuantity().nullish(),
  uom: z.string().trim().max(10).nullish(),
  unitPrice: money.cost(unitPrice().nullish()),
  discountPct: percent().nullish(),
  netAmount: money.cost(amountMinor()),
  vatRatePct: vatRate(),
  vatNature: vatNature().nullish(),
})

export const createContract = defineContract({
  body: input({
    companyId: id(),
    partyId: id(),
    /** MANUAL: "Add foreign invoice" (paper, a foreign supplier's PDF); EMAIL: one that came by e-mail. */
    source: z.enum(['MANUAL', 'EMAIL']),
    kind: z.enum(INVOICE_KINDS).optional(),
    docType: docType().nullish(),
    number: z.string().trim().min(1).max(PAYABLES_LIMITS.number),
    issueDate: businessDate(),
    receivedOn: businessDate().optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    netTotal: money.cost(amountMinor().optional()),
    vatTotal: money.cost(amountMinor().optional()),
    grossTotal: money.cost(amountMinor().optional()),
    withholdingAmount: money.cost(amountMinor().nullish()),
    stampDutyAmount: money.cost(amountMinor().nullish()),
    dueDate: businessDate().nullish(),
    creditOfId: id().nullish(),
    /** The invoice's PDF: a file you can read (an e-mail's attachment, an upload), copied onto the invoice. */
    fileId: id().nullish(),
    inboundEmailId: id().nullish(),
    internalNote: z.string().trim().max(PAYABLES_LIMITS.note).nullish(),
    lines: z.array(lineInput).min(1).max(PAYABLES_LIMITS.lines),
    periodLockOverride: periodLockOverride.optional(),
  }),
  response: created,
})

export const patchContract = defineContract({
  params: invoiceParams,
  body: input({
    version: version(),
    docType: docType().nullish(),
    number: z.string().trim().min(1).max(PAYABLES_LIMITS.number).optional(),
    issueDate: businessDate().optional(),
    receivedOn: businessDate().optional(),
    netTotal: money.cost(amountMinor().optional()),
    vatTotal: money.cost(amountMinor().optional()),
    grossTotal: money.cost(amountMinor().optional()),
    withholdingAmount: money.cost(amountMinor().nullish()),
    stampDutyAmount: money.cost(amountMinor().nullish()),
    dueDate: businessDate().nullish(),
    creditOfId: id().nullish(),
    fileId: id().optional(),
    internalNote: z.string().trim().max(PAYABLES_LIMITS.note).nullish(),
    periodLockOverride: periodLockOverride.optional(),
  }),
  response: one,
})

export const addLineContract = defineContract({
  params: invoiceParams,
  body: lineInput.extend({
    version: version(),
    periodLockOverride: periodLockOverride.optional(),
  }),
  response: { 201: output({ invoice: invoiceDetail }) },
})

export const patchLineContract = defineContract({
  params: lineParams,
  body: input({
    version: version(),
    ...mappingFields,
    description: z.string().trim().min(1).max(PAYABLES_LIMITS.description).optional(),
    itemCode: z.string().trim().max(60).nullish(),
    quantity: positiveQuantity().nullish(),
    uom: z.string().trim().max(10).nullish(),
    unitPrice: money.cost(unitPrice().nullish()),
    discountPct: percent().nullish(),
    netAmount: money.cost(amountMinor().optional()),
    vatRatePct: vatRate().optional(),
    vatNature: vatNature().nullish(),
    periodLockOverride: periodLockOverride.optional(),
  }),
  response: one,
})

export const removeLineContract = defineContract({
  params: lineParams,
  body: input({
    version: version(),
    periodLockOverride: periodLockOverride.optional(),
  }),
  response: one,
})
export const versionContract = defineContract({ params: invoiceParams, body: input({ version: version() }), response: one })
export const reasonContract = defineContract({ params: invoiceParams, body: input({ version: version(), reason: reason() }), response: one })
export const reopenContract = defineContract({ params: invoiceParams, body: input({ version: version(), reason: reason().optional() }), response: one })
export const approveContract = defineContract({ params: invoiceParams, body: input({ version: version(), note: z.string().trim().max(PAYABLES_LIMITS.note).nullish() }), response: one })
export const payContract = defineContract({
  params: invoiceParams,
  body: input({
    version: version(),
    paidOn: businessDate(),
    paymentRef: z.string().trim().min(1).max(PAYABLES_LIMITS.paymentRef),
    periodLockOverride: periodLockOverride.optional(),
  }),
  response: one,
})
export const acceptContract = defineContract({ params: matchParams, body: input({ version: version(), note: reason() }), response: one })

export const bulkApproveContract = defineContract({
  body: input({ items: z.array(input({ id: id(), version: version() })).min(1).max(PAYABLES_LIMITS.bulk), note: z.string().trim().max(PAYABLES_LIMITS.note).nullish() }),
  response: {
    200: output({
      results: z.array(output({ id: id(), approved: z.boolean(), status: z.enum(INVOICE_STATUSES).nullable(), version: z.number().int().nullable(), refusals: z.array(refusal) })),
      approved: z.number().int(),
      refused: z.number().int(),
    }),
  },
})

export const sendToBuyerContract = defineContract({
  params: invoiceParams,
  body: input({ version: version(), message: z.string().trim().max(PAYABLES_LIMITS.note).nullish() }),
  response: { 200: output({ invoice: invoiceDetail, mentioned: z.array(id()), notReached: z.array(id()) }) },
})

export const settleClaimContract = defineContract({
  params: invoiceParams,
  body: input({ version: version(), claimId: id() }),
  /** B-W2b-21: `claimClosed` — the claim was closed by this credit note (ACCEPTED for a credit); false: it was closed before and is matched only. */
  response: { 200: output({ invoice: invoiceDetail, claim: output({ id: id(), number: z.string(), status: z.literal('CLOSED') }), claimClosed: z.boolean() }) },
})

export const pickupContract = defineContract({
  body: input({ companyId: id() }),
  response: {
    200: output({
      companyId: id(),
      accountId: id(),
      listed: z.number().int(),
      known: z.number().int(),
      recorded: z.array(output({ invoiceId: id(), number: z.string(), sdiIdentifier: z.string(), matchStatus: z.string() })),
      waiting: z.array(output({ sdiIdentifier: z.string(), fileName: z.string(), receivedAt: instant(), problem: z.string() })),
      at: instant(),
    }),
  },
})

// ---- B-W2b-21 (Z8:03): the payables settings --------------------------------------------------------------------------

const pct = () => z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, 'Expected a percentage from 0 to 100, at most four decimals.')
const settingsRow = output({
  id: id(),
  companyId: id().nullable(),
  version: z.number().int(),
  quantityTolerancePct: z.string().nullable(),
  priceTolerancePct: notMoney(z.string().nullable()),
  differenceToleranceAmount: money.cost(z.number().int().nullable()),
  billingBasis: z.enum(MATCH_BASES).nullable(),
  sdiApproval: z.enum(PAYABLES_SDI_APPROVALS).nullable(),
  sdiApproverIds: z.array(id()),
  accepterMayNotApprove: z.boolean().nullable(),
  updatedAt: instant(),
})
const SETTING_SOURCES = ['COMPANY', 'TENANT', 'DEFAULT'] as const
const settingSource = z.enum(SETTING_SOURCES)
const settingsAnswer = output({
  companyId: id().nullable(),
  company: settingsRow.nullable(),
  tenant: settingsRow.nullable(),
  effective: output({
    quantityTolerancePct: z.string(),
    priceTolerancePct: notMoney(z.string()),
    differenceToleranceAmount: money.cost(z.number().int()),
    billingBasis: z.enum(MATCH_BASES),
    sdiApproval: z.enum(PAYABLES_SDI_APPROVALS),
    sdiApproverIds: z.array(id()),
    accepterMayNotApprove: z.literal(true),
    /** Every match figure is set (the accountant's, GATE-ACCOUNTANT); false: some follow the W2a rule. */
    decided: z.boolean(),
    /** Where each value comes from (COMPANY, TENANT, DEFAULT): words, not amounts. */
    source: output({ quantityTolerancePct: settingSource, priceTolerancePct: notMoney(z.enum(SETTING_SOURCES)), differenceToleranceAmount: notMoney(z.enum(SETTING_SOURCES)), billingBasis: settingSource, sdiApproval: settingSource, accepterMayNotApprove: settingSource }),
  }),
  words,
  people: z.array(person),
  mayManage: z.boolean(),
})

export const getSettingsContract = defineContract({ querystring: input({ companyId: id().optional() }), response: { 200: settingsAnswer } })

export const putSettingsContract = defineContract({
  body: input({
    /** null: the tenant-wide settings (a role over every company). */
    companyId: id().nullable(),
    /** The row's version as read; absent: the row is made. */
    version: version().optional(),
    quantityTolerancePct: pct().nullish(),
    priceTolerancePct: notMoney(pct().nullish()),
    differenceToleranceAmount: money.cost(z.number().int().min(0).max(2_147_483_647).nullish()),
    billingBasis: z.enum(MATCH_BASES).nullish(),
    sdiApproval: z.enum(PAYABLES_SDI_APPROVALS).nullish(),
    sdiApproverIds: z.array(id()).max(50).optional(),
    accepterMayNotApprove: z.boolean().nullish(),
  }),
  response: { 200: settingsAnswer },
})

// ---- B-W2b-21 (Z8:06): the SDI inbox of deliveries the pickup could not record ------------------------------------------

export const SDI_INBOX_STATUSES = ['OPEN', 'RECORDED', 'DISMISSED'] as const
export const SDI_INBOX_PROBLEMS = ['UNREADABLE', 'SUPPLIER_UNKNOWN', 'OTHER_ADDRESSEE', 'DUPLICATE_NUMBER', 'PERIOD_LOCKED', 'FILE_UNAVAILABLE', 'OTHER'] as const
const inboxItem = output({
  id: id(),
  company: named,
  accountId: id(),
  sdiIdentifier: z.string(),
  fileName: z.string(),
  receivedAt: instant(),
  problem: z.enum(SDI_INBOX_PROBLEMS),
  problemText: z.string(),
  attempts: z.number().int(),
  firstSeenAt: instant(),
  lastTriedAt: instant(),
  status: z.enum(SDI_INBOX_STATUSES),
  xmlFileId: id().nullable(),
  recorded: output({ at: instant(), supplierInvoiceId: id().nullable(), supplierInvoiceFileId: id().nullable() }).nullable(),
  dismissed: output({ at: instant(), by: person.nullable(), reason: z.string() }).nullable(),
  version: z.number().int(),
})
const inboxParams = input({ itemId: id() })

export const listInboxContract = defineContract({
  querystring: input({ companyId: id().optional(), status: z.enum(SDI_INBOX_STATUSES).optional(), cursor: id().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: { 200: output({ items: z.array(inboxItem), nextCursor: id().nullable(), counts: output({ open: z.number().int(), dismissed: z.number().int() }) }) },
})
export const dismissInboxContract = defineContract({ params: inboxParams, body: input({ version: version(), reason: reason() }), response: { 200: output({ item: inboxItem }) } })
export const reopenInboxContract = defineContract({ params: inboxParams, body: input({ version: version() }), response: { 200: output({ item: inboxItem }) } })
