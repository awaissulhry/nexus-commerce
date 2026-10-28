/**
 * What the phone bottom bar shows: its tabs, what goes under More, and the one current place. Pure, so it is tested in
 * Node; `BottomBar.tsx` draws it.
 *
 * The bar is read from the view's area-navigation manifest (`patterns/shell/area-nav.ts`), already filtered for the
 * person (`areaNavForPerson`):
 *  - TABS are the areas and rows marked `phone: 'tab'`, in manifest order, at most `maxTabs` (4). A manifest that marks
 *    none: its first areas are the tabs.
 *  - MORE holds every area that is not a tab (every area stays one tap and a sheet away), every row marked
 *    `phone: 'more'`, and the marked tabs past `maxTabs`. A row with no `phone` mark is not in the bar: it is reached
 *    through its area's sub-sidebar (a drawer on a phone).
 *  - When More would hold exactly one entry and there is room for a fifth tab, that entry becomes the fifth tab: a sheet
 *    with a single row is a wasted tap. So the bar has 2–5 slots: up to 4 tabs and More, or up to 5 tabs.
 *  - CURRENT: `findAreaNavPlace` decides the one area and row the address belongs to. Its row's entry when that row is in
 *    the bar (or the row it sits under), else its area's. When that entry is under More, More is the current slot.
 */
import type { LucideIcon } from 'lucide-react'
import { findAreaNavPlace, type AreaNav } from '../../patterns/shell/area-nav'

/** At most this many slots: tabs plus More. */
export const BOTTOM_BAR_MAX_SLOTS = 5
/** Tabs before More, by default. */
export const BOTTOM_BAR_TABS = 4

/** One place the bar can open: an area or a row of an area. */
export interface BottomBarEntry {
  /** The manifest id (unique within it). */
  id: string
  label: string
  /** An app address without the workspace prefix. */
  href: string
  icon?: LucideIcon
  /** The count key; shown when the shell's count is above 0. */
  badge?: string
  /** The full name for a screen reader, when the label is short. */
  ariaLabel?: string
  kind: 'area' | 'row'
  /** The area it belongs to (itself, for an area). */
  areaId: string
  areaLabel: string
}

export interface BottomBarLayout {
  tabs: BottomBarEntry[]
  /** Empty: no More slot. */
  more: BottomBarEntry[]
  /** The current slot: a tab's id, `'more'`, or null when no entry owns the address. */
  current: string | null
  /** The current entry inside More (when `current` is `'more'`). */
  currentInMore: string | null
}

export interface BottomBarOptions {
  /** Tabs before More (1–4, default 4). A fifth tab appears only in place of a More with one entry. */
  maxTabs?: number
}

/** Every entry the bar can show, in manifest order, with its phone mark. */
function entriesOf(nav: AreaNav): Array<{ entry: BottomBarEntry; phone?: 'tab' | 'more' }> {
  const out: Array<{ entry: BottomBarEntry; phone?: 'tab' | 'more' }> = []
  for (const area of nav.areas) {
    const base = { areaId: area.id, areaLabel: area.label }
    out.push({ entry: { id: area.id, label: area.label, href: area.href, icon: area.icon, ...(area.badge ? { badge: area.badge } : {}), kind: 'area', ...base }, phone: area.phone })
    for (const section of area.sections ?? []) {
      for (const item of section.items) {
        for (const row of [item, ...(item.children ?? [])]) {
          if (!row.phone) continue
          out.push({
            entry: {
              id: row.id,
              label: row.label,
              href: row.href,
              ...(row.icon ? { icon: row.icon } : {}),
              ...(row.badge ? { badge: row.badge } : {}),
              ...(row.ariaLabel ? { ariaLabel: row.ariaLabel } : {}),
              kind: 'row',
              ...base,
            },
            phone: row.phone,
          })
        }
      }
    }
  }
  return out
}

/** The bar for this manifest at this (workspace-free) address. */
export function bottomBarLayout(nav: AreaNav, path: string, options: BottomBarOptions = {}): BottomBarLayout {
  const maxTabs = Math.min(BOTTOM_BAR_TABS, Math.max(1, Math.floor(options.maxTabs ?? BOTTOM_BAR_TABS)))
  const all = entriesOf(nav)
  const order = new Map(all.map(({ entry }, i) => [entry.id, i]))
  const marked = all.filter((e) => e.phone === 'tab')
  const wanted = (marked.length > 0 ? marked : all.filter((e) => e.entry.kind === 'area')).map((e) => e.entry)
  let tabs = wanted.slice(0, maxTabs)
  const tabIds = new Set(tabs.map((t) => t.id))
  const overflow = new Set(wanted.slice(maxTabs).map((t) => t.id))
  let more = all
    .filter(({ entry, phone }) => !tabIds.has(entry.id) && (entry.kind === 'area' || phone === 'more' || overflow.has(entry.id)))
    .map((e) => e.entry)
  if (more.length === 1 && tabs.length < BOTTOM_BAR_MAX_SLOTS) {
    tabs = [...tabs, more[0]].sort((a, b) => order.get(a.id)! - order.get(b.id)!)
    more = []
  }

  const place = findAreaNavPlace(nav, path)
  let owner: BottomBarEntry | undefined
  if (place) {
    const inBar = new Map([...tabs, ...more].map((e) => [e.id, e]))
    owner = (place.item && inBar.get(place.item.id)) || (place.parent && inBar.get(place.parent.id)) || inBar.get(place.area.id)
  }
  const isTab = !!owner && tabs.includes(owner)
  return {
    tabs,
    more,
    current: owner ? (isTab ? owner.id : 'more') : null,
    currentInMore: owner && !isTab ? owner.id : null,
  }
}

/** A count as the badge shows it: `99+` above 99. */
export function badgeText(n: number): string {
  return n > 99 ? '99+' : String(n)
}
