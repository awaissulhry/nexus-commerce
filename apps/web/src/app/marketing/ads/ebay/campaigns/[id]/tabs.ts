/**
 * ER1 — the strategy→capability matrix, THE single source for which tabs a
 * campaign shows (SPEC-campaign-detail §4). Absent capabilities are absent,
 * never disabled. Search Terms is Priority-only (SEARCH_QUERY report is
 * CPC-only — teardown §6 #10).
 */
export type Strategy = 'GEN' | 'PRI_MANUAL' | 'PRI_SMART' | 'OFF'

export function strategyOf(c: { fundingModel: string; targetingType: string | null; channels: string[] }): Strategy {
  if ((c.channels ?? []).includes('OFF_SITE')) return 'OFF'
  if (c.fundingModel === 'COST_PER_CLICK') return c.targetingType === 'SMART' ? 'PRI_SMART' : 'PRI_MANUAL'
  return 'GEN'
}

export const STRATEGY_BADGE: Record<Strategy, string> = { GEN: 'GEN', PRI_MANUAL: 'PRI', PRI_SMART: 'PRI', OFF: 'OFF' }
export const STRATEGY_LABEL: Record<Strategy, string> = { GEN: 'General · CPS', PRI_MANUAL: 'Priority · manual', PRI_SMART: 'Priority · smart', OFF: 'Offsite' }

export type TabKey = 'details' | 'ads' | 'ad-groups' | 'keywords' | 'negatives' | 'search-terms' | 'automation' | 'activity'
export interface TabDef { key: TabKey; label: string }

const T = (key: TabKey, label: string): TabDef => ({ key, label })

export const TABS_BY_STRATEGY: Record<Strategy, TabDef[]> = {
  GEN: [T('details', 'Details'), T('ads', 'Ads'), T('automation', 'Automation'), T('activity', 'Activity')],
  PRI_MANUAL: [T('details', 'Details'), T('ad-groups', 'Ad Groups'), T('keywords', 'Keywords'), T('negatives', 'Campaign Negative Keywords'), T('search-terms', 'Search Terms'), T('automation', 'Automation'), T('activity', 'Activity')],
  PRI_SMART: [T('details', 'Details'), T('ads', 'Ads'), T('search-terms', 'Search Terms'), T('automation', 'Automation'), T('activity', 'Activity')],
  OFF: [T('details', 'Details'), T('ads', 'Ads'), T('automation', 'Automation'), T('activity', 'Activity')],
}
