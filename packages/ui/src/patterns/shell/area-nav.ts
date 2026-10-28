/**
 * Area navigation — the manifest type a view declares its navigation in, and the helpers that read it.
 *
 * One manifest per view drives the main sidebar (one row per area, `areaRailItems` → `AppRail`), each area's
 * sub-sidebar (its sections, `areaSubNavGroups` → `WorkspaceSubheader` groups: a pinned column from 1024 px, a drawer
 * below), the phone bottom bar (`phone`) and the permission filter (`areaNavForPerson`). Generalised from the web's
 * Reviews area (`marketing/reviews/_shell/reviews-nav.ts`): a section is its group, a row its row.
 *
 * A manifest is data: its file imports these types and its icons only, so it is tested in Node. Addresses are app
 * addresses without a workspace prefix (`/sales/quotes`); the shell adds the prefix when it draws a link. An area's
 * `href` is its root: every page of the area lives under it, so the main sidebar lights the area on any of them.
 *
 * The four views:
 *  - office — main sidebar + a sub-sidebar per area. A row without a `permission` is shown to everyone in the view.
 *  - floor  — no sidebar: the areas are a station's home tiles; `kinds` are the station modes a tile shows in.
 *  - portal — main sidebar with a few areas, a sub-sidebar where an area has several pages; `kinds` are partner kinds.
 *  - links  — no navigation (one task per page): its manifest has no areas.
 * Floor and portal fail closed: a row or area without a `permission` is hidden. A view may extend the row types with
 * its own fields (a floor tile's tone); the helpers keep them.
 */
import { createElement } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { WorkspaceNavGroup, WorkspaceNavItem } from '../WorkspaceSubheader'
import type { RailNavItem } from './AppRail'
import { hrefMatchesPath } from './app-rail-active'

export const AREA_NAV_VIEWS = ['office', 'floor', 'portal', 'links'] as const
export type AreaNavView = (typeof AREA_NAV_VIEWS)[number]

/** What an area (a main-sidebar row) and a page row share. */
interface AreaNavEntry {
  /** Unique within the manifest. */
  id: string
  label: string
  /** The page it opens: an app address without the workspace prefix. */
  href: string
  icon?: LucideIcon
  /** The permission a person needs to see it. Absent: everyone in an office view; nobody in floor and portal. */
  permission?: string
  /** The key of a count the shell looks up (`count`); shown when above 0. */
  badge?: string
  /** Only for these kinds: a floor station mode, a portal partner kind. Absent: every kind. */
  kinds?: readonly string[]
  /** On a phone: a tab of the bottom bar, or a row under More. */
  phone?: 'tab' | 'more'
}

/** A row of a sub-sidebar: one page. */
export interface AreaNavItem extends AreaNavEntry {
  /** `href` is this page only, never an ancestor of other pages (an area's overview). */
  exact?: boolean
  /** Other addresses (and the pages under them) this row owns: old addresses of its page, its records. */
  match?: readonly string[]
  /** The full name for a screen reader when the label is short: "Italy" under Amazon is "Amazon Italy". */
  ariaLabel?: string
  /** Rows under this row, behind a chevron. The sub-sidebar draws one level. */
  children?: readonly AreaNavItem[]
  /** What the rows under it are, for the chevron's name ("Show Amazon markets"). */
  childrenLabel?: string
}

/** A group of rows in a sub-sidebar. */
export interface AreaNavSection {
  id: string
  /** Always set: it names the group to a screen reader, even when `hideLabel` hides it on screen. */
  label: string
  /** Its label opens and closes it. */
  collapsible?: boolean
  /** The label is not drawn (the top group sits under the column title); such a group is never collapsible. */
  hideLabel?: boolean
  /** The group is not a crumb: "Sales › Quotes", not "Sales › Selling › Quotes". */
  noCrumb?: boolean
  items: readonly AreaNavItem[]
}

/** One area: its row in the main sidebar and its sub-sidebar. */
export interface AreaNavArea extends AreaNavEntry {
  icon: LucideIcon
  /** The sub-sidebar, top to bottom. Absent or empty: the area is one page, with no sub-sidebar. */
  sections?: readonly AreaNavSection[]
}

/** The navigation of one view. */
export interface AreaNav {
  view: AreaNavView
  areas: readonly AreaNavArea[]
}

/** Who is looking. */
export interface AreaNavAccess {
  /** Does the person hold this permission? */
  can: (permission: string) => boolean
  /** The kind the rows' `kinds` are matched against: the station mode (floor), the partner kind (portal). */
  kind?: string
}

/**
 * The manifest with only what this person may open. A row or area is kept when the person holds its `permission`
 * (without one: kept in an office view, dropped in floor and portal) and its `kinds`, if any, include `access.kind`.
 * A section left empty is dropped, and so is an area that had pages and kept none: navigation never shows a door
 * that leads nowhere. Rows under a dropped row go with it.
 */
export function areaNavForPerson(nav: AreaNav, access: AreaNavAccess): AreaNav {
  const failsClosed = nav.view !== 'office'
  const allowed = (entry: AreaNavEntry) =>
    (entry.permission ? access.can(entry.permission) : !failsClosed) &&
    (!entry.kinds || (access.kind !== undefined && entry.kinds.includes(access.kind)))
  const keep = (row: AreaNavItem): AreaNavItem[] => {
    if (!allowed(row)) return []
    if (!row.children) return [row]
    const { children, ...rest } = row
    const kept = children.flatMap(keep)
    return [kept.length > 0 ? { ...rest, children: kept } : rest]
  }
  const areas = nav.areas.flatMap((area): AreaNavArea[] => {
    if (!allowed(area)) return []
    if (!area.sections?.length) return [area]
    const sections = area.sections
      .map((section) => ({ ...section, items: section.items.flatMap(keep) }))
      .filter((section) => section.items.length > 0)
    return sections.length > 0 ? [{ ...area, sections }] : []
  })
  return { ...nav, areas }
}

/** Where a path is in a manifest. */
export interface AreaNavPlace {
  area: AreaNavArea
  /** The section of `item`. */
  section?: AreaNavSection
  /** The one current row, a row under a row included. Absent: the path is in the area but no row owns it. */
  item?: AreaNavItem
  /** The row `item` sits under, when it is a row under a row. */
  parent?: AreaNavItem
}

/** The path without query, hash and trailing slash. */
function cleanPath(path: string): string {
  return path.split(/[?#]/)[0].replace(/\/+$/, '') || '/'
}

/** How strongly a row owns `path` (the length of its longest matching address), or -1. */
function claim(row: AreaNavItem, path: string): number {
  let best = -1
  if (row.exact ? path === row.href : hrefMatchesPath(row.href, path)) best = row.href.length
  for (const address of row.match ?? []) if (hrefMatchesPath(address, path) && address.length > best) best = address.length
  return best
}

/**
 * The area and the ONE row a (workspace-free) path belongs to: the longest matching address wins, and a tie goes to
 * the deeper entry (a row over its area, a row under a row over its parent) — the rule the rail uses
 * (`app-rail-active.ts`). Null when nothing in the manifest owns the path.
 */
export function findAreaNavPlace(nav: AreaNav, path: string): AreaNavPlace | null {
  const clean = cleanPath(path)
  let best: AreaNavPlace | null = null
  let bestLength = -1
  let bestDepth = 0
  const consider = (length: number, depth: number, place: AreaNavPlace) => {
    if (length < 0) return
    if (length > bestLength || (length === bestLength && depth > bestDepth)) {
      best = place
      bestLength = length
      bestDepth = depth
    }
  }
  for (const area of nav.areas) {
    consider(hrefMatchesPath(area.href, clean) ? area.href.length : -1, 1, { area })
    for (const section of area.sections ?? []) {
      for (const item of section.items) {
        consider(claim(item, clean), 2, { area, section, item })
        for (const child of item.children ?? []) consider(claim(child, clean), 3, { area, section, item: child, parent: item })
      }
    }
  }
  return best
}

/** The main sidebar's rows for `AppRail`: one per area, with its count when the shell knows it. */
export function areaRailItems(nav: AreaNav, count?: (badge: string) => number | undefined): RailNavItem[] {
  return nav.areas.map((area) => {
    const n = area.badge ? count?.(area.badge) : undefined
    return { label: area.label, href: area.href, Icon: area.icon, ...(n !== undefined ? { badge: n } : {}) }
  })
}

export interface AreaSubNavOptions {
  /** The current (workspace-free) address: its row is the one marked `active`. */
  path: string
  /** Turns an app address into the link's href, e.g. adds the workspace prefix. Default: unchanged. */
  href?: (address: string) => string
  /** The count for a badge key; shown when above 0. */
  count?: (badge: string) => number | undefined
}

/**
 * An area's sub-sidebar as `WorkspaceSubheader` groups. Exactly one row is `active` (`findAreaNavPlace`). Filter the
 * manifest with `areaNavForPerson` first: this draws every row it is given.
 */
export function areaSubNavGroups(area: AreaNavArea, options: AreaSubNavOptions): WorkspaceNavGroup[] {
  const current = findAreaNavPlace({ view: 'office', areas: [area] }, options.path)?.item
  const toHref = options.href ?? ((address: string) => address)
  const row = (item: AreaNavItem): WorkspaceNavItem => {
    const n = item.badge ? options.count?.(item.badge) : undefined
    const children = (item.children ?? []).map(row)
    return {
      id: item.id,
      label: item.label,
      href: toHref(item.href),
      ...(item.icon ? { icon: createElement(item.icon, { size: 16, 'aria-hidden': true }) } : {}),
      ...(item.ariaLabel ? { ariaLabel: item.ariaLabel } : {}),
      active: item === current,
      ...(n !== undefined && n > 0 ? { badge: n.toLocaleString('en') } : {}),
      ...(children.length > 0 ? { children, ...(item.childrenLabel ? { childrenLabel: item.childrenLabel } : {}) } : {}),
    }
  }
  return (area.sections ?? []).map((section) => ({
    id: section.id,
    label: section.label,
    ...(section.collapsible ? { collapsible: true } : {}),
    ...(section.hideLabel ? { hideLabel: true } : {}),
    items: section.items.map(row),
  }))
}
