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
 *   phases  PB-9 — the phase table and a product's phase recipes, by what they would do once a phase is switched to:
 *           a recipe's target, highest bid, largest change up (or appearing / going with no inherited number to judge
 *           by), a floor (lowest bid) up, a looser harvest or negate group (the strategy writer's own rules); in the
 *           table, the same of its factors, a slot back from the floor, an hourly plan on or fuller, a harvest cadence
 *           more often, Claude allowed more alone, a shorter hold, any change of an exit rule, a phase added — each a
 *           RAISE, so a playbook edit cannot carry a later raise past the code
 *   same    names, portfolio, flows (harvest edges), hourly plans, budget weights: each is judged again where it acts —
 *           the hourly plans and the flows at a build or a start, which add spend only with a person and the code
 *
 * Only an enrolled product counts (before or after the change): a playbook nobody follows spends nothing.
 */
import { SECTIONS, type PhaseRecipes, type ProductTerms, type SectionKey, type TemplateDoc } from './doc.js'
import { judgeChange, overall, type Direction } from '../ads-strategy/write.js'
import { DEFAULT_HOLD_DAYS } from './defaults.js'

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
      case 'phases':
        out.set(key, judgePhases(before.phases, after.phases))
        break
      default:
        out.set(key, 'same')
    }
  }
  return out
}

// ── PB-9 — the phase table and the recipes, by effect ─────────────────────────────────────────────

type Recipe = NonNullable<PhaseRecipes[keyof PhaseRecipes]>
type Entry = NonNullable<TemplateDoc['phases'][keyof TemplateDoc['phases']]>
/** The strategy writer's rules take no fallback target here (a target appearing or going is judged apart). */
const NO_FALLBACK = { fallbackTargetPct: 0 }
const group = <T extends string>(r: Partial<Record<T, unknown>> | undefined, keys: readonly T[], required: readonly T[]) =>
  r && required.every((k) => r[k] != null) ? Object.fromEntries(keys.map((k) => [k, r[k] ?? null])) : null
const HARVEST = ['harvestMinOrders', 'harvestMinClicks', 'harvestMaxAcosPct', 'harvestWindowDays'] as const
const NEGATE = ['negateMinClicks', 'negateMinSpendCents', 'negateMaxOrders', 'negateWindowDays'] as const

/** A number up raises, down lowers; one appearing or going has nothing inherited to judge by here: a raise (fail closed). */
const upOrUnknown = (b: number | null | undefined, a: number | null | undefined): Direction =>
  b === a || (b == null && a == null) ? 'same' : b == null || a == null ? 'raise' : a > b ? 'raise' : 'lower'

/** One phase's recipe numbers, as the strategy writer would judge them once written (pure). */
export function judgeRecipe(before: Recipe | undefined, after: Recipe | undefined): Direction {
  if (!after) return before ? 'lower' : 'same' // no recipe: the phase cannot be switched to
  return overall([
    upOrUnknown(before?.targetAcosPct, after.targetAcosPct),
    judgeChange('floor', 'minBidCents', before?.minBidCents ?? null, after.minBidCents ?? null, NO_FALLBACK),
    judgeChange('up', 'maxBidCents', before?.maxBidCents ?? null, after.maxBidCents ?? null, NO_FALLBACK),
    judgeChange('up', 'maxChangePct', before?.maxChangePct ?? null, after.maxChangePct ?? null, NO_FALLBACK),
    judgeChange('loosen', 'harvest', group(before, HARVEST, ['harvestMinOrders', 'harvestMinClicks', 'harvestWindowDays']), group(after, HARVEST, ['harvestMinOrders', 'harvestMinClicks', 'harvestWindowDays']), NO_FALLBACK),
    judgeChange('loosen', 'negate', group(before, NEGATE, NEGATE), group(after, NEGATE, NEGATE), NO_FALLBACK),
  ])
}

/** A product's phase recipes (PB-3), every phase by its recipe (pure). */
export function judgeRecipes(before: PhaseRecipes | null | undefined, after: PhaseRecipes | null | undefined): Direction {
  const phases = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]) as Set<keyof PhaseRecipes>
  return overall([...phases].map((p) => judgeRecipe(before?.[p], after?.[p])))
}

const RANK_ORDER = { off: 0, light: 1, on: 2 } as const
const CADENCE_ORDER = { off: 0, weekly: 1, daily: 2 } as const

/** One phase of the table, by what a switch to it would do (pure). */
function judgeEntry(b: Entry, a: Entry): Direction {
  const r = (e: Entry) => e.recipe
  const ds: Direction[] = []
  // The recipe's factors (made absolute at enrollment): the strategy writer's own directions, on the factors.
  const tb = r(b).targetAcos
  const ta = r(a).targetAcos
  if (!same(tb, ta)) ds.push(!tb || !ta || tb.from !== ta.from ? 'raise' : overall([upOrUnknown(tb.factor, ta.factor), upOrUnknown(tb.fallbackFactor, ta.fallbackFactor)]))
  ds.push(judgeChange('floor', 'minBidCents', r(b).bidBand?.minFactor ?? null, r(a).bidBand?.minFactor ?? null, NO_FALLBACK))
  ds.push(judgeChange('up', 'maxBidCents', r(b).bidBand?.maxFactor ?? null, r(a).bidBand?.maxFactor ?? null, NO_FALLBACK))
  ds.push(judgeChange('up', 'maxChangePct', r(b).maxChangePct ?? null, r(a).maxChangePct ?? null, NO_FALLBACK))
  const h = (e: Entry) => (e.recipe.harvest ? { harvestMinOrders: e.recipe.harvest.minOrders, harvestMinClicks: e.recipe.harvest.minClicks, harvestMaxAcosPct: e.recipe.harvest.maxAcosFactor ?? null, harvestWindowDays: e.recipe.harvest.windowDays } : null)
  const n = (e: Entry) => (e.recipe.negate ? { negateMinClicks: e.recipe.negate.minClicks, negateMinSpendCents: e.recipe.negate.minSpendFactor ?? 0, negateMaxOrders: e.recipe.negate.maxOrders, negateWindowDays: e.recipe.negate.windowDays } : null)
  ds.push(judgeChange('loosen', 'harvest', h(b), h(a), NO_FALLBACK))
  ds.push(judgeChange('loosen', 'negate', n(b), n(a), NO_FALLBACK))
  // A slot back from the floor raises; one put at the floor lowers.
  for (const key of new Set([...Object.keys(b.slots ?? {}), ...Object.keys(a.slots ?? {})])) {
    const was = b.slots?.[key] ?? 'active'
    const is = a.slots?.[key] ?? 'active'
    if (was !== is) ds.push(is === 'active' ? 'raise' : 'lower')
  }
  // An hourly plan on or fuller raises (one a phase names on one side only: no clear direction, a raise).
  for (const role of ['performance', 'research'] as const) {
    const was = b.rank?.[role]
    const is = a.rank?.[role]
    if (was === is) continue
    ds.push(!was || !is ? 'raise' : RANK_ORDER[is] > RANK_ORDER[was] ? 'raise' : 'lower')
  }
  if (b.harvestCadence !== a.harvestCadence) ds.push(CADENCE_ORDER[a.harvestCadence] > CADENCE_ORDER[b.harvestCadence] ? 'raise' : 'lower')
  ds.push(judgeChange('autonomy', 'claudeAutonomy', Object.keys(b.claude ?? {}).length ? b.claude : null, Object.keys(a.claude ?? {}).length ? a.claude : null, NO_FALLBACK))
  // A shorter hold lets a move run by rule sooner; an exit rule changed, in any way, has no clear direction.
  const hold = (e: Entry) => e.minDays ?? DEFAULT_HOLD_DAYS
  if (hold(a) !== hold(b)) ds.push(hold(a) < hold(b) ? 'raise' : 'lower')
  if (!same(b.exit ?? [], a.exit ?? [])) ds.push('raise')
  return overall(ds)
}

/** The phase table, by what a switch to each phase would do: a phase added raises, one removed lowers (pure). */
export function judgePhases(before: TemplateDoc['phases'], after: TemplateDoc['phases']): Direction {
  const ds: Direction[] = []
  for (const phase of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]) as Set<keyof TemplateDoc['phases']>) {
    const b = before?.[phase]
    const a = after?.[phase]
    if (!b && !a) continue
    ds.push(!a ? 'lower' : !b ? 'raise' : same(b, a) ? 'same' : judgeEntry(b, a))
  }
  return overall(ds)
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
