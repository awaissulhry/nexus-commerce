/**
 * ── D-PLC-2 (2026-08-22) — a Placement rule may not be armed to AUTO against the rank engine ───
 *
 * `ad-rank-defend` pins each lane to the floor of whatever `RankTarget` the hour resolves to, on
 * every campaign an enabled `AdSchedule` governs. Measured on prod 2026-08-22: **7,818 lane writes
 * across 34 campaigns in seven days**, against **6 human lane writes in thirty** — and the account
 * watched the bias move wholesale between lanes inside one morning (Rest of Search 45 → 0 across
 * the account at 08:15, "snap to 75% Placement", while Top of Search went from non-zero on 16
 * campaigns at 00:19 to 48 at 11:46).
 *
 * So an AUTO placement rule pointed at a contested lane on a governed campaign is not merely
 * ineffective — it is a **write loop**: it writes, the engine reverts it within the hour, it writes
 * again on the next tick. It burns Amazon write quota, fills `CampaignBidHistory` with noise, and
 * changes nothing. That is worth refusing rather than warning about.
 *
 * 🔴 **The refinement the data forces, and the reason this is not a blanket ban.** The engine does
 * not contest all three lanes. Over the same 30 days it wrote `PLACEMENT_TOP` **12,197** times and
 * `PLACEMENT_REST_OF_SEARCH` **11,075** times — and `PLACEMENT_PRODUCT_PAGE` **twice**. A Product
 * Pages rule on a governed campaign therefore HOLDS, and blocking it would forbid the one
 * placement automation that actually works on the governed half of the account. (It is why the
 * PLC-P6 raise starter targets Product Pages.)
 *
 * What this refuses, precisely: **AUTO** ∧ the rule writes a **contested lane** ∧ at least one
 * campaign in its picker is governed by an **enabled** `AdSchedule`. Everything else is allowed —
 * PROPOSE is always allowed, because a proposal a human reads and accepts is a human's write, and
 * the operator may well want to override the engine deliberately once.
 *
 * Live, not cached: a schedule disabled tomorrow makes the same rule armable tomorrow, with no
 * state to clear.
 */
import prisma from '../../db.js'
import { PLACEMENT_TOP, PLACEMENT_REST, PLACEMENT_PRODUCT } from './ads-placement-math.js'

/**
 * The lanes `ad-rank-defend` actually rewrites. Product Pages is deliberately absent — see the
 * header; it is the one lane the engine leaves alone, and the exception is the whole point.
 */
export const ENGINE_CONTESTED_LANES: readonly string[] = [PLACEMENT_TOP, PLACEMENT_REST]

export interface PlacementAutoVerdict {
  /** True ⇒ refuse the arming. */
  blocked: boolean
  /** The operator-facing sentence. Names the cause AND the two ways out. */
  message: string
  /** Campaign names the engine governs, for the caller to render. */
  governed: string[]
  /** The contested lanes this rule writes. */
  lanes: string[]
}

/**
 * PURE — the verdict, given what was measured. Separated from the reads so the sentence an
 * operator sees is testable without a database.
 */
export function placementAutoVerdict(
  lanes: string[],
  governed: string[],
): PlacementAutoVerdict {
  const contested = lanes.filter((l) => ENGINE_CONTESTED_LANES.includes(l))
  if (contested.length === 0 || governed.length === 0) {
    return { blocked: false, message: '', governed, lanes: contested }
  }
  const laneWords = contested
    .map((l) => (l === PLACEMENT_TOP ? 'Top of Search' : l === PLACEMENT_REST ? 'Rest of Search' : l))
    .join(' and ')
  const n = governed.length
  const named = governed.slice(0, 3).join(', ')
  const rest = n > 3 ? ` and ${n - 3} more` : ''
  return {
    blocked: true,
    governed,
    lanes: contested,
    message:
      `This rule writes ${laneWords} on ${n} campaign${n === 1 ? '' : 's'} that Rank & Dayparting `
      + `already controls (${named}${rest}). The rank engine rewrites ${contested.length === 1 ? 'that lane' : 'those lanes'} `
      + `every time it runs, so on Auto this rule would set a modifier and have it reverted within the hour — `
      + `over and over, spending write quota to change nothing. `
      + `Leave it on Manual, or remove ${n === 1 ? 'that campaign' : 'those campaigns'} from the rule. `
      + `Product Pages is the one lane the rank engine does not touch, if you want a placement rule that holds here.`,
  }
}

/** Which lanes a stored rule actually writes, via its own translation — never its slug's repertoire. */
export function placementLanesOf(rule: { id: string; actions?: unknown; conditions?: unknown }): string[] {
  const out = new Set<string>()
  for (const a of (Array.isArray(rule.actions) ? rule.actions : []) as Array<Record<string, unknown>>) {
    // engine-native rules carry the lane on the action itself
    if (typeof a?.placement === 'string') out.add(a.placement)
  }
  return [...out]
}

/**
 * The full check: reads the rule's picker and the live schedule table.
 *
 * Returns `blocked: false` for every non-placement rule and for every level except AUTO — the
 * caller may hand it anything.
 */
export async function checkPlacementAutoAllowed(
  rule: { id: string; actions?: unknown; conditions?: unknown },
  level: string,
  producedTypes: string[],
): Promise<PlacementAutoVerdict> {
  const none: PlacementAutoVerdict = { blocked: false, message: '', governed: [], lanes: [] }
  if (level !== 'AUTO') return none
  if (!producedTypes.includes('placement_apply')) return none

  const { maybeTranslateAdsRule, builderDraftCampaignIds } = await import('./ads-rule-adapter.service.js')
  // The lanes the TRANSLATION emits — a multi-block rule may write a different lane per block, and
  // one contested block is enough to make Auto a write loop.
  const translated = maybeTranslateAdsRule(rule)
  const lanes = new Set<string>(placementLanesOf(rule))
  for (const b of translated?.blocks ?? []) {
    for (const a of b.actions ?? []) {
      const p = (a as { placement?: unknown }).placement
      if (typeof p === 'string') lanes.add(p)
    }
  }
  if (![...lanes].some((l) => ENGINE_CONTESTED_LANES.includes(l))) return none

  const picked = builderDraftCampaignIds(rule.actions, 'placement')
    ?? (Array.isArray((rule.actions as Array<Record<string, unknown>>)?.[0]?.campaignIds)
      ? ((rule.actions as Array<Record<string, unknown>>)[0].campaignIds as string[])
      : [])
  // 🔴 An EMPTY picker is not "no campaigns" — `campaignAllowed` treats an empty allowlist as no
  // restriction, so the rule reaches the whole account and therefore every governed campaign.
  const governedRows = await prisma.adSchedule.findMany({
    where: { enabled: true, ...(picked.length ? { campaignId: { in: picked } } : {}) },
    select: { campaignId: true },
  })
  if (governedRows.length === 0) return none
  const ids = [...new Set(governedRows.map((r) => r.campaignId))]
  const campaigns = await prisma.campaign.findMany({ where: { id: { in: ids } }, select: { name: true } })
  return placementAutoVerdict([...lanes], campaigns.map((c) => c.name).sort())
}
