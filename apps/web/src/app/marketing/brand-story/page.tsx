// MC.9.1 — Brand Story list page.
//
// List at /marketing/brand-story. Builder lands at
// /marketing/brand-story/[id] in MC.9.2.
//
// Data loads client-side in BrandStoryListLoader — the cross-site API
// session cookie means server fetches can never authenticate. The page
// stays a server component so router.refresh() (the list's Refresh
// control) mints a new refreshToken and re-triggers the loader.

import BrandStoryListLoader from './BrandStoryListLoader'

export const dynamic = 'force-dynamic'

export default function BrandStoryListPage() {
  return <BrandStoryListLoader refreshToken={Date.now()} />
}
