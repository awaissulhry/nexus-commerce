/**
 * B-W2b-05 (PLT-171, design shell.panels tab:print "Print view of the record", shell.lists tab:print-view "Print this
 * view"): any Office page opens for paper in a new tab — the same address with `print=1`, so a list prints the view it
 * shows (its filters are its address terms) and a record prints the record. The shell draws the paper's frame: the
 * company, the site, the page's place, who printed it and when, and page numbers.
 */

export const PRINT_PARAM = 'print'

/** The address terms say "print view". */
export const isPrintView = (search: URLSearchParams | null | undefined): boolean => search?.get(PRINT_PARAM) === '1'

/** The print view of an address: the same terms plus `print=1` (an address that has it already keeps it once). */
export function printHref(fullPath: string, search: string): string {
  const terms = new URLSearchParams(search)
  terms.set(PRINT_PARAM, '1')
  return `${fullPath}?${terms.toString()}`
}

/** The address the print view came from (its Close / Back link): the same terms without `print`. */
export function viewHref(fullPath: string, search: string): string {
  const terms = new URLSearchParams(search)
  terms.delete(PRINT_PARAM)
  const rest = terms.toString()
  return rest ? `${fullPath}?${rest}` : fullPath
}

/** Pages that are paper already (their own print, PDF, XML or sheet tab): no second print view. */
const PAPER_PAGE = /\/(print|xml|pack|sheet|job-sheet|tag|tags|calendar-print|statement)$/

export type PrintKind = 'record' | 'view'

/**
 * What the print view of a company-free address is: a RECORD (an address one of the built pages with an id has — the
 * band says "Print view of the record"), a VIEW (a list or any other page — "Print this view"), or null where the page
 * is paper already.
 */
export function printKindOf(path: string, built: ReadonlySet<string>): PrintKind | null {
  if (path === '/' || PAPER_PAGE.test(path)) return null
  if (built.has(path)) return 'view'
  const segments = path.split('/').filter(Boolean)
  for (const page of built) {
    const shape = page.split('/').filter(Boolean)
    if (shape.length !== segments.length || !shape.some((part) => part.startsWith('['))) continue
    if (shape.every((part, index) => part.startsWith('[') || part === segments[index])) return 'record'
  }
  return 'view'
}

/**
 * Where the band's Print opens, company-free: the page's OWN print page when it has one (`<page>/print`, a paper layout
 * its step built — Today, Production reports, …: one way to print each page), else the page itself with `print=1`.
 * The address terms go along either way.
 */
export function printAddressOf(path: string, search: string, built: ReadonlySet<string>): string {
  if (built.has(`${path}/print`)) {
    const terms = new URLSearchParams(search)
    terms.delete(PRINT_PARAM)
    const rest = terms.toString()
    return `${path}/print${rest ? `?${rest}` : ''}`
  }
  return printHref(path, search)
}
