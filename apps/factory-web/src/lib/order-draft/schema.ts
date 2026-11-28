import { z } from 'zod'
// F-CP-154 (B-CP-075, B-CP-076): the kinds of a draft line, how a person is measured, the parts of the checklist.
import { PROBLEM_PARTS } from '@nexus/factory-domain/sales/portal-ordering/office'
import { MEASURE_BY } from '@nexus/factory-domain/sales/portal-ordering/people'
import { CUSTOM_LINE_KINDS } from '@nexus/factory-domain/sales/portal-ordering/rules'
import { PROBLEM_CODES } from '@nexus/factory-domain/sales/portal-ordering/rules' // B-CP-075: the domain's codes, one source
// owb-po3: the ONE lines table's shapes (own columns, a line taken out) — read as optional until the server's owb-po1 lands.
import { recordOwnColumnsSchema, removedLineSchema } from '../order-lines/schema'

/**
 * The ONE draft order's record (THE SIMPLE ORDER START, od-w1.1): the shapes both doors read — the portal's
 * `GET /portal/order-requests/:id` and the office's `GET /sales/order-requests/:id/draft` answer the same record, grain-filtered
 * (moved out of the portal's New order, `portal/customer/neworder/api.ts`, B-W2b-190 and the customer page's F-CP-150…154).
 * Every write carries the request's `version` (409 when someone changed it) and an Idempotency-Key. Prices are decimal strings
 * that come ONLY with the price grain: the shared part never draws one (`draftViewOf`). The API's sentences are dropped: the
 * pages say everything from codes and figures in their own words. What a newer answer adds is read as optional: absent, the page
 * says less, never something false.
 */

export const STATUSES = ['DRAFT', 'SENT', 'ACCEPTED', 'REFUSED', 'WITHDRAWN'] as const
export type RequestStatus = (typeof STATUSES)[number]
export const SOURCES = ['PICKER', 'REORDER', 'UPLOAD'] as const
export type RequestSource = (typeof SOURCES)[number]
// B-CP-075: the problem codes are the domain's own list (one source): a described or made-to-measure line's codes (NO_TOTAL,
// SIZES_NOT_TOTAL, NO_PEOPLE, MTM_CLOSED, GARMENT_TYPE_GONE) parse too, so a draft with such a line never fails to read.
export { PROBLEM_CODES }
export type ProblemCode = (typeof PROBLEM_CODES)[number]
export const NOTICE_CODES = ['PRICE_CHANGED', 'REVISION_CHANGED', 'SIZES_DROPPED', 'COLOUR_DISCONTINUED', 'STYLE_NOT_SOLD', 'MADE_TO_MEASURE', 'NO_SIZES_LEFT'] as const
export type NoticeCode = (typeof NOTICE_CODES)[number]
export const APPROVALS = ['WAITING', 'APPROVED', 'REFUSED'] as const

/** The API's limits (factory-domain sales/portal-ordering ORDERING_LIMITS). */
export const LIMITS = Object.freeze({ lines: 200, sizesPerLine: 60, quantity: 99_999, customerRef: 100, note: 4000, lineNote: 1000 })

export const named = z.object({ id: z.string(), code: z.string(), name: z.string() })
export const sizeRow = z.object({ size: z.string(), quantity: z.number() })
/**
 * B-TH-304 (pick A, plan §0.5): the customer's own number of an order ("Your order 12"); the portal draws it and never the
 * office's `number` (SO-…), whose series would tell a customer how much the others order. Absent from an older answer: none.
 */
export const ownNumber = z.object({ seq: z.number(), words: z.object({ it: z.string(), en: z.string() }) }).nullable().default(null)
export type OwnNumber = z.infer<typeof ownNumber>
export const pair = z.object({ it: z.string(), en: z.string() })
export type Pair = z.infer<typeof pair>

export const problemSchema = z.object({
  code: z.enum(PROBLEM_CODES),
  lineId: z.string().nullable(),
  size: z.string().nullable(),
  // F-CP-154 (B-CP-075): the part of the checklist it holds and the person of a roster it is on (absent from an older answer).
  part: z.enum(PROBLEM_PARTS).optional(),
  personId: z.string().nullable().optional(),
})
export type Problem = z.infer<typeof problemSchema>
export const noticeSchema = z.object({ code: z.enum(NOTICE_CODES) })
export type Notice = z.infer<typeof noticeSchema>

// F-CP-151 (B-CP-072): one of a draft's files (its own party's: named, with its version for a removal).
export const draftFileSchema = z.object({
  id: z.string(),
  /** The line it is on (null: the draft's own). */
  lineId: z.string().nullable(),
  /** od-s: null while `locked` (an office reader without the measurements right: a measurement sheet's name is personal data). */
  originalName: z.string().nullable(),
  locked: z.boolean().optional(),
  kind: z.string(),
  contentType: z.string(),
  sizeBytes: z.number(),
  status: z.string(),
  version: z.number(),
  createdAt: z.string(),
})
export type DraftFile = z.infer<typeof draftFileSchema>

// ---- od- (THE SIMPLE ORDER START R1; 13-backend § 1a, § 3; addendum R1–R3): a row's sizing, its open options, who saved the draft
// last and what is still open — every one optional (an older answer: absent). A shape this page cannot read is left out (`catch`).
export const SIZINGS = ['STANDARD', 'MADE_TO_MEASURE'] as const
export type Sizing = (typeof SIZINGS)[number]
/** Standard sizes · Custom size (made to measure) · null = Not decided yet. */
export const sizingSchema = z.enum(SIZINGS).nullable().optional().catch(undefined)
/** An option of a row: "Leather" with its choices "Cowhide · Kangaroo"; `picked` null = Not decided yet. Names only, never a price. */
export const choiceSchema = z.object({ topic: z.string(), options: z.array(z.string()), picked: z.string().nullable() })
export type DraftChoice = z.infer<typeof choiceSchema>
export const choicesSchema = z.array(choiceSchema).nullable().optional().catch(undefined)
export const SAVED_BY_WHO = ['YOU', 'COLLEAGUE', 'FACTORY'] as const
export type SavedByWho = (typeof SAVED_BY_WHO)[number]
/** FACTORY: any office save, read in the portal — its name is always null there (the portal never names a factory worker). */
export const savedBySchema = z.object({ who: z.enum(SAVED_BY_WHO), name: z.string().nullable() })
export type SavedBy = z.infer<typeof savedBySchema>
/** What a still-open item names (R1): a row's product, sizing, colour, pieces or one of its options; the delivery date; the ship-to. */
export const STILL_OPEN_KINDS = ['PRODUCT', 'SIZING', 'COLOUR', 'PIECES', 'CHOICE', 'DATE', 'SHIP_TO'] as const
export type StillOpenKind = (typeof STILL_OPEN_KINDS)[number]
export const stillOpenItemSchema = z.object({
  /** A kind this page does not know is left out (`stillOpenRows`). */
  kind: z.string(),
  /** The row items name their row. */
  lineId: z.string().nullable(),
  seq: z.number().nullable(),
  /** CHOICE only: the option's name. */
  topic: z.string().nullable(),
  /** NOT_DECIDED in the draft; MISSING lives only in the office's Confirm window. */
  state: z.string(),
  confirmNeeds: z.boolean(),
  /** od-fx7 / od-fx8: whether the ORDER already has what it needs here (a style, a colour of ours, pieces by size, an address in use);
   * absent from an older answer (the Confirm card then reads the rows themselves). */
  confirmReady: z.boolean().optional().catch(undefined),
})
export type StillOpenItem = z.infer<typeof stillOpenItemSchema>
export const stillOpenSchema = z.object({ items: z.array(stillOpenItemSchema), openCount: z.number(), confirmHeld: z.boolean() })
export type StillOpen = z.infer<typeof stillOpenSchema>
// ---- end od-

export const lineSchema = z.object({
  id: z.string(),
  seq: z.number(),
  version: z.number(),
  style: named,
  colourway: named.nullable(), // od- R3: a catalogue row may leave its colour "Not decided yet"
  sizes: z.array(z.object({ size: z.string(), quantity: z.number(), offered: z.boolean() })),
  /** The colourway's sizes offered today, in range order: the grid's columns. */
  offered: z.array(z.string()),
  /** The style's colours the customer may choose. */
  colours: z.array(named),
  pieces: z.number(),
  unitPriceShown: z.string().nullable().optional(),
  priceNow: z.string().nullable().optional(),
  amount: z.string().nullable().optional(),
  note: z.string().nullable(),
  // B-TH-304: `orderNumber` is the office's (never drawn in the portal); `yourNumber` the customer's own ("Your order 12").
  source: z.object({ orderLineId: z.string(), orderId: z.string(), orderNumber: z.string(), yourNumber: ownNumber, customerRef: z.string().nullable(), orderDate: z.string() }).nullable(),
  notices: z.array(noticeSchema),
  problems: z.array(problemSchema),
  /** F-CP-154 (B-CP-076): "Your price" — the customer's own net unit price (price grain only; absent without it). */
  brandUnitPrice: z.string().nullable().optional(),
  // od- R1: Standard sizes · Custom size · null = Not decided yet; the line's open options (names only).
  sizing: sizingSchema,
  choices: choicesSchema,
  /** owb-po1 (settle 4): the line's material in words — its colourway or its "Material" option; absent from an older answer. */
  material: z.string().nullable().optional().catch(undefined),
})
export type DraftLine = z.infer<typeof lineSchema>

// ---- F-CP-154 (customer page plan C5; 12 §2 parts 1 and 4; B-CP-075): a line in the customer's own words and its people ---------
/** How a person of a by-person line is measured: a size, a measurement sheet of this draft, or sent later (no saved measurements in v1). */
export { MEASURE_BY, CUSTOM_LINE_KINDS }
export type MeasureBy = (typeof MEASURE_BY)[number]
export type CustomLineKind = (typeof CUSTOM_LINE_KINDS)[number]

export const personSchema = z.object({
  id: z.string(),
  seq: z.number(),
  version: z.number(),
  name: z.string(),
  number: z.string().nullable(),
  measureBy: z.enum(MEASURE_BY),
  size: z.string().nullable(),
  /** SHEET: the draft's measurement sheet it names (the customer's own file: named). */
  sheet: z.object({ id: z.string(), originalName: z.string().nullable(), locked: z.boolean() }).nullable(),
  note: z.string().nullable(),
})
export type DraftPerson = z.infer<typeof personSchema>

export const customLineSchema = z.object({
  id: z.string(),
  seq: z.number(),
  version: z.number(),
  kind: z.enum(CUSTOM_LINE_KINDS),
  description: z.string().nullable(),
  colourText: z.string().nullable(),
  /** A described line's own-label style, or the style a made-to-measure line is made from (null: none named). */
  style: named.nullable(),
  colourway: named.nullable(),
  /** MADE_TO_MEASURE: the garment type and its words. */
  garmentType: z.object({ code: z.string(), words: pair }).nullable(),
  /** DESCRIBED: the pieces in all (the sizes may follow after Send). */
  quantity: z.number().nullable(),
  sizes: z.array(sizeRow),
  byPerson: z.boolean(),
  pieces: z.number(),
  people: z.array(personSchema),
  /** By person, no one typed, a measurement sheet on the line: "People: in the attached sheet" (review A5). */
  peopleInSheet: z.boolean(),
  note: z.string().nullable(),
  problems: z.array(problemSchema),
  /** "Your price" (price grain only). */
  brandUnitPrice: z.string().nullable().optional(),
  // od- R1: Standard sizes · Custom size (made to measure) · null = Not decided yet; the line's open options (names only).
  sizing: sizingSchema,
  choices: choicesSchema,
  /** owb-po1 (settle 4): the line's material in words; absent from an older answer. */
  material: z.string().nullable().optional().catch(undefined),
})
export type CustomLine = z.infer<typeof customLineSchema>

/** Made to measure for this customer: open (the default), else why not; the garment types it may choose. */
export const madeToMeasureSchema = z.object({ open: z.boolean(), words: pair.nullable(), garmentTypes: z.array(z.object({ code: z.string(), words: pair })) })
export type MadeToMeasure = z.infer<typeof madeToMeasureSchema>
// ---- end F-CP-154

export const requestSchema = z.object({
  id: z.string(),
  number: z.string().nullable(),
  status: z.enum(STATUSES),
  source: z.enum(SOURCES),
  customerRef: z.string().nullable(),
  shipToAddressId: z.string().nullable(),
  requestedDate: z.string().nullable(),
  note: z.string().nullable(),
  currency: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  sentAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  salesOrder: z.object({ id: z.string(), number: z.string() }).nullable(),
  quote: z.object({ id: z.string(), number: z.string() }).nullable(),
  version: z.number(),
  lines: z.array(lineSchema),
  summary: z.object({ lines: z.number(), pieces: z.number(), net: z.string().nullable().optional() }),
  problems: z.array(problemSchema),
  pricesChanged: z.number(),
  // ---- F-CP-150 (customer page plan C5, D9–D11): what the reader may do beside filling the draft (B-CP-070: a Designer fills,
  // never sends; a draft is discarded by one who may order or by the colleague who started it) — absent from an older answer: as
  // before (the Buyer's page). The parts marked "we send it later" and who changed it last come with B-CP-075 (PA2): read as
  // optional until then (the band says "Saved 10:42" without a name).
  may: z.object({ send: z.boolean(), withdraw: z.boolean(), discard: z.boolean(), takeBack: z.boolean().optional() /* owb-po1: Take it back */ }).optional(),
  laterParts: z.array(z.string()).optional(),
  lastEditedBy: z.string().nullable().optional(),
  lastEditedAt: z.string().nullable().optional(),
  // ---- end F-CP-150
  // ---- F-CP-151 (B-CP-072): the draft's logos, references and measurement sheets (its own and its lines'), and whether files go
  // up here now — on live, until the virus scanner runs (D14, O7 not approved), they do not: the page says to e-mail them.
  files: z.object({ logos: z.array(draftFileSchema), references: z.array(draftFileSchema), sheets: z.array(draftFileSchema) }).optional(),
  uploads: z.object({ open: z.boolean(), words: z.string().nullable() }).optional(),
  // ---- end F-CP-151
  // ---- F-CP-154 (B-CP-075): the lines in the customer's own words (with `lines`, one draft by seq) and made to measure for it (null
  // once sent; absent from an older answer: none, and made to measure open — the default).
  customLines: z.array(customLineSchema).optional(),
  madeToMeasure: madeToMeasureSchema.nullable().optional(),
  // ---- od- (THE SIMPLE ORDER START R1, 13-backend § 3 + addendum R2): the mail's subject (the draft's title), who saved last (the
  // portal reads "the factory" for any office save — never a worker's name), what is still open (information only; the server's
  // `stillOpenOf`, no price item), and — portal only — whether the factory works on the design (a yes/no, never a style id).
  subject: z.string().nullable().optional(),
  savedBy: savedBySchema.optional().catch(undefined),
  stillOpen: stillOpenSchema.optional().catch(undefined),
  designStarted: z.boolean().optional().catch(undefined),
  // ---- end od-
  // ---- owb-po3 (owb-po-server § Shape "DRAFT RECORD", built by the server's owb-po1): the record's own columns and values, the lines
  // taken out (DRAFT only; "Put it back"), the picture of the order. Every one optional: an older answer says less, never something false.
  ownColumns: recordOwnColumnsSchema.optional().catch(undefined),
  removedLines: z.array(removedLineSchema).optional().catch(undefined),
  picture: z.object({ fileId: z.string().nullable(), setAt: z.string().nullable().default(null), contentType: z.string().nullable().default(null) }).optional().catch(undefined),
  // ---- end owb-po3
  // ---- end F-CP-154
})
export type DraftRequest = z.infer<typeof requestSchema>

export const addressSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  line1: z.string(),
  line2: z.string().nullable(),
  postalCode: z.string(),
  city: z.string(),
  province: z.string().nullable(),
  country: z.string(),
  contactName: z.string().nullable(),
  phone: z.string().nullable(),
  deliveryNotes: z.string().nullable(),
  isDefault: z.boolean(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  approval: z.object({ status: z.enum(APPROVALS) }).nullable(),
  version: z.number(),
})
export type ShipTo = z.infer<typeof addressSchema>

export const recordSchema = z.object({ request: requestSchema, addresses: z.array(addressSchema), seesPrices: z.boolean() })
export type DraftRecord = z.infer<typeof recordSchema>

export interface HeaderBody {
  /** od- R2: the mail's subject (1–200, trimmed; null = none): the draft's title. */
  subject?: string | null
  customerRef?: string | null
  shipToAddressId?: string | null
  requestedDate?: string | null
  note?: string | null
  /** F-CP-151: the parts the customer sends later (LOGOS, REFERENCES, PEOPLE) — B-CP-075 keeps them (PA2). */
  laterParts?: string[]
}

export interface SizeAsk {
  size: string
  quantity: number
}
export interface NewLine {
  styleId: string
  colourwayId: string
  sizes: SizeAsk[]
  note?: string | null
  /** F-CP-154 (B-CP-076): "Your price" — only a price holder sends it (the grain filter refuses it from anyone else). */
  brandUnitPrice?: string | null
}

export interface CustomLineFields {
  description?: string | null
  colourText?: string | null
  styleId?: string | null
  colourwayId?: string | null
  garmentType?: string | null
  quantity?: number | null
  byPerson?: boolean
  sizes?: SizeAsk[]
  note?: string | null
  brandUnitPrice?: string | null
  /** od- R3: Standard sizes · Custom size · null = Not decided yet (the server changes the row's kind with it, in one update). */
  sizing?: Sizing | null
  /** od-: the row's open options (names only; null clears them). */
  choices?: DraftChoice[] | null
}

export interface PersonFields {
  name: string
  number?: string | null
  measureBy: MeasureBy
  size?: string | null
  /** SHEET: a measurement sheet of this draft (its own or one of its lines'). */
  measurementFileId?: string | null
  note?: string | null
}

export const DRAFT_FILE_PARTS = ['LOGO', 'REFERENCE', 'SHEET'] as const
export type DraftFilePart = (typeof DRAFT_FILE_PARTS)[number]
export const presignedSchema = z.object({ method: z.enum(['PUT', 'GET']), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.string() })

export interface DraftFileAnnounce {
  part: DraftFilePart
  lineId?: string | null
  originalName: string
  contentType: string
  sizeBytes: number
  sha256: string
}
