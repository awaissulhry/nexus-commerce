import { notFound } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
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

  // PERF — these three reads are independent; fetch them in one parallel
  // round instead of three sequential server round trips (~3x the latency).
  const [familyRes, attributesRes, effectiveRes] = await Promise.allSettled([
    fetch(`${backend}/api/families/${id}`, { cache: 'no-store' }),
    fetch(`${backend}/api/attributes`, { cache: 'no-store' }),
    fetch(`${backend}/api/families/${id}/effective`, { cache: 'no-store' }),
  ])

  // family (required — 404s the route if missing)
  if (familyRes.status === 'fulfilled') {
    const res = familyRes.value
    if (res.status === 404) notFound()
    if (!res.ok) errors.push(`Failed to load family (HTTP ${res.status})`)
    else {
      const data = (await res.json()) as { family?: FamilyDetail }
      family = data.family ?? null
    }
  } else {
    errors.push(familyRes.reason?.message ?? String(familyRes.reason))
  }

  // attribute pool
  if (attributesRes.status === 'fulfilled') {
    const res = attributesRes.value
    if (!res.ok) errors.push(`Failed to load attribute pool (HTTP ${res.status})`)
    else {
      const data = (await res.json()) as { attributes?: AttributeRow[] }
      attributes = data.attributes ?? []
    }
  } else {
    errors.push(attributesRes.reason?.message ?? String(attributesRes.reason))
  }

  // effective inheritance preview (best-effort, non-critical)
  if (effectiveRes.status === 'fulfilled' && effectiveRes.value.ok) {
    const data = (await effectiveRes.value.json()) as { attributes?: EffectiveAttribute[] }
    effective = data.attributes ?? []
  }

  if (!family) notFound()

  // The shell header above shows "Product families" (parent nav).
  // Per-row identity (the family's own label + description) goes
  // here so a parent + child page still feels distinct.
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          {family.label}
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">
          {family.description ??
            `Akeneo-style family. Attach attributes here; ${family.parentFamily ? 'inherits ' + (effective.length - family.familyAttributes.length) + ' more from ancestors. ' : ''}Children of this family inherit ALL of these (additive, parent-wins on conflict).`}
        </p>
      </div>
      <FamilyEditorClient
        family={family}
        attributePool={attributes}
        initialEffective={effective}
        initialError={errors.length > 0 ? errors.join(' · ') : null}
      />
    </div>
  )
}
