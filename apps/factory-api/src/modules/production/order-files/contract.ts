import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * B-PR-44: the order files of a work order (one group per order its cells make) and the walled opening of one of them. A file
 * opens ONLY through `…/order-files/:fileId/open`; a worksheet through the made-to-measure route
 * `POST /sales/mtm/profiles/:profileId/worksheets/:documentId/open` (sales.measurements.view, each opening recorded).
 */

const params = input({ workOrderId: id() })

const lineRef = output({ id: id(), seq: z.number().int() })

/** One file of the order, of one of its lines, or of the quote line a line was made from (its artwork). */
export const orderFileView = output({
  id: id(),
  from: z.enum(['ORDER', 'LINE', 'QUOTE_LINE']),
  /** The order line it is of (null: a file of the order itself). */
  line: lineRef.nullable(),
  name: z.string(),
  contentType: z.string(),
  kind: z.string(),
  category: z.string().nullable(),
  sizeBytes: z.number().int(),
  versionNo: z.number().int(),
  /** When it became available. */
  at: instant(),
  /** A measurement sheet or a body photo (listed only with the measurements right; each opening recorded). */
  bodyData: z.boolean(),
})

/** The newest version of a made-to-measure line's worksheet (opened by the made-to-measure route). */
export const worksheetView = output({
  documentId: id(),
  /** The measurement profile revision the line is made to (the route's :profileId). */
  profileId: id(),
  line: lineRef,
  version: z.number().int(),
  number: z.string().nullable(),
  language: z.string(),
  createdAt: instant(),
})

export const orderFilesGroupView = output({
  /** F-PR-25 (threads ask, T9): `companyId` = the order's own company, so the docked order thread opens on the order's record scope. */
  order: output({ id: id(), number: z.string(), customerRef: z.string().nullable(), status: z.string(), orderDate: businessDate(), companyId: id() }),
  /** "Order thread": the sales order's thread (threadId null: none yet); null when the reader may not read it. */
  thread: output({ recordType: z.literal('SalesOrder'), recordId: id(), threadId: id().nullable() }).nullable(),
  /** Newest first. */
  files: z.array(orderFileView),
  worksheets: z.array(worksheetView),
  /** Worksheets and body-data files left out: the reader lacks sales.measurements.view (counted, never named). */
  measurementsLeftOut: z.number().int(),
  /** Files of a company the reader does not read files of (counted, never named). */
  filesLeftOut: z.number().int(),
})

export const orderFilesContract = defineContract({
  params,
  response: {
    200: output({
      workOrder: output({ id: id(), number: z.string() }),
      groups: z.array(orderFilesGroupView),
      /** Orders whose customer's files the reader does not read (a legacy mixed work order; files.read limited): counted only. */
      ordersLeftOut: z.number().int(),
    }),
  },
})

export const openOrderFileContract = defineContract({
  params: input({ workOrderId: id(), fileId: id() }),
  /** `preview` (default): a picture or a PDF opens in the browser (`inline`), any other kind downloads; `download`: always as a file. */
  body: input({ mode: z.enum(['preview', 'download']).optional() }).optional(),
  response: {
    200: output({
      file: output({ id: id(), name: z.string(), contentType: z.string() }),
      open: output({ mode: z.enum(['inline', 'download']), method: z.literal('GET'), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: instant() }),
    }),
  },
})
