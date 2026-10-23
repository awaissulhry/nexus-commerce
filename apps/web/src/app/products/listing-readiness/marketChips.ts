/**
 * Listing readiness — the Markets column's chips, the Next step line and the Fix target, in words.
 *
 * One chip per destination the row is on, in the API's destination order (Shared, then channel, market, store,
 * alias). The chip's colour and word are the design system's (`readinessMeta(state, 'scope')`); its number is the
 * API's `issueCount`. Nothing here decides a verdict — it only says what the API answered.
 *
 * Pure — no React — so the chip text and the screen-reader sentence are tests.
 */
import type { ReadinessChip, ReadinessDestination, ReadinessNextStep, ReadinessRowBase, ReadinessStateCounts } from '@nexus/shared/listing-readiness'
import { readinessMeta, SCOPE_READINESS_STATES } from '@/design-system/grid/renderers/readiness'

export const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en')} ${n === 1 ? one : many}`

export const listingTotal = (counts: ReadinessStateCounts): number =>
  counts.blocked + counts.warn + counts.notComputed + counts.absent + counts.ready

const CHANNEL_WORDS: Record<string, string> = { SHARED: 'Shared', AMAZON: 'Amazon', EBAY: 'eBay', SHOPIFY: 'Shopify', ETSY: 'Etsy' }
export function channelLabel(channel: string | null | undefined): string {
  if (!channel) return 'Shared'
  return CHANNEL_WORDS[channel.toUpperCase()] ?? channel.charAt(0).toUpperCase() + channel.slice(1).toLowerCase()
}

/**
 * A destination the page has no record of (a family's own page reads members only, and members carry keys, not
 * labels). The key is the index coordinate `[channel, market, accountId, aliasId]`, so the chip can still say
 * "Amazon DE"; only the store or alias suffix is unknown.
 */
export function destinationFromKey(key: string): ReadinessDestination {
  let parts: unknown = null
  try { parts = JSON.parse(key) } catch { /* not a coordinate key: say it as it is */ }
  if (!Array.isArray(parts)) return { key, channel: '', marketplace: '', accountId: null, aliasKey: '', label: key }
  const [channel, market, accountId, aliasId] = parts as Array<string | null | undefined>
  const ch = channel && channel !== 'SHARED' ? channel : 'SHARED'
  const mk = typeof market === 'string' ? market : ''
  const label = ch === 'SHARED' ? 'Shared' : `${channelLabel(ch)}${mk && mk !== 'GLOBAL' ? ` ${mk}` : ''}`
  return { key, channel: ch, marketplace: mk, accountId: accountId ?? null, aliasKey: aliasId ?? '', label }
}

/** Look a destination up by key; fall back to the key's own words. */
export function destinationLookup(destinations: readonly ReadinessDestination[]): (key: string) => ReadinessDestination {
  const byKey = new Map(destinations.map((d) => [d.key, d]))
  return (key) => byKey.get(key) ?? destinationFromKey(key)
}

/** The chips in the destinations' order; a chip whose destination the page does not know goes last, in API order. */
export function orderedChips(chips: readonly ReadinessChip[], destinations: readonly ReadinessDestination[]): ReadinessChip[] {
  const rank = new Map(destinations.map((d, i) => [d.key, i]))
  return chips
    .map((chip, i) => ({ chip, i, r: rank.get(chip.destinationKey) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.chip)
}

/** The chip's words: "Amazon DE", with its problem count when it is not ready ("Amazon DE · 3"). */
export function chipText(chip: ReadinessChip, label: string): string {
  return chip.state !== 'ready' && chip.issueCount > 0 ? `${label} · ${chip.issueCount.toLocaleString('en')}` : label
}

/**
 * Where a destination sits on the screen: its store's line and the word its own chip or button says. A store's markets
 * share a line under one short name ("Amazon", "eBay · motovento") and each says only its market ("DE"); a destination
 * without a market (Shared, Shopify, Etsy…) keeps its full words, and those share the first line, with no name in
 * front (`store: null`).
 */
export function placeOf(d: ReadinessDestination): { store: { key: string; label: string } | null; word: string } {
  const market = d.marketplace && d.marketplace !== 'GLOBAL' && d.channel !== 'SHARED' ? d.marketplace : ''
  if (!market) return { store: null, word: d.label }
  // "eBay DE · motovento" → "eBay · motovento": the store's words without the market its chip now carries.
  const prefix = `${channelLabel(d.channel)} ${market}`
  const label = d.label.startsWith(prefix) ? `${channelLabel(d.channel)}${d.label.slice(prefix.length)}` : channelLabel(d.channel)
  return { store: { key: JSON.stringify([d.channel, d.accountId, d.aliasKey]), label }, word: market }
}

/** One line of a market list: a store's short name (null on the first, market-less line) and its items. */
export interface PlaceLine<T> { key: string; label: string | null; items: T[] }

/** Items in lines, in their own order; the market-less line comes first. */
function linesOf<T>(items: readonly T[], destinationOf: (item: T) => ReadinessDestination): PlaceLine<T>[] {
  const single: T[] = []
  const stores = new Map<string, PlaceLine<T>>()
  for (const item of items) {
    const { store } = placeOf(destinationOf(item))
    if (!store) { single.push(item); continue }
    const line = stores.get(store.key) ?? { key: store.key, label: store.label, items: [] }
    line.items.push(item)
    stores.set(store.key, line)
  }
  return [...(single.length ? [{ key: 'single', label: null, items: single }] : []), ...stores.values()]
}

/** One chip as the cell draws it: its words, and the full destination label its sentence names. */
export interface PlacedChip { chip: ReadinessChip; label: string; text: string }

/** The Markets cell's lines. A chip that is not ready adds its problem count to its word ("DE · 72"). */
export function chipLines(chips: readonly ReadinessChip[], destinationOf: (key: string) => ReadinessDestination): Array<PlaceLine<PlacedChip>> {
  const placed = chips.map((chip) => {
    const d = destinationOf(chip.destinationKey)
    return { chip, label: d.label, text: chipText(chip, placeOf(d).word) }
  })
  return linesOf(placed, (c) => destinationOf(c.chip.destinationKey))
}

/** The Fix window's market switcher, in the same lines as the grid's chips. */
export function destinationLines(destinations: readonly ReadinessDestination[]): Array<PlaceLine<{ destination: ReadinessDestination; text: string }>> {
  return linesOf(destinations.map((destination) => ({ destination, text: placeOf(destination).word })), (x) => x.destination)
}

/** The chip's full sentence for a screen reader and the pointer: "Amazon DE: Blocked, 3 problems, 20 listings". */
export function chipAriaLabel(chip: ReadinessChip, label: string): string {
  const meta = readinessMeta(chip.state, 'scope')
  const listings = listingTotal(chip.counts)
  const parts = [meta.label]
  if (chip.issueCount > 0) parts.push(plural(chip.issueCount, 'problem'))
  parts.push(plural(listings, 'listing'))
  const sentence = `${label}: ${parts.join(', ')}`
  return chip.pending ? `${sentence}. Checking again now; this is the last result.` : sentence
}

const RANK = new Map(SCOPE_READINESS_STATES.map((s, i) => [s, i]))

/** The chip that needs attention first, in the design system's severity order (Blocked → Warnings → Not computed → Not set up → Ready). */
export function worstChip(chips: readonly ReadinessChip[]): ReadinessChip | null {
  let worst: ReadinessChip | null = null
  for (const chip of chips) {
    if (!worst || (RANK.get(chip.state) ?? 99) < (RANK.get(worst.state) ?? 99)) worst = chip
  }
  return worst
}

/** Where Fix opens: the next step's destination, else the chip that needs attention first. */
export function fixDestination(row: Pick<ReadinessRowBase, 'nextStep' | 'chips'>): string | null {
  return row.nextStep?.destinationKey ?? worstChip(row.chips)?.destinationKey ?? null
}

/** Why Fix is held on this row, or null when it opens. */
export function fixHeldReason(row: Pick<ReadinessRowBase, 'nextStep' | 'chips' | 'state'>): string | null {
  if (row.chips.length === 0) return 'Nothing to check: this product has no listing here.'
  if (!row.nextStep && row.state === 'ready') return 'Ready on every market. Nothing to fix.'
  return null
}

/** The Next step's last line: "Amazon DE · 20 listings". */
export function nextStepPlace(step: Pick<ReadinessNextStep, 'affected'>, label: string): string {
  return `${label} · ${plural(step.affected, 'listing')}`
}
