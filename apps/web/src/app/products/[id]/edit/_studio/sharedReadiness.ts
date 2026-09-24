import { readinessMeta } from '@/design-system/grid/renderers/readiness'
import { worstScopeState, type ScopeBarItem } from '@/design-system/patterns/ScopeBar'

/**
 * R-53 — the Shared product carries only its own few required fields (R-10), so its own percentage
 * says nothing about whether anything can publish. It shows no number: "See each channel", with the
 * dot in the WORST channel's tone and that channel named on hover. A save error on Shared still wins.
 */
export function sharedReadiness(own: ScopeBarItem['readiness'], channels: readonly ScopeBarItem[], saveFailed: boolean): ScopeBarItem['readiness'] {
  if (own === 'loading') return 'loading'
  if (saveFailed && own) return own
  const scoredChannels = channels.flatMap(item => item.readiness && item.readiness !== 'loading' ? [{ label: item.label, state: item.readiness.state }] : [])
  const worst = worstScopeState(scoredChannels.map(c => c.state))
  const worstLabel = worst ? scoredChannels.find(c => c.state === worst)?.label : undefined
  return {
    pct: null,
    state: worst ?? 'notComputed',
    summary: 'See each channel',
    note: [
      worst && worstLabel ? `Worst channel: ${worstLabel} — ${readinessMeta(worst, 'scope').label}.` : 'No channel has a readiness result for this market yet.',
      own ? `Shared's own fields: ${readinessMeta(own.state, 'scope').label}.` : null,
      'Each channel decides whether it can publish.',
    ].filter(Boolean).join(' '),
  }
}
