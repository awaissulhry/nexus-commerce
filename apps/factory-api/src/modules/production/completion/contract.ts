import { z } from 'zod'
import { periodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { MAX_CELL_PIECES, MAX_CELLS } from '@nexus/factory-domain/production/work-orders/cells'
import { WORK_ORDER_KINDS, WORK_ORDER_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'

/**
 * Report finished to stock (B-W2a-12; GAP-003, MES-011; design production.workorders pop-up "Report finished to stock"):
 * whole garments per cell. No money anywhere: a receipt's value is the stock ledger's (cost grain).
 */

const params = input({ workOrderId: id() })

export const completionSchema = output({
  workOrderId: id(),
  number: z.string(),
  batchNumber: z.string().nullable(),
  kind: z.enum(WORK_ORDER_KINDS),
  status: z.enum(WORK_ORDER_STATUSES),
  version: z.number().int(),
  siteId: id(),
  siteCode: z.string(),
  /** What stops a report on the whole work order, in words (empty: nothing). */
  blockers: z.array(z.string()),
  /** No blocker, and at least one garment can go into stock. */
  reportable: z.boolean(),
  /** The site's finished-goods places (FINISHED_GOODS locations and places inside them). */
  places: z.array(output({ id: id(), code: z.string(), name: z.string(), kind: z.string(), parentId: id().nullable(), status: z.string() })),
  /** Where a report goes when none is named: the site's one FINISHED_GOODS location. */
  defaultLocationId: id().nullable(),
  cells: z.array(
    output({
      cellId: id(),
      colourwayId: id(),
      colourwayCode: z.string(),
      colourwayName: z.string(),
      size: z.string(),
      sku: z.string().nullable(),
      /** Its FINISHED item, once one was made (the first report of the SKU makes it). */
      itemId: id().nullable(),
      quantity: z.number().int(),
      released: z.number().int(),
      reversed: z.number().int(),
      netReleased: z.number().int(),
      onShipments: z.number().int(),
      heldSerials: z.number().int(),
      inStock: z.number().int(),
      canReport: z.number().int(),
      /** Why nothing more can be reported, in words (null while something can). */
      why: z.string().nullable(),
    }),
  ),
  /** Garments summed over the cells. */
  garments: output({ pieces: z.number().int(), netReleased: z.number().int(), inStock: z.number().int(), canReport: z.number().int() }),
  /** Every garment of every cell is in finished goods (the record may offer to complete the work order). */
  allInStock: z.boolean(),
  tracking: z.enum(['BATCH', 'SERIAL']),
  valuation: z.string(),
  /** The reports to stock, newest first. */
  reports: z.array(
    output({
      id: id(),
      at: instant(),
      byId: id().nullable(),
      locationId: id(),
      locationCode: z.string().nullable(),
      note: z.string().nullable(),
      cells: z.array(output({ moveId: id(), cellId: id().nullable(), label: z.string(), itemId: id(), quantity: z.number().int(), reversedById: id().nullable() })),
      pieces: z.number().int(),
      /** Garments of it still counted in stock (not taken back). */
      open: z.number().int(),
      reversed: output({ at: instant(), byId: id().nullable(), reason: z.string().nullable() }).nullable(),
    }),
  ),
})

export const finishedContract = defineContract({ params, response: { 200: output({ finished: completionSchema }) } })

export const reportContract = defineContract({
  params,
  body: input({
    /** Per cell the garments to report (MES-011: part of what is released); left out: every cell, all it can. */
    cells: z.array(input({ cellId: id(), quantity: z.number().int().min(1).max(MAX_CELL_PIECES) })).min(1).max(MAX_CELLS).optional(),
    toLocationId: id().optional(),
    note: z.string().trim().max(500).nullish(),
    periodLockOverride: periodLockOverride.optional(),
  }),
  response: {
    201: output({
      report: output({
        id: id(),
        locationId: id(),
        locationCode: z.string(),
        moveIds: z.array(id()),
        cells: z.array(output({ workOrderSizeId: id(), itemId: id(), quantity: z.number().int() })),
        pieces: z.number().int(),
        /** Every receipt was valued (a standard cost exists for each SKU). */
        valued: z.boolean(),
      }),
      finished: completionSchema,
    }),
  },
})

export const reverseContract = defineContract({
  params: input({ workOrderId: id(), reportId: id() }),
  body: input({ reason: z.string().trim().min(3).max(500) }),
  response: {
    200: output({
      reversed: output({ reportId: id(), moveIds: z.array(id()), pieces: z.number().int() }),
      /** The SKUs left with more reserved than available (released by a person). */
      overReserved: z.array(output({ itemId: id(), available: z.string(), reserved: z.string() })),
      finished: completionSchema,
    }),
  },
})
