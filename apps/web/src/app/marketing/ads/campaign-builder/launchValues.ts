/**
 * CC-29 — no silent substitutions at launch.
 *
 * The builders sent `Number(bid) || 0.75` and `Number(budget) || 10`: a bid or budget the operator had cleared (or
 * typed as 0) was replaced by a number nobody showed him. The fields now carry their starting value visibly, and a
 * launch with a missing or zero value is refused with the campaigns named, instead of substituting one.
 */

/** The number in a money field, or null when it is blank, not a number, or not above 0. */
export function positiveAmount(raw: string | number | null | undefined): number | null {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim().replace(',', '.'))
  return Number.isFinite(n) && n > 0 && String(raw ?? '').trim() !== '' ? n : null
}

/** Names the campaigns whose default bid or daily budget is missing; `null` when every one has both. */
export function missingBidOrBudget(rows: ReadonlyArray<{ name: string; bid: string | number; budget: string | number }>): string | null {
  const bad = rows.filter((r) => positiveAmount(r.bid) == null || positiveAmount(r.budget) == null).map((r) => r.name || 'a campaign')
  if (!bad.length) return null
  const shown = bad.length > 3 ? `${bad.slice(0, 3).join(', ')} and ${bad.length - 3} more` : bad.join(', ')
  return `Enter a default bid and a daily budget above 0 for ${shown}. Nexus no longer fills a blank one in for you.`
}

/**
 * CC-15 — the campaigns a launch created, from its answer (`created: [{ campaignId }]`). The SP Super Wizard read
 * `campaignIds` / `campaigns[].id`, which the answer never had, so every "AI Control" plan was created with no campaigns.
 */
export function createdCampaignIds(answer: unknown): string[] {
  const created = (answer as { created?: unknown } | null)?.created
  if (!Array.isArray(created)) return []
  return created.map((c) => (c as { campaignId?: unknown } | null)?.campaignId).filter((id): id is string => typeof id === 'string' && id.length > 0)
}

/**
 * CC-9 — what a starting bid is, said plainly. Amazon has no bid recommendation for an ad group that does not exist yet
 * (Nexus calls it only for existing ad groups), so a builder's starting bid is either the account's own CPCs in the
 * launch market (`accountMedianCpcCents` measured) or a default. It was labelled "Suggested" either way, with a ±27 %
 * range nobody computed.
 */
export function startingBidSource(measuredMedianCpcCents: number | null | undefined, market: string): string {
  return typeof measuredMedianCpcCents === 'number' && measuredMedianCpcCents > 0 ? `From your ${market} CPCs` : 'Default'
}
