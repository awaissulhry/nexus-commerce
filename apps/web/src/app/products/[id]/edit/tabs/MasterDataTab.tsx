'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertCircle,
  CheckCircle2,
  ChevronsDown,
  GitFork,
  Globe,
  Loader2,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'

interface Props {
  product: any
  onDirtyChange: (count: number) => void
  /** W1.1 — bumped by parent's "Discard" handler. */
  discardSignal: number
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

const SAVE_DEBOUNCE_MS = 600

const MASTER_FIELDS = [
  'sku',
  'name',
  'brand',
  'manufacturer',
  'upc',
  'ean',
  'status',
] as const

type MasterField = (typeof MASTER_FIELDS)[number]

// Fields that make sense to cascade to child variants
const CASCADE_FIELDS = new Set<MasterField>(['name', 'brand', 'manufacturer'])

function seedFromProduct(product: any): Record<MasterField, string> {
  const seed = {} as Record<MasterField, string>
  for (const f of MASTER_FIELDS) {
    const v = product[f]
    seed[f] = v == null ? '' : String(v)
  }
  if (!seed.status) seed.status = 'ACTIVE'
  return seed
}

export default function MasterDataTab({
  product,
  onDirtyChange,
  discardSignal,
}: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const router = useRouter()
  const [data, setData] = useState<Record<MasterField, string>>(() =>
    seedFromProduct(product),
  )
  const [aiBusy, setAiBusy] = useState(false)
  // W1.2 — local copy of Product.version for CAS-bump on save.
  const [version, setVersion] = useState<number | null>(
    typeof product.version === 'number' ? product.version : null,
  )
  const [conflict, setConflict] = useState<{
    expected: number
    current: number | null
  } | null>(null)

  const [status, setStatus] = useState<SaveStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const dirtyRef = useRef<Set<MasterField>>(new Set())
  // Always holds the latest data so flush() doesn't read a stale
  // closure snapshot from the render that set the debounce timer.
  const dataRef = useRef(data)
  useEffect(() => { dataRef.current = data }, [data])
  const saveTimer = useRef<number | null>(null)
  const reportDirty = () => onDirtyChange(dirtyRef.current.size)

  // IN.3 — per-field cascade state
  const childCount: number = product.childCount ?? (product.isParent ? 1 : 0)
  const canCascade = product.isParent && childCount > 0
  const [cascadeField, setCascadeField] = useState<MasterField | null>(null)
  const [cascading, setCascading] = useState(false)
  const [cascadeAllOpen, setCascadeAllOpen] = useState(false)

  const update = (field: MasterField, value: string) => {
    setData((prev) => ({ ...prev, [field]: value }))
    dirtyRef.current.add(field)
    reportDirty()
    setStatus('saving')
    setError(null)
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => { void flush() }, SAVE_DEBOUNCE_MS)
  }

  // AI suggest for the product name (title generation, IT primary market).
  const aiSuggestName = async () => {
    setAiBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/products/ai/bulk-generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds: [product.id], fields: ['title'], marketplace: 'IT', dryRun: true }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      const json = await res.json()
      const result = json?.results?.[0]
      if (!result?.ok) throw new Error(result?.error ?? t('products.edit.master.aiNoSuggestion'))
      const next = result.generated?.title?.content
      if (typeof next === 'string' && next.length > 0) {
        update('name', next)
        toast.success(t('products.edit.master.aiSuggested'))
      } else {
        toast.error(t('products.edit.master.aiNoSuggestion'))
      }
    } catch (e: any) {
      toast.error(t('products.edit.master.aiFailed', { error: e?.message ?? String(e) }))
    } finally {
      setAiBusy(false)
    }
  }

  const flush = async () => {
    const fields = Array.from(dirtyRef.current)
    if (fields.length === 0) { setStatus('idle'); return }
    const changes = fields.map((field) => {
      const raw = dataRef.current[field]
      return { id: product.id, field, value: raw === '' ? null : raw }
    })
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (typeof version === 'number') headers['If-Match'] = String(version)
      const res = await fetch(`${getBackendUrl()}/api/products/bulk`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          changes,
          ...(typeof version === 'number' ? { expectedVersion: version } : {}),
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        if (res.status === 409 && body?.code === 'VERSION_CONFLICT') {
          setStatus('error')
          setError(null)
          setConflict({
            expected: typeof body.expectedVersion === 'number' ? body.expectedVersion : (version ?? 0),
            current: typeof body.currentVersion === 'number' ? body.currentVersion : null,
          })
          return
        }
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      const respBody = await res.json().catch(() => null)
      if (typeof respBody?.currentVersion === 'number') {
        setVersion(respBody.currentVersion)
      } else if (typeof version === 'number') {
        setVersion(version + 1)
      }
      const flushedFields = Array.from(dirtyRef.current)
      dirtyRef.current = new Set()
      reportDirty()
      setStatus('saved')
      window.setTimeout(() => { setStatus((s) => (s === 'saved' ? 'idle' : s)) }, 1500)
      emitInvalidation({ type: 'product.updated', id: product.id, fields: flushedFields, meta: { source: 'master-data-tab' } })
    } catch (e) {
      setStatus('error')
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // IN.3 — push a single field (or array of fields) to all children
  const doCascade = useCallback(async (fields: (MasterField | string)[]) => {
    setCascading(true)
    try {
      const changes = fields.map((field) => ({
        id: product.id,
        field,
        value: (dataRef.current as Record<string, string>)[field] === '' ? null : (dataRef.current as Record<string, string>)[field],
        cascade: true,
      }))
      const res = await fetch(`${getBackendUrl()}/api/products/bulk`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      const body = await res.json().catch(() => null)
      const affected: number = body?.affectedChildren?.length ?? childCount
      toast({ tone: 'success', title: `Cascaded to ${affected} variant${affected !== 1 ? 's' : ''}` })
    } catch (e: any) {
      toast({ tone: 'error', title: 'Cascade failed', description: e?.message ?? String(e) })
    } finally {
      setCascading(false)
      setCascadeField(null)
      setCascadeAllOpen(false)
    }
  }, [product.id, childCount, toast])

  // Flush on unmount so an in-flight debounce doesn't drop the last edit.
  useEffect(() => {
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      if (dirtyRef.current.size > 0) void flush()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // W1.1 — react to parent Discard.
  const discardSeen = useRef(discardSignal)
  useEffect(() => {
    if (discardSignal === discardSeen.current) return
    discardSeen.current = discardSignal
    if (saveTimer.current) { window.clearTimeout(saveTimer.current); saveTimer.current = null }
    dirtyRef.current = new Set()
    setData(seedFromProduct(product))
    setStatus('idle')
    setError(null)
    setConflict(null)
    setVersion(typeof product.version === 'number' ? product.version : null)
    reportDirty()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discardSignal, product])

  const cascadableDirtyFields = Array.from(dirtyRef.current).filter((f) => CASCADE_FIELDS.has(f)) as MasterField[]

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

      {/* Save status + cascade-all button */}
      <div className="flex items-center gap-3 flex-wrap">
        <SaveStatusBar status={status} error={error} t={t} />
        {canCascade && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setCascadeAllOpen((o) => !o)}
              title={`Push fields to ${childCount} child variant${childCount !== 1 ? 's' : ''}`}
              className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-medium transition-colors',
                cascadeAllOpen
                  ? 'bg-amber-100 dark:bg-amber-900/30 border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-300'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800',
              )}
            >
              <ChevronsDown className="w-3.5 h-3.5" />
              Cascade to variants
            </button>
            {cascadeAllOpen && (
              <CascadeAllPopover
                fields={CASCADE_FIELDS}
                data={data}
                childCount={childCount}
                cascading={cascading}
                highlightFields={new Set(cascadableDirtyFields)}
                onApply={(fields) => void doCascade(fields)}
                onClose={() => setCascadeAllOpen(false)}
              />
            )}
          </div>
        )}
      </div>

      <Card
        title={t('products.edit.master.identityTitle')}
        description={t('products.edit.master.identityDesc')}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3">
          <Input
            label={t('products.edit.master.skuLabel')}
            value={data.sku}
            mono
            onChange={(e) => update('sku', e.target.value)}
          />
          <div className="relative">
            <Input
              label={t('products.edit.master.nameLabel')}
              value={data.name}
              onChange={(e) => update('name', e.target.value)}
            />
            <AiSuggestOverlay
              busy={aiBusy}
              onClick={() => void aiSuggestName()}
              tooltip={t('products.edit.master.aiSuggestTitle')}
            />
            <NameCounter value={data.name} t={t} />
            {canCascade && (
              <CascadeFieldButton
                field="name"
                active={cascadeField === 'name'}
                cascading={cascading && cascadeField === 'name'}
                childCount={childCount}
                onRequest={() => setCascadeField(cascadeField === 'name' ? null : 'name')}
                onConfirm={() => void doCascade(['name'])}
                onCancel={() => setCascadeField(null)}
                offsetRight="2.5rem"
              />
            )}
          </div>
          <div className="relative">
            <Input
              label={t('products.edit.master.brandLabel')}
              value={data.brand}
              onChange={(e) => update('brand', e.target.value)}
            />
            {canCascade && (
              <CascadeFieldButton
                field="brand"
                active={cascadeField === 'brand'}
                cascading={cascading && cascadeField === 'brand'}
                childCount={childCount}
                onRequest={() => setCascadeField(cascadeField === 'brand' ? null : 'brand')}
                onConfirm={() => void doCascade(['brand'])}
                onCancel={() => setCascadeField(null)}
              />
            )}
          </div>
          <div className="relative">
            <Input
              label={t('products.edit.master.manufacturerLabel')}
              value={data.manufacturer}
              onChange={(e) => update('manufacturer', e.target.value)}
            />
            {canCascade && (
              <CascadeFieldButton
                field="manufacturer"
                active={cascadeField === 'manufacturer'}
                cascading={cascading && cascadeField === 'manufacturer'}
                childCount={childCount}
                onRequest={() => setCascadeField(cascadeField === 'manufacturer' ? null : 'manufacturer')}
                onConfirm={() => void doCascade(['manufacturer'])}
                onCancel={() => setCascadeField(null)}
              />
            )}
          </div>
          <Input
            label={t('products.edit.master.upcLabel')}
            value={data.upc}
            mono
            onChange={(e) => update('upc', e.target.value)}
          />
          <Input
            label={t('products.edit.master.eanLabel')}
            value={data.ean}
            mono
            onChange={(e) => update('ean', e.target.value)}
          />
        </div>
      </Card>

      <Card
        title={t('products.edit.master.statusTitle')}
        description={t('products.edit.master.statusDesc')}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3">
          <SelectField
            label={t('products.edit.master.statusLabel')}
            value={data.status || 'ACTIVE'}
            onChange={(v) => update('status', v)}
            options={[
              { value: 'ACTIVE',   label: t('products.edit.master.statusActive') },
              { value: 'DRAFT',    label: t('products.edit.master.statusDraft') },
              { value: 'INACTIVE', label: t('products.edit.master.statusInactive') },
            ]}
          />
        </div>
      </Card>

      <MarketAvailabilityCard productId={product.id} />
    </div>
  )
}

// ── IN.3 — Per-field cascade button ──────────────────────────────────────────

interface CascadeFieldButtonProps {
  field: string
  active: boolean
  cascading: boolean
  childCount: number
  onRequest: () => void
  onConfirm: () => void
  onCancel: () => void
  /** Extra right offset to avoid overlapping other absolute buttons (e.g. AI suggest). */
  offsetRight?: string
}

function CascadeFieldButton({
  field, active, cascading, childCount,
  onRequest, onConfirm, onCancel,
  offsetRight = '0.375rem',
}: CascadeFieldButtonProps) {
  if (active) {
    return (
      <div
        className="absolute bottom-1.5 flex items-center gap-1"
        style={{ right: offsetRight }}
      >
        <span className="text-[10px] text-amber-700 dark:text-amber-400 whitespace-nowrap">
          Push to {childCount} variant{childCount !== 1 ? 's' : ''}?
        </span>
        <button
          type="button"
          onClick={onConfirm}
          disabled={cascading}
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50 transition-colors"
        >
          {cascading ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <GitFork className="w-2.5 h-2.5" />}
          Push
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center justify-center w-4 h-4 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={onRequest}
      title={`Cascade ${field} to all child variants`}
      className="absolute bottom-1.5 inline-flex items-center justify-center w-6 h-6 rounded text-slate-300 dark:text-slate-600 hover:bg-amber-50 dark:hover:bg-amber-950/40 hover:text-amber-600 dark:hover:text-amber-400 transition-colors"
      style={{ right: offsetRight }}
    >
      <GitFork className="w-3.5 h-3.5" />
    </button>
  )
}

// ── IN.3 — Cascade-all popover ────────────────────────────────────────────────

const CASCADE_FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  brand: 'Brand',
  manufacturer: 'Manufacturer',
}

interface CascadeAllPopoverProps {
  fields: Set<string>
  data: Record<string, string>
  childCount: number
  cascading: boolean
  highlightFields: Set<string>
  onApply: (fields: MasterField[]) => void
  onClose: () => void
}

function CascadeAllPopover({
  fields, data, childCount, cascading, highlightFields, onApply, onClose,
}: CascadeAllPopoverProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set(fields))

  function toggle(f: string) {
    setSelected((prev) => {
      const n = new Set(prev)
      n.has(f) ? n.delete(f) : n.add(f)
      return n
    })
  }

  return (
    <div className="absolute left-0 top-full mt-1.5 z-50 w-64 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl overflow-hidden">
      <div className="px-3 py-2.5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <ChevronsDown className="w-3.5 h-3.5 text-amber-500" />
          <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
            Cascade to {childCount} variant{childCount !== 1 ? 's' : ''}
          </span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="px-3 py-2 space-y-1">
        <p className="text-[10px] text-slate-400 dark:text-slate-500 mb-2">
          Select fields to push to all child variants:
        </p>
        {Array.from(fields).map((f) => {
          const val = data[f] ?? ''
          const isDirty = highlightFields.has(f)
          return (
            <label
              key={f}
              className={cn(
                'flex items-center gap-2.5 px-2 py-1.5 rounded-lg cursor-pointer transition-colors',
                selected.has(f)
                  ? 'bg-amber-50 dark:bg-amber-900/20'
                  : 'hover:bg-slate-50 dark:hover:bg-slate-800/50',
              )}
            >
              <input
                type="checkbox"
                checked={selected.has(f)}
                onChange={() => toggle(f)}
                className="w-3.5 h-3.5 accent-amber-500 shrink-0"
              />
              <span className="text-xs font-medium text-slate-700 dark:text-slate-300 w-24 shrink-0">
                {CASCADE_FIELD_LABELS[f] ?? f}
                {isDirty && (
                  <span className="ml-1 text-[9px] text-amber-500 font-semibold">unsaved</span>
                )}
              </span>
              <span className="text-[10px] text-slate-400 dark:text-slate-500 truncate font-mono">
                {val || '—'}
              </span>
            </label>
          )
        })}
      </div>
      <div className="px-3 py-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
        >
          Cancel
        </button>
        <Button
          variant="primary"
          size="sm"
          disabled={selected.size === 0 || cascading}
          onClick={() => onApply(Array.from(selected) as MasterField[])}
        >
          {cascading
            ? <Loader2 className="w-3 h-3 animate-spin mr-1" />
            : <ChevronsDown className="w-3 h-3 mr-1" />}
          Push {selected.size} field{selected.size !== 1 ? 's' : ''}
        </Button>
      </div>
    </div>
  )
}

function AiSuggestOverlay({ busy, onClick, tooltip }: { busy: boolean; onClick: () => void; tooltip: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={tooltip}
      aria-label={tooltip}
      disabled={busy}
      className={cn(
        'absolute right-7 bottom-1.5 inline-flex items-center justify-center w-6 h-6 rounded text-slate-400 dark:text-slate-500 hover:bg-blue-50 dark:hover:bg-blue-950/40 hover:text-blue-600 dark:hover:text-blue-400 transition-colors',
        busy && 'opacity-50 cursor-wait',
      )}
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
    </button>
  )
}

const NAME_LIMITS = [
  { channel: 'eBay', limit: 80 },
  { channel: 'Amazon', limit: 200 },
] as const

function NameCounter({ value, t }: { value: string; t: (key: string, vars?: Record<string, string | number>) => string }) {
  const len = value.length
  const ebayLimit = NAME_LIMITS[0].limit
  const tone = len === 0 ? 'idle' : len > ebayLimit ? 'over' : len > ebayLimit * 0.9 ? 'near' : 'ok'
  return (
    <div className="mt-1 text-right">
      <span
        className={cn(
          'inline-block tabular-nums font-mono text-[10px] px-1.5 py-px rounded',
          tone === 'over' && 'text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40',
          tone === 'near' && 'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40',
          tone === 'ok'   && 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40',
          tone === 'idle' && 'text-slate-500 dark:text-slate-400',
        )}
        title={NAME_LIMITS.map((c) => `${c.channel}: ${c.limit}`).join(' · ')}
      >
        {t('products.edit.master.nameCount', { len, ebayLimit })}
      </span>
    </div>
  )
}

function ConflictBanner({ expected, current, onReload, onDismiss, t }: {
  expected: number; current: number | null
  onReload: () => void; onDismiss: () => void
  t: (key: string, vars?: Record<string, string | number>) => string
}) {
  return (
    <div role="alert" className="border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 rounded-lg px-4 py-3 flex items-start justify-between gap-3">
      <div className="flex items-start gap-2 min-w-0">
        <AlertCircle className="w-4 h-4 mt-0.5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
        <div className="min-w-0">
          <div className="text-md font-semibold text-amber-900 dark:text-amber-200">{t('products.edit.conflict.title')}</div>
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
        <Button variant="ghost" size="sm" onClick={onDismiss} aria-label={t('products.edit.conflict.dismiss')}>
          <X className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  )
}

function SaveStatusBar({ status, error, t }: {
  status: SaveStatus; error: string | null
  t: (key: string, vars?: Record<string, string | number>) => string
}) {
  if (status === 'idle') return null
  return (
    <div className={cn(
      'inline-flex items-center gap-1.5 text-sm px-2 py-1 rounded border',
      status === 'saving' && 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-800',
      status === 'saved'  && 'border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40',
      status === 'error'  && 'border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40',
    )}>
      {status === 'saving' && <Loader2 className="w-3 h-3 animate-spin" />}
      {status === 'saved'  && <CheckCircle2 className="w-3 h-3" />}
      {status === 'error'  && <AlertCircle className="w-3 h-3" />}
      {status === 'saving' && t('products.edit.savingFlag')}
      {status === 'saved'  && t('products.edit.savedFlag')}
      {status === 'error'  && (error ?? 'Save failed')}
    </div>
  )
}

function SelectField({ label, value, onChange, options }: {
  label: string; value: string
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
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )
}

// ── MA.1 Market Availability Card ─────────────────────────────────────────────
type MarketRow = { channel: string; marketplace: string; offerActive: boolean; listingId: string | null }

const CHANNEL_LABEL: Record<string, string> = { AMAZON: 'Amazon', EBAY: 'eBay', SHOPIFY: 'Shopify', WOOCOMMERCE: 'WooCommerce', ETSY: 'Etsy' }

function MarketAvailabilityCard({ productId }: { productId: string }) {
  const [rows, setRows] = useState<MarketRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<Set<string>>(new Set())
  const { toast } = useToast()

  const rowKey = (r: Pick<MarketRow, 'channel' | 'marketplace'>) => `${r.channel}:${r.marketplace}`

  useEffect(() => {
    setLoading(true)
    fetch(`${getBackendUrl()}/api/products/${productId}/all-listings`, { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : null)
      .then((grouped: Record<string, any[]> | null) => {
        if (!grouped) return
        const next: MarketRow[] = []
        for (const [channel, listings] of Object.entries(grouped)) {
          for (const l of listings) {
            next.push({ channel, marketplace: l.marketplace, offerActive: l.offerActive ?? true, listingId: l.id })
          }
        }
        next.sort((a, b) => a.channel.localeCompare(b.channel) || a.marketplace.localeCompare(b.marketplace))
        setRows(next)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [productId])

  const toggle = useCallback(async (channel: string, marketplace: string, next: boolean) => {
    const key = `${channel}:${marketplace}`
    setSaving((s) => new Set(s).add(key))
    // Optimistic update
    setRows((prev) => prev.map((r) => r.channel === channel && r.marketplace === marketplace ? { ...r, offerActive: next } : r))
    try {
      const res = await fetch(`${getBackendUrl()}/api/products/${productId}/offer-availability`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markets: [{ channel, marketplace, offerActive: next }] }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      toast({ tone: 'success', title: `${CHANNEL_LABEL[channel] ?? channel} ${marketplace} ${next ? 'activated' : 'paused'}` })
    } catch (e: any) {
      // Rollback on error
      setRows((prev) => prev.map((r) => r.channel === channel && r.marketplace === marketplace ? { ...r, offerActive: !next } : r))
      toast({ tone: 'error', title: 'Update failed', description: e?.message ?? String(e) })
    } finally {
      setSaving((s) => { const n = new Set(s); n.delete(key); return n })
    }
  }, [productId, toast])

  const setAll = useCallback(async (offerActive: boolean) => {
    if (rows.length === 0) return
    const markets = rows.map(({ channel, marketplace }) => ({ channel, marketplace, offerActive }))
    setSaving(new Set(rows.map(rowKey)))
    setRows((prev) => prev.map((r) => ({ ...r, offerActive })))
    try {
      const res = await fetch(`${getBackendUrl()}/api/products/${productId}/offer-availability`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markets }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast({ tone: 'success', title: offerActive ? 'All markets activated' : 'All markets paused' })
    } catch (e: any) {
      // Rollback
      setRows((prev) => prev.map((r) => ({ ...r, offerActive: !offerActive })))
      toast({ tone: 'error', title: 'Update failed', description: e?.message ?? String(e) })
    } finally {
      setSaving(new Set())
    }
  }, [rows, productId, toast])

  const pauseNonIT = useCallback(async () => {
    const nonIT = rows.filter((r) => r.marketplace !== 'IT' && r.offerActive)
    if (nonIT.length === 0) return
    const markets = nonIT.map(({ channel, marketplace }) => ({ channel, marketplace, offerActive: false }))
    const keys = new Set(nonIT.map(rowKey))
    setSaving(keys)
    setRows((prev) => prev.map((r) => nonIT.some((n) => n.channel === r.channel && n.marketplace === r.marketplace) ? { ...r, offerActive: false } : r))
    try {
      const res = await fetch(`${getBackendUrl()}/api/products/${productId}/offer-availability`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markets }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast({ tone: 'success', title: `${nonIT.length} non-IT market${nonIT.length !== 1 ? 's' : ''} paused` })
    } catch (e: any) {
      setRows((prev) => prev.map((r) => nonIT.some((n) => n.channel === r.channel && n.marketplace === r.marketplace) ? { ...r, offerActive: true } : r))
      toast({ tone: 'error', title: 'Update failed', description: e?.message ?? String(e) })
    } finally {
      setSaving(new Set())
    }
  }, [rows, productId, toast])

  const activeCount = rows.filter((r) => r.offerActive).length

  if (loading) return null
  if (rows.length === 0) return null

  return (
    <Card noPadding>
      {/* Header */}
      <div className="px-4 py-3 flex items-center justify-between gap-3 border-b border-slate-100 dark:border-slate-800">
        <div className="flex items-center gap-2 min-w-0">
          <Globe className="w-4 h-4 text-slate-400 flex-shrink-0" />
          <div>
            <div className="text-md font-semibold text-slate-900 dark:text-slate-100">Market Availability</div>
            <div className="text-sm text-slate-500 dark:text-slate-400">
              {activeCount} of {rows.length} market{rows.length !== 1 ? 's' : ''} active
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0 flex-wrap">
          {rows.some((r) => r.marketplace !== 'IT' && r.offerActive) && (
            <Button variant="secondary" size="sm" onClick={pauseNonIT} disabled={saving.size > 0}>
              Pause non-IT
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => void setAll(true)} disabled={saving.size > 0 || activeCount === rows.length}>
            Activate all
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void setAll(false)} disabled={saving.size > 0 || activeCount === 0}>
            Pause all
          </Button>
        </div>
      </div>

      {/* Market rows */}
      <div className="divide-y divide-slate-100 dark:divide-slate-800">
        {rows.map((row) => {
          const key = rowKey(row)
          const busy = saving.has(key)
          return (
            <div key={key} className="px-4 py-2.5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className={cn(
                  'inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium',
                  row.channel === 'AMAZON'   && 'bg-orange-50 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300',
                  row.channel === 'EBAY'     && 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
                  row.channel === 'SHOPIFY'  && 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
                  !['AMAZON','EBAY','SHOPIFY'].includes(row.channel) && 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
                )}>
                  {CHANNEL_LABEL[row.channel] ?? row.channel}
                </span>
                <span className="font-mono text-sm text-slate-700 dark:text-slate-300">{row.marketplace}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={cn(
                  'text-sm',
                  row.offerActive ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400 dark:text-slate-500',
                )}>
                  {row.offerActive ? 'Active' : 'Paused'}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={row.offerActive}
                  aria-label={`${row.offerActive ? 'Pause' : 'Activate'} offer on ${CHANNEL_LABEL[row.channel] ?? row.channel} ${row.marketplace}`}
                  disabled={busy}
                  onClick={() => void toggle(row.channel, row.marketplace, !row.offerActive)}
                  className={cn(
                    'relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1',
                    row.offerActive ? 'bg-emerald-500' : 'bg-slate-200 dark:bg-slate-700',
                    busy && 'opacity-50 cursor-wait',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition-transform',
                      row.offerActive ? 'translate-x-4' : 'translate-x-0',
                    )}
                  />
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}
