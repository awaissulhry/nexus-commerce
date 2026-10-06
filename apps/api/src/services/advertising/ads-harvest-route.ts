/**
 * ADS PLAYBOOK PB-6b — the intent router: where a harvested search term lands when one source feeds several Exact (or
 * Phrase) campaigns of ONE product — its Brand, its Competitor or its Category one — chosen by the term's own words.
 * Pure.
 *
 *   BRAND       the term holds one of the brand terms as whole words (the product's name token, its brand terms)
 *   COMPETITOR  else, it holds one of the competitor terms as whole words
 *   CATEGORY    else — classifyTarget's conservative default (ads-core/ads-blueprint.ts)
 *
 * Word-bounded containment is the blueprint's own (`hasToken`), never a copy. The lists are compiled into the rule (a
 * snapshot, ads-playbook/harvest-rule.ts): the harvest never reads a playbook row. An ASIN is a product: it never goes
 * through the router. A term that already has a home in the product's campaigns stays there whatever the router would
 * pick (L2, ads-harvest.service.ts): the router only places a term that has no home yet. Its three ad groups are the
 * product's own; it never looks at another product's campaigns (the Owner's rule 3).
 */
import { hasToken } from '../ads-core/ads-blueprint.js'

export type Intent = 'BRAND' | 'COMPETITOR' | 'CATEGORY'
/** A destination that picks one of three ad groups (AdGroup.ids) by the term's words. */
export interface IntentRouter { router: 'intent'; BRAND: string; COMPETITOR: string; CATEGORY: string; brand: string[]; competitor: string[] }
/** Where a graduation of one match type lands: one ad group (AdGroup.id), or the router. */
export type HarvestDestination = string | IntentRouter

const INTENTS: readonly Intent[] = ['BRAND', 'COMPETITOR', 'CATEGORY']
const isAsin = (term: string) => /^b0[a-z0-9]{8}$/i.test(term.trim())
/** Case and runs of spaces folded, so a brand term typed with two spaces still matches. */
const fold = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

/** A stored destination that is a router: the three ad groups named, the lists lists of words. */
export function isIntentRouter(d: unknown): d is IntentRouter {
  if (!d || typeof d !== 'object') return false
  const r = d as Record<string, unknown>
  return r.router === 'intent' && INTENTS.every((k) => typeof r[k] === 'string' && !!r[k])
    && (r.brand === undefined || Array.isArray(r.brand)) && (r.competitor === undefined || Array.isArray(r.competitor))
}

/** Brand (any brand term as words) beats competitor; else category — classifyTarget's conservative default. */
export function routeIntent(term: string, lists: { brand?: readonly unknown[]; competitor?: readonly unknown[] }): Intent {
  const t = fold(term)
  const holds = (list: readonly unknown[] | undefined) => (list ?? []).some((w) => typeof w === 'string' && !!fold(w) && hasToken(t, fold(w)))
  if (holds(lists.brand)) return 'BRAND'
  if (holds(lists.competitor)) return 'COMPETITOR'
  return 'CATEGORY'
}

/** The ad group a term lands in: a plain id, or the router's pick; an ASIN never goes through the router (null). */
export function resolveDestination(term: string, dest: HarvestDestination | null | undefined): { adGroupId: string; intent?: Intent } | null {
  if (typeof dest === 'string') return dest ? { adGroupId: dest } : null
  if (!isIntentRouter(dest) || isAsin(term)) return null
  const intent = routeIntent(term, dest)
  return { adGroupId: dest[intent], intent }
}

/** Every ad group a destination may land in (the router's three), for the reads that must see them all. */
export function destinationAdGroups(dest: unknown): string[] {
  if (typeof dest === 'string') return dest ? [dest] : []
  return isIntentRouter(dest) ? [...new Set(INTENTS.map((k) => dest[k]))] : []
}

/**
 * The SP Super Wizard's router, for a source whose own theme cannot be told (its Auto campaign) when several keyword
 * campaigns take one match type: each host's theme known and no theme twice, a Category host at least. A theme with no
 * host hands its terms to the Category one (the playbook's own fallback for a slot left out, ads-playbook/resolve.ts).
 * Null when the hosts cannot be told apart — the graduation is then refused by name, as before.
 */
export function themedRouter(
  hosts: ReadonlyArray<{ adGroupId: string; theme: string | null }>,
  lists: { brand: readonly string[]; competitor: readonly string[] },
): IntentRouter | null {
  if (hosts.length < 2 || hosts.some((h) => !h.theme)) return null
  const byTheme = new Map<string, string[]>()
  for (const h of hosts) byTheme.set(h.theme!, [...(byTheme.get(h.theme!) ?? []), h.adGroupId])
  if ([...byTheme.values()].some((ids) => ids.length > 1)) return null
  const category = byTheme.get('category')?.[0]
  if (!category) return null
  const fit = (list: readonly string[]) => [...new Map(list.map((w) => [fold(w), w.trim()])).entries()].filter(([k]) => !!k).map(([, w]) => w)
  return {
    router: 'intent',
    BRAND: byTheme.get('brand')?.[0] ?? category,
    COMPETITOR: byTheme.get('competitor')?.[0] ?? category,
    CATEGORY: category,
    brand: fit(lists.brand),
    competitor: fit(lists.competitor),
  }
}
