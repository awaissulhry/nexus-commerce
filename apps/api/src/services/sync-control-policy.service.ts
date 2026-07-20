/**
 * SC.1 — channel/market policy lookup for the derivation core.
 * One findMany per call site (rows are few); '*' marketplace = channel-wide.
 */
import prisma from '../db.js'
import { normalizeMarket } from './sync-control-core.js'

export type PolicyMap = Map<string, { pushesPaused: boolean; newListingDefaultMode: string }>

export async function loadChannelPolicies(
  db: { syncChannelPolicy: { findMany: (args?: unknown) => Promise<unknown> } } = prisma as never,
): Promise<PolicyMap> {
  try {
    const rows = (await db.syncChannelPolicy.findMany()) as Array<{
      channel: string
      marketplace: string
      pushesPaused: boolean
      newListingDefaultMode: string
    }>
    const map: PolicyMap = new Map()
    for (const r of rows) {
      map.set(`${r.channel.toUpperCase()}:${r.marketplace.toUpperCase()}`, {
        pushesPaused: r.pushesPaused,
        newListingDefaultMode: r.newListingDefaultMode,
      })
    }
    return map
  } catch {
    // fail-open: absent/unreadable policies = no pauses (today's behavior)
    return new Map()
  }
}

/** Effective policy for a channel+marketplace: exact row wins over '*' row. */
export function policyFor(
  policies: PolicyMap,
  channel: string,
  marketplace: string,
): { pushesPaused: boolean } | null {
  const c = channel.toUpperCase()
  const m = normalizeMarket(channel, marketplace)
  return policies.get(`${c}:${m}`) ?? policies.get(`${c}:*`) ?? null
}
