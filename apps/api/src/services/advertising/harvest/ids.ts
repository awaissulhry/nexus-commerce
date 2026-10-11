/**
 * HARVEST ENGINE — ids and refs. A candidate is one term of one product in one market, over EVERY source ad group of the
 * product where it ran: `${market}|${productId}|${term}` (the family root; the normalised term, an ASIN in lower case) —
 * the same key as its harvest record (AdsBrainHarvest product × market × term).
 */
import { strategyMarket } from '../ads-strategy/bids.js'
import { termKey } from '../brain/terms.js'

export interface Ref { id: string; name: string; href?: string }

const ASIN = /^b0[a-z0-9]{8}$/i

/** The ledger's form of a term: an ASIN in lower case, else the normalised words. */
export const normTerm = (raw: string): string => {
  const t = String(raw ?? '').trim()
  return ASIN.test(t) ? t.toLowerCase() : termKey(t)
}
export const isAsinTerm = (t: string) => ASIN.test(t.trim())

export const candidateIdOf = (market: string, productId: string, term: string) => `${market}|${productId}|${term}`

/** The parts of a candidate id, or null when it is not one. */
export function parseCandidateId(id: string): { market: string; productId: string; term: string } | null {
  const raw = String(id ?? '')
  const a = raw.indexOf('|')
  const b = a >= 0 ? raw.indexOf('|', a + 1) : -1
  if (a <= 0 || b <= a + 1 || b === raw.length - 1) return null
  const market = strategyMarket(raw.slice(0, a))
  const productId = raw.slice(a + 1, b).trim()
  const term = normTerm(raw.slice(b + 1))
  if (!market || !productId || !term) return null
  return { market, productId, term }
}

export const portfolioHref = (externalId: string) => `/marketing/ads/portfolios/${encodeURIComponent(externalId)}`
export const campaignHref = (id: string) => `/marketing/ads/campaigns/${encodeURIComponent(id)}`
export const adGroupHref = (campaignId: string, adGroupId: string) => `${campaignHref(campaignId)}/ad-groups/${encodeURIComponent(adGroupId)}`
export const productHref = (id: string) => `/products/${encodeURIComponent(id)}`

export const campaignRef = (id: string, name: string | null | undefined): Ref => ({ id, name: name ?? id, href: campaignHref(id) })
export const adGroupRef = (id: string, name: string | null | undefined, campaignId: string | null | undefined): Ref => ({ id, name: name ?? id, ...(campaignId ? { href: adGroupHref(campaignId, id) } : {}) })
export const portfolioRef = (externalId: string, name: string | null | undefined): Ref => ({ id: externalId, name: name ?? externalId, href: portfolioHref(externalId) })
export const productRef = (id: string, name: string | null | undefined): Ref => ({ id, name: name ?? id, href: productHref(id) })
