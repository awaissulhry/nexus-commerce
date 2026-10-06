/**
 * ADS PLAYBOOK PB-3 — is a playbook change a RAISE? Pure. Nothing at Amazon moves when a playbook is saved, but what it
 * says is what a later apply builds and starts. So a change is judged by what it would make an ENROLLED product spend
 * once applied, the W1 rule (Owner decision 2026-10-06): a raise needs settings.security.manage and a fresh
 * authenticator code, and never runs by rule.
 *
 *   raise   enrolling a product · a higher (or a first) daily budget or base bid · a positive term added (brand,
 *           category, competitor, competitor ASIN), a category term newly exact at start, a product negative removed ·
 *           a slot added, an Auto group switched on or its factor up · a start-bid factor up · a placement up · a
 *           higher least budget per slot · an isolation switch turned off
 *   lower   the opposite of each
 *   same    names, portfolio, flows (harvest edges), hourly plans, the phase table and its recipes, budget weights:
 *           each is judged again where it acts — a phase's numbers by the strategy's writer at a phase switch, the
 *           hourly plans and the flows at a build or a start, which add spend only with a person and the code
 *
 * Only an enrolled product counts (before or after the change): a playbook nobody follows spends nothing.
 */
import { SECTIONS, type ProductTerms, type SectionKey, type TemplateDoc } from './doc.js'
import { overall, type Direction } from '../ads-strategy/write.js'

export type { Direction }
export { overall }

const canonical = (value: unknown): string => {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sorted)
      : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]))
        : v
  return JSON.stringify(sorted(JSON.parse(JSON.stringify(value ?? null))))
}
export const same = (a: unknown, b: unknown) => canonical(a) === canonical(b)

/** Up when any shared number rises (or a new one appears above zero), down when any falls (or goes); else same. */
function numbers(before: Readonly<Record<string, number>>, after: Readonly<Record<string, number>>, newIsUp = true): Direction {
  const ds: Direction[] = []
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[key]
    const a = after[key]
    if (b === undefined && a !== undefined) ds.push(newIsUp && a > 0 ? 'raise' : 'same')
    else if (a === undefined && b !== undefined) ds.push(b > 0 ? 'lower' : 'same')
    else if (a > b) ds.push('raise')
    else if (a < b) ds.push('lower')
  }
  return overall(ds)
}

const flat = (placements: TemplateDoc['placements']) =>
  Object.fromEntries(Object.entries(placements).flatMap(([slot, p]) => Object.entries(p).map(([where, pct]) => [`${slot}.${where}`, pct])))
const autoFactors = (doc: TemplateDoc) => Object.fromEntries(doc.structure.slots.flatMap((s) =>
  Object.entries(s.autoGroups ?? {}).map(([group, g]) => [`${s.key}.${group}`, g?.on ? g.factor : 0])))

/** Each section's direction from one doc to the next (null: the product cannot be built from it). */
export function judgeDoc(before: TemplateDoc | null, after: TemplateDoc | null): Map<SectionKey, Direction> {
  const out = new Map<SectionKey, Direction>()
  if (!before && !after) return out
  if (!after) { out.set('structure', 'lower'); return out }
  if (!before) { out.set('structure', 'raise'); return out }
  for (const key of SECTIONS) {
    if (same(before[key], after[key])) continue
    switch (key) {
      case 'structure': {
        const had = new Set(before.structure.slots.map((s) => s.key))
        const has = new Set(after.structure.slots.map((s) => s.key))
        const added = [...has].some((k) => !had.has(k))
        const removed = [...had].some((k) => !has.has(k))
        out.set(key, overall([added ? 'raise' : 'same', removed ? 'lower' : 'same', numbers(autoFactors(before), autoFactors(after))]))
        break
      }
      case 'budget':
        out.set(key, numbers({ least: before.budget.minPerSlotCents }, { least: after.budget.minPerSlotCents }))
        break
      case 'bids':
        out.set(key, numbers(before.bids.ladder, after.bids.ladder))
        break
      case 'placements':
        out.set(key, numbers(flat(before.placements), flat(after.placements)))
        break
      case 'isolation': {
        const ds: Direction[] = []
        for (const k of Object.keys(after.isolation) as Array<keyof TemplateDoc['isolation']>) {
          if (before.isolation[k] && !after.isolation[k]) ds.push('raise')
          if (!before.isolation[k] && after.isolation[k]) ds.push('lower')
        }
        out.set(key, overall(ds))
        break
      }
      default:
        out.set(key, 'same')
    }
  }
  return out
}

const set = (values: readonly string[] | undefined) => new Set((values ?? []).map((v) => v.trim().toLowerCase()))
const grew = (b: Set<string>, a: Set<string>) => [...a].some((v) => !b.has(v))
const shrank = (b: Set<string>, a: Set<string>) => [...b].some((v) => !a.has(v))

/** The product's terms: positive terms (and exact-at-start marks) added raise; product negatives removed raise. */
export function judgeTerms(before: ProductTerms | null, after: ProductTerms | null): Direction {
  const ds: Direction[] = []
  for (const list of ['brand', 'competitor', 'competitorAsins'] as const) {
    const b = set(before?.[list])
    const a = set(after?.[list])
    if (grew(b, a)) ds.push('raise')
    if (shrank(b, a)) ds.push('lower')
  }
  const cat = (t: ProductTerms | null, exact: boolean) => set(t?.category.filter((c) => !exact || c.exactAtStart).map((c) => c.text))
  for (const exact of [false, true]) {
    if (grew(cat(before, exact), cat(after, exact))) ds.push('raise')
    if (shrank(cat(before, exact), cat(after, exact))) ds.push('lower')
  }
  const neg = (t: ProductTerms | null) => set(t?.negatives.map((n) => `${n.match}|${n.text}`))
  if (grew(neg(before), neg(after))) ds.push('lower')
  if (shrank(neg(before), neg(after))) ds.push('raise')
  return overall(ds)
}

/** A money number of the product (daily budget, base bid): a first one or a higher one raises; a lower one or none lowers. */
export function judgeMoney(before: number | null, after: number | null): Direction {
  if (before === after) return 'same'
  if (after == null) return 'lower'
  if (before == null) return 'raise'
  return after > before ? 'raise' : 'lower'
}

/** Enrolling raises; leaving lowers. */
export const judgeEnrolled = (before: boolean, after: boolean): Direction => (before === after ? 'same' : after ? 'raise' : 'lower')
