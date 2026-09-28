/**
 * Sheet pop-up P3, slice A2 (docs/sheet-popup-editor/QUALITY-PLAN-2026-09-28.md §4.4) — the variation-theme pop-up on a
 * CHANNEL scope: which axes it may add, what each row says about where it comes from and what it holds, and the refusals a
 * typed name meets before anything is saved. Pure: the panel and its suite read exactly these.
 *
 * The rules (the Owner, 2026-09-28): on eBay and Etsy an axis can come from Shared, from the channel's own list (eBay: the
 * category's variation-enabled aspects) or carry a name the operator types, with its values taken from a Shared per-variant
 * attribute; on Amazon the theme decides (that panel keeps its theme list). Every sentence the server already states — the
 * refused names, the lock, the collisions — is relayed verbatim, never re-composed here.
 */

import type { VariationThemeAxis, VariationThemeCell } from '../renderers/variationTheme'

/** A Shared per-variant attribute a channel-only axis may take its values from (`GET …/studio/own-axis-sources`). */
export interface OwnAxisSourceOption {
  field: string
  label: string
  filled: number
  of: number
  values: string[]
}

/**
 * P3 A3 — may this cell make a NEW per-variant attribute from the pop-up? The server answers it with the sources: the
 * attribute goes into the product's family (shared by `familyProducts` products), and only a user who may manage attributes
 * can make one. `reason` is the server's sentence when it may not.
 */
export interface NewAttributeState {
  allowed: boolean
  reason: string | null
  familyLabel: string | null
  familyProducts: number | null
}

export interface OwnAxisSourcesRead {
  sources: OwnAxisSourceOption[]
  /** null = a server that does not offer it; the pop-up then shows nothing (never a dead control). */
  newAttribute: NewAttributeState | null
}

/** The host reads the sources; the design system never fetches. */
export type OwnAxisSourcesLoader = (productId: string, market: string) => Promise<OwnAxisSourcesRead>

/**
 * P3 A3 — what "Create" answered. `created` / `placed` (an existing attribute put into this family) / `present` (already
 * in it) carry the new "Values from" entry; `offer` = an attribute of that name exists and may be used here; `refused` = the
 * server's sentence. It WRITES at once (the attribute is not part of the pop-up's draft), which the pop-up says before.
 */
export type OwnAxisAttributeResult =
  | { outcome: 'created' | 'placed' | 'present'; source: OwnAxisSourceOption }
  | { outcome: 'offer'; message: string; label: string }
  | { outcome: 'refused'; message: string }

export type OwnAxisAttributeCreator = (productId: string, market: string, name: string, useExisting: boolean) => Promise<OwnAxisAttributeResult>

export type OwnAxisSourcesState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; sources: OwnAxisSourceOption[]; newAttribute: NewAttributeState | null }
  | { state: 'error'; message: string }

export const CHANNEL_AXES_COPY = {
  fromShared: (label: string) => `from Shared: ${label}`,
  onlyOn: (channel: string) => `only on ${channel}`,
  yourName: 'your name',
  notInFilters: (channel: string) => `not in ${channel}’s search filters`,
  valuesFrom: (label: string) => `values from ${label}`,
  empty: (n: number) => `${n} ${n === 1 ? 'variant' : 'variants'} empty`,
  fillColumn: (name: string) => `Fill the ${name} column on the variant rows.`,
  fillShared: (label: string) => `Fill ${label} on the Shared product.`,
  filled: (filled: number | null, of: number | null) => (filled === null || of === null ? 'values not read' : `${filled} of ${of} filled`),
  /** A Shared axis this channel does not deliver yet. */
  notHere: (noun: string) => `not ${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun} here`,
  /** An add choice's screen-reader name: its visible spans run together ("Taglia0 of 8 filled", measured 2026-09-28). */
  addOption: (name: string, meta: string) => `Add ${name}, ${meta}`,
  groupShared: 'From Shared',
  groupOnly: (channel: string) => `Only on ${channel}`,
  groupOwn: 'Your own name',
  namePlaceholder: 'Name',
  valuesPlaceholder: 'Values from…',
  add: 'Add',
  addHint: 'Space on Add, or “,” in the name, adds it · ⏎ saves the pop-up',
  sourceMissing: 'Choose where the values come from.',
  /** The save's own sentence (`family-projection.service.ts`), so the pop-up and the server refuse in the same words. */
  duplicate: 'Each channel name can carry only one axis.',
  nameMissing: (noun: string) => `Name this ${noun}.`,
  nameTooLong: (channel: string, noun: string, max: number) => `${channel} ${noun} names are at most ${max} characters.`,
  noSources: 'This family has no per-variant attribute yet. Add one on the Shared product first.',
  sourcesLoading: 'Loading the attributes…',
  sourcesFailed: (message: string) => `The attributes could not be loaded (${message}).`,
  /** The "+ Add" hint on a live listing; the server's full sentence is in the lock banner and on the button's title. */
  setLockedShort: 'axes fixed while live',
  resetToShared: 'Reset to Shared',
  resetPending: 'Press ⏎ to follow Shared again. This channel’s own axes and names are removed.',
  remove: (name: string) => `Remove ${name}`,
  nothingToAdd: (noun: string) => `Nothing left to add as a ${noun}.`,
  /* P3 A3 — "New attribute" (QUALITY-PLAN §4.10). */
  noFit: 'No attribute fits?',
  noSourcesYet: 'This family has no per-variant attribute yet. Type a name and make one below.',
  newAttribute: (name: string) => `New attribute “${name}”`,
  newAttributeUnnamed: 'New attribute',
  /** Said BEFORE the write: where it goes, who else gets the column, and that Esc does not take it back. */
  createLine: (name: string, family: string, products: number) =>
    `Creates “${name}” (per variant, text) in the family “${family}” — ${products} ${products === 1 ? 'product gets' : 'products get'} this empty column. It is created now: Esc does not remove it.`,
  create: 'Create',
  creating: 'Creating…',
  created: 'Created. It is chosen in “Values from”; press Add, then ⏎ saves.',
  placed: 'Added to this family. It is chosen in “Values from”; press Add, then ⏎ saves.',
  present: 'It is already in “Values from” and is chosen there.',
  useExisting: 'Use it',
  /** The server's own sentence for a user without the permission (also what a 403 maps to). */
  noPermission: 'Only a user who may manage attributes can create one. Ask the business owner.',
  createFailed: (message: string) => `The attribute could not be created (${message}).`,
} as const

/**
 * The key of a channel-only axis — the same format as `@nexus/shared/variation-mapping` `ownAxisKey`, spelled here because
 * this design system is also compiled in `apps/factory`, which does not depend on `@nexus/shared`.
 */
export function ownAxisKeyFor(from: 'channel' | 'shared', field: string): string {
  return `own:${from}:${field}`
}

/**
 * Does this cell open the channel layout (A2)? A channel coordinate that is not Amazon (whose theme decides): eBay, Etsy
 * and — since A4 (QUALITY-PLAN §4.11) — Shopify, whose option names are free text. Master and the Variants dock keep their
 * own layouts.
 */
export function usesChannelAxesLayout(cell: VariationThemeCell): boolean {
  const channel = cell.write?.coordinate.channel ?? null
  if (!channel || cell.masterCandidates) return false
  if (cell.candidates?.kind === 'theme-enum') return false
  const upper = channel.toUpperCase()
  return upper === 'EBAY' || upper === 'ETSY' || upper === 'SHOPIFY'
}

/**
 * A4 — why a row's typed channel name (Shopify's free option name) cannot be saved, or null: empty, too long, or the same
 * as another delivered row's name. Said under the row while typing; the save refuses in its own words behind it.
 */
export function freeNameRefusal(cell: VariationThemeCell, axis: VariationThemeAxis, channelWord: string): string | null {
  const name = (axis.target ?? '').trim()
  const noun = cell.vocabulary.axisNoun
  if (!name) return CHANNEL_AXES_COPY.nameMissing(noun)
  const max = cell.ownNames?.maxLength ?? null
  if (max !== null && name.length > max) return CHANNEL_AXES_COPY.nameTooLong(channelWord, noun, max)
  const same = cell.axes.some((a) => a.included && a.axisKey !== axis.axisKey && (a.target ?? a.channelName).trim().toLocaleLowerCase() === name.toLocaleLowerCase())
  return same ? CHANNEL_AXES_COPY.duplicate : null
}

/** Where a row's axis comes from, in one short line. */
export function channelAxisOrigin(axis: VariationThemeAxis, channelWord: string, sources?: readonly OwnAxisSourceOption[]): string {
  if (!axis.own) return CHANNEL_AXES_COPY.fromShared(axis.label)
  if (axis.own.from === 'channel') return CHANNEL_AXES_COPY.onlyOn(channelWord)
  const source = sources?.find((s) => s.field === axis.own!.field)
  const parts: string[] = [CHANNEL_AXES_COPY.yourName]
  if (axis.own.custom && channelWord === 'eBay') parts.push(CHANNEL_AXES_COPY.notInFilters(channelWord))
  parts.push(CHANNEL_AXES_COPY.valuesFrom(source?.label ?? axis.own.field))
  return parts.join(' · ')
}

/** The values a row shows, and how many included variants lack one — the server's summary, else what the pop-up knows. */
export function channelAxisValues(
  cell: VariationThemeCell,
  axis: VariationThemeAxis,
  sources?: readonly OwnAxisSourceOption[],
): { values: string[]; empty: number } | null {
  const summary = cell.valueSummary?.[axis.familyKey]
  if (summary) return { values: summary.values, empty: Math.max(0, summary.of - summary.filled) }
  /* Added in this pop-up and not saved yet: a Shared attribute's own counts, or an eBay aspect's candidate counts. */
  if (axis.own?.from === 'shared') {
    const source = sources?.find((s) => s.field === axis.own!.field)
    return source ? { values: source.values, empty: Math.max(0, source.of - source.filled) } : null
  }
  const candidate = cell.ownCandidates?.find((c) => c.axisKey === axis.familyKey)
  if (candidate && candidate.filled !== null && candidate.of !== null) return { values: [], empty: Math.max(0, candidate.of - candidate.filled) }
  return null
}

/** What to do about the empty variants: fill the channel column, or the Shared attribute. */
export function channelAxisGapHint(axis: VariationThemeAxis, sources?: readonly OwnAxisSourceOption[]): string {
  if (axis.own?.from === 'shared') return CHANNEL_AXES_COPY.fillShared(sources?.find((s) => s.field === axis.own!.field)?.label ?? axis.own.field)
  return CHANNEL_AXES_COPY.fillColumn(axis.channelName)
}

/** The channel-list axes still addable here: candidates no row of the draft already holds. */
export function remainingOwnCandidates(cell: VariationThemeCell): NonNullable<VariationThemeCell['ownCandidates']> {
  const held = new Set(cell.axes.filter((a) => a.included).map((a) => a.familyKey))
  const names = new Set(cell.axes.filter((a) => a.included).map((a) => (a.target ?? a.channelName).toLocaleLowerCase()))
  return (cell.ownCandidates ?? []).filter((c) => !held.has(c.axisKey) && !names.has(c.name.toLocaleLowerCase()))
}

/** The Shared axes this channel does not deliver yet (dropped here, or never delivered). */
export function remainingSharedAxes(cell: VariationThemeCell): VariationThemeAxis[] {
  return cell.axes.filter((a) => !a.own && !a.included)
}

/**
 * Why a typed name may NOT be added, or null. In the order an operator meets them: the name itself, the channel's cap, a
 * name the channel refuses (the server's sentence), a name another axis already uses, and the source of the values.
 */
export function ownNameRefusal(cell: VariationThemeCell, name: string, hasSource: boolean, channelWord: string): string | null {
  const clean = name.trim()
  const noun = cell.vocabulary.axisNoun
  if (!clean) return CHANNEL_AXES_COPY.nameMissing(noun)
  const max = cell.ownNames?.maxLength ?? null
  if (max !== null && clean.length > max) return CHANNEL_AXES_COPY.nameTooLong(channelWord, noun, max)
  const refused = cell.ownNames?.refused?.find((r) => r.name.toLocaleLowerCase() === clean.toLocaleLowerCase())
  if (refused) return refused.reason
  if (cell.axes.some((a) => a.included && (a.target ?? a.channelName).toLocaleLowerCase() === clean.toLocaleLowerCase())) return CHANNEL_AXES_COPY.duplicate
  if (!hasSource) return CHANNEL_AXES_COPY.sourceMissing
  return null
}

/** Is a name the channel's own listed aspect (so it is in its search filters)? */
const listedOnChannel = (cell: VariationThemeCell, name: string) =>
  (cell.candidates?.items ?? []).some((i) => i.code.toLocaleLowerCase() === name.trim().toLocaleLowerCase())

/** The draft with an axis from the channel's own list added last. */
export function withOwnChannelAxis(cell: VariationThemeCell, candidate: NonNullable<VariationThemeCell['ownCandidates']>[number]): VariationThemeCell {
  const field = candidate.axisKey.replace(/^own:channel:/, '')
  const axis: VariationThemeAxis = {
    axisKey: candidate.axisKey, familyKey: candidate.axisKey, label: candidate.label, channelName: candidate.name, target: candidate.name,
    included: true, own: { from: 'channel', field, custom: false },
  }
  return { ...cell, axes: [...cell.axes.filter((a) => a.familyKey !== candidate.axisKey), axis] }
}

/** The draft with an axis under a typed name added last, its values from a Shared per-variant attribute. */
export function withOwnSharedAxis(cell: VariationThemeCell, name: string, source: OwnAxisSourceOption): VariationThemeCell {
  const clean = name.trim()
  const key = ownAxisKeyFor('shared', source.field)
  const axis: VariationThemeAxis = {
    axisKey: key, familyKey: key, label: clean, channelName: clean, target: clean, included: true,
    own: { from: 'shared', field: source.field, custom: !listedOnChannel(cell, clean) },
  }
  return { ...cell, axes: [...cell.axes.filter((a) => a.familyKey !== key), axis] }
}

/** The draft with a Shared axis delivered here again, last. */
export function withSharedAxis(cell: VariationThemeCell, axisKey: string): VariationThemeCell {
  const axis = cell.axes.find((a) => a.axisKey === axisKey && !a.own)
  if (!axis) return cell
  return { ...cell, axes: [...cell.axes.filter((a) => a.axisKey !== axisKey), { ...axis, included: true }] }
}

/** The draft without an axis: a channel-only one is removed, a Shared one is no longer delivered here (it stays addable). */
export function withoutAxis(cell: VariationThemeCell, axisKey: string): VariationThemeCell {
  const axis = cell.axes.find((a) => a.axisKey === axisKey)
  if (!axis) return cell
  if (axis.own) return { ...cell, axes: cell.axes.filter((a) => a.axisKey !== axisKey) }
  return { ...cell, axes: cell.axes.map((a) => (a.axisKey === axisKey ? { ...a, included: false } : a)) }
}

/**
 * P3 A3 — why "New attribute" may not run for this typed name, or null. The server's reason first (no family, no
 * permission), then the checks every typed name meets (A2), with a source counted as present: the attribute IS the source.
 */
export function newAttributeHeld(cell: VariationThemeCell, state: NewAttributeState, name: string, channelWord: string): string | null {
  if (!state.allowed) return state.reason ?? CHANNEL_AXES_COPY.noPermission
  return ownNameRefusal(cell, name, true, channelWord)
}

/** The "Values from" list with a created or placed attribute in it, once. */
export function withOwnAxisSource(sources: readonly OwnAxisSourceOption[], source: OwnAxisSourceOption): OwnAxisSourceOption[] {
  return [...sources.filter((s) => s.field !== source.field), source]
}

/** What the pop-up says after "Create" answered with a source. */
export function newAttributeDoneLine(outcome: 'created' | 'placed' | 'present'): string {
  return outcome === 'created' ? CHANNEL_AXES_COPY.created : outcome === 'placed' ? CHANNEL_AXES_COPY.placed : CHANNEL_AXES_COPY.present
}

/**
 * Why the SET of axes cannot change here, or null: a live listing (its set change is a relist or a new parent — the
 * server's own sentence). A reorder may still be allowed; `axesOrderState` answers that separately.
 */
export function channelSetChangeHeld(cell: VariationThemeCell): string | null {
  return cell.locked ? cell.locked.reason : null
}
