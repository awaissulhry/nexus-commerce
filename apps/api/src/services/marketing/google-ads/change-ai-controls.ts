/**
 * Google Ads (2026-10-16, programme 2 G14b) — what Performance Max and Search (AI Max) share for the text and pages Google
 * picks on its own: text guidelines (Campaign.TextGuidelines) and URL exclusions (negative WEBPAGE campaign criteria of one
 * URL condition). Used by change-pmax.ts / build-pmax.ts (Performance Max) and change-search-ai.ts (Search): one place,
 * so both read and write them alike. What was checked in Google's v25 reference is in change-pmax.ts's and
 * change-search-ai.ts's headers.
 */
import { plural } from './change-draft.js'
import type { PmaxCampaignLive } from './live-pmax.js'

export interface UrlExclusion { contains?: string; equals?: string }

/** Text guidelines' limits (Campaign.TextGuidelines, v25). */
export const TEXT_GUIDELINES_LIMITS = { terms: 25, termLength: 30, restrictions: 40, restrictionLength: 300 } as const
/** Text guidelines as a person names them: each list WHOLE (what it should be); a list left out stays as it is. */
export interface TextGuidelinesAsk { termExclusions?: string[]; messagingRestrictions?: string[] }

/** The lists as Google takes them (trimmed, each once without case), or the problems (Google's limits). */
export function textGuidelinesOfAsk(ask: TextGuidelinesAsk, where: string, problems: string[]): TextGuidelinesAsk {
  const out: TextGuidelinesAsk = {}
  const clean = (list: string[], max: number, length: number, word: string) => {
    const seen = new Set<string>()
    const kept: string[] = []
    for (const raw of list) {
      const t = raw.trim().replace(/\s+/g, ' ')
      if (!t) { problems.push(`${where}: a ${word} is empty`); continue }
      if (t.length > length) problems.push(`${where}: the ${word} "${t.slice(0, 40)}…" has ${t.length} characters (Google allows ${length})`)
      if (seen.has(t.toLowerCase())) continue
      seen.add(t.toLowerCase())
      kept.push(t)
    }
    if (kept.length > max) problems.push(`${where}: ${plural(kept.length, word)} (Google takes at most ${max})`)
    return kept
  }
  if (ask.termExclusions) out.termExclusions = clean(ask.termExclusions, TEXT_GUIDELINES_LIMITS.terms, TEXT_GUIDELINES_LIMITS.termLength, 'term exclusion')
  if (ask.messagingRestrictions) out.messagingRestrictions = clean(ask.messagingRestrictions, TEXT_GUIDELINES_LIMITS.restrictions, TEXT_GUIDELINES_LIMITS.restrictionLength, 'messaging restriction')
  return out
}
/** Google's JSON for text guidelines (only the lists given). */
export const textGuidelinesBody = (g: TextGuidelinesAsk): Record<string, unknown> => ({
  ...(g.termExclusions ? { termExclusions: g.termExclusions } : {}),
  ...(g.messagingRestrictions ? { messagingRestrictions: g.messagingRestrictions.map((t) => ({ restrictionText: t, restrictionType: 'RESTRICTION_BASED_EXCLUSION' })) } : {}),
})
export const urlExclusionKey = (u: UrlExclusion) => (u.contains !== undefined ? `contains:${u.contains.trim()}` : `equals:${(u.equals ?? '').trim()}`)
export const urlExclusionOfKey = (key: string): UrlExclusion => (key.startsWith('contains:') ? { contains: key.slice(9) } : { equals: key.slice(7) })

/** The URL exclusions a campaign holds (negative WEBPAGE criteria of one URL condition), by key. */
export function urlExclusionsOf(c: Pick<PmaxCampaignLive, 'criteria'>): Array<{ key: string; criterionId: string }> {
  const out: Array<{ key: string; criterionId: string }> = []
  for (const k of c.criteria) {
    if (k.type !== 'WEBPAGE' || !k.negative || !k.webpage || k.webpage.conditions.length !== 1) continue
    const w = k.webpage.conditions[0]
    if (w.operand !== 'URL' || !w.argument) continue
    out.push({ key: urlExclusionKey(w.operator === 'EQUALS' ? { equals: w.argument } : { contains: w.argument }), criterionId: k.criterionId })
  }
  return out
}
