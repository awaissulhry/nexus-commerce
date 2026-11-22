import { targetPctOf as domainTargetPct } from '@nexus/factory-domain/costing/margins/hand-lines' // B-OM-021: one rule with the server
import { COST_LINE_KINDS, type CostLineKind, type MarginTarget, type OrderMargin } from '../../../../finance/margins/api'
import { bridgeOf as financeBridgeOf, orderProfitabilityHref, pointsBetween, type MarginsCan } from '../../../../finance/margins/model' // F-OM-306: the bridge's one rule
import { isFinal, parseAmount, type OrderAbilities, type Tone } from '../../model'
import type { Order } from '../../api'
import { word, type MoneyWord } from './word'

/**
 * F-OM-302 (order MONEY tab, 10-design §8; 18-lead-settles L2, L4; B-OM-007, B-OM-021) — section 5, Margin (#margin), pure: does this
 * order still make the money we planned, and if not, why? The margin grain only (hidden otherwise); amounts and the bridge also need the
 * cost grain (the API drops what a reader does not hold: absent, never 0). The kit, ONE card:
 *
 *   head      "Based on: cost at quote 12 Oct · rev 2" (+ "The order is closed: its margin is final.") · Set a cost by hand… · Set
 *             target… (costing.ledger.manage + cost; the target also the margin grain: the Owner and Finance, L4) · ⋯ Open in
 *             Finance › Margins ›
 *   tiles     At quote ("as sold") · Now ("−2.8 pts since the quote" / "No work order yet: now = the cost at quote") · Actual so far
 *             ("Reads high while work is open" / "Final: every work order is done") · Difference (cost grain; "now against at quote")
 *   meter     the margin now against the target (set by hand), else the floor (its role's or the company's)
 *   by hand   the cost lines ADDED by hand (L2: replacing a computed part, and a rate for the order, are later jobs) + Put back
 *   pair      Where it went (Finance's waterfall) | From the price to the margin (price − each part − freight − the hand lines = margin)
 *   folds     By line · Work orders behind the cost · Why these figures
 * A margin is never typed: it stays worked out from the price and the costs.
 */

export interface MarginTile {
  readonly id: 'quoted' | 'now' | 'actual' | 'difference'
  readonly label: MoneyWord
  readonly value: MoneyWord
  readonly hint: MoneyWord | null
  /** "−2.8 pts since the quote": the points between at quote and now (the view writes them signed). */
  readonly points?: number
  readonly tone?: Tone
}

export interface MarginHandRow {
  readonly id: string
  readonly kind: CostLineKind
  readonly label: MoneyWord
  /** The cost grain (null without it). */
  readonly amount: number | null
  readonly reason: string | null
  readonly who: MoneyWord
  /** Put back (the line's own Remove): held only by the order's state; null: no right. */
  readonly putBack: { readonly held: MoneyWord | null } | null
}

export interface BridgeRow {
  readonly id: string
  readonly kind: 'value' | 'cost' | 'freight' | 'hand' | 'margin' | 'note'
  readonly label: MoneyWord
  readonly amount: number | null
  readonly tag: MoneyWord | null
}

export interface MarginView {
  readonly answer: readonly MoneyWord[]
  readonly tiles: readonly MarginTile[]
  readonly meter: { readonly now: number | null; readonly floor: number | null; readonly target: number | null; readonly words: readonly MoneyWord[] }
  /** The cost lines set by hand; null: the read does not name them yet (B-OM-021: no list, no door). */
  readonly hand: readonly MarginHandRow[] | null
  /** price − each part − freight − the hand lines = margin; null: without the cost grain ("Shown to people who see costs"). */
  readonly bridge: readonly BridgeRow[] | null
  readonly setCost: { readonly held: MoneyWord | null } | null
  readonly setTarget: { readonly held: MoneyWord | null } | null
  readonly finance: string
  readonly folds: { readonly lines: number; readonly workOrders: number }
  readonly why: readonly MoneyWord[]
}

/** A percent as the API writes it ("40.1667"), as a number; null when not known. */
export const pctNumber = (value: string | null | undefined): number | null => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value))

/** The order's target as the read writes it (B-OM-021): its percent, who set it by hand and when; null: none (the floor applies). */
export function targetOf(target: MarginTarget | null | undefined): { readonly pct: string; readonly by: string | null; readonly at: string | null } | null {
  return target ? { pct: target.pct, by: target.by, at: target.at } : null
}

const pctWord = (pct: string | null | undefined): MoneyWord => (pct === null || pct === undefined ? word('moneyTab.margin.value.unknown') : word('moneyTab.margin.value.pct', { pcts: { pct } }))

export function marginOf(input: { readonly detail: OrderMargin; readonly order: Order; readonly can: OrderAbilities; readonly marginCan: Pick<MarginsCan, 'cost' | 'margin' | 'price'>; readonly prefix: string }): MarginView {
  const { detail, order, can, marginCan, prefix } = input
  const final = isFinal(order)
  const closed = final ? word('moneyTab.margin.held.final') : null

  // ---- the head: what the quoted cost was based on (B-OM-007), and a closed order's final word ----
  const based = detail.basedOn
  const answer: MoneyWord[] = [
    based === undefined
      ? word('moneyTab.margin.basedOn.quote')
      : based === null || (based.pricedOn === null && based.revision === null)
        ? word('moneyTab.margin.basedOn.none')
        : based.pricedOn && based.revision !== null
          ? word('moneyTab.margin.basedOn.both', { days: { date: based.pricedOn }, params: { revision: based.revision } })
          : based.pricedOn
            ? word('moneyTab.margin.basedOn.date', { days: { date: based.pricedOn } })
            : word('moneyTab.margin.basedOn.rev', { params: { revision: based.revision ?? 0 } }),
    ...(final ? [word('moneyTab.margin.final')] : []),
  ]

  // ---- the tiles ----
  const points = pointsBetween(detail.quotedMarginPct, detail.estimateMarginPct)
  const tiles: MarginTile[] = [
    { id: 'quoted', label: word('moneyTab.margin.tile.quoted'), value: pctWord(detail.quotedMarginPct), hint: word(detail.quotedCost === null ? 'moneyTab.margin.tile.noQuotedCost' : 'moneyTab.margin.tile.asSold') },
    {
      id: 'now',
      label: word('moneyTab.margin.tile.now'),
      value: pctWord(detail.estimateMarginPct),
      hint: !detail.started ? word('moneyTab.margin.tile.noWorkOrder') : points === null || points === 0 ? word('moneyTab.margin.tile.sameAsQuote') : null,
      ...(detail.started && points !== null && points !== 0 ? { points } : {}),
    },
    {
      id: 'actual',
      label: word('moneyTab.margin.tile.actual'),
      value: detail.started ? pctWord(detail.actualMarginPct) : word('moneyTab.margin.value.notYet'),
      hint: word(detail.final ? 'moneyTab.margin.tile.actualFinal' : detail.started ? 'moneyTab.margin.tile.actualOpen' : 'moneyTab.margin.tile.actualNone'),
    },
  ]
  if (marginCan.cost && marginCan.margin && typeof detail.marginChange === 'number') {
    const change = detail.marginChange
    tiles.push({
      id: 'difference',
      label: word('moneyTab.margin.tile.difference'),
      value: word('moneyTab.margin.value.signed', { params: { sign: change > 0 ? '+' : change < 0 ? '−' : '' }, money: { amount: Math.abs(change) } }),
      hint: word('moneyTab.margin.tile.differenceHint'),
      tone: change < 0 ? 'danger' : change > 0 ? 'success' : 'neutral',
    })
  }

  // ---- the meter: against the target set by hand, else the floor (its role's, else the company's) ----
  const target = targetOf(detail.target)
  const floor = detail.floor ?? null
  const meterWords: MoneyWord[] = []
  if (target) meterWords.push(target.by && target.at ? word('moneyTab.margin.meter.targetBy', { pcts: { pct: target.pct }, params: { name: target.by }, instants: { date: target.at } }) : word('moneyTab.margin.meter.target', { pcts: { pct: target.pct } }))
  if (floor) meterWords.push(floor.from === 'ROLE' && floor.role ? word('moneyTab.margin.meter.floorRole', { pcts: { pct: floor.pct }, params: { role: floor.role } }) : word('moneyTab.margin.meter.floorCompany', { pcts: { pct: floor.pct } }))
  if (detail.belowFloor === true) meterWords.push(word('moneyTab.margin.meter.belowFloor'))

  // ---- the cost lines set by hand (B-OM-021): ADD a line only (L2) ----
  const mayLedger = !!can.costLedger && marginCan.cost
  const hand: MarginHandRow[] | null = detail.handLines
    ? detail.handLines.map((line) => {
        const by = line.by
        return {
          id: line.id,
          kind: line.kind,
          label: word(`moneyTab.margin.kind.${line.kind}`),
          amount: marginCan.cost && typeof line.amount === 'number' ? line.amount : null,
          reason: line.reason || null,
          who: by ? word('moneyTab.margin.hand.who', { params: { name: by }, instants: { date: line.at } }) : word('moneyTab.margin.hand.when', { instants: { date: line.at } }),
          putBack: mayLedger ? { held: closed } : null,
        }
      })
    : null

  return {
    answer,
    tiles,
    meter: { now: pctNumber(final && detail.final ? detail.actualMarginPct : detail.estimateMarginPct), floor: floor ? pctNumber(floor.pct) : null, target: target ? pctNumber(target.pct) : null, words: meterWords },
    hand,
    bridge: bridgeOf(detail, marginCan, hand, mayLedger && hand !== null),
    setCost: mayLedger && hand !== null ? { held: closed } : null,
    setTarget: mayLedger && marginCan.margin && detail.target !== undefined ? { held: closed } : null,
    finance: orderProfitabilityHref(prefix, order.id),
    folds: { lines: detail.lines.length, workOrders: detail.workOrderShares.length },
    why: [
      word(detail.provisional ? 'moneyTab.margin.why.provisional' : 'moneyTab.margin.why.method'),
      word(typeof detail.estimate.freight === 'number' ? 'moneyTab.margin.why.freightCounted' : 'moneyTab.margin.why.freightNone'),
      ...(hand !== null ? [word('moneyTab.margin.why.hand')] : []),
      word('moneyTab.margin.why.bankCharges'),
    ],
  }
}

/**
 * From the price to the margin, as estimated now: the price − each cost part − freight (the shipments', B-OM-007; none yet: said in
 * words) − each cost line set by hand = the margin. Null without the cost grain or the price (a margin amount gives the cost away).
 * F-OM-306: the figures are Finance › Margins' ONE rule (finance/margins/model.ts bridgeOf: one number per order); this says them in
 * the Money section's words (a hand freight estimate stands for the freight not recorded yet).
 */
function bridgeOf(detail: OrderMargin, can: Pick<MarginsCan, 'cost' | 'price'>, hand: readonly MarginHandRow[] | null, maySet: boolean): BridgeRow[] | null {
  const rows = financeBridgeOf(detail, can)
  if (!rows) return null
  const estimate = hand?.some((line) => line.kind === 'FREIGHT_ESTIMATE') ?? false
  return rows.flatMap((row): BridgeRow[] => {
    if (row.kind === 'value') return [{ id: row.id, kind: 'value', label: word('moneyTab.margin.bridge.price'), amount: row.amount, tag: null }]
    if (row.kind === 'cost') return [{ id: row.id, kind: 'cost', label: word(`moneyTab.margin.bridge.${row.id}`), amount: row.amount, tag: null }]
    if (row.kind === 'freight') {
      if (row.amount !== null) return [{ id: row.id, kind: 'freight', label: word('moneyTab.margin.bridge.FREIGHT'), amount: row.amount, tag: word('moneyTab.margin.bridge.fromShipments') }]
      return estimate ? [] : [{ id: row.id, kind: 'note', label: word(maySet ? 'moneyTab.margin.bridge.noFreightSet' : 'moneyTab.margin.bridge.noFreight'), amount: null, tag: null }]
    }
    if (row.kind === 'hand') return [{ id: row.id, kind: 'hand', label: word(row.handKind ? `moneyTab.margin.kind.${row.handKind}` : 'moneyTab.margin.bridge.byHand'), amount: row.amount, tag: word('moneyTab.plan.setByHand') }]
    return [{ id: row.id, kind: 'margin', label: word('moneyTab.margin.bridge.margin'), amount: row.amount, tag: null }]
  })
}

// ---- the hand windows (D7 Set a cost by hand…, Put back, Set target…): what they send ----

/** The kinds a person may add, freight first (before a shipment, its estimate). */
export const HAND_COST_KINDS: readonly CostLineKind[] = COST_LINE_KINDS

/** "1.234,50" / "1,234.50" in the order's currency → minor units; null: not an amount above 0. */
export function costAmountOf(text: string): number | null {
  const amount = parseAmount(text.trim())
  return amount !== null && amount > 0 ? amount : null
}

/** "38" / "38,5" / "38.5 %" → "38.5" (factory-domain's rule: above 0, below 100, at most 4 decimals); "" → null (the floor again); not a percent: null. */
export function targetPctOf(text: string): { readonly pct: string | null } | null {
  const trimmed = text.trim().replace(/\s*%$/, '').replace(',', '.')
  if (trimmed === '') return { pct: null }
  if (!/^\d{1,2}(\.\d{1,4})?$/.test(trimmed)) return null
  const pct = domainTargetPct(trimmed)
  return pct === null ? null : { pct }
}

/** The margin now with a cost line of this amount added (the price grain and the cost grain both read): "40.2 % → 37.2 %"; null: not known. */
export function marginAfterOf(detail: Pick<OrderMargin, 'estimate'>, amount: number | null): string | null {
  const value = detail.estimate.value
  const cost = detail.estimate.cost
  if (amount === null || typeof value !== 'number' || value <= 0 || typeof cost !== 'number') return null
  return String(Math.round(((value - cost - amount) / value) * 1000) / 10)
}
