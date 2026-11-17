import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { HEALTH_REASON_CODES } from '@nexus/factory-domain/production-brand/health'
import { SUPERVISOR_MARKS } from '@nexus/factory-domain/production-brand/supervisor'
import { BRAND_URGENCIES } from '@nexus/factory-domain/production-brand/urgency'
import { WAITING_ON } from '@nexus/factory-domain/production-brand/waiting'
import { WORK_ORDER_KINDS, WORK_ORDER_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'
import { ORDER_REQUEST_KINDS } from '@nexus/factory-domain/sales/change-requests/rules'
import { customerSchema } from '../work-orders/customers'
import { BLOCKED_BY, WORK_ORDER_RISKS } from '../work-orders/risk'

/**
 * B-PR-33 — Production › Overview, the all-customers read (production plan §5; 06-tree A.1; ./read). Counts only: pieces and work
 * orders, never money, never a person (lists show the supervisor as Me / Someone else / Not set). The word "total" is not used for a
 * field (the money-grain guard reads it as money): the Total row is `overall`, a list's size is `count`.
 */

const count = z.number().int().min(0)
const pieces = count.nullable()

/** Open work orders by what their order(s) wait on (the keeper's): us, the customer (BRAND), a supplier, a workshop. */
const waitingCounts = output({ US: count, BRAND: count, SUPPLIER: count, WORKSHOP: count })

/** Open work orders by what blocks them: on hold, the customer, material (the list's), a gate, made before the rule (needs a split). */
const blockedCounts = output({ HOLD: count, CUSTOMER: count, MATERIAL: count, GATE: count, NEEDS_SPLIT: count })

/** Pieces per WIP stage (null: "—", the floor does not count that stage for any of the row's work orders there). */
const stagePieces = output({
  NOT_RELEASED: pieces,
  RELEASED: pieces,
  CUTTING: pieces,
  SEWING: pieces,
  AT_WORKSHOP: pieces,
  QUALITY: pieces,
  FINISHED: pieces,
  ON_HOLD: pieces,
})

/**
 * One row of the overview: a customer (CUSTOMER), the work orders made before the one-customer rule with cells of several customers
 * (MIXED: "Mixed customers (made before the rule)"; only for a person who reaches every customer), the work of no customer (NO_CUSTOMER:
 * a sample of a round for no customer; the same), or the Total of the rows the reader gets (`overall`).
 */
const row = output({
  kind: z.enum(['CUSTOMER', 'MIXED', 'NO_CUSTOMER', 'ALL']),
  /** The customer (CUSTOMER rows only), as the office names it. */
  customer: customerSchema.nullable(),
  /** Open work orders (DRAFT, RELEASED, IN_PROGRESS, ON_HOLD) and their pieces. */
  inProduction: output({ workOrders: count, pieces: count }),
  /** Open work orders by their risk state (the Work orders list's `?risk=`): late, at risk, blocked. */
  late: count,
  atRisk: count,
  blocked: count,
  waitingOn: waitingCounts,
  blockedBy: blockedCounts,
  /** Open work orders whose customer marked their order Urgent (its urgency counts: the customer's switch is on). */
  customerUrgent: count,
  /** The customer's requests: those that wait (OPEN or COUNTERED), and those THIS reader answers in Home › Approvals. */
  requests: output({ waiting: count, toAnswer: count }),
  /** WIP by stage in pieces; started work orders whose sewing the floor does not count ("sewing not counted here"). */
  wip: output({ stages: stagePieces, sewingNotCounted: count }),
})

/** A work order's risk (../work-orders/risk; the list's own fields). */
const riskFacts = output({
  state: z.enum(WORK_ORDER_RISKS),
  daysLate: z.number().int().nullable(),
  plannedEnd: businessDate().nullable(),
  planAfterDue: z.boolean(),
  raised: z.enum(HEALTH_REASON_CODES).nullable(),
  blockedBy: z.enum(BLOCKED_BY).nullable(),
})

/** One row of Most urgent: a late or at-risk work order, as the Work orders list sorted by risk shows it. */
const urgentRow = output({
  id: id(),
  number: z.string(),
  status: z.enum(WORK_ORDER_STATUSES),
  kind: z.enum(WORK_ORDER_KINDS),
  siteId: id(),
  siteCode: z.string(),
  style: output({ code: z.string(), name: z.string() }),
  partyId: id().nullable(),
  customer: customerSchema.nullable(),
  /** Made before the one-customer rule with cells of several customers. */
  mixedCustomers: z.boolean(),
  dueDate: businessDate().nullable(),
  daysLate: z.number().int().nullable(),
  pieces: count,
  risk: riskFacts,
  waitingOn: output({ on: z.enum(WAITING_ON), since: instant().nullable() }).nullable(),
  /** Its production supervisor for the reader: ME, SOMEONE_ELSE, NOT_SET (never a name on a list); null: no customer. */
  supervisor: z.enum(SUPERVISOR_MARKS).nullable(),
  customerUrgency: z.enum(BRAND_URGENCIES).nullable(),
  urgentRank: z.number().int().nullable(),
  /** Not started and its open order waits on a gate (the planning board does not place it). */
  gate: z.boolean(),
})

export const overviewContract = defineContract({
  querystring: input({
    /** One site's work orders (customer requests: those of the site's company, as Home › Approvals filters them). */
    siteId: id().optional(),
    /** One customer the reader reaches (another: "Customer not found."). */
    partyId: id().optional(),
    /** `me` — "Only mine": the work orders and orders I supervise (their own supervisor, else the customer's default). */
    supervisor: z.enum(['me']).optional(),
    /** Most urgent: rows per page (default 10: "10 of N"). */
    limit: z.coerce.number().int().min(1).max(100).default(10),
    /** Most urgent: the `nextCursor` of the page before (a position token of the risk sort). */
    cursor: z.string().trim().min(1).max(80).optional(),
  }),
  response: {
    200: output({
      asOf: instant(),
      today: businessDate(),
      filter: output({ siteId: id().nullable(), partyId: id().nullable(), supervisor: z.enum(['me']).nullable() }),
      /** The reader reaches every customer here (the MIXED and NO_CUSTOMER rows can appear); a limited reader: false. */
      everyCustomer: z.boolean(),
      /** The six tiles: waiting on us, waiting on the customer, late, at risk, blocked; the customer requests this reader answers in Home › Approvals (the same rows). Supplier and workshop: the other two waits. */
      tiles: output({
        waitingOnUs: count,
        waitingOnCustomer: count,
        waitingOnSupplier: count,
        waitingOnWorkshop: count,
        late: count,
        atRisk: count,
        blocked: count,
        customerRequests: count,
      }),
      /** One row per customer the reader reaches with open work or a waiting request, by name. */
      customers: z.array(row),
      /** "Mixed customers (made before the rule)" (null: none, or the reader does not reach every customer). */
      mixed: row.nullable(),
      /** Work of no customer (samples for no customer; null: none). */
      noCustomer: row.nullable(),
      /** The Total of every row above, in full. */
      overall: row,
      /** Open customer requests (OPEN or COUNTERED) the reader reaches, by kind; `toAnswer`: the Home › Approvals rows. */
      requests: output({
        waiting: count,
        toAnswer: count,
        byKind: z.array(output({ kind: z.enum(ORDER_REQUEST_KINDS), open: count, countered: count })),
      }),
      /** Late and at-risk work orders, most urgent first (the list's risk sort), one page; `count` = all of them. */
      mostUrgent: output({ items: z.array(urgentRow), count, nextCursor: z.string().nullable() }),
      live: output({ events: z.array(z.string()) }),
    }),
  },
})
