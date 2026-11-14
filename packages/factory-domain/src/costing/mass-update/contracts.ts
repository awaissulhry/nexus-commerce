import { z } from 'zod'
import { businessDate, id, input, instant, output } from '../../core/contracts'
import { money, notMoney } from '../../money/marked'
import { SERIES_STATES, MASS_LIMITS } from './rules'

/**
 * The contracts of the mass cost update (B-W2b-423; FIN-022; design finance.costing › "Mass cost update": the new material
 * price, the cost sheets affected, the effect on margins of open orders and price lists, "Approve update"). Costs are
 * money.cost, prices money.price, margins money.margin: each dropped for a caller without its grain (A1 §2.6), so a person
 * with the cost grain only sees costs and no margin. Counts, sizes, states and words stay.
 */

export const massChangeInput = input({
  itemId: id(),
  /** The new standard purchase price per base unit, in the material's currency. */
  newPrice: money.cost(z.string()),
})

export const massPreviewBody = input({
  changes: z.array(massChangeInput).min(1).max(MASS_LIMITS.changes),
})
export type MassPreviewBody = z.output<typeof massPreviewBody>

export const massApplyBody = input({
  changes: z.array(massChangeInput).min(1).max(MASS_LIMITS.changes),
  /** The preview this person saw (its `previewHash`): anything that moved since is refused (STALE). */
  previewHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Make the new drafts although inputs are missing (they are left out; each draft's inputs list them). */
  leaveOutMissing: z.boolean().optional(),
  note: z.string().trim().min(1).max(500).optional(),
})
export type MassApplyBody = z.output<typeof massApplyBody>

const sizeDelta = output({ size: z.string(), before: money.cost(z.string().nullable()), after: money.cost(z.string().nullable()), move: money.cost(z.string().nullable()) })

export const massMaterialView = output({
  itemId: id(),
  code: z.string(),
  name: z.string(),
  baseUom: z.string(),
  currency: z.string(),
  priceNow: money.cost(z.string().nullable()),
  newPrice: money.cost(z.string()),
  changePct: money.cost(z.string().nullable()),
  version: z.number().int(),
})

export const massSeriesView = output({
  key: z.string(),
  style: output({ id: id(), code: z.string(), name: z.string() }),
  companyId: id(),
  seasonId: id().nullable(),
  /** The version the new draft follows (the series' newest that is not frozen). */
  sheet: output({ id: id(), sheetVersion: z.number().int(), state: z.enum(['DRAFT', 'APPROVED']), revisionId: id(), baseSize: z.string(), version: z.number().int() }),
  state: z.enum(SERIES_STATES),
  words: z.string(),
  /** The version's own stored cost at its base size. */
  stored: money.cost(z.string().nullable()),
  /** Its components at today's prices and with the new ones, per size. */
  sizes: z.array(sizeDelta),
  baseSize: sizeDelta,
  weighted: output({ before: money.cost(z.string().nullable()), after: money.cost(z.string().nullable()) }),
  missing: z.array(z.string()),
})

export const massPriceListView = output({
  listId: id(),
  code: z.string(),
  name: z.string(),
  versionId: id(),
  revision: z.number().int(),
  currency: z.string(),
  styleId: id(),
  styleCode: z.string(),
  colourwayId: id().nullable(),
  price: money.price(z.string()),
  costBefore: money.cost(z.string().nullable()),
  costAfter: money.cost(z.string().nullable()),
  marginBefore: money.margin(z.string().nullable()),
  marginAfter: money.margin(z.string().nullable()),
  marginMove: money.margin(z.string().nullable()),
  comparable: z.boolean(),
})

export const massOrderLineView = output({
  orderId: id(),
  number: z.string(),
  status: z.string(),
  customer: z.string(),
  lineId: id(),
  seq: z.number().int(),
  styleId: id(),
  styleCode: z.string(),
  pieces: z.number().int(),
  currency: z.string(),
  net: money.price(z.number().int()),
  costBefore: money.cost(z.number().int().nullable()),
  costAfter: money.cost(z.number().int().nullable()),
  marginBefore: money.margin(z.string().nullable()),
  marginAfter: money.margin(z.string().nullable()),
  marginMove: money.margin(z.string().nullable()),
})

export const massPreviewView = output({
  on: businessDate(),
  materials: z.array(massMaterialView),
  series: z.array(massSeriesView),
  /** Revisions that take a changed material but have no cost sheet: their effect is not computed. */
  withoutSheet: z.array(output({ styleId: id(), code: z.string(), revisionId: id(), revision: z.number().int() })),
  /** The rows' own figures are marked by grain. */
  priceLists: notMoney(z.array(massPriceListView)),
  orders: z.array(massOrderLineView),
  counts: notMoney(output({ series: z.number().int(), recomputed: z.number().int(), incomplete: z.number().int(), seasonClosed: z.number().int(), listEntries: z.number().int(), orderLines: z.number().int() })),
  /** More documents than shown (at most MASS_LIMITS.documents each). */
  truncated: z.boolean(),
  previewHash: z.string(),
  words: z.string(),
  computedAt: instant(),
})
export type MassPreviewView = z.infer<typeof massPreviewView>

export const massApplyView = output({
  materials: z.array(output({ itemId: id(), code: z.string(), version: z.number().int() })),
  created: z.array(output({ sheetId: id(), key: z.string(), sheetVersion: z.number().int(), basedOnId: id(), leftOut: z.number().int() })),
  skipped: z.array(output({ key: z.string(), state: z.enum(SERIES_STATES), words: z.string() })),
  words: z.string(),
})
export type MassApplyView = z.infer<typeof massApplyView>
