import { getBackendUrl } from '@/lib/backend-url'
import PageHeader from '@/components/layout/PageHeader'
import { getServerT } from '@/lib/i18n/server'
import DamClient, { type AssetRow } from './DamClient'

export const dynamic = 'force-dynamic'

export default async function DamSettingsPage() {
  const t = await getServerT()
  const backend = getBackendUrl()
  let initial: AssetRow[] = []
  let nextCursor: string | null = null
  let loadError: string | null = null
  try {
    const res = await fetch(`${backend}/api/assets?limit=50`, {
      cache: 'no-store',
    })
    if (!res.ok) {
      loadError = `Failed to load assets (HTTP ${res.status})`
    } else {
      const data = (await res.json()) as {
        assets?: AssetRow[]
        nextCursor?: string | null
      }
      initial = data.assets ?? []
      nextCursor = data.nextCursor ?? null
    }
  } catch (err: any) {
    loadError = err?.message ?? String(err)
  }

  return (
    <div>
      <PageHeader
        title={t('pim.dam.title')}
        subtitle={t('pim.dam.subtitle')}
        breadcrumbs={[
          { label: 'Settings', href: '/settings/account' },
          { label: 'DAM' },
        ]}
      />
      <DamClient
        initial={initial}
        initialCursor={nextCursor}
        initialError={loadError}
      />
    </div>
  )
}
