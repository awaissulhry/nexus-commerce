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
 *
 * 4e (review 5.3) — Product Pages is contested on a campaign whose schedule can hold a BLEND: a
 * blend writes the whole profile and sets every managed lane it does not name to 0
 * (`buildBlendedAdjustments`), so a Product Pages rule's 25% is reset on the next tick. The same
 * check now runs at write time too (`placement_apply` skips a contested lane on an automated run),
 * and on a rule edit (`updateAdsRule` moves an AUTO rule the edit made contested back to PROPOSE).
 */
import prisma from '../../db.js'
import { PLACEMENT_TOP, PLACEMENT_REST, PLACEMENT_PRODUCT, MANAGED_PLACEMENTS } from './ads-placement-math.js'

/**
 * The lanes `ad-rank-defend` rewrites on every campaign it governs. Product Pages is absent — see
 * the header; it is contested only where the schedule can hold a blend (`contestedLanesByCampaign`).
 */
export const ENGINE_CONTESTED_LANES: readonly string[] = [PLACEMENT_TOP, PLACEMENT_REST]

const LANE_WORDS: Record<string, string> = { [PLACEMENT_TOP]: 'Top of Search', [PLACEMENT_REST]: 'Rest of Search', [PLACEMENT_PRODUCT]: 'Product Pages' }
const laneWord = (l: string): string => LANE_WORDS[l] ?? l

type TargetOverrides = Record<string, { lanes?: unknown } | undefined> | null

/** The RankTarget keys a schedule (or an event of its group) can hold: every window's and the baseline. */
function heldKeys(windows: unknown, defaultTargetKey: string | null): string[] {
  const keys = (Array.isArray(windows) ? windows : [])
    .map((w) => (w && typeof w === 'object' ? (w as { targetKey?: unknown }).targetKey : null))
    .filter((k): k is string => typeof k === 'string' && k.length > 0)
  return defaultTargetKey ? [...keys, defaultTargetKey] : keys
}

/**
 * 4e — the lanes Rank & Dayparting writes, per campaign an ENABLED `AdSchedule` governs. `null` reads every schedule.
 *
 * Top and Rest of Search on every one. Product Pages as well when any target the schedule can hold — in any window,
 * not only this hour's, plus an enabled event of its group that has not ended — writes it: a blend (its own `lanes`,
 * or the schedule's per-campaign override, where an empty list clears the blend) or a single Product Pages target.
 * A campaign absent from the map is governed by no enabled schedule.
 */
export async function contestedLanesByCampaign(campaignIds: string[] | null): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  const schedules = await prisma.adSchedule.findMany({
    where: { enabled: true, ...(campaignIds ? { campaignId: { in: campaignIds } } : {}) },
    select: { campaignId: true, windows: true, defaultTargetKey: true, targetOverrides: true, groupId: true },
  })
  if (!schedules.length) return out
  const groupIds = [...new Set(schedules.map((s) => s.groupId).filter((g): g is string => !!g))]
  const events = groupIds.length
    ? await prisma.rankScheduleEvent.findMany({
      where: { groupId: { in: groupIds }, enabled: true, endsAt: { gt: new Date() } },
      select: { groupId: true, windows: true, defaultTargetKey: true },
    })
    : []
  const keysOf = (s: (typeof schedules)[number]): string[] => [
    ...heldKeys(s.windows, s.defaultTargetKey),
    ...events.filter((e) => e.groupId === s.groupId).flatMap((e) => heldKeys(e.windows, e.defaultTargetKey)),
  ]
  const allKeys = [...new Set(schedules.flatMap(keysOf))]
  const targets = allKeys.length
    ? await prisma.rankTarget.findMany({ where: { key: { in: allKeys } }, select: { key: true, placement: true, lanes: true } })
    : []
  const byKey = new Map(targets.map((t) => [t.key, t]))
  for (const s of schedules) {
    const overrides = (s.targetOverrides ?? null) as TargetOverrides
    const writesProduct = keysOf(s).some((k) => {
      const t = byKey.get(k)
      if (!t) return false // a dangling key holds nothing
      const o = overrides?.[k]?.lanes
      const lanes = Array.isArray(o) ? o : t.lanes
      return Array.isArray(lanes) && lanes.length > 0 ? true : t.placement === PLACEMENT_PRODUCT
    })
    const prev = out.get(s.campaignId) ?? []
    out.set(s.campaignId, writesProduct || prev.includes(PLACEMENT_PRODUCT) ? [...ENGINE_CONTESTED_LANES, PLACEMENT_PRODUCT] : [...ENGINE_CONTESTED_LANES])
  }
  return out
}

/**
 * 4e — the sentence an automated placement write gives when it skips a lane the rank engine holds on this campaign.
 * PURE, so the words are testable without a database.
 */
export function contestedLaneSkipReason(placement: string): string {
  const why = placement === PLACEMENT_PRODUCT
    ? 'its hourly plan here is a blend, which sets every lane it does not name to 0'
    : 'it rewrites that lane every time it runs'
  return `Rank & Dayparting controls ${laneWord(placement)} on this campaign: ${why}, so this rule did not write it — `
    + `the change would be reverted within the hour. Set the rule to Manual to approve such changes yourself, `
    + `or remove this campaign from the rule.`
}

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
  /** 4e — the lanes the engine writes on those campaigns; Product Pages joins where a schedule holds a blend. */
  engineLanes: readonly string[] = ENGINE_CONTESTED_LANES,
): PlacementAutoVerdict {
  const contested = lanes.filter((l) => engineLanes.includes(l))
  if (contested.length === 0 || governed.length === 0) {
    return { blocked: false, message: '', governed, lanes: contested }
  }
  const laneWords = contested.map(laneWord).join(' and ')
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
      + (engineLanes.includes(PLACEMENT_PRODUCT)
        ? `Product Pages does not hold here either: the hourly plan on ${n === 1 ? 'that campaign' : 'at least one of them'} is a blend, which sets every lane it does not name to 0.`
        : `Product Pages is the one lane the rank engine does not touch, if you want a placement rule that holds here.`),
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
  // 4e — any managed lane may be contested now (Product Pages under a blend), so only a rule that writes none stops here.
  if (![...lanes].some((l) => (MANAGED_PLACEMENTS as readonly string[]).includes(l))) return none

  const picked = builderDraftCampaignIds(rule.actions, 'placement')
    ?? (Array.isArray((rule.actions as Array<Record<string, unknown>>)?.[0]?.campaignIds)
      ? ((rule.actions as Array<Record<string, unknown>>)[0].campaignIds as string[])
      : [])
  // 🔴 An EMPTY picker is not "no campaigns" — `campaignAllowed` treats an empty allowlist as no
  // restriction, so the rule reaches the whole account and therefore every governed campaign.
  const contestedBy = await contestedLanesByCampaign(picked.length ? picked : null)
  // 4e — a governed campaign counts only where the engine writes one of this rule's lanes.
  const hit = [...contestedBy].filter(([, engineLanes]) => [...lanes].some((l) => engineLanes.includes(l)))
  if (hit.length === 0) return none
  const campaigns = await prisma.campaign.findMany({ where: { id: { in: hit.map(([id]) => id) } }, select: { name: true } })
  return placementAutoVerdict([...lanes], campaigns.map((c) => c.name).sort(), [...new Set(hit.flatMap(([, l]) => l))])
}
