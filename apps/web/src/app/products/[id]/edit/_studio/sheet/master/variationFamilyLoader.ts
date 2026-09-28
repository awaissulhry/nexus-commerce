/**
 * Sheet pop-up rebuild P2 — the family behind the master variation-theme cell, for the pop-up's value chips and variant list.
 *
 * ONE read: the photo plan's own family route (`GET /api/products/:id/media`, images lane, read only here). It already
 * answers what the pop-up needs, in the dictionary's terms: each axis's attribute code, its values as option codes in the
 * family's saved order (`Product.variationValueOrder` first), each variant's values, the photo library, and the Shared
 * plan's photo per value. Nothing here writes.
 */
import type { VariationFamilyView } from '@/design-system/grid'
import { getBackendUrl } from '@/lib/backend-url'

/** The slice of the media read this loader uses. */
export interface MediaFamilyRead {
  family: {
    /** The photo axis the media plan picks by default (colour first). */
    defaultAxis?: string | null
    axes: Array<{ code: string; label: string; dictionary: boolean; values: Array<{ key: string; label: string }> }>
    variants: Array<{ productId: string; sku: string; values: Record<string, string> }>
  }
  library?: Array<{ id: string; productId: string; url: string; mediaType?: string | null; isPrimary?: boolean | null }>
  layers?: Array<{ layer: string; plan?: { axis?: string | null; sets?: { values?: Record<string, Array<{ assetId: string }>> } } }>
}

/** A value's option code: `color:black` → `black`; a value the dictionary lacks (`color:text:…`) has none. */
const optionOf = (axisCode: string, key: string, dictionary: boolean) =>
  dictionary && key.startsWith(`${axisCode}:`) && !key.startsWith(`${axisCode}:text:`) ? key.slice(axisCode.length + 1) : null

export function variationFamilyFromMedia(read: MediaFamilyRead): VariationFamilyView {
  const library = (read.library ?? []).filter((a) => !a.mediaType || a.mediaType === 'IMAGE')
  const url = new Map(library.map((a) => [a.id, a.url]))
  /** A product's own photo: its primary image, else its first (the library comes in the product's order). */
  const own = (productId: string) => {
    const mine = library.filter((a) => a.productId === productId)
    return (mine.find((a) => a.isPrimary) ?? mine[0])?.url ?? null
  }
  const sharedPlan = read.layers?.find((l) => l.layer === 'SHARED')?.plan
  const sharedSets = sharedPlan?.sets?.values ?? {}
  /* Photos only on the PHOTO axis (Owner, 2026-09-28: "We do not need to have images for the size chips"): the axis the
     Shared plan names, else the one the plan would pick (colour first). `null` on the plan = one gallery, no value photos. */
  const photoAxis = sharedPlan && sharedPlan.axis !== undefined ? sharedPlan.axis : read.family.defaultAxis ?? null
  const planPhoto = (key: string) => {
    const first = sharedSets[key]?.[0]?.assetId
    return first ? url.get(first) ?? null : null
  }
  const variants = read.family.variants
  const axes = read.family.axes.map((axis) => ({
    code: axis.code,
    label: axis.label,
    dictionary: axis.dictionary,
    values: axis.values.map((value) => {
      const carriers = variants.filter((v) => v.values[axis.code] === value.key)
      /* The plan's photo for the value first (what the Media page shows), else the first variant that carries it. */
      const photo = axis.code !== photoAxis ? null : planPhoto(value.key) ?? carriers.map((v) => own(v.productId)).find(Boolean) ?? null
      return { key: value.key, option: optionOf(axis.code, value.key, axis.dictionary), label: value.label, count: carriers.length, photo }
    }),
  }))
  const labelOf = new Map(axes.flatMap((a) => a.values.map((v) => [v.key, v.label] as const)))
  return {
    axes,
    variants: variants.map((v) => ({
      id: v.productId,
      sku: v.sku,
      label: axes.map((a) => labelOf.get(v.values[a.code] ?? '')).filter(Boolean).join(' · ') || 'No values',
      photo: own(v.productId) ?? axes.map((a) => planPhoto(v.values[a.code] ?? '')).find(Boolean) ?? null,
    })),
  }
}

/** The loader the master variation-theme column hands its editor. One read per opening; nothing is cached. */
export async function loadVariationFamily(familyId: string): Promise<VariationFamilyView> {
  const res = await fetch(`${getBackendUrl()}/api/products/${encodeURIComponent(familyId)}/media`, {
    credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(30_000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `the family read failed (${res.status})`)
  return variationFamilyFromMedia(body as MediaFamilyRead)
}
