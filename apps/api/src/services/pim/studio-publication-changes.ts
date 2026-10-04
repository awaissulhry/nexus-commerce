import { PUBLICATION_PHOTO_FIELDS, type StudioPublishChange, type StudioPublishReplaces, type StudioPublishReplacesKind,
  type StudioPublishValue } from '@nexus/shared/studio-publication'

export interface PublicationChangeInput {
  productId: string
  sku: string
  field: string
  label: string
  current: StudioPublishValue
  lastAccepted: StudioPublishValue
  channel: StudioPublishValue
  newListing?: boolean
  refusal?: string
  /** Provider-specific equality from the existing drift comparators; raw sent values remain intact. */
  currentMatchesChannel?: boolean
  acceptedMatchesChannel?: boolean
  /**
   * The channel shows its OWN copy of this value, never what Nexus sent (Amazon and eBay re-host photos at their own
   * addresses), so the channel side cannot be compared: the line is judged on Nexus's side alone — unchanged since the
   * last accepted publish → SAME, changed → SEND (ticked). With no accepted record it cannot be compared: selectable,
   * never ticked by default, and this sentence is its reason. Never a DIFFERS line, so never a `replaces`.
   */
  channelCopy?: string
}

export const publicationChangeId = (productId: string, field: string): string => JSON.stringify([productId, field])

// Exact accepted-payload equality, not the provider's normalized content-drift comparison.
const canonical = (value: unknown) => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry)
const equal = (left: StudioPublishValue, right: StudioPublishValue): boolean | null => {
  if (left.state === 'unknown' || right.state === 'unknown') return null
  if (left.state !== right.state) return false
  return left.state === 'absent' || right.state === 'absent' || canonical(left.value) === canonical(right.value)
}
const changed = (value: StudioPublishValue, baseline: StudioPublishValue): boolean | null => {
  const same = equal(value, baseline)
  return same === null ? null : !same
}
const providerEqual = (left: StudioPublishValue, right: StudioPublishValue, verdict?: boolean) =>
  left.state === 'value' && right.state === 'value' && verdict !== undefined ? verdict : equal(left, right)

export interface PublicationChangeOptions {
  /** The channel's own name in the DIFFERS warnings ("Amazon", "eBay"). */
  channel?: string
}

// ── One-click "Nexus wins" words (Owner 2026-10-04) ──────────────────────────────────────────────────────────────────
const WORDS_MAX = 60
/** Selector keys that say where a value lives, not what it is (left out of the words). */
const SELECTOR_KEYS = new Set(['marketplace_id', 'language_tag', 'currency', 'audience'])
const MONEY_KEYS = /price|amount|value_with_tax/i
const cut = (text: string) => (text.length > WORDS_MAX ? `${text.slice(0, WORDS_MAX - 1).trimEnd()}…` : text)
const isPhotoField = (field: string) => PUBLICATION_PHOTO_FIELDS.has(field) || /image|picture|photo/i.test(field)

/**
 * A reviewed value in a few words for a warning: text without markup, a list joined with commas, a price with two
 * decimals, photos counted ("6 photos"); cut to 60 characters. Null when there is no value (absent or unknown).
 */
export function publicationValueWords(value: StudioPublishValue, field = ''): string | null {
  if (value.state !== 'value') return null
  const parts: string[] = []
  // A money key (the field's own name or any key above the leaf) gives its numbers two decimals.
  const walk = (entry: unknown, money: boolean): void => {
    if (entry == null || entry === '') return
    if (Array.isArray(entry)) { for (const item of entry) walk(item, money); return }
    if (typeof entry === 'object') {
      for (const [k, v] of Object.entries(entry as Record<string, unknown>)) if (!SELECTOR_KEYS.has(k) && !k.startsWith('@_')) walk(v, money || MONEY_KEYS.test(k))
      return
    }
    if (typeof entry === 'number') { parts.push(money ? entry.toFixed(2) : String(entry)); return }
    if (typeof entry === 'boolean') { parts.push(entry ? 'Yes' : 'No'); return }
    const text = String(entry).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim()
    if (text) parts.push(money && /^-?\d+(\.\d+)?$/.test(text) ? Number(text).toFixed(2) : text)
  }
  walk(value.value, MONEY_KEYS.test(field))
  if (isPhotoField(field)) {
    const photos = parts.filter(part => /^https?:\/\/\S+$/i.test(part)).length
    if (photos) return `${photos} ${photos === 1 ? 'photo' : 'photos'}`
  }
  return parts.length ? cut(parts.join(', ')) : 'empty'
}

const replacesKind = (change: Pick<StudioPublishChange, 'current' | 'channel' | 'lastAccepted' | 'localChanged'>): StudioPublishReplacesKind =>
  change.current.state === 'absent' && change.channel.state === 'value' ? 'removes'
    : change.lastAccepted.state === 'unknown' ? 'never_published'
      : change.localChanged === true ? 'both_changed' : 'channel_changed'

/**
 * What a ticked DIFFERS line replaces on the channel, in words: "Changed on Amazon since the last publish. Amazon has
 * 129.00 — Publish sets 149.00." `words` replaces the raw values' words (an Amazon offer line's `display`); `note` is an
 * extra warning (a price line's Automate Pricing).
 */
export function publicationReplaces(change: Pick<StudioPublishChange, 'field' | 'current' | 'channel' | 'lastAccepted' | 'localChanged'>, channelLabel: string,
  words?: { channel: string | null; nexus: string | null }, note: string | null = null): StudioPublishReplaces {
  const kind = replacesKind(change)
  const channel = words ? (words.channel === null ? null : cut(words.channel)) : publicationValueWords(change.channel, change.field)
  const nexus = words ? (words.nexus === null ? null : cut(words.nexus)) : publicationValueWords(change.current, change.field)
  const label = channelLabel === 'the channel' ? 'The channel' : channelLabel
  const lead = kind === 'channel_changed' ? `Changed on ${channelLabel} since the last publish. `
    : kind === 'both_changed' ? `Changed in Nexus and on ${channelLabel}. `
      : kind === 'never_published' ? 'Not published from Nexus before. ' : ''
  // Two values whose words read the same (a long text cut at 60 characters, photos in another order) still differ.
  const sets = kind === 'removes' ? 'Publish removes it.' : nexus !== null && nexus === channel ? 'Publish sets Nexus\'s version.' : `Publish sets ${nexus ?? 'no value'}.`
  return { kind, channel, nexus, sentence: `${lead}${label} has ${channel ?? 'no value'} — ${sets}`, note }
}

/**
 * A pure review plan.
 *
 * One-click "Nexus wins" (Owner 2026-10-04) — this REVERSES the earlier rule ("defaults never authorize overwriting a
 * divergent channel value"), on purpose: every SELECTABLE DIFFERS line (changed on the channel, changed on both sides,
 * never published from Nexus) starts ticked like a SEND line, and carries `replaces` — what Publish replaces there, in
 * words — so the window can warn per line and per market. Never ticked: SAME, CANNOT_COMPARE (an unknown channel value
 * is never overwritten by default), every refused line (its reason kept), and a photo line whose channel shows only its own
 * re-hosted copy (`channelCopy`: judged on Nexus's side alone, so it never resends unchanged photos). Held / blocked rows are unticked after this
 * (`blockRowChanges`); a photos-only review ticks photo fields only (`defaultReviewTicks`).
 */
export function planPublicationChanges(inputs: PublicationChangeInput[], options: PublicationChangeOptions = {}): StudioPublishChange[] {
  const ids = inputs.map(input => publicationChangeId(input.productId, input.field))
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate product/field coordinates make the publication review ambiguous.')
  const channelLabel = options.channel ?? 'the channel'
  return inputs.map((input, index) => {
    const { productId, sku, field, label, current, lastAccepted, channel } = input
    const localChanged = changed(current, lastAccepted)
    const sameAsAccepted = providerEqual(lastAccepted, channel, input.acceptedMatchesChannel)
    // A channel's own copy (re-hosted photos) says nothing about a change there.
    const copy = input.channelCopy !== undefined && channel.state === 'value'
    const channelChanged = copy || sameAsAccepted === null ? null : !sameAsAccepted
    let status: StudioPublishChange['status'], reason: string
    let selectable = false, selectedByDefault = false
    if (current.state === 'unknown') {
      status = 'CANNOT_COMPARE'; reason = `Nexus could not prepare this field: ${current.reason}`
    } else if (input.newListing) {
      status = 'SEND'; selectable = selectedByDefault = true; reason = 'Include this prepared field when creating the new listing.'
    } else if (providerEqual(current, channel, input.currentMatchesChannel) === true) {
      status = 'SAME'; reason = 'This value already matches the channel; nothing will be sent.'
    } else if (copy) {
      const own = `${channelLabel === 'the channel' ? 'The channel' : channelLabel} shows its own copy, so only Nexus's side is compared`
      if (lastAccepted.state === 'unknown') { status = 'CANNOT_COMPARE'; selectable = true; reason = input.channelCopy! }
      else if (localChanged === true) { status = 'SEND'; selectable = selectedByDefault = true; reason = `Nexus changed since the last accepted publish (${own}).` }
      else { status = 'SAME'; reason = `Nexus has not changed since the last accepted publish (${own}); nothing will be sent.` }
    } else if (lastAccepted.state === 'unknown') {
      status = channel.state === 'unknown' ? 'CANNOT_COMPARE' : 'DIFFERS'
      selectable = selectedByDefault = channel.state !== 'unknown'
      reason = channel.state === 'unknown' ? `No accepted publish record, and the channel could not be compared: ${channel.reason}`
        : 'No accepted publish record. Publish replaces the channel\'s different value with Nexus\'s; untick it to keep the channel\'s.'
    } else if (channel.state === 'unknown') {
      status = 'CANNOT_COMPARE'; selectable = localChanged === true
      reason = `The channel could not be compared: ${channel.reason}`
    } else if (channelChanged) {
      status = 'DIFFERS'; selectable = selectedByDefault = true
      reason = 'The channel differs from the last accepted publish. Publish replaces its value with Nexus\'s; untick it to keep the channel\'s.'
    } else if (localChanged === true) {
      status = 'SEND'; selectable = selectedByDefault = true; reason = 'Nexus changed since the last accepted publish; the channel still matches that record.'
    } else {
      status = 'SAME'; reason = 'Nexus has not changed and the channel matches the accepted value; nothing will be sent.'
    }
    if (input.refusal !== undefined) { selectable = selectedByDefault = false; reason = input.refusal }
    const change: StudioPublishChange = { id: ids[index], productId, sku, field, label, current, lastAccepted, channel, status, localChanged, channelChanged,
      selectable, selectedByDefault, reason, operation: current.state === 'unknown' ? null : current.state === 'absent' ? 'delete' : 'replace' }
    return status === 'DIFFERS' && selectedByDefault ? { ...change, replaces: publicationReplaces(change, channelLabel) } : change
  })
}

/** IDs are exact and case-sensitive; the provider plan retains the reviewed field order. */
export function selectPublicationChanges(changes: StudioPublishChange[], selectedIds: string[]): StudioPublishChange[] {
  const selected = new Set(selectedIds)
  if (selected.size !== selectedIds.length) throw new Error('A publication field was selected more than once.')
  const byId = new Map(changes.map(change => [change.id, change]))
  if (byId.size !== changes.length) throw new Error('Duplicate publication field IDs make this review ambiguous.')
  for (const id of selected) {
    const change = byId.get(id)
    if (!change) throw new Error('A selected field does not belong to this publication review.')
    if (!change.selectable) throw new Error(`The reviewed field ${change.label} cannot be selected: ${change.reason}`)
  }
  return changes.filter(change => selected.has(change.id))
}
