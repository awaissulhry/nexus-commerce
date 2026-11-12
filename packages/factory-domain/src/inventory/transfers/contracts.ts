import { z } from 'zod'
import { businessDate, id, input, instant, output } from '../../core/contracts'
import { notMoney } from '../../money/marked'
import { UOMS } from '../../product/units/units'
import {
  LINE_STATES,
  TRANSFER_DDT_REASONS,
  TRANSFER_LIMITS,
  TRANSFER_REFUSALS,
  TRANSFER_RESOLUTIONS,
  TRANSFER_STATUSES,
  TRANSFER_TILES,
  TRANSFER_TRANSPORT,
} from './rules'

/**
 * Transfers' contracts (B-W2b-326; SCM-219, SCM-220): what apps/factory-api modules/inventory/transfers accepts and
 * answers, read by the web's Warehouse › Transfers too. Quantities are decimal strings in the item's base unit. No money,
 * no person's figure: who shipped or received is in the audit rows, never in a list. A refusal is a 409 whose issue is
 * `refusal/<CODE>` (TRANSFER_REFUSALS) with the words.
 */

const version = () => z.number().int().min(1)
const qty = () => z.string().regex(/^\d{1,14}(?:\.\d{1,4})?$/, 'Expected a decimal with at most 4 decimals.')
const words = (max: number) => z.string().trim().min(1).max(max)

const siteRef = output({ id: id(), code: z.string(), name: z.string(), companyId: id(), companyName: z.string() })
const placeRef = output({ id: id(), code: z.string(), name: z.string() })
const itemRef = output({ id: id(), code: z.string(), name: z.string(), baseUom: z.enum(UOMS), tracking: z.enum(['NONE', 'LOT', 'HIDE', 'SERIAL']) })
const colourRef = output({ id: id(), code: z.string(), name: z.string() })
const lotRef = output({ id: id(), code: z.string(), qualityStatus: z.string() })
const tagRef = output({ id: id(), code: z.string() })
export type SiteRef = z.infer<typeof siteRef>
export type PlaceRef = z.infer<typeof placeRef>

export const transferAction = output({ allowed: z.boolean(), refusal: z.enum(TRANSFER_REFUSALS).nullable() })
export type TransferActionView = z.infer<typeof transferAction>

export const transferParams = input({ transferId: id() })
export const lineParams = input({ transferId: id(), lineId: id() })

// ---- the list -----------------------------------------------------------------------------------------------------------

export const listQuery = input({
  tile: z.enum(TRANSFER_TILES).optional(),
  status: z.enum(TRANSFER_STATUSES).optional(),
  fromSiteId: id().optional(),
  toSiteId: id().optional(),
  q: z.string().trim().max(TRANSFER_LIMITS.search).optional(),
  limit: z.coerce.number().int().min(1).max(TRANSFER_LIMITS.list).optional(),
})
export type ListQuery = z.infer<typeof listQuery>

export const transferRow = output({
  id: id(),
  number: z.string(),
  status: z.enum(TRANSFER_STATUSES),
  from: siteRef,
  to: siteRef,
  /** Between two companies of the tenant. */
  interCompany: z.boolean(),
  lines: z.number().int(),
  shipOn: businessDate().nullable(),
  expectedOn: businessDate().nullable(),
  ddtNumber: z.string().nullable(),
  ddtDate: businessDate().nullable(),
  /** Lines whose difference waits to be settled. */
  differences: z.number().int(),
  /** In transit and expected before today. */
  late: z.boolean(),
  version: z.number().int(),
  createdAt: instant(),
})
export type TransferRow = z.infer<typeof transferRow>

export const transferList = output({
  rows: z.array(transferRow),
  /** Per tile and ALL, over every transfer the caller sees (not only the filtered rows). */
  counts: output({ IN_TRANSIT: z.number().int(), ARRIVING_TODAY: z.number().int(), WITH_DIFFERENCES: z.number().int(), ALL: z.number().int() }),
  /** False: more rows match than the limit; narrow the filters. */
  complete: z.boolean(),
  /** Today, Europe/Rome, as the tiles read it. */
  today: businessDate(),
})
export type TransferList = z.infer<typeof transferList>

// ---- one transfer ---------------------------------------------------------------------------------------------------------

export const lineView = output({
  id: id(),
  seq: z.number().int(),
  item: itemRef,
  colour: colourRef.nullable(),
  lot: lotRef.nullable(),
  hide: tagRef.nullable(),
  /** Where it is picked (null: the transfer's place). */
  fromLocation: placeRef.nullable(),
  quantity: z.string(),
  uom: z.enum(UOMS),
  /** While a draft: what its pick place holds of it now (null: no place named). */
  available: z.string().nullable(),
  shippedQuantity: z.string().nullable(),
  receivedQuantity: z.string(),
  inTransit: z.string(),
  difference: z.string(),
  state: z.enum(LINE_STATES),
  toLocation: placeRef.nullable(),
  toLot: tagRef.nullable(),
  toHide: tagRef.nullable(),
  differenceReasonCode: z.string().nullable(),
  differenceNote: z.string().nullable(),
  differenceResolution: z.enum(TRANSFER_RESOLUTIONS).nullable(),
  resolvedAt: instant().nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
})
export type LineView = z.infer<typeof lineView>

export const ddtView = output({
  number: z.string(),
  date: businessDate(),
  reason: z.enum(['SALE', 'WORK_ON_ACCOUNT', 'RETURN_FROM_WORK', 'RETURN', 'ON_APPROVAL', 'REPAIR', 'SAMPLE', 'TRANSFER', 'OTHER']),
  reasonText: z.string().nullable(),
  transportBy: z.enum(TRANSFER_TRANSPORT),
  carrier: output({ name: z.string(), vatNumber: z.string().nullable() }).nullable(),
  packages: z.number().int(),
  grossWeightKg: z.string(),
  appearance: z.string(),
  /** The stored PDF (null: not stored yet: print it again). */
  fileId: id().nullable(),
})
export type DdtView = z.infer<typeof ddtView>

export const reasonOption = output({ code: z.string(), labelIt: z.string(), labelEn: z.string() })
export type ReasonOption = z.infer<typeof reasonOption>

export const transferView = output({
  id: id(),
  number: z.string(),
  status: z.enum(TRANSFER_STATUSES),
  from: siteRef,
  to: siteRef,
  interCompany: z.boolean(),
  fromLocation: placeRef.nullable(),
  toLocation: placeRef.nullable(),
  transit: placeRef,
  shipOn: businessDate().nullable(),
  expectedOn: businessDate().nullable(),
  late: z.boolean(),
  ddt: ddtView.nullable(),
  trackingRef: z.string().nullable(),
  trackingUrl: z.string().nullable(),
  shippedAt: instant().nullable(),
  receivedAt: instant().nullable(),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  lines: z.array(lineView),
  /** Counts of lines (no money). */
  totals: notMoney(output({ lines: z.number().int(), inTransitLines: z.number().int(), openDifferences: z.number().int(), settled: z.number().int() })),
  actions: output({
    edit: transferAction,
    lines: transferAction,
    ship: transferAction,
    cancel: transferAction,
    receive: transferAction,
    settle: transferAction,
    track: transferAction,
    printDdt: transferAction,
  }),
  /** The Discrepancy reason list's active codes, for a short line. */
  reasons: z.array(reasonOption),
})
export type TransferView = z.infer<typeof transferView>

export const oneTransfer = output({ transfer: transferView })

// ---- what the New transfer dialog offers ---------------------------------------------------------------------------------

export const optionSite = output({
  id: id(),
  code: z.string(),
  name: z.string(),
  companyId: id(),
  companyName: z.string(),
  active: z.boolean(),
  /** May send from it / receive at it (inventory.transfers.manage there). */
  send: z.boolean(),
  receive: z.boolean(),
  transitPlaces: z.array(placeRef),
  places: z.array(placeRef),
})
export type OptionSite = z.infer<typeof optionSite>

export const transferOptions = output({
  sites: z.array(optionSite),
  ddtReasons: z.array(z.enum(TRANSFER_DDT_REASONS)),
  transport: z.array(z.enum(TRANSFER_TRANSPORT)),
})
export type TransferOptions = z.infer<typeof transferOptions>

// ---- the stock picker ------------------------------------------------------------------------------------------------------

export const stockQuery = input({
  locationId: id().optional(),
  q: z.string().trim().max(TRANSFER_LIMITS.search).optional(),
})

export const stockRow = output({
  location: placeRef,
  item: itemRef,
  colour: colourRef.nullable(),
  lot: lotRef.nullable(),
  hide: tagRef.nullable(),
  onHand: z.string(),
  /** Already on lines of this transfer. */
  onLines: z.string(),
  available: z.string(),
  /** Why it cannot be sent (a blocked or rejected lot), or null. */
  refusal: z.enum(TRANSFER_REFUSALS).nullable(),
})
export type StockRow = z.infer<typeof stockRow>

export const stockList = output({ rows: z.array(stockRow), truncated: z.boolean() })
export type StockList = z.infer<typeof stockList>

// ---- writes ---------------------------------------------------------------------------------------------------------------

export const createBody = input({
  fromSiteId: id(),
  toSiteId: id(),
  /** Default: the sending site's transit place (one only; with several, name it). */
  transitLocationId: id().optional(),
  fromLocationId: id().nullable().optional(),
  toLocationId: id().nullable().optional(),
  shipOn: businessDate().nullable().optional(),
  expectedOn: businessDate().nullable().optional(),
  note: words(TRANSFER_LIMITS.note).nullable().optional(),
})
export type CreateBody = z.infer<typeof createBody>

export const updateBody = input({
  version: version(),
  transitLocationId: id().optional(),
  fromLocationId: id().nullable().optional(),
  toLocationId: id().nullable().optional(),
  shipOn: businessDate().nullable().optional(),
  expectedOn: businessDate().nullable().optional(),
  note: words(TRANSFER_LIMITS.note).nullable().optional(),
  trackingRef: words(TRANSFER_LIMITS.trackingRef).nullable().optional(),
  trackingUrl: z.string().trim().max(TRANSFER_LIMITS.trackingUrl).regex(/^https:\/\/\S+$/, 'An https address.').nullable().optional(),
})
export type UpdateBody = z.infer<typeof updateBody>

export const addLineBody = input({
  version: version(),
  itemId: id(),
  itemColourId: id().nullable().optional(),
  lotId: id().nullable().optional(),
  hideId: id().nullable().optional(),
  fromLocationId: id().nullable().optional(),
  /** Base unit; a hide's: what it holds at its place (left out: that). */
  quantity: qty().optional(),
  note: words(TRANSFER_LIMITS.lineNote).nullable().optional(),
})
export type AddLineBody = z.infer<typeof addLineBody>

export const updateLineBody = input({
  /** The line's version. */
  version: version(),
  quantity: qty().optional(),
  fromLocationId: id().nullable().optional(),
  note: words(TRANSFER_LIMITS.lineNote).nullable().optional(),
})
export type UpdateLineBody = z.infer<typeof updateLineBody>

export const removeLineBody = input({ version: version() })

export const shipBody = input({
  version: version(),
  reason: z.enum(TRANSFER_DDT_REASONS).optional(),
  reasonText: words(TRANSFER_LIMITS.reasonText).nullable().optional(),
  transportBy: z.enum(TRANSFER_TRANSPORT),
  carrierName: words(TRANSFER_LIMITS.carrierName).nullable().optional(),
  carrierVatNumber: z.string().trim().min(1).max(40).nullable().optional(),
  packages: z.number().int().min(1).max(TRANSFER_LIMITS.packages),
  grossWeightKg: qty(),
  /** Default: the sending site's goods appearance (Carriers & shipping), else "colli". */
  appearance: words(TRANSFER_LIMITS.appearance).nullable().optional(),
  trackingRef: words(TRANSFER_LIMITS.trackingRef).nullable().optional(),
  trackingUrl: z.string().trim().max(TRANSFER_LIMITS.trackingUrl).regex(/^https:\/\/\S+$/, 'An https address.').nullable().optional(),
  expectedOn: businessDate().nullable().optional(),
  /** The DDT's language (default it). */
  language: z.enum(['it', 'en']).optional(),
})
export type ShipBody = z.infer<typeof shipBody>

export const receiveLineBody = input({
  lineId: id(),
  /** What arrives now, base unit (0: nothing of it now). */
  quantity: qty(),
  /** Default: the line's place, else the transfer's. */
  toLocationId: id().nullable().optional(),
  /** Why the line is short (a Discrepancy code): the rest waits on the transit place to be settled. */
  differenceReasonCode: z.string().trim().regex(/^[A-Za-z0-9_.:-]{1,60}$/, 'A code without spaces.').nullable().optional(),
  differenceNote: words(TRANSFER_LIMITS.differenceNote).nullable().optional(),
})
export type ReceiveLineBody = z.infer<typeof receiveLineBody>

export const receiveBody = input({ version: version(), lines: z.array(receiveLineBody).min(1).max(TRANSFER_LIMITS.lines) })
export type ReceiveBody = z.infer<typeof receiveBody>

export const settleBody = input({ version: version(), resolution: z.enum(TRANSFER_RESOLUTIONS), note: words(TRANSFER_LIMITS.differenceNote).nullable().optional() })
export type SettleBody = z.infer<typeof settleBody>

export const cancelBody = input({ version: version(), reason: words(TRANSFER_LIMITS.cancelReason) })
export type CancelBody = z.infer<typeof cancelBody>

export const ddtPdfBody = input({ language: z.enum(['it', 'en']).optional() })

export const shipAnswer = output({ transfer: transferView, fileId: id().nullable(), pdfProblem: z.string().nullable() })
export type ShipAnswer = z.infer<typeof shipAnswer>
