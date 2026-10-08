/**
 * ONE BRAIN AB-6 — every engine asks who holds a lever BEFORE it asks to write (design 2026-10-08-ads-one-brain/DESIGN.md
 * §3 target 4: "every other engine checks ownership before it asks (skip, counted per reason); the gate is the last line").
 * The write gate (ads-write-gate.ts productBrainRefusal, AB-5) still refuses the write; this lets an engine leave it first,
 * so its own log, run summary and suggestions stay true: a write it never asked for is not counted as one it made, and a
 * PROPOSE rule never offers a change a product's brain owns.
 *
 *   same answer  an engine skips exactly what the gate would refuse it: under the env ceiling `live` only
 *                (brainLiveCeiling), the levers brain/lever-owners.ts holds (owned by a product's brain at PROPOSE or AUTO,
 *                or held at the Owner's own value by his whole-lever lock), and only for a writer the gate does not let
 *                through (leverWriterOf + leverHoldRefusal: a person's edit, a forced lowering and the safety owners always
 *                pass). The keyword-bids lever stays BB-6's (bid-brain/live.ts brainOwnedCampaignIds): engines already
 *                leave those campaigns by it.
 *   batched      one read per engine run for every campaign it may write (campaignLeverOwners: a fixed number of queries,
 *                remembered 15 s per campaign). Nothing enrolled in the business — production today, apart from the bid
 *                brain's own BidBrainEnrollment — is one remembered query per business (anyBrainEnrolled) and no skip:
 *                every engine runs exactly as before.
 *   unread       a failed read never crashes an engine run and never skips a write on a guess: the engine skips only what
 *                is KNOWN to be held (the last answers this process knew still count, lever-owners.ts) and sends the rest
 *                to the write gate, which judges each write and, when it cannot read the owner either, leaves the queued
 *                row to be sent again (review of #523). The run's summary says the holders were unread.
 *   counted      every skip is counted per lever (counts(), note()); the engine puts the count in its summary line, its
 *                notification or its automation-activity record, and the reason in its own log line.
 */
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { brainLiveCeiling } from '../bid-brain/live.js'
import { LEVER_WORDS, leverHoldRefusal, leverWriterOf } from '../ads-write-gate.js'
import { anyBrainEnrolled, campaignLeverOwners, type CampaignLeverOwners, type LeverHold } from './lever-owners.js'
import type { BrainLever } from './levers.js'

/** The engine's writer, as the gate sees it (GateContext): its actor, and whether a person or a forced lowering writes. */
export interface EngineWriter {
  actor: string
  /** A person's own edit or a request a person approved (the gate never reads a person from the actor). */
  manual?: boolean
  /** A forced lowering (a floor): it passes every lever at the gate. */
  isSuppression?: boolean
}

/** One write an engine leaves to a product's brain (or to the Owner's lock), with why in words. */
export interface LeverSkip {
  lever: BrainLever
  kind: LeverHold['kind']
  campaignId: string
  campaignName: string | null
  productId: string
  market: string
  /** "a product's brain runs the daily budget of campaign "X" (c1) — product p1 in IT" */
  reason: string
}

export type LeverSkipCounts = Partial<Record<BrainLever, number>>

const where = (campaignId: string, name: string | null | undefined) => `campaign ${name ? `"${name}" (${campaignId})` : campaignId}`

/** The skip reason in words (design: "a product's brain runs the <lever> of <campaign>"). Pure. */
export function leverSkipReason(lever: BrainLever, hold: Pick<LeverHold, 'kind' | 'productId' | 'market'>, campaignId: string, name?: string | null): string {
  const words = LEVER_WORDS[lever]
  return hold.kind === 'owned'
    ? `a product's brain runs the ${words} of ${where(campaignId, name)} — product ${hold.productId} in ${hold.market}`
    : `the Owner holds the ${words} of ${where(campaignId, name)} at his own value — product ${hold.productId} in ${hold.market}`
}

/** The skip for `writer` on `lever` of one campaign's holders, or null when nothing holds it or the gate lets it pass. Pure. */
export function leverSkipOf(owners: CampaignLeverOwners | undefined, lever: BrainLever, writer: EngineWriter): LeverSkip | null {
  const hold = owners?.levers[lever]
  if (!owners || !hold) return null
  // Exactly the gate's question: would it refuse this writer on this held lever?
  if (!leverHoldRefusal(lever, hold, leverWriterOf(lever, writer), where(owners.campaignId, owners.name), writer.actor)) return null
  return {
    lever, kind: hold.kind, campaignId: owners.campaignId, campaignName: owners.name ?? null, productId: hold.productId, market: hold.market,
    reason: leverSkipReason(lever, hold, owners.campaignId, owners.name),
  }
}

/** Add one run's counts into another's (in place). */
export function addLeverSkipCounts(into: LeverSkipCounts, from: LeverSkipCounts | null | undefined): LeverSkipCounts {
  for (const [lever, n] of Object.entries(from ?? {}) as Array<[BrainLever, number]>) if (n) into[lever] = (into[lever] ?? 0) + n
  return into
}

/**
 * A run summary's words for its skips: " brain-levers=budgets:2,state:1 (left to a product's brain or the Owner's lock)",
 * " brain-levers=unread (nothing skipped on a guess; …)" when the holders could not be read, or "" on
 * a run that skipped nothing (every run while nothing is enrolled). Pure.
 */
export function leverSkipNote(counts: LeverSkipCounts | null | undefined, unread = false): string {
  const parts = (Object.entries(counts ?? {}) as Array<[BrainLever, number]>).filter(([, n]) => n > 0).map(([lever, n]) => `${lever}:${n}`)
  const said = parts.length ? ` brain-levers=${parts.join(',')} (left to a product's brain or the Owner's lock)` : ''
  return unread ? `${said} brain-levers=unread (nothing skipped on a guess; the write gate judges each write)` : said
}

/**
 * What an action or a run that writes several campaigns adds to its output for the skips it made (`brainSkips`: counts per
 * lever, a sample with why, and whether the holders were unread); empty when it skipped nothing and read fine. Pure.
 */
export function brainSkipsOutput(counts: LeverSkipCounts, sample: readonly LeverSkip[], unread = false): Record<string, unknown> {
  const total = Object.values(counts).reduce((n, v) => n + (v ?? 0), 0)
  if (!total && !unread) return {}
  return {
    brainSkips: {
      counts,
      ...(sample.length ? { sample: sample.slice(0, 5).map((s) => ({ lever: s.lever, campaignId: s.campaignId, why: s.reason })) } : {}),
      ...(unread ? { unread: 'who holds the levers could not be read: nothing was skipped on a guess, the write gate judged each write' } : {}),
    },
  }
}

/** What one engine run knows about who holds the levers of the campaigns it may write. */
export class LeverHolds {
  private readonly tally: LeverSkipCounts = {}

  constructor(
    private readonly owners: ReadonlyMap<string, CampaignLeverOwners>,
    readonly writer: EngineWriter,
    /** The holders could not be read: nothing is skipped, the write gate judges each write. */
    readonly unread = false,
  ) {}

  /** The skip for this run's writer on `lever` of `campaignId`, not counted (a second look, a preview). */
  peek(campaignId: string | null | undefined, lever: BrainLever): LeverSkip | null {
    return campaignId ? leverSkipOf(this.owners.get(campaignId), lever, this.writer) : null
  }

  /** The skip for this run's writer on `lever` of `campaignId`, counted once per call (one call per write left), or null. */
  skip(campaignId: string | null | undefined, lever: BrainLever): LeverSkip | null {
    const s = this.peek(campaignId, lever)
    if (s) this.tally[lever] = (this.tally[lever] ?? 0) + 1
    return s
  }

  /** Count `n` writes left for a reason this reader does not judge itself (the bid brain's keyword bids, BB-6; a product's structure). */
  count(lever: BrainLever, n = 1): void {
    if (n > 0) this.tally[lever] = (this.tally[lever] ?? 0) + n
  }

  counts(): LeverSkipCounts {
    return { ...this.tally }
  }

  total(): number {
    return Object.values(this.tally).reduce((n, v) => n + (v ?? 0), 0)
  }

  /** The run summary's words (leverSkipNote). */
  note(): string {
    return leverSkipNote(this.tally, this.unread)
  }
}

/** Holds for a run that reads nothing (no campaign, or the ceiling is not live). */
export const noLeverHolds = (writer: EngineWriter): LeverHolds => new LeverHolds(new Map(), writer)

/**
 * Read once, for one engine run, who holds the levers of these campaigns. Not under a live ceiling: nothing (no query) —
 * the gate judges nothing either. A failed read: logged once, nothing skipped (`unread`), the write gate decides.
 */
export async function readLeverHolds(campaignIds: Iterable<string | null | undefined>, writer: EngineWriter, engine: string): Promise<LeverHolds> {
  const ids = [...new Set([...campaignIds].filter((id): id is string => !!id))]
  if (!ids.length || !brainLiveCeiling()) return noLeverHolds(writer)
  try {
    return new LeverHolds(await campaignLeverOwners(ids), writer)
  } catch (err) {
    logger.warn(`[ads-brain] ${engine}: could not read who holds the levers of its campaigns — nothing is skipped on a guess; the write gate judges each write and sends one again when it cannot read the owner either`, {
      engine, campaigns: ids.length, error: err instanceof Error ? err.message : String(err),
    })
    return new LeverHolds(new Map(), writer, true)
  }
}

/**
 * readLeverHolds for writes keyed by ad group (Nexus's ids and/or Amazon's): their campaigns in one query, then the holders
 * in one read. `campaignOf` maps every given ad group id (either kind) to its campaign. Not under a live ceiling, or nothing
 * enrolled in the business: no query beyond the remembered "anything enrolled?" (anyBrainEnrolled) and nothing held.
 */
export async function readAdGroupLeverHolds(
  adGroups: { local?: Iterable<string | null | undefined>; external?: Iterable<string | null | undefined> },
  writer: EngineWriter,
  engine: string,
): Promise<{ holds: LeverHolds; campaignOf: Map<string, string> }> {
  const campaignOf = new Map<string, string>()
  const local = [...new Set([...(adGroups.local ?? [])].filter((id): id is string => !!id))]
  const external = [...new Set([...(adGroups.external ?? [])].filter((id): id is string => !!id))]
  if ((!local.length && !external.length) || !brainLiveCeiling()) return { holds: noLeverHolds(writer), campaignOf }
  try {
    if (!(await anyBrainEnrolled())) return { holds: noLeverHolds(writer), campaignOf }
    const rows = await prisma.adGroup.findMany({
      where: { OR: [...(local.length ? [{ id: { in: local } }] : []), ...(external.length ? [{ externalAdGroupId: { in: external } }] : [])] },
      select: { id: true, externalAdGroupId: true, campaignId: true },
    })
    for (const r of rows) {
      campaignOf.set(r.id, r.campaignId)
      if (r.externalAdGroupId) campaignOf.set(r.externalAdGroupId, r.campaignId)
    }
  } catch (err) {
    logger.warn(`[ads-brain] ${engine}: could not read the campaigns of its ad groups — nothing is skipped on a guess; the write gate judges each write`, {
      engine, error: err instanceof Error ? err.message : String(err),
    })
    return { holds: new LeverHolds(new Map(), writer, true), campaignOf }
  }
  return { holds: await readLeverHolds(campaignOf.values(), writer, engine), campaignOf }
}

/** One product's lever held for a writer (a build of new campaigns, which no campaign's owner can answer for). */
export interface ProductLeverSkip {
  lever: BrainLever
  kind: LeverHold['kind']
  productId: string
  market: string
  reason: string
}

/**
 * ONE BRAIN AB-6 — a product's own lever, for a writer that creates what no campaign holds yet: a playbook build, an AI
 * goal's scaffold (the structure lever: design §3, "AI goals, playbook build (unless the brain asks it)"). The product's
 * brain settings say it (brain/enrollment.ts brainSettings): owned at PROPOSE or AUTO, or the Owner's whole-lever lock.
 * Same writer rule as the gate (a person, a forced lowering and the safety owners pass; the brain passes a lever it owns).
 * Not under a live ceiling, or nothing enrolled in the business: null at once. A failed read: null, logged (skip only what
 * is known to be held).
 */
export async function productLeverSkip(productId: string, market: string, lever: BrainLever, writer: EngineWriter, engine: string): Promise<ProductLeverSkip | null> {
  if (!productId || !market || !brainLiveCeiling()) return null
  const who = leverWriterOf(lever, writer)
  if (who === 'passes') return null
  try {
    if (!(await anyBrainEnrolled())) return null
    const { brainSettings } = await import('./enrollment.js')
    const s = await brainSettings(productId, market)
    const l = s?.levers[lever]
    if (!s || !l) return null
    const kind: LeverHold['kind'] | null = l.effective === 'LOCKED' ? 'locked' : l.owned ? 'owned' : null
    if (!kind || (kind === 'owned' && who === 'brain')) return null
    const words = LEVER_WORDS[lever]
    return {
      lever, kind, productId: s.productId, market: s.market,
      reason: kind === 'owned'
        ? `a product's brain runs the ${words} of product ${s.productId} in ${s.market} (${l.why})`
        : `the Owner holds the ${words} of product ${s.productId} in ${s.market} at his own value (${l.why})`,
    }
  } catch (err) {
    logger.warn(`[ads-brain] ${engine}: could not read whether a product's brain holds its ${lever} lever — nothing is skipped on a guess`, {
      engine, productId, market, error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
