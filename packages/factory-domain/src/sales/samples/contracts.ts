import { z } from 'zod'
import { businessDate, currency, id, input, instant, output } from '../../core/contracts'
import { money } from '../../money/marked'
import {
  BOARD_LANES,
  MANUAL_STAGES,
  ROUND_TILES,
  SAMPLE_DECISION_VIAS,
  SAMPLE_DECISIONS,
  SAMPLE_KINDS,
  SAMPLE_LIMITS,
  SAMPLE_REFUSALS,
  SAMPLE_STAGES,
  SAMPLE_TEST_RESULTS,
  SHIPMENT_DIRECTIONS,
} from './rules'

/**
 * Sample rounds' contracts (B-W2b-246): what apps/factory-api's modules/sales/samples accepts and answers. A refusal is a 409
 * whose issue is `refusal/<CODE>` (SAMPLE_REFUSALS) with the words. The one money field is the round's charge to the customer,
 * a price (money.price: the value only with the price grain; sent without it, the request is refused). People as user ids (the
 * round's maker by name inside the record only); no floor worker anywhere.
 */

const version = () => z.number().int().min(1)
const words = (max: number) => z.string().trim().min(1).max(max)
const ref = output({ id: id(), code: z.string(), name: z.string() })
export const sampleRefusal = output({ code: z.enum(SAMPLE_REFUSALS), message: z.string() })
const action = output({ allowed: z.boolean(), refusal: sampleRefusal.nullable() })
const chargeMinor = () => z.number().int().min(0).max(SAMPLE_LIMITS.chargeMinor)

export const roundParams = input({ roundId: id() })
export const shipmentParams = input({ shipmentId: id() })

/** One cell asked: a colourway of the style (left out: any), a size of its range, 1 to 1000 pieces. */
export const cellBody = input({
  colourwayId: id().nullable().optional(),
  size: z.string().trim().min(1).max(SAMPLE_LIMITS.size),
  quantity: z.number().int().min(1).max(SAMPLE_LIMITS.cellQuantity),
})

// ---- rounds -----------------------------------------------------------------------------------------------------------

/** "New sample request" (SCR-110 samples.new): the style and its revision (default: the newest not obsolete), the kind and round, the cells, the due day, the customer. */
export const createRoundBody = input({
  styleId: id(),
  /** Default: the style's newest revision that is not obsolete (a draft for a proto, the released one once released). */
  revisionId: id().optional(),
  /** A tenant-wide style's round is numbered in this company (a company style: its own; another is refused). */
  companyId: id().optional(),
  kind: z.enum(SAMPLE_KINDS),
  /** Default: one more than the style's highest round of this kind. */
  roundNo: z.number().int().min(1).max(SAMPLE_LIMITS.roundNo).optional(),
  /** The brand or customer it is for (a CUSTOMER or BRAND party); left out: an internal round. */
  partyId: id().optional(),
  cells: z.array(cellBody).min(1).max(SAMPLE_LIMITS.cells),
  dueDate: businessDate().optional(),
  instructions: words(SAMPLE_LIMITS.instructions).optional(),
  /** What the customer is charged, in minor units of chargeCurrency (both or neither). */
  chargeAmountMinor: money.price(chargeMinor()),
  chargeCurrency: currency().optional(),
  /** CERTIFICATION only: the sizes and zones sent to the notified body. */
  testZones: words(SAMPLE_LIMITS.testZones).optional(),
})
export type CreateRoundBody = z.output<typeof createRoundBody>

/** The round's request changed while it is open (the revision only while REQUESTED); null clears a field. */
export const updateRoundBody = input({
  version: version(),
  revisionId: id().optional(),
  roundNo: z.number().int().min(1).max(SAMPLE_LIMITS.roundNo).optional(),
  cells: z.array(cellBody).min(1).max(SAMPLE_LIMITS.cells).optional(),
  dueDate: businessDate().nullable().optional(),
  instructions: words(SAMPLE_LIMITS.instructions).nullable().optional(),
  /** Both or neither: null with null clears the charge. */
  chargeAmountMinor: money.price(chargeMinor().nullable()),
  chargeCurrency: currency().nullable().optional(),
  testZones: words(SAMPLE_LIMITS.testZones).nullable().optional(),
})
export type UpdateRoundBody = z.output<typeof updateRoundBody>

/** "Move to…" (a drag between the four manual lanes). */
export const moveRoundBody = input({ version: version(), to: z.enum(MANUAL_STAGES) })
export type MoveRoundBody = z.output<typeof moveRoundBody>

export const cancelRoundBody = input({ version: version(), reason: words(SAMPLE_LIMITS.cancelReason) })
export type CancelRoundBody = z.output<typeof cancelRoundBody>

export const roundListQuery = input({
  tile: z.enum(ROUND_TILES).optional(),
  stage: z.enum(SAMPLE_STAGES).optional(),
  kind: z.enum(SAMPLE_KINDS).optional(),
  styleId: id().optional(),
  revisionId: id().optional(),
  partyId: id().optional(),
  /** true: internal rounds only (no customer). */
  internal: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  companyId: id().optional(),
  /** Due from / to (both days included). */
  dueFrom: businessDate().optional(),
  dueTo: businessDate().optional(),
  /** Part of the number, the style's code or name, the customer's code or name. */
  q: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(SAMPLE_LIMITS.list).optional(),
})
export type RoundListQuery = z.output<typeof roundListQuery>

const party = output({ id: id(), code: z.string(), name: z.string() })
const revisionRef = output({ id: id(), revision: z.number().int(), status: z.string() })
const cellView = output({ colourwayId: id().nullable(), colourwayCode: z.string().nullable(), size: z.string(), quantity: z.number().int() })

/** A card of the board and a row of the list (SCR-110). */
export const roundRow = output({
  id: id(),
  number: z.string(),
  companyId: id(),
  style: ref,
  revision: revisionRef,
  kind: z.enum(SAMPLE_KINDS),
  roundNo: z.number().int(),
  /** "Fit · round 2" (English; the screen words it from kind and roundNo). */
  label: z.string(),
  party: party.nullable(),
  cells: z.array(cellView),
  pieces: z.number().int(),
  dueDate: businessDate().nullable(),
  /** Days past due while open (null: not late). */
  daysLate: z.number().int().nullable(),
  stage: z.enum(SAMPLE_STAGES),
  decision: z.enum(SAMPLE_DECISIONS).nullable(),
  decidedAt: instant().nullable(),
  /** Who asked for it (the card's Owner): an office user id. */
  createdById: id().nullable(),
  createdAt: instant(),
  /** Open fit comments (the card's "Open comments"). */
  openComments: z.number().int(),
  workOrders: z.number().int(),
  shipments: z.number().int(),
  chargeAmountMinor: money.price(z.number().int().nullable()),
  chargeCurrency: z.string().nullable(),
  version: z.number().int(),
})
export type RoundRow = z.output<typeof roundRow>

export const roundList = output({
  rows: z.array(roundRow),
  /** Each tile's count under the other filters. */
  counts: z.record(z.enum(ROUND_TILES), z.number().int()),
  /** The board's lanes in order, each with its count under the filters. */
  lanes: z.array(output({ stage: z.enum(BOARD_LANES), count: z.number().int() })),
  complete: z.boolean(),
})

/** A sample work order of the round (the Sample tab's "What was made"): never a worker. */
export const roundWorkOrder = output({
  id: id(),
  number: z.string(),
  status: z.string(),
  site: output({ id: id(), code: z.string() }),
  pieces: z.number().int(),
  dueDate: businessDate().nullable(),
  releasedAt: instant().nullable(),
  startedAt: instant().nullable(),
  completedAt: instant().nullable(),
})

const address = output({ id: id(), name: z.string().nullable(), line1: z.string(), postalCode: z.string(), city: z.string(), country: z.string() })

export const shipmentView = output({
  id: id(),
  roundId: id(),
  direction: z.enum(SHIPMENT_DIRECTIONS),
  party,
  shipToAddress: address.nullable(),
  carrierName: z.string().nullable(),
  trackingNumber: z.string().nullable(),
  trackingUrl: z.string().nullable(),
  sentAt: instant().nullable(),
  receivedAt: instant().nullable(),
  note: z.string().nullable(),
  /** Removed only before it is sent. */
  removable: z.boolean(),
  createdAt: instant(),
  version: z.number().int(),
})
export type ShipmentView = z.output<typeof shipmentView>

/** The round's record (Request, Sample, Approval as recorded, Shipments; Activity is the thread's timeline). */
export const roundView = roundRow.extend({
  style: ref.extend({ lifecycle: z.string(), status: z.string(), brandPartyId: id().nullable() }),
  /** The style's RELEASED revision when the pinned one is not it (the Request card's "a newer revision exists"). */
  releasedRevision: revisionRef.nullable(),
  instructions: z.string().nullable(),
  createdBy: output({ id: id(), name: z.string() }).nullable(),
  decision: z.enum(SAMPLE_DECISIONS).nullable(),
  decisionComments: z.string().nullable(),
  decidedVia: z.enum(SAMPLE_DECISION_VIAS).nullable(),
  decidedById: id().nullable(),
  approvalRequestId: id().nullable(),
  /** CERTIFICATION only (PRD-158): the zones sent, the result and the certificate (B-W2b-252 records the last two). */
  testZones: z.string().nullable(),
  testResult: z.enum(SAMPLE_TEST_RESULTS).nullable(),
  certificate: output({ id: id(), number: z.string() }).nullable(),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  /** Its sample work orders the reader may see (workorders.view at their site); `workOrdersHeld` counts the others. */
  workOrdersList: z.array(roundWorkOrder),
  workOrdersHeld: z.number().int(),
  shipmentsList: z.array(shipmentView),
  /** Parts kept by B-W2b-252 (fit and swatches), counted here. */
  measurements: z.number().int(),
  swatches: z.number().int(),
  /** Each manual stage and whether the round may move there now (else the refusal in words). */
  moves: z.array(output({ to: z.enum(MANUAL_STAGES), allowed: z.boolean(), refusal: sampleRefusal.nullable() })),
  actions: output({ edit: action, changeRevision: action, cancel: action, makeWorkOrder: action, addShipment: action }),
})
export type RoundView = z.output<typeof roundView>

// ---- the sample work order (MES-018) ------------------------------------------------------------------------------------

/** "Make sample work order": the order lines it is made on (each line's sizes, default: the round's cells of its colourway). */
export const workOrderBody = input({
  /** The round's version as read (the edit-conflict guard). */
  version: version().optional(),
  /** Default: the lines' site, else the company's only active plant (W1's rule). */
  siteId: id().optional(),
  /** Default: the round's due day. */
  dueDate: businessDate().optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  note: z.string().trim().max(2000).nullish(),
  lines: z
    .array(
      input({
        salesOrderLineId: id(),
        /** Default: the round's cells of the line's colourway (a cell of no colourway with one line). */
        sizes: z.array(input({ size: z.string().trim().min(1).max(SAMPLE_LIMITS.size), quantity: z.number().int().min(1).max(100_000) })).min(1).max(400).optional(),
      }),
    )
    .min(1)
    .max(50),
})
export type WorkOrderBody = z.output<typeof workOrderBody>

/** What the "Make sample work order" dialog needs. */
export const workOrderOptionsView = output({
  round: output({ id: id(), number: z.string(), stage: z.enum(SAMPLE_STAGES), version: z.number().int(), revision: revisionRef, partyId: id().nullable() }),
  /** Order lines of the round's style the samples can be made on (of its customer when it has one; CONFIRMED or IN_PRODUCTION), with what is still open per size and the round's cells each would take. */
  lines: z.array(
    output({
      id: id(),
      orderId: id(),
      orderNumber: z.string(),
      seq: z.number().int(),
      partyId: id(),
      colourwayId: id(),
      colourwayCode: z.string(),
      styleRevisionId: id().nullable(),
      siteId: id().nullable(),
      open: z.array(output({ size: z.string(), ordered: z.number().int(), onWorkOrders: z.number().int(), open: z.number().int() })),
      proposed: z.array(output({ size: z.string(), quantity: z.number().int() })),
    }),
  ),
  sites: z.array(output({ id: id(), code: z.string(), name: z.string() })),
  /** What stops the work order now, in words (empty: it can be made). */
  blockers: z.array(z.string()),
  /** What does not stop making it but stops its release (a draft revision), in words. */
  warnings: z.array(z.string()),
})

// ---- shipments (SAL-316) ------------------------------------------------------------------------------------------------

const trackingUrl = () => z.string().trim().max(SAMPLE_LIMITS.trackingUrl).regex(/^https:\/\/\S+$/, { message: 'Expected the courier’s tracking page (https://…).' })

export const createShipmentBody = input({
  direction: z.enum(SHIPMENT_DIRECTIONS).optional(),
  /** Who it goes to or comes from; default: the round's customer (an internal round names one: a notified body, an agent). */
  partyId: id().optional(),
  /** OUTBOUND only: an address of the party; left out: typed on the label. */
  shipToAddressId: id().optional(),
  carrierName: words(SAMPLE_LIMITS.carrierName).optional(),
  trackingNumber: words(SAMPLE_LIMITS.trackingNumber).optional(),
  trackingUrl: trackingUrl().optional(),
  sentAt: instant().optional(),
  receivedAt: instant().optional(),
  note: words(SAMPLE_LIMITS.shipmentNote).optional(),
})
export type CreateShipmentBody = z.output<typeof createShipmentBody>

/** A cell of the Shipments grid saved (autosave per cell): sent and received once each. */
export const updateShipmentBody = input({
  version: version(),
  shipToAddressId: id().nullable().optional(),
  carrierName: words(SAMPLE_LIMITS.carrierName).nullable().optional(),
  trackingNumber: words(SAMPLE_LIMITS.trackingNumber).nullable().optional(),
  trackingUrl: trackingUrl().nullable().optional(),
  sentAt: instant().optional(),
  receivedAt: instant().optional(),
  note: words(SAMPLE_LIMITS.shipmentNote).nullable().optional(),
})
export type UpdateShipmentBody = z.output<typeof updateShipmentBody>

export const removeShipmentQuery = input({ version: z.coerce.number().int().min(1) })
