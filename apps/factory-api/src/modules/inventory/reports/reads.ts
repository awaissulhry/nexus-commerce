import { asMoney } from '@nexus/factory-domain/money/marked'
import type { Uom } from '@nexus/factory-domain/product/units/units'
import { dimensionOf } from '@nexus/factory-domain/product/units/units'
import {
  addLeather,
  AGE_BUCKETS,
  figuresOf,
  inReferenceUnit,
  isIdle,
  leatherFiguresOf,
  MATERIAL_TYPES,
  quantityText,
  REPORT_LIMITS,
  slicesOf,
  type AgeingFigures,
  type AgeingPosition,
  type LeatherFigures,
  type MaterialType,
  type PositionSlice,
} from '@nexus/factory-domain/inventory/reports/rules'
import { Dec, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import type { AgeingQuery, LeatherQuery } from './contract'
import { headOf, placeOf } from './access'
import {
  childCountsOf,
  coloursOf,
  firstInOf,
  hidesReceivedOf,
  itemsOf,
  keyBalances,
  lastInstant,
  leatherBalancesOf,
  leatherFlowsOf,
  lotsOf,
  type LeatherFlowRow,
  suppliersOf,
  untrackedInsOf,
} from './facts'

/**
 * The warehouse reports' answers (B-W2b-356): what facts.ts reads, folded by factory-domain inventory/reports/rules. Values are
 * marked with the cost grain (the HTTP filter drops them for a caller without it).
 */

const unique = <T>(values: readonly (T | null | undefined)[]): T[] => [...new Set(values.filter((value): value is T => value !== null && value !== undefined))]

const cost = (value: number | null) => asMoney('cost', value)

/** Figures as the contract writes them (values marked). */
function ageingView(figures: AgeingFigures) {
  return {
    buckets: Object.fromEntries(AGE_BUCKETS.map((bucket) => [bucket, { quantities: [...figures.buckets[bucket].quantities], value: cost(figures.buckets[bucket].value), share: figures.buckets[bucket].share }])) as Record<
      (typeof AGE_BUCKETS)[number],
      { quantities: { uom: Uom; quantity: string }[]; value: ReturnType<typeof cost>; share: string | null }
    >,
    undated: [...figures.undated],
    whole: { quantities: [...figures.whole.quantities], value: cost(figures.whole.value) },
    currency: figures.currency,
    mixedCurrencies: figures.mixedCurrencies,
    unvalued: figures.unvalued,
    averageDays: figures.averageDays,
    oldestDays: figures.oldestDays,
    keys: figures.keys,
  }
}

/** How much of a group lies over a year (its articles' order: the oldest stock first), in its reference unit. */
const overYear = (figures: AgeingFigures): number => figures.buckets.overYear.quantities.reduce((sum, row) => sum + Number(row.quantity), 0)

/**
 * GET /inventory/reports/ageing (wr-ageing): what lies in stock at the end of the period at the sites read, by material type and
 * age bucket, with its articles; the stock as the ledger holds it at that moment (the stock valuation's own key balances).
 */
export async function ageingAnswer(caller: CommandCaller, query: AgeingQuery) {
  return caller.withClient(async (db) => {
    const place = await placeOf(db, caller, query)
    const at = lastInstant(place.span.end)
    const empty = { ...headOf(place), sight: place.sight, asAt: place.period.to, types: [], all: { value: cost(place.sight.stock ? 0 : null), currency: null, mixedCurrencies: false, unvalued: 0 }, customerOwned: 0 }
    if (!place.sight.stock) return empty
    const siteIds = place.sites.map((row) => row.id)
    const balances = (await keyBalances(db, { siteIds }, at)).filter((row) => new Dec(row.quantity).greaterThan(0))
    const items = await itemsOf(db, unique(balances.map((row) => row.itemId)))
    const colours = await coloursOf(db, unique(balances.map((row) => row.itemColourId)))
    const lots = await lotsOf(db, unique(balances.map((row) => row.lotId)))
    const firstIns = await firstInOf(db, [...lots.values()].filter((lot) => lot.receivedAt === null).map((lot) => lot.id), at)
    const untrackedItems = unique(balances.filter((row) => row.lotId === null).map((row) => row.itemId))
    const ins = await untrackedInsOf(db, siteIds, untrackedItems, at)
    const insOf = new Map<string, { at: Date; quantity: string }[]>()
    for (const move of ins) {
      const key = `${move.siteId}|${move.itemId}|${move.itemColourId ?? ''}`
      insOf.set(key, [...(insOf.get(key) ?? []), { at: move.at, quantity: move.quantity }])
    }

    interface Row {
      readonly type: MaterialType
      readonly article: string
      readonly itemId: string
      readonly colourId: string | null
      readonly tracked: boolean
      readonly slices: { slice: PositionSlice; uom: Uom; currency: string | null }[]
    }
    const rows: Row[] = []
    let customerOwned = 0
    for (const balance of balances) {
      const item = items.get(balance.itemId)
      if (!item) continue
      const type = (MATERIAL_TYPES as readonly string[]).includes(item.kind) ? (item.kind as MaterialType) : null
      if (!type) continue
      const lot = balance.lotId ? lots.get(balance.lotId) : undefined
      const owned = !!lot?.ownerPartyId
      if (owned) customerOwned += 1
      const currency = balance.currencies.length === 1 ? balance.currencies[0]! : null
      const position: AgeingPosition = {
        itemId: item.id,
        kind: type,
        uom: item.baseUom as Uom,
        onHand: balance.quantity,
        value: owned || balance.currencies.length !== 1 ? null : balance.value,
        currency,
        lotSince: lot ? (lot.receivedAt ?? firstIns.get(lot.id) ?? null) : null,
        tracked: balance.lotId !== null,
        ins: balance.lotId === null ? (insOf.get(`${balance.siteId}|${balance.itemId}|${balance.itemColourId ?? ''}`) ?? []) : [],
      }
      rows.push({
        type,
        article: `${item.id}|${balance.itemColourId ?? ''}`,
        itemId: item.id,
        colourId: balance.itemColourId,
        tracked: position.tracked,
        slices: slicesOf(position, place.period.to).map((slice) => ({ slice, uom: position.uom, currency })),
      })
    }

    const allValues = figuresOf(rows.flatMap((row) => row.slices), rows.length)
    const types = MATERIAL_TYPES.flatMap((type) => {
      const mine = rows.filter((row) => row.type === type)
      if (mine.length === 0) return []
      const byArticle = new Map<string, Row[]>()
      for (const row of mine) byArticle.set(row.article, [...(byArticle.get(row.article) ?? []), row])
      const articles = [...byArticle.values()]
        .map((group) => {
          const first = group[0]!
          const item = items.get(first.itemId)!
          const colour = first.colourId ? (colours.get(first.colourId) ?? null) : null
          return { item: { id: item.id, code: item.code, name: item.name }, colour, tracked: first.tracked, figures: figuresOf(group.flatMap((row) => row.slices), group.length) }
        })
        .sort((a, b) => overYear(b.figures) - overYear(a.figures) || (b.figures.oldestDays ?? -1) - (a.figures.oldestDays ?? -1) || a.item.code.localeCompare(b.item.code) || (a.colour?.code ?? '').localeCompare(b.colour?.code ?? ''))
      const shown = articles.slice(0, REPORT_LIMITS.articlesPerType)
      return [
        {
          type,
          ...ageingView(figuresOf(mine.flatMap((row) => row.slices), mine.length)),
          articles: shown.map((article) => ({ item: article.item, colour: article.colour, tracked: article.tracked, ...ageingView(article.figures) })),
          more: articles.length - shown.length,
        },
      ]
    })
    return {
      ...headOf(place),
      sight: place.sight,
      asAt: place.period.to,
      types,
      all: { value: cost(allValues.whole.value), currency: allValues.currency, mixedCurrencies: allValues.mixedCurrencies, unvalued: allValues.unvalued },
      customerOwned,
    }
  })
}

// ---- leather use ---------------------------------------------------------------------------------------------------------------

const QUANTITY_KEYS = ['start', 'received', 'issued', 'returned', 'remnant', 'cut', 'scrapped', 'other', 'end'] as const
type QuantityKey = (typeof QUANTITY_KEYS)[number]

/** The currencies a group's values are in: one, none (nothing valued) or several (then its values are not said). */
class Currencies {
  private readonly seen = new Set<string>()
  add(min: string | null, max: string | null): void {
    if (min) this.seen.add(min)
    if (max) this.seen.add(max)
  }
  merge(other: Currencies): this {
    for (const code of other.seen) this.seen.add(code)
    return this
  }
  get one(): string | null {
    return this.seen.size === 1 ? [...this.seen][0]! : null
  }
  get mixed(): boolean {
    return this.seen.size > 1
  }
}

/** A group's figures as the contract writes them, in its base unit and in m² (an area unit only); no value over several currencies. */
function leatherView(figures: LeatherFigures, uom: Uom | null, hides: { received: number; onHand: number }, currencies: Currencies) {
  const write = (convert: (value: Decimal) => Decimal) => Object.fromEntries(QUANTITY_KEYS.map((key) => [key, quantityText(convert(figures[key]))])) as Record<QuantityKey, string>
  const area = uom !== null && dimensionOf(uom) === 'AREA'
  const value = (amount: number | null) => cost(currencies.mixed ? null : amount)
  return {
    uom,
    base: uom === null ? null : write((amount) => amount),
    m2: area ? write((amount) => inReferenceUnit(amount, uom).quantity) : null,
    addsUp: figures.addsUp,
    hidesReceived: hides.received,
    hidesOnHand: hides.onHand,
    values: { start: value(figures.values.start), received: value(figures.values.received), cut: value(figures.values.cut), scrapped: value(figures.values.scrapped), end: value(figures.values.end) },
    currency: currencies.one,
  }
}

/** Figures in m² (an article total over several area units is added in m²). */
function inM2(figures: LeatherFigures, uom: Uom): LeatherFigures {
  const m2 = (value: Decimal) => inReferenceUnit(value, uom).quantity
  return { ...figures, start: m2(figures.start), received: m2(figures.received), issued: m2(figures.issued), returned: m2(figures.returned), remnant: m2(figures.remnant), cut: m2(figures.cut), scrapped: m2(figures.scrapped), other: m2(figures.other), end: m2(figures.end) }
}

interface LotGroup {
  readonly itemId: string
  readonly itemColourId: string | null
  readonly rootLotId: string | null
  readonly figures: LeatherFigures
  readonly hides: { received: number; onHand: number }
  readonly currencies: Currencies
}

/**
 * GET /inventory/reports/leather (wr-leather): per leather article and supplier lot, the period's moves by what they did and the
 * stock at both ends, at the sites read. A split lot's children count with their parent (B-W2b-313); the split's own moves (a
 * value-neutral pair of adjustments inside the family) cancel out. Groups where nothing moved and nothing lies are left out.
 */
export async function leatherAnswer(caller: CommandCaller, query: LeatherQuery) {
  return caller.withClient(async (db) => {
    const place = await placeOf(db, caller, query)
    const zero = leatherFiguresOf({ quantity: '0', value: 0 }, [], { quantity: '0', value: 0 })
    if (!place.sight.stock) return { ...headOf(place), sight: place.sight, articles: [], all: leatherView(zero, null, { received: 0, onHand: 0 }, new Currencies()), more: 0, unvaluedMoves: 0 }
    const siteIds = place.sites.map((row) => row.id)
    // One query at a time: the client may be one transaction's connection.
    const flows = await leatherFlowsOf(db, siteIds, place.span.start, place.span.end)
    const starts = await leatherBalancesOf(db, siteIds, place.span.start)
    const ends = await leatherBalancesOf(db, siteIds, place.span.end)
    const received = await hidesReceivedOf(db, siteIds, place.span.start, place.span.end)
    const keyOf = (row: { rootLotId: string | null; itemId: string; itemColourId: string | null }) => `${row.itemId}|${row.itemColourId ?? ''}|${row.rootLotId ?? ''}`
    const groups = new Map<string, { itemId: string; itemColourId: string | null; rootLotId: string | null }>()
    for (const row of [...flows, ...starts, ...ends]) groups.set(keyOf(row), { itemId: row.itemId, itemColourId: row.itemColourId, rootLotId: row.rootLotId })
    const startOf = new Map(starts.map((row) => [keyOf(row), row]))
    const endOf = new Map(ends.map((row) => [keyOf(row), row]))
    const receivedOf = new Map(received.map((row) => [keyOf(row), row.hides]))
    const flowsOf = new Map<string, LeatherFlowRow[]>()
    for (const row of flows) flowsOf.set(keyOf(row), [...(flowsOf.get(keyOf(row)) ?? []), row])

    const items = await itemsOf(db, unique([...groups.values()].map((row) => row.itemId)))
    const colours = await coloursOf(db, unique([...groups.values()].map((row) => row.itemColourId)))
    const lots = await lotsOf(db, unique([...groups.values()].map((row) => row.rootLotId)))
    const children = await childCountsOf(db, [...lots.keys()])
    const suppliers = await suppliersOf(db, unique([...lots.values()].map((lot) => lot.supplierId)))

    const lotGroups: LotGroup[] = []
    for (const [key, group] of groups) {
      if (!items.has(group.itemId)) continue
      const start = startOf.get(key)
      const end = endOf.get(key)
      const mine = flowsOf.get(key) ?? []
      const figures = leatherFiguresOf(
        { quantity: start?.quantity ?? '0', value: start ? Number(start.value) : 0 },
        mine.map((row) => ({ reason: row.reason, direction: row.direction, quantity: row.quantity, value: Number(row.value) })),
        { quantity: end?.quantity ?? '0', value: end ? Number(end.value) : 0 },
      )
      if (isIdle(figures)) continue
      const currencies = new Currencies()
      for (const row of [start, end, ...mine]) if (row) currencies.add(row.currencyMin, row.currencyMax)
      lotGroups.push({ ...group, figures, hides: { received: receivedOf.get(key) ?? 0, onHand: end?.hides ?? 0 }, currencies })
    }
    const byArticle = new Map<string, LotGroup[]>()
    for (const row of lotGroups) {
      const key = `${row.itemId}|${row.itemColourId ?? ''}`
      byArticle.set(key, [...(byArticle.get(key) ?? []), row])
    }
    const codeOf = (row: LotGroup) => (row.rootLotId ? (lots.get(row.rootLotId)?.code ?? '') : '')
    const sorted = [...byArticle.values()]
      .map((group) => ({ group, item: items.get(group[0]!.itemId)!, colour: group[0]!.itemColourId ? (colours.get(group[0]!.itemColourId) ?? null) : null }))
      .sort((a, b) => a.item.code.localeCompare(b.item.code) || (a.colour?.code ?? '').localeCompare(b.colour?.code ?? ''))

    let room: number = REPORT_LIMITS.leatherLots
    let more = 0
    const totals: { figures: LeatherFigures; uom: Uom; hides: { received: number; onHand: number }; currencies: Currencies }[] = []
    const articles = sorted.map(({ group, item, colour }) => {
      const uom = item.baseUom as Uom
      const figures = group.reduce((sum, row) => addLeather(sum, row.figures), zero)
      const hides = group.reduce((sum, row) => ({ received: sum.received + row.hides.received, onHand: sum.onHand + row.hides.onHand }), { received: 0, onHand: 0 })
      const currencies = group.reduce((sum, row) => sum.merge(row.currencies), new Currencies())
      totals.push({ figures, uom, hides, currencies })
      const lotsOfArticle = [...group].sort((a, b) => codeOf(a).localeCompare(codeOf(b)))
      const kept = lotsOfArticle.slice(0, Math.max(0, room))
      room -= kept.length
      more += lotsOfArticle.length - kept.length
      return {
        item: { id: item.id, code: item.code, name: item.name },
        colour,
        figures: leatherView(figures, uom, hides, currencies),
        lots: kept.map((row) => {
          const lot = row.rootLotId ? lots.get(row.rootLotId) : undefined
          return {
            lot: lot ? { id: lot.id, code: lot.code } : null,
            supplier: lot?.supplierId ? (suppliers.get(lot.supplierId) ?? null) : null,
            supplierLotRef: lot?.supplierLotRef ?? null,
            dyeBatch: lot?.dyeBatch ?? null,
            children: lot ? (children.get(lot.id) ?? 0) : 0,
            figures: leatherView(row.figures, uom, row.hides, row.currencies),
          }
        }),
      }
    })
    // Every article together: in m² when every article is in an area unit (else no quantity is said).
    const everyArea = totals.every((row) => dimensionOf(row.uom) === 'AREA')
    const all = totals.reduce((sum, row) => addLeather(sum, everyArea ? inM2(row.figures, row.uom) : row.figures), zero)
    const allHides = totals.reduce((sum, row) => ({ received: sum.received + row.hides.received, onHand: sum.onHand + row.hides.onHand }), { received: 0, onHand: 0 })
    const allCurrencies = totals.reduce((sum, row) => sum.merge(row.currencies), new Currencies())
    return {
      ...headOf(place),
      sight: place.sight,
      articles,
      all: leatherView(all, everyArea && totals.length > 0 ? 'M2' : null, allHides, allCurrencies),
      more,
      unvaluedMoves: flows.reduce((sum, row) => sum + row.unvalued, 0),
    }
  })
}
