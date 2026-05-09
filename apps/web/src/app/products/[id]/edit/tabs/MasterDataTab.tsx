'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'

interface Props {
  product: any
  onDirtyChange: (count: number) => void
  /** W1.1 — bumped by parent's "Discard" handler. On change we cancel
   *  any pending debounced save, drop the dirty set without flushing,
   *  and reseed local state from the freshly-fetched product prop. */
  discardSignal: number
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

const SAVE_DEBOUNCE_MS = 600

/** Q.0 — fields the master-data form actually persists. Each
 *  corresponds to a field allowed on the existing
 *  /api/products/bulk PATCH endpoint, so we don't need a new route.
 */
const MASTER_FIELDS = [
  'sku',
  'name',
  'brand',
  'manufacturer',
  'upc',
  'ean',
  'weightValue',
  'weightUnit',
  'dimLength',
  'dimWidth',
  'dimHeight',
  'dimUnit',
  'costPrice',
  'minMargin',
  'minPrice',
  'maxPrice',
] as const

type MasterField = (typeof MASTER_FIELDS)[number]

const NUMERIC_FIELDS: ReadonlySet<string> = new Set([
  'weightValue',
  'dimLength',
  'dimWidth',
  'dimHeight',
  'costPrice',
  'minMargin',
  'minPrice',
  'maxPrice',
])

function seedFromProduct(product: any): Record<MasterField, string> {
  const seed = {} as Record<MasterField, string>
  for (const f of MASTER_FIELDS) {
    const v = product[f]
    seed[f] = v == null ? '' : String(v)
  }
  if (!seed.weightUnit) seed.weightUnit = 'kg'
  if (!seed.dimUnit) seed.dimUnit = 'cm'
  return seed
}

export default function MasterDataTab({
  product,
  onDirtyChange,
  discardSignal,
}: Props) {
  const { t } = useTranslations()
  const router = useRouter()
  const [data, setData] = useState<Record<MasterField, string>>(() =>
    seedFromProduct(product),
  )
  // W1.2 — local copy of Product.version. Sent as If-Match on every
  // PATCH and bumped from the response so two consecutive saves with
  // no intervening reload still pass the CAS check on the server.
  // Seeded from the product prop on mount and on discard (along with
  // the field values themselves).
  const [version, setVersion] = useState<number | null>(
    typeof product.version === 'number' ? product.version : null,
  )
  // W1.2 — surfaced when the server returns 409 VERSION_CONFLICT.
  // Until the user clicks Reload (or Dismiss), the dirty set is held
  // intact so a second save attempt with a fresh version still has
  // every touched field to flush.
  const [conflict, setConflict] = useState<{
    expected: number
    current: number | null
  } | null>(null)

  const [status, setStatus] = useState<SaveStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  // Track which fields have been touched since the last successful
  // save — only those flush in the next PATCH.
  const dirtyRef = useRef<Set<MasterField>>(new Set())
  const saveTimer = useRef<number | null>(null)
  // W1.1 — onDirtyChange is invoked whenever dirty cardinality
  // changes. The parent aggregates per-tab counts to drive the
  // header's accurate "{n} unsaved" badge.
  const reportDirty = () => onDirtyChange(dirtyRef.current.size)

  const update = (field: MasterField, value: string) => {
    setData((prev) => ({ ...prev, [field]: value }))
    dirtyRef.current.add(field)
    reportDirty()
    setStatus('saving')
    setError(null)
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void flush()
    }, SAVE_DEBOUNCE_MS)
  }

  const flush = async () => {
    const fields = Array.from(dirtyRef.current)
    if (fields.length === 0) {
      setStatus('idle')
      return
    }
    const changes = fields.map((field) => {
      const raw = data[field]
      let value: unknown = raw
      if (NUMERIC_FIELDS.has(field)) {
        value = raw === '' ? null : Number(raw)
        if (typeof value === 'number' && Number.isNaN(value)) value = null
      } else if (raw === '') {
        value = null
      }
      return { id: product.id, field, value }
    })
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      // W1.2 — send the version we read with so the server can CAS-
      // bump in the same transaction as our field updates. expected
      // Version doubles up in the body for older route handlers that
      // can't read headers cleanly; the server reads If-Match first.
      if (typeof version === 'number') {
        headers['If-Match'] = String(version)
      }
      const res = await fetch(`${getBackendUrl()}/api/products/bulk`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          changes,
          ...(typeof version === 'number'
            ? { expectedVersion: version }
            : {}),
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        // W1.2 — VERSION_CONFLICT means another writer landed first.
        // Keep the dirty set so the user can choose to reapply after
        // reloading; surface a banner that names the version skew.
        if (res.status === 409 && body?.code === 'VERSION_CONFLICT') {
          setStatus('error')
          setError(null)
          setConflict({
            expected:
              typeof body.expectedVersion === 'number'
                ? body.expectedVersion
                : (version ?? 0),
            current:
              typeof body.currentVersion === 'number'
                ? body.currentVersion
                : null,
          })
          return
        }
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      const respBody = await res.json().catch(() => null)
      // W1.2 — track the server's freshly-incremented version so the
      // next debounced save still passes the CAS check without a
      // round-trip to GET /api/products/:id.
      if (typeof respBody?.currentVersion === 'number') {
        setVersion(respBody.currentVersion)
      } else if (typeof version === 'number') {
        setVersion(version + 1)
      }
      const flushedFields = Array.from(dirtyRef.current)
      dirtyRef.current = new Set()
      reportDirty()
      setStatus('saved')
      window.setTimeout(() => {
        setStatus((s) => (s === 'saved' ? 'idle' : s))
      }, 1500)
      // Phase 10/F11 — broadcast so /products grid + /bulk-operations
      // refresh within ~200ms.
      emitInvalidation({
        type: 'product.updated',
        id: product.id,
        fields: flushedFields,
        meta: { source: 'master-data-tab' },
      })
    } catch (e) {
      setStatus('error')
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // Flush on unmount so an in-flight debounce doesn't drop the last
  // edit when the user switches tabs. Discard path clears dirtyRef
  // first, so this becomes a no-op when the user explicitly chose
  // to throw away pending edits.
  useEffect(() => {
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      if (dirtyRef.current.size > 0) void flush()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // W1.1 — react to parent Discard. Skip the initial mount so
  // discardSignal=0 doesn't trigger a no-op reset on every render.
  const discardSeen = useRef(discardSignal)
  useEffect(() => {
    if (discardSignal === discardSeen.current) return
    discardSeen.current = discardSignal
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    dirtyRef.current = new Set()
    setData(seedFromProduct(product))
    setStatus('idle')
    setError(null)
    // W1.2 — discard also clears the conflict banner and reseeds
    // version from the freshly-fetched product prop. ProductEditClient
    // calls router.refresh() right after bumping discardSignal, so
    // the next render carries the latest version.
    setConflict(null)
    setVersion(typeof product.version === 'number' ? product.version : null)
    reportDirty()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discardSignal, product])

  return (
    <div className="space-y-4">
      {conflict && (
        <ConflictBanner
          expected={conflict.expected}
          current={conflict.current}
          onReload={() => router.refresh()}
          onDismiss={() => setConflict(null)}
          t={t}
        />
      )}
      <SaveStatusBar status={status} error={error} t={t} />

      <Card title="Identity" description="Core information shared across all channels">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3">
          <Input
            label="Master SKU"
            value={data.sku}
            mono
            onChange={(e) => update('sku', e.target.value)}
          />
          <Input
            label="Product Name"
            value={data.name}
            onChange={(e) => update('name', e.target.value)}
          />
          <Input
            label="Brand"
            value={data.brand}
            onChange={(e) => update('brand', e.target.value)}
          />
          <Input
            label="Manufacturer"
            value={data.manufacturer}
            onChange={(e) => update('manufacturer', e.target.value)}
          />
          <Input
            label="UPC"
            value={data.upc}
            mono
            onChange={(e) => update('upc', e.target.value)}
          />
          <Input
            label="EAN"
            value={data.ean}
            mono
            onChange={(e) => update('ean', e.target.value)}
          />
        </div>
      </Card>

      <Card title="Physical Attributes" description="Defaults for fulfillment fees and shipping. Variants can override.">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-3">
          <Input
            label="Weight"
            type="number"
            value={data.weightValue}
            onChange={(e) => update('weightValue', e.target.value)}
          />
          <SelectField
            label="Unit"
            value={data.weightUnit}
            onChange={(v) => update('weightUnit', v)}
            options={[
              { value: 'kg', label: 'kg' },
              { value: 'g', label: 'g' },
              { value: 'lb', label: 'lb' },
              { value: 'oz', label: 'oz' },
            ]}
          />
          <div />
          <div />
          <Input
            label="Length"
            type="number"
            value={data.dimLength}
            onChange={(e) => update('dimLength', e.target.value)}
          />
          <Input
            label="Width"
            type="number"
            value={data.dimWidth}
            onChange={(e) => update('dimWidth', e.target.value)}
          />
          <Input
            label="Height"
            type="number"
            value={data.dimHeight}
            onChange={(e) => update('dimHeight', e.target.value)}
          />
          <SelectField
            label="Unit"
            value={data.dimUnit}
            onChange={(v) => update('dimUnit', v)}
            options={[
              { value: 'cm', label: 'cm' },
              { value: 'mm', label: 'mm' },
              { value: 'in', label: 'in' },
            ]}
          />
        </div>
      </Card>

      <Card title="Pricing Rules" description="Constraints applied across all channels">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-3">
          <Input
            label="Cost Price"
            type="number"
            prefix="€"
            value={data.costPrice}
            onChange={(e) => update('costPrice', e.target.value)}
          />
          <Input
            label="Min Margin"
            type="number"
            suffix="%"
            value={data.minMargin}
            onChange={(e) => update('minMargin', e.target.value)}
          />
          <Input
            label="Min Price"
            type="number"
            prefix="€"
            value={data.minPrice}
            onChange={(e) => update('minPrice', e.target.value)}
          />
          <Input
            label="Max Price"
            type="number"
            prefix="€"
            value={data.maxPrice}
            onChange={(e) => update('maxPrice', e.target.value)}
          />
        </div>
      </Card>
    </div>
  )
}

function ConflictBanner({
  expected,
  current,
  onReload,
  onDismiss,
  t,
}: {
  expected: number
  current: number | null
  onReload: () => void
  onDismiss: () => void
  t: (key: string, vars?: Record<string, string | number>) => string
}) {
  return (
    <div
      role="alert"
      className="border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 rounded-lg px-4 py-3 flex items-start justify-between gap-3"
    >
      <div className="flex items-start gap-2 min-w-0">
        <AlertCircle className="w-4 h-4 mt-0.5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
        <div className="min-w-0">
          <div className="text-md font-semibold text-amber-900 dark:text-amber-200">
            {t('products.edit.conflict.title')}
          </div>
          <div className="text-sm text-amber-800 dark:text-amber-300 mt-0.5">
            {current != null
              ? t('products.edit.conflict.body', { expected, current })
              : t('products.edit.conflict.bodyNoCurrent', { expected })}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <Button variant="primary" size="sm" onClick={onReload}>
          <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
          {t('products.edit.conflict.reload')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          aria-label={t('products.edit.conflict.dismiss')}
        >
          <X className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  )
}

function SaveStatusBar({
  status,
  error,
  t,
}: {
  status: SaveStatus
  error: string | null
  t: (key: string, vars?: Record<string, string | number>) => string
}) {
  if (status === 'idle') return null
  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5 text-sm px-2 py-1 rounded border',
        status === 'saving' && 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-800',
        status === 'saved' && 'border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40',
        status === 'error' && 'border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40',
      )}
    >
      {status === 'saving' && <Loader2 className="w-3 h-3 animate-spin" />}
      {status === 'saved' && <CheckCircle2 className="w-3 h-3" />}
      {status === 'error' && <AlertCircle className="w-3 h-3" />}
      {status === 'saving' && t('products.edit.savingFlag')}
      {status === 'saved' && t('products.edit.savedFlag')}
      {status === 'error' && (error ?? 'Save failed')}
    </div>
  )
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label: string }>
}) {
  return (
    <div className="space-y-1">
      <label className="text-base font-medium text-slate-700 dark:text-slate-300">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-8 rounded-md border border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 bg-white dark:bg-slate-900 text-md text-slate-900 dark:text-slate-100 px-3 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}
