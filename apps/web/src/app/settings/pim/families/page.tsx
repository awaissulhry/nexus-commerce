import { getBackendUrl } from '@/lib/backend-url'
import PageHeader from '@/components/layout/PageHeader'
import FamiliesClient, { type FamilyRow } from './FamiliesClient'

export const dynamic = 'force-dynamic'

export default async function FamiliesSettingsPage() {
  const backend = getBackendUrl()
  let initial: FamilyRow[] = []
  let loadError: string | null = null
  try {
    const res = await fetch(`${backend}/api/families`, { cache: 'no-store' })
    if (!res.ok) {
      loadError = `Failed to load product families (HTTP ${res.status})`
    } else {
      const data = (await res.json()) as { families?: FamilyRow[] }
      initial = data.families ?? []
    }
  } catch (err: any) {
    loadError = err?.message ?? String(err)
  }

  return (
    <div>
      <PageHeader
        title="Product families"
        subtitle="Akeneo-style PIM templates. A family declares which attribute groups + attributes apply to a product type, with required-vs-optional + per-channel rules. Children inherit from parents (additive — children can ADD but never remove or downgrade)."
        breadcrumbs={[
          { label: 'Settings', href: '/settings/account' },
          { label: 'PIM', href: '/settings/pim/families' },
          { label: 'Families' },
        ]}
      />
      <FamiliesClient initial={initial} initialError={loadError} />
    </div>
  )
}
