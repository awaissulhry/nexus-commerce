import type { Metadata } from 'next'
import type { ReactNode } from 'react'

/**
 * The Portal view (B-W2b-173; A2 §3.2, design portal.frame): the pages a customer, supplier, workshop or adviser opens with a
 * portal session, under `/p/<party code>/…` — each in the portal frame (`p/[party]/layout.tsx`). The sign-in pages
 * (`/p/signin`, B-W2b-164) and the unsubscribe page (`/p/unsubscribe`) live beside it, with no frame. Never imports the
 * office, floor or links views (check-view-boundaries): shared code lives in src/lib.
 */
export const metadata: Metadata = {
  // A partner's pages are for that partner: never in a search engine, never followed, never sent as a referrer.
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

export default function PortalLayout({ children }: { children: ReactNode }) {
  return children
}
