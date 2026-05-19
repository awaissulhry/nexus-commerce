import { getBackendUrl } from '@/lib/backend-url'
import TerminologyClient, { type TerminologyItem } from './TerminologyClient'

export const dynamic = 'force-dynamic'

export default async function TerminologySettingsPage() {
  const backend = getBackendUrl()
  let initial: TerminologyItem[] = []
  let loadError: string | null = null
  try {
    const res = await fetch(`${backend}/api/terminology`, { cache: 'no-store' })
    if (!res.ok) {
      loadError = `Failed to load terminology preferences (HTTP ${res.status})`
    } else {
      const data = (await res.json()) as { items?: TerminologyItem[] }
      initial = data.items ?? []
    }
  } catch (err: any) {
    loadError = err?.message ?? String(err)
  }

  return <TerminologyClient initial={initial} initialError={loadError} />
}
