import { areaNavForPerson, findAreaNavPlace, type AreaNav, type AreaNavArea, type AreaNavItem, type AreaNavSection } from '@nexus/ui/patterns/shell/index'

/**
 * The Office navigation (A2 §1.1, PLT-160): ONE declaration per area, `src/areas/<area>/nav.ts`, exporting
 * `officeArea = { order, area }` (the design system's `AreaNavArea`). This file finds them by itself (no central list
 * to edit), orders them by `order` (A2 §1.3's row numbers), and gives the shell:
 *  - `officeNavFor(can)` — only what this person may open (`areaNavForPerson`: a row with a permission they lack is
 *    gone, a section or area left empty goes with it; a row without a permission is shown to everyone in the office);
 *  - `translateNav(nav, t)` — labels are message keys (`shell:nav.admin.users`), drawn in the person's language;
 *  - `officeCrumbs(nav, path)` — where a page sits: area › row (› row under a row).
 * The same manifest drives the rail, the area's sub-sidebar (its pages button), the crumbs, the phone bottom bar and the
 * palette's pages.
 */

export interface OfficeAreaNav {
  /** The area's place in the main sidebar (A2 §1.3, top to bottom). */
  order: number
  area: AreaNavArea
}

/**
 * Permissions a W0 row names before the step that builds its page declares them (factory-domain's catalogue). Nobody
 * holds them yet, so their rows are hidden for everyone; the office-nav test fails on any OTHER undeclared name (a typo).
 */
export const PENDING_PERMISSIONS: ReadonlySet<string> = new Set([])

const MODULES = import.meta.glob('./*/nav.ts', { base: '../../areas', eager: true, import: 'officeArea' }) as Record<string, OfficeAreaNav | undefined>

/** Every area's declaration, in sidebar order. */
export function officeAreaDeclarations(modules: Readonly<Record<string, OfficeAreaNav | undefined>> = MODULES): OfficeAreaNav[] {
  return Object.entries(modules)
    .flatMap(([path, declaration]) => {
      if (!declaration?.area) throw new Error(`${path}: an area nav file exports \`officeArea\` ({ order, area })`)
      return [declaration]
    })
    .sort((a, b) => a.order - b.order || a.area.id.localeCompare(b.area.id))
}

/** The whole Office manifest (before any person's filter). */
export const OFFICE_NAV: AreaNav = { view: 'office', areas: officeAreaDeclarations().map((declaration) => declaration.area) }

/** The Office navigation this person may open. */
export function officeNavFor(can: (permission: string) => boolean, nav: AreaNav = OFFICE_NAV): AreaNav {
  return areaNavForPerson(nav, { can })
}

/** The manifest with every label (and screen-reader name) drawn by `t`. Ids, addresses and icons stay. */
export function translateNav(nav: AreaNav, t: (key: string) => string): AreaNav {
  const row = (item: AreaNavItem): AreaNavItem => ({
    ...item,
    label: t(item.label),
    ...(item.ariaLabel ? { ariaLabel: t(item.ariaLabel) } : {}),
    ...(item.childrenLabel ? { childrenLabel: t(item.childrenLabel) } : {}),
    ...(item.children ? { children: item.children.map(row) } : {}),
  })
  const section = (s: AreaNavSection): AreaNavSection => ({ ...s, label: t(s.label), items: s.items.map(row) })
  return { ...nav, areas: nav.areas.map((area) => ({ ...area, label: t(area.label), ...(area.sections ? { sections: area.sections.map(section) } : {}) })) }
}

/** Every label key a manifest uses (the i18n test checks each exists in every language). */
export function navLabelKeys(nav: AreaNav = OFFICE_NAV): string[] {
  const keys = new Set<string>()
  const row = (item: AreaNavItem) => {
    keys.add(item.label)
    if (item.ariaLabel) keys.add(item.ariaLabel)
    if (item.childrenLabel) keys.add(item.childrenLabel)
    item.children?.forEach(row)
  }
  for (const area of nav.areas) {
    keys.add(area.label)
    for (const section of area.sections ?? []) {
      keys.add(section.label)
      section.items.forEach(row)
    }
  }
  return [...keys].sort()
}

/** Every permission a manifest names. */
export function navPermissions(nav: AreaNav = OFFICE_NAV): string[] {
  const names = new Set<string>()
  const row = (item: AreaNavItem) => {
    if (item.permission) names.add(item.permission)
    item.children?.forEach(row)
  }
  for (const area of nav.areas) {
    if (area.permission) names.add(area.permission)
    for (const section of area.sections ?? []) section.items.forEach(row)
  }
  return [...names].sort()
}

/**
 * The office pages that are built, by their company-free address. A step that builds a page adds its address here
 * (`office-entry.vitest.test.ts` compares this list with the page files under `app/(office)/w/[company]/`): the office
 * entry opens only a page that exists, never a row whose page comes with a later step.
 */
export const OFFICE_PAGES: ReadonlySet<string> = new Set([
  '/me',
  '/home/today',
  '/home/today/print',
  '/home/approvals',
  '/home/mail-to-sort',
  '/records/[type]/[id]',
  '/sales/customers',
  '/sales/customers/[partyId]',
  '/sales/quotes',
  '/sales/quotes/[id]',
  '/purchasing/suppliers',
  '/purchasing/suppliers/[partyId]',
  '/products/styles',
  '/products/styles/[id]',
  '/production/floor',
  '/production/work-orders',
  '/production/work-orders/[id]',
  // B-W0-27 Admin: All settings, Companies & sites, Devices & printers, Users, Roles & permissions, and their records.
  '/admin',
  '/admin/companies',
  '/admin/companies/[companyId]',
  '/admin/companies/[companyId]/sites/[siteId]',
  '/admin/devices',
  '/admin/devices/[deviceId]',
  '/admin/users',
  '/admin/users/[userId]',
  '/admin/users/floor/[workerId]',
  '/admin/roles',
  '/admin/roles/[roleId]',
  // B-W0-28 Admin: Documents & numbering, Languages & formats, Connections & API (and a connection), Import & export,
  // Audit log.
  '/admin/documents',
  '/admin/languages',
  '/admin/connections',
  '/admin/connections/[accountId]',
  '/admin/import',
  '/admin/audit',
])

/** My profile & security (SCR-007): open to every signed-in person, the page of last resort. */
export const PROFILE_PAGE = '/me'

/**
 * The page an office entry opens (`/w/<company>`, an area's own address, the brand link, a new session): the first
 * row in the navigation's order this person may open whose page is built — inside `areaId` first when one is given —
 * else My profile (W0 builds one area page, Home › Mail to sort; a person with no role opens no row).
 */
export function firstOfficePage(nav: AreaNav, options: { areaId?: string; built?: ReadonlySet<string> } = {}): string {
  const built = options.built ?? OFFICE_PAGES
  const firstIn = (areas: readonly AreaNavArea[]): string | undefined => {
    for (const area of areas) {
      if (!area.sections?.length && built.has(area.href)) return area.href
      for (const section of area.sections ?? []) {
        for (const item of section.items) {
          for (const row of [item, ...(item.children ?? [])]) if (built.has(row.href)) return row.href
        }
      }
    }
    return undefined
  }
  const own = options.areaId ? firstIn(nav.areas.filter((area) => area.id === options.areaId)) : undefined
  return own ?? firstIn(nav.areas) ?? PROFILE_PAGE
}

export interface Crumb {
  id: string
  name: string
  /** Company-free address; absent for the current page. */
  href?: string
}

/**
 * Where `path` sits: its area, the section when it is a crumb (`noCrumb` and hidden-label sections are not), the row a
 * row sits under, and the row itself. The last crumb is the current page (no link). Empty when the path is not in the
 * manifest.
 */
export function officeCrumbs(nav: AreaNav, path: string): Crumb[] {
  const place = findAreaNavPlace(nav, path)
  if (!place) return []
  const crumbs: Crumb[] = [{ id: place.area.id, name: place.area.label, href: place.area.href }]
  if (place.section && !place.section.noCrumb && !place.section.hideLabel) crumbs.push({ id: place.section.id, name: place.section.label })
  if (place.parent) crumbs.push({ id: place.parent.id, name: place.parent.label, href: place.parent.href })
  if (place.item) crumbs.push({ id: place.item.id, name: place.item.label, href: place.item.href })
  const last = crumbs[crumbs.length - 1]
  if (last && path.replace(/\/+$/, '') === last.href) delete last.href
  return crumbs
}

/** The pages of a manifest as a flat list (the palette jumps to them): every row, with its area. */
export function navPages(nav: AreaNav): Array<{ id: string; label: string; area: string; href: string }> {
  const pages: Array<{ id: string; label: string; area: string; href: string }> = []
  for (const area of nav.areas) {
    if (!area.sections?.length) pages.push({ id: area.id, label: area.label, area: area.label, href: area.href })
    for (const section of area.sections ?? []) {
      for (const item of section.items) {
        pages.push({ id: item.id, label: item.label, area: area.label, href: item.href })
        for (const child of item.children ?? []) pages.push({ id: child.id, label: child.label, area: area.label, href: child.href })
      }
    }
  }
  return pages
}
