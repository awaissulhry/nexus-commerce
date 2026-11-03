import type { BarListItem, BarListKey } from '@nexus/ui/charts/bar-list/index'
import type { Locale } from '../../../../lib/i18n/locales'
import type { Uom } from '../../../_shared/stock/api'
import { convertArea, decimalValue, quantity } from '../../../_shared/stock/model'
import type { CuttingYield, GradeMix, LeatherDashboard, LeatherValue } from './api'

/**
 * The leather dashboard (B-W2b-131; SCM-285, design warehouse.hides sec hd-dashboard), pure: each panel's bars from its
 * read. Bars compare in square metres (a tannery's ft² and a cutter's dm² side by side); every value is WRITTEN in the
 * unit it was counted in with the other unit beside it, and hides beside area (the two numbers, SCM-258). Never money
 * unless the person holds the cost grain (the Area value series), never a person (yield per style and supplier lot).
 */

export type PanelId = 'area' | 'mix' | 'remnants' | 'outside' | 'onHold' | 'yield'
export const PANELS: readonly PanelId[] = ['area', 'mix', 'remnants', 'outside', 'onHold', 'yield']

/** A panel's read: still reading (null, null), its answer, or its problem (a key of `stock`). `held`: the person may not read it (a key of warehouse-hides). */
export interface PanelRead<T> {
  value: T | null
  problem: string | null
  asOf: string | null
  held?: string | null
}

export type UnitWord = (uom: Uom) => string
export type Say = (key: string, params?: Readonly<Record<string, string | number>>) => string

/** The m² of an area in its unit (for the bars only; never written). */
export const m2Of = (area: string | null | undefined, uom: Uom): number => convertArea(decimalValue(area) ?? 0, uom, 'M2') ?? 0

/** "51,80 ft² (4,8 m²)": the area in its unit, the other unit beside it. */
export function areaWords(area: string | number, uom: Uom, unit: UnitWord, locale: Locale): string {
  const value = typeof area === 'number' ? area : (decimalValue(area) ?? 0)
  const other: Uom | null = uom === 'FT2' ? 'M2' : uom === 'M2' || uom === 'DM2' ? 'FT2' : null
  const converted = other ? convertArea(value, uom, other) : null
  const own = `${quantity(value, locale)} ${unit(uom)}`
  return converted !== null && other ? `${own} (${quantity(converted, locale, 1)} ${unit(other)})` : own
}

/** "3 hides · 51,80 ft² (4,8 m²)". */
export const twoNumbers = (hides: number, area: string | number, uom: Uom, unit: UnitWord, locale: Locale, say: Say): string => say('dash.two', { hides: say('dash.hides', { count: hides }), area: areaWords(area, uom, unit, locale) })

/** The article and colour key a bar filters the grid by (`?item=&colour=`). */
export const articleKey = (itemId: string, colourId: string | null | undefined): string => `${itemId}|${colourId ?? ''}`
export function articleOfKey(key: string): { itemId: string; colourId: string | null } {
  const [itemId, colourId] = key.split('|')
  return { itemId: itemId ?? '', colourId: colourId ? colourId : null }
}

// ---- area on hand by article and colour (and its value, cost grain) -------------------------------------------------------

export interface AreaBar {
  key: string
  item: { id: string; code: string; name: string }
  colour: { id: string; code: string; name: string } | null
  uom: Uom
  hides: number
  quantity: number
  m2: number
  /** Minor units (cost grain only), null when the read gave none. */
  value: number | null
  currency: string | null
}

/** The valuation's rows per site, article and colour → one bar per article and colour (sites added; units never mixed). */
export function areaBarsOf(answer: LeatherValue): AreaBar[] {
  const bars = new Map<string, AreaBar>()
  for (const row of answer.rows) {
    const uom = row.item.baseUom as Uom
    const key = articleKey(row.item.id, row.colour?.id)
    const seen = bars.get(key)
    const quantityNow = decimalValue(row.quantity) ?? 0
    const valueNow = row.value === undefined ? null : row.value
    if (!seen) {
      bars.set(key, { key, item: { id: row.item.id, code: row.item.code, name: row.item.name }, colour: row.colour, uom, hides: row.hides, quantity: quantityNow, m2: decimalValue(row.areaM2) ?? m2Of(row.quantity, uom), value: valueNow, currency: row.currency })
      continue
    }
    seen.hides += row.hides
    seen.quantity += quantityNow
    seen.m2 += decimalValue(row.areaM2) ?? m2Of(row.quantity, uom)
    seen.value = seen.value === null || valueNow === null || seen.currency !== row.currency ? null : seen.value + valueNow
  }
  return [...bars.values()].sort((a, b) => b.m2 - a.m2 || `${a.item.code}${a.colour?.code ?? ''}`.localeCompare(`${b.item.code}${b.colour?.code ?? ''}`))
}

/** The bars as the DS BarList takes them: the area (bar in m², written in its unit) or the area's value (cost grain). */
export function areaItems(bars: readonly AreaBar[], series: 'area' | 'value', unit: UnitWord, locale: Locale, say: Say, money: (minor: number, currency: string) => string): BarListItem[] {
  return bars.map((bar) => ({
    id: bar.key,
    label: `${bar.item.code} · ${bar.colour?.name ?? say('dash.noColour')}`,
    sub: twoNumbers(bar.hides, bar.quantity, bar.uom, unit, locale, say),
    value: series === 'area' ? bar.m2 : bar.value,
    valueText: series === 'area' ? areaWords(bar.quantity, bar.uom, unit, locale) : bar.value !== null && bar.currency ? money(bar.value, bar.currency) : '—',
  }))
}

// ---- grade mix per lot (stacked) ------------------------------------------------------------------------------------------

export const UNGRADED = 'ungraded'

/**
 * The legend: every grade the lots hold in the API's tile order (each group lists its grades in that order: a grade's
 * earliest place in any group, then its code), the ungraded last.
 */
export function mixKeys(answer: GradeMix, locale: Locale, say: Say): BarListKey[] {
  const found = new Map<string, { place: number; key: BarListKey }>()
  let ungraded = false
  for (const group of answer.groups)
    group.grades.forEach((row, place) => {
      if (!row.grade) {
        ungraded = true
        return
      }
      const seen = found.get(row.grade.code)
      if (seen && seen.place <= place) return
      found.set(row.grade.code, { place, key: { id: row.grade.code, label: say('dash.mix.grade', { code: row.grade.code, label: locale === 'en' ? row.grade.labelEn : row.grade.labelIt }) } })
    })
  const keys = [...found.values()].sort((a, b) => a.place - b.place || a.key.id.localeCompare(b.key.id)).map((entry) => entry.key)
  if (ungraded) keys.push({ id: UNGRADED, label: say('dash.mix.ungraded'), tone: 'warning' })
  return keys
}

/** One bar per lot (what is left, in m² for the bars), its parts per grade. */
export function mixItems(answer: GradeMix, unit: UnitWord, locale: Locale, say: Say): BarListItem[] {
  return answer.groups
    .filter((group) => group.lot)
    .map((group) => {
      const parts: Record<string, number> = {}
      for (const row of group.grades) {
        const id = row.grade?.code ?? UNGRADED
        parts[id] = (parts[id] ?? 0) + m2Of(row.left, group.uom)
      }
      return {
        id: group.lot!.id,
        label: group.lot!.code,
        sub: `${group.item.code}${group.colour ? ` · ${group.colour.name}` : ''} · ${say('dash.hides', { count: group.hides })}`,
        value: m2Of(group.left, group.uom),
        valueText: areaWords(group.left, group.uom, unit, locale),
        parts,
      }
    })
}

/** The remnants in stock, per unit: "12 pieces · 8,40 m² (90,4 ft²)". */
export function remnantLines(answer: GradeMix, unit: UnitWord, locale: Locale, say: Say): string[] {
  return answer.totals.filter((total) => total.remnants.pieces > 0).map((total) => say('dash.two', { hides: say('dash.pieces', { count: total.remnants.pieces }), area: areaWords(total.remnants.area, total.uom, unit, locale) }))
}

// ---- at subcontractors, on hold ------------------------------------------------------------------------------------------

export function outsideItems(answer: LeatherDashboard, unit: UnitWord, locale: Locale, say: Say): BarListItem[] {
  return answer.atSubcontractors.rows.map((row) => ({
    id: `${row.location.id}|${articleKey(row.item.id, row.colour?.id)}`,
    label: row.party ? `${row.party.name} · ${row.location.code}` : row.location.code,
    sub: `${row.item.code}${row.colour ? ` · ${row.colour.name}` : ''} · ${say('dash.hides', { count: row.hides })}`,
    value: m2Of(row.area, row.uom),
    valueText: areaWords(row.area, row.uom, unit, locale),
  }))
}

export const HOLD_KEYS = ['lotNotReleased', 'qualityHold'] as const

export function onHoldItems(answer: LeatherDashboard, unit: UnitWord, locale: Locale, say: Say): BarListItem[] {
  return answer.onHold.rows.map((row) => {
    const hides = row.lotNotReleased.hides + row.qualityHold.hides
    const area = (decimalValue(row.lotNotReleased.area) ?? 0) + (decimalValue(row.qualityHold.area) ?? 0)
    return {
      id: articleKey(row.item.id, row.colour?.id),
      label: `${row.item.code} · ${row.colour?.name ?? say('dash.noColour')}`,
      sub: twoNumbers(hides, area, row.uom, unit, locale, say),
      value: m2Of(String(area), row.uom),
      valueText: areaWords(area, row.uom, unit, locale),
      parts: { lotNotReleased: m2Of(row.lotNotReleased.area, row.uom), qualityHold: m2Of(row.qualityHold.area, row.uom) },
    }
  })
}

/** "2 hides · 98,00 ft² (9,1 m²)" per unit for a panel's sums line. */
export function sumLines(sums: readonly { uom: Uom; hides: number; area: string }[], unit: UnitWord, locale: Locale, say: Say): string[] {
  return sums.filter((sum) => sum.hides > 0).map((sum) => twoNumbers(sum.hides, sum.area, sum.uom, unit, locale, say))
}

export function holdSumLines(answer: LeatherDashboard, unit: UnitWord, locale: Locale, say: Say): string[] {
  return answer.onHold.sums.map((sum) => {
    const hides = sum.lotNotReleased.hides + sum.qualityHold.hides
    const area = (decimalValue(sum.lotNotReleased.area) ?? 0) + (decimalValue(sum.qualityHold.area) ?? 0)
    return twoNumbers(hides, area, sum.uom, unit, locale, say)
  })
}

// ---- yield of the last 30 days, per style and supplier lot (never per cutter) ----------------------------------------------

export const YIELD_DAYS = 30

/** The last 30 days up to now: the yield read's from / to (instants). */
export function yieldRange(now: Date): { from: string; to: string } {
  return { from: new Date(now.getTime() - YIELD_DAYS * 86_400_000).toISOString(), to: now.toISOString() }
}

export function yieldItems(answer: CuttingYield, locale: Locale, say: Say): BarListItem[] {
  return answer.byStyleAndLot.map((row) => {
    const value = decimalValue(row.yieldPct)
    const variance = decimalValue(row.variancePct)
    return {
      id: `${row.style.id}|${row.lot.id}`,
      label: `${row.style.code} · ${row.lot.code}`,
      sub: [row.supplier?.name, row.lot.supplierLotRef ? say('dash.yield.supplierLot', { ref: row.lot.supplierLotRef }) : null, say('dash.hides', { count: row.hides }), row.plannedPct ? say('dash.yield.planned', { pct: quantity(row.plannedPct, locale) }) : null].filter(Boolean).join(' · '),
      value,
      valueText: value === null ? '—' : `${quantity(value, locale)} %`,
      tone: variance !== null && variance < 0 ? ('warning' as const) : undefined,
    }
  })
}

// ---- open state, per person ----------------------------------------------------------------------------------------------

export const DASHBOARD_OPEN_KEY = 'fw.warehouse.hides.dashboard'

/** The dashboard's open state as this browser keeps it for the person (default open); storage may be missing. */
export function readOpen(storage: Pick<Storage, 'getItem'> | null): boolean {
  try {
    return storage?.getItem(DASHBOARD_OPEN_KEY) !== 'closed'
  } catch {
    return true
  }
}

export function writeOpen(storage: Pick<Storage, 'setItem'> | null, open: boolean): void {
  try {
    storage?.setItem(DASHBOARD_OPEN_KEY, open ? 'open' : 'closed')
  } catch {
    // A private window or blocked storage: the state lives for this page only.
  }
}
