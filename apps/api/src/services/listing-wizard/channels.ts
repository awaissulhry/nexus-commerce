/**
 * Phase A — multi-channel wizard helpers.
 *
 * Centralises the (channel, marketplace) ↔ channels[] translation so the
 * route handlers don't have to deal with JSON-array shapes inline. Phase
 * B will widen the consumers to use the full channel set; until then,
 * these helpers keep the existing single-channel code paths working by
 * reading the first entry of channels[].
 */

import crypto from 'node:crypto'

export interface ChannelTuple {
  platform: string
  marketplace: string
}

/**
 * Normalize a channels array — trims, uppercases the platform, and
 * deduplicates while preserving the user's selection order.
 */
export function normalizeChannels(input: unknown): ChannelTuple[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const out: ChannelTuple[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as { platform?: unknown; marketplace?: unknown }
    if (typeof r.platform !== 'string' || typeof r.marketplace !== 'string') {
      continue
    }
    const platform = r.platform.trim().toUpperCase()
    const marketplace = r.marketplace.trim().toUpperCase()
    if (!platform || !marketplace) continue
    const key = `${platform}:${marketplace}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ platform, marketplace })
  }
  return out
}

/**
 * Stable, order-insensitive hash of a channels array. Used as the
 * resume key so two wizards targeting [AMAZON:IT, AMAZON:DE] and
 * [AMAZON:DE, AMAZON:IT] are recognised as the same draft.
 *
 * Matches the migration's hash algorithm for single-entry rows
 * (md5(`<platform>:<marketplace>`)) when len === 1.
 */
export function channelsHash(channels: ChannelTuple[]): string {
  const sorted = [...channels]
    .map((c) => `${c.platform}:${c.marketplace}`)
    .sort()
  return crypto.createHash('md5').update(sorted.join('|')).digest('hex')
}

/**
 * Bridge for routes that haven't been widened to multi-channel yet.
 * Reads the first channel from a wizard row's channels[] and exposes
 * it as the legacy `{channel, marketplace}` shape. Throws if the
 * channels array is empty — that would mean a wizard row with no
 * targets, which shouldn't exist post-migration.
 */
export function legacyFirstChannel(wizard: { channels: unknown }): {
  channel: string
  marketplace: string
} {
  const arr = normalizeChannels(wizard.channels)
  if (arr.length === 0) {
    throw new Error(
      'Wizard has no channels — this should not happen post-Phase A migration.',
    )
  }
  return {
    channel: arr[0]!.platform,
    marketplace: arr[0]!.marketplace,
  }
}

/**
 * "PLATFORM:MARKET" key used everywhere multi-channel state is keyed
 * (channelStates, validation tags, content tabs).
 */
export function channelKey(t: ChannelTuple): string {
  return `${t.platform}:${t.marketplace}`
}
