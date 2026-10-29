import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output, unitPrice } from '@nexus/factory-domain/core/contracts'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { PARTY_TAX_MODES } from '@nexus/factory-domain/parties/tax'
import {
  APPROVAL_REASONS,
  APPROVAL_STATUSES,
  DEPOSIT_KINDS,
  ISSUE_SEVERITIES,
  MAX_SIZE_QUANTITY,
  MAX_TEXT,
  QUOTE_ISSUE_CODES,
  QUOTE_STATUSES,
  QUOTE_VERSION_STATUSES,
  SALES_LINE_KINDS,
} from '@nexus/factory-domain/sales/quotes/quotes'

/**
 * The quotes routes' contracts (B-W1-21; A2 SCR-030 "Quotes", SCR-034 "Quote record", SCR-035 the line and the approval
 * pop-ups). Money is marked: prices and totals money.price, costs money.cost, margins money.margin (the margin AMOUNT is
 * also dropped by the handler for a caller without the cost grain: net − margin is the cost); the API drops a marked
 * field the caller's grains do not reach and refuses a body that sends one. Approval reasons and the issues are in words
 * without a cost or margin figure, so a person without the margin grain still reads why a quote waits. The quote's
 * `version` is the edit-conflict guard of every write (COL-078).
 */

const version = z.number().int().min(1)
const text = (max: number) => z.string().trim().max(max)
const json = z.record(z.string(), z.unknown())
const pct = z.string().trim().max(12)

const sizeInput = input({
  size: z.string().trim().min(1).max(10),
  quantity: z.number().int().min(0).max(MAX_SIZE_QUANTITY),
  /** The size's own net unit price when it differs from the line's (a size surcharge); null: the line's. */
  unitPrice: money.price(unitPrice().nullish()),
})

const lineFields = {
  colourwayId: id(),
  /** The revision the cost is taken from: default the RELEASED one, else the newest DRAFT (an estimate). */
  styleRevisionId: id().nullish(),
  sizes: z.array(sizeInput).min(1).max(50),
  /** On the version's price basis: net for a business, VAT included for a consumer. */
  unitPrice: money.price(unitPrice().nullish()),
  listUnitPrice: money.price(unitPrice().nullish()),
  /** A discount off the list price, percent: the unit price follows (never with a unit price). */
  discountPct: pct.nullish(),
  description: text(MAX_TEXT.description).nullish(),
  note: text(MAX_TEXT.note).nullish(),
}

const certificateView = output({
  outcome: z.enum(['covered', 'not_required', 'refused']),
  certificateNumber: z.string().nullable(),
  /** Why no valid certificate covers the size, in words (empty when covered or not required). */
  reasons: z.array(z.string()),
})

const lineView = output({
  id: id(),
  seq: z.number().int(),
  kind: z.enum(SALES_LINE_KINDS),
  styleId: id(),
  style: output({ code: z.string(), name: z.string(), status: z.string() }),
  styleRevisionId: id().nullable(),
  styleRevision: output({ revision: z.number().int(), status: z.string() }).nullable(),
  colourwayId: id(),
  colourway: output({ code: z.string(), name: z.string() }),
  description: z.string().nullable(),
  note: z.string().nullable(),
  quantity: z.number().int(),
  listUnitPrice: money.price(z.string().nullable()),
  unitPrice: money.price(z.string()),
  discountPct: z.string().nullable(),
  netAmount: money.price(z.number().int()),
  vatRatePct: z.string(),
  vatNature: z.string().nullable(),
  vatAmount: money.price(z.number().int()),
  unitCost: money.cost(z.string().nullable()),
  costAmount: money.cost(z.number().int().nullable()),
  /** Every input of the line's cost is known (else costMissing says what is missing, in words). */
  costComplete: notMoney(z.boolean()),
  costMissing: notMoney(z.array(output({ code: z.string(), message: z.string() }))),
  /** The cost sheet as priced: the cells of the line's sizes (B-W1-16 cellView, with each size's pieces). */
  costSnapshot: money.cost(json.nullable()),
  marginAmount: money.margin(z.number().int().nullable()),
  marginPct: money.margin(z.string().nullable()),
  /** Its margin is under the floor. */
  belowFloor: money.margin(z.boolean()),
  sizes: z.array(output({ size: z.string(), quantity: z.number().int(), unitPrice: money.price(z.string().nullable()), certificate: certificateView })),
  version: z.number().int(),
})

const vatEntry = output({ rate: z.string().nullable(), nature: z.string().nullable(), taxable: z.number().int(), vat: z.number().int(), rounding: z.number().int() })

const currentView = output({
  id: id(),
  revision: z.number().int(),
  status: z.enum(QUOTE_VERSION_STATUSES),
  currency: z.string(),
  language: z.string(),
  taxMode: z.enum(PARTY_TAX_MODES),
  /** NET for a business, GROSS (VAT included) for a consumer (Codice del Consumo art. 49). */
  priceBasis: notMoney(z.enum(['NET', 'GROSS'])),
  taxIdentityId: id().nullable(),
  billToAddressId: id().nullable(),
  shipToAddressId: id().nullable(),
  validUntil: z.string().nullable(),
  firmOffer: z.boolean(),
  promiseDate: z.string().nullable(),
  paymentTerms: z.string().nullable(),
  termsText: z.string().nullable(),
  termsVersion: z.string().nullable(),
  depositPct: z.string().nullable(),
  depositKind: z.enum(DEPOSIT_KINDS).nullable(),
  depositAmount: money.price(z.number().int().nullable()),
  noWithdrawal: z.boolean(),
  netAmount: money.price(z.number().int()),
  vatAmount: money.price(z.number().int()),
  grossAmount: money.price(z.number().int()),
  /** The VAT per rate or nature, as the invoice will say it. */
  vat: money.price(z.array(vatEntry)),
  costAmount: money.cost(z.number().int().nullable()),
  costComplete: notMoney(z.boolean()),
  marginAmount: money.margin(z.number().int().nullable()),
  marginPct: money.margin(z.string().nullable()),
  marginFloorPct: money.margin(z.string().nullable()),
  marginFloorBreached: money.margin(z.boolean()),
  changeNote: z.string().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})

const ruleView = output({
  reason: z.enum(APPROVAL_REASONS),
  known: z.boolean(),
  broken: z.boolean(),
  message: z.string(),
  lines: z.array(z.number().int()),
})

export const approvalView = output({
  id: id(),
  status: z.enum(APPROVAL_STATUSES),
  reasons: z.array(z.enum(APPROVAL_REASONS)),
  requestNote: z.string().nullable(),
  /** The numbers behind each broken rule and exactly what was asked (margin %, prices, discounts; never a cost). */
  details: money.margin(json.nullable()),
  createdById: id().nullable(),
  createdAt: instant(),
  decidedById: id().nullable(),
  decidedAt: instant().nullable(),
  decisionNote: z.string().nullable(),
})

const issueView = output({
  code: z.enum(QUOTE_ISSUE_CODES),
  severity: z.enum(ISSUE_SEVERITIES),
  path: z.string(),
  message: z.string(),
  lineId: id().nullable(),
  size: z.string().nullable(),
})

export const quoteView = output({
  id: id(),
  number: z.string(),
  companyId: id(),
  partyId: id(),
  party: output({ code: z.string(), legalName: z.string(), status: z.string() }),
  contactId: id().nullable(),
  contact: output({ name: z.string(), email: z.string().nullable() }).nullable(),
  customerRef: z.string().nullable(),
  status: z.enum(QUOTE_STATUSES),
  currentRevision: z.number().int(),
  internalNote: z.string().nullable(),
  version: z.number().int(),
  createdById: id().nullable(),
  createdAt: instant(),
  updatedAt: instant(),
  current: currentView,
  lines: z.array(lineView),
  approval: output({
    /** A rule breaks: an approval is needed before the quote is sent. */
    needed: z.boolean(),
    marginFloorPct: money.margin(z.string()),
    discountLimitPct: z.string(),
    rules: z.array(ruleView),
    /** The requests of the current version, newest first. */
    requests: z.array(approvalView),
  }),
  /** What stops or concerns the quote, in words: BLOCKS stops the approval request and the send. */
  issues: z.array(issueView),
  /** An approval can be asked now: a DRAFT that breaks a rule and nothing BLOCKS it. */
  canAskApproval: z.boolean(),
  /** What stops the send (B-W1-24's checks): empty when it could be sent. */
  sendBlockers: z.array(issueView),
})

const one = output({ quote: quoteView })
const quoteParams = input({ quoteId: id() })
const lineParams = input({ quoteId: id(), lineId: id() })

export const listQuotesContract = defineContract({
  querystring: input({
    status: z.enum(QUOTE_STATUSES).optional(),
    companyId: id().optional(),
    partyId: id().optional(),
    /** Only the quotes the caller made. */
    mine: z.enum(['true', 'false']).optional(),
    /** Number or customer reference, case-insensitive. */
    q: z.string().trim().min(1).max(100).optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: {
    200: output({
      quotes: z.array(
        output({
          id: id(),
          number: z.string(),
          companyId: id(),
          partyId: id(),
          partyName: z.string(),
          contactId: id().nullable(),
          customerRef: z.string().nullable(),
          status: z.enum(QUOTE_STATUSES),
          revision: z.number().int(),
          lineCount: z.number().int(),
          units: z.number().int(),
          currency: z.string(),
          netAmount: money.price(z.number().int()),
          grossAmount: money.price(z.number().int()),
          marginPct: money.margin(z.string().nullable()),
          marginFloorBreached: money.margin(z.boolean()),
          /** The newest approval request of the current version: its status, or null when none was asked. */
          approval: z.enum(APPROVAL_STATUSES).nullable(),
          validUntil: z.string().nullable(),
          promiseDate: z.string().nullable(),
          createdById: id().nullable(),
          updatedAt: instant(),
          version: z.number().int(),
        }),
      ),
      nextCursor: id().nullable(),
    }),
  },
})

export const getQuoteContract = defineContract({ params: quoteParams, response: { 200: one } })

const headerFields = {
  contactId: id().nullish(),
  customerRef: text(MAX_TEXT.customerRef).nullish(),
  internalNote: text(MAX_TEXT.internalNote).nullish(),
  validUntil: businessDate().nullish(),
  firmOffer: z.boolean().optional(),
  promiseDate: businessDate().nullish(),
  paymentTerms: text(MAX_TEXT.paymentTerms).nullish(),
  termsText: text(MAX_TEXT.termsText).nullish(),
  termsVersion: text(MAX_TEXT.termsVersion).nullish(),
  /** Percent of the gross total asked at acceptance; null: none. */
  depositPct: pct.nullish(),
  depositKind: z.enum(DEPOSIT_KINDS).nullish(),
  billToAddressId: id().nullish(),
  shipToAddressId: id().nullish(),
  language: z.enum(['it', 'en']).optional(),
  changeNote: text(MAX_TEXT.changeNote).nullish(),
}

export const createQuoteContract = defineContract({
  body: input({ companyId: id(), partyId: id(), ...headerFields }),
  response: { 201: one },
})

export const updateQuoteContract = defineContract({ params: quoteParams, body: input({ version, ...headerFields }), response: { 200: one } })

export const addLineContract = defineContract({
  params: quoteParams,
  body: input({
    version,
    /** SIZE_GRID; MADE_TO_MEASURE is refused for now (Owner Q9: made-to-measure comes later). */
    kind: z.enum(SALES_LINE_KINDS).optional(),
    measurementProfileId: id().nullish(),
    styleId: id(),
    ...lineFields,
  }),
  response: { 201: one },
})

export const editLineContract = defineContract({
  params: lineParams,
  body: input({ version, ...lineFields, colourwayId: id().optional(), sizes: lineFields.sizes.optional() }),
  response: { 200: one },
})

export const removeLineContract = defineContract({ params: lineParams, querystring: input({ version: z.coerce.number().int().min(1) }), response: { 200: one } })

export const recomputeContract = defineContract({ params: quoteParams, body: input({ version }), response: { 200: one } })

export const askApprovalContract = defineContract({ params: quoteParams, body: input({ version, note: text(MAX_TEXT.reason).nullish() }), response: { 200: one } })

const decision = output({
  approvalId: id(),
  /** The approval request: PENDING → its decision. */
  approval: output({ from: z.enum(APPROVAL_STATUSES), to: z.enum(APPROVAL_STATUSES) }),
  /** The version: PENDING_APPROVAL → APPROVED (approve) or DRAFT (reject). */
  status: output({ from: z.enum(QUOTE_VERSION_STATUSES), to: z.enum(QUOTE_VERSION_STATUSES) }),
})

export const approveContract = defineContract({ params: quoteParams, body: input({ version, note: text(MAX_TEXT.reason).nullish() }), response: { 200: output({ quote: quoteView, decision }) } })

export const rejectContract = defineContract({ params: quoteParams, body: input({ version, reason: text(MAX_TEXT.reason).min(1) }), response: { 200: output({ quote: quoteView, decision }) } })

export const reopenContract = defineContract({ params: quoteParams, body: input({ version, reason: text(MAX_TEXT.reason).nullish() }), response: { 200: one } })

export const cancelContract = defineContract({ params: quoteParams, body: input({ version, reason: text(MAX_TEXT.reason).nullish() }), response: { 200: one } })

// ---- the sales settings -----------------------------------------------------------------------------------------------

const settingsView = output({
  /** The company's id, or the tenant's for the tenant-wide row. */
  id: id(),
  companyId: id().nullable(),
  marginFloorPct: money.margin(z.string()),
  discountLimitPct: z.string(),
  defaultValidityDays: z.number().int(),
  defaultDepositPct: z.string().nullable(),
  version: z.number().int(),
  updatedAt: instant(),
})

const rulesView = output({
  marginFloorPct: money.margin(z.string()),
  discountLimitPct: z.string(),
  defaultValidityDays: z.number().int(),
  defaultDepositPct: z.string().nullable(),
  /** DEFAULT (no row), TENANT (the tenant-wide row) or COMPANY (the company's own row). */
  source: z.enum(['DEFAULT', 'TENANT', 'COMPANY']),
})

export const getSettingsContract = defineContract({
  querystring: input({ companyId: id().optional() }),
  response: { 200: output({ settings: output({ tenant: settingsView.nullable(), company: settingsView.nullable(), inForce: rulesView, defaults: rulesView }) }) },
})

export const saveSettingsContract = defineContract({
  body: input({
    /** A company's own settings; none: the tenant-wide ones (a role over every company). */
    companyId: id().optional(),
    marginFloorPct: money.margin(pct),
    discountLimitPct: pct,
    defaultValidityDays: z.number().int(),
    defaultDepositPct: pct.nullable(),
    /** Required once the row exists (the edit-conflict guard); absent on the first save. */
    version: version.optional(),
  }),
  response: { 200: output({ settings: settingsView }) },
})
