import { getBackendUrl } from '@/lib/backend-url'
import PageHeader from '@/components/layout/PageHeader'
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

  return (
    <div>
      <PageHeader
        title="Workflows"
        subtitle="Salesforce-parity content-quality pipelines. A workflow is a configurable sequence of stages (DRAFT → REVIEW → APPROVED → PUBLISHED) attached to a family. Products joining the family land on the workflow's initial stage and progress through transitions. Distinct from product status — status is what the marketplace sees; workflow is the internal gate before publishing."
        breadcrumbs={[
          { label: 'Settings', href: '/settings/account' },
          { label: 'PIM', href: '/settings/pim/families' },
          { label: 'Workflows' },
        ]}
      />
      <WorkflowsClient initial={initial} initialError={loadError} />
    </div>
  )
}
