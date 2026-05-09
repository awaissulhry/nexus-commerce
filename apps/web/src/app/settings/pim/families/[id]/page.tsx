import { notFound } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import PageHeader from '@/components/layout/PageHeader'
import FamilyEditorClient, {
  type FamilyDetail,
  type AttributeRow,
  type EffectiveAttribute,
} from './FamilyEditorClient'

export const dynamic = 'force-dynamic'

export default async function FamilyEditorPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const backend = getBackendUrl()

  const errors: string[] = []
  let family: FamilyDetail | null = null
  let attributes: AttributeRow[] = []
  let effective: EffectiveAttribute[] = []

  try {
    const res = await fetch(`${backend}/api/families/${id}`, {
      cache: 'no-store',
    })
    if (res.status === 404) notFound()
    if (!res.ok)
      errors.push(`Failed to load family (HTTP ${res.status})`)
    else {
      const data = (await res.json()) as { family?: FamilyDetail }
      family = data.family ?? null
    }
  } catch (err: any) {
    errors.push(err?.message ?? String(err))
  }

  try {
    const res = await fetch(`${backend}/api/attributes`, { cache: 'no-store' })
    if (!res.ok) errors.push(`Failed to load attribute pool (HTTP ${res.status})`)
    else {
      const data = (await res.json()) as { attributes?: AttributeRow[] }
      attributes = data.attributes ?? []
    }
  } catch (err: any) {
    errors.push(err?.message ?? String(err))
  }

  try {
    const res = await fetch(`${backend}/api/families/${id}/effective`, {
      cache: 'no-store',
    })
    if (res.ok) {
      const data = (await res.json()) as { attributes?: EffectiveAttribute[] }
      effective = data.attributes ?? []
    }
  } catch {
    // Best-effort — inheritance preview is non-critical.
  }

  if (!family) notFound()

  return (
    <div>
      <PageHeader
        title={family.label}
        subtitle={
          family.description ??
          `Akeneo-style family. Attach attributes here; ${family.parentFamily ? 'inherits ' + (effective.length - family.familyAttributes.length) + ' more from ancestors. ' : ''}Children of this family inherit ALL of these (additive, parent-wins on conflict).`
        }
        breadcrumbs={[
          { label: 'Settings', href: '/settings/account' },
          { label: 'PIM', href: '/settings/pim/families' },
          { label: 'Families', href: '/settings/pim/families' },
          { label: family.label },
        ]}
      />
      <FamilyEditorClient
        family={family}
        attributePool={attributes}
        initialEffective={effective}
        initialError={errors.length > 0 ? errors.join(' · ') : null}
      />
    </div>
  )
}
