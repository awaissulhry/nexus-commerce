import { z } from 'zod'
import { periodLockLineView } from '@nexus/factory-domain/accounting/contracts'
import { amountMinor, businessDate, currency, defineContract, id, input, instant, output, quantity, unitPrice } from '@nexus/factory-domain/core/contracts'
import { BACK_DATING_LIMITS, MAX_ADJUSTMENT_AMOUNT } from '@nexus/factory-domain/inventory/posting/rules'
import { money } from '@nexus/factory-domain/money/marked'
import { UOMS } from '@nexus/factory-domain/product/units/units'

/**
 * Warehouse rules and what they hold back (B-W2b-314; SCM-196, SCM-281; design warehouse.settings ws-posting, ws-adjust,
 * warehouse.moves mv-approval). Office routes; every write takes an Idempotency-Key and the version read (rules never saved:
 * 0). Refusals in words at `body/<field>` (400); a stale version 409; loosening a rule without the reason 400 `body/reason`,
 * without a fresh code 403 `stepUp`. The adjustment value is a cost: shown and written only with the cost grain.
 */

const source = z.enum(['COMPANY', 'TENANT', 'DEFAULT'])
const place = output({ id: id(), code: z.string(), name: z.string() })
const words = output({ en: z.string(), it: z.string() })

export const rulesView = output({
  /** null: the rules of every company (the tenant-wide row). */
  companyId: id().nullable(),
  company: place.nullable(),
  /** The scope's own row: its version (0: never saved), when it last changed and who changed it ("Changed by"). */
  version: z.number().int().min(0),
  updatedAt: instant().nullable(),
  changedBy: output({ id: id(), name: z.string() }).nullable(),
  /** inventory.rules.manage over the scope (every company: a grant over every company). */
  mayChange: z.boolean(),
  /** ws-posting: how many days back a move may be dated; closed months are Finance's (the link). */
  postingDates: output({
    own: z.number().int().nullable(),
    inForce: output({ days: z.number().int().nullable(), source }),
    today: businessDate(),
    /** The earliest posting date today (null: no limit). */
    earliest: businessDate().nullable(),
    limits: output({ min: z.number().int(), max: z.number().int() }),
    words,
  }),
  /** ws-adjust: adjustments worth more than this wait for a yes (the cost grain: the value is absent without it). */
  adjustmentApproval: output({
    own: money.cost(amountMinor().nullable()),
    inForce: output({ amount: money.cost(amountMinor().nullable()), source, set: z.boolean() }),
    /** The company's currency (the tenant-wide rules: the currency of each company's own adjustments). */
    currency: currency().nullable(),
    /** Who approves is an approval rule's (Admin › Automation › Approval rules, kind STOCK_ADJUSTMENT): how many are on. */
    approvalRules: output({ active: z.number().int().min(0), words }),
    /** The value is held from a reader without the cost grain (the design's "visible and editable only with money.cost"). */
    held: z.string().nullable(),
  }),
  /** Low-stock alerts (SCM-281): on unless switched off here. */
  lowStockAlerts: output({ own: z.boolean().nullable(), inForce: output({ on: z.boolean(), source }) }),
})
export type RulesView = z.infer<typeof rulesView>

export const rulesContract = defineContract({
  querystring: input({ companyId: id().optional() }),
  response: { 200: rulesView },
})

const scope = { companyId: id().nullable().optional(), version: z.number().int().min(0) }
/** Loosening a rule asks why (1 to 500 characters), and a fresh code. */
const reason = z.string().max(1000).nullable().optional()
const saved = { 200: output({ rules: rulesView, loosened: z.boolean() }) }

export const savePostingDatesContract = defineContract({
  body: input({
    ...scope,
    /** 0 to 366; null: follow the rules of every company (a company), or no limit (every company). */
    backDatingDays: z.number().int().min(BACK_DATING_LIMITS.min).max(BACK_DATING_LIMITS.max).nullable(),
    reason,
  }),
  response: saved,
})

export const saveAdjustmentApprovalContract = defineContract({
  body: input({
    ...scope,
    /** Minor units of the company's currency, 0 or more; null: follow every company's (a company) or none (every company). */
    amount: money.cost(amountMinor().refine((value) => value >= 0 && value <= MAX_ADJUSTMENT_AMOUNT, { message: `0 to ${MAX_ADJUSTMENT_AMOUNT}.` }).nullable()),
    reason,
  }),
  response: saved,
})

export const saveLowStockAlertsContract = defineContract({
  body: input({
    ...scope,
    /** null: follow the rules of every company (a company), or on (every company). */
    on: z.boolean().nullable(),
  }),
  response: saved,
})

// ---- a posting date checked before a move is sent (the Adjust dialog's date field) --------------------------------------

export const postingCheckContract = defineContract({
  querystring: input({ siteId: id(), day: businessDate() }),
  response: {
    200: output({
      day: businessDate(),
      today: businessDate(),
      earliest: businessDate().nullable(),
      backDatingDays: output({ days: z.number().int().nullable(), source }),
      /** The day may be used (the back-dating limit; a SOFT lock still asks its reason: `periodLock.needsReason`). */
      allowed: z.boolean(),
      /** Why not, in words (the limit, or a closed month). */
      problem: z.string().nullable(),
      periodLock: periodLockLineView.nullable(),
    }),
  },
})

// ---- an adjustment waiting for a yes (mv-approval) -----------------------------------------------------------------------

export const waitingAdjustmentView = output({
  /** The adjustment's own id (the request's subject StockAdjustment). */
  requestId: id(),
  /** The request in Approvals (GET /approvals/tasks/:taskId). */
  taskId: id(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'STALE']),
  requestedAt: instant(),
  requestedBy: output({ id: id(), name: z.string().nullable() }).nullable(),
  approver: output({ kind: z.enum(['ROLE', 'PERSON']), id: id(), name: z.string().nullable() }),
  dueAt: instant().nullable(),
  site: place,
  item: output({ id: id(), code: z.string(), name: z.string(), baseUom: z.enum(UOMS) }),
  colour: place.nullable(),
  lot: output({ id: id(), code: z.string() }).nullable(),
  hide: output({ id: id(), code: z.string() }).nullable(),
  location: place,
  direction: z.enum(['IN', 'OUT']),
  quantity: quantity(),
  uom: z.enum(UOMS),
  baseQuantity: quantity(),
  /** The stock at the location when it was asked, and after the adjustment (base unit). */
  onHand: output({ from: z.string(), to: z.string() }),
  note: z.string(),
  reasonCode: z.string().nullable(),
  postingDate: businessDate().nullable(),
  /** The size of its value in the company's currency (the cost grain); null: unknown. */
  value: money.cost(output({ amount: money.cost(unitPrice().nullable()), currency: currency() })),
  /** "Waiting for approval by Warehouse manager since 10:42" (it "In attesa di approvazione da Magazzino dalle 10:42"). */
  words,
})
export type WaitingAdjustmentView = z.infer<typeof waitingAdjustmentView>

export const waitingAdjustmentsContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    itemId: id().optional(),
    locationId: id().optional(),
    /** Default PENDING: what waits now. */
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'STALE']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: { 200: output({ rows: z.array(waitingAdjustmentView), count: z.number().int().min(0) }) },
})
