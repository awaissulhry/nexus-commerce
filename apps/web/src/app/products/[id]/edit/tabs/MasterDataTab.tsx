'use client'

import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2, AlertCircle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { cn } from '@/lib/utils'

interface Props {
  product: any
  onChange: () => void
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

export default function MasterDataTab({ product, onChange }: Props) {
  const [data, setData] = useState<Record<MasterField, string>>(() => {
    const seed = {} as Record<MasterField, string>
    for (const f of MASTER_FIELDS) {
      const v = product[f]
      seed[f] = v == null ? '' : String(v)
    }
    if (!seed.weightUnit) seed.weightUnit = 'kg'
    if (!seed.dimUnit) seed.dimUnit = 'cm'
    return seed
  })

  const [status, setStatus] = useState<SaveStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  // Track which fields have been touched since the last successful
  // save — only those flush in the next PATCH so we don't write back
  // unchanged values.
  const dirtyRef = useRef<Set<MasterField>>(new Set())
  const saveTimer = useRef<number | null>(null)

  const update = (field: MasterField, value: string) => {
    setData((prev) => ({ ...prev, [field]: value }))
    dirtyRef.current.add(field)
    onChange()
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
      const res = await fetch(`${getBackendUrl()}/api/products/bulk`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      // Only clear the dirty set on success — keep entries on error so
      // the next save attempt retries the same fields.
      const flushedFields = Array.from(dirtyRef.current)
      dirtyRef.current = new Set()
      setStatus('saved')
      window.setTimeout(() => {
        setStatus((s) => (s === 'saved' ? 'idle' : s))
      }, 1500)
      // Phase 10/F11 — broadcast so /products grid + /bulk-operations
      // refresh within ~200ms. MasterDataTab edits identity / physical /
      // pricing-floor fields (sku, name, brand, weight, costPrice,
      // minMargin, etc.) — none of these cascade to ChannelListing,
      // so we only emit product.updated. basePrice + totalStock edits
      // happen via the inline grid PATCH /api/products/:id (which
      // emits its own listing.updated).
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
  // edit when the user switches tabs.
  useEffect(() => {
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      if (dirtyRef.current.size > 0) void flush()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="space-y-4">
      <SaveStatusBar status={status} error={error} />

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

function SaveStatusBar({
  status,
  error,
}: {
  status: SaveStatus
  error: string | null
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
      {status === 'saving' && 'Saving…'}
      {status === 'saved' && 'Saved'}
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
