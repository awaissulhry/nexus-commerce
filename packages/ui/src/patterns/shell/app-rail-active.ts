/**
 * Which ONE rail row is the current page? The single answer, used by AppRail.
 *
 * ## The defect this exists to end
 *
 * Every row used to decide its own highlight from a PREFIX test
 * (`pathname === href || pathname.startsWith(href + '/')`). A prefix test can
 * only answer "could this row be the match" — never "is this row the BEST
 * match". So in any nav where one entry's href is a prefix of a sibling's,
 * several rows lit up at once.
 *
 * The three-level groups guarantee that collision rather than risk it, because
 * `app-nav.ts` gives each group its own first page as its href on purpose
 * ("clicking Build lands on Workers"). Measured on `/fleet/workers` before this
 * fix, THREE rows were `on`: **Operate** (href `/fleet`, a prefix), **Overview**
 * (href `/fleet`, also a prefix) and **Workers**. Operate and Overview were
 * highlighted on all ten fleet pages — the rail could not say where you were.
 *
 * ## The rule
 *
 * Among all hrefs that match the pathname, the **LONGEST wins**; a tie goes to
 * the **DEEPEST** row. So a group and the child it points at resolve to the
 * child, which is the row the operator actually clicked.
 *
 * Longest-match is what makes it general: it needs no knowledge of which entries
 * happen to be prefixes of which, so a new page can never reintroduce the bug.
 *
 * ## What this deliberately does NOT decide
 *
 * Group EXPANSION and the subtle `.section` tint stay prefix-based in AppRail. A
 * section genuinely is "open" and "the one you are in" for every descendant.
 * Only the full `.on` fill is exclusive.
 */

/** Structural shape only — avoids a cycle with AppRail's own RailItem types. */
export interface ActiveNavNode {
  href: string
  /**
   * The destination URL when this row is an external link, per `RailNavItem`.
   * Typed as `unknown` rather than `string` so the caller can pass its own item
   * type unchanged; only its truthiness is read. External rows never win —
   * following one leaves the app, so it can never be "the page you are on".
   */
  external?: unknown
  children?: readonly ActiveNavNode[]
}

export interface ActiveNavMatch {
  href: string
  /** 1 = top-level item · 2 = group or sub-item · 3 = sub-sub-item. */
  depth: number
}

/** True when `href` is this page or an ancestor of it. Never a bare prefix: `/fleet` must not claim `/fleets`. */
export function hrefMatchesPath(href: string, pathname: string): boolean {
  return !!href && (pathname === href || pathname.startsWith(`${href}/`))
}

/**
 * The one row that should carry `.on`, or null when nothing in the tree matches
 * (a page with no rail entry — legitimate, and it must highlight nothing rather
 * than the nearest ancestor).
 */
export function resolveActiveNav(
  items: readonly ActiveNavNode[],
  pathname: string,
): ActiveNavMatch | null {
  let win: ActiveNavMatch | null = null

  const consider = (href: string, depth: number) => {
    if (!hrefMatchesPath(href, pathname)) return
    if (
      win == null ||
      href.length > win.href.length ||
      (href.length === win.href.length && depth > win.depth)
    ) {
      win = { href, depth }
    }
  }

  for (const it of items) {
    if (!it.external) consider(it.href, 1)
    for (const c of it.children ?? []) {
      consider(c.href, 2)
      for (const m of c.children ?? []) consider(m.href, 3)
    }
  }

  return win
}
