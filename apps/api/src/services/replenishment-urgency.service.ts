/**
 * R.14 — Channel-level urgency promotion.
 *
 * The bug: pre-R.14 the headline urgency used a global aggregate.
 * A SKU at 0d cover on Amazon-IT-FBA but 200d at IT-MAIN showed
 * as LOW because the aggregate looked fine — Amazon would stock
 * out while operators were oblivious.
 *
 * The fix: headline urgency = MAX(globalUrgency, worstChannelUrgency)
 * where MAX is by severity (CRITICAL > HIGH > MEDIUM > LOW). Strictly
 * tightens — nothing that was CRITICAL becomes lower; only LOWs and
 * MEDIUMs hiding per-channel disasters get promoted.
 *
 * Same threshold formula as the global urgency calculator (route
 * handler) for consistency: leadTime/2 = CRITICAL, leadTime = HIGH,
 * leadTime*2 = MEDIUM, beyond = LOW.
 */

export type Urgency = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'

export interface ChannelCoverInput {
  channel: string
  marketplace: string
  daysOfCover: number | null
}

export interface PromotedUrgency {
  urgency: Urgency
  source: 'GLOBAL' | 'CHANNEL'
  worstChannel: {
    channel: string
    marketplace: string
    daysOfCover: number
    urgency: Urgency
  } | null
}

const URGENCY_RANK: Record<Urgency, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
}

/**
 * Map a per-channel days-of-cover into an urgency tier. Returns null
 * when daysOfCover is null (no recent sales — informationally neutral,
 * skip rather than treat as LOW with infinite cover).
 */
export function computeChannelUrgency(
  daysOfCover: number | null,
  leadTimeDays: number,
): Urgency | null {
  if (daysOfCover == null) return null
  if (leadTimeDays <= 0) return null
  if (daysOfCover <= leadTimeDays / 2) return 'CRITICAL'
  if (daysOfCover <= leadTimeDays) return 'HIGH'
  if (daysOfCover <= leadTimeDays * 2) return 'MEDIUM'
  return 'LOW'
}

/**
 * Pick the worst (most urgent) channel from the cover array. Channels
 * with no recent sales (daysOfCover=null) are excluded — they don't
 * carry signal. Returns null if every channel was skipped.
 */
export function findWorstChannel(
  channels: ChannelCoverInput[],
  leadTimeDays: number,
): { channel: string; marketplace: string; daysOfCover: number; urgency: Urgency } | null {
  let worst: ReturnType<typeof findWorstChannel> = null
  for (const c of channels) {
    const u = computeChannelUrgency(c.daysOfCover, leadTimeDays)
    if (u == null) continue
    const candidate = {
      channel: c.channel,
      marketplace: c.marketplace,
      daysOfCover: c.daysOfCover!, // non-null guaranteed by computeChannelUrgency
      urgency: u,
    }
    if (worst == null || URGENCY_RANK[u] < URGENCY_RANK[worst.urgency]) {
      worst = candidate
    }
  }
  return worst
}

/**
 * Combine global urgency with per-channel urgency. Source tracks
 * which signal drove the headline so the UI can render the
 * provenance ("CRITICAL because of Amazon · IT" vs "CRITICAL on
 * the aggregate").
 */
export function promoteUrgency(args: {
  globalUrgency: Urgency
  channels: ChannelCoverInput[]
  leadTimeDays: number
}): PromotedUrgency {
  const worst = findWorstChannel(args.channels, args.leadTimeDays)

  if (worst == null) {
    return { urgency: args.globalUrgency, source: 'GLOBAL', worstChannel: null }
  }

  // Pick the more severe tier (lower rank = more urgent).
  if (URGENCY_RANK[worst.urgency] < URGENCY_RANK[args.globalUrgency]) {
    return { urgency: worst.urgency, source: 'CHANNEL', worstChannel: worst }
  }

  // Global is at least as urgent as the worst channel; channel is
  // info but didn't promote. Source = GLOBAL.
  return { urgency: args.globalUrgency, source: 'GLOBAL', worstChannel: worst }
}
