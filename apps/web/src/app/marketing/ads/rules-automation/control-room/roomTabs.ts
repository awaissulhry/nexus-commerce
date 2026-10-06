/**
 * CR rebuild 1 — the Control Room's four tabs, and the old tab names that still reach them.
 *
 * Owner 2026-10-06 (layout B): one top band, then four tabs that each answer one question — who may change the ads,
 * inside which limits, on which campaigns, and what they did. The six old tabs (Today · Strategy · Foresight · Levers ·
 * Guardrails · Activity) are gone as tabs, but their names live on in links the API sends (ads-today-board.service.ts,
 * approval-target.ts) and in bookmarks, so each still opens the place its content moved to. Pure: tests drive it.
 */

export type RoomTab = 'who' | 'limits' | 'campaigns' | 'history'
/** History shows what happened, or what is planned for the next 24 hours. */
export type HistoryView = 'done' | 'next'

export const ROOM_PATH = '/marketing/ads/rules-automation/control-room'

export const ROOM_TABS: readonly { id: RoomTab; label: string }[] = [
  { id: 'who', label: 'Who acts' },
  { id: 'limits', label: 'Limits' },
  { id: 'campaigns', label: 'Campaigns' },
  { id: 'history', label: 'History' },
]

/** Old and new `?tab=` names → the tab (and History view) that holds that content now. */
const FROM_TAB: Record<string, { tab: RoomTab; view?: HistoryView }> = {
  who: { tab: 'who' },
  limits: { tab: 'limits' },
  campaigns: { tab: 'campaigns' },
  history: { tab: 'history' },
  // The six old tabs.
  today: { tab: 'who' }, // Today's checks are the Problems and Waiting tiles above every tab now.
  levers: { tab: 'who' },
  strategy: { tab: 'limits' },
  guardrails: { tab: 'campaigns' },
  activity: { tab: 'history', view: 'done' },
  foresight: { tab: 'history', view: 'next' },
}

/** The tab and History view a URL asks for. Unknown or missing names open Who acts. */
export function readTab(tab: string | null, view: string | null): { tab: RoomTab; view: HistoryView } {
  const hit = (tab && Object.prototype.hasOwnProperty.call(FROM_TAB, tab) ? FROM_TAB[tab] : undefined) ?? { tab: 'who' as const }
  return { tab: hit.tab, view: hit.view ?? (view === 'next' ? 'next' : 'done') }
}

/** The link to a tab. History and Limits carry their view, and only when it is not the first one. */
export function tabHref(tab: RoomTab, view?: HistoryView | LimitsView): string {
  const carried = tab === 'history' && view === 'next' ? 'next'
    : tab === 'limits' && isLimitsView(view) && view !== 'strategy' ? view
      : null
  return `${ROOM_PATH}?tab=${tab}${carried ? `&view=${carried}` : ''}`
}

/**
 * CR rebuild 4 — Limits shows one of four views: the ads strategy, the account brakes, the protected terms, and what
 * only a deploy changes. The old Strategy tab's links land on Strategy, its first view.
 */
export type LimitsView = 'strategy' | 'brakes' | 'terms' | 'server'

export const LIMITS_VIEWS: readonly { id: LimitsView; label: string }[] = [
  { id: 'strategy', label: 'Strategy' },
  { id: 'brakes', label: 'Account brakes' },
  { id: 'terms', label: 'Protected terms' },
  { id: 'server', label: 'Set on the server' },
]

export function isLimitsView(v: unknown): v is LimitsView {
  return typeof v === 'string' && LIMITS_VIEWS.some((x) => x.id === v)
}

/** The Limits view a URL asks for (`?view=`, read only when the tab is Limits). Anything else opens Strategy. */
export function readLimitsView(view: string | null): LimitsView {
  return isLimitsView(view) ? view : 'strategy'
}
