import { getBackendUrl } from '@/lib/backend-url'
import AttributesClient, {
  type AttributeGroupRow,
  type AttributeRow,
} from './AttributesClient'

export const dynamic = 'force-dynamic'

export default async function AttributesSettingsPage() {
  const backend = getBackendUrl()
  const errors: string[] = []

  let groups: AttributeGroupRow[] = []
  let attributes: AttributeRow[] = []

  try {
    const res = await fetch(`${backend}/api/attribute-groups`, {
      cache: 'no-store',
    })
    if (!res.ok) errors.push(`Failed to load groups (HTTP ${res.status})`)
    else {
      const data = (await res.json()) as { groups?: AttributeGroupRow[] }
      groups = data.groups ?? []
    }
  } catch (err: any) {
    errors.push(err?.message ?? String(err))
  }

  try {
    const res = await fetch(`${backend}/api/attributes`, { cache: 'no-store' })
    if (!res.ok) errors.push(`Failed to load attributes (HTTP ${res.status})`)
    else {
      const data = (await res.json()) as { attributes?: AttributeRow[] }
      attributes = data.attributes ?? []
    }
  } catch (err: any) {
    errors.push(err?.message ?? String(err))
  }

  return (
    <AttributesClient
      initialGroups={groups}
      initialAttributes={attributes}
      initialError={errors.length > 0 ? errors.join(' · ') : null}
    />
  )
}
