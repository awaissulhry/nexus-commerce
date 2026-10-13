/**
 * Google Ads step 1b — which search terms are the business's brand (PLAN-1B M7, plan-1b-backend §5).
 *
 * Brand = the business's protected terms that apply to every market: AdKeywordProtection WHITELIST rows with no
 * marketplace, edited in Ads › Rules & Automation › Control Room › Limits › Protected terms. Matched by the same
 * classifier the Keyword Tracker and share of voice use (`classifyBranded`): never a second definition of "brand".
 * No such term → every answer is null (unknown), never "not brand". Nothing about brand is stored for Google.
 * Only this file reads AdKeywordProtection for Google Ads.
 */
import prisma from '../../../db.js'
import { classifyBranded, normTerm, type ProtectionRule } from '../../advertising/keyword-watchlist.service.js'
import type { GoogleBrandTerms } from './read-types.js'

/** Where a person changes the protected terms (a bare path; the web adds the business prefix). */
export const BRAND_TERMS_HREF = '/marketing/ads/rules-automation/control-room?tab=limits&view=terms'
/** The market name `classifyBranded` is asked with. Only rules for every market (no marketplace) are ever passed. */
export const GOOGLE_BRAND_MARKET = 'GOOGLE'

export interface GoogleBrand {
  brandTerms: GoogleBrandTerms
  /** true / false by the protected terms; null when the business has none (unknown, never "not brand"). */
  isBrand(term: string): boolean | null
}

/** The brand of the rules given (pure). Rules scoped to one marketplace are left out. */
export function googleBrandOf(rules: ProtectionRule[]): GoogleBrand {
  const everywhere = rules.filter((rule) => !rule.marketplace && normTerm(rule.term))
  const terms = [...new Set(everywhere.map((rule) => normTerm(rule.term)))].sort()
  return {
    brandTerms: { terms, source: 'protected_terms', editHref: BRAND_TERMS_HREF },
    isBrand: (term) => (everywhere.length ? classifyBranded(term, GOOGLE_BRAND_MARKET, everywhere) : null),
  }
}

/** The business's brand for Google Ads, from its protected terms. */
export async function googleBrand(): Promise<GoogleBrand> {
  const rules = await prisma.adKeywordProtection.findMany({
    where: { mode: 'WHITELIST', marketplace: null },
    select: { term: true, matchType: true, isPrefix: true, marketplace: true },
  })
  return googleBrandOf(rules)
}
