/**
 * PES.3 — the visible cascade.
 *
 * Layout §1: "Override cascade visible per cell: alias×variant `✎` → alias `✎` → master `🔗`. Hover
 * names the source; one click pins, one click resets."
 *
 * ── Division of labour (hub ruling #11) ─────────────────────────────────────────────────────────
 * How provenance LOOKS is PES.2's: `classifyProvenance` / `ProvenanceMark` / `provenanceClassRules`
 * from `design-system/grid` are the one definition, and this lane renders through them — no glyph,
 * tint or class is decided here.
 *
 * What a click DOES is this lane's, and is not the DS's business: pinning and resetting have to know
 * WHICH cascade layer a value came from, because that decides where the write lands (the alias, or
 * this alias × this variant). That is write ROUTING over PES.5 §3.2's `layer` field — server data,
 * not a second provenance vocabulary.
 *
 * The alias level is fully expressible in the substrate as of hub ruling #16: `classifyProvenance`
 * returns `inheritedOverride` for a value inherited from a layer that is itself an override of the
 * master, with its own glyph, its own `.nds-cell-is-inherited-override` tint, and a tooltip that
 * states where a reset actually lands. PES.3's tooltip-only interim is gone; nothing in this lane
 * describes provenance any more.
 *
 * ── Who decides the layer ───────────────────────────────────────────────────────────────────────
 * PES.5 §3.2 sends `StudioCellValue.layer` — the server's own fold, and the authority. This module
 * narrows those seven layers to the three the cascade routes on, and does NOT re-derive provenance
 * from `source` when `layer` is present. `foldSource()` survives only as the fallback for a payload
 * without `layer`, and as the parity check in the tests.
 *
 * ── The trap the fallback exists for ────────────────────────────────────────────────────────────
 * `channelExplicit` does not mean "alias × variant". It means "the ChannelListing we resolved
 * through pinned this" — and WHICH listing that is depends on the row:
 *
 *   on a `variant` row  the resolved listing is the CHILD's  → alias × variant  ✎
 *   on a `parent` row   the resolved listing is the ALIAS's  → alias           ✎
 *
 * Fold without the row kind and every pinned value on an alias band reads as "pinned for this one
 * variant", the opposite of what it is: a value every variant under that alias inherits.
 */

import type { CascadeLayer, ChannelValueSource, StudioCellValue, StudioLayer, StudioRowKind } from './types'

/** Layers that mean "an alias-level ChannelListing supplied this". */
const ALIAS_SOURCE: ReadonlySet<ChannelValueSource> = new Set<ChannelValueSource>([
  'aliasOverride',
  'aliasExplicit',
])

/** Layers that mean "the ChannelListing we resolved through supplied this". */
const RESOLVED_LISTING_SOURCE: ReadonlySet<ChannelValueSource> = new Set<ChannelValueSource>([
  'channelOverride',
  'channelExplicit',
])

/** True when a value is actually present — an emptied cell is `unset`, never an inherited badge. */
export function hasValue(v: unknown): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === 'string' && v.trim() === '') return false
  if (Array.isArray(v) && v.length === 0) return false
  return true
}

/**
 * Narrow the server's seven-layer fold to the three the sheet paints.
 *
 * `channel` is the alias-or-variant listing layer that the server could not attribute more finely,
 * so the row kind decides it — the same rule as the fallback below. `linked` paints as `master`:
 * a link group is an inheritance, not a pin, and layout §1 renders derived values with `🔗`.
 */
export function narrowLayer(layer: StudioLayer, kind: StudioRowKind, present: boolean): CascadeLayer {
  if (!present) return 'unset'
  switch (layer) {
    case 'aliasVariant':
      return 'aliasVariant'
    case 'alias':
      return 'alias'
    case 'channel':
      return kind === 'parent' ? 'alias' : 'aliasVariant'
    case 'master':
    case 'variant':
    case 'linked':
      return 'master'
    case 'default':
    default:
      return 'unset'
  }
}

/** Fallback for a payload with no `layer`. Kept so a contract drift degrades honestly, not wrongly. */
export function foldSource(source: ChannelValueSource, kind: StudioRowKind, present: boolean): CascadeLayer {
  if (!present) return 'unset'
  if (source === 'default') return 'unset'
  if (ALIAS_SOURCE.has(source)) return 'alias'
  if (RESOLVED_LISTING_SOURCE.has(source)) return kind === 'parent' ? 'alias' : 'aliasVariant'
  return 'master'
}

/** The one entry point a renderer uses: server layer first, fold only if it is missing. */
export function cascadeOf(cell: StudioCellValue | undefined, kind: StudioRowKind): CascadeLayer {
  if (!cell) return 'unset'
  const present = hasValue(cell.value) || cell.pinned === true
  // The server uses `alias` for this row's own named-listing override too.
  if (kind === 'variant' && cell.layer === 'alias' && cell.pinned && !cell.inherited) return 'aliasVariant'
  return cell.layer ? narrowLayer(cell.layer, kind, present) : foldSource(cell.source, kind, present)
}

export interface CascadeContext {
  aliasLabel: string
  aliasPosition: number
  sku: string
  kind: StudioRowKind
}

export interface CascadeMeta {
  layer: CascadeLayer
  action: 'pin' | 'reset' | null
  /** Names the layer for `ProvenanceMark`'s `from` / `provenanceTooltip`'s second argument. */
  fromLabel: (ctx: CascadeContext) => string
  /**
   * ONE clause about what a click does, appended to the DS's provenance sentence.
   *
   * This is the only text this lane still writes, and it is write ROUTING, not provenance: layout
   * §1's "one click pins, one click resets" is an affordance the substrate deliberately does not
   * own (its mark is `aria-hidden` and carries no action). Where the value CAME from is
   * `provenanceTooltip`'s sentence and is never restated here.
   */
  actionHint: (ctx: CascadeContext) => string
}

/**
 * ①②③… — the alias marks layout §1 uses. `position: 0` is the PRIMARY listing, which PES.5 sends as
 * one more uniform group; it gets its own mark rather than a number that would read as "alias zero".
 */
export function aliasMark(position: number): string {
  if (position === 0) return '★'
  const MARKS = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'
  return position >= 1 && position <= MARKS.length ? MARKS[position - 1] : `(${position})`
}

const META: Record<CascadeLayer, CascadeMeta> = {
  aliasVariant: {
    layer: 'aliasVariant',
    action: 'reset',
    fromLabel: (c) => `${aliasMark(c.aliasPosition)} ${c.aliasLabel} · ${c.sku}`,
    actionHint: () => 'Click to reset it to this variant’s Master value.',
  },
  alias: {
    layer: 'alias',
    action: 'reset',
    fromLabel: (c) => `${aliasMark(c.aliasPosition)} ${c.aliasLabel}`,
    actionHint: (c) =>
      c.kind === 'parent'
        ? 'Click to reset this listing row to Master.'
        : `Click to pin it for ${c.sku} alone.`,
  },
  master: {
    layer: 'master',
    action: 'pin',
    fromLabel: () => 'the master record',
    actionHint: (c) =>
      c.kind === 'parent'
        ? `Click to pin it for ${aliasMark(c.aliasPosition)} ${c.aliasLabel}.`
        : `Click to pin it for ${c.sku} on ${aliasMark(c.aliasPosition)} ${c.aliasLabel}.`,
  },
  unset: {
    layer: 'unset',
    action: null,
    fromLabel: () => '',
    actionHint: () => 'Not set anywhere — type a value to set it.',
  },
}

export function describeCascade(layer: CascadeLayer): CascadeMeta {
  return META[layer]
}

/**
 * What a click does, given where the value currently comes from.
 *
 * Layout §1: "one click pins, one click resets". Pinning freezes the CURRENT resolved value at this
 * row's own layer, so pinning never changes what the channel shows — it only stops the value
 * tracking. Resetting clears this row's layer and lets it fall back up the cascade.
 */
export interface CascadeIntent {
  action: 'pin' | 'reset'
  target: 'aliasVariant' | 'alias'
  value: unknown
}

export function cascadeIntent(
  layer: CascadeLayer,
  kind: StudioRowKind,
  current: unknown,
): CascadeIntent | null {
  const target = kind === 'parent' ? ('alias' as const) : ('aliasVariant' as const)
  switch (layer) {
    case 'aliasVariant':
      return { action: 'reset', target, value: null }
    case 'alias':
      // On the band the alias value IS this row's own → release it. On a variant it is inherited
      // from above → pin it down to this variant.
      return kind === 'parent'
        ? { action: 'reset', target, value: null }
        : { action: 'pin', target, value: current }
    case 'master':
      return { action: 'pin', target, value: current }
    case 'unset':
    default:
      return null
  }
}

/** A slot is a projection of one stored list; resuming inheritance always targets that whole list. */
export function wholeListWriteField(writeField: string): string | null {
  return /^(.+)\[[1-9]\d*\]$/.exec(writeField)?.[1] ?? null
}
