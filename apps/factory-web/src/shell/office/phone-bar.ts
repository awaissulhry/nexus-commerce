import { findAreaNavPlace, type AreaNav, type AreaNavArea } from '@nexus/ui/patterns/shell/index'
import { OFFICE_NAV } from '../nav/office-nav'

/**
 * B-W2b-05 (PLT-162, design shell.frame sec:phone-bar): on a phone (under 720 px) the rail becomes 4 tabs and More.
 *
 * The tabs are the person's own (design: "4 tabs the person's roles mark 'tab' (e.g. Home, Sales, Warehouse,
 * Production)"): Home first, then the areas their roles open the most of — the share of an area's pages they may open —
 * and, between equals, the daily areas before the rare ones (`PHONE_TAB_ORDER`). So the Owner (every page) gets Home,
 * Sales, Warehouse, Production; a warehouse person Home, Warehouse and the areas their role works in; a sales person
 * Home, Sales and theirs. Every other area is in the More sheet, in rail order (the DS BottomBar's rule).
 * The area files' own `phone` marks are the default before this rule; rows are reached through their area's Pages.
 *
 * "Tabs keep the last page used per area": the shell remembers, per person on this device, the page of each area the
 * person used last (its navigation row, never a record id or a filter), and a tab — or a More row — opens there.
 */

export const PHONE_TABS = 4

/** Areas in the order they become phone tabs (the areas used every day by the most people first). */
export const PHONE_TAB_ORDER: readonly string[] = Object.freeze([
  'home',
  'sales',
  'warehouse',
  'production',
  'purchasing',
  'quality',
  'planning',
  'finance',
  'products',
  'compliance',
  'people',
  'plant',
  'admin',
])

/** How many pages an area holds (its rows and their children; an area without rows is one page). */
const pageCount = (area: AreaNavArea | undefined): number =>
  area?.sections?.reduce((sum, section) => sum + section.items.reduce((rows, item) => rows + 1 + (item.children?.length ?? 0), 0), 0) || 1

/**
 * The person's navigation with the phone marks of this rule: Home, then their areas by the share of each area's pages
 * they may open (of the whole manifest, `full`), then PHONE_TAB_ORDER; the first `max` are tabs.
 */
export function phoneNav(nav: AreaNav, max = PHONE_TABS, full: AreaNav = OFFICE_NAV): AreaNav {
  const order = (id: string) => {
    const at = PHONE_TAB_ORDER.indexOf(id)
    return at === -1 ? PHONE_TAB_ORDER.length : at
  }
  const share = (area: AreaNavArea) => (area.id === 'home' ? 2 : pageCount(area) / pageCount(full.areas.find((entry) => entry.id === area.id)))
  const tabs = new Set(
    [...nav.areas]
      .sort((a, b) => share(b) - share(a) || order(a.id) - order(b.id))
      .slice(0, max)
      .map((area) => area.id),
  )
  return {
    ...nav,
    areas: nav.areas.map((area) => ({
      ...area,
      phone: tabs.has(area.id) ? 'tab' : 'more',
      // Rows are reached through their area's Pages on a phone: no row takes a tab of its own.
      ...(area.sections
        ? {
            sections: area.sections.map((section) => ({
              ...section,
              items: section.items.map(({ phone: _phone, ...item }) => ({
                ...item,
                ...(item.children ? { children: item.children.map(({ phone: _p, ...child }) => child) } : {}),
              })),
            })),
          }
        : {}),
    })),
  }
}

/** The area and page (its navigation row) an address belongs to, to remember as "last used"; null outside the navigation. */
export function lastPageOf(nav: AreaNav, path: string): { area: string; page: string } | null {
  const place = findAreaNavPlace(nav, path)
  if (!place) return null
  const page = place.item?.href ?? place.area.href
  return { area: place.area.id, page }
}

export type LastPages = Readonly<Record<string, string>>

/** Where an area's tab opens: the page used last there when the person may still open it, else the area's own address. */
export function areaTabHref(nav: AreaNav, last: LastPages, address: string): string {
  const area = nav.areas.find((entry) => entry.href === address)
  if (!area) return address
  const page = last[area.id]
  if (!page) return address
  const still = lastPageOf(nav, page)
  return still && still.area === area.id && still.page === page ? page : address
}

const KEY_PREFIX = 'fw.lastPages.'

/** This person's last pages on this device (a per-viewer convenience: localStorage, read with try/catch). */
export function readLastPages(person: string): LastPages {
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + person)
    const value = raw ? (JSON.parse(raw) as unknown) : null
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].startsWith('/')))
  } catch {
    return {}
  }
}

export function writeLastPages(person: string, last: LastPages): void {
  try {
    window.localStorage.setItem(KEY_PREFIX + person, JSON.stringify(last))
  } catch {
    // Private window or blocked storage: the tabs open each area's first page.
  }
}
