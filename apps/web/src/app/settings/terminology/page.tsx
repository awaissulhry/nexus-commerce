import { getBackendUrl } from '@/lib/backend-url'
import PageHeader from '@/components/layout/PageHeader'
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

  return (
    <div>
      <PageHeader
        title="Terminology preferences"
        subtitle="Brand-specific glossary fed into AI listing generation. Use this to keep the model from drifting (e.g. Giubbotto vs Giacca for motorcycle jackets in IT)."
        breadcrumbs={[
          { label: 'Settings', href: '/settings/account' },
          { label: 'Terminology' },
        ]}
      />
      <TerminologyClient initial={initial} initialError={loadError} />
    </div>
  )
}
