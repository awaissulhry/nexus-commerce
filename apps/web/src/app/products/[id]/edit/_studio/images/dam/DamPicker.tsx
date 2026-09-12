'use client'

/**
 * PES.7 — pick an image out of the DAM library.
 *
 * Importing shares the asset rather than copying it: the created `ProductImage` points at the same
 * Cloudinary `publicId`, so nothing is re-uploaded and one set of bytes serves both. The route is
 * idempotent per (product, publicId), so a double click cannot produce two rows.
 *
 * 🔴 The library's ids are PREFIXED and the import route's are not — see `assetId.ts`. The shipped
 * picker posts the prefixed id and 404s on every import; this one strips it, and the rule has a
 * test.
 *
 * The picker asks for `sources=digital_asset` because a `product_image` row is another product's
 * photo and there is no route that imports one — offering it would be an affordance that cannot
 * work. Brand / product-type scoping is offered where the product has them, because the useful
 * default is "assets already used by things like this", not "all 6,601 images".
 */
import { useCallback, useEffect, useMemo, useState } from 'react'

import { Modal } from '@/design-system/components'
import { Button, Input, SegmentedControl } from '@/design-system/primitives'
import { cdnFit } from '@/design-system/lib/cdn-image'

import { apiGet, apiSend, routes, type ApiResult } from '../api'
import { writeSubject } from '../imageWrites'
import type { ImportFromDamResponse, MasterAsset } from '../types'
import { importableAssetId } from './assetId'
import styles from './dam.module.css'
import { MediaSourceLibrary } from '@/app/_shared/media/MediaSourceLibrary'

export interface DamPickerProps {
  open: boolean
  productId: string
  /** Used to offer the "things like this" scopes; either may be absent on a product. */
  brand: string | null
  productType: string | null
  onClose(): void
  onImported(created: MasterAsset): void
  write<T>(subject: string, run: () => Promise<ApiResult<T>>): Promise<ApiResult<T>>
}

interface LibraryItem {
  id: string
  url: string
  label: string | null
  width: number | null
  height: number | null
  sizeBytes: number | null
  usageCount: number | null
  productSku: string | null
  hasQualityWarnings?: boolean
}

interface LibraryPage { items: LibraryItem[]; page: number; pageSize: number; total: number; hasMore: boolean }

type Scope = 'all' | 'brand' | 'type'
const PAGE_SIZE = 48
const THUMB_PX = 240

export function DamPicker(props: DamPickerProps) {
  const [busy, setBusy] = useState(false)
  if (!props.open) return null
  return <Modal open onClose={() => { if (!busy) props.onClose() }} size="xxl" readable title="Add from the media library">
    <MediaSourceLibrary imagesOnly onBusyChange={setBusy} nexusLibrary={<NexusDamLibrary {...props} />} onUse={async reference => {
      const result = await props.write(writeSubject.upload(`dam:${reference.assetId}`), () => apiSend<ImportFromDamResponse>(
        routes.importFromDam(props.productId), 'POST', { assetId: reference.assetId, type: 'ALT' },
      ))
      if (!result.ok) throw new Error(result.message)
      if (!result.data.image?.id) throw new Error('The image was accepted but could not be read. Reload the gallery.')
      props.onImported(result.data.image)
    }} />
  </Modal>
}

function NexusDamLibrary({
  open, productId, brand, productType, onImported, write,
}: DamPickerProps) {
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [scope, setScope] = useState<Scope>('all')
  const [page, setPage] = useState<LibraryPage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [importingId, setImportingId] = useState<string | null>(null)
  const [imported, setImported] = useState<Set<string>>(new Set())

  // Typing must not fire a request per keystroke against a 6,601-row library.
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(search.trim()), 300)
    return () => window.clearTimeout(t)
  }, [search])

  const scopes = useMemo(() => {
    const out: Array<{ value: Scope; label: string }> = [{ value: 'all', label: 'All assets' }]
    // Only offered when the product actually carries the field — a scope that cannot narrow
    // anything is a control that lies about what it does.
    if (brand) out.push({ value: 'brand', label: brand })
    if (productType) out.push({ value: 'type', label: productType })
    return out
  }, [brand, productType])

  const query = useMemo(() => {
    const p = new URLSearchParams({
      types: 'image',
      sources: 'digital_asset',
      pageSize: String(PAGE_SIZE),
    })
    if (debounced) p.set('search', debounced)
    if (scope === 'brand' && brand) p.set('relatedBrand', brand)
    if (scope === 'type' && productType) p.set('relatedProductType', productType)
    return p.toString()
  }, [brand, debounced, productType, scope])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      const res = await apiGet<LibraryPage>(`/api/assets/library?${query}`)
      if (cancelled) return
      setLoading(false)
      if (!res.ok) { setError(res.message); return }
      setPage(res.data)
    })()
    return () => { cancelled = true }
  }, [open, query])

  useEffect(() => { if (!open) { setImported(new Set()); setError(null) } }, [open])

  const importAsset = useCallback(async (item: LibraryItem) => {
    const assetId = importableAssetId(item.id)
    if (!assetId) {
      // Cannot happen while the query asks for digital_asset only, but the refusal is stated
      // rather than assumed — the alternative is posting an id that 404s.
      setError('That asset is another product’s image, which cannot be imported from here.')
      return
    }
    setImportingId(item.id)
    setError(null)
    // 🔴 The row is nested under `image` — this route does not return it at the top level.
    const res = await write(writeSubject.upload(`dam:${assetId}`), () => apiSend<ImportFromDamResponse>(
      routes.importFromDam(productId), 'POST',
      { assetId, type: 'ALT', alt: item.label ?? null },
    ))
    setImportingId(null)
    if (!res.ok) { setError(res.message); return }
    const created = res.data?.image
    if (!created?.id) {
      // The server answered 2xx in a shape this code does not understand. Saying nothing here is
      // how a successful write became an invisible one; say it instead.
      setError('The asset was accepted but the response could not be read — reload to see it.')
      return
    }
    setImported((prev) => new Set(prev).add(item.id))
    // `reused` means the product already had it; adding a second tile would be a lie.
    if (!res.data?.reused) onImported(created)
  }, [onImported, productId, write])

  if (!open) return null

  const items = page?.items ?? []

  return (
    <>
      <div className={styles.controls}>
        <Input
          size="sm"
          value={search}
          placeholder="Search by filename, label or alt text"
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search the asset library"
        />
        {scopes.length > 1 && (
          <SegmentedControl
            ariaLabel="Narrow the library"
            size="sm"
            value={scope}
            onChange={(v) => setScope(v as Scope)}
            options={scopes}
          />
        )}
      </div>

      {error && <p className={styles.error} role="alert">{error}</p>}
      {loading && <p className={styles.note}>Searching…</p>}

      {!loading && items.length === 0 && (
        <p className={styles.note}>
          {debounced || scope !== 'all'
            ? 'No assets match. Widen the search or switch back to all assets.'
            : 'The asset library has no images yet.'}
        </p>
      )}

      <div className={styles.grid}>
        {items.map((item) => {
          const busy = importingId === item.id
          const done = imported.has(item.id)
          return (
            <figure key={item.id} className={styles.card} data-testid="dam-asset">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className={styles.cardImg} src={cdnFit(item.url, THUMB_PX)} alt={item.label ?? ''} loading="lazy" />
              <figcaption className={styles.cardMeta}>
                <span className={styles.cardLabel} title={item.label ?? ''}>{item.label ?? 'Untitled'}</span>
                <span className={styles.cardFacts}>
                  {item.width != null && item.height != null
                    ? `${item.width}×${item.height}`
                    : <em>size unknown</em>}
                  {/* Where else this asset is already used — the reason to reuse rather than upload. */}
                  {item.usageCount != null && item.usageCount > 0 && ` · used ${item.usageCount}×`}
                </span>
              </figcaption>
              <Button
                size="sm"
                variant={done ? 'ghost' : 'secondary'}
                disabled={busy || done}
                onClick={() => void importAsset(item)}
              >
                {done ? 'Added' : busy ? 'Adding…' : 'Add'}
              </Button>
            </figure>
          )
        })}
      </div>

      {page?.hasMore && (
        <p className={styles.note}>
          Showing the first {items.length} of {page.total.toLocaleString()}. Search to narrow it.
        </p>
      )}
    </>
  )
}
