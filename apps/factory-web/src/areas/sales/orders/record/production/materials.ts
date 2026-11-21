import type { ReadinessRow } from '../../../../production/work-orders/daily/api'
import type { Materials } from '../../depth/api'
import type { ShortageLine } from '../../../../purchasing/requests/ask/model'

/**
 * F-PT-303 (order PRODUCTION tab, 10-design §8; S9; bugs B40–B43; lead settle L4) — Materials, without a screen: do we have everything
 * to make this order. Both halves meet in ONE answer and ONE "missing first" list: the customer's own goods still to come ("8 m still to
 * come (12 of 20 m arrived)" — B41; "Arrived" on this tab, L4) and what we buy that is not there yet (the production lane's readiness
 * per work order, its own words — "Received" stays its word, L4 — with what is needed and short and the purchase orders that bring it,
 * B-PT-014). "More used than received" is gone (B40: it can never be true). Quantities only: never a price.
 */

const num = (value: string | number | null | undefined): number => {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

export interface CustomerGood {
  readonly id: string
  /** F-PT-304: the material and its colour (a receipt line names them). */
  readonly itemId: string
  readonly itemColourId: string | null
  readonly item: string
  readonly code: string
  readonly colour: string | null
  readonly uom: string
  readonly expected: number
  readonly arrived: number
  readonly used: number
  readonly left: number
  /** Still to come (never below 0). */
  readonly toCome: number
  readonly lots: readonly string[]
}

export function customerGoodsOf(view: Materials | null | undefined): CustomerGood[] | null {
  if (!view) return null
  return view.rows.map((row) => {
    const expected = num(row.expected)
    const arrived = num(row.received)
    return {
      id: row.id,
      itemId: row.item.id,
      itemColourId: row.colour?.id ?? null,
      item: row.item.name,
      code: row.item.code,
      colour: row.colour ? (row.colour.name ? `${row.colour.code} · ${row.colour.name}` : row.colour.code) : null,
      uom: row.uom,
      expected,
      arrived,
      used: num(row.used),
      left: num(row.left),
      toCome: Math.max(0, expected - arrived),
      lots: view.lots.filter((lot) => lot.itemId === row.item.id && (row.colour === null || lot.itemColourId === null || lot.itemColourId === row.colour.id)).map((lot) => lot.code),
    }
  })
}

/** One material we buy, by material over the order's work orders (the worst word first). */
export interface BoughtMaterial {
  readonly key: string
  /** F-PT-304: the material and colour (Ask the buyers… names them), and each work order short of it (the ask is per work order). */
  readonly itemId: string
  readonly itemColourId: string | null
  readonly shortages: readonly Shortage[]
  readonly label: string | null
  readonly uom: string | null
  readonly word: ReadinessRow['materials'][number]['word']
  readonly date: string | null
  readonly needed: number | null
  readonly short: number | null
  readonly workOrders: readonly string[]
  readonly purchaseOrders: readonly { readonly id: string; readonly number: string; readonly dueDate: string | null }[]
}

/** One work order short of a material we buy (NOT_ENOUGH / DELAYED: what the buyers can be asked for, planning's shortage). */
export interface Shortage {
  readonly workOrderId: string
  readonly number: string | null
  readonly word: 'NOT_ENOUGH' | 'DELAYED'
  readonly short: string
  readonly neededOn: string | null
}

/** F-PT-304: one shortage's key — the work order, the material, its colour (as planning's own list keys an ask). */
export const askKeyOf = (workOrderId: string, itemId: string, itemColourId: string | null): string => `${workOrderId}|${itemId}|${itemColourId ?? '-'}`

/**
 * F-PT-304: what Ask the buyers… asks for one material we buy — its first work order short of it not asked yet (the from-shortage
 * dialog asks per work order, on that work order's site), or the day the first one was asked ("Asked 20 Nov"); null: nothing to ask.
 */
export function askOf(material: Pick<BoughtMaterial, 'itemId' | 'itemColourId' | 'label' | 'uom' | 'shortages'>, workOrders: readonly { readonly id: string; readonly siteId: string }[], asked: ReadonlyMap<string, string>, today: string): { readonly kind: 'asked'; readonly at: string } | { readonly kind: 'ask'; readonly line: ShortageLine } | null {
  const keyOf = (shortage: Shortage) => askKeyOf(shortage.workOrderId, material.itemId, material.itemColourId)
  const done = material.shortages.map((shortage) => asked.get(keyOf(shortage))).find((at): at is string => !!at)
  const open = material.shortages.find((shortage) => !asked.has(keyOf(shortage)) && workOrders.some((row) => row.id === shortage.workOrderId))
  if (open) {
    const siteId = workOrders.find((row) => row.id === open.workOrderId)!.siteId
    return { kind: 'ask', line: { siteId, workOrder: { id: open.workOrderId, number: open.number ?? '—' }, material: { itemId: material.itemId, itemColourId: material.itemColourId, label: material.label ?? '—', uom: material.uom ?? '' }, word: open.word, short: open.short, neededBy: open.neededOn ?? today } }
  }
  return done ? { kind: 'asked', at: done } : null
}

/** The words a material is "there" by (the production lane's: reserved or issued, or nothing planned). */
const THERE = new Set(['RECEIVED', 'NOT_PLANNED'])
/** How bad a word is (the readiness order of the work order page): worst first. */
const RANK = ['NOT_ENOUGH', 'DELAYED', 'NOT_BOOKED', 'REQUESTED', 'EXPECTED', 'RECEIVED', 'NOT_PLANNED']

export function boughtOf(rows: readonly ReadinessRow[] | null | undefined, numberOf: (workOrderId: string) => string | null): BoughtMaterial[] | null {
  if (!rows) return null
  const byKey = new Map<string, BoughtMaterial>()
  for (const row of rows) {
    for (const material of row.materials) {
      const key = `${material.itemId}:${material.itemColourId ?? '-'}`
      const known = byKey.get(key)
      const number = numberOf(row.workOrderId)
      const worse = !known || RANK.indexOf(material.word) < RANK.indexOf(known.word)
      const sum = (a: number | null, b: string | number | null | undefined) => (b === null || b === undefined ? a : (a ?? 0) + num(b))
      const shortage: Shortage | null =
        material.word === 'NOT_ENOUGH' || material.word === 'DELAYED' ? { workOrderId: row.workOrderId, number, word: material.word, short: String(material.short ?? material.needed ?? '0'), neededOn: material.neededOn ?? material.date ?? null } : null
      byKey.set(key, {
        key,
        itemId: material.itemId,
        itemColourId: material.itemColourId,
        shortages: shortage ? [...(known?.shortages ?? []), shortage] : (known?.shortages ?? []),
        label: material.label ?? known?.label ?? null,
        uom: material.uom ?? known?.uom ?? null,
        word: worse ? material.word : known!.word,
        date: worse ? material.date : known!.date,
        needed: sum(known?.needed ?? null, material.needed),
        short: sum(known?.short ?? null, material.short),
        workOrders: number && !(known?.workOrders ?? []).includes(number) ? [...(known?.workOrders ?? []), number] : (known?.workOrders ?? []),
        purchaseOrders: [...(known?.purchaseOrders ?? []), ...(material.purchaseOrders ?? []).filter((po) => !(known?.purchaseOrders ?? []).some((other) => other.id === po.id)).map((po) => ({ id: po.id, number: po.number, dueDate: po.dueDate }))],
      })
    }
  }
  return [...byKey.values()].sort((a, b) => RANK.indexOf(a.word) - RANK.indexOf(b.word) || (a.label ?? '').localeCompare(b.label ?? ''))
}

export const isThere = (material: Pick<BoughtMaterial, 'word'>): boolean => THERE.has(material.word)

/** The answer line: everything here, N things missing, or nothing to check yet (no work order: what we buy is not planned). */
export type MaterialsAnswer = { readonly kind: 'reading' } | { readonly kind: 'noWork' } | { readonly kind: 'allHere' } | { readonly kind: 'missing'; readonly count: number }

export function materialsAnswerOf(goods: readonly CustomerGood[] | null, bought: readonly BoughtMaterial[] | null, workOrders: number): MaterialsAnswer {
  const missing = (goods ?? []).filter((good) => good.toCome > 0).length + (bought ?? []).filter((material) => !isThere(material)).length
  if (missing > 0) return { kind: 'missing', count: missing }
  if (workOrders === 0) return { kind: 'noWork' }
  if (goods === null && bought === null) return { kind: 'reading' }
  return { kind: 'allHere' }
}
