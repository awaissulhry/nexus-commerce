/**
 * UM-series (P5) — single chokepoint for marketing-channel write
 * authorization. Generalizes ads-write-gate across channels.
 *
 * Live writes require ALL of:
 *   1. Per-channel mode is live (Amazon: NEXUS_AMAZON_ADS_MODE=live; other
 *      channels: NEXUS_MARKETING_WRITES_<CHANNEL>=1)
 *   2. payload value ≤ NEXUS_MARKETING_MAX_WRITE_VALUE_CENTS (default €500)
 * Otherwise the mutation runs in sandbox: the DB-side optimistic update +
 * audit complete, but no external API call fires.
 *
 * Defense-in-depth alongside the per-rule caps (P6) and the grace window.
 * Amazon LIVE writes through the unified path are intentionally NOT
 * enabled here until P8 (the Amazon authoritative cutover) — sandbox is
 * the only mode the unified path drives for Amazon in P5.
 */

import type { MktChannel } from '@prisma/client'
import { adsMode } from '../advertising/ads-api-client.js'

export type MarketingGateDecision =
  | { allowed: true; mode: 'sandbox' }
  | { allowed: true; mode: 'live' }
  | { allowed: false; mode: 'sandbox'; reason: string }

export interface MarketingGateContext {
  channel: MktChannel
  marketplace: string | null
  payloadValueCents: number
}

function maxWriteValueCents(): number {
  const v = Number(process.env.NEXUS_MARKETING_MAX_WRITE_VALUE_CENTS)
  if (Number.isFinite(v) && v > 0) return v
  return 50_000 // €500 default
}

/** Is this channel allowed to make LIVE external writes via the unified path? */
function channelLiveEnabled(channel: MktChannel): boolean {
  switch (channel) {
    case 'AMAZON':
      // Amazon live via the UNIFIED path waits for P8 cutover. Until then
      // the legacy ads-mutation path stays authoritative; unified = sandbox.
      return false
    case 'EBAY':
      return process.env.NEXUS_MARKETING_WRITES_EBAY === '1'
    case 'SHOPIFY':
      return process.env.NEXUS_MARKETING_WRITES_SHOPIFY === '1'
    case 'GOOGLE':
      return process.env.NEXUS_MARKETING_WRITES_GOOGLE === '1'
    case 'META':
      return process.env.NEXUS_MARKETING_WRITES_META === '1'
    case 'TIKTOK':
      return process.env.NEXUS_MARKETING_WRITES_TIKTOK === '1'
    case 'INTERNAL':
      // Content/outreach delegate to MC/RV pipelines (P10) — gated there.
      return process.env.NEXUS_MARKETING_WRITES_INTERNAL === '1'
    default:
      return false
  }
}

export function checkMarketingWriteGate(ctx: MarketingGateContext): MarketingGateDecision {
  // Value cap applies regardless of channel.
  if (ctx.payloadValueCents > maxWriteValueCents()) {
    return {
      allowed: false,
      mode: 'sandbox',
      reason: `payload value ${ctx.payloadValueCents}¢ exceeds cap ${maxWriteValueCents()}¢`,
    }
  }

  // Amazon additionally respects the existing deploy-wide ads mode flag, so
  // a single env toggle keeps legacy + unified consistent.
  if (ctx.channel === 'AMAZON' && adsMode() === 'sandbox') {
    return { allowed: true, mode: 'sandbox' }
  }

  return channelLiveEnabled(ctx.channel)
    ? { allowed: true, mode: 'live' }
    : { allowed: true, mode: 'sandbox' }
}
