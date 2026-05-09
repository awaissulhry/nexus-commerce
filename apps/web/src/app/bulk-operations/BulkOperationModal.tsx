'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Globe,
  Loader2,
  Sparkles,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import { cn } from '@/lib/utils'
import {
  FieldInput,
  type Primitive,
  type UnionField,
  type UnionManifest,
} from '../products/_shared/attribute-editor'
import type { MarketplaceContext } from './components/MarketplaceSelector'
import { OPERATIONS } from './_operations/configs'
import { Field, inputCls } from './_operations/_helpers'
import type { OperationType as BulkOperationType } from './_operations/types'
import {
  TemplateLibrary,
  type ServerTemplate,
} from './components/TemplateLibrary'

// ── Operation contract ─────────────────────────────────────────────
//
// W1.7 — base OperationType + the array of operation configs moved
// to _operations/. The modal extends the union locally with
// SCHEMA_FIELD_UPDATE because that flow doesn't persist a
// BulkActionJob — it lives only in this modal's UI state.

type OperationType = BulkOperationType | 'SCHEMA_FIELD_UPDATE'


// ── Scope filter shape (matches backend ScopeFilters) ──────────────

interface ScopeFilters {
  brand?: string
  productType?: string
  marketplace?: string
  status?: 'DRAFT' | 'ACTIVE' | 'INACTIVE'
  stockMin?: number
  stockMax?: number
}

// P1 #34e — added 'selected' scope mode so the modal can take a row
// selection from the grid as the explicit target list, not via filter
// resolution. Backend already supports `targetProductIds` directly
// (validation.ts:23) — this just exposes it in the UI.
type ScopeMode = 'filter' | 'subset' | 'selected'

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
  /** P1 #34e — the operator's row selection from the grid. When
   *  non-empty, the modal exposes a "Selected rows (N)" scope mode
   *  that targets these IDs directly via targetProductIds, skipping
   *  filter resolution. Empty disables that mode. */
  selectedProductIds?: string[]
}

export default function BulkOperationModal({
  open,
  onClose,
  currentFilters,
  marketplaceTargets = [],
  visibleProductIds = [],
  selectedProductIds = [],
}: Props) {
  const [opType, setOpType] = useState<OperationType>('PRICING_UPDATE')
  const op = OPERATIONS.find((o) => o.type === opType)
  const isSchemaOp = opType === 'SCHEMA_FIELD_UPDATE'

  // W5.3 — Template library + apply state. The library opens as a
  // modal-on-modal: picking a template fills the modal's op + payload
  // (so the operator sees what's about to fire) and stashes the
  // template id in `appliedTemplateId` for the apply path to bump
  // the usageCount.
  const [templateLibraryOpen, setTemplateLibraryOpen] = useState(false)
  const [appliedTemplateId, setAppliedTemplateId] = useState<string | null>(
    null,
  )

  // W6.3 — Schedule picker state. When `mode === 'schedule'` the
  // footer's primary button POSTs to /api/scheduled-bulk-actions
  // with the modal's current operation + scope, instead of running
  // it now via /api/bulk-operations. Cron expression is optional —
  // when blank, the schedule fires once at scheduledFor.
  const [scheduleMode, setScheduleMode] = useState<'now' | 'schedule'>('now')
  const [scheduleAt, setScheduleAt] = useState<string>('') // datetime-local
  const [scheduleCron, setScheduleCron] = useState<string>('')
  const [scheduleName, setScheduleName] = useState<string>('')
  const [scheduling, setScheduling] = useState(false)
  const [scheduleResult, setScheduleResult] = useState<
    { id: string; nextRunAt: string | null } | null
  >(null)

  const [payload, setPayload] = useState<Record<string, unknown>>(
    op?.initialPayload ?? {},
  )
  // Reset payload when op changes
  useEffect(() => setPayload(op?.initialPayload ?? {}), [opType, op?.initialPayload])

  const [scopeMode, setScopeMode] = useState<ScopeMode>('filter')
  const [subsetFilters, setSubsetFilters] = useState<ScopeFilters>({})
  const activeFilters: ScopeFilters = useMemo(
    () => (scopeMode === 'filter' ? currentFilters ?? {} : subsetFilters),
    [scopeMode, currentFilters, subsetFilters],
  )

  // P1 #34e — single source of truth for scope payload going to the
  // backend. 'selected' mode targets explicit IDs; the other two pass
  // resolved filters. Backend's CreateBulkJobSchema accepts either.
  //
  // U.59 — MUST be useMemo'd. Effects 740/790 below depend on
  // scopePayload, and computing it inline made a fresh object every
  // render → effect re-fired every render → the bail-out branch's
  // `setConflicts([])` created a new empty array → re-render →
  // re-fire → ... an infinite render loop. React's concurrent
  // scheduler kept those urgent updates ahead of the App Router's
  // (low-priority) navigation transitions, so router.push() silently
  // no-op'd whenever this modal was mounted (even with open={false}).
  // The fix is just to memo the deps so the effects only fire when
  // something real changes.
  const scopePayload: {
    filters?: ScopeFilters
    targetProductIds?: string[]
  } = useMemo(
    () =>
      scopeMode === 'selected'
        ? { targetProductIds: selectedProductIds }
        : { filters: activeFilters },
    [scopeMode, selectedProductIds, activeFilters],
  )

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
      if (json.updated && json.updated > 0) {
        emitInvalidation({
          type: 'bulk-job.completed',
          meta: {
            schemaOp: true,
            updated: json.updated,
            errorCount: (json.errors ?? []).length,
          },
        })
      }
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

  // Conflict detection (Commit 18). Surfaces in-flight bulk jobs that
  // touch overlapping productIds + same actionType so the operator can
  // wait for the prior run, or explicitly acknowledge and force-run.
  // Keyed by `previewKey` so it re-fetches whenever scope/payload moves.
  const [conflicts, setConflicts] = useState<Array<{
    jobId: string
    jobName: string
    actionType: string
    status: string
    startedAt: string | null
    createdAt: string
    createdBy: string | null
    totalItems: number
    progressPercent: number
    overlapCount: number
    overlapTruncated: boolean
  }>>([])
  // conflictsLoading isn't surfaced in the UI today (the warning just
  // appears when results land); keeping the setter so the fetch effect
  // tracks "in flight" cleanly without re-rendering on the boolean.
  const [, setConflictsLoading] = useState(false)
  const [conflictsAck, setConflictsAck] = useState(false)
  const conflictsSeq = useRef(0)

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
      setConflicts([])
      setConflictsLoading(false)
      setConflictsAck(false)
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
        scope: scopePayload,
      }),
    [opType, payload, scopePayload],
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
              ...scopePayload,
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
  }, [open, payloadValid, previewKey, op?.label, opType, payload, scopePayload, isSchemaOp])

  // Conflict detection — fires alongside the preview, with the same
  // debounce key. We don't block the preview on it; the warning banner
  // appears below the preview when results land. Reset acknowledgement
  // every time scope/payload moves (operator hasn't seen the new
  // conflict set yet, so a stale ack shouldn't carry forward).
  useEffect(() => {
    if (!open || !payloadValid || isSchemaOp) {
      // U.59 — bail-out used to set a fresh `[]` every call, which
      // turned this effect into a render-loop driver when scopePayload
      // wasn't memo'd (now it is). Belt-and-braces: the functional
      // form bails when already empty so even if an upstream dep ever
      // churns again, we don't trigger a re-render here.
      setConflicts((prev) => (prev.length === 0 ? prev : []))
      return
    }
    const seq = ++conflictsSeq.current
    setConflictsLoading(true)
    setConflictsAck(false)
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/bulk-operations/check-conflicts`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jobName: `${op?.label ?? opType} (conflict-check)`,
              actionType: opType,
              ...scopePayload,
              actionPayload: payload,
            }),
          },
        )
        if (seq !== conflictsSeq.current) return
        if (!res.ok) {
          // Don't block the operator on a check-conflicts failure;
          // the create endpoint will run the same check authoritatively.
          setConflicts([])
          return
        }
        const data = await res.json()
        if (seq !== conflictsSeq.current) return
        setConflicts(Array.isArray(data.conflicts) ? data.conflicts : [])
      } catch {
        if (seq !== conflictsSeq.current) return
        setConflicts([])
      } finally {
        if (seq === conflictsSeq.current) setConflictsLoading(false)
      }
    }, 350)
    return () => window.clearTimeout(timer)
  }, [open, payloadValid, previewKey, op?.label, opType, payload, scopePayload, isSchemaOp])

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
            ...scopePayload,
            actionPayload: payload,
            // Conflicts surface in the modal before the operator clicks
            // Execute; clicking the "Run anyway" button sets conflictsAck
            // which lets us pass force=true through to the API.
            force: conflictsAck,
          }),
        },
      )
      if (createRes.status === 409) {
        // Race-condition fallback: between the conflict-check and the
        // execute click, a new job appeared on overlapping products.
        // Surface the fresh list and let the operator re-acknowledge.
        const body = await createRes.json().catch(() => ({}))
        const fresh = Array.isArray(body.conflicts) ? body.conflicts : []
        setConflicts(fresh)
        setConflictsAck(false)
        throw new Error(
          fresh.length > 0
            ? `New conflicting job(s) appeared — review the warning above and confirm "Run anyway" to override.`
            : (body.error ?? 'Job creation conflict'),
        )
      }
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
      let finalJob: typeof createdJob | null = null
      while (true) {
        await new Promise((r) => setTimeout(r, 2000))
        const statusRes = await fetch(
          `${getBackendUrl()}/api/bulk-operations/${createdJob.id}`,
          { cache: 'no-store' },
        )
        if (!statusRes.ok) break
        const { job: latest } = await statusRes.json()
        setJob(latest)
        finalJob = latest
        if (terminal.has(latest.status)) break
      }
      // Emit cross-page invalidation so /products + others refetch.
      // Skip on FAILED/CANCELLED — no real changes propagated.
      if (
        finalJob &&
        (finalJob.status === 'COMPLETED' ||
          finalJob.status === 'PARTIALLY_COMPLETED')
      ) {
        emitInvalidation({
          type: 'bulk-job.completed',
          meta: {
            jobId: finalJob.id,
            actionType: opType,
            status: finalJob.status,
            processedItems: finalJob.processedItems,
            failedItems: finalJob.failedItems,
          },
        })
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
        className="bg-white dark:bg-slate-900 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 w-[640px] max-w-[92vw] flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Bulk apply
            {appliedTemplateId && (
              <span
                className="ml-2 inline-flex items-center gap-1 text-xs font-normal text-amber-700 dark:text-amber-400"
                title="Loaded from template"
              >
                <Sparkles className="w-3 h-3" />
                from template
              </span>
            )}
          </h2>
          <div className="flex items-center gap-1">
            {/* W5.3 — Templates trigger. Opens the library where the
                operator can browse / save / apply reusable bulk-action
                presets. The library is modal-on-modal — eats clicks
                outside to close, returns control to this modal on
                template-select. */}
            <button
              type="button"
              onClick={() => setTemplateLibraryOpen(true)}
              disabled={executing}
              className={cn(
                'h-7 px-2 inline-flex items-center gap-1 rounded border text-xs font-medium transition-colors',
                'bg-amber-50 border-amber-200 text-amber-700 hover:bg-amber-100',
                'dark:bg-amber-950/40 dark:border-amber-900 dark:text-amber-400',
                'disabled:opacity-50',
              )}
              title="Browse + apply saved templates"
            >
              <Sparkles className="w-3 h-3" />
              Templates
            </button>
            <button
              type="button"
              onClick={() => !executing && onClose()}
              className="text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 disabled:opacity-50 ml-1"
              disabled={executing}
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
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
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40 text-blue-900'
                      : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600',
                  )}
                >
                  <div className="text-md font-medium">{o.label}</div>
                  <div className="text-sm text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-2">
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
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40 text-blue-900'
                    : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600',
                )}
              >
                <div className="text-md font-medium inline-flex items-center gap-1.5">
                  <Globe className="w-3.5 h-3.5" />
                  Set channel attribute
                </div>
                <div className="text-sm text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-2">
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
                  <div className="text-base text-slate-500 dark:text-slate-400 inline-flex items-center gap-1.5">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Loading schema fields…
                  </div>
                )}
                {schemaError && (
                  <div className="text-base text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded px-3 py-2 inline-flex items-start gap-2">
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
                            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                              {schemaField.description}
                            </p>
                          )}
                        </Field>
                      )}
                    </>
                  )}
              </div>
              <div className="mt-3 text-sm text-slate-500 dark:text-slate-400">
                Targets {visibleProductIds.length.toLocaleString()} visible
                product{visibleProductIds.length === 1 ? '' : 's'} ×{' '}
                {marketplaceTargets.length} marketplace
                {marketplaceTargets.length === 1 ? '' : 's'}
                {visibleProductIds.length > 1000 && (
                  <span className="text-amber-700 dark:text-amber-300">
                    {' '}
                    (capped at 1000 — refine the grid filter to narrow it
                    down)
                  </span>
                )}
                .
              </div>
              {schemaResult && (
                <div className="mt-3 text-base text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 rounded px-3 py-2">
                  Updated {schemaResult.updated.toLocaleString()} listing
                  {schemaResult.updated === 1 ? '' : 's'}.
                  {schemaResult.errors.length > 0 && (
                    <span className="text-amber-700 dark:text-amber-300 ml-1">
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
                    <span className="text-slate-500 dark:text-slate-400">
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
              {/* P1 #34e — selected-rows scope. Disabled when the
                  operator hasn't picked any rows on the parent grid. */}
              <Radio
                checked={scopeMode === 'selected'}
                onChange={() => {
                  if (selectedProductIds.length > 0) setScopeMode('selected')
                }}
                label={
                  <>
                    Selected rows{' '}
                    <span className="text-slate-500 dark:text-slate-400">
                      ({selectedProductIds.length}
                      {selectedProductIds.length === 0
                        ? ' — pick rows on the grid first'
                        : ''}
                      )
                    </span>
                  </>
                }
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
                <div className="text-base text-slate-500 dark:text-slate-400 inline-flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Computing…
                </div>
              )}
              {previewError && (
                <div className="text-base text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded px-3 py-2 inline-flex items-start gap-2">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  <div>{previewError}</div>
                </div>
              )}
              {!previewLoading && !previewError && preview && (
                <>
                  <div className="text-md font-medium text-slate-900 dark:text-slate-100 mb-2">
                    {preview.affectedCount.toLocaleString()}{' '}
                    {preview.affectedCount === 1 ? 'item' : 'items'} will be
                    affected.
                  </div>
                  {preview.sampleItems.length > 0 && (
                    <div className="border border-slate-200 dark:border-slate-700 rounded-md overflow-hidden">
                      <table className="w-full text-base">
                        <thead className="bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
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
                              className="border-t border-slate-100 dark:border-slate-800"
                            >
                              <td className="px-3 py-1.5 font-mono text-sm text-slate-700 dark:text-slate-300 truncate max-w-[220px]">
                                {s.sku ?? '—'}
                              </td>
                              <td className="px-3 py-1.5 text-slate-600 dark:text-slate-400 tabular-nums">
                                {String(s.currentValue ?? '—')}
                              </td>
                              <td className="px-3 py-1.5 text-slate-900 dark:text-slate-100 tabular-nums">
                                {String(s.newValue ?? '—')}
                              </td>
                              <td className="px-3 py-1.5">
                                <span
                                  className={cn(
                                    'text-xs px-1.5 py-0.5 rounded',
                                    s.status === 'processed'
                                      ? 'bg-emerald-100 dark:bg-emerald-900/60 text-emerald-800'
                                      : 'bg-amber-100 dark:bg-amber-900/60 text-amber-800',
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
                        <div className="px-3 py-1.5 text-sm text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800 border-t border-slate-100 dark:border-slate-800">
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
                <div className="text-base text-slate-700 dark:text-slate-300 inline-flex items-center gap-2">
                  {executing && !jobTerminal && (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  )}
                  {jobTerminal && job.status === 'COMPLETED' && (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                  )}
                  {jobTerminal && job.status !== 'COMPLETED' && (
                    <AlertCircle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                  )}
                  Status: <strong>{job.status}</strong>
                  {job.progressPercent > 0 && (
                    <span className="text-slate-500 dark:text-slate-400">
                      · {job.progressPercent}%
                    </span>
                  )}
                </div>
                <div className="w-full bg-slate-100 dark:bg-slate-800 rounded-full h-1.5 overflow-hidden">
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
                  <div className="text-base text-slate-700 dark:text-slate-300 grid grid-cols-3 gap-2 mt-2">
                    <Stat label="Processed" value={job.processedItems} tone="ok" />
                    <Stat label="Skipped" value={job.skippedItems} tone="warn" />
                    <Stat label="Failed" value={job.failedItems} tone="danger" />
                  </div>
                )}
                {job.lastError && (
                  <div className="text-sm text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded px-3 py-2 mt-2">
                    Last error: {job.lastError}
                  </div>
                )}
              </div>
            </Section>
          )}

          {/* Conflict warning — shown when one or more in-flight jobs
              touch overlapping products + same actionType. Operator
              must explicitly check "Run anyway" before Execute unlocks. */}
          {conflicts.length > 0 && !job && !isSchemaOp && (
            <div className="text-base bg-amber-50 dark:bg-amber-950/40 border border-amber-300 rounded px-3 py-2.5 space-y-2">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
                <div className="space-y-1.5 flex-1">
                  <div className="font-semibold text-amber-900">
                    {conflicts.length === 1
                      ? '1 in-flight job overlaps with this scope'
                      : `${conflicts.length} in-flight jobs overlap with this scope`}
                  </div>
                  <div className="text-amber-800">
                    These jobs are running on the same {opType.replace('_', ' ').toLowerCase()} action
                    + at least one shared product. Running anyway can race
                    against them and produce a last-write-wins result. Wait
                    for the prior run to finish, or check "Run anyway" to
                    override.
                  </div>
                  <ul className="space-y-1 mt-1">
                    {conflicts.map((c) => (
                      <li
                        key={c.jobId}
                        className="text-sm text-amber-900 bg-white/60 border border-amber-200 dark:border-amber-900 rounded px-2 py-1.5 flex items-center justify-between gap-3"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="font-medium truncate">
                            {c.jobName}
                          </div>
                          <div className="text-amber-700 dark:text-amber-300 text-xs">
                            {c.status} · {c.progressPercent}% · {c.totalItems.toLocaleString()} items
                            {c.createdBy ? ` · by ${c.createdBy}` : ''}
                          </div>
                        </div>
                        <div className="flex-shrink-0 text-xs font-mono bg-amber-100 dark:bg-amber-900/60 text-amber-900 border border-amber-200 dark:border-amber-900 rounded px-1.5 py-0.5">
                          ~{c.overlapCount.toLocaleString()}
                          {c.overlapTruncated ? '+' : ''} overlap
                        </div>
                      </li>
                    ))}
                  </ul>
                  <label className="flex items-center gap-2 text-amber-900 cursor-pointer pt-1">
                    <input
                      type="checkbox"
                      checked={conflictsAck}
                      onChange={(e) => setConflictsAck(e.target.checked)}
                      className="cursor-pointer"
                    />
                    <span className="text-base">
                      Run anyway — I accept that this may overwrite changes from the in-flight run.
                    </span>
                  </label>
                </div>
              </div>
            </div>
          )}

          {executeError && (
            <div className="text-base text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded px-3 py-2 inline-flex items-start gap-2">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <div>{executeError}</div>
            </div>
          )}

          {/* W6.3 — Schedule inputs. Visible only when the operator
              has flipped to "Schedule" mode in the footer. The save
              path lives on the footer's primary button (above). */}
          {!isSchemaOp && scheduleMode === 'schedule' && !scheduleResult && (
            <div className="border border-purple-200 dark:border-purple-900 bg-purple-50/50 dark:bg-purple-950/20 rounded p-3 space-y-2">
              <div className="text-sm font-semibold text-purple-700 dark:text-purple-300 inline-flex items-center gap-1.5">
                <CalendarClock className="w-3.5 h-3.5" />
                Schedule this operation
              </div>
              <label className="block">
                <span className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-0.5 block">
                  Schedule name
                </span>
                <input
                  type="text"
                  value={scheduleName}
                  onChange={(e) => setScheduleName(e.target.value)}
                  placeholder={op?.label ? `${op.label} (scheduled)` : 'Schedule name'}
                  className={inputCls}
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-0.5 block">
                    Run at (optional if cron set)
                  </span>
                  <input
                    type="datetime-local"
                    value={scheduleAt}
                    onChange={(e) => setScheduleAt(e.target.value)}
                    className={inputCls}
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-0.5 block">
                    Cron (optional, e.g. 0 2 * * *)
                  </span>
                  <input
                    type="text"
                    value={scheduleCron}
                    onChange={(e) => setScheduleCron(e.target.value)}
                    placeholder="m h dom mon dow"
                    className={`${inputCls} font-mono text-xs`}
                  />
                </label>
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Set just the date/time for a one-shot. Set just the cron
                for a pure recurring schedule. Set both to start a
                recurring schedule on a specific date. Times use{' '}
                <strong>Europe/Rome</strong>.
              </div>
            </div>
          )}

          {/* W6.3 — Saved-schedule confirmation. */}
          {scheduleResult && (
            <div className="text-base text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 rounded px-3 py-2 inline-flex items-start gap-2">
              <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <div>
                Schedule saved.{' '}
                {scheduleResult.nextRunAt
                  ? `Next run: ${new Date(scheduleResult.nextRunAt).toLocaleString()}.`
                  : 'No next run scheduled.'}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200 dark:border-slate-700 flex-shrink-0">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => !executing && onClose()}
            disabled={executing}
          >
            {jobTerminal ? 'Close' : 'Cancel'}
          </Button>
          {/* W6.3 — schedule mode toggle. Flipping to "schedule"
              swaps the primary button from "Apply now" to "Save
              schedule" and reveals the datetime + cron inputs. */}
          {!jobTerminal && !isSchemaOp && (
            <button
              type="button"
              onClick={() =>
                setScheduleMode((m) => (m === 'now' ? 'schedule' : 'now'))
              }
              disabled={executing || scheduling}
              title="Schedule this operation for later or on a recurring cadence"
              className={cn(
                'h-7 px-2 inline-flex items-center gap-1 rounded border text-xs font-medium transition-colors',
                scheduleMode === 'schedule'
                  ? 'bg-purple-50 dark:bg-purple-950/40 border-purple-300 dark:border-purple-800 text-purple-700 dark:text-purple-300'
                  : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800',
                'disabled:opacity-50',
              )}
              aria-pressed={scheduleMode === 'schedule'}
            >
              <CalendarClock className="w-3 h-3" />
              {scheduleMode === 'schedule' ? 'Run now' : 'Schedule…'}
            </button>
          )}
          {!jobTerminal && !isSchemaOp && scheduleMode === 'now' && (
            <Button
              variant="primary"
              size="sm"
              onClick={handleExecute}
              disabled={
                !payloadValid ||
                !preview ||
                preview.affectedCount === 0 ||
                executing ||
                (conflicts.length > 0 && !conflictsAck)
              }
              loading={executing}
            >
              {executing
                ? 'Executing…'
                : conflicts.length > 0 && conflictsAck
                  ? `Run anyway on ${preview?.affectedCount.toLocaleString() ?? 0}`
                  : `Apply to ${preview?.affectedCount.toLocaleString() ?? 0}`}
            </Button>
          )}
          {!jobTerminal && !isSchemaOp && scheduleMode === 'schedule' && (
            <Button
              variant="primary"
              size="sm"
              onClick={async () => {
                if (!scheduleName.trim() && !op?.label) return
                if (!scheduleAt && !scheduleCron) return
                setScheduling(true)
                setExecuteError(null)
                try {
                  const res = await fetch(
                    `${getBackendUrl()}/api/scheduled-bulk-actions`,
                    {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        name:
                          scheduleName.trim() ||
                          `${op?.label ?? 'Bulk action'} (scheduled)`,
                        actionType: opType,
                        actionPayload: payload,
                        filters: scopePayload.filters ?? null,
                        targetProductIds: scopePayload.targetProductIds,
                        scheduledFor: scheduleAt
                          ? new Date(scheduleAt).toISOString()
                          : null,
                        cronExpression: scheduleCron.trim() || null,
                        timezone: 'Europe/Rome',
                      }),
                    },
                  )
                  const json = await res.json()
                  if (!res.ok) {
                    throw new Error(json.error ?? `HTTP ${res.status}`)
                  }
                  setScheduleResult({
                    id: json.schedule.id,
                    nextRunAt: json.schedule.nextRunAt,
                  })
                } catch (err) {
                  setExecuteError(
                    err instanceof Error ? err.message : String(err),
                  )
                } finally {
                  setScheduling(false)
                }
              }}
              disabled={
                !payloadValid ||
                scheduling ||
                (!scheduleAt && !scheduleCron)
              }
              loading={scheduling}
            >
              {scheduling
                ? 'Scheduling…'
                : scheduleResult
                  ? 'Scheduled ✓'
                  : 'Save schedule'}
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
      {/* W5.3 — Template library / save panel. Modal-on-modal; the
          parent's backdrop click is suppressed by the library's own
          stopPropagation, so closing the library returns control to
          the bulk-apply modal cleanly. */}
      <TemplateLibrary
        open={templateLibraryOpen}
        onClose={() => setTemplateLibraryOpen(false)}
        onSelect={(template: ServerTemplate) => {
          // Load the template into the modal: switch to its
          // actionType (when it's one of the OPERATIONS we render)
          // and seed the payload. SCHEMA_FIELD_UPDATE templates would
          // need extra wiring (schemaFieldId/value); not in scope for
          // v0. Operators see the modal pre-filled with the
          // template's defaults and can tweak before applying.
          if (
            ['PRICING_UPDATE', 'INVENTORY_UPDATE', 'STATUS_UPDATE',
              'ATTRIBUTE_UPDATE', 'LISTING_SYNC',
              'MARKETPLACE_OVERRIDE_UPDATE'].includes(template.actionType)
          ) {
            setOpType(template.actionType as OperationType)
            setPayload(template.actionPayload as Record<string, unknown>)
          }
          setAppliedTemplateId(template.id)
          setTemplateLibraryOpen(false)
        }}
        currentDraft={
          payloadValid
            ? {
                actionType: opType,
                channel: null,
                actionPayload: payload,
                defaultFilters:
                  activeFilters as unknown as Record<string, unknown>,
              }
            : null
        }
      />
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
      <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">
        {title}
      </div>
      {children}
    </div>
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
    <label className="flex items-start gap-2 text-md text-slate-700 dark:text-slate-300 cursor-pointer hover:text-slate-900 dark:hover:text-slate-100">
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        className="mt-0.5 w-3.5 h-3.5 border-slate-300 dark:border-slate-600 text-blue-600 dark:text-blue-400 focus:ring-blue-500"
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
      ? 'text-emerald-700 dark:text-emerald-300'
      : tone === 'warn'
        ? 'text-amber-700 dark:text-amber-300'
        : 'text-red-700 dark:text-red-300'
  return (
    <div className="text-center bg-slate-50 dark:bg-slate-800 rounded px-2 py-1.5">
      <div className={cn('text-xl font-semibold tabular-nums', toneClass)}>
        {value.toLocaleString()}
      </div>
      <div className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wide">
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
      <div className="text-base text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded px-3 py-2 inline-flex items-start gap-2">
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
    <div className="text-base text-blue-800 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 rounded px-3 py-2 inline-flex items-start gap-2">
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

