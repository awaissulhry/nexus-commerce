import { z } from 'zod'
import { REGISTER_KINDS, REGISTER_LIMITS, REGISTER_RISKS, REGISTER_SOURCE_TYPES, REGISTER_STATUSES } from '@nexus/factory-domain/compliance/register/rules'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * The PPE register's contracts (B-W1-43; QHS-118; Reg. (EU) 2016/425 art. 8(4), 8(8)). Instants are UTC ISO strings;
 * the list's period is business days (Europe/Rome). No field carries money: the trace names work orders, shipments,
 * DDTs and customers, never a price or a cost.
 */

const kind = z.enum(REGISTER_KINDS)
const status = z.enum(REGISTER_STATUSES)
const risk = z.enum(REGISTER_RISKS)
const version = () => z.number().int().min(1)
const text = (max: number = REGISTER_LIMITS.text) => z.string().trim().max(max)
const codes = (max: number) => z.array(z.string().trim().min(1).max(REGISTER_LIMITS.code)).max(max)
const ids = (max: number) => z.array(id()).max(max)

const named = output({ id: id(), code: z.string(), name: z.string() })

export const entryView = output({
  id: id(),
  companyId: id(),
  reference: z.string(),
  kind,
  status,
  styleId: id(),
  style: named,
  styleRevisionId: id().nullable(),
  batchNumbers: z.array(z.string()),
  serials: z.array(z.string()),
  lotIds: z.array(id()),
  workOrderIds: z.array(id()),
  shipmentIds: z.array(id()),
  /** Who reported it (a customer or distributor). */
  partyId: id().nullable(),
  party: named.nullable(),
  ownerId: id().nullable(),
  /** The record that opened it (a release reversal …); null for a person's own entry. */
  source: output({ type: z.enum(REGISTER_SOURCE_TYPES), id: id() }).nullable(),
  reportedAt: instant(),
  description: z.string(),
  investigation: z.string().nullable(),
  risk,
  actionTaken: z.string().nullable(),
  actionCompletedAt: instant().nullable(),
  distributorsInformedAt: instant().nullable(),
  authorityNotifiedAt: instant().nullable(),
  authorityReference: z.string().nullable(),
  closedAt: instant().nullable(),
  closedById: id().nullable(),
  closeReason: z.string().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type EntryView = z.infer<typeof entryView>

const cellView = output({
  workOrderSizeId: id(),
  colourwayCode: z.string(),
  size: z.string(),
  pieces: z.number().int(),
  concerned: z.number().int(),
  released: z.number().int(),
  packed: z.number().int(),
  shipped: z.number().int(),
  returned: z.number().int(),
  serials: z.array(output({ serial: z.string(), status: z.string(), shipmentId: id().nullable(), shipmentNumber: z.string().nullable() })),
})

export const traceView = output({
  workOrders: z.array(
    output({
      id: id(),
      number: z.string(),
      batchNumber: z.string().nullable(),
      styleId: id(),
      styleCode: z.string(),
      revision: z.number().int().nullable(),
      status: z.string(),
      reach: z.enum(['WHOLE', 'PART']),
      via: z.array(z.enum(['BATCH', 'SERIAL', 'LOT', 'WORK_ORDER', 'SHIPMENT'])),
      cells: z.array(cellView),
    }),
  ),
  lots: z.array(output({ id: id(), code: z.string(), workOrderNumbers: z.array(z.string()) })),
  shipments: z.array(
    output({
      id: id(),
      number: z.string(),
      status: z.string(),
      left: z.boolean(),
      shippedAt: instant().nullable(),
      deliveredAt: instant().nullable(),
      partyId: id(),
      partyCode: z.string(),
      partyName: z.string(),
      ddtNumbers: z.array(z.string()),
      garments: z.number().int(),
      workOrderNumbers: z.array(z.string()),
    }),
  ),
  customers: z.array(output({ partyId: id(), code: z.string(), name: z.string(), garments: z.number().int(), shipmentNumbers: z.array(z.string()), ddtNumbers: z.array(z.string()) })),
  counts: output({
    workOrders: z.number().int(),
    concerned: z.number().int(),
    released: z.number().int(),
    packed: z.number().int(),
    shipped: z.number().int(),
    returned: z.number().int(),
    customers: z.number().int(),
  }),
  shippedGoods: z.boolean(),
  problems: z.array(output({ path: z.string(), code: z.string(), message: z.string() })),
})

const problem = output({ code: z.string(), message: z.string() })

export const entryDetail = entryView.extend({
  trace: traceView,
  /** The entry's duties: whether the law asks each now, and whether it is met. */
  duties: z.array(output({ code: z.enum(['RISK_ASSESSMENT', 'CORRECTIVE_ACTION', 'DISTRIBUTORS', 'AUTHORITY']), required: z.boolean(), done: z.boolean(), law: z.string() })),
  /** What still stops it from closing (beyond the reason the close asks), in plain words; empty for a closed entry. */
  toClose: z.array(problem),
})
export type EntryDetail = z.infer<typeof entryDetail>

const one = { 200: output({ entry: entryDetail }) }
const params = input({ entryId: id() })

export const listEntriesContract = defineContract({
  querystring: input({
    companyId: id().optional(),
    kind: kind.optional(),
    status: status.optional(),
    risk: risk.optional(),
    styleId: id().optional(),
    /** Reported on or after this business day, and on or before this one. */
    from: businessDate().optional(),
    to: businessDate().optional(),
    q: z.string().trim().min(1).max(120).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  }),
  response: { 200: output({ entries: z.array(entryView) }) },
})

export const getEntryContract = defineContract({ params, response: one })

const concern = {
  styleId: id(),
  styleRevisionId: id().nullish(),
  batchNumbers: codes(REGISTER_LIMITS.batchNumbers).optional(),
  serials: codes(REGISTER_LIMITS.serials).optional(),
  lotIds: ids(REGISTER_LIMITS.lotIds).optional(),
  workOrderIds: ids(REGISTER_LIMITS.workOrderIds).optional(),
  shipmentIds: ids(REGISTER_LIMITS.shipmentIds).optional(),
}

export const traceContract = defineContract({
  body: input({ companyId: id(), ...concern }),
  response: { 200: output({ trace: traceView }) },
})

export const createEntryContract = defineContract({
  body: input({
    companyId: id(),
    kind,
    ...concern,
    partyId: id().nullish(),
    ownerId: id().nullish(),
    /** When it was received or found; default now. */
    reportedAt: instant().optional(),
    description: text(REGISTER_LIMITS.description).min(1),
    investigation: text().nullish(),
    risk: risk.optional(),
    actionTaken: text().nullish(),
  }),
  response: { 201: output({ entry: entryDetail }) },
})

export const updateEntryContract = defineContract({
  params,
  body: input({
    version: version(),
    styleId: id().optional(),
    styleRevisionId: id().nullish(),
    batchNumbers: concern.batchNumbers,
    serials: concern.serials,
    lotIds: concern.lotIds,
    workOrderIds: concern.workOrderIds,
    shipmentIds: concern.shipmentIds,
    partyId: id().nullish(),
    ownerId: id().nullish(),
    description: text(REGISTER_LIMITS.description).min(1).optional(),
    investigation: text().nullish(),
    risk: risk.optional(),
    actionTaken: text().nullish(),
  }),
  response: one,
})

export const completeActionContract = defineContract({
  params,
  body: input({ version: version(), actionTaken: text().min(1).optional(), completedAt: instant().optional() }),
  response: one,
})

export const informDistributorsContract = defineContract({
  params,
  body: input({
    version: version(),
    informedAt: instant().optional(),
    /** How and whom (kept as a note on the entry's thread). */
    note: text().min(1),
  }),
  response: one,
})

export const notifyAuthorityContract = defineContract({
  params,
  body: input({
    version: version(),
    notifiedAt: instant().optional(),
    /** The authority's reference of the notice (or the Safety Gate / ICSMS number). */
    reference: z.string().trim().min(1).max(REGISTER_LIMITS.authorityReference),
    /** Which authority, and what was sent (kept as a note on the entry's thread). */
    note: text().min(1),
  }),
  response: one,
})

export const closeEntryContract = defineContract({
  params,
  /** Why it is closed; an empty reason is listed with the other problems (409). */
  body: input({ version: version(), reason: text(REGISTER_LIMITS.reason) }),
  response: one,
})

export const addNoteContract = defineContract({
  params,
  body: input({ body: text().min(1), mentions: z.array(id()).max(20).optional() }),
  response: { 201: output({ messageId: id(), threadId: id() }) },
})
