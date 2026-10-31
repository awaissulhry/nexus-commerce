import type { AreaNav } from '@nexus/ui/patterns/shell/index'
import { isWindowPage, navPages, OFFICE_PAGES } from '../../nav/office-nav'

/**
 * B-W2b-05 (design shell.scope sec:defaults: "Start page: Today (default) / a saved view I pick"): what an office entry
 * opens for this person after sign-in (`/w/<company>`). Kept with their remembered company and site (the scope cookie,
 * per person on this device; lib/session/scope-memory.ts `start`). A saved view opens as its list's own link
 * (`<page>?savedView=<id>`, the list tools' Copy link). The entry opens it only while the person may still open that
 * page; anything else is Today, as before. The API checks the view itself when the list reads it.
 */

export type StartChoice = { kind: 'today' } | { kind: 'view'; page: string; viewId: string }

export const SAVED_VIEW_TERM = 'savedView'

/** The company-free address of a choice; null = Today (the entry's own first page). */
export function startAddressOf(choice: StartChoice): string | null {
  return choice.kind === 'today' ? null : `${choice.page}?${SAVED_VIEW_TERM}=${encodeURIComponent(choice.viewId)}`
}

/** The choice an address stands for (anything not a saved view's link is Today). */
export function startChoiceOf(address: string | null): StartChoice {
  if (!address) return { kind: 'today' }
  const [page, terms = ''] = address.split('?')
  const viewId = new URLSearchParams(terms).get(SAVED_VIEW_TERM)
  return page && viewId ? { kind: 'view', page, viewId } : { kind: 'today' }
}

/** The pages a start view may be on: the person's list pages (navigation rows that are built, never a window page). */
export function startPagesOf(nav: AreaNav, built: ReadonlySet<string> = OFFICE_PAGES): Array<{ href: string; label: string; area: string }> {
  return navPages(nav).filter((page) => built.has(page.href) && !isWindowPage(page.href))
}

/** The address the entry opens for this start page, or null (Today) when the person may no longer open its page. */
export function startPageFor(address: string | null, nav: AreaNav, built: ReadonlySet<string> = OFFICE_PAGES): string | null {
  const choice = startChoiceOf(address)
  if (choice.kind === 'today') return null
  return startPagesOf(nav, built).some((page) => page.href === choice.page) ? startAddressOf(choice) : null
}

/** Same choice? (the Save button is held until something changed). */
export function sameStart(a: StartChoice, b: StartChoice): boolean {
  return a.kind === b.kind && (a.kind === 'today' || (b.kind === 'view' && a.page === b.page && a.viewId === b.viewId))
}
