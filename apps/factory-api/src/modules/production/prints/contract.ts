import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { PRINT_AGAIN_REASONS, SMALL_CHANGE_NOTE_MAX } from '@nexus/factory-domain/production/print-start/prints'

/**
 * "Print again" and the print sheet (owb- order workflow, S3 ss2 step 2.3; the Shape of build/briefs/owb-ss2.md + S3 lead settle
 * 09:13, FIXED: web A ss4 codes against it). No money, no customer name: the customer's CODE only.
 */

const orderParams = input({ orderId: id() })

export const printAgainContract = defineContract({
  params: orderParams,
  body: input({
    reason: z.enum(PRINT_AGAIN_REASONS),
    /** Required on SMALL_CHANGE (the floor reads it with the design). */
    note: z.string().trim().max(SMALL_CHANGE_NOTE_MAX).nullish(),
    pages: z.array(input({ salesOrderLineId: id(), page: z.number().int().min(1).max(500) })).max(200),
    cards: z.array(input({ bundleId: id() })).max(2000),
  }),
  response: { 201: output({ printId: id(), printNo: z.number().int(), solvedCalls: z.number().int() }) },
})

const step = output({ departmentNumber: z.number().int(), shortName: z.string(), name: z.string(), nameUr: z.string().nullable(), tone: z.string(), icon: z.string() })

export const printSheetContract = defineContract({
  params: orderParams,
  /** Left out: the order's current sheet for "Print again" (every page, every ACTIVE basket card of its FIRST print). */
  querystring: input({ printId: id().optional() }),
  response: {
    200: output({
      printId: id(),
      kind: z.enum(['FIRST', 'AGAIN']),
      printedAt: instant(),
      order: output({ number: z.string(), customerCode: z.string(), dueDate: z.string().nullable() }),
      pages: z.array(
        output({
          salesOrderLineId: id(),
          label: z.string(),
          styleCode: z.string(),
          fileId: id(),
          page: z.number().int(),
          contentType: z.string(),
          /** The work order number (the traveller's QR form). */
          qr: z.string(),
          workOrderNumber: z.string(),
          /** null: the usual place, top right, 20 mm. */
          placement: output({ xMm: z.number(), yMm: z.number(), sizeMm: z.number() }).nullable(),
          printNo: z.number().int(),
        }),
      ),
      cards: z.array(
        output({
          bundleId: id(),
          code: z.string(),
          basketNo: z.string(),
          pieces: z.number().int(),
          styleCode: z.string(),
          label: z.string(),
          pictureFileId: id().nullable(),
          customerCode: z.string(),
          dueDate: z.string().nullable(),
          printNo: z.number().int(),
          steps: z.array(step),
          /** Its garments left, or its work order is closed or cancelled: never printed again (S3 lead settle 09:13). */
          shipped: z.boolean(),
        }),
      ),
    }),
  },
})

// ---- owb-ss2b: Place the scan code (the Shape of build/briefs/owb-ss2.md § owb-ss2b, FIXED) ------------------------------------------

const placementView = output({
  salesOrderLineId: id(),
  fileId: id(),
  page: z.number().int(),
  xMm: z.number(),
  yMm: z.number(),
  sizeMm: z.number(),
  version: z.number().int(),
  placedAt: instant(),
  placedBy: output({ name: z.string() }),
})

export const listPlacementsContract = defineContract({ params: orderParams, response: { 200: output({ placements: z.array(placementView) }) } })

export const savePlacementContract = defineContract({
  params: input({ orderId: id(), salesOrderLineId: id() }),
  body: input({
    fileId: id(),
    page: z.number().int().min(1).max(500),
    xMm: z.number().min(0).max(2000),
    yMm: z.number().min(0).max(2000),
    sizeMm: z.number().min(0).max(2000),
    pageWidthMm: z.number().max(2000),
    pageHeightMm: z.number().max(2000),
    /** The place's version as read (a second save moves it); left out for a new place. */
    version: z.number().int().min(1).optional(),
  }),
  response: { 200: placementView },
})
