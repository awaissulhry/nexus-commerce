/**
 * SC.1 — channel/market policy lookup for the derivation core.
 * One findMany per call site (rows are few); '*' marketplace = channel-wide.
 */
import prisma from '../db.js'
import { normalizeMarket, KNOWN_CHANNELS } from './sync-control-core.js'

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

// ── SC.5 — policy mutations support ─────────────────────────────────────────

/** Pure: validate a policy upsert input. Returns null when valid, else the problem. */
export function validatePolicyInput(input: {
  channel?: string
  marketplace?: string
  pushesPaused?: unknown
  newListingDefaultMode?: unknown
}): string | null {
  const c = String(input.channel ?? '').trim().toUpperCase()
  const m = String(input.marketplace ?? '').trim().toUpperCase()
  if (!KNOWN_CHANNELS.includes(c as never)) return `unknown channel '${input.channel}'`
  if (m !== '*' && !/^[A-Z]{2,4}$/.test(m)) return `marketplace must be '*' or a market code, got '${input.marketplace}'`
  if (input.pushesPaused === undefined && input.newListingDefaultMode === undefined) {
    return 'nothing to change (pass pushesPaused and/or newListingDefaultMode)'
  }
  if (input.pushesPaused !== undefined && typeof input.pushesPaused !== 'boolean') return 'pushesPaused must be boolean'
  if (input.newListingDefaultMode !== undefined && !['FOLLOW', 'PAUSED'].includes(String(input.newListingDefaultMode))) {
    return `newListingDefaultMode must be FOLLOW or PAUSED`
  }
  return null
}

interface EnforceDb {
  syncChannelPolicy: { findMany: (args?: unknown) => Promise<unknown> }
  channelListing: {
    findMany: (args?: unknown) => Promise<unknown>
    updateMany: (args?: unknown) => Promise<{ count: number }>
  }
  syncControlAudit: {
    findMany: (args?: unknown) => Promise<unknown>
    createMany: (args?: unknown) => Promise<unknown>
  }
}

/**
 * SC.5 — enforce newListingDefaultMode=PAUSED: listings created AFTER the
 * policy cutoff start life sync-paused (dark) instead of pushing pool truth.
 *
 * Idempotent and resume-sticky: each listing is auto-paused AT MOST ONCE —
 * the audit row (actor 'policy:new-listing') is the "seen" marker, so an
 * operator RESUME is never overridden by a later sweep. Runs from the
 * watchdog loop and inline when the policy is set; creation sites stay
 * untouched.
 */
export async function enforceNewListingDefaults(db: EnforceDb = prisma as never): Promise<{ paused: number }> {
  const policies = (await db.syncChannelPolicy.findMany({
    where: { newListingDefaultMode: 'PAUSED', newListingModeSetAt: { not: null } },
  })) as Array<{ channel: string; marketplace: string; newListingModeSetAt: Date }>
  if (policies.length === 0) return { paused: 0 }

  let paused = 0
  for (const p of policies) {
    const candidates = (await db.channelListing.findMany({
      where: {
        channel: p.channel.toUpperCase(),
        createdAt: { gt: p.newListingModeSetAt },
        syncPaused: false,
      },
      select: { id: true, sku: true, channel: true, marketplace: true },
    })) as Array<{ id: string; sku: string | null; channel: string; marketplace: string | null }>
    // '*' = channel-wide; else match after normalization (EBAY_IT → IT)
    const scoped = p.marketplace === '*'
      ? candidates
      : candidates.filter((c) => normalizeMarket(c.channel, c.marketplace ?? '') === p.marketplace.toUpperCase())
    if (scoped.length === 0) continue

    const seen = (await db.syncControlAudit.findMany({
      where: { actor: 'policy:new-listing', scopeType: 'LISTING', scopeId: { in: scoped.map((c) => c.id) } },
      select: { scopeId: true },
    })) as Array<{ scopeId: string }>
    const seenIds = new Set(seen.map((s) => s.scopeId))
    const fresh = scoped.filter((c) => !seenIds.has(c.id))
    if (fresh.length === 0) continue

    await db.channelListing.updateMany({
      where: { id: { in: fresh.map((f) => f.id) } },
      data: { syncPaused: true },
    })
    await db.syncControlAudit.createMany({
      data: fresh.map((f) => ({
        actor: 'policy:new-listing',
        scopeType: 'LISTING',
        scopeId: f.id,
        scopeName: `${f.sku ?? '?'}@${f.channel}:${f.marketplace ?? '?'}`,
        field: 'syncPaused',
        before: { syncPaused: false },
        after: { syncPaused: true },
        reason: `newListingDefaultMode=PAUSED for ${p.channel}:${p.marketplace}`,
      })),
    })
    paused += fresh.length
  }
  return { paused }
}
