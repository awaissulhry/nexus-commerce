import { cents, type CostOfOne, type Words } from '../now/model'

/**
 * owb-pd5b step 5.3 (S4; design plan § 5zh "What if"; prototype cost.js costWhat + costParts' `mat` / `work`) — a calculator in the
 * browser, nothing is saved: the materials cost n % more or less, the work m % more or less, at a price p → the new cost of one piece,
 * the margin at that price (a share of the PRICE), the lowest price that keeps the target. The overhead is counted on the materials and
 * the work (the costing settings' rule: a percent on material + labour), so it moves with them; the other costs stay. No React, no API.
 */

export interface WhatIfInput {
  /** As typed: "+10", "-5", "" (none). */
  readonly materialsPct: string
  readonly workPct: string
  /** A price of one piece, as typed ("" = none). */
  readonly price: string
}

export interface WhatIfBase {
  readonly materials: number
  readonly work: number
  readonly overhead: number
  readonly other: number
}

export const PCT_MIN = -90
export const PCT_MAX = 300
export const PRICE_MAX = 999_999

/** A percent change as typed: "" = 0; "+10" / "10" / "-5,5"; out of −90…300 or not a number = null. */
export function pctOf(text: string): number | null {
  const value = text.trim().replace(',', '.').replace(/^\+/, '')
  if (value === '') return 0
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) return null
  const n = Number(value)
  return n < PCT_MIN || n > PCT_MAX ? null : n
}

/** A price as typed: "" = none (undefined); not a number or out of 0…999 999 = null. */
export function priceOf(text: string): number | undefined | null {
  const value = text.trim().replace(',', '.')
  if (value === '') return undefined
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null
  const n = Number(value)
  return n > PRICE_MAX ? null : n
}

/** The base of the calculator: the cost of one piece now, in its 4 parts (what is known so far). */
export function whatIfBaseOf(cost: CostOfOne): WhatIfBase {
  const amount = (part: string) => Number(cost.parts.find((entry) => entry.part === part)?.amount ?? 0)
  return { materials: amount('materials'), work: amount('work'), overhead: amount('overhead'), other: amount('other') }
}

/** The margin at a price, a share of the PRICE, one decimal; null without a price above 0. */
export const marginAt = (price: number | undefined | null, cost: number): number | null => (price && price > 0 ? Math.round(((price - cost) / price) * 1000) / 10 : null)

/** The lowest price that keeps the target margin (a share of the price), up to the cent. */
export const priceForTarget = (cost: number, targetPct: number): number | null => (targetPct >= 100 || cost <= 0 ? null : Math.ceil((cost / (1 - targetPct / 100)) * 100 - 1e-9) / 100)

export interface WhatIfAnswer {
  /** null: a field is not a number (the field's own words say which). */
  readonly cost: string | null
  /** The new cost against the cost now (+ more, − less). */
  readonly change: string | null
  readonly margin: number | null
  readonly priceForTarget: string | null
  /** The margin against the target: keeps it, under the target, under the cost. */
  readonly verdict: 'KEEPS' | 'UNDER_TARGET' | 'UNDER_COST' | null
  /** Which typed field is not accepted (its words). */
  readonly problems: Readonly<Partial<Record<keyof WhatIfInput, Words>>>
  /** Something was typed (the card offers "Clear"). */
  readonly touched: boolean
}

export function whatIf(base: WhatIfBase, input: WhatIfInput, targetPct: number): WhatIfAnswer {
  const m = pctOf(input.materialsPct)
  const w = pctOf(input.workPct)
  const p = priceOf(input.price)
  const problems: Partial<Record<keyof WhatIfInput, Words>> = {}
  if (m === null) problems.materialsPct = { key: 'whatif.bad.pct', params: { min: PCT_MIN, max: PCT_MAX } }
  if (w === null) problems.workPct = { key: 'whatif.bad.pct', params: { min: PCT_MIN, max: PCT_MAX } }
  if (p === null) problems.price = { key: 'whatif.bad.price' }
  const touched = input.materialsPct.trim() !== '' || input.workPct.trim() !== '' || input.price.trim() !== ''
  if (m === null || w === null) return { cost: null, change: null, margin: null, priceForTarget: null, verdict: null, problems, touched }
  const materials = base.materials * (1 + m / 100)
  const work = base.work * (1 + w / 100)
  const before = base.materials + base.work
  const overhead = before > 0 ? base.overhead * ((materials + work) / before) : base.overhead
  const cost = Math.round((materials + work + overhead + base.other) * 100) / 100
  const now = Math.round((before + base.overhead + base.other) * 100) / 100
  const margin = p === null ? null : marginAt(p, cost)
  const floor = priceForTarget(cost, targetPct)
  return {
    cost: cents(cost),
    change: cents(cost - now),
    margin,
    priceForTarget: floor === null ? null : cents(floor),
    verdict: margin === null ? null : margin < 0 ? 'UNDER_COST' : margin < targetPct ? 'UNDER_TARGET' : 'KEEPS',
    problems,
    touched,
  }
}
