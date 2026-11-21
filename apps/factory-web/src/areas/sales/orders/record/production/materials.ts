import type { ReadinessRow } from '../../../../production/work-orders/daily/api'
import type { Materials } from '../../depth/api'

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
  readonly label: string | null
  readonly uom: string | null
  readonly word: ReadinessRow['materials'][number]['word']
  readonly date: string | null
  readonly needed: number | null
  readonly short: number | null
  readonly workOrders: readonly string[]
  readonly purchaseOrders: readonly { readonly id: string; readonly number: string; readonly dueDate: string | null }[]
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
      byKey.set(key, {
        key,
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
