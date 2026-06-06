/**
 * RD.6 — self-competition detector.
 *
 * When a product family has several campaigns, two of OUR OWN campaigns can bid
 * each other up: they share a keyword (EXACT/PHRASE) or are both AUTO over the same
 * family ASINs. That wastes spend outbidding ourselves. The Rank Director demotes
 * the lower-efficiency campaign in each contest to the plan baseline, keeping the
 * single best campaign on each contested term. Pure + unit-tested; the job loads the
 * targeting/efficiency rows and feeds them in.
 *
 * A campaign is demoted only if it LOSES a contest AND WINS none — so a campaign
 * that's the champion of its own keyword is never demoted just for a secondary
 * overlap.
 */

export interface CampaignTargeting {
  campaignId: string
  keywords: string[] // normalised "text|EXACT" / "text|PHRASE" (positive keywords only)
  isAuto: boolean
  acos: number | null // spend/sales; lower = better; null = unproven
  spendCents: number
}
export interface SelfCompetitionConflict { on: string; campaigns: string[]; demoted: string[] }
export interface SelfCompetitionResult { demoted: Set<string>; conflicts: SelfCompetitionConflict[] }

// Lower ACOS wins; unknown ACOS ranks worst; tie-break = higher spend (more proven).
function rankKey(c: CampaignTargeting): [number, number] {
  return [c.acos ?? Number.POSITIVE_INFINITY, -c.spendCents]
}

export function detectSelfCompetition(campaigns: CampaignTargeting[]): SelfCompetitionResult {
  const winners = new Set<string>()
  const losers = new Set<string>()
  const conflicts: SelfCompetitionConflict[] = []

  const resolve = (group: CampaignTargeting[], on: string): void => {
    const uniq = [...new Map(group.map((c) => [c.campaignId, c])).values()]
    if (uniq.length < 2) return
    const sorted = uniq.slice().sort((a, b) => { const ra = rankKey(a), rb = rankKey(b); return ra[0] - rb[0] || ra[1] - rb[1] })
    winners.add(sorted[0].campaignId)
    const loserIds = sorted.slice(1).map((c) => c.campaignId)
    for (const id of loserIds) losers.add(id)
    conflicts.push({ on, campaigns: uniq.map((c) => c.campaignId), demoted: loserIds })
  }

  // Keyword contests (EXACT/PHRASE overlap across family campaigns).
  const byKw = new Map<string, CampaignTargeting[]>()
  for (const c of campaigns) for (const kw of new Set(c.keywords)) { const arr = byKw.get(kw) ?? []; arr.push(c); byKw.set(kw, arr) }
  for (const [kw, group] of byKw) resolve(group, `kw:${kw}`)

  // Auto contest (every AUTO campaign in the family competes on the same ASINs).
  resolve(campaigns.filter((c) => c.isAuto), 'AUTO')

  const demoted = new Set([...losers].filter((id) => !winners.has(id)))
  return { demoted, conflicts }
}
