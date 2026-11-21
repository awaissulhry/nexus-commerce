import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output, unitPrice } from '@nexus/factory-domain/core/contracts'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { MAX_REASON } from '@nexus/factory-domain/sales/orders/orders'
import { MAX_QUOTE_LINES, MAX_SIZE_QUANTITY, MAX_TEXT } from '@nexus/factory-domain/sales/quotes/quotes'
import { FREEZE_LIMITS, FREEZE_STATES, ORDER_FREEZE_ACTIONS, ORDER_FREEZE_FIELDS, ORDER_FREEZE_STAGES } from '@nexus/factory-domain/sales/order-changes/freeze'
import { CHANGE_YES_STATES, CUSTOMER_DECISIONS, PRICED_LIMITS } from '@nexus/factory-domain/sales/order-changes/priced'
import { SERVER_REASON_CODES } from '@nexus/factory-domain/sales/amendments/reasons' // B-OC-012
import { diffView, workOrderPreviewView } from '../orders/daily-contract'
import { orderView } from '../orders/contract'
// B-OP-012: what the office change's work orders did in its command, and what waits.
import { followedView } from '../../production/work-order-changes/contract'
// B-SA-042: what happens to extra pieces already cut.
import { EXTRA_OUTCOMES } from '@nexus/factory-domain/order-apply/rules'

/**
 * The order-changes routes (B-W2b-309; modules/sales/order-changes). Prices, fees and deposits are money.price (dropped for a
 * caller without the grain; a body that sends one without it is refused). No cost, no person's figure.
 */

const words = output({ en: z.string(), it: z.string() })
const version = z.number().int().min(1)
const field = z.enum(ORDER_FREEZE_FIELDS)
const stage = z.enum(ORDER_FREEZE_STAGES)
const action = z.enum(ORDER_FREEZE_ACTIONS)
const issue = output({ path: z.string(), message: z.string() })
const orderParams = input({ orderId: id() })

// ---- freeze rules ----------------------------------------------------------------------------------------------------------

const ruleView = output({
  id: id(),
  companyId: id(),
  /** B-PR-14: the customer whose own rule it is (null: the company's rule). */
  partyId: id().nullable(),
  field,
  fieldWords: words,
  frozenFrom: stage,
  stageWords: words,
  action,
  active: z.boolean(),
  note: z.string().nullable(),
  words,
  updatedBy: z.string().nullable(),
  updatedAt: instant(),
  version: z.number().int(),
})

export const listFreezeRulesContract = defineContract({
  /** B-PR-14: partyId — that customer's own rules beside the company's (404 for a customer the caller does not reach). */
  querystring: input({ companyId: id(), partyId: id().optional() }),
  response: {
    200: output({
      companyId: id(),
      partyId: id().nullable(),
      rules: z.array(ruleView),
      /** B-PR-14 `set`: whose rules decide the field for the customer asked (COMPANY without one). */
      fields: z.array(output({ field, words, scope: z.enum(['SIZE', 'LINE', 'ORDER']), set: z.enum(['CUSTOMER', 'COMPANY']) })),
      mayManage: z.boolean(),
    }),
  },
})

const note = z.string().max(FREEZE_LIMITS.note + 10).nullable().optional()

export const createFreezeRuleContract = defineContract({
  /** B-PR-14: partyId — a customer's own rule (sales.settings.manage or partners.production.manage over it). */
  body: input({ companyId: id(), partyId: id().nullable().optional(), field, frozenFrom: stage, action, note }),
  response: { 201: output({ rule: ruleView }) },
})

export const updateFreezeRuleContract = defineContract({
  params: input({ ruleId: id() }),
  body: input({ version, active: z.boolean().optional(), action: action.optional(), note }),
  response: { 200: output({ rule: ruleView }) },
})

const stageOut = { stage: stage.nullable(), on: businessDate().nullable(), words }
// ── B-OC-017 (order changes tab R13b): what freezes next (from which stage, to what; null: nothing more), and whether the deciding
// rule is the customer's own set ("Rule of {customer}") — never a date ──
const next = output({ stage, action }).nullable()
const verdict = output({ field, fieldWords: words, state: z.enum(FREEZE_STATES), frozenFrom: stage.nullable(), ruleId: id().nullable(), words, next, customerRule: z.boolean() })

export const orderFreezeContract = defineContract({
  params: orderParams,
  response: {
    200: output({
      orderId: id(),
      number: z.string(),
      /** How many active rules the company keeps (0: every field open). */
      rules: z.number().int(),
      order: output({ ...stageOut, fields: z.array(verdict) }),
      lines: z.array(
        output({
          lineId: id(),
          seq: z.number().int(),
          ...stageOut,
          fields: z.array(verdict),
          sizes: z.array(output({ size: z.string(), ...stageOut, locked: z.boolean(), state: z.enum(FREEZE_STATES), words, /* B-OC-017 */ next, customerRule: z.boolean() })),
        }),
      ),
    }),
  },
})

// ---- priced changes --------------------------------------------------------------------------------------------------------

const text = (max: number) => z.string().trim().max(max)
const sizeInput = input({ size: z.string().trim().min(1).max(10), quantity: z.number().int().min(0).max(MAX_SIZE_QUANTITY), unitPrice: money.price(unitPrice().nullish()) })
const amendLine = input({
  id: id().optional(),
  styleId: id().optional(),
  colourwayId: id().optional(),
  sizes: z.array(sizeInput).max(50).optional(),
  unitPrice: money.price(unitPrice().nullish()),
  description: text(MAX_TEXT.description).nullish(),
  note: text(MAX_TEXT.note).nullish(),
})

const pricedFields = {
  reason: z.string().trim().max(MAX_REASON).optional(),
  customerRef: text(MAX_TEXT.customerRef).nullish(),
  requestedDate: businessDate().nullish(),
  lines: z.array(amendLine).min(1).max(MAX_QUOTE_LINES),
  /** The office's words per line part: { "<lineId>": "One more jacket in 52, cut on its own" }. */
  labels: z.record(id(), z.string().max(PRICED_LIMITS.label + 10)).optional(),
  /** The change fee, net, in the order's currency ("25.00"). */
  fee: money.price(z.string().trim().max(20).nullish()),
  /** The extra deposit. B-OL-016 (none unless sent): left out or null = none; `{}` = the order's own percent of the growth. */
  deposit: money.price(
    input({ pct: z.string().trim().max(12).optional(), amount: money.price(z.string().trim().max(20).optional()), dueDate: businessDate().optional(), kind: z.enum(['ACCONTO', 'CAPARRA', 'CAPARRA_PENITENZIALE']).optional() }).nullish(),
  ),
  /** B-SA-042 (R1): what happens to pieces already cut beyond the new figures; required when the change leaves some. */
  extraOutcome: z.enum(EXTRA_OUTCOMES).nullish(),
  /** B-OL-005 (order lines plan D3): ask the customer to accept the new order again; left out: only when the total goes up (a fee). */
  askCustomer: z.boolean().optional(),
}

const partView = output({ label: z.string(), orderLineId: id().nullable(), amount: money.price(z.number().int()) })
const depositPlan = output({ amount: money.price(z.number().int()), pct: z.string(), basis: z.string(), kind: z.string(), growthAmount: money.price(z.number().int()) })

export const previewPricedChangeContract = defineContract({
  params: orderParams,
  body: input({ version: version.optional(), ...pricedFields }),
  response: {
    200: output({
      ok: z.boolean(),
      problems: z.array(issue),
      revision: z.number().int(),
      version: z.number().int(),
      diff: diffView.nullable(),
      parts: money.price(z.array(partView)),
      feeAmount: money.price(z.number().int().nullable()),
      changeAmount: money.price(z.number().int().nullable()),
      deposit: money.price(depositPlan.nullable()),
      /** B-OP-010: an office change applies at once ("Applies at once — no approval"); null with the problems of no plan. */
      yes: z.enum(['APPLIES_AT_ONCE']).nullable(),
      stage: output({ stage, words }).nullable(),
      /** B-OP-013: the extra pieces and what each work order will do (null with the problems of no plan). */
      workOrders: workOrderPreviewView.nullable(),
      // ── B-OL-005 (order lines plan D3; 18 F10): what the Review window's one tick starts from ──
      /** The amount changes (the net, or the fee): for every writer, never which way. */
      amountChanges: notMoney(z.boolean()),
      /** What the customer pays goes up (a higher net, or a fee): only with the price grain. */
      totalUp: money.price(z.boolean()),
    }),
  },
})

const changeView = output({
  id: id(),
  revision: z.number().int(),
  reason: z.string(),
  /** B-OC-012 (order changes tab R8): which server words `reason` is (AUTOMATIC · REQUEST · PUT_BACK); null: typed by a person. */
  reasonCode: z.enum(SERVER_REASON_CODES).nullable(),
  // ── B-OC-010 (R6a): certain links only — the web groups by these, never by time ──
  /** The customer's request this change carried out (its OrderChangeRequest); null: the office's own. */
  changeRequestId: id().nullable(),
  /** A put-back: the revision it restored as before; null: not a put-back. */
  restores: z.number().int().nullable(),
  /** The revision that restored this change as before; null: not restored. */
  restoredBy: z.number().int().nullable(),
  // ── end B-OC-010 ──
  createdAt: instant(),
  createdBy: z.string().nullable(),
  /** A priced change request (its parts or a fee): a yes/no, not money. */
  priced: notMoney(z.boolean()),
  diff: diffView,
  parts: money.price(z.array(partView)),
  feeAmount: money.price(z.number().int().nullable()),
  changeAmount: money.price(z.number().int()),
  deposit: output({ id: id(), kind: z.string(), kindWords: words, amount: money.price(z.number().int()), pct: z.string().nullable(), status: z.string(), dueDate: businessDate() }).nullable(),
  // B-OC-010: + when and by whom (an office person) our yes was decided.
  yes: output({ state: z.enum(CHANGE_YES_STATES), words, taskId: id().nullable(), reason: z.string().nullable(), decidedAt: instant().nullable(), decidedBy: z.string().nullable() }),
  customer: output({
    decision: z.enum(CUSTOMER_DECISIONS),
    words,
    requestId: id().nullable(),
    answeredAt: instant().nullable(),
    // ── B-OC-011 (R6b): how the customer answered its newest ask ──
    /** The full name it typed to sign the answer (null: not answered). */
    by: z.string().nullable(),
    /** By its one-use link or in its portal (null: not answered). No "for the customer": the database refuses it on a revised order. */
    via: z.enum(['LINK', 'PORTAL']).nullable(),
    /** Its own words with the answer — only with partners.approvals.view (the approvals list's rule), else null. */
    answer: z.string().nullable(),
    // ── end B-OC-011 ──
  }),
  /**
   * B-OC-010: `offered` — the latest change with a reason to restore it (our yes refused or the customer's no), to a reader with
   * orders.manage; `may` as before; `why` in words (EN + IT) when it may not (was English only).
   */
  putBack: output({ offered: z.boolean(), may: z.boolean(), why: words.nullable() }),
})

export const applyPricedChangeContract = defineContract({
  params: orderParams,
  // B-OL-004 (order lines plan D2): the reason is optional (none: the server stores the automatic words).
  body: input({ version, ...pricedFields }),
  response: { 201: output({ order: orderView, change: changeView, /* B-OP-012 */ workOrders: followedView }) },
})

export const listChangesContract = defineContract({
  params: orderParams,
  response: { 200: output({ orderId: id(), number: z.string(), waitingForYes: output({ taskId: id(), since: instant() }).nullable(), reapprovalNeededAt: instant().nullable(), changes: z.array(changeView) }) },
})

export const putBackContract = defineContract({
  params: input({ orderId: id(), amendmentId: id() }),
  body: input({ version, reason: z.string().trim().max(MAX_REASON).optional() }),
  response: { 201: output({ order: orderView, change: changeView, depositCancelled: z.boolean(), /* B-OP-012 */ workOrders: followedView }) },
})

export const depositKindsContract = defineContract({
  querystring: input({ companyId: id() }),
  response: {
    200: output({
      companyId: id(),
      kinds: z.array(output({ kind: z.enum(['ACCONTO', 'CAPARRA', 'CAPARRA_PENITENZIALE']), words, available: z.boolean(), why: words.nullable() })),
      caparraPenitenziale: output({ on: z.boolean(), source: z.enum(['COMPANY', 'TENANT', 'NONE']) }),
    }),
  },
})
