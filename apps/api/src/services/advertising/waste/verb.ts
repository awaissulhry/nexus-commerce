/**
 * Negative Targeting page (NREAD) — the verb of one row (PLAN §2, 5-neg-industry.md §3.2), pure. One rule, shown as the
 * row's verb; a verb that may not run here is HELD with its reason (the button stays, said why), never hidden.
 *
 *   our EXACT keyword         → Pause (kept paused). Never a negative of the same text in its own ad group: it blocks itself.
 *   our phrase / broad / auto → Pause when it wastes as a whole and none of its search terms sold; when some sold, the
 *                               verb is held ("its terms sell") and the wasting terms get their own negative rows.
 *   a product / category target → Pause.
 *   a shopper's ASIN term     → negative product target in the ad group.
 *   a shopper's search term   → negative exact, in the ad group; in the whole campaign when it served in 2+ ad groups of it
 *                               (the brain's rule, brain/negatives.ts).
 *   held (first that applies) protected term · our own keyword in this ad group (a negative would block it: L1) · a term
 *                               harvested in the last 30 days · a place younger than 14 days · a shared campaign with no
 *                               owner · (keywords) its search terms sell.
 *   a word (Words view)       → negative phrase, through the same list: words.ts names the keyword that holds the word and
 *                               the harvested term that holds it (`ownKeywordText`, `harvestedText`).
 */
import { HARVEST_QUIET_DAYS, PLACE_MIN_AGE_DAYS, termKeyOf, type Match, type RowKind, type Verb } from './pure.js'

export interface VerbFacts {
  kind: RowKind
  match: Match
  text: string
  /** TERM: the search term is an ASIN. */
  isAsinTerm?: boolean
  /** TERM: ad groups of this campaign the term served in over the window. */
  adGroupsInCampaign?: number
  /** A protected term (AdKeywordProtection) hits it: the protection's words. */
  protectedBy?: string | null
  /** TERM: the same text is our own keyword or target in this ad group (any match, paused ones too). */
  ownKeywordHere?: boolean
  /** Words view: our keyword that HOLDS the word there (a negative phrase of the word would block it); named in the reason. */
  ownKeywordText?: string | null
  /** Days since a harvest made this text a keyword (any of the product's); null: never harvested. */
  harvestedDaysAgo?: number | null
  /** Words view: the harvested term that holds the word (named in the reason). */
  harvestedText?: string | null
  /** Days since the ad group was created. */
  placeAgeDays?: number | null
  /** The campaign advertises several product families (or ads Nexus cannot tie): nobody owns its stops. */
  sharedCampaign?: boolean
  /** KEYWORD (phrase, broad, auto): its search terms that sold in the window. */
  termsSold?: number
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function verbFor(f: VerbFacts): Verb {
  const isTerm = f.kind === 'TERM'
  const action: Verb['action'] = !isTerm ? 'PAUSE' : f.isAsinTerm ? 'NEGATE_ASIN' : 'NEGATE_EXACT'
  const where: Verb['where'] = isTerm && !f.isAsinTerm && (f.adGroupsInCampaign ?? 0) >= 2 ? 'campaign' : 'adGroup'
  return { action, where, held: heldFor(f) }
}

function heldFor(f: VerbFacts): Verb['held'] {
  if (f.protectedBy) return { label: 'Protected', reason: `"${f.protectedBy}" is a protected term: no negative and no pause may stop it.` }
  if (f.kind === 'TERM' && f.ownKeywordHere) {
    if (f.ownKeywordText && termKeyOf(f.ownKeywordText) !== termKeyOf(f.text)) {
      return { label: 'Our keyword', reason: `Our keyword "${f.ownKeywordText}" holds "${f.text}": a negative phrase here would block it.` }
    }
    return { label: 'Our keyword', reason: `"${f.text}" is our own keyword in this ad group: a negative here would block it. Pause the keyword instead.` }
  }
  if (f.harvestedDaysAgo != null && f.harvestedDaysAgo < HARVEST_QUIET_DAYS) {
    return { label: 'Harvested lately', reason: `Harvest made "${f.harvestedText ?? f.text}" a keyword ${plural(Math.max(0, Math.floor(f.harvestedDaysAgo)), 'day')} ago: Harvest judges it until ${HARVEST_QUIET_DAYS} days have passed.` }
  }
  if (f.placeAgeDays != null && f.placeAgeDays < PLACE_MIN_AGE_DAYS) {
    return { label: 'New place', reason: `The ad group is ${plural(Math.max(0, Math.floor(f.placeAgeDays)), 'day')} old: nothing is stopped in a place younger than ${PLACE_MIN_AGE_DAYS} days.` }
  }
  if (f.sharedCampaign) return { label: 'Shared campaign', reason: 'The campaign advertises several products and no one owns its stops: nothing is stopped here alone.' }
  if (f.kind !== 'TERM' && f.match !== 'EXACT' && (f.termsSold ?? 0) > 0) {
    return { label: 'Its terms sell', reason: `${plural(f.termsSold!, 'search term')} under this keyword sold: negate its wasting terms instead of pausing it.` }
  }
  return null
}
