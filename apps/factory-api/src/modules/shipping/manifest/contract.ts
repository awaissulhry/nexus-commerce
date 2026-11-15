import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { DAY_SHEET_REFUSALS } from '@nexus/factory-domain/shipping/manifest/rules'
import { SHIPMENT_STATUSES } from '@nexus/factory-domain/shipping/shipments'
import { notMoney } from '@nexus/factory-domain/money/marked'
import { fileView, presignedView } from '../../../platform/files/contract'

/**
 * The day's close (B-W2b-395; LOG-049; design warehouse.shipments pop-up "End of day" (per carrier: parcels handed over today;
 * the manifest preview; "Close the day and print manifests") and the "End-of-day manifest PDF" window). No money; no person of
 * ours (who closed a sheet: PERSON with their id, or SYSTEM).
 */

const refusal = output({ code: z.enum(DAY_SHEET_REFUSALS), message: z.string() })

const sheetShipment = output({
  id: id(),
  number: z.string(),
  consignee: z.string(),
  city: z.string(),
  country: z.string(),
  parcels: z.number().int(),
  /** Kilograms, 3 places. */
  weightKg: z.string(),
  trackingNumbers: z.array(z.string()),
  ddtNumber: z.string().nullable(),
  shippedAt: instant().nullable(),
  /** It left on a day before (after that day's sheet had closed): a late hand-over. */
  earlier: z.boolean(),
})

/** Shipments, parcels and their weight (kilograms, 3 places): counts, not money. */
const counts = output({ shipments: z.number().int(), parcels: z.number().int(), weightKg: z.string() })

const sheetState = output({
  id: id(),
  state: z.enum(['OPEN', 'CLOSED']),
  closedAt: instant().nullable(),
  closedBy: z.enum(['PERSON', 'SYSTEM']).nullable(),
  closedById: id().nullable(),
  /** The sheet as closed (its PDF); null while open. */
  fileId: id().nullable(),
  documentId: id().nullable(),
  version: z.number().int(),
})

const carrierDay = output({
  carrierCode: z.string(),
  carrierName: z.string(),
  /** Null: no sheet yet (the close makes it). */
  sheet: sheetState.nullable(),
  /** On the sheet (closed), or what the close puts on it (open or none). */
  shipments: z.array(sheetShipment),
  /** The sheet is closed: these left after it closed and go on the next day's sheet. */
  waiting: z.array(sheetShipment),
  /** On the open sheet but never left: let go at the close. */
  letGo: z.array(output({ id: id(), number: z.string(), status: z.enum(SHIPMENT_STATUSES) })),
  /** Packed with this carrier at the dock now, not left (today only): ship them before closing, or they wait for the next sheet. */
  stillPacked: z.array(output({ id: id(), number: z.string(), parcels: z.number().int() })),
  totals: notMoney(counts),
  may: output({ close: output({ allowed: z.boolean(), refusal: refusal.nullable() }) }),
})

export const endOfDayContract = defineContract({
  querystring: input({ siteId: id(), day: businessDate().optional() }),
  response: {
    200: output({
      siteId: id(),
      companyId: id(),
      site: output({ code: z.string(), name: z.string(), timeZone: z.string() }),
      day: z.string(),
      today: z.string(),
      carriers: z.array(carrierDay),
      toClose: z.array(z.string()),
    }),
  },
})

/** The PDF itself (application/pdf). */
export const previewSheetContract = defineContract({ querystring: input({ siteId: id(), carrierCode: z.string().min(1).max(40), day: businessDate().optional() }), response: {} })

export const closeDayContract = defineContract({
  body: input({
    siteId: id(),
    day: businessDate().optional(),
    /** Default: every carrier with something to close that day. */
    carrierCodes: z.array(z.string().min(1).max(40)).max(50).optional(),
    /** One print job per sheet on the site's A4 printer (default true). */
    print: z.boolean().optional(),
    printerId: id().optional(),
  }),
  response: {
    200: output({
      siteId: id(),
      day: z.string(),
      outcomes: z.array(
        output({
          carrierCode: z.string(),
          closed: z.boolean(),
          manifestId: id().optional(),
          documentId: id().optional(),
          fileId: id().optional(),
          shipments: z.number().int().optional(),
          parcels: z.number().int().optional(),
          letGo: z.array(z.string()).optional(),
          refusal: refusal.optional(),
          printJob: output({ id: id(), status: z.string() }).nullable(),
          printProblem: z.string().nullable(),
        }),
      ),
    }),
  },
})

export const getManifestContract = defineContract({
  params: input({ manifestId: id() }),
  response: {
    200: output({
      manifest: output({
        id: id(),
        siteId: id(),
        companyId: id(),
        site: output({ code: z.string(), name: z.string() }),
        carrierCode: z.string(),
        carrierName: z.string(),
        day: z.string(),
        state: z.enum(['OPEN', 'CLOSED']),
        closedAt: instant().nullable(),
        closedBy: z.enum(['PERSON', 'SYSTEM']).nullable(),
        closedById: id().nullable(),
        fileId: id().nullable(),
        documentId: id().nullable(),
        version: z.number().int(),
        shipments: z.array(sheetShipment),
        totals: notMoney(counts),
      }),
    }),
  },
})

export const downloadManifestContract = defineContract({ params: input({ manifestId: id() }), response: { 200: output({ file: fileView, download: presignedView }) } })
