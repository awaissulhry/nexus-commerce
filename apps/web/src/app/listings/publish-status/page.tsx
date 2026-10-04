// Publish history (sheet publish parity, step 4) — the business's publishes, newest first, with each channel's answer.
// The URL stays /listings/publish-status; the old rollout dashboard (M.7) lives in a collapsed section of the page.

import PublishStatusClient from './PublishStatusClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function PublishStatusPage() {
  return <PublishStatusClient />
}
