/**
 * The Negative Targeting builder's ONE extra section, "Stop waste — may run alone" (Owner 2026-10-11, wave 4: the old
 * negative-targeting builder exactly as it was, plus one small part). Off by default, so an old rule opens and saves
 * exactly as before. On, the rule carries the safe test as `stopWaste` on its first action — the shape the API already
 * reads (`stopWasteParamsOf`, `ads-graduation-stopwaste.ts`) — and its action: "Negative exact" (shoppers' search terms)
 * or "Pause keyword, keep it paused" (our keywords; the API's adapter runs it on the keyword test, its trigger follows).
 * Only such a rule may reach Auto, inside the daily caps. Pure, tested in Node.
 */

export type StopWasteKind = 'PAUSE_KEYWORD' | 'NEGATE_TERM'

/** The section as the form holds it: the numbers as typed (a decimal comma is fine). */
export interface StopWasteForm {
  on: boolean
  kind: StopWasteKind
  windowDays: string
  minClicks: string
  cpaMultiple: string
  /** The spend bar for a product with no target cost per order, in the market's money; null when the money is hidden. */
  spendFloor: string | null
}

/** What GET /api/advertising/waste/rules/starters gives (money absent without the ad spend permission). */
export interface Starter { kind: StopWasteKind; windowDays: number; minClicks: number; cpaMultiple: number; spendFloorCents?: number }

/** The API's own bounds (`stopWasteParamsOf`): a window of 14–87 click-days (to 3 days ago, so 90 back), 1–10 000 clicks. */
export const BOUNDS = { windowDays: [14, 87], minClicks: [1, 10_000], cpaMultiple: [0.5, 10] } as const

const centsText = (c: number | undefined | null): string | null => (typeof c === 'number' ? String(c / 100) : null)

/** The form a kind opens on: its starter's numbers (the PLAN §2 defaults the API serves). */
export function formOfStarter(s: Starter, on = false): StopWasteForm {
  return { on, kind: s.kind, windowDays: String(s.windowDays), minClicks: String(s.minClicks), cpaMultiple: String(s.cpaMultiple), spendFloor: centsText(s.spendFloorCents) }
}

/** A saved rule's section (its first action's `stopWaste`); null when it has none. Money only when the person may see it. */
export function formOfSaved(raw: unknown, moneyShown: boolean): StopWasteForm | null {
  const p = (raw ?? null) as Partial<{ kind: unknown; windowDays: unknown; minClicks: unknown; cpaMultiple: unknown; spendFloorCents: unknown }> | null
  if (!p || (p.kind !== 'PAUSE_KEYWORD' && p.kind !== 'NEGATE_TERM')) return null
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '')
  return {
    on: true, kind: p.kind, windowDays: n(p.windowDays), minClicks: n(p.minClicks), cpaMultiple: n(p.cpaMultiple),
    spendFloor: moneyShown && typeof p.spendFloorCents === 'number' ? String(p.spendFloorCents / 100) : null,
  }
}

const readNumber = (text: string): number | null => {
  const t = text.replace(',', '.').trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** What is wrong with each field, in a few words; empty when the section can be saved (or is off). */
export function sectionProblems(f: StopWasteForm): Partial<Record<'windowDays' | 'minClicks' | 'cpaMultiple' | 'spendFloor', string>> {
  if (!f.on) return {}
  const out: Partial<Record<'windowDays' | 'minClicks' | 'cpaMultiple' | 'spendFloor', string>> = {}
  const within = (v: number | null, [lo, hi]: readonly [number, number], whole = false) => v != null && v >= lo && v <= hi && (!whole || Number.isInteger(v))
  if (!within(readNumber(f.windowDays), BOUNDS.windowDays, true)) out.windowDays = `A whole number of days, ${BOUNDS.windowDays[0]} to ${BOUNDS.windowDays[1]}`
  if (!within(readNumber(f.minClicks), BOUNDS.minClicks, true)) out.minClicks = `A whole number, ${BOUNDS.minClicks[0]} to ${BOUNDS.minClicks[1].toLocaleString('en-GB')}`
  if (!within(readNumber(f.cpaMultiple), BOUNDS.cpaMultiple)) out.cpaMultiple = `${BOUNDS.cpaMultiple[0]} to ${BOUNDS.cpaMultiple[1]} times`
  if (f.spendFloor != null) {
    const v = readNumber(f.spendFloor)
    if (v == null || v <= 0) out.spendFloor = 'More than 0'
  }
  return out
}

/** The `stopWaste` the first action carries (the API's keys); null when the section is off or a number cannot be read. */
export function stopWastePayload(f: StopWasteForm): { kind: StopWasteKind; windowDays: number; minClicks: number; cpaMultiple: number; spendFloorCents?: number } | null {
  if (!f.on || Object.keys(sectionProblems(f)).length) return null
  const floor = f.spendFloor != null ? readNumber(f.spendFloor) : null
  return {
    kind: f.kind,
    windowDays: readNumber(f.windowDays)!,
    minClicks: readNumber(f.minClicks)!,
    cpaMultiple: readNumber(f.cpaMultiple)!,
    ...(floor != null ? { spendFloorCents: Math.round(floor * 100) } : {}),
  }
}

/** One Ad Group Mapping row as the builder holds it. */
export interface MappedGroup { look: boolean; types: { P: boolean; E: boolean; product: boolean } }

/**
 * Why Automate stays held with the section on (the API's own shape check and words, `builderShapeWhy` /
 * BUILDER_SHAPE_WHY in ads-graduation-stopwaste.ts); null when this rule may run alone. "Negative exact" needs a negative
 * exact only — E in every ad group it looks in, no P or product target anywhere in its mapping — at ad-group level.
 */
export function autoHeldBy(f: StopWasteForm, p: { negationLevel: string; groups: readonly MappedGroup[] }): string | null {
  if (!f.on) return null
  if (f.kind === 'PAUSE_KEYWORD') return null
  if (p.negationLevel !== 'adgroup') return 'Set Negation Level to Ad Group: a negative for the whole campaign always asks you.'
  const looking = p.groups.filter((g) => g.look)
  if (!looking.length) return 'Add an ad group to look in, in Ad Group Mapping.'
  if (p.groups.some((g) => g.types.P || g.types.product) || looking.some((g) => !g.types.E)) return EXACT_ONLY_ASKS
  return null
}

/** BUILDER_SHAPE_WHY.exactOnly, word for word. */
export const EXACT_ONLY_ASKS = 'Negative exact only: tick E in every ad group it looks in, and no P or product target in its Ad Group Mapping — a phrase or a product target always asks you.'

/**
 * Audit M2 — with the section on and "Negative exact", the rule makes exact negatives only: the mapping's P and product
 * targets are switched off (and held). The same array back when nothing changes, so a caller's effect settles. Pure.
 */
export function exactOnlyBlocks<B extends { groups: ReadonlyArray<{ types: { P: boolean; E: boolean; product: boolean } }> }>(blocks: B[]): B[] {
  if (!blocks.some((b) => b.groups.some((g) => g.types.P || g.types.product))) return blocks
  return blocks.map((b) => ({ ...b, groups: b.groups.map((g) => (g.types.P || g.types.product ? { ...g, types: { ...g.types, P: false, product: false } } : g)) }) as B)
}

/** One mapping row's phrase and product ticks, as they were before "Negative exact" held them (audit R-S1). */
export type TypesBefore = ReadonlyMap<string, { P: boolean; product: boolean }>
type Blocks = ReadonlyArray<{ id: number; groups: ReadonlyArray<{ id: string; types: { P: boolean; E: boolean; product: boolean } }> }>
const typesKey = (blockId: number, groupId: string) => `${blockId}:${groupId}`

/**
 * What "Negative exact" is about to switch off, added to what it already remembers (a row it holds keeps its first
 * memory; a row added while it holds is remembered as it came in). Pure.
 */
export function rememberTypes(blocks: Blocks, before: TypesBefore): Map<string, { P: boolean; product: boolean }> {
  const out = new Map(before)
  for (const b of blocks) for (const g of b.groups) {
    const k = typesKey(b.id, g.id)
    if (!out.has(k) && (g.types.P || g.types.product)) out.set(k, { P: g.types.P, product: g.types.product })
  }
  return out
}

/** The section went off (or to a keyword pause): every row it held gets its phrase and product ticks back, exactly. Pure. */
export function restoreTypes<B extends Blocks[number]>(blocks: B[], before: TypesBefore): B[] {
  if (!before.size) return blocks
  return blocks.map((b) => ({
    ...b,
    groups: b.groups.map((g) => { const was = before.get(typesKey(b.id, g.id)); return was ? { ...g, types: { ...g.types, ...was } } : g }),
  }) as B)
}

/** Why a held target type cannot be ticked, said where it is held. */
export const HELD_TYPES_WHY: Readonly<Record<StopWasteKind, string>> = {
  NEGATE_TERM: 'Stop waste is on with "Negative exact": exact negatives only. Turn the section off to create a phrase or a product target.',
  PAUSE_KEYWORD: 'Not used by "Pause keyword, keep it paused": it pauses our keywords, it creates no target.',
}

/** S2 — the parts a keyword pause does not read, held in place with this reason. */
export const PAUSE_UNUSED = 'Not used by "Pause keyword, keep it paused": a keyword pause reads only the criteria and the ad groups it looks in.'

/** S1 — the one window the criteria are read over with the section on (the safe test's). */
export function windowWords(f: StopWasteForm): string {
  const d = Number(f.windowDays.replace(',', '.'))
  const days = Number.isInteger(d) && d > 0 ? `${d} click-days` : 'its window'
  return `With Stop waste on, the criteria are read over the safe test's window: ${days}, clicks and spend up to 3 days ago, orders up to today. Days out of stock are left out.`
}

export const KIND_WORD: Readonly<Record<StopWasteKind, { title: string; description: string }>> = {
  NEGATE_TERM: { title: 'Negative exact', description: 'A shopper\'s search term that wastes gets a negative exact — no phrase, no product target' },
  PAUSE_KEYWORD: { title: 'Pause keyword, keep it paused', description: 'Our keyword that wastes is paused, and nothing turns it back on by itself — only a person' },
}

/** The caps, said once (the API's STOP_WASTE_CAPS: per product, per day). */
export const CAPS_WORDS = 'On Automate it acts alone inside its caps — at most 20 negatives and 10 keyword pauses per product a day. A protected term, a term or keyword that sold, a keyword under 30 days old, a place under 14 days old and a campaign no single product owns always ask you.'
