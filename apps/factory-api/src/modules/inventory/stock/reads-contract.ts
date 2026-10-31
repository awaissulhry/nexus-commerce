import { z } from 'zod'
import { amountMinor, currency, defineContract, id, input, instant, output, unitPrice } from '@nexus/factory-domain/core/contracts'
import { ITEM_TRACKINGS, STOCK_MOVE_REASONS } from '@nexus/factory-domain/inventory/ledger/moves'
import { VALUATION_METHODS } from '@nexus/factory-domain/inventory/ledger/valuation'
import { LOT_QUALITY_STATUSES } from '@nexus/factory-domain/inventory/stock/overview'
import { money } from '@nexus/factory-domain/money/marked'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { reservationView } from '../reservations/contract'

/**
 * The warehouse screens' reads (A2 SCR-060 stock, SCR-064 movements, the Hides and Lots & traceability pages; design
 * warehouse.stock / warehouse.hides / warehouse.lots / warehouse.moves): every hide one by one, every lot with its
 * stock, tests and trace, the ledger with what the grid shows (names, documents, who posted, both clocks) and "why is it
 * this number" summed by reason. Office only, inventory.stock.view, read only: nothing here writes. Quantities are
 * decimal strings with four decimals in the item's base unit unless a `uom` names another. Values are marked with the
 * cost grain: a caller without it never receives them. A floor worker is never named in a list (Owner answer W1); one
 * record (a move, a hide's cut) names the worker only where the site records workers.
 */

const uom = z.enum(UOMS)
const named = output({ id: id(), code: z.string(), name: z.string() })
const item = output({ id: id(), code: z.string(), name: z.string(), baseUom: uom, tracking: z.enum(ITEM_TRACKINGS) })
const flag = () => z.enum(['true', 'false']).transform((value) => value === 'true')
const quality = z.enum(LOT_QUALITY_STATUSES)
const crViStatus = z.enum(['NOT_REQUIRED', 'PENDING', 'PASS', 'FAIL'])
// W2b (B-W2b-01): RETURNED, a hide sent back to the tannery.
const hideState = z.enum(['FULL', 'PARTLY_CUT', 'REMNANT', 'CONSUMED', 'SCRAPPED', 'RETURNED'])
/** One quantity in one unit (totals never add different units). */
const perUnit = output({ uom, quantity: z.string() })
const limit = (max: number, fallback: number) => z.coerce.number().int().min(1).max(max).default(fallback)

export const HIDE_STATES = hideState.options
export type HideState = z.infer<typeof hideState>

/** A lot as a hide or a stock row names it. */
const lotBrief = output({
  id: id(),
  code: z.string(),
  qualityStatus: quality,
  crViStatus,
  dyeBatch: z.string().nullable(),
  shade: z.string().nullable(),
})

// ---- hides ---------------------------------------------------------------------------------------------------------------

export const hideRow = output({
  id: id(),
  /** Our tag (the barcode on the hide). */
  code: z.string(),
  /** The tannery's own number on the hide. */
  supplierCode: z.string().nullable(),
  siteId: id(),
  companyId: id(),
  item,
  colour: named.nullable(),
  lot: lotBrief,
  grade: z.string().nullable(),
  shade: z.string().nullable(),
  thicknessMm: z.string().nullable(),
  defects: z.string().nullable(),
  /** As measured at receipt (never changed), in its unit of entry. */
  area: z.string(),
  areaUom: uom,
  /** The same area in the item's base unit. */
  baseArea: z.string(),
  /** What the ledger holds of it now, base unit (0 once issued whole to a work order, or consumed). */
  onHand: z.string(),
  /**
   * What is left of the leather, base unit: the stock on hand for a FULL hide or a REMNANT; for a PARTLY_CUT hide (issued
   * whole, at the cutting table) its measured area less what its cuts used and set aside; 0 once CONSUMED or SCRAPPED.
   */
  left: z.string(),
  state: hideState,
  /** Where its stock lies now; null when none is left. */
  location: named.nullable(),
  receivedAt: instant().nullable(),
  createdAt: instant(),
  /**
   * The ACTIVE reservation that holds this hide whole (B-W2a-64, design hd-grid "Reserved for (WO link)"): its demand, and
   * `stale` when that demand is done (it holds nothing any more: a person releases it); null when none.
   */
  reservedFor: output({ reservationId: id(), version: z.number().int(), demand: reservationView.shape.demand, stale: z.boolean() }).nullable(),
})
export type HideRow = z.infer<typeof hideRow>

const stateCount = output({ hides: z.number().int(), area: z.array(perUnit) })

export const listHidesContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    lotId: id().optional(),
    itemId: id().optional(),
    itemColourId: id().optional(),
    /** One state; `inStock` = FULL, PARTLY_CUT or REMNANT (the default view). */
    state: hideState.optional(),
    inStock: flag().optional(),
    /** Only hides an ACTIVE reservation holds whole (B-W2a-64, the Reserved view). */
    reserved: flag().optional(),
    /** The lot's quality status. */
    quality: quality.optional(),
    /** Hides whose stock lies at this location. */
    locationId: id().optional(),
    grade: z.string().trim().min(1).max(40).optional(),
    shade: z.string().trim().min(1).max(60).optional(),
    /** A tag, a tannery number or a lot code (a scanned tag finds its hide). */
    q: z.string().trim().min(1).max(80).optional(),
    cursor: id().optional(),
    limit: limit(200, 50),
  }),
  response: {
    200: output({
      hides: z.array(hideRow),
      nextCursor: id().nullable(),
      /**
       * The tiles (SCM-258: hides and area side by side), over the caller's hides at the site asked (no other filter): the
       * area is what is left (`left`), but for consumed hides their measured area.
       */
      counts: output({
        full: stateCount,
        partlyCut: stateCount,
        remnant: stateCount,
        quarantine: stateCount,
        consumed: stateCount,
        /** Hides in stock an ACTIVE reservation holds whole (B-W2a-64, the Reserved tile). */
        reserved: stateCount,
      }),
      /** The hides matching the filters: count and area left per unit. */
      matching: stateCount,
    }),
  },
})

const cutRow = output({
  id: id(),
  at: instant(),
  /** The tablet's clock when it came from the floor. */
  deviceTime: instant().nullable(),
  workOrder: output({ id: id(), number: z.string() }).nullable(),
  areaUsed: z.string(),
  remnantArea: z.string(),
  uom,
  baseAreaUsed: z.string(),
  baseRemnantArea: z.string(),
  pieces: z.number().int(),
  station: named.nullable(),
  device: output({ id: id(), name: z.string() }).nullable(),
  /** The worker who cut it: only where the site records workers (this one record), else null. */
  cutBy: z.string().nullable(),
  note: z.string().nullable(),
  reversalOfId: id().nullable(),
  reversedById: id().nullable(),
})

export const hideRecordContract = defineContract({
  params: input({ hideId: id() }),
  response: {
    200: output({
      hide: hideRow,
      lot: output({
        id: id(),
        code: z.string(),
        qualityStatus: quality,
        qualityNote: z.string().nullable(),
        crVi: output({ status: crViStatus, valueMgKg: z.string().nullable(), limitMgKg: z.string().nullable(), testedOn: z.string().nullable() }),
        supplier: named.nullable(),
        supplierLotRef: z.string().nullable(),
        receipt: output({ id: id(), number: z.string() }).nullable(),
      }),
      /** What happened to the area, base unit: measured, used by cuts (pieces and waste), set aside as remnants, on hand. */
      area: output({ measured: z.string(), cut: z.string(), remnant: z.string(), onHand: z.string(), uom }),
      cuts: z.array(cutRow),
      /** The site records the station only: no cut names a worker. */
      stationOnly: z.boolean(),
    }),
  },
})

// ---- lots ----------------------------------------------------------------------------------------------------------------

export const lotRow = output({
  id: id(),
  code: z.string(),
  companyId: id(),
  siteId: id(),
  siteCode: z.string(),
  item,
  colour: named.nullable(),
  supplier: named.nullable(),
  supplierLotRef: z.string().nullable(),
  dyeBatch: z.string().nullable(),
  shade: z.string().nullable(),
  receivedAt: instant().nullable(),
  /** The goods receipt it came with; null for opening stock. */
  receipt: output({ id: id(), number: z.string() }).nullable(),
  opening: z.boolean(),
  qualityStatus: quality,
  qualityNote: z.string().nullable(),
  qualityDecidedAt: instant().nullable(),
  crVi: output({
    required: z.boolean(),
    status: crViStatus,
    valueMgKg: z.string().nullable(),
    limitMgKg: z.string().nullable(),
    evidence: z.enum(['LOT_REPORT', 'SUPPLIER_REPORT']).nullable(),
    testedOn: z.string().nullable(),
  }),
  /** Active documents on the lot (certificates, statements, test reports). */
  documents: z.number().int(),
  /** On hand at the site, base unit; and the hides of it in stock (leather). */
  onHand: z.string(),
  hides: z.number().int(),
  /** The work orders it was issued to (issues less their reversals). */
  issuedTo: z.number().int(),
})
export type LotRow = z.infer<typeof lotRow>

export const listStockLotsContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    itemId: id().optional(),
    supplierId: id().optional(),
    quality: quality.optional(),
    /** QUARANTINE or BLOCKED. */
    onHold: flag().optional(),
    crVi: crViStatus.optional(),
    /** Only lots with stock on hand. */
    inStock: flag().optional(),
    /** Received at or after / before. */
    receivedFrom: instant().optional(),
    receivedTo: instant().optional(),
    /** A lot code, the supplier's lot or a dye batch (a scanned lot label finds it). */
    q: z.string().trim().min(1).max(80).optional(),
    cursor: id().optional(),
    limit: limit(200, 50),
  }),
  response: {
    200: output({
      lots: z.array(lotRow),
      nextCursor: id().nullable(),
      /** The tiles, over the caller's lots at the site asked (no other filter). */
      counts: output({
        quarantine: z.number().int(),
        waitingCrVi: z.number().int(),
        crViFailed: z.number().int(),
        blocked: z.number().int(),
        rejected: z.number().int(),
        released: z.number().int(),
      }),
    }),
  },
})

const traceWorkOrder = output({
  id: id(),
  number: z.string().nullable(),
  batchNumber: z.string().nullable(),
  status: z.string().nullable(),
  /** Base unit, issued less reversals; returned; still at the work order. */
  issued: z.string(),
  returned: z.string(),
  atWorkOrder: z.string(),
  hides: z.number().int(),
})

export const stockLotRecordContract = defineContract({
  params: input({ lotId: id() }),
  response: {
    200: output({
      lot: lotRow,
      /** Where it is: per location, on hand and held (the lot is not RELEASED) and its hides. */
      stock: z.array(output({ location: named, onHand: z.string(), held: z.string(), hides: z.number().int() })),
      hides: output({ inStock: z.number().int(), consumed: z.number().int(), scrapped: z.number().int() }),
      trace: output({
        /** Came from: the supplier, the purchase order line, the receipt and the supplier's DDT; opening stock has none. */
        backward: output({
          supplier: named.nullable(),
          receipt: output({ id: id(), number: z.string(), status: z.string(), receivedAt: instant(), supplierDdtNumber: z.string().nullable(), supplierDdtDate: z.string().nullable() }).nullable(),
          purchaseOrder: output({ id: id(), number: z.string(), lineSeq: z.number().int().nullable() }).nullable(),
        }),
        /** Went to: the work orders that took its stock, their shipments and the customers reached. */
        forward: output({
          workOrders: z.array(traceWorkOrder),
          shipments: z.array(output({ id: id(), number: z.string(), status: z.string(), customer: named.nullable(), garments: z.number().int() })),
          customers: z.number().int(),
        }),
      }),
      /** Moves naming the lot. */
      moves: z.number().int(),
    }),
  },
})

// ---- the ledger ----------------------------------------------------------------------------------------------------------

const side = output({
  /** LOCATION: a place of the site; else where it came from or went outside the site's stock. */
  kind: z.enum(['LOCATION', 'SUPPLIER', 'WORK_ORDER', 'OPENING', 'COUNT', 'ADJUSTMENT', 'SCRAP', 'OUTSIDE']),
  location: named.nullable(),
})

const postedBy = output({
  audience: z.enum(['OFFICE', 'FLOOR', 'SYSTEM']),
  /** The office user's name; null for a floor move (the list names the device, never a worker: Owner answer W1). */
  name: z.string().nullable(),
  device: output({ id: id(), name: z.string() }).nullable(),
})

const valuation = output({
  method: z.enum(VALUATION_METHODS),
  quantity: z.string(),
  unitCost: money.cost(unitPrice()),
  valueAmount: money.cost(amountMinor()),
  currency: currency(),
})

export const ledgerRow = output({
  id: id(),
  companyId: id(),
  siteId: id(),
  siteCode: z.string(),
  reason: z.enum(STOCK_MOVE_REASONS),
  /** When it happened (the tablet's clock for a floor move); `createdAt` is the server's. */
  occurredAt: instant(),
  createdAt: instant(),
  item,
  colour: named.nullable(),
  lot: output({ id: id(), code: z.string() }).nullable(),
  hide: output({ id: id(), code: z.string() }).nullable(),
  from: side,
  to: side,
  /** As entered, in `uom`. */
  quantity: z.string(),
  uom,
  baseQuantity: z.string(),
  /** Its effect on the stock asked for: the location's when one is filtered, else the site's (0 for a transfer). */
  delta: z.string(),
  /** The document behind it: a goods receipt or a work order (else the free reference). */
  document: output({ type: z.enum(['GoodsReceipt', 'WorkOrder']), id: id(), number: z.string() }).nullable(),
  reference: z.string().nullable(),
  note: z.string().nullable(),
  reversalOfId: id().nullable(),
  reversedById: id().nullable(),
  postedBy,
  /** Its value with the cost grain; null when it has none (a transfer, no cost basis, a floor move not valued yet). */
  valuation: money.cost(valuation.nullable()),
  /** B-W2a-11: a write-off's SCRAP move — its WRITE_OFF reason code, its note without the code, its write-off (the first move's id: its photos' record). */
  writeOff: output({ id: id(), reasonCode: z.string(), note: z.string().nullable() }).nullable(),
})
export type LedgerRow = z.infer<typeof ledgerRow>

export const ledgerContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    itemId: id().optional(),
    itemColourId: id().optional(),
    lotId: id().optional(),
    hideId: id().optional(),
    /** Moves into or out of this location (the delta is then the location's). */
    locationId: id().optional(),
    /** One or more reasons, comma separated. */
    reasons: z
      .string()
      .trim()
      .transform((value, context) => {
        const parts = value.split(',').map((part) => part.trim()).filter(Boolean)
        const bad = parts.filter((part) => !(STOCK_MOVE_REASONS as readonly string[]).includes(part))
        if (bad.length > 0) context.addIssue({ code: 'custom', message: `Not a reason: ${bad.join(', ')}.` })
        return parts as (typeof STOCK_MOVE_REASONS)[number][]
      })
      .optional(),
    /** Posted by this office user (stations: by `deviceId`). */
    createdById: id().optional(),
    deviceId: id().optional(),
    /** A goods receipt or a work order behind the moves. */
    documentId: id().optional(),
    hasNote: flag().optional(),
    /** true: only moves reversed or reversing; false: neither. */
    reversed: flag().optional(),
    from: instant().optional(),
    to: instant().optional(),
    /** B-W2a-11 (SCM-195): text or a scanned code — material code or name, lot, hide, location, work order or receipt number, reference, note. */
    q: z.string().trim().min(1).max(80).optional(),
    /** Only write-offs (true) or none of them (false). */
    writeOffs: flag().optional(),
    cursor: id().optional(),
    limit: limit(1000, 200),
  }),
  response: {
    200: output({
      moves: z.array(ledgerRow),
      nextCursor: id().nullable(),
      /** On the first page (no cursor): how many moves match, for the one long grid (Owner answer W2 B); null on the next pages. */
      rowCount: z.number().int().nullable(),
      /**
       * With one stock key (site and item; a colour, lot, hide or location narrow it) and no filter but `from`: the
       * balance now, so the running balance of each row is `closing` less the deltas of the rows above it (newest first).
       */
      closing: z.string().nullable(),
    }),
  },
})

export const ledgerCountsContract = defineContract({
  querystring: input({ siteId: id().optional() }),
  response: {
    200: output({
      adjustments7d: z.number().int(),
      scraps30d: z.number().int(),
      counts30d: z.number().int(),
      reversals30d: z.number().int(),
      /** B-W2a-11: write-offs (SCRAP moves of the write-off, not reversed) of 30 days. */
      writeOffs30d: z.number().int(),
      /** Moves into or out of the site's stock without a value yet: only with the cost grain (absent otherwise). */
      unvalued: money.cost(z.number().int()),
    }),
  },
})

export const ledgerMoveContract = defineContract({
  params: input({ moveId: id() }),
  response: {
    200: output({
      move: ledgerRow.extend({
        idempotencyKey: z.string(),
        receiptLineId: id().nullable(),
        workOrderId: id().nullable(),
        /** The worker, in this one record, only where the site records workers; else null. */
        worker: z.string().nullable(),
        stationOnly: z.boolean(),
      }),
      /** The move it reverses, or the one reversing it. */
      original: ledgerRow.nullable(),
      reversal: ledgerRow.nullable(),
    }),
  },
})

// ---- why is it this number ------------------------------------------------------------------------------------------------

export const explainContract = defineContract({
  querystring: input({
    siteId: id(),
    itemId: id(),
    itemColourId: id().optional(),
    lotId: id().optional(),
    hideId: id().optional(),
    /** The figure of one location; default the site's stock (transfers inside it net 0). */
    locationId: id().optional(),
    /** B-W2a-11 (SCM-197): the figure as it was at this instant (the moves that happened up to it). */
    asOf: instant().optional(),
  }),
  response: {
    200: output({
      siteId: id(),
      asOf: instant().nullable(),
      item,
      colour: named.nullable(),
      lot: output({ id: id(), code: z.string() }).nullable(),
      hide: output({ id: id(), code: z.string() }).nullable(),
      location: named.nullable(),
      /** The balance now (or as of `asOf`), from the located balances (what the stock page shows). */
      onHand: z.string(),
      /** Per reason: what came in, what went out, the net and how many moves. */
      byReason: z.array(output({ reason: z.enum(STOCK_MOVE_REASONS), in: z.string(), out: z.string(), net: z.string(), moves: z.number().int() })),
      /** The nets added up, and whether they equal the balance (a gap is a bug and says so). */
      sum: z.string(),
      addsUp: z.boolean(),
      gap: z.string(),
      moves: z.number().int(),
    }),
  },
})
