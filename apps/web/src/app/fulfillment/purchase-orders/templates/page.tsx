// PO-Plus.6 — Reusable PO templates + recurring schedules.

import PoTemplatesClient from './PoTemplatesClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default function PoTemplatesPage() {
  return <PoTemplatesClient />
}
