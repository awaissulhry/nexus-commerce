import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { REPAIR_KINDS } from '@nexus/factory-domain/sales/repairs/rules'
import { RETURN_LIMITS } from '@nexus/factory-domain/sales/returns/rules'
import {
  BUYER_KINDS,
  CASE_ACTIONS,
  CASE_CHANNELS,
  CASE_KINDS,
  CASE_LIMITS,
  CASE_PRIORITIES,
  CASE_STATUSES,
  CASE_VIEWS,
  CASE_WISHES,
  COVER_DECISIONS,
  COVER_STATES,
  COVERS,
  GUARANTEE_STATES,
  HELD_CODES,
  LINK_RECORD_TYPES,
  MOVE_TARGETS,
  OFFICE_CASE_CHANNELS,
  RETURN_PURPOSES,
} from '@nexus/factory-domain/sales/service/rules'

/**
 * Warranty and service cases (B-W2b-345; SAL-368, SAL-436; design sales.service). No amount anywhere (a case holds none; the
 * records it links show their numbers and statuses). Every write takes an Idempotency-Key and the case's `version`. Refusals
 * in words: `body/<field>` (400), a step its status does not take (409 invalid_state, the held code in `issues[0].path` =
 * `held/<CODE>`), a stale version (409 conflict). Office people by id, their names in `people`.
 */

const version = z.number().int().min(1)
const issue = output({ path: z.string(), message: z.string() })
const caseParams = input({ caseId: id() })
const person = output({ id: id(), name: z.string() })
const party = output({ id: id(), code: z.string(), legalName: z.string() })
const style = output({ id: id(), code: z.string(), name: z.string() })
const text = (max: number) => z.string().trim().max(max)

/** One row of the list (design service.grid). */
export const caseRow = output({
  id: id(),
  number: z.string(),
  companyId: id(),
  kind: z.enum(CASE_KINDS),
  channel: z.enum(CASE_CHANNELS),
  status: z.enum(CASE_STATUSES),
  priority: z.enum(CASE_PRIORITIES),
  /** The customer or dealer; null: a rider named in the case's words. */
  party: party.nullable(),
  /** The serial and batch as typed or read from the label, and the serial and batch of ours they are (null: not ours). */
  serial: z.string().nullable(),
  garmentSerial: z.string().nullable(),
  batchNumber: z.string().nullable(),
  garmentBatch: z.string().nullable(),
  style: style.nullable(),
  size: z.string().nullable(),
  customerWants: z.enum(CASE_WISHES).nullable(),
  /** The Cover column: the decided cover, else what the warranty check points to (UNKNOWN: no delivery day yet). */
  cover: output({ state: z.enum(COVER_STATES), decided: z.boolean(), decision: z.enum(COVER_DECISIONS).nullable() }),
  openedAt: instant(),
  ownerId: id().nullable(),
  notifyCustomer: z.boolean(),
  links: z.number().int(),
  /** A short first line of the customer's words (the record has them whole). */
  summary: z.string(),
  version: z.number().int(),
})

const reading = output({ state: z.enum(GUARANTEE_STATES), endsOn: businessDate().nullable(), daysLeft: z.number().int().nullable(), words: z.string() })

/** The warranty check (design case.warranty: "Legal 2-year guarantee or factory warranty, with why"). */
export const warrantyCheck = output({
  buyer: z.enum(BUYER_KINDS),
  deliveredOn: businessDate().nullable(),
  legal: reading,
  factory: reading,
  presumption: output({ applies: z.boolean(), until: businessDate().nullable(), words: z.string() }).nullable(),
  suggested: z.enum(COVERS).nullable(),
  state: z.enum(COVER_STATES),
  remedies: z.string(),
  liable: z.string(),
  words: z.array(z.string()),
})

const shipmentRef = output({ id: id(), number: z.string(), partyId: id(), day: businessDate().nullable(), delivered: z.boolean() })

/** Our garment the serial names, and our batch (the work order and its deliveries). */
export const garmentView = output({
  serial: output({
    serial: z.string(),
    madeOn: businessDate(),
    workOrderNumber: z.string(),
    batchNumber: z.string().nullable(),
    madeForPartyId: id().nullable(),
    salesOrderId: id().nullable(),
    shipment: shipmentRef.nullable(),
  }).nullable(),
  batch: output({ batchNumber: z.string(), workOrderNumber: z.string(), deliveries: z.array(shipmentRef) }).nullable(),
})

const linkView = output({
  id: id(),
  recordType: z.string(),
  recordId: id(),
  note: z.string().nullable(),
  createdAt: instant(),
  createdById: id().nullable(),
  /** The record's number and status for a reader of it; null: one the reader may not open. */
  record: output({ label: z.string(), status: z.string().nullable() }).nullable(),
})

/** GET /sales/service/cases/:caseId — every tab of the record (Case, Warranty check, Linked records, Actions; Activity is the thread). */
export const caseView = caseRow.extend({
  party: output({ id: id(), code: z.string(), legalName: z.string(), kind: z.string() }).nullable(),
  /** The contact who wrote; `email` only while they may get mail (active, not erased). */
  contact: output({ id: id(), name: z.string(), email: z.string().nullable(), language: z.string().nullable() }).nullable(),
  style: output({ id: id(), code: z.string(), name: z.string(), ppeCategory: z.string() }).nullable(),
  colourway: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  problem: z.string(),
  garment: garmentView,
  warranty: output({
    deliveredOn: businessDate().nullable(),
    legalGuaranteeEndsOn: businessDate().nullable(),
    factoryGuaranteeEndsOn: businessDate().nullable(),
    suggestedDeliveredOn: businessDate().nullable(),
    check: warrantyCheck,
    decided: output({ cover: z.enum(COVERS), decision: z.enum(COVER_DECISIONS), note: z.string(), at: instant(), byId: id().nullable(), remedies: z.string() }).nullable(),
  }),
  resolution: output({ at: instant(), words: z.string() }).nullable(),
  closed: output({ at: instant(), byId: id().nullable(), reason: z.string().nullable() }).nullable(),
  internalNote: z.string().nullable(),
  createdAt: instant(),
  createdById: id().nullable(),
  links: z.array(linkView),
  /** The mails sent on the case's thread (the status mails, SAL-436), newest first, with where each one is. */
  mails: z.array(output({ id: id(), subject: z.string(), status: z.string(), to: z.array(z.string()), queuedAt: instant(), sentAt: instant().nullable(), deliveredAt: instant().nullable(), failedAt: instant().nullable(), sentById: id().nullable() })),
  actions: z.array(output({ action: z.enum(CASE_ACTIONS), allowed: z.boolean(), held: z.enum(HELD_CODES).nullable() })),
  people: z.array(person),
})

const oneCase = output({ case: caseView })
const withWarnings = output({ case: caseView, warnings: z.array(issue) })

// ---- the list and its tiles ---------------------------------------------------------------------------------------------

export const listContract = defineContract({
  querystring: input({
    /** A saved row or a tile: open (default) | new | waitingCustomer | waitingPart | waiting | mine | closed | all. */
    view: z.enum(CASE_VIEWS).optional(),
    /** One status or a comma list; wins over `view`. */
    status: z.string().max(200).optional(),
    kind: z.enum(CASE_KINDS).optional(),
    cover: z.enum(COVER_STATES).optional(),
    partyId: id().optional(),
    /** me | a person's id. */
    owner: z.string().max(40).optional(),
    /** A garment's cases: its serial as typed or ours. */
    serial: z.string().max(CASE_LIMITS.label).optional(),
    /** The cases a record is linked to: <RecordType>:<id>. */
    linked: z.string().max(80).optional(),
    /** Number, serial, batch, customer code or name. */
    q: z.string().max(100).optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(CASE_LIMITS.list).optional(),
  }),
  response: { 200: output({ cases: z.array(caseRow), nextCursor: z.string().nullable(), people: z.array(person), asOf: instant() }) },
})

export const countsContract = defineContract({
  response: {
    200: output({
      /** The tiles (design service.tiles): new, waiting for the customer, waiting for a part. */
      tiles: output({ new: z.number().int(), waitingCustomer: z.number().int(), waitingPart: z.number().int() }),
      /** The saved rows' totals (Open · Mine · Waiting · Closed · All). */
      rows: output({ open: z.number().int(), mine: z.number().int(), waiting: z.number().int(), closed: z.number().int(), all: z.number().int() }),
      asOf: instant(),
    }),
  },
})

export const peopleContract = defineContract({
  querystring: input({ companyId: id() }),
  /** Who may own a case of the company (sales.service.manage there, from their live roles now). */
  response: { 200: output({ owners: z.array(person) }) },
})

// ---- open one -----------------------------------------------------------------------------------------------------------

export const openBody = input({
  companyId: id(),
  kind: z.enum(CASE_KINDS),
  channel: z.enum(OFFICE_CASE_CHANNELS),
  partyId: id().nullish(),
  contactId: id().nullish(),
  /** The serial as typed or scanned: ours gives the style, colourway, size, batch and delivery day. */
  serial: text(CASE_LIMITS.label).nullish(),
  batchNumber: text(CASE_LIMITS.label).nullish(),
  styleId: id().nullish(),
  colourwayId: id().nullish(),
  size: text(CASE_LIMITS.size).nullish(),
  /** What the customer reports, in their words. */
  problem: z.string().max(CASE_LIMITS.problem * 2),
  customerWants: z.enum(CASE_WISHES).nullish(),
  priority: z.enum(CASE_PRIORITIES).optional(),
  ownerId: id().nullish(),
  /** Left out: from our records (the serial's shipment); null: not known. */
  deliveredOn: businessDate().nullish(),
  /** Left out: 2 years from delivery for a consumer we sold to. */
  legalGuaranteeEndsOn: businessDate().nullish(),
  factoryGuaranteeEndsOn: businessDate().nullish(),
  /** Tell the customer at each status change (default off; needs a contact with an e-mail). */
  notifyCustomer: z.boolean().optional(),
  internalNote: z.string().max(CASE_LIMITS.internalNote * 2).nullish(),
})

export const previewContract = defineContract({
  body: openBody.partial(),
  response: {
    200: output({
      ok: z.boolean(),
      problems: z.array(issue),
      warnings: z.array(issue),
      /** What the serial, the batch and the customer give the case (the dialog fills the fields left empty). */
      draft: output({
        styleId: id().nullable(),
        colourwayId: id().nullable(),
        size: z.string().nullable(),
        batchNumber: z.string().nullable(),
        garmentSerial: z.string().nullable(),
        garmentBatch: z.string().nullable(),
        partyId: id().nullable(),
        deliveredOn: businessDate().nullable(),
        legalGuaranteeEndsOn: businessDate().nullable(),
        factoryGuaranteeEndsOn: businessDate().nullable(),
      }),
      garment: garmentView,
      warranty: warrantyCheck,
      /** The other open cases of the same garment or batch (a duplicate?), newest first. */
      others: z.array(output({ id: id(), number: z.string(), status: z.enum(CASE_STATUSES), kind: z.enum(CASE_KINDS), openedAt: instant() })),
    }),
  },
})

export const openContract = defineContract({ body: openBody, response: { 201: withWarnings } })

// ---- the record and its steps -------------------------------------------------------------------------------------------

export const getContract = defineContract({ params: caseParams, response: { 200: oneCase } })

export const changeContract = defineContract({
  params: caseParams,
  body: input({
    version,
    kind: z.enum(CASE_KINDS).optional(),
    partyId: id().nullish(),
    contactId: id().nullish(),
    serial: text(CASE_LIMITS.label).nullish(),
    batchNumber: text(CASE_LIMITS.label).nullish(),
    styleId: id().nullish(),
    colourwayId: id().nullish(),
    size: text(CASE_LIMITS.size).nullish(),
    problem: z.string().max(CASE_LIMITS.problem * 2).optional(),
    customerWants: z.enum(CASE_WISHES).nullish(),
    priority: z.enum(CASE_PRIORITIES).optional(),
    ownerId: id().nullish(),
    deliveredOn: businessDate().nullish(),
    legalGuaranteeEndsOn: businessDate().nullish(),
    factoryGuaranteeEndsOn: businessDate().nullish(),
    notifyCustomer: z.boolean().optional(),
    internalNote: z.string().max(CASE_LIMITS.internalNote * 2).nullish(),
  }),
  response: { 200: withWarnings },
})

/** The decision (design case.warranty "Decide: covered / partly / not covered"), ONE update; decided again replaces it. */
export const coverContract = defineContract({
  params: caseParams,
  body: input({ version, cover: z.enum(COVERS), decision: z.enum(COVER_DECISIONS), note: z.string().max(CASE_LIMITS.coverNote * 2) }),
  response: { 200: withWarnings },
})

const notified = z.union([
  output({ sent: z.literal(true), emailId: id(), to: z.string(), subject: z.string() }),
  output({ sent: z.literal(false), reason: z.enum(['NO_CONTACT_EMAIL', 'NOT_SENT']), words: z.string() }),
])

export const statusContract = defineContract({
  params: caseParams,
  body: input({
    version,
    to: z.enum(MOVE_TARGETS),
    resolution: z.string().max(CASE_LIMITS.resolution * 2).nullish(),
    reason: z.string().max(CASE_LIMITS.closeReason * 2).nullish(),
    /** Words for the customer with this move's status mail (only when the case tells the customer). */
    message: z.string().max(CASE_LIMITS.message * 2).nullish(),
  }),
  /** `notified`: the status mail of this move (null: the case does not tell the customer). */
  response: { 200: output({ case: caseView, notified: notified.nullable(), warnings: z.array(issue) }) },
})

// ---- links and the actions that open records ------------------------------------------------------------------------------

export const linkContract = defineContract({
  params: caseParams,
  body: input({ version, recordType: z.enum(LINK_RECORD_TYPES), recordId: id(), note: z.string().max(CASE_LIMITS.linkNote * 2).nullish() }),
  response: { 200: oneCase },
})

export const unlinkContract = defineContract({
  params: input({ caseId: id(), linkId: id() }),
  querystring: input({ version: z.coerce.number().int().min(1) }),
  response: { 200: oneCase },
})

export const repairContract = defineContract({
  params: caseParams,
  body: input({
    version,
    siteId: id().optional(),
    kind: z.enum(REPAIR_KINDS).optional(),
    /** The repair's words (default: the case's problem; a repair's hold 2000 characters). */
    problem: z.string().max(4000).optional(),
    workWanted: z.string().max(4000).nullish(),
    ownerId: id().nullish(),
    /** The garment came with the customer: received now (or at), with the customer's DDT. */
    received: input({ at: instant().optional(), inboundDdtNumber: z.string().max(80).nullish(), inboundDdtDate: businessDate().nullish() }).nullish(),
  }),
  response: { 201: output({ case: caseView, repair: output({ id: id(), number: z.string() }), warnings: z.array(issue) }) },
})

/** A line as W2a's RMA takes it (modules/sales/returns contract newLine). */
const returnLine = input({
  invoiceLineId: id().nullish(),
  salesOrderLineId: id().nullish(),
  size: z.string().trim().max(10).nullish(),
  quantity: z.number().int().min(1).max(100_000),
  reasonCode: z.string().min(1).max(40),
  reasonNote: text(RETURN_LIMITS.reasonNote).nullish(),
  serial: text(RETURN_LIMITS.serial).nullish(),
  batchNumber: text(RETURN_LIMITS.batchNumber).nullish(),
  description: text(RETURN_LIMITS.description).nullish(),
})

export const returnContract = defineContract({
  params: caseParams,
  body: input({
    version,
    purpose: z.enum(RETURN_PURPOSES),
    /** The lines that come back; left out: the case's garment, one piece of the order line its serial left on. */
    lines: z.array(returnLine).min(1).max(50).optional(),
    /** The return reason of the case's garment line (with no `lines`). */
    reasonCode: z.string().min(1).max(40).optional(),
    /** REMAKE: what is wrong with the fit. */
    fit: z.string().max(4000).optional(),
    siteId: id().optional(),
    customerRef: text(RETURN_LIMITS.customerRef).nullish(),
    goodsDueBy: businessDate().nullish(),
    internalNote: text(RETURN_LIMITS.internalNote).nullish(),
  }),
  response: { 201: output({ case: caseView, return: output({ id: id(), number: z.string() }), next: z.string(), warnings: z.array(issue) }) },
})
