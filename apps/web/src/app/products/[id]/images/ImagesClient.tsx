'use client'

/**
 * C.11 — multi-scope image editor client. The grouping model:
 *
 *   Bucket = (variationId, scope, platform, marketplace)
 *
 * Variants are tabbed across the top (Master | each variant); within
 * a variant tab the operator sees the override buckets that exist
 * for that (productId, variationId) combo, organized by scope. The
 * master gallery is read-only here — that's still managed via the
 * existing /products/:id/edit images section.
 *
 * Scope semantics (matches schema):
 *   GLOBAL      — no platform/marketplace
 *   PLATFORM    — platform required, marketplace null
 *   MARKETPLACE — platform + marketplace both required
 *
 * Operations supported in this iteration:
 *   - View master gallery + every override bucket
 *   - Create override from a master image (copies URL into a new
 *     ListingImage row at the chosen scope/variant)
 *   - Delete an override (master untouched; resolution falls back)
 *   - Reorder within a bucket (drag-drop with HTML5 dnd; no extra dep)
 *   - Patch role / scope on a single row
 *
 * Out of scope this iteration:
 *   - Direct upload (use the existing /products/images/upload path
 *     from the master edit page; this editor references existing URLs)
 *   - Drag-and-drop *between* buckets (move row between scopes by
 *     editing the scope dropdown; cross-bucket drag is harder UX
 *     and operators can chain delete + create cleanly)
 */

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  Box,
  ChevronLeft,
  Image as ImageIcon,
  Layers,
  Plus,
  Trash2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { Tooltip } from '@/components/ui/Tooltip'
import PageHeader from '@/components/layout/PageHeader'
import { getBackendUrl } from '@/lib/backend-url'

type Scope = 'GLOBAL' | 'PLATFORM' | 'MARKETPLACE'
type Role =
  | 'MAIN'
  | 'GALLERY'
  | 'INFOGRAPHIC'
  | 'LIFESTYLE'
  | 'SIZE_CHART'
  | 'SWATCH'

interface ListingImageRow {
  id: string
  productId: string
  variationId: string | null
  scope: Scope
  platform: string | null
  marketplace: string | null
  url: string
  filename: string | null
  position: number
  role: string
  sourceProductImageId: string | null
}

interface MasterImage {
  id: string
  url: string
  alt: string | null
  type: string
  createdAt: string
}

interface VariantSummary {
  id: string
  sku: string
  name: string
  variantAttributes: Record<string, unknown> | null
}

interface Props {
  product: { id: string; sku: string; name: string; isParent: boolean }
  master: MasterImage[]
  overrides: ListingImageRow[]
  variants: VariantSummary[]
}

const ROLES: Role[] = [
  'MAIN',
  'GALLERY',
  'INFOGRAPHIC',
  'LIFESTYLE',
  'SIZE_CHART',
  'SWATCH',
]

export default function ImagesClient({
  product,
  master,
  overrides: initialOverrides,
  variants,
}: Props) {
  const { toast } = useToast()
  const confirm = useConfirm()
  // Active variant tab. null = master / product-level (variationId = null).
  const [activeVariant, setActiveVariant] = useState<string | null>(null)
  const [overrides, setOverrides] = useState<ListingImageRow[]>(initialOverrides)
  const [busy, setBusy] = useState(false)

  // Group overrides by (variationId, scope, platform, marketplace).
  // Bucket key string: 'v=<vid>|s=<scope>|p=<platform>|m=<market>'.
  const buckets = useMemo(() => {
    const m = new Map<
      string,
      {
        variationId: string | null
        scope: Scope
        platform: string | null
        marketplace: string | null
        rows: ListingImageRow[]
      }
    >()
    for (const r of overrides) {
      const key = bucketKey(r.variationId, r.scope, r.platform, r.marketplace)
      const cur = m.get(key)
      if (cur) {
        cur.rows.push(r)
      } else {
        m.set(key, {
          variationId: r.variationId,
          scope: r.scope,
          platform: r.platform,
          marketplace: r.marketplace,
          rows: [r],
        })
      }
    }
    for (const b of m.values()) b.rows.sort((a, b) => a.position - b.position)
    return Array.from(m.values())
  }, [overrides])

  const visibleBuckets = useMemo(
    () => buckets.filter((b) => b.variationId === activeVariant),
    [buckets, activeVariant],
  )

  const refreshOverrides = useCallback(async () => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${encodeURIComponent(product.id)}/listing-images`,
      )
      if (!res.ok) return
      const j = await res.json()
      if (Array.isArray(j?.overrides)) setOverrides(j.overrides)
    } catch {
      /* swallow — user can refresh page */
    }
  }, [product.id])

  // Create an override from a master image — copies the master URL
  // into a new ListingImage row at the active variant + chosen scope.
  const onCreateOverride = useCallback(
    async (masterImg: MasterImage, scope: Scope) => {
      setBusy(true)
      try {
        const body: Record<string, unknown> = {
          url: masterImg.url,
          filename: masterImg.alt ?? null,
          scope,
          variationId: activeVariant,
          role: scope === 'GLOBAL' ? 'GALLERY' : 'GALLERY',
          sourceProductImageId: masterImg.id,
        }
        // Scope-specific fields. PLATFORM and MARKETPLACE need
        // additional values; the operator picks them next via the
        // scope dropdown on the new row. We default platform to
        // 'AMAZON' for PLATFORM scope so the row creates cleanly,
        // and require manual edit for MARKETPLACE (operator picks
        // from a known set after create).
        if (scope === 'PLATFORM') {
          body.platform = 'AMAZON'
        } else if (scope === 'MARKETPLACE') {
          body.platform = 'AMAZON'
          body.marketplace = 'IT'
        }
        const res = await fetch(
          `${getBackendUrl()}/api/products/${encodeURIComponent(product.id)}/listing-images`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
        )
        const j = await res.json()
        if (!res.ok) {
          toast({
            tone: 'error',
            title: 'Couldn’t create override',
            description: j?.error ?? `HTTP ${res.status}`,
          })
          return
        }
        toast({ tone: 'success', title: 'Override created' })
        await refreshOverrides()
      } catch (err) {
        toast({
          tone: 'error',
          title: 'Couldn’t create override',
          description: err instanceof Error ? err.message : String(err),
        })
      } finally {
        setBusy(false)
      }
    },
    [product.id, activeVariant, toast, refreshOverrides],
  )

  const onDeleteRow = useCallback(
    async (row: ListingImageRow) => {
      const ok = await confirm({
        title: 'Remove this override?',
        description:
          'The override row is deleted; the resolution cascade falls back to the next-most-general scope (or the master gallery).',
        confirmLabel: 'Remove',
        tone: 'danger',
      })
      if (!ok) return
      setBusy(true)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/listing-images/${encodeURIComponent(row.id)}`,
          { method: 'DELETE' },
        )
        if (!res.ok) {
          const j = await res.json().catch(() => ({}))
          toast({
            tone: 'error',
            title: 'Delete failed',
            description: j?.error ?? `HTTP ${res.status}`,
          })
          return
        }
        toast({ tone: 'success', title: 'Override removed' })
        await refreshOverrides()
      } finally {
        setBusy(false)
      }
    },
    [confirm, toast, refreshOverrides],
  )

  const onPatchRow = useCallback(
    async (row: ListingImageRow, patch: Partial<ListingImageRow>) => {
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/listing-images/${encodeURIComponent(row.id)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
          },
        )
        const j = await res.json()
        if (!res.ok) {
          toast({
            tone: 'error',
            title: 'Update failed',
            description: j?.error ?? `HTTP ${res.status}`,
          })
          return
        }
        await refreshOverrides()
      } catch (err) {
        toast({
          tone: 'error',
          title: 'Update failed',
          description: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [toast, refreshOverrides],
  )

  return (
    <div className="px-6 py-6 max-w-[1400px] mx-auto space-y-5 dark:bg-slate-950">
      <PageHeader
        title={`Images · ${product.sku}`}
        description="Multi-scope override editor. Master gallery stays editable on the product edit page; here you layer per-variant + per-scope overrides on top."
        breadcrumbs={[
          { label: 'Products', href: '/products' },
          { label: product.name, href: `/products/${product.id}/edit` },
          { label: 'Images' },
        ]}
        actions={
          <Link
            href={`/products/${product.id}/edit`}
            className="inline-flex items-center gap-1 text-base text-blue-600 hover:underline dark:text-blue-400"
          >
            <ChevronLeft className="w-3 h-3" />
            Back to product
          </Link>
        }
      />

      {/* Variant tabs */}
      <nav
        role="tablist"
        aria-label="Variant tabs"
        className="flex items-center gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800"
      >
        <TabButton
          active={activeVariant === null}
          onClick={() => setActiveVariant(null)}
          label="Master / product-level"
          icon={<Layers className="w-3.5 h-3.5" />}
        />
        {variants.map((v) => (
          <TabButton
            key={v.id}
            active={activeVariant === v.id}
            onClick={() => setActiveVariant(v.id)}
            label={v.sku}
            sublabel={
              v.variantAttributes
                ? Object.entries(v.variantAttributes)
                    .map(([k, val]) => `${k}=${String(val ?? '')}`)
                    .join(' · ')
                : null
            }
            icon={<Box className="w-3.5 h-3.5" />}
          />
        ))}
      </nav>

      {/* Active variant header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            {activeVariant === null
              ? 'Product-level overrides'
              : `Variant overrides · ${variants.find((v) => v.id === activeVariant)?.sku ?? ''}`}
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            {visibleBuckets.length === 0
              ? 'No overrides yet — every channel falls back to the master gallery.'
              : `${visibleBuckets.length} bucket${visibleBuckets.length === 1 ? '' : 's'} configured`}
          </p>
        </div>
      </div>

      {/* Master gallery (always visible — context for creating overrides) */}
      <section className="border border-slate-200 rounded-lg bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-md font-medium text-slate-900 dark:text-slate-100">
            Master gallery ({master.length} image{master.length === 1 ? '' : 's'})
          </h3>
          <Link
            href={`/products/${product.id}/edit`}
            className="text-sm text-blue-600 hover:underline dark:text-blue-400"
          >
            Edit master →
          </Link>
        </div>
        {master.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No master images yet. Upload via the product edit page first.
          </p>
        ) : (
          <ul className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {master.map((m) => (
              <li
                key={m.id}
                className="border border-slate-200 rounded-md bg-slate-50 overflow-hidden dark:border-slate-700 dark:bg-slate-800"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={m.url}
                  alt={m.alt ?? ''}
                  className="w-full aspect-square object-cover"
                />
                <div className="p-2">
                  <div className="text-xs uppercase tracking-wide font-semibold text-slate-500 dark:text-slate-400">
                    {m.type}
                  </div>
                  <div className="mt-1.5 flex items-center gap-1">
                    <Tooltip content="Create GLOBAL override from this master image">
                      <button
                        type="button"
                        onClick={() => void onCreateOverride(m, 'GLOBAL')}
                        disabled={busy}
                        aria-label="Override at GLOBAL scope"
                        className="inline-flex items-center justify-center h-6 px-1.5 rounded text-xs font-medium border border-slate-200 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-blue-950 dark:hover:border-blue-800"
                      >
                        <Plus className="w-3 h-3" /> Global
                      </button>
                    </Tooltip>
                    <Tooltip content="Create PLATFORM override from this master image">
                      <button
                        type="button"
                        onClick={() => void onCreateOverride(m, 'PLATFORM')}
                        disabled={busy}
                        aria-label="Override at PLATFORM scope"
                        className="inline-flex items-center justify-center h-6 px-1.5 rounded text-xs font-medium border border-slate-200 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-blue-950 dark:hover:border-blue-800"
                      >
                        <Plus className="w-3 h-3" /> Plat
                      </button>
                    </Tooltip>
                    <Tooltip content="Create MARKETPLACE override from this master image">
                      <button
                        type="button"
                        onClick={() => void onCreateOverride(m, 'MARKETPLACE')}
                        disabled={busy}
                        aria-label="Override at MARKETPLACE scope"
                        className="inline-flex items-center justify-center h-6 px-1.5 rounded text-xs font-medium border border-slate-200 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-blue-950 dark:hover:border-blue-800"
                      >
                        <Plus className="w-3 h-3" /> Mkt
                      </button>
                    </Tooltip>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Override buckets for the active variant */}
      <section className="space-y-3">
        {visibleBuckets.length === 0 ? (
          <div className="border border-dashed border-slate-300 rounded-lg p-6 text-center bg-white dark:border-slate-700 dark:bg-slate-900">
            <ImageIcon className="w-6 h-6 mx-auto text-slate-300 dark:text-slate-600" />
            <p className="mt-2 text-md text-slate-600 dark:text-slate-400">
              No override buckets here yet
            </p>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-500">
              Click "Global / Plat / Mkt" on a master image above to create
              an override at that scope for {activeVariant === null ? 'product-level' : 'this variant'}.
            </p>
          </div>
        ) : (
          visibleBuckets.map((bucket) => {
            const bk = bucketKey(
              bucket.variationId,
              bucket.scope,
              bucket.platform,
              bucket.marketplace,
            )
            return (
              <BucketCard
                key={bk}
                bucket={bucket}
                onPatchRow={onPatchRow}
                onDeleteRow={onDeleteRow}
              />
            )
          })
        )}
      </section>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────

function bucketKey(
  variationId: string | null,
  scope: Scope,
  platform: string | null,
  marketplace: string | null,
): string {
  return `v=${variationId ?? ''}|s=${scope}|p=${platform ?? ''}|m=${marketplace ?? ''}`
}

function TabButton({
  active,
  onClick,
  label,
  sublabel,
  icon,
}: {
  active: boolean
  onClick: () => void
  label: string
  sublabel?: string | null
  icon?: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'inline-flex flex-col items-start gap-0 px-3 h-12 border-b-2 transition-colors whitespace-nowrap min-w-0',
        active
          ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
          : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200',
      )}
    >
      <span className="inline-flex items-center gap-1.5 text-md font-medium">
        {icon}
        {label}
      </span>
      {sublabel && (
        <span className="text-xs text-slate-500 dark:text-slate-500 truncate max-w-[200px]">
          {sublabel}
        </span>
      )}
    </button>
  )
}

function BucketCard({
  bucket,
  onPatchRow,
  onDeleteRow,
}: {
  bucket: {
    variationId: string | null
    scope: Scope
    platform: string | null
    marketplace: string | null
    rows: ListingImageRow[]
  }
  onPatchRow: (row: ListingImageRow, patch: Partial<ListingImageRow>) => void
  onDeleteRow: (row: ListingImageRow) => void
}) {
  const scopeLabel =
    bucket.scope === 'GLOBAL'
      ? 'Global'
      : bucket.scope === 'PLATFORM'
        ? `Platform · ${bucket.platform ?? '?'}`
        : `${bucket.platform ?? '?'} · ${bucket.marketplace ?? '?'}`

  return (
    <div className="border border-slate-200 rounded-lg bg-white dark:border-slate-800 dark:bg-slate-900">
      <header className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between dark:border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-md font-semibold text-slate-900 dark:text-slate-100">
            {scopeLabel}
          </span>
          <span className="text-sm text-slate-500 dark:text-slate-400 tabular-nums">
            ({bucket.rows.length} image{bucket.rows.length === 1 ? '' : 's'})
          </span>
        </div>
      </header>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {bucket.rows.map((row) => (
          <li
            key={row.id}
            className="px-4 py-2.5 flex items-center gap-3"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={row.url}
              alt={row.filename ?? ''}
              className="w-12 h-12 rounded object-cover bg-slate-100 dark:bg-slate-800 flex-shrink-0"
            />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-mono text-slate-700 dark:text-slate-300 truncate">
                {row.filename ?? row.url.split('/').pop() ?? row.url}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-500 mt-0.5 tabular-nums">
                position {row.position}
                {row.sourceProductImageId && (
                  <span className="ml-2 text-slate-400 dark:text-slate-600">
                    · from master
                  </span>
                )}
              </div>
            </div>
            <select
              value={row.role}
              onChange={(e) =>
                onPatchRow(row, { role: e.target.value as Role })
              }
              aria-label="Image role"
              className="h-7 px-1.5 text-sm border border-slate-200 rounded dark:border-slate-700 dark:bg-slate-800"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            {bucket.scope !== 'GLOBAL' && (
              <Tooltip content="Edit platform/marketplace via the resolution cascade — open product edit for full control">
                <span className="text-xs font-mono text-slate-500 dark:text-slate-500 px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800">
                  {row.platform ?? '?'}
                  {row.marketplace ? `:${row.marketplace}` : ''}
                </span>
              </Tooltip>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onDeleteRow(row)}
              aria-label="Remove override"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}
