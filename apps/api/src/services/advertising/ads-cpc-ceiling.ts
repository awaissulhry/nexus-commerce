/**
 * MCP full control A1 (docs/mcp-full-control/sections/01-ads.md §4) — the CPC-ceiling clamp, moved out of
 * advertising.routes.ts WITHOUT a behaviour change, so the bid routes and Claude's bid tools share one code path.
 *
 * For each requested bid, if the target's campaign has `dynamicBidding.cpcCeiling` enabled and the target has
 * historical clicks, the bid is clamped to `multiple × its average CPC` (default multiple 1.5, never below the
 * 5-cent floor). A target with no click history has no basis and is left unclamped; so is a target that is not
 * found (the mutation service answers for it). Runs before the audited mutation service. One findMany.
 */
import prisma from '../../db.js'

export interface BidEntry {
  adTargetId: string
  bidCents: number
}

export interface CpcClamp {
  adTargetId: string
  from: number
  to: number
  ceilingCents: number
}

/** `Campaign.dynamicBidding.cpcCeiling` as the Ad Manager stores it. */
export interface CpcCeilingSetting {
  enabled?: boolean
  multiple?: number
}

/**
 * The ceiling for one target, in cents, or null when none applies (ceiling off, or no click history). Pure.
 */
export function cpcCeilingCents(
  target: { clicks: number; spendCents: number } | null | undefined,
  ceiling: CpcCeilingSetting | null | undefined,
): number | null {
  if (!target || !ceiling?.enabled || !target.clicks || target.clicks <= 0) return null
  const avgCpc = target.spendCents / target.clicks
  return Math.max(5, Math.round((ceiling.multiple ?? 1.5) * avgCpc))
}

/** The effective entries (same order; an unclamped entry is returned as given) and a log of each clamp. */
export async function clampBidsByCeiling<E extends BidEntry>(entries: E[]): Promise<{ entries: E[]; clamps: CpcClamp[] }> {
  const ids = entries.map((e) => e.adTargetId)
  const targets = await prisma.adTarget.findMany({
    where: { id: { in: ids } },
    select: { id: true, clicks: true, spendCents: true, adGroup: { select: { campaign: { select: { dynamicBidding: true } } } } },
  })
  const byId = new Map(targets.map((t) => [t.id, t]))
  const clamps: CpcClamp[] = []
  const out = entries.map((e) => {
    const t = byId.get(e.adTargetId)
    const db = (t?.adGroup?.campaign?.dynamicBidding ?? {}) as { cpcCeiling?: CpcCeilingSetting }
    const ceilingCents = cpcCeilingCents(t, db.cpcCeiling)
    if (ceilingCents === null) return e
    if (e.bidCents > ceilingCents) {
      clamps.push({ adTargetId: e.adTargetId, from: e.bidCents, to: ceilingCents, ceilingCents })
      return { ...e, bidCents: ceilingCents }
    }
    return e
  })
  return { entries: out, clamps }
}
