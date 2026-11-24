/**
 * tw- fx2 (walk G-3: a jump also scrolled the office PAGE under the dock, 0 → 52 px): a row is brought into view by scrolling its
 * LIST only — the thread's feed (`.fw-rt-feed`) or the dock card's body (`.fw-rt-scroll`) — never with `scrollIntoView`, which scrolls
 * every scrolling ancestor up to the page.
 */
const LIST = '.fw-rt-feed, .fw-rt-scroll'

/** The row centred in its list (10-design § 6.4). No list around it: nothing moves. */
export function centreInList(row: HTMLElement | null | undefined): void {
  const list = row?.closest<HTMLElement>(LIST)
  if (!row || !list) return
  const offset = row.getBoundingClientRect().top - list.getBoundingClientRect().top
  list.scrollTop = Math.max(0, list.scrollTop + offset - (list.clientHeight - row.offsetHeight) / 2)
}

/** The row just inside its list's view (a keyboard walk): scrolled only as far as it needs. */
export function revealInList(row: HTMLElement | null | undefined): void {
  const list = row?.closest<HTMLElement>(LIST)
  if (!row || !list) return
  const box = row.getBoundingClientRect()
  const view = list.getBoundingClientRect()
  if (box.top < view.top) list.scrollTop -= view.top - box.top
  else if (box.bottom > view.bottom) list.scrollTop += box.bottom - view.bottom
}
