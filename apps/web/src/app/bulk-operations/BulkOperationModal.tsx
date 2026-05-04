'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Globe,
  Loader2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import {
  FieldInput,
  type Primitive,
  type UnionField,
  type UnionManifest,
} from '../products/_shared/attribute-editor'
import type { MarketplaceContext } from './components/MarketplaceSelector'

// ── Operation contract ─────────────────────────────────────────────

type OperationType =
  | 'PRICING_UPDATE'
  | 'INVENTORY_UPDATE'
  | 'STATUS_UPDATE'
  | 'ATTRIBUTE_UPDATE'
  | 'SCHEMA_FIELD_UPDATE'

interface OperationConfig {
  type: OperationType
  label: string
  description: string
  /** Default action payload. */
  initialPayload: Record<string, unknown>
  /** True if the user must provide non-empty values to proceed. */
  isPayloadValid: (p: Record<string, unknown>) => boolean
  /** Render parameter inputs. */
  renderParams: (
    payload: Record<string, unknown>,
    setPayload: (next: Record<string, unknown>) => void,
  ) => React.ReactNode
}

const OPERATIONS: OperationConfig[] = [
  {
    type: 'PRICING_UPDATE',
    label: 'Adjust price',
    description:
      'Set absolute prices, apply percentage adjustments, or shift by a fixed amount across matching variations.',
    initialPayload: { adjustmentType: 'PERCENT', value: 0 },
    isPayloadValid: (p) =>
      typeof p.adjustmentType === 'string' &&
      typeof p.value === 'number' &&
      !Number.isNaN(p.value),
    renderParams: (p, set) => (
      <>
        <Field label="Adjustment">
          <select
            value={(p.adjustmentType as string) ?? 'PERCENT'}
            onChange={(e) =>
              set({ ...p, adjustmentType: e.target.value as string })
            }
            className={inputCls}
          >
            <option value="ABSOLUTE">Set to absolute amount</option>
            <option value="DELTA">Add / subtract fixed amount</option>
            <option value="PERCENT">Change by percentage</option>
          </select>
        </Field>
        <Field
          label={
            p.adjustmentType === 'PERCENT'
              ? 'Percentage (e.g. 5 = +5%, -10 = -10%)'
              : p.adjustmentType === 'DELTA'
                ? 'Amount (e.g. 5 = +€5, -2.50 = -€2.50)'
                : 'New price (€)'
          }
        >
          <input
            type="number"
            step="0.01"
            value={(p.value as number) ?? 0}
            onChange={(e) =>
              set({ ...p, value: parseFloat(e.target.value) || 0 })
            }
            className={inputCls}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Floor (optional)">
            <input
              type="number"
              step="0.01"
              value={(p.minPrice as number) ?? ''}
              onChange={(e) =>
                set({
                  ...p,
                  minPrice: e.target.value
                    ? parseFloat(e.target.value)
                    : undefined,
                })
              }
              placeholder="Skip if below"
              className={inputCls}
            />
          </Field>
          <Field label="Ceiling (optional)">
            <input
              type="number"
              step="0.01"
              value={(p.maxPrice as number) ?? ''}
              onChange={(e) =>
                set({
                  ...p,
                  maxPrice: e.target.value
                    ? parseFloat(e.target.value)
                    : undefined,
                })
              }
              placeholder="Skip if above"
              className={inputCls}
            />
          </Field>
        </div>
      </>
    ),
  },
  {
    type: 'INVENTORY_UPDATE',
    label: 'Update stock',
    description: 'Set stock to a value or adjust by a delta.',
    initialPayload: { adjustmentType: 'ABSOLUTE', value: 0 },
    isPayloadValid: (p) =>
      typeof p.adjustmentType === 'string' &&
      typeof p.value === 'number' &&
      !Number.isNaN(p.value),
    renderParams: (p, set) => (
      <>
        <Field label="Mode">
          <select
            value={(p.adjustmentType as string) ?? 'ABSOLUTE'}
            onChange={(e) =>
              set({ ...p, adjustmentType: e.target.value as string })
            }
            className={inputCls}
          >
            <option value="ABSOLUTE">Set to value</option>
            <option value="DELTA">Add / subtract</option>
          </select>
        </Field>
        <Field label="Quantity">
          <input
            type="number"
            step="1"
            value={(p.value as number) ?? 0}
            onChange={(e) =>
              set({ ...p, value: parseInt(e.target.value, 10) || 0 })
            }
            className={inputCls}
          />
        </Field>
      </>
    ),
  },
  {
    type: 'STATUS_UPDATE',
    label: 'Change status',
    description: 'Set product status (DRAFT / ACTIVE / INACTIVE).',
    initialPayload: { status: 'ACTIVE' },
    isPayloadValid: (p) =>
      ['DRAFT', 'ACTIVE', 'INACTIVE'].includes(p.status as string),
    renderParams: (p, set) => (
      <Field label="New status">
        <select
          value={(p.status as string) ?? 'ACTIVE'}
          onChange={(e) => set({ ...p, status: e.target.value })}
          className={inputCls}
        >
          <option value="DRAFT">Draft</option>
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
        </select>
      </Field>
    ),
  },
  {
    type: 'ATTRIBUTE_UPDATE',
    label: 'Set attribute',
    description:
      'Set a single key inside variationAttributes. The new value shallow-merges into existing attributes — other keys are preserved.',
    initialPayload: { attributeName: '', value: '' },
    isPayloadValid: (p) =>
      typeof p.attributeName === 'string' &&
      (p.attributeName as string).trim().length > 0,
    renderParams: (p, set) => (
      <>
        <Field label="Attribute name">
          <input
            type="text"
            value={(p.attributeName as string) ?? ''}
            onChange={(e) => set({ ...p, attributeName: e.target.value })}
            placeholder="e.g. material, fit"
            className={inputCls}
          />
        </Field>
        <Field label="Value">
          <input
            type="text"
            value={(p.value as string) ?? ''}
            onChange={(e) => set({ ...p, value: e.target.value })}
            placeholder="any value"
            className={inputCls}
          />
        </Field>
      </>
    ),
  },
]

// ── Scope filter shape (matches backend ScopeFilters) ──────────────

interface ScopeFilters {
  brand?: string
  productType?: string
  marketplace?: string
  status?: 'DRAFT' | 'ACTIVE' | 'INACTIVE'
  stockMin?: number
  stockMax?: number
}

type ScopeMode = 'filter' | 'subset'

interface PreviewSample {
  id: string
  sku: string | null
  name: string | null
  currentValue: unknown
  newValue: unknown
  status: 'processed' | 'skipped'
}

interface JobResult {
  id: string
  status: string
  totalItems: number
  processedItems: number
  failedItems: number
  skippedItems: number
  progressPercent: number
  errorLog?: Array<{ itemId: string; error: string }> | null
  lastError?: string | null
}

// ── Modal ──────────────────────────────────────────────────────────

interface Props {
  open: boolean
  onClose: () => void
  /** Current grid filters (mapped from the bulk-ops page's filterState).
   *  Used as the default when the user picks "current filter result". */
  currentFilters?: ScopeFilters
  /** R.2 — multi-marketplace targets selected on the page. The
   *  schema-driven "Set channel attribute" op fans out to every
   *  entry. Empty disables that op. */
  marketplaceTargets?: MarketplaceContext[]
  /** R.2 — product IDs currently visible in the grid (post-search /
   *  filter). The schema-driven op operates on these directly,
   *  skipping the BulkActionService preview/job system. Capped at
   *  1000 by the backend. */
  visibleProductIds?: string[]
}

export default function BulkOperationModal({
  open,
  onClose,
  currentFilters,
  marketplaceTargets = [],
  visibleProductIds = [],
}: Props) {
  const [opType, setOpType] = useState<OperationType>('PRICING_UPDATE')
  const op = OPERATIONS.find((o) => o.type === opType)
  const isSchemaOp = opType === 'SCHEMA_FIELD_UPDATE'

  const [payload, setPayload] = useState<Record<string, unknown>>(
    op?.initialPayload ?? {},
  )
  // Reset payload when op changes
  useEffect(() => setPayload(op?.initialPayload ?? {}), [opType, op?.initialPayload])

  const [scopeMode, setScopeMode] = useState<ScopeMode>('filter')
  const [subsetFilters, setSubsetFilters] = useState<ScopeFilters>({})
  const activeFilters: ScopeFilters =
    scopeMode === 'filter' ? currentFilters ?? {} : subsetFilters

  // R.2 — schema-op-specific state. Field manifest is loaded from a
  // representative product (the first visible id) using the active
  // page-level marketplace target as the schema lookup key. The
  // selected field id + value drive the bulk-schema-update PUT.
  const [schemaManifest, setSchemaManifest] = useState<UnionManifest | null>(
    null,
  )
  const [schemaLoading, setSchemaLoading] = useState(false)
  const [schemaError, setSchemaError] = useState<string | null>(null)
  const [schemaFieldId, setSchemaFieldId] = useState<string>('')
  const [schemaValue, setSchemaValue] = useState<Primitive | undefined>(
    undefined,
  )
  const [schemaResult, setSchemaResult] = useState<{
    updated: number
    errors: Array<{
      productId: string
      channel: string
      marketplace: string
      error: string
    }>
  } | null>(null)

  const schemaField: UnionField | undefined = useMemo(
    () => schemaManifest?.fields.find((f) => f.id === schemaFieldId),
    [schemaManifest, schemaFieldId],
  )

  const primaryTarget = marketplaceTargets[0] ?? null
  const repProductId = visibleProductIds[0] ?? null

  // Load schema for the schema-op when it's active. Refetches when the
  // representative product or primary target changes.
  useEffect(() => {
    if (!open || !isSchemaOp) return
    if (!primaryTarget || !repProductId) {
      setSchemaManifest(null)
      setSchemaError(
        !primaryTarget
          ? 'Select one or more marketplace targets in the toolbar first.'
          : 'No products visible in the grid.',
      )
      return
    }
    let cancelled = false
    setSchemaLoading(true)
    setSchemaError(null)
    fetch(
      `${getBackendUrl()}/api/products/${repProductId}/listings/${primaryTarget.channel}/${primaryTarget.marketplace}/schema?all=1`,
    )
      .then(async (r) => ({ ok: r.ok, json: await r.json() }))
      .then(({ ok, json }) => {
        if (cancelled) return
        if (!ok) {
          setSchemaError(json?.error ?? 'Schema lookup failed')
          setSchemaManifest(null)
          return
        }
        setSchemaManifest(json as UnionManifest)
      })
      .catch((err) => {
        if (cancelled) return
        setSchemaError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setSchemaLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, isSchemaOp, primaryTarget, repProductId])

  const handleSchemaExecute = async () => {
    if (!schemaFieldId || schemaValue === undefined || schemaValue === '') return
    if (visibleProductIds.length === 0 || marketplaceTargets.length === 0) return
    setExecuting(true)
    setExecuteError(null)
    setSchemaResult(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/bulk-schema-update`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            productIds: visibleProductIds.slice(0, 1000),
            marketplaceContexts: marketplaceTargets,
            attributes: { [schemaFieldId]: schemaValue },
          }),
        },
      )
      const json = await res.json()
      if (!res.ok) {
        throw new Error(json.error ?? `HTTP ${res.status}`)
      }
      setSchemaResult({ updated: json.updated ?? 0, errors: json.errors ?? [] })
    } catch (err) {
      setExecuteError(err instanceof Error ? err.message : String(err))
    } finally {
      setExecuting(false)
    }
  }

  const [preview, setPreview] = useState<{
    affectedCount: number
    sampleItems: PreviewSample[]
  } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const previewSeq = useRef(0)

  const [job, setJob] = useState<JobResult | null>(null)
  const [executing, setExecuting] = useState(false)
  const [executeError, setExecuteError] = useState<string | null>(null)

  // Reset everything on close.
  useEffect(() => {
    if (!open) {
      setOpType('PRICING_UPDATE')
      setPayload(OPERATIONS[0].initialPayload)
      setScopeMode('filter')
      setSubsetFilters({})
      setPreview(null)
      setPreviewLoading(false)
      setPreviewError(null)
      setJob(null)
      setExecuting(false)
      setExecuteError(null)
      setSchemaFieldId('')
      setSchemaValue(undefined)
      setSchemaResult(null)
      setSchemaManifest(null)
      setSchemaError(null)
    }
  }, [open])

  // Esc to close.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !executing) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, executing, onClose])

  // Fetch preview whenever scope or payload changes (debounced). The
  // schema-op uses its own (non-async-job) flow so it skips this.
  const payloadValid = isSchemaOp ? true : op?.isPayloadValid(payload) ?? false
  const previewKey = useMemo(
    () =>
      JSON.stringify({
        opType,
        payload,
        filters: activeFilters,
      }),
    [opType, payload, activeFilters],
  )
  useEffect(() => {
    if (!open || !payloadValid || isSchemaOp) {
      setPreview(null)
      return
    }
    const seq = ++previewSeq.current
    setPreviewLoading(true)
    setPreviewError(null)
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/bulk-operations/preview`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jobName: `${op?.label ?? opType} (preview)`,
              actionType: opType,
              filters: activeFilters,
              actionPayload: payload,
              sampleSize: 8,
            }),
          },
        )
        if (seq !== previewSeq.current) return
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? `Preview failed (HTTP ${res.status})`)
        }
        const data = await res.json()
        if (seq !== previewSeq.current) return
        setPreview({
          affectedCount: data.affectedCount ?? 0,
          sampleItems: data.sampleItems ?? [],
        })
      } catch (err) {
        if (seq !== previewSeq.current) return
        setPreviewError(err instanceof Error ? err.message : String(err))
      } finally {
        if (seq === previewSeq.current) setPreviewLoading(false)
      }
    }, 250)
    return () => window.clearTimeout(timer)
  }, [open, payloadValid, previewKey, op?.label, opType, payload, activeFilters, isSchemaOp])

  // Execute: POST /create → POST /:id/process → poll /:id every 2s.
  const handleExecute = async () => {
    if (!preview || preview.affectedCount === 0) return
    setExecuting(true)
    setExecuteError(null)
    try {
      const createRes = await fetch(
        `${getBackendUrl()}/api/bulk-operations`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jobName: `${op?.label ?? opType} (${new Date().toISOString().slice(0, 19)})`,
            actionType: opType,
            filters: activeFilters,
            actionPayload: payload,
          }),
        },
      )
      if (!createRes.ok) {
        const body = await createRes.json().catch(() => ({}))
        throw new Error(body.error ?? `Create failed (HTTP ${createRes.status})`)
      }
      const { job: createdJob } = await createRes.json()
      setJob(createdJob)

      const processRes = await fetch(
        `${getBackendUrl()}/api/bulk-operations/${createdJob.id}/process`,
        { method: 'POST' },
      )
      if (!processRes.ok) {
        const body = await processRes.json().catch(() => ({}))
        throw new Error(body.error ?? `Process failed (HTTP ${processRes.status})`)
      }

      // Poll status. Stops on terminal state.
      const terminal = new Set([
        'COMPLETED',
        'FAILED',
        'PARTIALLY_COMPLETED',
        'CANCELLED',
      ])
      while (true) {
        await new Promise((r) => setTimeout(r, 2000))
        const statusRes = await fetch(
          `${getBackendUrl()}/api/bulk-operations/${createdJob.id}`,
          { cache: 'no-store' },
        )
        if (!statusRes.ok) break
        const { job: latest } = await statusRes.json()
        setJob(latest)
        if (terminal.has(latest.status)) break
      }
    } catch (err) {
      setExecuteError(err instanceof Error ? err.message : String(err))
    } finally {
      setExecuting(false)
    }
  }

  if (!open) return null

  const jobTerminal = job
    ? ['COMPLETED', 'FAILED', 'PARTIALLY_COMPLETED', 'CANCELLED'].includes(
        job.status,
      )
    : false

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 backdrop-blur-sm pt-[5vh] px-4"
      role="dialog"
      aria-modal="true"
      onClick={() => !executing && onClose()}
    >
      <div
        className="bg-white rounded-lg shadow-xl border border-slate-200 w-[640px] max-w-[92vw] flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 flex-shrink-0">
          <h2 className="text-[15px] font-semibold text-slate-900">
            Bulk apply
          </h2>
          <button
            type="button"
            onClick={() => !executing && onClose()}
            className="text-slate-400 hover:text-slate-700 disabled:opacity-50"
            disabled={executing}
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Operation picker */}
          <Section title="Operation">
            <div className="grid grid-cols-2 gap-2">
              {OPERATIONS.map((o) => (
                <button
                  key={o.type}
                  type="button"
                  onClick={() => setOpType(o.type)}
                  className={cn(
                    'text-left rounded-md border px-3 py-2 transition-colors',
                    opType === o.type
                      ? 'border-blue-500 bg-blue-50 text-blue-900'
                      : 'border-slate-200 hover:border-slate-300',
                  )}
                >
                  <div className="text-[13px] font-medium">{o.label}</div>
                  <div className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">
                    {o.description}
                  </div>
                </button>
              ))}
              <button
                type="button"
                onClick={() => setOpType('SCHEMA_FIELD_UPDATE')}
                className={cn(
                  'text-left rounded-md border px-3 py-2 transition-colors',
                  isSchemaOp
                    ? 'border-blue-500 bg-blue-50 text-blue-900'
                    : 'border-slate-200 hover:border-slate-300',
                )}
              >
                <div className="text-[13px] font-medium inline-flex items-center gap-1.5">
                  <Globe className="w-3.5 h-3.5" />
                  Set channel attribute
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">
                  Schema-driven update of any Amazon attribute across the
                  selected marketplaces. Operates on visible products in
                  the grid.
                </div>
              </button>
            </div>
          </Section>

          {/* Operation parameters */}
          {!isSchemaOp && op && (
            <Section title="Parameters">
              <div className="space-y-3">{op.renderParams(payload, setPayload)}</div>
            </Section>
          )}

          {/* R.2 — schema-driven flow: targets banner + field picker +
              value input. Uses the already-loaded UnionManifest for
              the representative product to populate the field list. */}
          {isSchemaOp && (
            <Section title="Schema-driven update">
              <SchemaTargetsBanner targets={marketplaceTargets} />
              <div className="mt-3 space-y-3">
                {schemaLoading && (
                  <div className="text-[12px] text-slate-500 inline-flex items-center gap-1.5">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Loading schema fields…
                  </div>
                )}
                {schemaError && (
                  <div className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 inline-flex items-start gap-2">
                    <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                    <div>{schemaError}</div>
                  </div>
                )}
                {!schemaLoading &&
                  !schemaError &&
                  schemaManifest &&
                  schemaManifest.fields.length > 0 && (
                    <>
                      <Field label="Field">
                        <select
                          value={schemaFieldId}
                          onChange={(e) => {
                            setSchemaFieldId(e.target.value)
                            setSchemaValue(undefined)
                          }}
                          className={inputCls}
                        >
                          <option value="">— Pick a field —</option>
                          {schemaManifest.fields.map((f) => (
                            <option key={f.id} value={f.id}>
                              {f.label} ({f.id})
                            </option>
                          ))}
                        </select>
                      </Field>
                      {schemaField && (
                        <Field label="Value">
                          <FieldInput
                            field={schemaField}
                            value={schemaValue}
                            onChange={(v) => setSchemaValue(v)}
                          />
                          {schemaField.description && (
                            <p className="mt-1 text-[10px] text-slate-500">
                              {schemaField.description}
                            </p>
                          )}
                        </Field>
                      )}
                    </>
                  )}
              </div>
              <div className="mt-3 text-[11px] text-slate-500">
                Targets {visibleProductIds.length.toLocaleString()} visible
                product{visibleProductIds.length === 1 ? '' : 's'} ×{' '}
                {marketplaceTargets.length} marketplace
                {marketplaceTargets.length === 1 ? '' : 's'}
                {visibleProductIds.length > 1000 && (
                  <span className="text-amber-700">
                    {' '}
                    (capped at 1000 — refine the grid filter to narrow it
                    down)
                  </span>
                )}
                .
              </div>
              {schemaResult && (
                <div className="mt-3 text-[12px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-3 py-2">
                  Updated {schemaResult.updated.toLocaleString()} listing
                  {schemaResult.updated === 1 ? '' : 's'}.
                  {schemaResult.errors.length > 0 && (
                    <span className="text-amber-700 ml-1">
                      {' '}
                      {schemaResult.errors.length} error
                      {schemaResult.errors.length === 1 ? '' : 's'} (see
                      console).
                    </span>
                  )}
                </div>
              )}
            </Section>
          )}

          {/* Scope (job-based ops only) */}
          {!isSchemaOp && (
          <Section title="Apply to">
            <div className="space-y-2">
              <Radio
                checked={scopeMode === 'filter'}
                onChange={() => setScopeMode('filter')}
                label={
                  <>
                    Current filter result{' '}
                    <span className="text-slate-500">
                      (uses the grid&apos;s active filters)
                    </span>
                  </>
                }
              />
              <Radio
                checked={scopeMode === 'subset'}
                onChange={() => setScopeMode('subset')}
                label="Specific subset…"
              />
              {scopeMode === 'subset' && (
                <div className="ml-6 mt-2 grid grid-cols-2 gap-3">
                  <Field label="Brand">
                    <input
                      type="text"
                      value={subsetFilters.brand ?? ''}
                      onChange={(e) =>
                        setSubsetFilters({
                          ...subsetFilters,
                          brand: e.target.value || undefined,
                        })
                      }
                      placeholder="e.g. Xavia Racing"
                      className={inputCls}
                    />
                  </Field>
                  <Field label="Category (productType)">
                    <input
                      type="text"
                      value={subsetFilters.productType ?? ''}
                      onChange={(e) =>
                        setSubsetFilters({
                          ...subsetFilters,
                          productType: e.target.value || undefined,
                        })
                      }
                      placeholder="e.g. RACE_JACKET"
                      className={inputCls}
                    />
                  </Field>
                  <Field label="Marketplace">
                    <input
                      type="text"
                      value={subsetFilters.marketplace ?? ''}
                      onChange={(e) =>
                        setSubsetFilters({
                          ...subsetFilters,
                          marketplace: e.target.value || undefined,
                        })
                      }
                      placeholder="e.g. IT, DE"
                      className={inputCls}
                    />
                  </Field>
                  <Field label="Status">
                    <select
                      value={subsetFilters.status ?? ''}
                      onChange={(e) =>
                        setSubsetFilters({
                          ...subsetFilters,
                          status:
                            (e.target.value as ScopeFilters['status']) ||
                            undefined,
                        })
                      }
                      className={inputCls}
                    >
                      <option value="">Any</option>
                      <option value="DRAFT">Draft</option>
                      <option value="ACTIVE">Active</option>
                      <option value="INACTIVE">Inactive</option>
                    </select>
                  </Field>
                  <Field label="Stock min">
                    <input
                      type="number"
                      value={subsetFilters.stockMin ?? ''}
                      onChange={(e) =>
                        setSubsetFilters({
                          ...subsetFilters,
                          stockMin: e.target.value
                            ? parseInt(e.target.value, 10)
                            : undefined,
                        })
                      }
                      className={inputCls}
                    />
                  </Field>
                  <Field label="Stock max">
                    <input
                      type="number"
                      value={subsetFilters.stockMax ?? ''}
                      onChange={(e) =>
                        setSubsetFilters({
                          ...subsetFilters,
                          stockMax: e.target.value
                            ? parseInt(e.target.value, 10)
                            : undefined,
                        })
                      }
                      className={inputCls}
                    />
                  </Field>
                </div>
              )}
            </div>
          </Section>
          )}

          {/* Preview (job-based ops only) */}
          {!isSchemaOp && payloadValid && (
            <Section title="Preview">
              {previewLoading && (
                <div className="text-[12px] text-slate-500 inline-flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Computing…
                </div>
              )}
              {previewError && (
                <div className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 inline-flex items-start gap-2">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  <div>{previewError}</div>
                </div>
              )}
              {!previewLoading && !previewError && preview && (
                <>
                  <div className="text-[13px] font-medium text-slate-900 mb-2">
                    {preview.affectedCount.toLocaleString()}{' '}
                    {preview.affectedCount === 1 ? 'item' : 'items'} will be
                    affected.
                  </div>
                  {preview.sampleItems.length > 0 && (
                    <div className="border border-slate-200 rounded-md overflow-hidden">
                      <table className="w-full text-[12px]">
                        <thead className="bg-slate-50 text-slate-500">
                          <tr>
                            <th className="text-left px-3 py-1.5 font-medium">
                              SKU
                            </th>
                            <th className="text-left px-3 py-1.5 font-medium">
                              Current
                            </th>
                            <th className="text-left px-3 py-1.5 font-medium">
                              New
                            </th>
                            <th className="text-left px-3 py-1.5 font-medium w-[60px]">
                              Status
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.sampleItems.map((s) => (
                            <tr
                              key={s.id}
                              className="border-t border-slate-100"
                            >
                              <td className="px-3 py-1.5 font-mono text-[11px] text-slate-700 truncate max-w-[220px]">
                                {s.sku ?? '—'}
                              </td>
                              <td className="px-3 py-1.5 text-slate-600 tabular-nums">
                                {String(s.currentValue ?? '—')}
                              </td>
                              <td className="px-3 py-1.5 text-slate-900 tabular-nums">
                                {String(s.newValue ?? '—')}
                              </td>
                              <td className="px-3 py-1.5">
                                <span
                                  className={cn(
                                    'text-[10px] px-1.5 py-0.5 rounded',
                                    s.status === 'processed'
                                      ? 'bg-emerald-100 text-emerald-800'
                                      : 'bg-amber-100 text-amber-800',
                                  )}
                                >
                                  {s.status}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {preview.affectedCount > preview.sampleItems.length && (
                        <div className="px-3 py-1.5 text-[11px] text-slate-500 bg-slate-50 border-t border-slate-100">
                          + {preview.affectedCount - preview.sampleItems.length}{' '}
                          more
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </Section>
          )}

          {/* Job progress / result */}
          {job && (
            <Section title="Execution">
              <div className="space-y-2">
                <div className="text-[12px] text-slate-700 inline-flex items-center gap-2">
                  {executing && !jobTerminal && (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  )}
                  {jobTerminal && job.status === 'COMPLETED' && (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                  )}
                  {jobTerminal && job.status !== 'COMPLETED' && (
                    <AlertCircle className="w-3.5 h-3.5 text-amber-600" />
                  )}
                  Status: <strong>{job.status}</strong>
                  {job.progressPercent > 0 && (
                    <span className="text-slate-500">
                      · {job.progressPercent}%
                    </span>
                  )}
                </div>
                <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
                  <div
                    className={cn(
                      'h-full transition-all',
                      job.status === 'COMPLETED'
                        ? 'bg-emerald-500'
                        : job.status === 'FAILED'
                          ? 'bg-red-500'
                          : 'bg-blue-500',
                    )}
                    style={{ width: `${job.progressPercent ?? 0}%` }}
                  />
                </div>
                {jobTerminal && (
                  <div className="text-[12px] text-slate-700 grid grid-cols-3 gap-2 mt-2">
                    <Stat label="Processed" value={job.processedItems} tone="ok" />
                    <Stat label="Skipped" value={job.skippedItems} tone="warn" />
                    <Stat label="Failed" value={job.failedItems} tone="danger" />
                  </div>
                )}
                {job.lastError && (
                  <div className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 mt-2">
                    Last error: {job.lastError}
                  </div>
                )}
              </div>
            </Section>
          )}

          {executeError && (
            <div className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 inline-flex items-start gap-2">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <div>{executeError}</div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200 flex-shrink-0">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => !executing && onClose()}
            disabled={executing}
          >
            {jobTerminal ? 'Close' : 'Cancel'}
          </Button>
          {!jobTerminal && !isSchemaOp && (
            <Button
              variant="primary"
              size="sm"
              onClick={handleExecute}
              disabled={
                !payloadValid ||
                !preview ||
                preview.affectedCount === 0 ||
                executing
              }
              loading={executing}
            >
              {executing
                ? 'Executing…'
                : `Apply to ${preview?.affectedCount.toLocaleString() ?? 0}`}
            </Button>
          )}
          {isSchemaOp && (
            <Button
              variant="primary"
              size="sm"
              onClick={handleSchemaExecute}
              disabled={
                !schemaFieldId ||
                schemaValue === undefined ||
                schemaValue === '' ||
                visibleProductIds.length === 0 ||
                marketplaceTargets.length === 0 ||
                executing
              }
              loading={executing}
            >
              {executing
                ? 'Applying…'
                : `Apply to ${Math.min(visibleProductIds.length, 1000).toLocaleString()} × ${marketplaceTargets.length}`}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Small UI primitives ────────────────────────────────────────────

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-2">
        {title}
      </div>
      {children}
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <div className="text-[11px] text-slate-600 mb-1">{label}</div>
      {children}
    </label>
  )
}

function Radio({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: () => void
  label: React.ReactNode
}) {
  return (
    <label className="flex items-start gap-2 text-[13px] text-slate-700 cursor-pointer hover:text-slate-900">
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        className="mt-0.5 w-3.5 h-3.5 border-slate-300 text-blue-600 focus:ring-blue-500"
      />
      <span>{label}</span>
    </label>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'ok' | 'warn' | 'danger'
}) {
  const toneClass =
    tone === 'ok'
      ? 'text-emerald-700'
      : tone === 'warn'
        ? 'text-amber-700'
        : 'text-red-700'
  return (
    <div className="text-center bg-slate-50 rounded px-2 py-1.5">
      <div className={cn('text-[16px] font-semibold tabular-nums', toneClass)}>
        {value.toLocaleString()}
      </div>
      <div className="text-[10px] text-slate-500 uppercase tracking-wide">
        {label}
      </div>
    </div>
  )
}

function SchemaTargetsBanner({
  targets,
}: {
  targets: MarketplaceContext[]
}) {
  if (targets.length === 0) {
    return (
      <div className="text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 inline-flex items-start gap-2">
        <Globe className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        <div>
          No marketplace targets selected. Use the marketplace picker in
          the toolbar to pick one or more (Amazon IT / DE / FR …) before
          running this operation.
        </div>
      </div>
    )
  }
  return (
    <div className="text-[12px] text-blue-800 bg-blue-50 border border-blue-200 rounded px-3 py-2 inline-flex items-start gap-2">
      <Globe className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
      <div>
        Will fan out to{' '}
        <strong className="font-mono">
          {targets.map((t) => `${t.channel}:${t.marketplace}`).join(', ')}
        </strong>
        .
      </div>
    </div>
  )
}

const inputCls =
  'w-full h-7 px-2 text-[12px] border border-slate-200 rounded-md bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500'
