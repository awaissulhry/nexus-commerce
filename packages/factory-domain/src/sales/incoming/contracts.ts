import { z } from 'zod'
import { businessDate, id, input, instant, output } from '../../core/contracts'
import { inquiryRow } from '../inquiries/contracts'
import { INQUIRY_SOURCES, INQUIRY_STATUSES } from '../inquiries/rules'
import { INCOMING_CHANGE_KINDS, INCOMING_KINDS, INCOMING_LIMITS, INCOMING_TILES } from './rules'

/**
 * Sales › Incoming's one read (B-TH-039; threads plan G2, L2-G07): GET /sales/incoming — requests, catalogue orders and change
 * requests in ONE paged list (the kind on each row; each row only for a reader who holds its own view permission: requests
 * sales.inquiries.view, catalogue orders and change requests orders.view, over the row's company and customer), the tiles counted
 * under the same filters, and the cursor of the next page. factory-domain sales/incoming/rules.ts says what each tile counts.
 * People as in the inquiries' rows (the assignee by name, Owner decision 4); a prospect's personal data only as "From" for a
 * reader who keeps requests (B-TH-016). No money but a request's target price (its own row, price grain).
 */

export const incomingListQuery = input({
  /** The tile or saved row (default OPEN). */
  tile: z.enum(INCOMING_TILES).optional(),
  /** One kind only (default: every kind the reader may see). */
  kind: z.enum(INCOMING_KINDS).optional(),
  /** A request's own status (the State cell): only requests are listed then. */
  status: z.enum(INQUIRY_STATUSES).optional(),
  /** How it came: PORTAL also lists catalogue orders and change requests (they come from the portal); any other only requests. */
  source: z.enum(INQUIRY_SOURCES).optional(),
  partyId: id().optional(),
  /** true: requests of prospects only (no customer yet). */
  prospect: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  companyId: id().optional(),
  /** When it came (a request's arrival, a catalogue order's send, a change request's ask), Rome days, both included. */
  receivedFrom: businessDate().optional(),
  receivedTo: businessDate().optional(),
  /** Part of a number, the request's words, the customer's code or name, the customer's own reference. */
  q: z.string().trim().min(1).max(INCOMING_LIMITS.q).optional(),
  limit: z.coerce.number().int().min(1).max(INCOMING_LIMITS.list).optional(),
  /** `next` of the page before, as it came. */
  cursor: z.string().min(1).max(500).optional(),
})
export type IncomingListQuery = z.output<typeof incomingListQuery>

const partyRef = output({ id: id(), code: z.string(), name: z.string() })
const numbered = output({ id: id(), number: z.string() })
const words = output({ it: z.string(), en: z.string() })

/** A catalogue order as its Incoming row reads it. */
export const catalogueOrderFacts = output({
  status: z.enum(['SENT', 'ACCEPTED', 'REFUSED', 'WITHDRAWN']),
  source: z.string(),
  customerRef: z.string().nullable(),
  /** Its lines and pieces (a count, not money). */
  lines: z.number().int(),
  styles: z.array(z.string()),
  requestedDate: businessDate().nullable(),
  decidedAt: instant().nullable(),
  /** What it became, for a reader who may see it (orders.view / quotes.view there). */
  salesOrder: numbered.nullable(),
  quote: numbered.nullable(),
})

/** A change or cancel request as its Incoming row reads it (answered in Home › Approvals: `opens`). */
export const changeRequestFacts = output({
  kind: z.enum(INCOMING_CHANGE_KINDS),
  status: z.enum(['OPEN', 'ACCEPTED', 'REFUSED', 'WITHDRAWN']),
  order: numbered,
  reasonCode: z.string().nullable(),
  requestedDate: businessDate().nullable(),
  /** The order lines and size cells it names (counts, not money). */
  lines: z.number().int(),
  sizes: z.number().int(),
  answeredAt: instant().nullable(),
})

/** One row of Incoming, of any kind. */
export const incomingRow = output({
  /** Unique in the list: `<kind>:<id>`. */
  key: z.string(),
  kind: z.enum(INCOMING_KINDS),
  id: id(),
  /** The office's number: the request's INQ-…, the catalogue order's, the change request's order. */
  number: z.string(),
  companyId: id(),
  /** When it came: a request's arrival, a catalogue order's send, a change request's ask. */
  receivedAt: instant(),
  party: partyRef.nullable(),
  /** From: the customer, else the prospect as the inquiries' rows say it. */
  fromWords: z.string(),
  prospect: z.boolean(),
  summary: z.string(),
  /** Pieces asked (null: not said). */
  pieces: z.number().int().nullable(),
  wantedDate: businessDate().nullable(),
  /** The kind's own status code, and its words. */
  state: z.string(),
  stateWords: words,
  /** Still waits for the office (the OPEN tile). */
  open: z.boolean(),
  waiting: output({ for: z.enum(['US', 'CUSTOMER']).nullable(), workingMinutes: z.number().int().nullable(), overdue: z.boolean() }),
  version: z.number().int(),
  /**
   * Where the row opens: INCOMING (the reading pane, with its thread) or, for a change request (agreement T3), APPROVALS — the Home ›
   * Approvals review window, `?open=<id>` with the change request's id.
   */
  opens: output({ place: z.enum(['INCOMING', 'APPROVALS']), id: id() }),
  /** The kind's own facts: exactly one of the three. */
  request: inquiryRow.nullable(),
  catalogueOrder: catalogueOrderFacts.nullable(),
  changeRequest: changeRequestFacts.nullable(),
})

export const incomingList = output({
  rows: z.array(incomingRow),
  /** Each tile's number under the filters, every kind the reader may see (null: not counted, "—"). */
  counts: z.record(z.string(), z.number().int().nullable()),
  /** The rows of the tile asked, per kind (null: the reader may not see that kind, or the filters leave it out). */
  kinds: output({ REQUEST: z.number().int().nullable(), CATALOGUE_ORDER: z.number().int().nullable(), CHANGE_REQUEST: z.number().int().nullable() }),
  /** The cursor of the next page (null: this is the last). */
  next: z.string().nullable(),
  /** The waiting time was read for every open row (false: the WAITING_US count is partial). */
  complete: z.boolean(),
})
export type IncomingList = z.output<typeof incomingList>
export type IncomingRow = z.output<typeof incomingRow>
