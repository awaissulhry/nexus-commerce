/**
 * CM-21 — the portfolios Nexus stores itself, as the portfolio pickers list them.
 *
 * `GET /advertising/portfolios` lists Amazon's live portfolios per connection and then adds the ones stored in
 * Nexus that the live list did not return: created here while writes were closed (`local-pf-…`, never on Amazon),
 * or synced earlier from a market whose live read failed or whose connection is off. Those stored rows were all
 * labelled with the asked market, or 'IT' when none was asked, and a market filter did not apply to them. So the
 * campaign pickers offered another market's portfolio, which Amazon refuses for this campaign.
 *
 * Here each stored row carries the market of its OWN profile, and a market filter keeps only that market's rows.
 * Pure, so it is tested without a server.
 */

export interface StoredPortfolio {
  externalPortfolioId: string
  name: string
  profileId: string
}

export interface PickerPortfolio {
  portfolioId: string
  name: string
  /** '' when the market of the portfolio's profile is not known. */
  marketplace: string
}

/** The market a stored portfolio belongs to: its profile's connection, else the market a `local-<MK>` profile names. */
export function storedPortfolioMarket(profileId: string, marketOfProfile: ReadonlyMap<string, string>): string | null {
  const known = marketOfProfile.get(profileId)
  if (known) return known
  // `POST /advertising/portfolios` stores `local-<market>` as the profile when the market had no connection.
  return profileId.startsWith('local-') ? profileId.slice('local-'.length) || null : null
}

/**
 * The stored portfolios to add to the picker list. `seen` holds the ids already listed (the live ones) and receives
 * the ones added. `fallbackMarket` names the market of a row whose profile is unknown (the sandbox fixture only).
 */
export function storedPortfoliosForPicker(
  rows: readonly StoredPortfolio[],
  opts: { seen: Set<string>; marketplace: string | null; marketOfProfile: ReadonlyMap<string, string>; fallbackMarket?: string | null },
): PickerPortfolio[] {
  const out: PickerPortfolio[] = []
  for (const row of rows) {
    if (opts.seen.has(row.externalPortfolioId)) continue
    const market = storedPortfolioMarket(row.profileId, opts.marketOfProfile) ?? opts.fallbackMarket ?? null
    if (opts.marketplace && market !== opts.marketplace) continue
    opts.seen.add(row.externalPortfolioId)
    out.push({ portfolioId: row.externalPortfolioId, name: row.name, marketplace: market ?? '' })
  }
  return out
}
