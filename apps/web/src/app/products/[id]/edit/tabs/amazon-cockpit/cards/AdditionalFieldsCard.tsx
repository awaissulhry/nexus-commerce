'use client'

// AdditionalFieldsCard — surfaces flat-file manifest fields that are
// REQUIRED or RECOMMENDED but not yet covered by any dedicated cockpit
// card. Renders a collapsible card listing those fields with a link to
// the flat-file editor where the operator can fill them.
//
// If no uncovered required/recommended fields exist (or productType is
// null), the component renders nothing.

import { useEffect, useState } from 'react'
import { ExternalLink, ChevronDown, ChevronUp, AlertCircle } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { getBackendUrl } from '@/lib/backend-url'

interface ManifestColumn {
  id: string
  fieldRef: string
  labelEn: string
  required: 'REQUIRED' | 'RECOMMENDED' | 'OPTIONAL'
  kind: 'text' | 'longtext' | 'number' | 'enum' | 'boolean'
  options?: string[]
  maxLength?: number
}

interface ManifestGroup {
  label: string
  columns: ManifestColumn[]
}

interface ManifestResponse {
  groups: ManifestGroup[]
}

// Fields already covered by existing cockpit cards — skip these.
const COVERED_FIELDS = new Set([
  'item_sku',
  'item_name',
  'product_description',
  'bullet_point',
  'our_price',
  'brand_name',
  'external_product_id',
  'external_product_id_type',
  'condition_type',
  'product_site_launch_date',
  'item_type',
  'browse_node',
  'browse_node2',
  'main_image_url',
  'other_image_url1',
  'other_image_url2',
  'other_image_url3',
  'other_image_url4',
  'other_image_url5',
  'other_image_url6',
  'other_image_url7',
  'other_image_url8',
  'variation_theme',
  'fulfillment_channel_code',
  'merchant_shipping_group_name',
  'quantity',
])

const MAX_FIELDS = 20

interface Props {
  productId: string
  marketplace: string
  productType: string | null
  listingId: string | null
  onSaved: () => void
}

export default function AdditionalFieldsCard({
  productId,
  marketplace,
  productType,
}: Props) {
  const [manifest, setManifest] = useState<ManifestResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(true)

  useEffect(() => {
    if (!productType) return

    let cancelled = false
    setLoading(true)
    setError(null)

    const url = `${getBackendUrl()}/api/amazon/flat-file/template?marketplace=${encodeURIComponent(marketplace)}&productType=${encodeURIComponent(productType)}`

    fetch(url, { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<ManifestResponse>
      })
      .then((data) => {
        if (!cancelled) {
          setManifest(data)
          setLoading(false)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load template')
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [marketplace, productType])

  // Nothing to show if no productType or still loading
  if (!productType) return null
  if (loading) return null
  if (error) return null
  if (!manifest) return null

  // Collect uncovered required/recommended fields (up to MAX_FIELDS)
  const uncovered: ManifestColumn[] = []
  for (const group of manifest.groups) {
    for (const col of group.columns) {
      if (col.required === 'OPTIONAL') continue
      if (COVERED_FIELDS.has(col.fieldRef)) continue
      uncovered.push(col)
      if (uncovered.length >= MAX_FIELDS) break
    }
    if (uncovered.length >= MAX_FIELDS) break
  }

  if (uncovered.length === 0) return null

  const flatFileUrl = `/products/amazon-flat-file?marketplace=${encodeURIComponent(marketplace)}${productType ? `&productType=${encodeURIComponent(productType)}` : ''}&productId=${encodeURIComponent(productId)}`

  const requiredCount = uncovered.filter((c) => c.required === 'REQUIRED').length
  const recommendedCount = uncovered.filter((c) => c.required === 'RECOMMENDED').length

  return (
    <Card noPadding>
      {/* Header */}
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="w-full px-4 py-2.5 border-b border-subtle dark:border-slate-800 flex items-center gap-2 text-left hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors"
        aria-expanded={!collapsed}
      >
        <AlertCircle aria-hidden className="w-4 h-4 text-amber-500 shrink-0" />
        <span className="text-md font-medium text-slate-900 dark:text-slate-100 flex-1">
          Additional Required Fields
        </span>
        <span className="inline-flex items-center gap-1.5">
          {requiredCount > 0 && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
              {requiredCount} required
            </span>
          )}
          {recommendedCount > 0 && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
              {recommendedCount} recommended
            </span>
          )}
        </span>
        {collapsed ? (
          <ChevronDown aria-hidden className="w-4 h-4 text-slate-400 shrink-0" />
        ) : (
          <ChevronUp aria-hidden className="w-4 h-4 text-slate-400 shrink-0" />
        )}
      </button>

      {!collapsed && (
        <div className="p-4 space-y-3">
          {/* Field list */}
          <div className="space-y-1.5">
            {uncovered.map((col) => (
              <div
                key={col.fieldRef}
                className="flex items-center justify-between gap-3 text-xs"
              >
                <span className="text-slate-700 dark:text-slate-300 truncate min-w-0">
                  {col.labelEn}
                </span>
                <span
                  className={
                    col.required === 'REQUIRED'
                      ? 'text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300 shrink-0 font-medium'
                      : 'text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300 shrink-0 font-medium'
                  }
                >
                  {col.required === 'REQUIRED' ? 'Required' : 'Recommended'}
                </span>
              </div>
            ))}
          </div>

          {/* Footer note + link */}
          <p className="text-[11px] text-slate-500 dark:text-slate-400 pt-1">
            These fields can be filled in the Flat File editor.
          </p>
          <a
            href={flatFileUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-block"
          >
            <Button size="sm" variant="secondary" icon={<ExternalLink className="w-3.5 h-3.5" />}>
              Open Flat File Editor
            </Button>
          </a>
        </div>
      )}
    </Card>
  )
}
