/**
 * SC.1 — channel/market policy lookup for the derivation core.
 * One findMany per call site (rows are few); '*' marketplace = channel-wide.
 *
 * MAP.2b — a row also names an account (`channelConnectionId`); a row with no account is for EVERY
 * account of the channel. A lookup that knows the listing's account sees both.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../db.js'
import { normalizeMarket, KNOWN_CHANNELS } from './sync-control-core.js'

/**
 * Step 2 — a row may also hold the market's "Sells from" list (`sourceLocationCodes`). That list is not a pause or a
 * new-listing default: a row that holds a list and nothing else (no pause, the FOLLOW default) carries no policy of its
 * own, and `policyFor` passes over it, so a channel-wide pause still reaches that market. Any other row reads exactly
 * as before (an exact market row beats the channel-wide one).
 */
export type PolicyMap = Map<string, { pushesPaused: boolean; newListingDefaultMode: string; sourceLocationCodes?: string[] }>

/** A row kept only for its "Sells from" list: no pause, the FOLLOW default, and a list. */
const listOnly = (p: { pushesPaused: boolean; newListingDefaultMode: string; sourceLocationCodes?: string[] }): boolean =>
  !p.pushesPaused && p.newListingDefaultMode === 'FOLLOW' && (p.sourceLocationCodes ?? []).length > 0

/** Oldest first, so the newest row of one key is merged last (and its list wins). */
const byUpdatedAt = <T extends { updatedAt?: Date | null }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => (a.updatedAt?.getTime?.() ?? 0) - (b.updatedAt?.getTime?.() ?? 0))

/** The map key of one policy row: channel, market ('*' = every market) and account ('' = every account). */
export function policyKey(channel: string, marketplace: string, connectionId?: string | null): string {
  return `${channel.toUpperCase()}:${marketplace.toUpperCase()}@${connectionId ?? ''}`
}

/** The parts of a `policyKey`. */
export function parsePolicyKey(key: string): { channel: string; market: string; accountId: string | null } {
  const at = key.lastIndexOf('@')
  const [channel, market] = key.slice(0, at).split(':')
  return { channel: channel!, market: market ?? '*', accountId: key.slice(at + 1) || null }
}

export async function loadChannelPolicies(
  db: { syncChannelPolicy: { findMany: (args?: unknown) => Promise<unknown> } } = prisma as never,
): Promise<PolicyMap> {
  try {
    const rows = (await db.syncChannelPolicy.findMany()) as Array<{
      channel: string
      marketplace: string
      channelConnectionId?: string | null
      pushesPaused: boolean
      newListingDefaultMode: string
      sourceLocationCodes?: string[] | null
      updatedAt?: Date | null
    }>
    const map: PolicyMap = new Map()
    for (const r of byUpdatedAt(rows)) {
      // The unique key cannot stop two rows for "every account" (NULLs are distinct), so rows of one key
      // merge, and a pause wins: a row nobody can see must never un-pause a channel. A list: the newest wins.
      const key = policyKey(r.channel, r.marketplace, r.channelConnectionId)
      const before = map.get(key)
      map.set(key, {
        pushesPaused: r.pushesPaused || !!before?.pushesPaused,
        newListingDefaultMode: r.newListingDefaultMode === 'PAUSED' || before?.newListingDefaultMode === 'PAUSED' ? 'PAUSED' : r.newListingDefaultMode,
        sourceLocationCodes: r.sourceLocationCodes?.length ? [...r.sourceLocationCodes] : before?.sourceLocationCodes ?? [],
      })
    }
    return map
  } catch {
    // fail-open: absent/unreadable policies = no pauses (today's behavior)
    return new Map()
  }
}

/**
 * Effective policy for a channel+marketplace (+ the listing's account when known). The market decides first,
 * then the account: exact market for this account, exact market for every account, then the same for '*'.
 */
export function policyFor(
  policies: PolicyMap,
  channel: string,
  marketplace: string,
  connectionId?: string | null,
): { pushesPaused: boolean } | null {
  const m = normalizeMarket(channel, marketplace)
  // A row that holds only a "Sells from" list says nothing about pushes: it is passed over, never read as "not paused".
  const policy = (key: string) => {
    const found = policies.get(key)
    return found && !listOnly(found) ? found : undefined
  }
  for (const market of [m, '*']) {
    const found = (connectionId ? policy(policyKey(channel, market, connectionId)) : undefined) ?? policy(policyKey(channel, market))
    if (found) return found
  }
  return null
}

// ── SC.5 — policy mutations support ─────────────────────────────────────────

export interface PolicyWriteResult {
  /** The policy before the write (its rows merged), or null when it had none. */
  before: { id: string; pushesPaused: boolean; newListingDefaultMode: string; sourceLocationCodes: string[] } | null
  /** The row that now holds the policy; null when the result was all-default and its rows were removed. */
  saved: { id: string } | null
  nextPaused: boolean
  nextMode: string
  /** Step 2 — the market's "Sells from" list after the write ([] = none). */
  nextSourceLocationCodes: string[]
  pausedChanged: boolean
  modeChanged: boolean
  sourcesChanged: boolean
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((code, i) => code === b[i])

/**
 * Save one policy: a channel, a market ('*' = every market) and an account (null = every account). The rows are
 * found by the SAME account they are written with. (A lookup by the channel's primary account and a write with no
 * account left a pause that Resume never found: it answered "ok" and the channel stayed paused.) The key cannot
 * target a NULL account and NULLs do not collide, so "every account" can hold more than one row: they are one
 * policy, read together and written together. An all-default result removes the rows (an all-default row and no
 * row derive identically) — unless the row still holds the market's "Sells from" list (Step 2): a field the write
 * does not name keeps its value, so a pause or resume never wipes a list, and a list never moves a pause.
 * With `tx`, every read and write runs in that transaction (the caller commits); without it, as before.
 */
export async function writeChannelPolicy(input: {
  channel: string
  marketplace: string
  channelConnectionId: string | null
  pushesPaused?: boolean
  newListingDefaultMode?: 'FOLLOW' | 'PAUSED'
  /** Step 2 — the market's ordered "Sells from" codes; [] removes the list; absent keeps it. */
  sourceLocationCodes?: string[]
}, tx?: Prisma.TransactionClient): Promise<PolicyWriteResult> {
  const { channel, marketplace, channelConnectionId } = input
  const db = tx ?? prisma
  const same = await db.syncChannelPolicy.findMany({
    where: { channel, marketplace, channelConnectionId },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
  })
  const before = same.length
    ? {
        id: same[0]!.id,
        pushesPaused: same.some((row) => row.pushesPaused),
        newListingDefaultMode: same.some((row) => row.newListingDefaultMode === 'PAUSED') ? 'PAUSED' : same[0]!.newListingDefaultMode,
        // The newest row that holds a list (rows come newest first).
        sourceLocationCodes: [...(same.find((row) => (row.sourceLocationCodes ?? []).length > 0)?.sourceLocationCodes ?? [])],
      }
    : null
  const nextPaused = input.pushesPaused ?? before?.pushesPaused ?? false
  const nextMode = input.newListingDefaultMode ?? before?.newListingDefaultMode ?? 'FOLLOW'
  const nextSourceLocationCodes = input.sourceLocationCodes ? [...input.sourceLocationCodes] : before?.sourceLocationCodes ?? []
  const modeChanged = nextMode !== (before?.newListingDefaultMode ?? 'FOLLOW')
  const pausedChanged = nextPaused !== (before?.pushesPaused ?? false)
  const sourcesChanged = !sameList(nextSourceLocationCodes, before?.sourceLocationCodes ?? [])
  const result = { before, nextPaused, nextMode, nextSourceLocationCodes, pausedChanged, modeChanged, sourcesChanged }

  if (!nextPaused && nextMode === 'FOLLOW' && nextSourceLocationCodes.length === 0) {
    if (same.length) await db.syncChannelPolicy.deleteMany({ where: { id: { in: same.map((row) => row.id) } } })
    return { ...result, saved: null }
  }
  if (!before) {
    const created = await db.syncChannelPolicy.create({
      data: {
        channel, marketplace, channelConnectionId, pushesPaused: nextPaused, newListingDefaultMode: nextMode,
        newListingModeSetAt: nextMode === 'PAUSED' ? new Date() : null, sourceLocationCodes: nextSourceLocationCodes,
      },
      select: { id: true },
    })
    return { ...result, saved: created }
  }
  const update = async (t: Prisma.TransactionClient) => {
    // Extra rows of the same policy go; the newest carries the merged values.
    if (same.length > 1) await t.syncChannelPolicy.deleteMany({ where: { id: { in: same.slice(1).map((row) => row.id) } } })
    return t.syncChannelPolicy.update({
      where: { id: before.id },
      data: {
        pushesPaused: nextPaused,
        newListingDefaultMode: nextMode,
        sourceLocationCodes: nextSourceLocationCodes,
        // Cutoff moves ONLY when the default-mode itself changes.
        ...(modeChanged ? { newListingModeSetAt: nextMode === 'PAUSED' ? new Date() : null } : {}),
      },
      select: { id: true },
    })
  }
  const saved = tx ? await update(tx) : await prisma.$transaction(update)
  return { ...result, saved }
}

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
  })) as Array<{ channel: string; marketplace: string; channelConnectionId?: string | null; newListingModeSetAt: Date }>
  if (policies.length === 0) return { paused: 0 }

  let paused = 0
  for (const p of policies) {
    const candidates = (await db.channelListing.findMany({
      where: {
        channel: p.channel.toUpperCase(),
        // A row for one account pauses only that account's new listings.
        ...(p.channelConnectionId ? { channelConnectionId: p.channelConnectionId } : {}),
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
