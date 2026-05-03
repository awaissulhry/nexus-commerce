'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import type { StepProps } from '../ListWizardClient'

type FieldKind =
  | 'text'
  | 'longtext'
  | 'enum'
  | 'number'
  | 'boolean'
  | 'unsupported'

interface RenderableField {
  id: string
  label: string
  description?: string
  kind: FieldKind
  required: boolean
  wrapped: boolean
  options?: Array<{ value: string; label: string }>
  defaultValue?: string | number | boolean
  examples?: string[]
  maxLength?: number
  minLength?: number
  unsupportedReason?: string
}

interface FieldManifest {
  channel: string
  marketplace: string
  productType: string
  schemaVersion: string
  fetchedAt: string
  fields: RenderableField[]
}

type AttributesSlice = Record<string, string | number | boolean>

const SAVE_DEBOUNCE_MS = 600

export default function Step4Attributes({
  wizardState,
  updateWizardState,
  wizardId,
  channel,
}: StepProps) {
  const productTypeSlice = (wizardState.productType ?? {}) as {
    productType?: string
    displayName?: string
  }

  const [manifest, setManifest] = useState<FieldManifest | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const initialAttrs = (wizardState.attributes ?? {}) as AttributesSlice
  const [values, setValues] = useState<AttributesSlice>(initialAttrs)

  // Debounced persist of `values` into wizardState.attributes.
  const saveTimer = useRef<number | null>(null)
  useEffect(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void updateWizardState({ attributes: values })
    }, SAVE_DEBOUNCE_MS)
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
    }
    // updateWizardState is a stable ref from the wizard shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values])

  // Fetch the required-fields manifest. If the productType isn't set
  // yet, redirect-style hint to Step 3 — the backend would 409, this
  // gives a friendlier inline message.
  useEffect(() => {
    if (channel !== 'AMAZON') {
      setLoading(false)
      setError(null)
      setManifest(null)
      return
    }
    if (!productTypeSlice.productType) {
      setLoading(false)
      setError('Pick a product type in Step 3 first.')
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(
      `${getBackendUrl()}/api/listing-wizard/${wizardId}/required-fields`,
    )
      .then(async (r) => ({ ok: r.ok, status: r.status, json: await r.json() }))
      .then(({ ok, status, json }) => {
        if (cancelled) return
        if (!ok) {
          setError(json?.error ?? `HTTP ${status}`)
          setManifest(null)
          return
        }
        setManifest(json as FieldManifest)
        // Seed inputs with smart defaults for any fields the user
        // hasn't filled yet — without overwriting existing edits.
        setValues((prev) => {
          const next = { ...prev }
          for (const f of (json as FieldManifest).fields) {
            if (next[f.id] === undefined && f.defaultValue !== undefined) {
              next[f.id] = f.defaultValue
            }
          }
          return next
        })
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [channel, productTypeSlice.productType, wizardId, reloadKey])

  const setField = useCallback(
    (id: string, value: string | number | boolean) => {
      setValues((prev) => ({ ...prev, [id]: value }))
    },
    [],
  )

  // Continue is enabled when every required field has a non-empty
  // value. Unsupported fields don't block — they're flagged for
  // manual handling but can't be rendered, so we treat them as
  // 'manually skipped' rather than failing the whole step.
  const missingFieldIds = useMemo(() => {
    if (!manifest) return []
    return manifest.fields
      .filter((f) => f.required && f.kind !== 'unsupported')
      .filter((f) => isEmpty(values[f.id]))
      .map((f) => f.id)
  }, [manifest, values])

  const onContinue = useCallback(async () => {
    if (missingFieldIds.length > 0) return
    await updateWizardState(
      {
        attributes: values,
      },
      { advance: true },
    )
  }, [missingFieldIds.length, updateWizardState, values])

  if (channel !== 'AMAZON') {
    return (
      <div className="max-w-2xl mx-auto py-12 px-6 text-center">
        <p className="text-[13px] text-slate-600">
          Required attributes only apply to Amazon listings. Skipping for{' '}
          <span className="font-mono">{channel}</span>.
        </p>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto py-10 px-6">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[20px] font-semibold text-slate-900">
            Required Attributes
          </h2>
          <p className="text-[13px] text-slate-600 mt-1">
            Fill the fields Amazon requires for{' '}
            <span className="font-mono text-slate-800">
              {productTypeSlice.productType}
            </span>{' '}
            <span className="text-slate-500">
              ({productTypeSlice.displayName ?? '—'})
            </span>
            . Smart defaults are pulled from the master product where they
            line up.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={loading}
          className="inline-flex items-center gap-1 h-7 px-2 text-[11px] text-slate-600 border border-slate-200 rounded hover:bg-slate-50 hover:text-slate-900 disabled:opacity-40 flex-shrink-0"
          title="Re-fetch the required-fields manifest from the latest schema"
        >
          {loading ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <RefreshCw className="w-3 h-3" />
          )}
          Refresh
        </button>
      </div>

      {loading && !manifest && (
        <div className="border border-slate-200 rounded-lg bg-white px-6 py-12 text-center text-[13px] text-slate-500 flex items-center justify-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading required fields…
        </div>
      )}

      {error && !loading && (
        <div className="border border-rose-200 rounded-lg bg-rose-50 px-4 py-3 text-[13px] text-rose-700 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div>
            <div>{error}</div>
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              className="mt-1 text-[12px] font-medium underline hover:no-underline"
            >
              Try again
            </button>
          </div>
        </div>
      )}

      {manifest && manifest.fields.length === 0 && !loading && (
        <div className="border border-slate-200 rounded-lg bg-white px-4 py-6 text-center text-[12px] text-slate-500">
          No required fields for this product type — nothing to fill in.
        </div>
      )}

      {manifest && manifest.fields.length > 0 && (
        <div className="space-y-4">
          {manifest.fields.map((field) => (
            <FieldRenderer
              key={field.id}
              field={field}
              value={values[field.id]}
              onChange={(v) => setField(field.id, v)}
              isMissing={missingFieldIds.includes(field.id)}
              marketplace={manifest.marketplace}
            />
          ))}
        </div>
      )}

      <div className="mt-8 flex items-center justify-between gap-3">
        <div className="text-[12px] text-slate-600">
          {missingFieldIds.length === 0 && manifest ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-700">
              <CheckCircle2 className="w-3.5 h-3.5" />
              All required fields complete.
            </span>
          ) : (
            <span className="text-amber-700">
              {missingFieldIds.length} required field
              {missingFieldIds.length === 1 ? '' : 's'} remaining
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onContinue}
          disabled={!manifest || missingFieldIds.length > 0}
          className={cn(
            'h-8 px-4 rounded-md text-[13px] font-medium',
            !manifest || missingFieldIds.length > 0
              ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
              : 'bg-blue-600 text-white hover:bg-blue-700',
          )}
        >
          Continue
        </button>
      </div>
    </div>
  )
}

// ── Field renderer ──────────────────────────────────────────────

function FieldRenderer({
  field,
  value,
  onChange,
  isMissing,
  marketplace,
}: {
  field: RenderableField
  value: string | number | boolean | undefined
  onChange: (v: string | number | boolean) => void
  isMissing: boolean
  marketplace: string
}) {
  const containerClass = cn(
    'border rounded-lg bg-white px-4 py-3',
    isMissing ? 'border-amber-200' : 'border-slate-200',
  )

  return (
    <div className={containerClass}>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label className="text-[13px] font-medium text-slate-900">
          {field.label}
          <span className="text-rose-600 ml-0.5">*</span>
          <span className="ml-2 text-[11px] font-mono font-normal text-slate-400">
            {field.id}
          </span>
        </label>
        {field.wrapped && (
          <span className="text-[10px] uppercase tracking-wide text-slate-400 font-medium">
            {marketplace}
          </span>
        )}
      </div>
      {field.description && (
        <p className="text-[12px] text-slate-500 mb-2">{field.description}</p>
      )}

      <FieldInput field={field} value={value} onChange={onChange} />

      {field.examples && field.examples.length > 0 && field.kind !== 'enum' && (
        <p className="mt-1.5 text-[11px] text-slate-400">
          Examples: {field.examples.join(', ')}
        </p>
      )}
      {field.maxLength && field.kind !== 'enum' && (
        <p className="mt-1 text-[11px] text-slate-400">
          {currentLength(value)} / {field.maxLength} characters
        </p>
      )}
    </div>
  )
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: RenderableField
  value: string | number | boolean | undefined
  onChange: (v: string | number | boolean) => void
}) {
  if (field.kind === 'unsupported') {
    return (
      <div className="text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
        Can't render this field automatically yet.
        {field.unsupportedReason ? ` (${field.unsupportedReason})` : ''} Set it
        directly in Seller Central after submission, or skip this product
        type for now.
      </div>
    )
  }

  if (field.kind === 'enum') {
    const v = (value ?? '') as string
    return (
      <select
        value={v}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-8 px-2 text-[13px] border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white"
      >
        <option value="">— Select —</option>
        {(field.options ?? []).map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    )
  }

  if (field.kind === 'boolean') {
    const v = Boolean(value)
    return (
      <label className="flex items-center gap-2 text-[13px] text-slate-700">
        <input
          type="checkbox"
          checked={v}
          onChange={(e) => onChange(e.target.checked)}
          className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
        />
        {v ? 'Yes' : 'No'}
      </label>
    )
  }

  if (field.kind === 'number') {
    const v = value === undefined ? '' : String(value)
    return (
      <input
        type="number"
        value={v}
        onChange={(e) => {
          const raw = e.target.value
          if (raw === '') onChange('')
          else {
            const n = Number(raw)
            if (!Number.isNaN(n)) onChange(n)
          }
        }}
        className="w-full h-8 px-2 text-[13px] border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
      />
    )
  }

  if (field.kind === 'longtext') {
    const v = (value ?? '') as string
    return (
      <textarea
        value={v}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        maxLength={field.maxLength}
        className="w-full px-2 py-1.5 text-[13px] border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
      />
    )
  }

  // text
  const v = (value ?? '') as string
  return (
    <input
      type="text"
      value={v}
      onChange={(e) => onChange(e.target.value)}
      maxLength={field.maxLength}
      className="w-full h-8 px-2 text-[13px] border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
    />
  )
}

// ── helpers ─────────────────────────────────────────────────────

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true
  if (typeof v === 'string') return v.trim() === ''
  if (typeof v === 'number') return Number.isNaN(v)
  return false
}

function currentLength(v: unknown): number {
  if (typeof v === 'string') return v.length
  return 0
}
