import type { Metadata } from 'next'
import type { ReactNode } from 'react'

/**
 * The Links view (A2 §1.7, §3.2; SAL-099, PLT-007): pages a customer or supplier opens from a one-off link, with no
 * account. NO chrome — no navigation, search, switcher or banner: the page shows the one record its link opens and
 * nothing else about the factory. Each page draws the link frame itself (shell/links: the sender's branding,
 * comfortable density, the link states, the privacy notice). Never imports the office view (check-view-boundaries).
 */
export const metadata: Metadata = {
  // A link page is for its recipient: never in a search engine, never followed, never sent as a referrer.
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

export default function LinksLayout({ children }: { children: ReactNode }) {
  return children
}
