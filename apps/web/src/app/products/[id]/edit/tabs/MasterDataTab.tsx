'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertCircle,
  CheckCircle2,
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
          </div>
          <Input
            label={t('products.edit.master.brandLabel')}
            value={data.brand}
            onChange={(e) => update('brand', e.target.value)}
          />
          <Input
            label={t('products.edit.master.manufacturerLabel')}
            value={data.manufacturer}
            onChange={(e) => update('manufacturer', e.target.value)}
          />
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
        'absolute right-1.5 bottom-1.5 inline-flex items-center justify-center w-6 h-6 rounded text-slate-400 dark:text-slate-500 hover:bg-blue-50 dark:hover:bg-blue-950/40 hover:text-blue-600 dark:hover:text-blue-400 transition-colors',
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
