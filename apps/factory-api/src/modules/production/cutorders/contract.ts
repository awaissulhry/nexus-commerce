import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { LENGTH_UOMS, ROLL_STATES } from '@nexus/factory-domain/inventory/rolls/rolls'
import { ALLOCATION_REFUSALS, ALLOCATION_WARNINGS } from '@nexus/factory-domain/production/cutorders/allocation'
import { MAX_STICKERS_PER_RUN, PLY_LIMITS } from '@nexus/factory-domain/production/cutorders/plies'
import { CUT_ORDER_KINDS, CUT_ORDER_LIMITS, CUT_ORDER_STATUSES, CUT_TICKET_STATUSES, LAY_STATUSES, PLY_RUN_STATUSES } from '@nexus/factory-domain/production/cutorders/rules'
import { MAX_TICKET_COPIES, TICKET_REFUSALS } from '@nexus/factory-domain/production/cutorders/tickets'
import { printJobView } from '../../../platform/print/contract'
import { CUT_ORDER_VIEWS } from './read'

/**
 * Cut orders and cut tickets (B-W2b-112; MES-034, MES-037, MES-041, MES-043): the contracts of read.ts, plan.ts, allocate.ts,
 * tickets.ts and plies.ts. Lengths are decimal strings in the unit beside them; a day is YYYY-MM-DD, an instant ISO 8601 UTC. No
 * money; no person (nothing names who planned, spread, cut or numbered beyond the audit).
 */

const words = output({ it: z.string(), en: z.string() })
const ref = output({ id: id(), code: z.string(), name: z.string() })
const decimal = () => z.string().trim().regex(/^\d{1,14}(\.\d{1,4})?$/, 'A decimal of 0 or more, at most four decimals.')
const language = z.enum(['it', 'en'])
const reason = z.string().trim().min(1).max(CUT_ORDER_LIMITS.reason)
const version = z.number().int().min(1)
const job = printJobView.nullable()

export const ticketView = output({
  id: id(),
  number: z.string(),
  /** What the label's barcode says (the ticket's number). */
  code: z.string(),
  status: z.enum(CUT_TICKET_STATUSES),
  cutOrderId: id(),
  layId: id().nullable(),
  laySeq: z.number().int().nullable(),
  printedAt: instant().nullable(),
  startedAt: instant().nullable(),
  doneAt: instant().nullable(),
  voidedAt: instant().nullable(),
  voidReason: z.string().nullable(),
  version: z.number().int(),
})

export const plyRunView = output({
  id: id(),
  layId: id(),
  seq: z.number().int(),
  firstPly: z.number().int(),
  lastPly: z.number().int(),
  parts: z.array(z.string()),
  labelCount: z.number().int(),
  status: z.enum(PLY_RUN_STATUSES),
  printedAt: instant().nullable(),
  voidedAt: instant().nullable(),
  voidReason: z.string().nullable(),
  version: z.number().int(),
})

export const layRollView = output({
  id: id(),
  seq: z.number().int(),
  rollId: id(),
  code: z.string(),
  lotCode: z.string(),
  plies: z.number().int(),
  splices: z.number().int(),
  endLoss: z.string(),
  endReturned: z.string(),
  state: z.enum(ROLL_STATES),
  lengthLeft: z.string(),
  uom: z.enum(LENGTH_UOMS),
  widthCm: z.string().nullable(),
  shade: z.string().nullable(),
  shadeGroupId: id().nullable(),
  shrinkageGroup: z.string().nullable(),
  version: z.number().int(),
})

export const cutOrderSummary = output({
  id: id(),
  number: z.string(),
  kind: z.enum(CUT_ORDER_KINDS),
  status: z.enum(CUT_ORDER_STATUSES),
  companyId: id(),
  siteId: id(),
  material: output({ item: ref, colour: ref.nullable() }),
  workOrders: z.array(output({ id: id(), number: z.string() })),
  styles: z.array(ref),
  /** Garments its lines cut. */
  garments: z.number().int(),
  /** FABRIC: the plies of the marker; null for leather. */
  plies: z.number().int().nullable(),
  /** Lays not cancelled: how many, cut, still open. */
  lays: output({ count: z.number().int(), cut: z.number().int(), open: z.number().int() }),
  tickets: output({ open: z.number().int(), started: z.number().int(), done: z.number().int() }),
  station: ref.nullable(),
  dueDate: z.string().nullable(),
  releasedAt: instant().nullable(),
  cutAt: instant().nullable(),
  createdAt: instant(),
  version: z.number().int(),
  /** "2 lays · 60 plies · 360 garments" (it "2 materassi · 60 strati · 360 capi"). */
  words,
})

const warning = output({ code: z.enum(ALLOCATION_WARNINGS), message: z.string() })

export const cutOrderRecord = output({
  cutOrder: cutOrderSummary.extend({
    marker: output({ name: z.string(), length: z.string().nullable(), uom: z.enum(LENGTH_UOMS).nullable(), widthCm: z.string().nullable(), fileId: id().nullable(), ratio: z.string(), garmentsPerPly: z.number().int() }).nullable(),
    markerName: z.string().nullable(),
    note: z.string().nullable(),
    cancelReason: z.string().nullable(),
    cancelledAt: instant().nullable(),
    reconciledAt: instant().nullable(),
  }),
  lines: z.array(
    output({
      id: id(),
      seq: z.number().int(),
      workOrder: output({ id: id(), number: z.string(), batchNumber: z.string().nullable(), status: z.string(), holdReason: z.string().nullable(), dueDate: z.string().nullable() }),
      style: ref,
      colourway: ref,
      workOrderSizeId: id(),
      size: z.string(),
      cellQuantity: z.number().int(),
      quantity: z.number().int(),
      ratio: z.number().int().nullable(),
      plies: z.number().int().nullable(),
      version: z.number().int(),
    }),
  ),
  lays: z.array(
    output({
      id: id(),
      seq: z.number().int(),
      plies: z.number().int(),
      status: z.enum(LAY_STATUSES),
      layLength: z.string().nullable(),
      lengthUom: z.string().nullable(),
      /** The plies counted at both ends (CHECKED, CUT). */
      counted: z.number().int().nullable(),
      checkedAt: instant().nullable(),
      cutAt: instant().nullable(),
      cancelledAt: instant().nullable(),
      cancelReason: z.string().nullable(),
      note: z.string().nullable(),
      version: z.number().int(),
      /** Plies its rolls give (allocated or spread). */
      allocated: z.number().int(),
      shade: z.string().nullable(),
      shrinkageGroup: z.string().nullable(),
      rolls: z.array(layRollView),
      ticket: ticketView.nullable(),
      plyRuns: z.array(plyRunView),
    }),
  ),
  tickets: z.array(ticketView),
  warnings: z.array(warning),
  can: output({ edit: z.boolean(), release: z.boolean(), backToPlanning: z.boolean(), cancel: z.boolean(), allocate: z.boolean() }),
})

const cutOrderParams = input({ cutOrderId: id() })
const markerBody = input({
  name: z.string().trim().min(1).max(CUT_ORDER_LIMITS.markerName),
  length: decimal(),
  uom: z.enum(LENGTH_UOMS),
  widthCm: decimal().nullish(),
  fileId: id().nullish(),
})
const planShape = {
  stationId: id().nullish(),
  dueDate: businessDate().nullish(),
  note: z.string().max(CUT_ORDER_LIMITS.note).nullish(),
  marker: markerBody.nullish(),
  plies: z.number().int().min(1).max(CUT_ORDER_LIMITS.plies).optional(),
  lays: z.array(z.number().int().min(1).max(CUT_ORDER_LIMITS.pliesPerLay)).min(1).max(CUT_ORDER_LIMITS.lays).optional(),
  lines: z
    .array(input({ workOrderSizeId: id(), quantity: z.number().int().min(1).max(100_000).optional(), ratio: z.number().int().min(1).max(CUT_ORDER_LIMITS.ratio).optional() }))
    .min(1)
    .max(CUT_ORDER_LIMITS.lines),
}

export const listCutOrdersContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    view: z.enum(CUT_ORDER_VIEWS).optional(),
    kind: z.enum(CUT_ORDER_KINDS).optional(),
    q: z.string().trim().min(1).max(60).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: id().optional(),
  }),
  response: {
    200: output({
      rows: z.array(cutOrderSummary),
      nextCursor: id().nullable(),
      /** Counts per status over the scope (and site, kind): the Cutting tiles. */
      tiles: output({ planned: z.number().int(), released: z.number().int(), cutting: z.number().int(), cut: z.number().int(), cancelled: z.number().int() }),
    }),
  },
})

export const waitingCellsContract = defineContract({
  querystring: input({ siteId: id().optional(), itemId: id().optional(), itemColourId: id().optional() }),
  response: {
    200: output({
      groups: z.array(
        output({
          kind: z.enum(CUT_ORDER_KINDS),
          siteId: id(),
          item: ref,
          colour: ref.nullable(),
          garmentsLeft: z.number().int(),
          cells: z.array(
            output({
              workOrderSizeId: id(),
              workOrder: output({ id: id(), number: z.string(), status: z.string(), dueDate: z.string().nullable() }),
              style: ref,
              colourway: ref,
              size: z.string(),
              quantity: z.number().int(),
              /** Garments live cut orders of the material already cut of it. */
              onCutOrders: z.number().int(),
              left: z.number().int(),
            }),
          ),
        }),
      ),
    }),
  },
})

export const cutOrderRecordContract = defineContract({ params: cutOrderParams, response: { 200: cutOrderRecord } })

export const createCutOrderContract = defineContract({
  body: input({ siteId: id(), kind: z.enum(CUT_ORDER_KINDS), itemId: id(), itemColourId: id().nullish(), ...planShape }),
  response: { 201: cutOrderRecord },
})

export const replanCutOrderContract = defineContract({ params: cutOrderParams, body: input({ version, ...planShape }), response: { 200: cutOrderRecord } })
export const releaseCutOrderContract = defineContract({ params: cutOrderParams, body: input({ version }), response: { 200: cutOrderRecord } })
export const unreleaseCutOrderContract = defineContract({ params: cutOrderParams, body: input({ version, reason }), response: { 200: cutOrderRecord } })
export const cancelCutOrderContract = defineContract({ params: cutOrderParams, body: input({ version, reason }), response: { 200: cutOrderRecord } })

// ---- rolls --------------------------------------------------------------------------------------------------------------------

const allowanceCm = z.coerce.number().int().min(0).max(CUT_ORDER_LIMITS.allowanceCm)

export const rollCandidatesContract = defineContract({
  params: cutOrderParams,
  querystring: input({ allowanceCm: allowanceCm.optional() }),
  response: {
    200: output({
      marker: output({ name: z.string(), length: z.string(), uom: z.enum(LENGTH_UOMS), widthCm: z.string().nullable() }),
      allowanceCm: z.number().int(),
      /** One ply off a roll: the marker and the allowance, in metres. */
      perPlyMetres: z.string(),
      rolls: z.array(
        output({
          id: id(),
          code: z.string(),
          supplierRollRef: z.string().nullable(),
          state: z.enum(ROLL_STATES),
          uom: z.enum(LENGTH_UOMS),
          length: z.string(),
          lengthLeft: z.string(),
          /** What lays not yet spread plan from it (their plies × their marker), in its unit. */
          planned: z.string(),
          widthCm: z.string().nullable(),
          shade: z.string().nullable(),
          shadeGroup: output({ id: id(), label: z.string(), outOfShade: z.boolean() }).nullable(),
          shrinkageGroup: z.string().nullable(),
          shrinkageLengthPercent: z.string().nullable(),
          shrinkageWidthPercent: z.string().nullable(),
          lot: output({ id: id(), code: z.string(), dyeBatch: z.string().nullable(), qualityStatus: z.string() }),
          location: output({ id: id(), code: z.string() }).nullable(),
          /** Whole plies of the marker it still gives (0 when refused). */
          plies: z.number().int(),
          allocatedTo: z.array(output({ cutOrderNumber: z.string(), laySeq: z.number().int(), plies: z.number().int() })),
          refusal: output({ code: z.enum(ALLOCATION_REFUSALS), message: z.string() }).nullable(),
          warnings: z.array(warning),
        }),
      ),
      /** The rolls that fit, per shade and shrinkage group: rolls and the plies they give. */
      groups: z.array(output({ shade: z.string().nullable(), shadeGroupId: id().nullable(), shrinkageGroup: z.string().nullable(), rolls: z.number().int(), plies: z.number().int() })),
      lays: z.array(output({ id: id(), seq: z.number().int(), plies: z.number().int(), allocated: z.number().int(), proposable: z.boolean() })),
      /** Each PLANNED lay filled from one shade and shrinkage group (ends and part rolls first). */
      proposal: z.array(output({ layId: id(), seq: z.number().int(), need: z.number().int(), rolls: z.array(output({ rollId: id(), code: z.string(), plies: z.number().int() })), short: z.number().int() })),
      words,
      warnings: z.array(warning),
    }),
  },
})

const layParams = input({ cutOrderId: id(), layId: id() })

export const allocateRollsContract = defineContract({
  params: layParams,
  body: input({
    version,
    rolls: z.array(input({ rollId: id(), plies: z.number().int().min(1).max(CUT_ORDER_LIMITS.pliesPerLay) })).min(1).max(30),
    allowanceCm: z.number().int().min(0).max(CUT_ORDER_LIMITS.allowanceCm).optional(),
  }),
  response: { 201: cutOrderRecord.extend({ allocation: output({ layId: id(), allocated: z.number().int(), warnings: z.array(warning) }) }) },
})

export const removeLayRollContract = defineContract({
  params: input({ cutOrderId: id(), layId: id(), layRollId: id() }),
  body: input({ version }),
  response: { 200: cutOrderRecord },
})

// ---- tickets ------------------------------------------------------------------------------------------------------------------

const material = output({ item: output({ code: z.string(), name: z.string() }), colour: output({ code: z.string(), name: z.string() }).nullable() })

export const waitingTicketsContract = defineContract({
  querystring: input({ siteId: id().optional() }),
  response: {
    200: output({
      tickets: z.array(
        ticketView.extend({
          cutOrder: output({ id: id(), number: z.string(), kind: z.enum(CUT_ORDER_KINDS), marker: z.string().nullable(), dueDate: z.string().nullable(), material }),
          lay: output({ id: id(), seq: z.number().int(), plies: z.number().int(), status: z.enum(LAY_STATUSES) }).nullable(),
          ratio: z.string(),
          styles: z.array(z.string()),
        }),
      ),
    }),
  },
})

const ticketCard = output({
  ticket: ticketView,
  cutOrder: output({
    id: id(),
    number: z.string(),
    kind: z.enum(CUT_ORDER_KINDS),
    status: z.enum(CUT_ORDER_STATUSES),
    material: output({ item: ref, colour: ref.nullable() }),
    marker: output({ name: z.string(), length: z.string(), uom: z.enum(LENGTH_UOMS), widthCm: z.string().nullable(), words }).nullable(),
    /** The size ratio as size chips read it: "46:1 · 48:2". */
    ratio: z.string().nullable(),
    plies: z.number().int().nullable(),
    garments: z.number().int(),
    dueDate: z.string().nullable(),
    station: ref.nullable(),
    words,
  }),
  lay: output({ id: id(), seq: z.number().int(), of: z.number().int(), plies: z.number().int(), status: z.enum(LAY_STATUSES), counted: z.number().int().nullable(), version: z.number().int(), rolls: z.array(layRollView) }).nullable(),
  lines: z.array(output({ workOrder: output({ id: id(), number: z.string() }), style: ref, colourway: ref, size: z.string(), ratio: z.number().int().nullable(), quantity: z.number().int() })),
  /** The parts ply stickers number by default (the pattern's pieces of this material). */
  parts: z.array(z.string()),
  plyRuns: z.array(plyRunView),
  next: output({ next: z.enum(['START', 'FINISH', 'NONE']), refusal: output({ code: z.enum(TICKET_REFUSALS), message: z.string() }).nullable(), words }),
})

export const scanTicketContract = defineContract({ querystring: input({ code: z.string().trim().min(1).max(60) }), response: { 200: ticketCard } })

const scanBody = input({ code: z.string().trim().min(1).max(60) })
export const startTicketContract = defineContract({ body: scanBody, response: { 200: ticketCard.extend({ replayed: z.boolean() }) } })
export const finishTicketContract = defineContract({ body: scanBody, response: { 200: ticketCard.extend({ replayed: z.boolean() }) } })

const ticketParams = input({ ticketId: id() })
export const voidTicketContract = defineContract({
  params: ticketParams,
  body: input({ version, reason, replace: z.boolean().optional() }),
  response: { 200: output({ voided: ticketView, replacement: ticketView.nullable() }) },
})

const labelLines = output({ heading: z.string(), title: z.string(), fields: z.array(output({ label: z.string(), value: z.string() })) })

export const printTicketContract = defineContract({
  params: ticketParams,
  body: input({ printerId: id().nullish(), copies: z.number().int().min(1).max(MAX_TICKET_COPIES).optional(), language: language.optional() }),
  response: { 200: output({ ticket: ticketView, label: labelLines, job, problem: z.string().nullable() }) },
})

// ---- ply runs -------------------------------------------------------------------------------------------------------------------

const stickerText = z.tuple([z.string(), z.string(), z.string()])

export const makePlyRunContract = defineContract({
  params: input({ layId: id() }),
  body: input({
    parts: z.array(z.string().trim().min(1).max(PLY_LIMITS.part)).min(1).max(PLY_LIMITS.parts).optional(),
    firstPly: z.number().int().min(1).max(CUT_ORDER_LIMITS.pliesPerLay).optional(),
    lastPly: z.number().int().min(1).max(CUT_ORDER_LIMITS.pliesPerLay).optional(),
    printerId: id().nullish(),
    language: language.optional(),
  }),
  response: { 201: output({ run: plyRunView, stickersPerPly: z.number().int(), preview: z.array(stickerText), job, problem: z.string().nullable() }) },
})

const runParams = input({ runId: id() })
export const reprintPlyRunContract = defineContract({
  params: runParams,
  body: input({ printerId: id().nullish(), language: language.optional() }),
  response: { 200: output({ run: plyRunView, job, problem: z.string().nullable() }) },
})
export const voidPlyRunContract = defineContract({ params: runParams, body: input({ version, reason }), response: { 200: output({ run: plyRunView }) } })
export const plyRunStickersContract = defineContract({
  params: runParams,
  querystring: input({ language: language.optional() }),
  response: {
    200: output({
      run: plyRunView,
      stickers: z
        .array(output({ ply: z.number().int(), size: z.string(), garment: z.number().int(), garments: z.number().int(), part: z.string(), piece: z.number().int(), pieces: z.number().int(), lines: stickerText }))
        .max(MAX_STICKERS_PER_RUN),
    }),
  },
})

