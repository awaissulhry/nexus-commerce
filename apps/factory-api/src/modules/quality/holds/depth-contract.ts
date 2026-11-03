import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { TRACE_NODE_KINDS, TRACE_REACHES, TRACE_START_KINDS } from '@nexus/factory-domain/inventory/trace/rules'
import { GENEALOGY_PICK_LIMIT, GENEALOGY_START_TYPES, HOLD_NEXT_STEPS, NODE_HOLD_STATES } from '@nexus/factory-domain/quality/holds/depth'
import { HOLD_LIMITS, HOLD_STATUSES, HOLD_SUBJECT_TYPES } from '@nexus/factory-domain/quality/holds/rules'
import { heldStockView, holdView } from './contract'

/**
 * Holds in depth (B-W2b-114; QHS-075 hold by genealogy, QHS-077 the hold board, QHS-078 the quarantine move; design
 * quality.holds qh-genealogy, sec:qh-board, Hold › Affected, qh-move). Office routes; every write takes an Idempotency-Key
 * and (a change of one hold) the version read. Refusals in words: `body/<field>` (400), `picks/<key>` (409). No cost, price,
 * value or worker's name: quantities are decimal strings in the unit named, garments whole numbers.
 */

const count = () => z.number().int().min(0)
const holdKind = z.enum(HOLD_SUBJECT_TYPES)

const impactNode = output({
  key: z.string(),
  kind: z.enum(TRACE_NODE_KINDS),
  id: id(),
  /** Null when hidden (a site or a party the reader may not see): counted, never shown. */
  code: z.string().nullable(),
  reach: z.enum(TRACE_REACHES),
  companyId: id().nullable(),
  siteId: id().nullable(),
  hidden: z.boolean(),
  /** The record's state as a code (a lot's quality status, a work order's status …); the screens say it. */
  state: z.string().nullable(),
  holdKind: holdKind.nullable(),
  /** HOLDABLE · HELD (an ACTIVE hold names it) · LEFT (gone: the PPE register's) · NOT_HOLDABLE · NONE (no kind of hold) · HIDDEN. */
  hold: z.enum(NODE_HOLD_STATES),
  /** Why it cannot be held (English; data under the screen's words). */
  problem: z.string().nullable(),
  holds: z.array(output({ id: id(), reasonCode: z.string() })),
  workOrderId: id().nullable(),
  cell: output({ colourwayCode: z.string(), size: z.string(), quantity: count(), released: count(), packed: count(), shipped: count(), returned: count() }).nullable().optional(),
  lot: output({ itemCode: z.string(), itemName: z.string(), uom: z.string(), onHand: z.string(), colourCode: z.string().nullable() }).nullable().optional(),
  hideOnHand: z.string().nullable().optional(),
  workOrder: output({ styleCode: z.string(), batchNumber: z.string().nullable(), status: z.string() }).nullable().optional(),
  bundle: output({ quantity: count(), part: z.string().nullable() }).nullable().optional(),
  shipment: output({ ddtNumbers: z.array(z.string()), left: z.boolean() }).nullable().optional(),
  partyName: z.string().nullable().optional(),
  received: z.boolean().optional(),
})

const impact = {
  starts: z.array(output({ key: z.string(), kind: z.enum(TRACE_START_KINDS), id: id(), code: z.string() })),
  asOf: instant(),
  /** Upstream → downstream in tree order. */
  nodes: z.array(impactNode),
  edges: z.array(output({ from: z.string(), to: z.string(), link: z.string(), exact: z.boolean(), quantity: z.string().nullable(), uom: z.string().nullable() })),
  levels: z.array(output({ kind: z.enum(TRACE_NODE_KINDS), exact: count(), possible: count() })),
  /** Where the chain is broken, coarse or still in work (B-W2a-27's codes; the screens say them). */
  gaps: z.array(output({ code: z.string(), severity: z.string(), at: z.string(), count: count() })),
  /** What it touches by state (design Hold › Affected "In stock · in work · packed · shipped (with customers)"). */
  states: output({
    material: z.array(output({ uom: z.string(), onHand: z.string() })),
    hidesInStock: count(),
    garments: output({ inWork: count(), inStock: count(), packed: count(), shipped: count(), returned: count() }),
    customers: count(),
  }),
  /** Nodes counted but not shown, per missing permission. */
  restricted: z.array(output({ permission: z.string(), nodes: count() })),
}

export const groupView = output({
  id: id(),
  sourceType: z.string(),
  sourceId: id(),
  sourceCode: z.string().nullable(),
  reasonCode: z.string(),
  reasonNote: z.string().nullable(),
  /** { Lot, Hide, WorkOrder, Bundle, GarmentSerial, Shipment, garments, shippedGarments, customers }: whole numbers. */
  counts: z.record(z.string(), count()),
  placedAt: instant(),
  placedBy: z.enum(['USER', 'SYSTEM']),
  version: z.number().int(),
  holds: z.array(output({ id: id(), number: z.string().nullable(), subjectType: holdKind, count: count(), status: z.enum(HOLD_STATUSES), siteCode: z.string().nullable() })),
})

const startType = z.enum(GENEALOGY_START_TYPES)

export const genealogyContract = defineContract({
  querystring: input({ type: startType, id: id(), /** Extending this hold (its group, or a new group naming it). */ holdId: id().optional() }),
  response: {
    200: output({
      start: output({ type: startType, id: id(), code: z.string(), companyId: id(), siteId: id() }),
      ...impact,
      /** The sites with something to hold: their quarantine places, and whether the caller places holds there. */
      sites: z.array(output({ id: id(), code: z.string(), name: z.string(), mayPlace: z.boolean(), quarantinePlaces: z.array(output({ id: id(), code: z.string(), name: z.string() })) })),
      extending: output({ holdId: id(), number: z.string().nullable(), status: z.enum(HOLD_STATUSES), groupId: id().nullable() }).nullable(),
      group: groupView.nullable(),
    }),
  },
})

export const placeGenealogyContract = defineContract({
  body: input({
    type: startType,
    id: id(),
    /** The ticked nodes' keys ("WORK_ORDER:<id>"): sizes and customers among them are branches, skipped. */
    picks: z.array(z.string().min(3).max(80)).min(1).max(GENEALOGY_PICK_LIMIT),
    reasonCode: z.string().min(1).max(40),
    reasonNote: z.string().max(HOLD_LIMITS.reasonNote * 2).nullable().optional(),
    ownerId: id().nullable().optional(),
    expectedReleaseOn: businessDate().nullable().optional(),
    /** Ask the move to quarantine for held lots and hides (at a site with one quarantine place). */
    askQuarantine: z.boolean().optional(),
    note: z.string().max(HOLD_LIMITS.note * 2).nullable().optional(),
    /** Extend this hold: its group grows, or a new group names it. */
    holdId: id().nullable().optional(),
  }),
  response: {
    201: output({
      group: groupView,
      holds: z.array(holdView),
      alreadyHeld: z.array(output({ key: z.string(), code: z.string().nullable() })),
      covered: count(),
      /** Sites whose stock was held without asking the move (none or several quarantine places). */
      quarantineNotAsked: z.array(output({ siteId: id(), places: count() })),
    }),
  },
})

export const affectedContract = defineContract({
  params: input({ holdId: id() }),
  response: {
    200: output({
      holdId: id(),
      /** How many of the hold's records were traced, of how many. */
      traced: count(),
      of: count(),
      traceable: z.boolean(),
      ...impact,
      group: groupView.nullable(),
      /** Where "Extend hold" starts, or why it does not (NOT_ACTIVE, NO_RIGHT, KIND). */
      extend: output({ start: output({ type: startType, id: id(), code: z.string() }).nullable(), held: z.enum(['NOT_ACTIVE', 'NO_RIGHT', 'KIND']).nullable() }),
    }),
  },
})

export const nextStepContract = defineContract({
  params: input({ holdId: id() }),
  body: input({ version: z.number().int().min(1), nextStep: z.enum(HOLD_NEXT_STEPS) }),
  response: { 200: output({ hold: holdView }) },
})

export const askQuarantineContract = defineContract({
  params: input({ holdId: id() }),
  body: input({ version: z.number().int().min(1), /** A QUARANTINE place of the hold's site (left out: the site's only one). */ locationId: id().nullable().optional() }),
  response: { 200: output({ hold: holdView }) },
})

export const confirmQuarantineContract = defineContract({
  params: input({ holdId: id() }),
  body: input({
    version: z.number().int().min(1),
    /** The place's code as typed or scanned from its label (case, spaces and hyphens aside). */
    placeCode: z.string().trim().min(1).max(80),
  }),
  response: {
    200: output({
      hold: holdView,
      /** The transfers posted into the place (base unit). */
      moved: z.array(output({ fromCode: z.string(), onHand: z.string(), uom: z.string() })),
      /** Stock of the hold left where it is (at an outside workshop). */
      stays: z.array(output({ atCode: z.string(), onHand: z.string(), uom: z.string() })),
      stock: heldStockView.nullable(),
    }),
  },
})
