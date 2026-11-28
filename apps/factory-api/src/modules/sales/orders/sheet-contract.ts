import { z } from 'zod'
import { businessDate, defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { ORDER_LIFE } from '@nexus/factory-domain/sales/order-life'
import { SHEET_ASK_COLUMNS, SHEET_LINE_KINDS, SHEET_LIVES } from '@nexus/factory-domain/sales/orders-sheet/rules'

/**
 * owb-of1 (order workflow, plan.md § 5b, § 5c; the Shape FIXED in build/briefs/owb-of1.md — web A of3 and web B of5 code against it):
 * the office's ONE orders sheet over the Draft and Sent orders (PortalOrderRequest) and the confirmed ones (SalesOrder), and the
 * band of a Draft or Sent order. NO price field, for anybody (the design: prices are Finance's page) — so nothing here is marked
 * money and nothing may be.
 */

const picture = output({ fileId: id(), contentType: z.string(), small: z.boolean() })
const party = output({ id: id(), code: z.string(), name: z.string() })
const life = z.enum(ORDER_LIFE)

const ownValue = output({
  columnId: id(),
  name: z.string(),
  kind: z.enum(['TEXT', 'YES_NO', 'CHOICE', 'NUMBER', 'DATE']),
  value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
})

const sheetLine = output({
  id: id(),
  seq: z.number().int(),
  kind: z.enum(SHEET_LINE_KINDS),
  product: output({ styleId: id(), code: z.string(), name: z.string() }).nullable(),
  text: z.string().nullable(),
  material: z.string().nullable(),
  sizes: z.string().nullable(),
  sizeFileId: id().nullable(),
  pieces: z.number().int(),
  own: z.array(ownValue),
  asks: z.array(output({ requestId: id(), column: z.enum(SHEET_ASK_COLUMNS), from: z.string(), to: z.string() })),
})

const sheetRow = output({
  kind: z.enum(['ORDER', 'REQUEST']),
  id: id(),
  version: z.number().int(),
  /** ORDER: its number (SO-…); REQUEST: its own number (RQ-…, null while never sent) — an office number never on a REQUEST row. */
  number: z.string().nullable(),
  subject: z.string().nullable(),
  party,
  /** The base's key (factory-domain sales/order-life): the web draws it with StateChip only. */
  life,
  wantedFor: businessDate().nullable(),
  promised: businessDate().nullable(),
  daysLate: z.number().int().nullable(),
  /** ORDER only: the production's stage and health words' keys, and whether a work order is held. */
  where: output({ stage: z.string().nullable(), health: z.string().nullable(), held: z.boolean() }).nullable(),
  picture: picture.nullable(),
  news: output({
    unread: z.number().int(),
    openAsks: z.number().int(),
    openDetails: z.number().int(),
    sentAsText: z.boolean(),
    remakeOf: output({ id: id(), number: z.string() }).nullable(),
    withDesigner: z.boolean(),
    design: z.enum(['WAITS', 'APPROVED', 'CHANGE']).nullable(),
    problems: z.number().int(),
    late: z.boolean(),
    label: z.enum(['RECEIVED', 'WAITS']).nullable(),
    next: z.enum(['CONFIRM', 'PRINT', 'PRINT_AGAIN', 'SHIP']).nullable(),
    paymentNotices: z.number().int(),
  }),
  restricted: z.boolean(),
  customerOnHold: z.boolean(),
  pieces: z.number().int(),
  may: output({ confirm: z.boolean(), deleteDraft: z.boolean(), editLines: z.enum(['DRAFT', 'AMEND']).nullable() }),
  lines: z.array(sheetLine),
})

export const SHEET_LIMIT = 100

export const orderSheetContract = defineContract({
  querystring: input({
    life: z.enum(SHEET_LIVES).default('all'),
    q: z.string().trim().min(1).max(120).optional(),
    partyId: id().optional(),
    cursor: z.string().trim().min(1).max(80).optional(),
    limit: z.coerce.number().int().min(1).max(SHEET_LIMIT).default(50),
  }),
  response: {
    200: output({
      rows: z.array(sheetRow),
      tiles: output({ incoming: z.number().int(), waitingForPrint: z.number().int(), inProduction: z.number().int(), problems: z.number().int(), late: z.number().int(), readyToShip: z.number().int() }),
      nextCursor: z.string().nullable(),
    }),
  },
})

export type OrderSheetQuery = z.infer<typeof orderSheetContract.querystring>
export type SheetRowView = z.infer<typeof sheetRow>
export type SheetLineView = z.infer<typeof sheetLine>

// ---- the band of a Draft or Sent order (web B of5 frames today's /sales/orders/new?draft=<id> with it) -------------------------

export const requestBandContract = defineContract({
  params: input({ requestId: id() }),
  response: {
    200: output({
      id: id(),
      version: z.number().int(),
      number: z.string().nullable(),
      subject: z.string().nullable(),
      party,
      life,
      picture: picture.nullable(),
      /** What is still open (factory-domain portal-ordering stillOpenOf), and the A-5 holder: a line without a product. */
      open: output({
        count: z.number().int(),
        confirmHeld: z.boolean(),
        lines: z.array(output({ lineId: id(), seq: z.number().int(), what: z.enum(['PRODUCT', 'MATERIAL', 'SIZES', 'PIECES']) })),
      }),
      may: output({ confirm: z.boolean(), picture: z.boolean() }),
    }),
  },
})
