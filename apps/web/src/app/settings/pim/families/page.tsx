import { getBackendUrl } from '@/lib/backend-url'
import PageHeader from '@/components/layout/PageHeader'
import { getServerT } from '@/lib/i18n/server'
import FamiliesClient, { type FamilyRow } from './FamiliesClient'

export const dynamic = 'force-dynamic'

export default async function FamiliesSettingsPage() {
  const t = await getServerT()
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
        title={t('pim.families.title')}
        subtitle={t('pim.families.subtitle')}
        breadcrumbs={[
          { label: 'Settings', href: '/settings/account' },
          { label: 'PIM', href: '/settings/pim/families' },
          { label: t('pim.families.title') },
        ]}
      />
      <FamiliesClient initial={initial} initialError={loadError} />
    </div>
  )
}
