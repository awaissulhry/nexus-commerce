import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { WORK_CENTRE_KINDS } from '@nexus/factory-domain/product/routing/operations'
import { CAPACITY_UNITS, HOLD_CODES, JOB_KINDS, MAX_PARTS, NOTE_MAX, PER_WEEK_MAX, WARNING_CODES } from '@nexus/factory-domain/planning/subcontract-capacity/rules'

/**
 * Work to subcontractors (B-W2b-321; PLN-117, PLN-124, PLN-162, PLN-164, PLN-165; design planning.allocation and
 * planning.capacity). Amounts are decimal strings with one decimal (minutes or garments, as `unit` says), percents with one;
 * days are the site's calendar days. No money, no person.
 */

const version = () => z.number().int().min(1)
const named = output({ id: id(), code: z.string(), name: z.string() })
const kind = z.enum(WORK_CENTRE_KINDS)
const amount = () => z.string()

// ---- capacity rows (PLN-124) ----------------------------------------------------------------------------------------------

const capacityRowView = output({
  id: id(),
  workshop: named,
  workCentreKind: z.string().nullable(),
  unit: z.enum(CAPACITY_UNITS),
  perWeek: z.number().int(),
  validFrom: businessDate(),
  validTo: businessDate().nullable(),
  note: z.string().nullable(),
  inForceToday: z.boolean(),
  /** "2,400 minutes a week for sewing". */
  words: z.string(),
  version: z.number().int(),
  may: output({ change: z.boolean() }),
})

export const listCapacityContract = defineContract({
  querystring: input({ siteId: id().optional(), partyId: id().optional() }),
  response: { 200: output({ workshops: z.array(output({ id: id(), code: z.string(), name: z.string(), may: output({ create: z.boolean() }) })), rows: z.array(capacityRowView) }) },
})

const capacityFields = {
  workCentreKind: kind.nullable().optional(),
  perWeek: z.number().int().min(1).max(PER_WEEK_MAX),
  validFrom: businessDate(),
  validTo: businessDate().nullable().optional(),
  note: z.string().max(NOTE_MAX).nullable().optional(),
}

export const createCapacityContract = defineContract({
  body: input({ partyId: id(), unit: z.enum(CAPACITY_UNITS), ...capacityFields }),
  response: { 201: output({ row: capacityRowView }) },
})

export const editCapacityContract = defineContract({
  params: input({ capacityId: id() }),
  body: input({ version: version(), unit: z.enum(CAPACITY_UNITS).optional(), ...capacityFields, perWeek: capacityFields.perWeek.optional(), validFrom: capacityFields.validFrom.optional() }),
  response: { 200: output({ row: capacityRowView }) },
})

export const deleteCapacityContract = defineContract({
  params: input({ capacityId: id() }),
  querystring: input({ version: z.coerce.number().int().min(1) }),
  response: { 200: output({ deleted: id() }) },
})

// ---- subcontractors on Capacity & load (PLN-124) ------------------------------------------------------------------------

const lineCell = output({
  key: z.string(),
  from: businessDate(),
  to: businessDate(),
  /** null: no capacity set (unknown, never 0). */
  available: amount().nullable(),
  booked: amount(),
  /** The plan's planned subcontract orders there: never in the %. */
  proposed: amount(),
  loadPct: z.string().nullable(),
  over: z.boolean(),
  openDays: z.number().int(),
  closedDays: z.number().int(),
  words: z.string(),
})

const lineView = output({
  kind: z.literal('WORKSHOP'),
  id: id(),
  code: z.string(),
  name: z.string(),
  location: output({ id: id(), code: z.string() }).nullable(),
  /** The kind of work the line counts (null: all its work). */
  workCentreKind: z.string().nullable(),
  /** null: no capacity set. */
  unit: z.enum(CAPACITY_UNITS).nullable(),
  known: z.boolean(),
  capacity: z.array(output({ id: id(), perWeek: z.number().int(), validFrom: businessDate(), validTo: businessDate().nullable(), words: z.string() })),
  cells: z.array(lineCell),
  overall: output({ available: amount().nullable(), booked: amount(), proposed: amount(), loadPct: z.string().nullable(), over: z.boolean() }),
})

export const subcontractorCapacityContract = defineContract({
  querystring: input({ siteId: id(), from: businessDate().optional(), to: businessDate().optional(), bucket: z.enum(['DAY', 'WEEK', 'MONTH', 'PLAN']).optional() }),
  response: {
    200: output({
      site: output({ id: id(), companyId: id(), code: z.string(), name: z.string(), timeZone: z.string() }),
      from: businessDate(),
      to: businessDate(),
      bucket: z.string(),
      today: businessDate(),
      asOf: instant(),
      buckets: z.array(output({ key: z.string(), kind: z.string(), from: businessDate(), to: businessDate() })),
      lanes: z.array(lineView),
      tiles: output({ subcontractorsOverThisWeek: z.number().int(), workshopsWithoutCapacity: z.number().int() }),
    }),
  },
})

export const subcontractorCellContract = defineContract({
  querystring: input({ siteId: id(), partyId: id(), workCentreKind: z.string().max(40).optional(), from: businessDate(), to: businessDate() }),
  response: {
    200: output({
      workshop: named,
      workCentreKind: z.string().nullable(),
      unit: z.enum(CAPACITY_UNITS).nullable(),
      from: businessDate(),
      to: businessDate(),
      available: amount().nullable(),
      booked: amount(),
      proposed: amount(),
      loadPct: z.string().nullable(),
      words: z.string(),
      jobs: z.array(
        output({
          kind: z.enum(JOB_KINDS),
          id: id(),
          number: z.string().nullable(),
          status: z.string(),
          proposed: z.boolean(),
          workOrder: output({ id: id(), number: z.string().nullable() }).nullable(),
          style: z.string().nullable(),
          from: businessDate(),
          to: businessDate(),
          garments: z.number().int(),
          /** Its minutes or garments in these days (as the line's unit). */
          share: amount(),
          sharePct: z.string(),
        }),
      ),
    }),
  },
})

// ---- only approved workshops (PLN-162) -----------------------------------------------------------------------------------

const reason = <Codes extends readonly [string, ...string[]]>(codes: Codes) => output({ code: z.enum(codes), words: z.string() })
const verdictFields = { offered: z.boolean(), held: z.array(reason(HOLD_CODES)), warnings: z.array(reason(WARNING_CODES)) }
const durcView = output({ checked: z.boolean(), state: z.enum(['MET', 'EXPIRING', 'EXPIRED', 'MISSING']), expiresOn: businessDate().nullable() })
const workshopFields = {
  id: id(),
  code: z.string(),
  name: z.string(),
  location: output({ id: id(), code: z.string() }).nullable(),
  active: z.boolean(),
  supplierProblem: z.string().nullable(),
  durc: durcView,
  /** The next four weeks per capacity line. */
  capacity: z.array(output({ workCentreKind: z.string().nullable(), unit: z.enum(CAPACITY_UNITS).nullable(), available: amount().nullable(), booked: amount(), proposed: amount(), loadPct: z.string().nullable(), over: z.boolean() })),
}
const operationView = output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string(), workCentreKind: z.string(), outsourced: z.boolean(), subcontractOrderId: id().nullable(), outsideStep: z.boolean(), version: z.number().int() })

export const allocationWorkshopsContract = defineContract({
  querystring: input({ siteId: id() }),
  response: {
    200: output({
      site: output({ id: id(), companyId: id(), code: z.string(), name: z.string(), timeZone: z.string() }),
      today: businessDate(),
      asOf: instant(),
      window: output({ from: businessDate(), to: businessDate() }),
      workshops: z.array(output({ ...workshopFields, qualifications: z.array(output({ workCentreKind: z.string(), qualified: z.boolean(), standing: z.string(), words: z.string() })) })),
      workOrders: z.array(output({ workOrder: output({ id: id(), number: z.string(), status: z.string(), version: z.number().int() }), operations: z.array(operationView), workshops: z.array(output({ partyId: id(), ...verdictFields })) })),
    }),
  },
})

const workOrderParams = input({ workOrderId: id() })

export const workOrderWorkshopsContract = defineContract({
  params: workOrderParams,
  querystring: input({ operationIds: z.string().max(2000).optional() }),
  response: {
    200: output({
      workOrder: output({ id: id(), number: z.string(), status: z.string(), version: z.number().int(), garments: z.number().int(), style: z.string() }),
      asOf: instant(),
      operations: z.array(operationView),
      mayOutsource: z.boolean(),
      workshops: z.array(output({ ...workshopFields, routing: z.boolean(), ...verdictFields, operations: z.array(output({ operationId: id(), qualified: z.boolean(), standing: z.string(), words: z.string() })) })),
    }),
  },
})

// ---- kit timing (PLN-164) ------------------------------------------------------------------------------------------------

export const kitTimingContract = defineContract({
  params: workOrderParams,
  querystring: input({ partyId: id(), operationIds: z.string().max(2000).optional(), start: businessDate().optional(), pieces: z.coerce.number().int().min(1).optional() }),
  response: {
    200: output({
      workOrder: output({ id: id(), number: z.string(), status: z.string(), garments: z.number().int() }),
      workshop: named,
      operations: z.array(output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string(), workCentreKind: z.string() })),
      pieces: z.number().int(),
      start: businessDate(),
      startSource: z.enum(['GIVEN', 'SCHEDULE', 'TODAY']),
      transportDays: z.number().int(),
      transportSource: z.enum(['WORKSHOP', 'DEFAULT']),
      kitShipOn: businessDate(),
      kitDueAt: instant(),
      late: z.boolean(),
      words: z.string(),
      workDays: z.number().int(),
      workDaysSource: z.enum(['CAPACITY', 'ROUTING', 'DEFAULT']),
      backOn: businessDate(),
      closedDaysSkipped: z.number().int(),
      kit: output({ note: z.string().nullable(), lines: z.array(output({ item: named, colour: output({ id: id(), code: z.string() }).nullable(), quantity: z.string(), uom: z.string() })) }),
      laterOperations: z.array(output({ id: id(), seq: z.number().int(), name: z.string(), earliestStart: businessDate(), latestStart: businessDate().nullable(), finishesLate: z.boolean(), words: z.string() })),
      finishesLate: z.boolean(),
    }),
  },
})

export const setKitDueContract = defineContract({
  params: input({ subcontractOrderId: id() }),
  body: input({ version: version(), kitDueAt: instant().nullable() }),
  response: { 200: output({ order: output({ id: id(), number: z.string(), status: z.string(), version: z.number().int(), kitDueAt: instant().nullable() }) }) },
})

// ---- in-house or outside (PLN-165) ---------------------------------------------------------------------------------------

const operationParams = input({ workOrderId: id(), operationId: id() })
const switchedOperation = output({ id: id(), seq: z.number().int(), name: z.string(), version: z.number().int(), outsourced: z.boolean(), subcontractOrderId: id().nullable() })

export const outsideContract = defineContract({
  params: operationParams,
  body: input({
    version: version(),
    partyId: id(),
    /** Default: make the DRAFT subcontract order when the caller may and the work order is released; false: outside without one. */
    order: z.boolean().optional(),
    pieces: z.number().int().min(1).optional(),
    start: businessDate().optional(),
    expectedBackDate: businessDate().optional(),
    locationId: id().optional(),
  }),
  response: {
    200: output({
      operation: switchedOperation,
      workshop: named,
      order: output({ id: id(), number: z.string(), status: z.string(), kitDueAt: instant() }).nullable(),
      /** Why no order was made (null: it was). */
      orderWords: z.string().nullable(),
      timing: output({ start: businessDate(), kitShipOn: businessDate(), kitDueAt: instant(), late: z.boolean(), words: z.string(), backOn: businessDate() }),
      warnings: z.array(reason(WARNING_CODES)),
    }),
  },
})

export const inHouseContract = defineContract({
  params: operationParams,
  body: input({ version: version(), reason: z.string().trim().min(3).max(500) }),
  response: { 200: output({ operation: switchedOperation, order: output({ id: id(), number: z.string(), change: z.enum(['CANCELLED', 'OPERATION_REMOVED']).nullable() }).nullable() }) },
})

export const fromAllocationContract = defineContract({
  body: input({ siteId: id(), parts: z.array(input({ slotId: id() })).min(1).max(MAX_PARTS), preview: z.boolean().optional() }),
  response: {
    200: output({
      preview: z.boolean(),
      made: z.number().int(),
      held: z.number().int(),
      asOf: instant(),
      results: z.array(
        output({
          slotId: id(),
          ok: z.boolean(),
          workOrder: output({ id: id(), number: z.string() }).nullable(),
          workshop: named.nullable(),
          operations: z.array(output({ id: id(), seq: z.number().int(), name: z.string() })),
          pieces: z.number().int(),
          order: output({ id: id(), number: z.string(), status: z.string(), kitDueAt: instant() }).nullable(),
          kitShipOn: businessDate().nullable(),
          backOn: businessDate().nullable(),
          problems: z.array(z.string()),
          warnings: z.array(reason(WARNING_CODES)),
        }),
      ),
    }),
  },
})
