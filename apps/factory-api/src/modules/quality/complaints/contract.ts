import { z } from 'zod'
import { REGISTER_RISKS } from '@nexus/factory-domain/compliance/register/rules'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { money } from '@nexus/factory-domain/money/marked'
import {
  COMPLAINT_ACTIONS,
  COMPLAINT_CATEGORIES,
  COMPLAINT_CHANNELS,
  COMPLAINT_SEVERITIES,
  COMPLAINT_STATUSES,
  COMPLAINT_VIEWS,
  HELD_CODES,
  OFFICE_CHANNELS,
  SAFETY_STATES,
  STATUS_MOVES,
} from '@nexus/factory-domain/quality/complaints/rules'

/**
 * Customer complaints (B-W2a-65; SAL-416, QHS-113, QHS-115; design quality.complaints). The order's value is the only
 * amount (the price grain: dropped for a reader without it). Every write takes an Idempotency-Key and the complaint's
 * `version`. Refusals in words: `body/<field>` (400), a step its status does not take (409 invalid_state, with the held
 * code in `issues[0].path` = `held/<CODE>`), a stale version (409 conflict). No worker's name anywhere; office people by
 * id, their names in `people`.
 */

const version = z.number().int().min(1)
const status = z.enum(COMPLAINT_STATUSES)
const category = z.enum(COMPLAINT_CATEGORIES)
const severity = z.enum(COMPLAINT_SEVERITIES)
const channel = z.enum(COMPLAINT_CHANNELS)
const issue = output({ path: z.string(), message: z.string() })
const complaintParams = input({ complaintId: id() })
const party = output({ id: id(), code: z.string(), legalName: z.string() })
const person = output({ id: id(), name: z.string() })
const numbered = output({ id: id(), number: z.string(), status: z.string() })
const style = output({ id: id(), code: z.string(), name: z.string() })
const text = (max: number) => z.string().trim().max(max)

const safetyView = output({
  state: z.enum(SAFETY_STATES),
  raisedAt: instant().nullable(),
  acknowledgedAt: instant().nullable(),
  acknowledgedById: id().nullable(),
})
const registerRef = output({ id: id(), reference: z.string(), status: z.string(), risk: z.enum(REGISTER_RISKS) })
const orderRef = output({ id: id(), number: z.string(), status: z.string(), currency: z.string(), netAmount: money.price(z.number().int()) })

/** One row of the list (design cmp-grid). */
export const complaintRow = output({
  id: id(),
  number: z.string(),
  companyId: id(),
  status,
  channel,
  receivedAt: instant(),
  party,
  customerRef: z.string().nullable(),
  order: orderRef.nullable(),
  shipment: numbered.nullable(),
  return: numbered.nullable(),
  style: style.nullable(),
  size: z.string().nullable(),
  serial: z.string().nullable(),
  batchNumber: z.string().nullable(),
  category: category.nullable(),
  severity: severity.nullable(),
  ownerId: id().nullable(),
  answerDueOn: businessDate().nullable(),
  answeredAt: instant().nullable(),
  safety: safetyView,
  /** Its PPE register entry (the register's own source link), with compliance.register.view only. */
  register: registerRef.nullable(),
  /** The NCRs raised from it or linked to it, with quality.ncr.view only. */
  ncrs: z.array(output({ id: id(), number: z.string(), stage: z.string() })),
  /** A short first line of the customer's words (the record has them whole). */
  summary: z.string(),
})

/** GET /quality/complaints/:complaintId — every tab of the record. */
export const complaintView = complaintRow.extend({
  description: z.string(),
  contact: output({ id: id(), name: z.string(), email: z.string().nullable() }).nullable(),
  style: output({ id: id(), code: z.string(), name: z.string(), ppeCategory: z.string() }).nullable(),
  /** Our garment that carries the serial: made on, its work order and batch, the shipment it left on, made for this customer. */
  garment: output({
    madeOn: businessDate(),
    workOrderNumber: z.string(),
    batchNumber: z.string().nullable(),
    shipment: output({ id: id(), number: z.string() }).nullable(),
    forThisCustomer: z.boolean(),
  }).nullable(),
  triagedAt: instant().nullable(),
  triagedById: id().nullable(),
  closedAt: instant().nullable(),
  closeReason: z.string().nullable(),
  internalNote: z.string().nullable(),
  createdAt: instant(),
  createdById: id().nullable(),
  version: z.number().int(),
  /** The repairs made from it (B-W2a-57), with sales.repairs.view only. */
  repairs: z.array(output({ id: id(), number: z.string(), stage: z.string() })),
  /** The garment's evidence trail (W1: /compliance/evidence/<kind>/<subject>): its serial, else its batch. */
  evidence: output({ kind: z.enum(['serial', 'batch']), subject: z.string() }).nullable(),
  /** The answer due a triage suggests: 10 working days of the company's calendar after it came in. */
  suggestedAnswerDueOn: businessDate().nullable(),
  actions: z.array(output({ action: z.enum(COMPLAINT_ACTIONS), allowed: z.boolean(), held: z.enum(HELD_CODES).nullable() })),
  people: z.array(person),
})

const oneComplaint = output({ complaint: complaintView })
const withWarnings = output({ complaint: complaintView, warnings: z.array(issue) })

// ---- the list and its tiles ---------------------------------------------------------------------------------------------

export const listContract = defineContract({
  querystring: input({
    /** A tile (a named saved filter) or another row: new | safety | dueSoon | open (default) | answeredMonth | closed | all. */
    view: z.enum(COMPLAINT_VIEWS).optional(),
    /** One status or a comma list; wins over `view`. */
    status: z.string().max(200).optional(),
    category: category.optional(),
    severity: severity.optional(),
    partyId: id().optional(),
    salesOrderId: id().optional(),
    shipmentId: id().optional(),
    returnId: id().optional(),
    /** me | a person's id. */
    owner: z.string().max(40).optional(),
    /** Number, customer code or name, their reference, serial or batch. */
    q: z.string().max(100).optional(),
    /** The `nextCursor` of the page before. */
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  }),
  response: {
    200: output({
      complaints: z.array(complaintRow),
      nextCursor: z.string().nullable(),
      people: z.array(person),
      asOf: instant(),
    }),
  },
})

export const countsContract = defineContract({
  response: {
    200: output({
      /** The tiles (design cmp-metrics): new to triage, safety open, answer due in 3 days (overdue too), open, answered this month. */
      tiles: output({ new: z.number().int(), safety: z.number().int(), dueSoon: z.number().int(), open: z.number().int(), answeredMonth: z.number().int() }),
      /** The safety banner (design cmp-safety): raised, not acknowledged by the owner, oldest first (at most 20; `more`). */
      safetyAlerts: z.array(
        output({
          id: id(),
          number: z.string(),
          summary: z.string(),
          style: style.nullable(),
          batchNumber: z.string().nullable(),
          serial: z.string().nullable(),
          raisedAt: instant(),
          version: z.number().int(),
        }),
      ),
      moreSafetyAlerts: z.number().int(),
      asOf: instant(),
    }),
  },
})

// ---- log one ------------------------------------------------------------------------------------------------------------

export const logBody = input({
  companyId: id(),
  partyId: id(),
  contactId: id().nullish(),
  customerRef: text(80).nullish(),
  channel: z.enum(OFFICE_CHANNELS),
  /** When it came in; default now. */
  receivedAt: instant().optional(),
  /** What happened, in the customer's words. */
  description: text(4000),
  salesOrderId: id().nullish(),
  shipmentId: id().nullish(),
  returnId: id().nullish(),
  /** The garment as reported: our serial gives its style, size and batch when they are left out. */
  styleId: id().nullish(),
  size: text(40).nullish(),
  serial: text(120).nullish(),
  batchNumber: text(120).nullish(),
  internalNote: text(4000).nullish(),
})

export const previewContract = defineContract({
  /** What the dialog has so far: a scanned serial alone finds the garment, the shipment it left on, its order and customer. */
  body: logBody.partial(),
  response: {
    200: output({
      ok: z.boolean(),
      problems: z.array(issue),
      warnings: z.array(issue),
      /** What the serial and the order found: the style, size, batch, the shipment it left on and the order. */
      draft: output({
        companyId: id().nullable(),
        partyId: id().nullable(),
        styleId: id().nullable(),
        size: z.string().nullable(),
        batchNumber: z.string().nullable(),
        shipmentId: id().nullable(),
        salesOrderId: id().nullable(),
      }),
      garment: output({ madeOn: businessDate(), workOrderNumber: z.string(), batchNumber: z.string().nullable(), shipment: output({ id: id(), number: z.string() }).nullable(), forThisCustomer: z.boolean() }).nullable(),
      /** The customer's other open complaints (a duplicate?), newest first. */
      others: z.array(output({ id: id(), number: z.string(), status, receivedAt: instant(), summary: z.string() })),
    }),
  },
})

export const logContract = defineContract({ body: logBody, response: { 201: withWarnings } })

/**
 * GET /quality/complaints/people?companyId= — the people of a company's complaints, read from their live roles now:
 * `owners` may follow one up (quality.complaints.manage there: the triage's owner picker); `told` are whom a safety alert
 * tells (QHS-115): who may acknowledge it (the owner) and who follows complaints up (quality). Office people only.
 */
export const peopleContract = defineContract({
  querystring: input({ companyId: id() }),
  response: {
    200: output({
      owners: z.array(person),
      told: z.array(output({ id: id(), name: z.string(), as: z.enum(['OWNER', 'QUALITY']) })),
    }),
  },
})

// ---- the record and its steps -------------------------------------------------------------------------------------------

export const getContract = defineContract({ params: complaintParams, response: { 200: oneComplaint } })

export const changeContract = defineContract({
  params: complaintParams,
  body: input({
    version,
    contactId: id().nullish(),
    customerRef: text(80).nullish(),
    channel: z.enum(OFFICE_CHANNELS).optional(),
    receivedAt: instant().optional(),
    description: text(4000).optional(),
    salesOrderId: id().nullish(),
    shipmentId: id().nullish(),
    returnId: id().nullish(),
    styleId: id().nullish(),
    size: text(40).nullish(),
    serial: text(120).nullish(),
    batchNumber: text(120).nullish(),
    internalNote: text(4000).nullish(),
  }),
  response: { 200: withWarnings },
})

export const triageContract = defineContract({
  params: complaintParams,
  body: input({
    version,
    category,
    severity,
    ownerId: id(),
    answerDueOn: businessDate(),
    /** The garment's style, when the complaint names none (a safety complaint needs it for the PPE register). */
    styleId: id().nullish(),
    /** A safety complaint's register entry: the risk as assessed now (default: being assessed). */
    risk: z.enum(['ASSESSING', 'YES']).optional(),
    note: text(2000).nullish(),
  }),
  response: { 200: output({ complaint: complaintView, safetyRaised: z.boolean(), register: output({ entryId: id(), reference: z.string(), opened: z.boolean() }).nullable() }) },
})

export const acknowledgeContract = defineContract({
  params: complaintParams,
  body: input({ version, note: text(2000).nullish() }),
  response: { 200: oneComplaint },
})

export const statusContract = defineContract({
  params: complaintParams,
  body: input({ version, to: z.enum(STATUS_MOVES), note: text(2000).nullish() }),
  response: { 200: oneComplaint },
})

export const closeContract = defineContract({
  params: complaintParams,
  body: input({ version, reason: text(1000) }),
  response: { 200: oneComplaint },
})

export const registerContract = defineContract({
  params: complaintParams,
  body: input({ version, risk: z.enum(['NO', 'ASSESSING', 'YES']).optional() }),
  response: { 200: output({ complaint: complaintView, register: output({ entryId: id(), reference: z.string(), opened: z.boolean() }) }) },
})
