import { getBackendUrl } from '@/lib/backend-url'
import PageHeader from '@/components/layout/PageHeader'
import { getServerT } from '@/lib/i18n/server'
import WorkflowsClient, { type WorkflowRow } from './WorkflowsClient'

export const dynamic = 'force-dynamic'

export default async function WorkflowsSettingsPage() {
  const t = await getServerT()
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
        title={t('pim.workflows.title')}
        subtitle={t('pim.workflows.subtitle')}
        breadcrumbs={[
          { label: 'Settings', href: '/settings/account' },
          { label: 'PIM', href: '/settings/pim/families' },
          { label: t('pim.workflows.title') },
        ]}
      />
      <WorkflowsClient initial={initial} initialError={loadError} />
    </div>
  )
}
