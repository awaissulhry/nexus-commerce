/**
 * Settings rebuild — Phase B.5
 *
 * /settings/audit — settings change history. Reads from
 * /api/settings/audit. Server-rendered initial page; the client
 * component handles filter changes + revert with refetch.
 */

import { getBackendUrl } from '@/lib/backend-url'
import AuditClient, { type AuditRow, type KeyCountMap } from './AuditClient'

export const dynamic = 'force-dynamic'

export default async function SettingsAuditPage() {
  const backend = getBackendUrl()
  let items: AuditRow[] = []
  let total = 0
  let keyCounts: KeyCountMap = {}
  let loadError: string | null = null

  try {
    const [listRes, keysRes] = await Promise.all([
      fetch(`${backend}/api/settings/audit?limit=50`, { cache: 'no-store' }),
      fetch(`${backend}/api/settings/audit/keys`, { cache: 'no-store' }),
    ])
    if (listRes.ok) {
      const data = (await listRes.json()) as { items: AuditRow[]; total: number }
      items = data.items
      total = data.total
    } else {
      loadError = `Failed to load audit log (HTTP ${listRes.status})`
    }
    if (keysRes.ok) {
      const data = (await keysRes.json()) as { byKey: KeyCountMap }
      keyCounts = data.byKey ?? {}
    }
  } catch (err: any) {
    loadError = err?.message ?? String(err)
  }

  return (
    <AuditClient
      initial={items}
      initialTotal={total}
      initialKeyCounts={keyCounts}
      initialError={loadError}
    />
  )
}
