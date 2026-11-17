/**
 * B-TH-216 (threads plan TH-1b; O-SAL-INQ-REC.band-F02 "Old links keep working"): Office pages that changed their address. The
 * old address — a bookmark, a notification, a Today row, a search hit, a pin, a mail — opens the new one with its query and its
 * record id kept, through Next's own redirects (next.config.ts), so no page file is left behind at the old address. Pure: the
 * navigation test holds every rename.
 */

export interface RenamedPage {
  /** The old address under `/w/<company>`. */
  readonly from: string
  /** The address it opens now. */
  readonly to: string
  readonly step: string
}

export const RENAMED_PAGES: readonly RenamedPage[] = [
  // Sales › Inquiries became Sales › Incoming: every request of every customer on one page (Owner yes 2026-11-16).
  { from: '/sales/inquiries', to: '/sales/incoming', step: 'B-TH-216' },
]

/** Next's redirects for the renames: the page and everything under it (`:rest*` keeps a record id); the query is kept by Next. */
export function officeRedirects(): { source: string; destination: string; permanent: false }[] {
  return RENAMED_PAGES.flatMap(({ from, to }) => [
    { source: `/w/:company${from}`, destination: `/w/:company${to}`, permanent: false as const },
    { source: `/w/:company${from}/:rest*`, destination: `/w/:company${to}/:rest*`, permanent: false as const },
  ])
}

/** Where an old company-free address opens now (the same address when it was not renamed). */
export function renamedAddress(address: string): string {
  for (const { from, to } of RENAMED_PAGES) if (address === from || address.startsWith(`${from}/`) || address.startsWith(`${from}?`)) return `${to}${address.slice(from.length)}`
  return address
}
