import { z } from 'zod'
import { amountMinor, businessDate, currency, defineContract, id, input, instant, output, quantity } from '@nexus/factory-domain/core/contracts'
import { SHADE_RULES } from '@nexus/factory-domain/inventory/reservations/shade'
import { money } from '@nexus/factory-domain/money/marked'
import { FEASIBILITY } from '@nexus/factory-domain/planning/leather/feasibility'
import { LOSS_DECISIONS, LOSS_SOURCES, PROPOSAL_STATES } from '@nexus/factory-domain/planning/leather/loss'
import { PROTECTOR_STATES } from '@nexus/factory-domain/planning/leather/protectors'
import { UOMS } from '@nexus/factory-domain/product/units/units'

/**
 * The leather and cut plan (B-W2b-132; PLN-106, PLN-108, PLN-109, PLN-114; design planning.leather, SCR-252). Areas in the
 * leather's base unit (four places), percentages with two places. Three reads, each its own section (one failing never
 * blanks the others): the leather need per order and the certified protectors from the site's latest plan run, the yield per
 * style from the cut log. Money only in fields marked with the cost grain (dropped for a caller without it). Never a cutter.
 */

const pct = () => z.string().regex(/^-?\d{1,6}\.\d{2}$/)
const ref = output({ id: id(), code: z.string(), name: z.string() })
const siteQuery = input({ siteId: id() })
const siteView = output({ id: id(), code: z.string(), name: z.string(), timeZone: z.string() })
const runView = output({ id: id(), finishedAt: instant(), orderLines: z.number().int().min(0) }).nullable()
const lotRef = output({ key: z.string(), lotId: id(), lotCode: z.string(), shadeLabel: z.string().nullable(), free: quantity(), count: z.number().int().min(0), ordersOwn: z.boolean() })

const needRow = output({
  /** `<order line>:<article>:<colour or ->`. */
  id: z.string(),
  order: output({ id: id(), number: z.string() }),
  orderLine: output({ id: id(), seq: z.number().int(), dueDate: businessDate().nullable() }),
  style: ref,
  revision: output({ id: id(), revision: z.number().int(), status: z.enum(['DRAFT', 'RELEASED', 'OBSOLETE']) }).nullable(),
  colourway: ref.nullable(),
  item: output({ id: id(), code: z.string(), name: z.string(), baseUom: z.enum(UOMS), thicknessMinMm: z.string().nullable(), thicknessMaxMm: z.string().nullable() }),
  colour: ref.nullable(),
  /** The run's line for the article and colour (Draft PO acts on it, as in What to buy & make). */
  requirement: output({ id: id(), version: z.number().int(), decision: z.enum(['OPEN', 'ORDERED', 'IGNORED']), suggestedQuantity: quantity(), suggestedUom: z.enum(UOMS) }),
  /** Per size: pieces still to make, the area they take (loss included) and of it what is issued. */
  sizes: z.array(output({ size: z.string(), pieces: z.number().int(), area: quantity(), issued: quantity() })),
  /** Per part (the BOM line's placement) and size: the area its pieces take, loss included. */
  parts: z.array(output({ part: z.string(), sizes: z.array(output({ size: z.string(), area: quantity() })) })),
  pieces: z.number().int(),
  /** Area needed, loss included; what is issued already; what the order's reservations still hold; what is left to find. */
  area: quantity(),
  issued: quantity(),
  reserved: quantity(),
  toFind: quantity(),
  /** The area without the loss. */
  netArea: quantity().nullable(),
  /** The revision's planned cutting loss (null: not known) and where it comes from. */
  lossPct: pct().nullable(),
  lossSource: z.enum(LOSS_SOURCES).nullable(),
  /** About how many hides of the article what is left to find is (the article's hide size; null: no hide size). */
  hides: z.number().int().nullable(),
  /** The grade mix of the article's free hides at the site, percent of their area (null code: no grade). */
  gradeMix: z.array(output({ code: z.string().nullable(), pct: pct(), area: quantity() })),
  workOrders: z.array(output({ id: id(), number: z.string() })),
  heldLots: z.array(output({ lotCode: z.string(), shadeLabel: z.string().nullable() })),
  feasibility: z.enum(FEASIBILITY),
  best: lotRef.nullable(),
  split: z.array(output({ lotKey: z.string(), lotId: id(), lotCode: z.string(), shadeLabel: z.string().nullable(), sizes: z.array(z.string()), area: quantity() })).nullable(),
  buy: output({ area: quantity(), hides: z.number().int().nullable(), lotCode: z.string().nullable(), shadeLabel: z.string().nullable() }).nullable(),
  /** The hides the best lot would reserve (FITS), largest first until the need. */
  proposal: output({ hideIds: z.array(id()), count: z.number().int(), area: quantity() }).nullable(),
  /** The free lots by shade (the order's own first), the drawer's bars. */
  lots: z.array(lotRef),
  /** The order line's demand for a reservation: its one open work order, else the line. */
  demand: output({ workOrderId: id().nullable(), salesOrderLineId: id().nullable() }),
  /** Cost grain: what is left to find at the article's standard cost. */
  value: money.cost(amountMinor().nullable()),
  currency: currency(),
})
export type NeedRowView = z.infer<typeof needRow>

export const needContract = defineContract({
  querystring: siteQuery,
  response: {
    200: output({
      site: siteView,
      run: runView,
      rule: z.enum(SHADE_RULES),
      rows: z.array(needRow),
    }),
  },
})

const protectorRow = output({
  id: z.string(),
  order: output({ id: id(), number: z.string() }),
  orderLine: output({ id: id(), seq: z.number().int(), dueDate: businessDate().nullable() }),
  style: ref,
  colourway: ref.nullable(),
  /** The BOM line's placement (shoulder, elbow, back); null when the BOM names none. */
  placement: z.string().nullable(),
  sizes: z.array(output({ size: z.string(), pieces: z.number().int() })),
  /** The part the style's BOM names: its certified part number (W1: the BOM names the certified part). */
  item: output({ id: id(), code: z.string(), name: z.string(), baseUom: z.enum(UOMS) }),
  /** What the order line still needs (issued taken off), base unit. */
  needed: quantity(),
  certificate: output({ id: id(), number: z.string(), standard: z.string(), validTo: businessDate() }).nullable(),
  /** Released lots at the site holding the part, and of them those with an active EN 1621 lot certificate. */
  lots: output({ count: z.number().int(), available: quantity(), withCertificate: z.number().int() }),
  state: z.enum(PROTECTOR_STATES),
  /** Other protectors in stock at the site: never used instead (not certified for the style). */
  substitutes: z.array(ref),
})
export type ProtectorRowView = z.infer<typeof protectorRow>

export const protectorsContract = defineContract({
  querystring: siteQuery,
  response: { 200: output({ site: siteView, run: runView, rows: z.array(protectorRow) }) },
})

const yieldRow = output({
  style: ref,
  /** The revision the plan uses now (the released one) and the draft a change goes into. */
  revision: output({ id: id(), revision: z.number().int() }).nullable(),
  draft: output({ id: id(), revision: z.number().int(), version: z.number().int() }).nullable(),
  /** Hides and cuts (live cut log entries whose pattern is known) at the site in the window. */
  hides: z.number().int(),
  cuts: z.number().int(),
  /** The BOM's need of what was cut (loss included) and the area the cuts used. */
  plannedArea: quantity(),
  actualArea: quantity(),
  uom: z.enum(UOMS).nullable(),
  plannedLossPct: pct().nullable(),
  plannedSource: z.enum(LOSS_SOURCES).nullable(),
  actualLossPct: pct().nullable(),
  /** Actual loss per work order, oldest first (the trend). */
  trend: z.array(output({ workOrder: z.string(), lossPct: pct().nullable() })),
  proposal: output({ state: z.enum(PROPOSAL_STATES), fromPct: pct().nullable(), toPct: pct().nullable(), cuts: z.number().int() }),
  /** The latest decision at the site (who decided is in the style's history, never in the list). */
  lastDecision: output({ decision: z.enum(LOSS_DECISIONS), toPct: pct(), cuts: z.number().int(), at: instant(), reason: z.string().nullable(), revision: z.number().int().nullable() }).nullable(),
  /** Cost grain: the area lost beyond the plan at the leather's standard cost. */
  extraLossValue: money.cost(amountMinor().nullable()),
  currency: currency().nullable(),
})
export type YieldRowView = z.infer<typeof yieldRow>

export const yieldContract = defineContract({
  querystring: siteQuery,
  response: {
    200: output({
      site: siteView,
      from: instant(),
      minCuts: z.number().int(),
      driftPoints: z.string(),
      maxLossPct: z.string(),
      rows: z.array(yieldRow),
    }),
  },
})

const styleParams = input({ styleId: id() })
const decided = output({
  styleId: id(),
  siteId: id(),
  decision: z.enum(LOSS_DECISIONS),
  fromPct: pct().nullable(),
  toPct: pct(),
  cuts: z.number().int(),
  decidedAt: instant(),
  /** The draft revision the accepted loss went into (null: none — Products starts one to carry it). */
  carriedIn: output({ revisionId: id(), revision: z.number().int(), plannedHideYieldPct: z.string(), wastagePct: z.string(), lines: z.number().int() }).nullable(),
})

export const acceptLossContract = defineContract({
  params: styleParams,
  body: input({
    siteId: id(),
    /** The proposal as the person saw it: its loss and the cuts it rests on (409 refusal/PROPOSAL_MOVED otherwise). */
    toPct: z.string().max(10),
    cuts: z.number().int().min(0),
    /** The draft revision's version as read (required when the style has a draft). */
    draftVersion: z.number().int().min(1).nullable().optional(),
  }),
  response: { 200: decided },
})

export const dismissLossContract = defineContract({
  params: styleParams,
  body: input({ siteId: id(), toPct: z.string().max(10), cuts: z.number().int().min(0), reason: z.string().max(500) }),
  response: { 200: decided },
})
