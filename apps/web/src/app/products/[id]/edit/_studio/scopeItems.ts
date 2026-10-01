import { readinessMeta } from '@/design-system/grid/renderers/readiness'
import type { ScopeBarItem } from '@/design-system/patterns/ScopeBar'
import { draftStartSentence, notListedTitle } from './draftListing'
import { connectionScopePolicy } from './presence/connection'
import { channelLabel, languageLabel } from './scopes'
import { sharedReadiness } from './sharedReadiness'
import { MASTER_SCOPE, type ChannelOption, type MarketplaceLite, type ScopeReadiness, type ScopeReadinessQuery, type StudioSaveState } from './types'
import type { DestinationState } from './useWorkspaceDestination'

/**
 * A-55 (SR1) — the scope bar's items: one per scope, each with the readiness word it can PROVE.
 *
 * Moved out of `StudioBar.tsx` so the rules are testable in node, as `sharedReadiness.ts` was. It said "Not set up"
 * for almost every channel, for three reasons, and each rule below closes one of them. "Not set up" (`absent`) now
 * comes from exactly two places: a stamped participation refusal, or the server's own `absent`.
 */

type Participation = Pick<MarketplaceLite, 'isParticipating' | 'participationStatus' | 'participationCheckedAt'>

/**
 * Participation is an Amazon SP-API MEASUREMENT (`amazon-participations.service.ts`). The column defaults to `false`
 * (`schema.prisma`), so `false` is a fact only once the refresher has stamped it with its check time. eBay, Shopify,
 * Etsy and WooCommerce rows are never stamped. Production 2026-09-24: all 28 such rows in both businesses read
 * `false` with no check time — and every one of those channels read "Not set up" while the server held a real verdict.
 * `UNKNOWN` (SP-API returned the market without a participation flag) is not a measured "no" either.
 */
export function measuredNonParticipation(row?: Participation): boolean {
  return row?.isParticipating === false && row.participationCheckedAt != null && row.participationStatus !== 'UNKNOWN'
}

/** The Market list's suffix, by the same rule — never "(not participating)" on a default nobody measured. */
export const participationSuffix = (row?: Participation): string => (measuredNonParticipation(row) ? ' (not participating)' : '')

/**
 * A-55 arm B (Owner Q1 (a)) — the verdict a channel·market has in its OWN first language, for when the chosen language
 * is not one it sells. The Shared product reads in Italian. Amazon·DE sells German only, so its Italian answer is
 * `notComputed`, and it can never be computed. The server already sends the German verdict in `languages`, so it is
 * read verbatim from there. No mapping, no number of our own.
 *
 * `undefined` when the chosen language IS sold there: the server's answer is then the answer, even if it is
 * `notComputed`. Also `undefined` when the market's language has no verdict either: `notComputed` is then the truth.
 */
export function ownLanguageVerdict(value: ScopeReadiness, sold: readonly string[], locale: string | null) {
  if (!locale || !sold.length || sold.includes(locale)) return undefined
  return value.languages?.find(entry => entry.language === sold[0])
}

export interface ScopeItemsInput {
  channels: ChannelOption[]
  market: string | null
  marketplaces: MarketplaceLite[]
  readiness: ScopeReadinessQuery
  scope: string
  save: StudioSaveState
  locale: string | null
  discoveryFailed: boolean
  destination: DestinationState['status']
  /**
   * The open channel scope has no listing on this market (its destination resolved with none). Step 4 (D2): the chip
   * then says what the sheet's notice says — "Not listed yet" — instead of an unmeasured "Not computed".
   */
  unlisted?: boolean
}

/** The chip on a channel · market with no listing and no verdict: the row pill's words, the sheet notice's short form. */
export const NOT_LISTED_SUMMARY = readinessMeta('unlisted', 'row').label

export function scopeItems(i: ScopeItemsInput): ScopeBarItem[] {
  const { market, marketplaces, readiness, scope, save, locale } = i
  const scored = (id: string): ScopeBarItem['readiness'] => {
    const participation = marketplaces.find(m => m.channel === id && m.code === market)
    if (measuredNonParticipation(participation)) return { pct: null, state: 'absent', note: `${channelLabel(id)} · ${market} is not participating (checked ${participation?.participationCheckedAt?.slice(0, 10)}).` }
    if (id === scope && save.kind === 'error') return { pct: null, state: 'blocked', note: save.message }
    if (id === scope && save.kind === 'saving') return 'loading'
    if (readiness.status === 'loading') return 'loading'
    // Step 4 (D2) — no listing here and no verdict: ONE wording with the sheet's notice. A real verdict (Blocked,
    // Warnings…) still wins: the rules can be judged before the first listing exists.
    const notListed = id === scope && id !== MASTER_SCOPE && i.unlisted && market
      ? { pct: null, state: 'notComputed' as const, summary: NOT_LISTED_SUMMARY, note: `${notListedTitle(id, market)}. ${draftStartSentence(id, 'edit')}` } : null
    if (readiness.status === 'ready') {
      const value = readiness.byScope[id]
      // R-LX-9 — a scope the response did not score is unmeasured, not empty.
      if (!value) return notListed ?? { pct: null, state: 'notComputed', note: `Nexus has not checked ${id === MASTER_SCOPE ? 'the Shared product' : `${channelLabel(id)} · ${market}`} yet.` }
      if (notListed && value.state === 'notComputed' && value.pct == null) return notListed
      const others = (shown: string | null) => value.languages?.filter(entry => entry.language !== shown).map(entry => `${entry.language.toUpperCase()}: ${readinessMeta(entry.state, 'scope').label} ${entry.pct === null ? '—' : `${entry.pct}%`}`) ?? []
      const own = id === MASTER_SCOPE ? undefined : ownLanguageVerdict(value, participation?.languages ?? [], locale)
      if (own) return { pct: own.pct, state: own.state, note: [`Shown in ${languageLabel(own.language)}: ${languageLabel(locale ?? '')} is not sold on ${channelLabel(id)} · ${market}.`, ...others(own.language)].join(' · ') }
      return { ...value, note: [`${locale?.toUpperCase() ?? 'Selected language'}: ${value.note ?? ''}`, ...others(locale)].join(' · ') }
    }
    // A-55 arm C — a channel scope asks for readiness only once its destination (account/listing) is resolved. Until
    // then the query answers "No market selected." That is a wait, not a verdict (~0.5–1 s measured in production).
    if (readiness.status === 'unavailable' && scope !== MASTER_SCOPE && i.destination === 'loading') return 'loading'
    // A failed or unavailable read measured nothing. Its reason is the hover, verbatim.
    return { pct: null, state: 'notComputed', note: readiness.status === 'unavailable' ? readiness.reason : readiness.message }
  }
  const channelItems: ScopeBarItem[] = i.channels.map(c => {
    const policy = connectionScopePolicy(c.health, c.label, i.discoveryFailed)
    // TOOLBAR REBUILD (2026-09-27) — on Shared the market is not on the bar, yet each channel's verdict here is for ONE
    // market; the item names it ("Amazon · BE") so the number is never read as the channel's everywhere.
    const label = scope === MASTER_SCOPE && market && c.markets.includes(market) ? `${c.label} · ${market}` : c.label
    return { id: c.id, label, disabled: policy.disabled, disabledReason: policy.disabledReason ?? undefined,
      readiness: policy.disabled ? undefined : market && c.markets.includes(market) ? scored(c.id) : undefined }
  })
  return [{ id: MASTER_SCOPE, label: 'Shared product', readiness: sharedReadiness(scored(MASTER_SCOPE), channelItems, scope === MASTER_SCOPE && save.kind === 'error') }, ...channelItems]
}
