// MC.8.2 — A+ Content list page.
//
// List with filter toolbar (marketplace + status + search) and a
// "New A+" CTA. Detail/builder lands at /marketing/aplus/[id] in MC.8.3.
//
// Data loads client-side in AplusListLoader — the cross-site API session
// cookie means server fetches can never authenticate. The page stays a
// server component so router.refresh() (the list's Refresh control)
// mints a new refreshToken and re-triggers the loader.

import AplusListLoader from './AplusListLoader'

export const dynamic = 'force-dynamic'

export default function AplusListPage() {
  return <AplusListLoader refreshToken={Date.now()} />
}
