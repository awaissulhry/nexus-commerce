/**
 * Link tabs (bid page DS lane, 2026-10-10): which tab is the page you are on — pure, tested in Node.
 *
 * The tab whose `href` IS the path, or the longest one the path sits under (`/rules/bid` is active on
 * `/rules/bid/123`), wins. The query and the hash never count, and neither does a trailing slash. `/rules/bidding` is
 * NOT under `/rules/bid`: only whole segments match. Give the path and the hrefs in the same form (the web app's
 * workspace `usePathname()` and hrefs both without the `/w/<id>` prefix).
 */
const bare = (path: string): string => {
  const cut = path.split(/[?#]/, 1)[0] ?? ''
  return cut.length > 1 ? cut.replace(/\/+$/, '') : cut
}

export function activeTabFromPath(tabs: ReadonlyArray<{ id: string; href?: string; disabled?: boolean }>, pathname: string | null | undefined): string | null {
  if (!pathname) return null
  const path = bare(pathname)
  let best: { id: string; length: number } | null = null
  for (const tab of tabs) {
    if (!tab.href || tab.disabled) continue
    const href = bare(tab.href)
    if (!href) continue
    const under = path === href || path.startsWith(href === '/' ? '/' : `${href}/`)
    if (under && (!best || href.length > best.length)) best = { id: tab.id, length: href.length }
  }
  return best?.id ?? null
}
