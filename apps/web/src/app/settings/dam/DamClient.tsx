'use client'

/**
 * W4.11 — DAM browse + edit UI.
 *
 * Grid view of DigitalAsset rows: thumbnail (for image type), label,
 * mimeType chip, size, usage count. Click an asset → side panel
 * with full metadata + usage list (which products + roles).
 *
 * Search by label/code/originalFilename + filter by type. Cursor-
 * paginated (50/page) so the library can scale into thousands of
 * assets without a single jumbo query.
 *
 * Upload integration with Cloudinary is intentionally NOT here —
 * the existing products-images.routes.ts owns Cloudinary today;
 * W4.11b will tee that flow to ALSO create a DigitalAsset row so
 * uploads start populating the library naturally. Until then this
 * page browses + edits + deletes existing assets (created via the
 * API directly with storageId + url provided by the caller).
 */

import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  Archive,
  FileText,
  Film,
  ImageIcon,
  Search,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

export interface AssetRow {
  id: string
  code: string | null
  label: string
  type: string
  mimeType: string
  sizeBytes: number
  storageProvider: string
  storageId: string
  url: string
  originalFilename: string | null
  metadata: unknown
  createdAt: string
  updatedAt: string
  _count?: { usages: number }
}

interface AssetDetail extends AssetRow {
  usages: Array<{
    id: string
    scope: string
    role: string
    sortOrder: number
    productId: string | null
    product: { id: string; sku: string; name: string } | null
    createdAt: string
  }>
}

interface Props {
  initial: AssetRow[]
  initialCursor: string | null
  initialError: string | null
}

const TYPE_ICONS: Record<string, typeof ImageIcon> = {
  image: ImageIcon,
  video: Film,
  document: FileText,
  model3d: Archive,
}

const TYPE_OPTIONS = ['', 'image', 'video', 'document', 'model3d'] as const

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`
  return `${(n / (1024 * 1024)).toFixed(1)}MB`
}

export default function DamClient({
  initial,
  initialCursor,
  initialError,
}: Props) {
  const [assets, setAssets] = useState<AssetRow[]>(initial)
  const [cursor, setCursor] = useState<string | null>(initialCursor)
  const [error, setError] = useState<string | null>(initialError)
  const [loadingMore, setLoadingMore] = useState(false)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('')
  const [openDetailId, setOpenDetailId] = useState<string | null>(null)
  const confirm = useConfirm()
  const { toast } = useToast()

  // Refresh on filter change.
  const refresh = useCallback(async () => {
    try {
      const qs = new URLSearchParams()
      qs.set('limit', '50')
      if (search.trim()) qs.set('search', search.trim())
      if (typeFilter) qs.set('type', typeFilter)
      const res = await fetch(
        `${getBackendUrl()}/api/assets?${qs.toString()}`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as {
        assets?: AssetRow[]
        nextCursor?: string | null
      }
      setAssets(data.assets ?? [])
      setCursor(data.nextCursor ?? null)
      setError(null)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }, [search, typeFilter])

  // Debounce search input + apply type filter changes immediately.
  useEffect(() => {
    const t = setTimeout(() => {
      void refresh()
    }, 200)
    return () => clearTimeout(t)
  }, [refresh])

  const loadMore = async () => {
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    try {
      const qs = new URLSearchParams()
      qs.set('limit', '50')
      qs.set('cursor', cursor)
      if (search.trim()) qs.set('search', search.trim())
      if (typeFilter) qs.set('type', typeFilter)
      const res = await fetch(
        `${getBackendUrl()}/api/assets?${qs.toString()}`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as {
        assets?: AssetRow[]
        nextCursor?: string | null
      }
      setAssets((prev) => [...prev, ...(data.assets ?? [])])
      setCursor(data.nextCursor ?? null)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setLoadingMore(false)
    }
  }

  const onDelete = useCallback(
    async (a: AssetRow) => {
      const ok = await confirm({
        title: `Delete asset "${a.label}"?`,
        description:
          (a._count?.usages ?? 0) > 0
            ? `${a._count?.usages} usage row${a._count?.usages === 1 ? '' : 's'} will cascade-delete (the product reference goes; the product itself is unaffected). The Cloudinary file stays — operator clears it from Cloudinary separately if needed.`
            : 'No usages attached. Cloudinary file stays — clear from Cloudinary separately if needed.',
        confirmLabel: 'Delete',
        tone: 'danger',
      })
      if (!ok) return
      try {
        const res = await fetch(`${getBackendUrl()}/api/assets/${a.id}`, {
          method: 'DELETE',
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? `HTTP ${res.status}`)
        }
        toast.success(`Deleted "${a.label}"`)
        refresh()
      } catch (e: any) {
        toast.error(`Delete failed: ${e?.message ?? String(e)}`)
      }
    },
    [confirm, refresh, toast],
  )

  return (
    <div className="space-y-4">
      {error && (
        <div className="border border-rose-200 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/40 rounded-md px-3 py-2 text-base text-rose-700 dark:text-rose-300 inline-flex items-start gap-1.5">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Filter bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search
            size={14}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search label / code / filename"
            className="h-8 pl-7 pr-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100 w-72"
          />
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="h-8 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
        >
          {TYPE_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {t === '' ? 'All types' : t}
            </option>
          ))}
        </select>
        <div className="ml-auto text-sm text-slate-500 dark:text-slate-400">
          {assets.length} shown{cursor ? ' — more available' : ''}
        </div>
      </div>

      {/* Asset grid */}
      {assets.length === 0 ? (
        <div className="border border-dashed border-slate-300 dark:border-slate-700 rounded-lg p-12 text-center">
          <ImageIcon className="w-8 h-8 mx-auto text-slate-300 dark:text-slate-600 mb-2" />
          <div className="text-md text-slate-700 dark:text-slate-300">
            No assets found.
          </div>
          <div className="text-sm text-slate-500 dark:text-slate-400 mt-1 max-w-md mx-auto">
            Cloudinary uploads will start populating the library once W4.11b
            wires the upload flow into DigitalAsset creation. Until then,
            assets are created via API only.
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
          {assets.map((a) => (
            <AssetCard
              key={a.id}
              asset={a}
              onOpen={() => setOpenDetailId(a.id)}
              onDelete={() => onDelete(a)}
            />
          ))}
        </div>
      )}

      {cursor && (
        <div className="flex justify-center pt-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={loadMore}
            disabled={loadingMore}
            loading={loadingMore}
          >
            Load 50 more
          </Button>
        </div>
      )}

      {openDetailId && (
        <AssetDetailModal
          assetId={openDetailId}
          onClose={() => setOpenDetailId(null)}
          onChanged={refresh}
        />
      )}
    </div>
  )
}

function AssetCard({
  asset,
  onOpen,
  onDelete,
}: {
  asset: AssetRow
  onOpen: () => void
  onDelete: () => void
}) {
  const Icon = TYPE_ICONS[asset.type] ?? FileText
  const isImage = asset.type === 'image'
  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded overflow-hidden bg-white dark:bg-slate-900 group">
      <button
        type="button"
        onClick={onOpen}
        className="block w-full aspect-square bg-slate-100 dark:bg-slate-800 relative hover:opacity-90"
      >
        {isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={asset.url}
            alt={asset.label}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Icon className="w-8 h-8 text-slate-400 dark:text-slate-500" />
          </div>
        )}
        <span className="absolute top-1 left-1 px-1.5 py-0.5 text-xs font-medium bg-slate-900/70 text-white rounded uppercase tracking-wider">
          {asset.type}
        </span>
        {(asset._count?.usages ?? 0) > 0 && (
          <span className="absolute top-1 right-1 px-1.5 py-0.5 text-xs font-medium bg-emerald-600 text-white rounded tabular-nums">
            {asset._count?.usages} use{asset._count?.usages === 1 ? '' : 's'}
          </span>
        )}
      </button>
      <div className="p-2">
        <div className="flex items-start justify-between gap-1">
          <button
            type="button"
            onClick={onOpen}
            className="text-sm text-slate-900 dark:text-slate-100 truncate hover:underline text-left flex-1 min-w-0"
            title={asset.label}
          >
            {asset.label}
          </button>
          <IconButton
            aria-label={`Delete ${asset.label}`}
            size="sm"
            tone="danger"
            onClick={onDelete}
            className="opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <Trash2 className="w-3 h-3" />
          </IconButton>
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">
          {asset.mimeType} · {formatBytes(asset.sizeBytes)}
        </div>
      </div>
    </div>
  )
}

function AssetDetailModal({
  assetId,
  onClose,
  onChanged,
}: {
  assetId: string
  onClose: () => void
  onChanged: () => void
}) {
  const [asset, setAsset] = useState<AssetDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editingLabel, setEditingLabel] = useState(false)
  const [labelDraft, setLabelDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const { toast } = useToast()

  useEffect(() => {
    let cancelled = false
    fetch(`${getBackendUrl()}/api/assets/${assetId}`, { cache: 'no-store' })
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
      .then((data) => {
        if (cancelled) return
        setAsset(data.asset)
        setLabelDraft(data.asset?.label ?? '')
      })
      .catch((e) => !cancelled && setError(e?.message ?? String(e)))
    return () => {
      cancelled = true
    }
  }, [assetId])

  const saveLabel = async () => {
    if (!asset || !labelDraft.trim() || labelDraft === asset.label) {
      setEditingLabel(false)
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/assets/${asset.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: labelDraft.trim() }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      toast.success('Saved')
      setAsset((prev) =>
        prev ? { ...prev, label: labelDraft.trim() } : prev,
      )
      setEditingLabel(false)
      onChanged()
    } catch (e: any) {
      toast.error(e?.message ?? String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      size="2xl"
      title={asset?.label ?? 'Asset detail'}
    >
      <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
        {error && (
          <div className="text-sm text-rose-700 dark:text-rose-300">
            {error}
          </div>
        )}
        {!asset ? (
          <div className="text-base text-slate-500 dark:text-slate-400">
            Loading…
          </div>
        ) : (
          <>
            {/* Preview */}
            <div className="flex gap-4">
              <div className="w-48 h-48 bg-slate-100 dark:bg-slate-800 rounded overflow-hidden flex-shrink-0 flex items-center justify-center">
                {asset.type === 'image' ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={asset.url}
                    alt={asset.label}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  (() => {
                    const Icon = TYPE_ICONS[asset.type] ?? FileText
                    return (
                      <Icon className="w-12 h-12 text-slate-400 dark:text-slate-500" />
                    )
                  })()
                )}
              </div>
              <div className="flex-1 space-y-2 min-w-0">
                <div>
                  <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
                    Label
                  </div>
                  {editingLabel ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={labelDraft}
                        onChange={(e) => setLabelDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveLabel()
                          if (e.key === 'Escape') setEditingLabel(false)
                        }}
                        autoFocus
                        className="flex-1 h-8 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
                      />
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={saveLabel}
                        loading={saving}
                      >
                        Save
                      </Button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setEditingLabel(true)}
                      className="text-base text-slate-900 dark:text-slate-100 hover:underline text-left"
                    >
                      {asset.label}
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <KV k="Type" v={asset.type} />
                  <KV k="MIME" v={asset.mimeType} />
                  <KV k="Size" v={formatBytes(asset.sizeBytes)} />
                  <KV k="Provider" v={asset.storageProvider} />
                  {asset.code && <KV k="Code" v={asset.code} mono />}
                  {asset.originalFilename && (
                    <KV k="Original" v={asset.originalFilename} mono />
                  )}
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
                    Storage URL
                  </div>
                  <a
                    href={asset.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-blue-700 dark:text-blue-300 hover:underline break-all"
                  >
                    {asset.url}
                  </a>
                </div>
              </div>
            </div>

            {/* Usages */}
            <div>
              <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1">
                Used by ({asset.usages.length})
              </div>
              {asset.usages.length === 0 ? (
                <div className="text-sm italic text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-800 rounded p-3 text-center">
                  Not attached to any product yet.
                </div>
              ) : (
                <ul className="border border-slate-200 dark:border-slate-800 rounded divide-y divide-slate-100 dark:divide-slate-800">
                  {asset.usages.map((u) => (
                    <li
                      key={u.id}
                      className="px-3 py-2 flex items-center justify-between gap-2"
                    >
                      <div className="min-w-0 flex-1">
                        {u.product ? (
                          <a
                            href={`/products?drawer=${u.product.id}&drawerTab=images`}
                            className="text-sm text-blue-700 dark:text-blue-300 hover:underline"
                          >
                            {u.product.name}
                          </a>
                        ) : (
                          <span className="text-sm text-slate-500 dark:text-slate-400 italic">
                            (orphaned usage)
                          </span>
                        )}
                        {u.product && (
                          <span className="ml-1 text-xs text-slate-500 dark:text-slate-400 font-mono">
                            {u.product.sku}
                          </span>
                        )}
                      </div>
                      <span
                        className={cn(
                          'inline-flex items-center px-1.5 py-0.5 text-xs rounded font-medium',
                          'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
                        )}
                      >
                        {u.role}
                        {u.sortOrder > 0 && (
                          <span className="ml-1 text-slate-500 dark:text-slate-400">
                            #{u.sortOrder}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  )
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
        {k}
      </div>
      <div
        className={cn(
          'text-sm text-slate-900 dark:text-slate-100 truncate',
          mono && 'font-mono',
        )}
      >
        {v}
      </div>
    </div>
  )
}
