import { z } from 'zod'
import { periodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import { businessDate, defineContract, id, input, instant, output, quantity, unitPrice } from '@nexus/factory-domain/core/contracts'
import { money } from '@nexus/factory-domain/money/marked'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { BALANCE_FLAGS, CONSUMPTION_KINDS } from '@nexus/factory-domain/purchasing/subcontract-depth/balance'
import { BUNDLE_STATES } from '@nexus/factory-domain/purchasing/subcontract-depth/bundles'
import { COST_KINDS } from '@nexus/factory-domain/purchasing/subcontract-depth/cost'
import { AGREEMENT_STATUSES } from '@nexus/factory-domain/purchasing/subcontract-depth/terms'
import { SUBCONTRACT_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/subcontracting/rules'

/**
 * Subcontracting in depth (B-W2b-331; SCM-049, SCM-143, SCM-144, SCM-145, SCM-146, SCM-150; design
 * purchasing.subcontracting: the written terms link, the Material balance and Cost tabs, days out, Balance open). Prices,
 * amounts and the cost bridge are costs, marked money.cost: the API drops them for a caller without the cost grain and
 * refuses a body that sends one. Quantities of material are decimal strings in their unit (four places); pieces whole.
 */

const version = () => z.number().int().min(1)
const orderParams = input({ subcontractOrderId: id() })
const agreementParams = input({ agreementId: id() })
const held = () => z.string().nullable()
const ref = output({ id: id(), code: z.string(), name: z.string() })
const reason = () => z.string().trim().min(1).max(2000)
const reasonCode = () => z.string().trim().min(1).max(40)
const flag = () => z.enum(['true', 'false']).transform((value) => value === 'true').optional()

// ---- the written terms (SCM-049) --------------------------------------------------------------------------------------

const agreementView = output({
  id: id(),
  revision: z.number().int(),
  title: z.string(),
  status: z.enum(AGREEMENT_STATUSES),
  company: ref,
  workshop: ref,
  validFrom: businessDate(),
  validUntil: businessDate().nullable(),
  signedAt: instant().nullable(),
  endedAt: instant().nullable(),
  endReason: z.string().nullable(),
  /** The signed terms (or the file the draft will be signed with); download it with GET /files/:fileId/download. */
  file: output({ id: id(), originalName: z.string(), contentType: z.string(), status: z.string(), availableAt: instant().nullable() }).nullable(),
  /** The revision that covers today. */
  inForceToday: z.boolean(),
  /** The revision in force ends within 30 days: in how many. */
  expiresInDays: z.number().int().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
  /** null: may be done now; else why not, in words. */
  actions: output({ edit: held(), delete: held(), sign: held(), terminate: held() }),
})
const oneAgreement = output({ agreement: agreementView })

export const listAgreementsContract = defineContract({
  querystring: input({ partyId: id().optional(), companyId: id().optional(), status: z.enum(AGREEMENT_STATUSES).optional() }),
  response: { 200: output({ items: z.array(agreementView) }) },
})
export const getAgreementContract = defineContract({ params: agreementParams, response: { 200: oneAgreement } })
export const createAgreementContract = defineContract({
  body: input({
    companyId: id(),
    partyId: id(),
    title: z.string().trim().min(1).max(200),
    validFrom: businessDate(),
    validUntil: businessDate().nullish(),
    /** The file it will be signed with (a file of this revision, uploaded later, or of the workshop). */
    termsFileId: id().nullish(),
  }),
  response: { 201: oneAgreement },
})
export const updateAgreementContract = defineContract({
  params: agreementParams,
  body: input({ version: version(), title: z.string().trim().min(1).max(200).optional(), validFrom: businessDate().optional(), validUntil: businessDate().nullish(), termsFileId: id().nullish() }),
  response: { 200: oneAgreement },
})
export const deleteAgreementContract = defineContract({ params: agreementParams, querystring: input({ version: z.coerce.number().int().min(1) }), response: { 200: output({ deleted: id() }) } })
export const signAgreementContract = defineContract({
  params: agreementParams,
  body: input({ version: version(), signedAt: instant().optional(), termsFileId: id().optional() }),
  response: { 200: oneAgreement },
})
export const terminateAgreementContract = defineContract({ params: agreementParams, body: input({ version: version(), endedAt: instant().optional(), reason: reason() }), response: { 200: oneAgreement } })
export const orderTermsContract = defineContract({
  params: orderParams,
  response: {
    200: output({
      order: output({ id: id(), number: z.string(), orderDate: businessDate(), companyId: id(), workshop: output({ id: id(), name: z.string() }) }),
      /** The signed revision whose days held the order's date; null: none. */
      covering: agreementView.nullable(),
      /** Why no written terms cover the order, in words (naming the law); null when they do. */
      words: z.string().nullable(),
      law: z.string(),
      revisions: z.array(agreementView),
    }),
  },
})

// ---- the material balance (SCM-143, SCM-144, TZ1:01) ------------------------------------------------------------------

const quantities = { used: quantity(), returned: quantity(), scrapped: quantity() }
const balanceLine = output({
  kitLineId: id(),
  seq: z.number().int(),
  item: ref,
  colour: ref.nullable(),
  lot: output({ id: id(), code: z.string() }).nullable(),
  hide: output({ id: id(), code: z.string() }).nullable(),
  uom: z.enum(UOMS),
  sentAt: instant().nullable(),
  sent: quantity(),
  ...quantities,
  /** sent − used − returned − scrapped: still out (a loss once the job is closed). */
  open: quantity(),
  /** The workshop counted less than was sent (negative), else null. */
  short: z.string().nullable(),
  flags: z.array(output({ flag: z.enum(BALANCE_FLAGS), words: z.string() })),
  /** The workshop's kit check (B-W2b-176). */
  checkedByWorkshop: output({ quantity: quantity(), at: instant().nullable(), note: z.string().nullable() }).nullable(),
  /** What the workshop's announced send-backs say comes back (B-W2b-176's material back). */
  announcedBack: quantity(),
  /** What came back into our places with the order's receipts. */
  backInOurPlaces: quantity(),
  /** Days the open rest has been out (since it was sent); null when nothing is open. */
  daysOut: z.number().int().nullable(),
  rows: z.array(
    output({
      id: id(),
      seq: z.number().int(),
      kind: z.enum(CONSUMPTION_KINDS),
      ...quantities,
      receipt: output({ id: id(), seq: z.number().int() }).nullable(),
      reportedAt: instant(),
      reasonCode: z.string().nullable(),
      reason: z.string().nullable(),
      bookedAt: instant(),
      bookedBy: z.string().nullable(),
    }),
  ),
  /** A declaration as it is expected now (what came back, the share of the pieces back): the office checks it. */
  suggestion: output(quantities),
  actions: output({ declare: held(), adjust: held() }),
})
const balanceView = output({
  order: output({ id: id(), number: z.string(), status: z.enum(SUBCONTRACT_ORDER_STATUSES), version: z.number().int(), allBack: z.boolean(), someBack: z.boolean() }),
  /** Every piece is back and material is still open. */
  balanceOpen: z.boolean(),
  lines: z.array(balanceLine),
  receipts: z.array(output({ id: id(), seq: z.number().int(), receivedAt: instant() })),
  actions: output({ declare: held(), adjust: held() }),
})
const booked = output({ rowIds: z.array(id()), moveIds: z.array(id()), ledger: output({ posted: z.number().int(), waiting: z.array(z.string()) }), balance: balanceView })

export const orderBalanceContract = defineContract({ params: orderParams, response: { 200: balanceView } })
export const declareBalanceContract = defineContract({
  params: orderParams,
  body: input({
    version: version(),
    /** The goods back it came with (a receipt of the order). */
    receiptId: id().nullish(),
    /** When the workshop reported it; default now. */
    reportedAt: instant().optional(),
    lines: z.array(input({ kitLineId: id(), ...quantities, reasonCode: reasonCode().nullish(), reason: reason().nullish() })).min(1).max(200),
    periodLockOverride: periodLockOverride.optional(),
  }),
  response: { 201: booked },
})
export const adjustBalanceContract = defineContract({
  params: orderParams,
  body: input({
    version: version(),
    kitLineId: id(),
    /** Signed changes in the line's unit: + more, − less. */
    used: z.string().regex(/^-?\d{1,14}(\.\d{1,4})?$/).optional(),
    returned: z.string().regex(/^-?\d{1,14}(\.\d{1,4})?$/).optional(),
    scrapped: z.string().regex(/^-?\d{1,14}(\.\d{1,4})?$/).optional(),
    reportedAt: instant().optional(),
    reasonCode: reasonCode().nullish(),
    reason: reason(),
    periodLockOverride: periodLockOverride.optional(),
  }),
  response: { 201: booked },
})

// ---- partial returns by bundle (SCM-145) ------------------------------------------------------------------------------

const bundleRow = output({
  bundle: output({ id: id(), code: z.string(), part: z.string().nullable(), workOrderSizeId: id().nullable(), colourway: z.string(), size: z.string() }),
  /** The garments it carried out. */
  garments: z.number().int(),
  sentAt: instant().nullable(),
  operations: z.array(output({ operationId: id(), seq: z.number().int(), code: z.string(), good: z.number().int(), defective: z.number().int(), scrapped: z.number().int(), back: z.number().int(), stillOut: z.number().int() })),
  state: z.enum(BUNDLE_STATES),
  receipts: z.array(output({ id: id(), seq: z.number().int(), receivedAt: instant() })),
})
export const orderBundlesContract = defineContract({
  params: orderParams,
  response: {
    200: output({
      order: output({ id: id(), number: z.string(), status: z.string(), version: z.number().int() }),
      /** The order's bundles out are on record: a receipt names only those. */
      onRecord: z.boolean(),
      bundles: z.array(bundleRow),
      /** Bundles that came back without a send on record (before W2b). */
      backWithoutSend: z.array(bundleRow),
      counts: output({ out: z.number().int(), partlyBack: z.number().int(), back: z.number().int() }),
    }),
  },
})

// ---- the cost on the work order (SCM-146) -----------------------------------------------------------------------------

const costView = output({
  order: output({ id: id(), number: z.string(), status: z.string(), currency: z.string(), workOrder: output({ id: id(), number: z.string(), currency: z.string() }) }),
  operations: z.array(
    output({
      id: id(),
      seq: z.number().int(),
      code: z.string(),
      name: z.string(),
      pricePerPiece: money.cost(z.string()),
      piecesBackGood: z.number().int(),
      waitingForInspection: z.number().int(),
      /** Pieces a FEE entry books at the workshop's price (they leave the earned fee). */
      bookedByFee: z.number().int(),
      /** Pieces a FEE entry may still book. */
      bookable: z.number().int(),
      /** The fee earned for the rest of the pieces back good (W2a's posting). */
      earnedFee: money.cost(z.number().int()),
    }),
  ),
  entries: z.array(
    output({
      id: id(),
      kind: z.enum(COST_KINDS),
      words: z.string(),
      operation: output({ id: id(), seq: z.number().int() }).nullable(),
      receipt: output({ id: id(), seq: z.number().int() }).nullable(),
      quantity: quantity(),
      unitPrice: money.cost(z.string()),
      amount: money.cost(z.number().int()),
      currency: z.string(),
      occurredAt: instant(),
      reason: z.string().nullable(),
      reversalOfId: id().nullable(),
      reversedById: id().nullable(),
      /** The work order's cost ledger holds it. */
      onWorkOrder: z.boolean(),
      createdAt: instant(),
    }),
  ),
  /** The bridge: earned fee + fees at the workshop's price + transport + material + other = the order's cost (minor units). */
  bridge: output({
    earnedFee: money.cost(z.number().int()),
    feeAtWorkshopPrice: money.cost(z.number().int()),
    transport: money.cost(z.number().int()),
    material: money.cost(z.number().int()),
    other: money.cost(z.number().int()),
    orderCost: money.cost(z.number().int()),
    currency: z.string(),
  }),
  /** What the work order's ledger holds of the order (SUBCONTRACT entries) and what waits, in words. */
  workOrder: output({ onLedger: money.cost(z.number().int()), entries: z.number().int(), waiting: z.array(z.string()) }),
  /** The subcontractor's invoice lines that bill the order (with payables.view; null without). */
  invoices: z
    .array(output({ invoiceId: id(), number: z.string(), status: z.string(), matchStatus: z.string(), currency: z.string(), seq: z.number().int(), description: z.string(), netAmount: money.cost(z.number().int()) }))
    .nullable(),
  actions: output({ book: held(), reverse: held() }),
})
const costBooked = output({ entryId: id(), ledger: output({ posted: z.number().int(), waiting: z.array(z.string()) }), view: costView })

export const orderCostContract = defineContract({ params: orderParams, response: { 200: costView } })
export const bookCostContract = defineContract({
  params: orderParams,
  body: input({
    version: version(),
    kind: z.enum(COST_KINDS),
    /** FEE: the operation of the order whose pieces it pays; another kind names none. */
    subcontractOperationId: id().nullish(),
    /** The goods back it came with (a receipt of the order). */
    receiptId: id().nullish(),
    /** FEE: whole pieces; another kind: how many (default 1). */
    quantity: quantity().optional(),
    /** In the order's currency; a FEE defaults to the operation's fee per piece. */
    unitPrice: money.cost(unitPrice()).optional(),
    occurredAt: instant().optional(),
    reason: reason().nullish(),
  }),
  response: { 201: costBooked },
})
export const reverseCostContract = defineContract({ params: input({ subcontractOrderId: id(), entryId: id() }), body: input({ version: version(), reason: reason() }), response: { 201: costBooked } })

// ---- days out and open balances (SCM-150, the Balance open tile) ------------------------------------------------------

export const ageingContract = defineContract({
  querystring: input({ siteId: id().optional(), partyId: id().optional(), locationId: id().optional(), itemId: id().optional() }),
  response: {
    200: output({
      asOf: businessDate(),
      longOutDays: z.number().int(),
      rows: z.array(
        output({
          site: output({ id: id(), code: z.string() }),
          workshop: ref,
          location: ref,
          item: output({ id: id(), code: z.string(), name: z.string(), baseUom: z.enum(UOMS) }),
          colour: ref.nullable(),
          lot: output({ id: id(), code: z.string() }).nullable(),
          hide: output({ id: id(), code: z.string() }).nullable(),
          /** In the item's base unit. */
          onHand: quantity(),
          /** Since when the oldest part still out is out, and its days out. */
          since: businessDate().nullable(),
          daysOut: z.number().int().nullable(),
          /** The quantities out per bucket of days (base unit). */
          buckets: output({ upTo30: quantity(), upTo60: quantity(), upTo90: quantity(), over90: quantity() }),
          longOut: z.boolean(),
        }),
      ),
      workshops: z.array(
        output({
          workshop: ref,
          location: ref,
          site: output({ id: id(), code: z.string() }),
          lines: z.number().int(),
          oldestDaysOut: z.number().int().nullable(),
          longOut: z.number().int(),
          linesPerBucket: output({ upTo30: z.number().int(), upTo60: z.number().int(), upTo90: z.number().int(), over90: z.number().int() }),
        }),
      ),
      truncated: z.boolean(),
    }),
  },
})

export const balancesContract = defineContract({
  querystring: input({ siteId: id().optional(), partyId: id().optional(), open: flag() }),
  response: {
    200: output({
      asOf: businessDate(),
      items: z.array(
        output({
          order: output({ id: id(), number: z.string(), status: z.enum(SUBCONTRACT_ORDER_STATUSES), version: z.number().int(), workshop: ref, workOrder: output({ id: id(), number: z.string() }) }),
          kitLines: z.number().int(),
          openLines: z.number().int(),
          /** The open rest per unit. */
          open: z.array(output({ uom: z.enum(UOMS), quantity: quantity() })),
          oldestSentAt: instant().nullable(),
          daysOut: z.number().int().nullable(),
          /** Every piece is back and material is still open. */
          balanceOpen: z.boolean(),
        }),
      ),
      /** The tiles: jobs back with material open (Balance open), jobs with material open, out longer than the long-out days. */
      counts: output({ balanceOpen: z.number().int(), open: z.number().int(), longOut: z.number().int() }),
    }),
  },
})
