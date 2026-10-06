/**
 * AM-33 — the AMC page's second reason ("there is nothing to overlap"), computed from the campaigns as they are now.
 *
 * It was a sentence with fixed numbers in it: a count of Sponsored Brands and Display campaigns and "all paused", as
 * measured on one day in August 2026 and never read again, shown as a current fact. Now it is counted from the
 * campaign list each time the page opens, and says when nothing could be read. Archived campaigns are not counted,
 * as the Ad Manager does not show them by default.
 */

export interface CampaignTypeRow { adProduct?: string | null; type?: string | null; status?: string | null }

export interface TypeCount { total: number; enabled: number }
export interface AdTypeMix { brands: TypeCount; display: TypeCount; tv: TypeCount }

type Kind = 'brands' | 'display' | 'tv' | 'products'

/** Which ad type a campaign is: `adProduct` (Amazon's v1 name) first, the legacy `type` enum second. */
export function adTypeOf(c: CampaignTypeRow): Kind {
  const v = `${c.adProduct ?? ''} ${c.type ?? ''}`.toUpperCase()
  if (v.includes('BRAND') || /\bSB\b/.test(v)) return 'brands'
  if (v.includes('DISPLAY') || /\bSD\b/.test(v)) return 'display'
  if (v.includes('TELEVISION') || /\bTV\b/.test(v)) return 'tv'
  return 'products'
}

export function adTypeMix(rows: CampaignTypeRow[]): AdTypeMix {
  const mix: AdTypeMix = { brands: { total: 0, enabled: 0 }, display: { total: 0, enabled: 0 }, tv: { total: 0, enabled: 0 } }
  for (const c of rows) {
    const status = (c.status ?? '').toUpperCase()
    if (status === 'ARCHIVED') continue
    const kind = adTypeOf(c)
    if (kind === 'products') continue
    mix[kind].total++
    if (status === 'ENABLED') mix[kind].enabled++
  }
  return mix
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * The paragraph, in plain words: how many Sponsored Brands / Display / TV campaigns there are, whether any is enabled,
 * and what that means for AMC. `cappedAt` = the list stopped at that many campaigns, so the counts may be short.
 */
export function adTypeMixSentence(mix: AdTypeMix, cappedAt?: number): { facts: string; meaning: string } {
  const { brands, display, tv } = mix
  const sbsd = brands.total + display.total
  const others = sbsd + tv.total
  const running = brands.enabled + display.enabled + tv.enabled
  const tvPart = tv.total === 0 ? 'no Sponsored TV' : plural(tv.total, 'Sponsored TV campaign', 'Sponsored TV campaigns')
  const state = others === 1
    ? (running ? 'it is enabled' : 'it is paused')
    : running === 0 ? `all ${others} are paused` : `${running} of the ${others} ${running === 1 ? 'is' : 'are'} enabled`
  let facts: string
  if (others === 0) facts = 'This account has no Sponsored Brands, Sponsored Display or Sponsored TV campaigns.'
  else if (sbsd === 0) facts = `This account has no Sponsored Brands or Sponsored Display campaigns, and ${tvPart}; ${state}.`
  else facts = `This account has ${brands.total} Sponsored Brands and ${display.total} Sponsored Display ${sbsd === 1 ? 'campaign' : 'campaigns'}, and ${tvPart}; ${state}.`
  if (cappedAt) facts += ` Counted over the first ${cappedAt} campaigns only.`
  const meaning = running === 0
    ? 'An instance provisioned today would draw a diagram of one circle.'
    : `With ${plural(running, 'campaign', 'campaigns')} beyond Sponsored Products enabled, an instance would have more than one ad type to compare, once ${running === 1 ? 'it has' : 'they have'} run long enough to attribute.`
  return { facts, meaning }
}
