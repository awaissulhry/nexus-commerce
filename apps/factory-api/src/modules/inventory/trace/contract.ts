import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { TRACE_DIRECTIONS, TRACE_GAP_CODES, TRACE_GAP_SEVERITIES, TRACE_LINKS, TRACE_NODE_KINDS, TRACE_REACHES, TRACE_SIDES, TRACE_START_KINDS } from '@nexus/factory-domain/inventory/trace/rules'

/**
 * The trace both ways (B-W2a-27; SCM-240 backward, SCM-241 forward; design warehouse.lots lt-trace (the dialog: one
 * field, any code) and lt-trace-tree (levels with counts, arrow keys, "Show only affected customers")). Office only,
 * inventory.stock.view on the start's company and site; read only: nothing here writes, nothing is stored. No cost,
 * price, margin or wage is read or answered; no worker is named. A supplier's, customer's or workshop's name only with
 * parties.view on that party; a record at a site the caller's grants do not reach is counted, never shown
 * (`restricted`). Quantities are decimal strings in the unit `uom` names (garments: PCS).
 */

export const TRACE_MATCHES = [
  'LOT_CODE',
  'SUPPLIER_LOT',
  'DYE_BATCH',
  'HIDE_TAG',
  'TANNERY_NUMBER',
  'BUNDLE_TICKET',
  'OLD_BUNDLE_TICKET',
  'SERIAL',
  'BATCH_NUMBER',
  'WORK_ORDER_NUMBER',
  'SHIPMENT_NUMBER',
  'DDT_NUMBER',
] as const

export const traceFindContract = defineContract({
  querystring: input({
    /** Scanned or typed: a garment serial, a batch number, a bundle ticket (also an old one), a hide tag, a lot, a work order, shipment or DDT number. */
    code: z.string().trim().min(1).max(80),
  }),
  response: {
    200: output({
      code: z.string(),
      /** Every record the code names that the caller may trace, best match first. Empty: nothing found. */
      matches: z.array(output({ kind: z.enum(TRACE_START_KINDS), id: id(), code: z.string(), matchedBy: z.enum(TRACE_MATCHES), label: z.string() })),
      /** A label code the trace cannot read (another factory's, a typo, a location label), in words. */
      problem: z.string().nullable(),
    }),
  },
})

const party = output({ id: id(), code: z.string(), name: z.string() })
const count = () => z.number().int().min(0)

const traceNode = output({
  key: z.string(),
  kind: z.enum(TRACE_NODE_KINDS),
  id: id(),
  /** What a person reads; null when the node is restricted. */
  code: z.string().nullable(),
  reach: z.enum(TRACE_REACHES),
  sides: z.array(z.enum(TRACE_SIDES)),
  /** The permissions the caller lacks to see this node's details (it is still counted). */
  restricted: z.array(z.string()),
  /** ACTIVE quality holds that name it. */
  holds: z.array(output({ id: id(), reasonCode: z.string(), placedAt: instant() })),
  /** SUPPLIER, CUSTOMER: the party; null without parties.view on it. */
  party: party.nullable().optional(),
  /** CUSTOMER: one of its shipments that carry the goods left the site. */
  received: z.boolean().optional(),
  receipt: output({ status: z.string(), receivedAt: instant(), supplierDdtNumber: z.string().nullable(), supplierDdtDate: z.string().nullable() }).optional(),
  lot: output({
    companyId: id(),
    siteId: id(),
    item: output({ id: id(), code: z.string(), name: z.string(), baseUom: z.string(), tracking: z.string() }),
    colourCode: z.string().nullable(),
    supplierLotRef: z.string().nullable(),
    dyeBatch: z.string().nullable(),
    purchaseOrder: output({ id: id(), number: z.string(), lineSeq: z.number().int().nullable() }).nullable(),
    receivedAt: instant().nullable(),
    qualityStatus: z.string(),
    crVi: output({ status: z.string(), valueMgKg: z.string().nullable(), limitMgKg: z.string().nullable() }),
    labResults: count(),
    documents: count(),
    /** The site's ledger, base unit: on hand now, and taken out as scrap less reversals. */
    onHand: z.string(),
    scrapped: z.string(),
  }).optional(),
  hide: output({ lotId: id(), state: z.string(), baseArea: z.string(), onHand: z.string() }).optional(),
  subcontract: output({ status: z.string(), workOrderId: id(), workshop: party.nullable() }).optional(),
  workOrder: output({
    companyId: id(),
    siteId: id(),
    batchNumber: z.string().nullable(),
    status: z.string(),
    kind: z.string(),
    styleCode: z.string(),
    tracking: z.enum(['BATCH', 'SERIAL']),
    /** Garments received into finished-goods stock, less reversals. */
    finishedReceived: count(),
  }).optional(),
  cell: output({
    workOrderId: id(),
    colourwayCode: z.string(),
    size: z.string(),
    quantity: count(),
    /** Released less reversed. */
    released: count(),
    /** Serials per status (MADE, RELEASED, SHIPPED, VOID). */
    serials: z.record(z.string(), count()),
    /** Garments on shipments: being packed (DRAFT, PACKED), gone (SHIPPED, DELIVERED), back from the carrier (RETURNED). */
    packed: count(),
    shipped: count(),
    returned: count(),
  }).optional(),
  bundle: output({ workOrderId: id(), cellId: id(), quantity: count(), part: z.string().nullable(), status: z.string(), parentBundleId: id().nullable(), cuts: count(), serials: count() }).optional(),
  serial: output({ workOrderId: id(), cellId: id(), bundleId: id().nullable(), status: z.string(), shipmentLineId: id().nullable() }).optional(),
  shipment: output({ companyId: id(), siteId: id(), status: z.string(), shippedAt: instant().nullable(), deliveredAt: instant().nullable(), ddtNumbers: z.array(z.string()), left: z.boolean() }).optional(),
})

export const traceContract = defineContract({
  querystring: input({
    kind: z.enum(TRACE_START_KINDS),
    id: id(),
    /** BACKWARD (where it came from), FORWARD (where it went) or BOTH (default). */
    direction: z.enum(TRACE_DIRECTIONS).default('BOTH'),
  }),
  response: {
    200: output({
      start: output({ key: z.string(), kind: z.enum(TRACE_START_KINDS), id: id(), code: z.string() }),
      direction: z.enum(TRACE_DIRECTIONS),
      /** The time the records were read (the trace is computed then; nothing is stored). */
      asOf: instant(),
      /** Upstream → downstream, sorted by level (rules.ts TRACE_NODE_KINDS). */
      nodes: z.array(traceNode),
      edges: z.array(output({ from: z.string(), to: z.string(), link: z.enum(TRACE_LINKS), exact: z.boolean(), quantity: z.string().nullable(), uom: z.string().nullable() })),
      /** Per kind with nodes: how many, exact and possible ("used in 3 work orders · shipped to 2 customers"). */
      levels: z.array(output({ kind: z.enum(TRACE_NODE_KINDS), exact: count(), possible: count() })),
      /** Where the chain is broken, coarse or still in work, in words. */
      gaps: z.array(output({ code: z.enum(TRACE_GAP_CODES), severity: z.enum(TRACE_GAP_SEVERITIES), at: z.string(), count: count(), message: z.string() })),
      customersReceived: output({ exact: count(), possible: count() }),
      /** Nodes counted but not shown, per missing permission. */
      restricted: z.array(output({ permission: z.string(), nodes: count() })),
    }),
  },
})
