import { getBackendUrl } from '@/lib/backend-url'
import WorkflowsClient, { type WorkflowRow } from './WorkflowsClient'

export const dynamic = 'force-dynamic'

export default async function WorkflowsSettingsPage() {
  const backend = getBackendUrl()
  let initial: WorkflowRow[] = []
  let loadError: string | null = null
  try {
    const res = await fetch(`${backend}/api/workflows`, { cache: 'no-store' })
    if (!res.ok) {
      loadError = `Failed to load workflows (HTTP ${res.status})`
    } else {
      const data = (await res.json()) as { workflows?: WorkflowRow[] }
      initial = data.workflows ?? []
    }
  } catch (err: any) {
    loadError = err?.message ?? String(err)
  }

  return <WorkflowsClient initial={initial} initialError={loadError} />
}
