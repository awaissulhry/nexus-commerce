/**
 * P3b S1 (docs/attributes/PLAN.md §10.9) — the ONE answer to "which channels and markets does this business use".
 *
 * Today three answers exist: the switched-on `Marketplace` rows (19 for every new business, account or not), listing
 * presence, and the web scope bar's connected accounts (`_studio/studio-data.ts` + `scopes.ts:128`). Readiness, sheet
 * coordinates, "required by" marks and suggestions will all read this one (plan rule 2).
 *
 * The rule:
 *   · a channel is in the footprint when it has at least one ACTIVE account managed by oauth or env. The token may
 *     have expired — it still counts, so columns never vanish while an operator reconnects;
 *   · its markets are its switched-on `Marketplace` rows. For Amazon, a market leaves only when Amazon SAID the seller
 *     does not participate there (`participationStatus = 'NOT_PARTICIPATING'`); a market never checked stays in;
 *   · a channel with switched-on markets and no active account is `notConnected` (shown as "connect", never counted
 *     as missing work).
 *
 * Two deliberate differences from today's web scope bar (which reads every oauth/env row, active or not, and every
 * switched-on market): a channel whose accounts are ALL disconnected is not in the footprint (plan: "a channel removed
 * → hidden, values kept"), and an Amazon market Amazon reports as not participating is left out. Pinned in the tests.
 */
import prisma from '../db.js'
import { listManagedConnections } from './connection-resolver.service.js'

export const FOOTPRINT_CHANNEL_ORDER = ['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY'] as const

export interface FootprintAccount { id: string; primary: boolean; managedBy: string; authStatus: string | null; label: string | null }
export interface FootprintChannel { channel: string; accounts: FootprintAccount[]; markets: string[] }
export interface ChannelFootprint {
  channels: FootprintChannel[]
  /** market code → the footprint channels that serve it. */
  markets: Record<string, string[]>
  /** Channels with switched-on markets and no active account. */
  notConnected: Array<{ channel: string; markets: string[] }>
  /** Switched-on markets of a connected channel that the channel says the seller does not use. */
  excludedMarkets: Array<{ channel: string; market: string; reason: 'not participating' }>
}

export interface FootprintConnection { id: string; channelType: string; isActive: boolean; managedBy: string; isPrimary: boolean; authStatus: string | null; label?: string | null }
export interface FootprintMarket { channel: string; code: string; participationStatus: string | null }

const channelRank = (channel: string) => {
  const rank = (FOOTPRINT_CHANNEL_ORDER as readonly string[]).indexOf(channel)
  return rank === -1 ? FOOTPRINT_CHANNEL_ORDER.length : rank
}
const byChannel = (a: string, b: string) => channelRank(a) - channelRank(b) || a.localeCompare(b)

/** Pure: the rule above, from the business's connections and its SWITCHED-ON markets. */
export function footprintFrom(connections: readonly FootprintConnection[], markets: readonly FootprintMarket[]): ChannelFootprint {
  const accounts = new Map<string, FootprintAccount[]>()
  for (const c of connections) {
    if (!c.isActive || (c.managedBy !== 'oauth' && c.managedBy !== 'env')) continue
    accounts.set(c.channelType, [...(accounts.get(c.channelType) ?? []), { id: c.id, primary: c.isPrimary, managedBy: c.managedBy, authStatus: c.authStatus, label: c.label ?? null }])
  }
  const marketsByChannel = new Map<string, FootprintMarket[]>()
  for (const m of markets) marketsByChannel.set(m.channel, [...(marketsByChannel.get(m.channel) ?? []), m])

  const channels: FootprintChannel[] = []
  const notConnected: ChannelFootprint['notConnected'] = []
  const excludedMarkets: ChannelFootprint['excludedMarkets'] = []
  for (const channel of [...marketsByChannel.keys()].sort(byChannel)) {
    const codes = [...new Set(marketsByChannel.get(channel)!.map(m => m.code))].sort()
    const own = accounts.get(channel)
    if (!own?.length) { notConnected.push({ channel, markets: codes }); continue }
    const out = channel === 'AMAZON'
      ? codes.filter(code => {
          const leave = marketsByChannel.get(channel)!.some(m => m.code === code && m.participationStatus === 'NOT_PARTICIPATING')
          if (leave) excludedMarkets.push({ channel, market: code, reason: 'not participating' })
          return !leave
        })
      : codes
    channels.push({ channel, accounts: [...own].sort((a, b) => Number(b.primary) - Number(a.primary) || a.id.localeCompare(b.id)), markets: out })
  }
  const byMarket: Record<string, string[]> = {}
  for (const c of channels) for (const code of c.markets) (byMarket[code] ??= []).push(c.channel)
  return { channels, markets: Object.fromEntries(Object.entries(byMarket).sort(([a], [b]) => a.localeCompare(b))), notConnected, excludedMarkets }
}

/** The current business's footprint (runs in the request's business, like every read). */
export async function channelFootprint(): Promise<ChannelFootprint> {
  const [connections, markets] = await Promise.all([
    listManagedConnections(false),
    prisma.marketplace.findMany({ where: { isActive: true }, select: { channel: true, code: true, participationStatus: true } }),
  ])
  return footprintFrom(connections.map(c => ({ id: c.id, channelType: c.channelType, isActive: c.isActive, managedBy: c.managedBy, isPrimary: c.isPrimary,
    authStatus: c.authStatus ?? null, label: c.accountLabel ?? c.displayName ?? null })), markets)
}
