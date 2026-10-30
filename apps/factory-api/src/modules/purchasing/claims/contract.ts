import { z } from 'zod'
import { amountMinor, businessDate, defineContract, id, input, instant, output, quantity, unitPrice } from '@nexus/factory-domain/core/contracts'
import { DOCUMENT_LANGUAGES } from '@nexus/factory-domain/documents/model'
import { money } from '@nexus/factory-domain/money/marked'
import { ITEM_TRACKINGS } from '@nexus/factory-domain/product/materials/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { CLAIM_ACTIONS, CLAIM_FOUND_AT, CLAIM_KINDS, CLAIM_LIMITS, CLAIM_OUTCOMES, CLAIM_REMEDIES, CLAIM_STATUSES } from '@nexus/factory-domain/purchasing/claims/rules'
import { fileView } from '../../../platform/files/contract'
import { sourceRequest } from '../../shipping/ddt/contract'

/**
 * The supplier claims' contracts (B-W2a-44; SCM-134; design purchasing.claims SCR-131). The cost per base unit, the value
 * of the goods and the credit asked are costs: marked money.cost, so the API drops them for a caller without the cost
 * grain (the warehouse reads a claim without its value) and refuses a body that sends one. Quantities are decimal
 * strings in their unit (four places).
 */

const version = () => z.number().int().min(1)
const note = () => z.string().trim().max(CLAIM_LIMITS.note).nullish()
const claimParams = input({ claimId: id() })
const lineParams = input({ claimId: id(), lineId: id() })
const flag = () => z.enum(['true', 'false']).transform((value) => value === 'true').optional()
const status = z.enum(CLAIM_STATUSES)
const remedy = z.enum(CLAIM_REMEDIES)
const reasonCode = () => z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'Expected a reason code of the claim list.')

const ref = output({ id: id(), code: z.string() })
const named = output({ id: id(), code: z.string(), name: z.string() })

const summary = {
  id: id(),
  number: z.string(),
  kind: z.enum(CLAIM_KINDS),
  status,
  companyId: id(),
  site: ref,
  supplier: named,
  foundAt: z.enum(CLAIM_FOUND_AT),
  /** The reason: a code of the CLAIM list (null for a reason typed before the list) with its words, and the note. */
  reason: output({ code: z.string().nullable(), labelEn: z.string().nullable(), labelIt: z.string().nullable(), note: z.string().nullable() }),
  remedy: remedy.nullable(),
  lots: z.array(ref),
  materials: z.array(named),
  /** The lines' quantity added up when they share one unit (an area of leather in ft²); null otherwise. */
  quantity: output({ quantity: z.string(), uom: z.enum(UOMS) }).nullable(),
  lines: z.number().int(),
  /** Lines whose goods went back. */
  returned: z.number().int(),
  currency: z.string(),
  /** The value of the goods claimed (the lines' cost × quantity). */
  value: money.cost(z.number().int().nullable()),
  /** The credit asked: the lines' value, or the amount agreed with the supplier; null for a replacement. */
  expectedCreditAmount: money.cost(z.number().int().nullable()),
  /** Whole days since it was made. */
  ageDays: z.number().int(),
  sentAt: instant().nullable(),
  answeredAt: instant().nullable(),
  closedAt: instant().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
}
export const claimRow = output(summary)

const lineView = output({
  id: id(),
  seq: z.number().int(),
  item: output({ id: id(), code: z.string(), name: z.string(), baseUom: z.enum(UOMS), tracking: z.enum(ITEM_TRACKINGS) }),
  colour: named.nullable(),
  lot: output({ id: id(), code: z.string(), qualityStatus: z.string() }).nullable(),
  hide: ref.nullable(),
  discrepancy: output({ id: id(), seq: z.number().int(), kind: z.string(), status: z.string(), receiptId: id() }).nullable(),
  receiptLineId: id().nullable(),
  quantity: z.string(),
  uom: z.enum(UOMS),
  baseQuantity: z.string(),
  reason: z.string().nullable(),
  unitCost: money.cost(z.string().nullable()),
  creditAmount: money.cost(z.number().int().nullable()),
  /** The stock move that took the goods out (a return's line, once it went back). */
  move: output({ id: id(), reason: z.string(), occurredAt: instant(), quantity: z.string(), uom: z.enum(UOMS), fromLocation: ref.nullable() }).nullable(),
  /** The return DDT the line went with (set once). */
  ddt: output({ id: id(), number: z.string(), cancelled: z.boolean() }).nullable(),
  /** The live DDT that carries it now (a replacement after a cancel). */
  liveDdt: output({ id: id(), number: z.string() }).nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
})

const claimDetail = output({
  ...summary,
  goodsReceipt: output({ id: id(), number: z.string(), supplierDdtNumber: z.string().nullable(), supplierDdtDate: businessDate().nullable() }).nullable(),
  purchaseOrder: output({ id: id(), number: z.string() }).nullable(),
  supplierAnswer: z.string().nullable(),
  closeNote: z.string().nullable(),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  internalNote: z.string().nullable(),
  sentById: id().nullable(),
  createdById: id().nullable(),
  lines: z.array(lineView),
  /** The return DDTs, live and cancelled, with the claim lines each carries (Goods returned, Return DDT (PDF)). */
  ddts: z.array(output({ id: id(), number: z.string(), documentDate: businessDate(), reason: z.string(), startAt: instant(), cancelled: z.boolean(), lineIds: z.array(id()) })),
  credit: output({
    currency: z.string(),
    remedy: remedy.nullable(),
    expected: money.cost(z.number().int().nullable()),
    value: money.cost(z.number().int().nullable()),
    /** The supplier's credit note matched to the claim (Finance, B-W2a-62): none yet. */
    matched: z.null(),
    difference: z.null(),
  }),
  /** Each action: null = allowed now, else why not in words. */
  actions: output(Object.fromEntries(CLAIM_ACTIONS.map((action) => [action, z.string().nullable()])) as Record<(typeof CLAIM_ACTIONS)[number], z.ZodNullable<z.ZodString>>),
  people: z.array(output({ id: id(), name: z.string() })),
})
const one = output({ claim: claimDetail })

export const listClaimsContract = defineContract({
  querystring: input({
    status: status.optional(),
    /** Default true: the claims not settled yet; false: every state. */
    open: flag(),
    kind: z.enum(CLAIM_KINDS).optional(),
    partyId: id().optional(),
    siteId: id().optional(),
    /** The claims about a lot (the lot record's opener). */
    lotId: id().optional(),
    goodsReceiptId: id().optional(),
    q: z.string().trim().min(1).max(100).optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: { 200: output({ items: z.array(claimRow), nextCursor: id().nullable() }) },
})

export const claimCountsContract = defineContract({
  querystring: input({ siteId: id().optional(), partyId: id().optional() }),
  response: { 200: output({ open: z.number().int(), waitingForSupplier: z.number().int(), creditExpected: z.number().int(), closedThisMonth: z.number().int() }) },
})

export const getClaimContract = defineContract({ params: claimParams, response: { 200: one } })

const lineInput = input({
  /** The receipt discrepancy the line pursues (its receipt line and how much are the defaults). */
  discrepancyId: id().optional(),
  receiptLineId: id().optional(),
  itemId: id().optional(),
  itemColourId: id().nullish(),
  lotId: id().nullish(),
  hideId: id().nullish(),
  /** Default the discrepancy's, else what the hide or the lot holds at the site. */
  quantity: quantity().optional(),
  /** Default the material's base unit. */
  uom: z.enum(UOMS).optional(),
  baseQuantity: quantity().optional(),
  reason: z.string().trim().max(CLAIM_LIMITS.reasonNote).nullish(),
  /** The cost per base unit the credit is asked at; default the lot's. */
  unitCost: money.cost(unitPrice().nullish()),
  note: note(),
})
const returnLineInput = lineInput.extend({ /** Where its goods leave from; default the one place that holds them. */ fromLocationId: id().optional() })
const from = input({
  /** Discrepancies of one receipt: one line each. */
  discrepancyIds: z.array(id()).min(1).max(CLAIM_LIMITS.lines).optional(),
  /** A lot: every hide of it in stock (or the hides named), or its stock per place. */
  lotId: id().optional(),
  hideIds: z.array(id()).min(1).max(CLAIM_LIMITS.lines).optional(),
})
const header = {
  /** Default: the lines' supplier. */
  partyId: id().optional(),
  /** Default: the lines' site. */
  siteId: id().optional(),
  /** Default: the receipt every line came on; null: none. */
  goodsReceiptId: id().nullish(),
  /** Default: the receipt's order; null: none. */
  purchaseOrderId: id().nullish(),
  /** Default: RECEIPT for discrepancies, else from the lot's quality state (quarantine: RECEIPT, rejected or blocked: INSPECTION, else STOCK). */
  foundAt: z.enum(CLAIM_FOUND_AT).optional(),
  reasonCode: reasonCode(),
  reasonNote: z.string().trim().max(CLAIM_LIMITS.reasonNote).nullish(),
  internalNote: note(),
  from: from.optional(),
}

export const createClaimContract = defineContract({
  body: input({
    kind: z.enum(CLAIM_KINDS),
    ...header,
    /** Default a credit; null: choose it before the claim is sent. */
    remedy: remedy.nullish(),
    lines: z.array(lineInput).max(CLAIM_LIMITS.lines).default([]),
  }),
  response: { 201: one },
})

export const updateClaimContract = defineContract({
  params: claimParams,
  body: input({
    version: version(),
    kind: z.enum(CLAIM_KINDS).optional(),
    foundAt: z.enum(CLAIM_FOUND_AT).optional(),
    reasonCode: reasonCode().optional(),
    reasonNote: z.string().trim().max(CLAIM_LIMITS.reasonNote).nullish(),
    remedy: remedy.nullish(),
    goodsReceiptId: id().nullish(),
    purchaseOrderId: id().nullish(),
    /** The credit asked: the amount agreed with the supplier (minor units); null: none. */
    expectedCreditAmount: money.cost(amountMinor().refine((value) => value >= 0, 'Expected 0 or more.').nullable()),
    internalNote: note(),
  }),
  response: { 200: one },
})

export const addLinesContract = defineContract({
  params: claimParams,
  body: input({ version: version(), from: from.optional(), lines: z.array(lineInput).max(CLAIM_LIMITS.lines).default([]) }),
  response: { 201: one },
})
export const editLineContract = defineContract({
  params: lineParams,
  body: input({ version: version(), quantity: quantity().optional(), uom: z.enum(UOMS).optional(), baseQuantity: quantity().optional(), reason: z.string().trim().max(CLAIM_LIMITS.reasonNote).nullish(), unitCost: money.cost(unitPrice().nullish()), note: note() }),
  response: { 200: one },
})
export const removeLineContract = defineContract({ params: lineParams, querystring: input({ version: z.coerce.number().int().min(1) }), response: { 200: one } })

const mailInput = input({
  contactIds: z.array(id()).min(1).max(CLAIM_LIMITS.recipients),
  cc: z.array(z.email().max(254)).max(CLAIM_LIMITS.recipients).optional(),
  subject: z.string().trim().max(200).nullish(),
  /** The office's own words in place of the standard text. */
  message: z.string().trim().max(4000).nullish(),
  language: z.enum(DOCUMENT_LANGUAGES).optional(),
})

export const sendCheckContract = defineContract({
  params: claimParams,
  response: {
    200: output({
      ready: z.boolean(),
      problems: z.array(output({ path: z.string(), message: z.string() })),
      recipients: z.array(output({ contactId: id(), name: z.string(), email: z.string(), roles: z.array(z.string()), language: z.string().nullable(), suggested: z.boolean() })),
      language: z.enum(DOCUMENT_LANGUAGES),
      subject: z.string(),
      message: z.string(),
    }),
  },
})

export const sendClaimContract = defineContract({
  params: claimParams,
  body: input({
    version: version(),
    /** Chosen now when it was not (a sent claim asks for a credit or a replacement). */
    remedy: remedy.optional(),
    /** The claim by e-mail on its thread; null: the supplier was told another way (the goods travel with the return DDT). */
    mail: mailInput.nullable(),
  }),
  response: { 200: output({ claim: claimDetail, emailId: id().nullable() }) },
})

export const answerClaimContract = defineContract({
  params: claimParams,
  body: input({
    version: version(),
    outcome: z.enum(CLAIM_OUTCOMES),
    /** What the supplier said. */
    answer: z.string().trim().min(1).max(CLAIM_LIMITS.answer),
    remedy: remedy.optional(),
    /** The credit agreed (minor units); default the lines' value for a credit. */
    expectedCreditAmount: money.cost(amountMinor().refine((value) => value >= 0, 'Expected 0 or more.').nullable()),
  }),
  response: { 200: one },
})

export const closeClaimContract = defineContract({ params: claimParams, body: input({ version: version(), note: z.string().trim().min(3).max(CLAIM_LIMITS.note) }), response: { 200: one } })
export const cancelClaimContract = defineContract({ params: claimParams, body: input({ version: version(), reason: z.string().trim().min(3).max(500) }), response: { 200: one } })

const returnDdt = sourceRequest.omit({ version: true, lineIds: true })
const returnAnswer = output({
  claim: claimDetail,
  moveIds: z.array(id()),
  ddt: output({ id: id(), number: z.string(), file: fileView.nullable(), pdfProblem: z.string().nullable() }),
  /** Lines that keep a cancelled DDT in their column (set once): this DDT names them in its lines. */
  claimLinesKeepingOldDdt: z.array(id()),
  /** What the return leaves over-reserved (the reservations stay). */
  overReserved: z.array(output({ itemId: id(), itemColourId: id().nullable(), available: z.string(), reserved: z.string() })),
})

export const returnGoodsContract = defineContract({
  params: claimParams,
  body: input({
    version: version(),
    /** The lines that go now (default every line not gone yet, from where it lies). */
    lines: z.array(input({ lineId: id(), fromLocationId: id().optional() })).min(1).max(CLAIM_LIMITS.lines).optional(),
    /** The return DDT the goods travel with (B-W2a-17's request: who carries them, packages, gross weight …). */
    ddt: returnDdt,
  }),
  response: { 201: returnAnswer },
})

export const returnToSupplierContract = defineContract({
  body: input({
    ...header,
    remedy: remedy.optional(),
    lines: z.array(returnLineInput).max(CLAIM_LIMITS.lines).default([]),
    /** The claim by e-mail to the supplier's contacts; null or missing: none (the goods and their DDT tell it). */
    mail: mailInput.nullish(),
    ddt: returnDdt,
  }),
  response: { 201: returnAnswer },
})
