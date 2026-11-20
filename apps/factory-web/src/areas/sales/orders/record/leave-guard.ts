/**
 * F-OL-07 (Order LINES lane; 11-design-dialogs D-k "Leaving the order with changes", W2) — which click leaves the order page while the
 * Lines tab holds changes not saved. An in-app link to another page (another order too) asks first; a link inside this page — another
 * tab of the same order, an anchor — keeps the draft and asks nothing. A click the browser opens elsewhere (a new tab or window, a
 * download, another site) is not this page's to hold: the browser's own guard (`beforeunload`) covers leaving the site. Pure.
 */

/** What the click was: its button and keys, and whether something before us already took it. */
export interface LeaveClick {
  readonly button: number
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly defaultPrevented: boolean
}

/** The link clicked (its resolved address, its target, a download). */
export interface LeaveAnchor {
  readonly href: string
  readonly target: string
  readonly download: boolean
}

/** Where the page is now. */
export interface LeaveHere {
  readonly origin: string
  readonly pathname: string
}

/** The in-app address the click goes to when it leaves this page (path, query and hash); null: let it go as it is. */
export function leavingHrefOf(click: LeaveClick, anchor: LeaveAnchor | null, here: LeaveHere): string | null {
  if (!anchor || click.defaultPrevented) return null
  // Another tab or window, or a download: the page stays (the browser opens it elsewhere).
  if (click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return null
  if (anchor.download || (anchor.target !== '' && anchor.target !== '_self')) return null
  let url: URL
  try {
    url = new URL(anchor.href, `${here.origin}${here.pathname}`)
  } catch {
    return null
  }
  // Another site: the browser's own guard asks.
  if (url.origin !== here.origin) return null
  // This page: another tab of the order (`?tab=`), the dock's scope, an anchor — the draft stays, nothing asked.
  if (url.pathname === here.pathname) return null
  return `${url.pathname}${url.search}${url.hash}`
}
