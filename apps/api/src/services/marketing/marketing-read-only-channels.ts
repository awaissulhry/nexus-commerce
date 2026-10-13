/**
 * Google Ads step 1a (plan-3 §2 D1, D2, D4; §3.5 A3) — the marketing channels Nexus only reads.
 *
 * Nexus has no integration that changes Google, Meta or TikTok ads: their unified-layer adapters are sandbox stubs
 * (adapters/stub-adapters.ts), so creating, pausing, resuming, re-budgeting or launching one of their campaigns would be
 * recorded in Nexus as done while nothing reached the channel. The marketing OS routes refuse those writes before
 * anything is queued, and the marketing write gate never answers live for these channels, whatever the env says.
 * Google Ads is read through its own stack (services/marketing/google-ads/), never through these rows.
 */
import prisma from '../../db.js'

export const READ_ONLY_CHANNELS = ['GOOGLE', 'META', 'TIKTOK'] as const
export type ReadOnlyChannel = (typeof READ_ONLY_CHANNELS)[number]

/** What the channel's ads are called, and where a person makes the change instead. */
const WORDS: Readonly<Record<ReadOnlyChannel, { ads: string; where: string }>> = {
  GOOGLE: { ads: 'Google Ads', where: 'Google Ads' },
  META: { ads: 'Meta ads', where: 'Meta Ads Manager' },
  TIKTOK: { ads: 'TikTok ads', where: 'TikTok Ads Manager' },
}

export function isReadOnlyChannel(channel: unknown): channel is ReadOnlyChannel {
  return typeof channel === 'string' && (READ_ONLY_CHANNELS as readonly string[]).includes(channel.trim().toUpperCase())
}

export interface ChannelReadOnlyRefusal {
  code: 'channel_read_only'
  error: string
}

/** The 409 answer for a write on a read-only channel; null when the channel takes writes through Nexus. */
export function channelReadOnlyRefusal(channel: unknown): ChannelReadOnlyRefusal | null {
  if (!isReadOnlyChannel(channel)) return null
  const words = WORDS[channel.trim().toUpperCase() as ReadOnlyChannel]
  return { code: 'channel_read_only', error: `Nexus does not make changes in ${words.ads} yet. Make this change in ${words.where}.` }
}

/** The refusal for a write on this marketing campaign; null when its channel takes writes (or it does not exist). */
export async function campaignReadOnlyRefusal(campaignId: string): Promise<ChannelReadOnlyRefusal | null> {
  const campaign = await prisma.marketingCampaign.findUnique({ where: { id: campaignId }, select: { channel: true } })
  return campaign ? channelReadOnlyRefusal(campaign.channel) : null
}
