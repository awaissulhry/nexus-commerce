'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  ArrowRight,
  Check,
  ChevronUp,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Network,
  Trash2,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Input } from '@/components/ui/Input'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'

interface Warehouse {
  id: string
  code: string
  name: string
  isDefault: boolean
}

interface Rule {
  id: string
  name: string
  priority: number
  channel: string | null
  marketplace: string | null
  shippingCountry: string | null
  warehouseId: string
  warehouse: { id: string; code: string; name: string }
  isActive: boolean
  notes: string | null
  createdAt: string
  updatedAt: string
}

interface RulesResponse {
  success: boolean
  rules: Rule[]
  warehouses: Warehouse[]
}

interface RouteResult {
  warehouseId: string | null
  ruleId: string | null
  ruleName: string | null
  source: 'RULE_MATCH' | 'DEFAULT_WAREHOUSE' | 'FALLBACK_OVERRIDE' | 'NONE'
}

interface RuleFormState {
  id: string | null
  name: string
  priority: number
  channel: string
  marketplace: string
  shippingCountry: string
  warehouseId: string
  isActive: boolean
  notes: string
}

const blankForm = (defaults?: { warehouseId?: string }): RuleFormState => ({
  id: null,
  name: '',
  priority: 100,
  channel: '',
  marketplace: '',
  shippingCountry: '',
  warehouseId: defaults?.warehouseId ?? '',
  isActive: true,
  notes: '',
})

export default function RoutingRulesClient() {
  const { t } = useTranslations()
  const askConfirm = useConfirm()
  const [data, setData] = useState<RulesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<RuleFormState | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // Dry-run preview state
  const [previewInput, setPreviewInput] = useState({
    channel: '',
    marketplace: '',
    shippingCountry: '',
  })
  const [previewResult, setPreviewResult] = useState<RouteResult | null>(null)
  const [previewing, setPreviewing] = useState(false)

  const { toast } = useToast()

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/routing-rules`, {
        cache: 'no-store',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const json = await res.json()
      setData(json)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form) return
    setSubmitting(true)
    try {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        priority: form.priority,
        channel: form.channel.trim() || null,
        marketplace: form.marketplace.trim() || null,
        shippingCountry: form.shippingCountry.trim() || null,
        warehouseId: form.warehouseId,
        isActive: form.isActive,
        notes: form.notes.trim() || null,
      }
      const url = form.id
        ? `${getBackendUrl()}/api/fulfillment/routing-rules/${form.id}`
        : `${getBackendUrl()}/api/fulfillment/routing-rules`
      const method = form.id ? 'PATCH' : 'POST'
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      toast.success(form.id ? `Rule updated` : `Rule "${form.name}" created`)
      setForm(null)
      await fetchData()
    } catch (err) {
      toast.error(
        `Save failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (rule: Rule) => {
    if (!(await askConfirm({ title: `Delete rule "${rule.name}"?`, description: 'This cannot be undone.', confirmLabel: 'Delete', tone: 'danger' }))) return
    setDeletingId(rule.id)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/routing-rules/${rule.id}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      toast.success(`Deleted "${rule.name}"`)
      await fetchData()
    } catch (err) {
      toast.error(
        `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      setDeletingId(null)
    }
  }

  const handlePreview = async () => {
    setPreviewing(true)
    setPreviewResult(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/routing-rules/preview`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel: previewInput.channel.trim() || null,
            marketplace: previewInput.marketplace.trim() || null,
            shippingCountry: previewInput.shippingCountry.trim() || null,
          }),
        },
      )
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      setPreviewResult(body)
    } catch (err) {
      toast.error(
        `Preview failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      setPreviewing(false)
    }
  }

  const startEdit = (rule: Rule) => {
    setForm({
      id: rule.id,
      name: rule.name,
      priority: rule.priority,
      channel: rule.channel ?? '',
      marketplace: rule.marketplace ?? '',
      shippingCountry: rule.shippingCountry ?? '',
      warehouseId: rule.warehouseId,
      isActive: rule.isActive,
      notes: rule.notes ?? '',
    })
  }

  const startCreate = () => {
    const defaultWh = data?.warehouses.find((w) => w.isDefault)
    setForm(blankForm({ warehouseId: defaultWh?.id ?? '' }))
  }

  const previewWarehouseName = previewResult
    ? data?.warehouses.find((w) => w.id === previewResult.warehouseId)?.name ?? null
    : null

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-base text-slate-500 dark:text-slate-400">
          {t('routingRules.summary', { rules: data?.rules.length ?? 0, warehouses: data?.warehouses.length ?? 0 })}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={fetchData} disabled={loading} aria-label={t('common.refresh')}>
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} aria-hidden="true" />
            {t('common.refresh')}
          </Button>
          <Button variant="primary" size="sm" onClick={startCreate}>
            <Plus className="w-3.5 h-3.5" aria-hidden="true" />
            {t('routingRules.newRule')}
          </Button>
        </div>
      </div>

      {error && (
        <div role="alert" className="text-base text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded px-3 py-2 inline-flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5" aria-hidden="true" />
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-14 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg animate-pulse" />
          ))}
        </div>
      )}

      {/* Rules table */}
      {data && data.rules.length === 0 && !loading && (
        <EmptyState
          icon={Network}
          title={t('routingRules.empty.title')}
          description={t('routingRules.empty.description')}
          action={{ label: t('routingRules.empty.create'), onClick: startCreate }}
        />
      )}

      {data && data.rules.length > 0 && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
          <table className="w-full text-base">
            <thead className="bg-slate-50 dark:bg-slate-800 text-sm text-slate-600 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
              <tr>
                <th className="text-left font-medium px-3 py-2 w-16">{t('routingRules.col.priority')}</th>
                <th className="text-left font-medium px-3 py-2">{t('routingRules.col.nameCriteria')}</th>
                <th className="text-left font-medium px-3 py-2 w-48">{t('routingRules.col.warehouse')}</th>
                <th className="text-left font-medium px-3 py-2 w-20">{t('routingRules.col.status')}</th>
                <th className="text-right font-medium px-3 py-2 w-24"></th>
              </tr>
            </thead>
            <tbody>
              {data.rules.map((rule) => (
                <tr key={rule.id} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                  <td className="px-3 py-2 font-mono tabular-nums text-slate-700 dark:text-slate-300">
                    {rule.priority}
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-900 dark:text-slate-100">{rule.name}</div>
                    <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                      {rule.channel ? (
                        <Badge variant="info" size="sm">{rule.channel}</Badge>
                      ) : null}
                      {rule.marketplace ? (
                        <Badge variant="default" size="sm">{rule.marketplace}</Badge>
                      ) : null}
                      {rule.shippingCountry ? (
                        <Badge variant="default" size="sm">→ {rule.shippingCountry}</Badge>
                      ) : null}
                      {!rule.channel && !rule.marketplace && !rule.shippingCountry && (
                        <span className="text-xs text-slate-400 dark:text-slate-500 italic">
                          {t('routingRules.matchesAll')}
                        </span>
                      )}
                    </div>
                    {rule.notes && (
                      <div className="text-sm text-slate-500 dark:text-slate-400 mt-1 italic">
                        {rule.notes}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="text-slate-900 dark:text-slate-100">{rule.warehouse.name}</div>
                    <div className="text-sm text-slate-500 dark:text-slate-400 font-mono">
                      {rule.warehouse.code}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={rule.isActive ? 'success' : 'default'} size="sm">
                      {rule.isActive ? t('routingRules.active') : t('routingRules.inactive')}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => startEdit(rule)}
                        className="min-h-[44px] sm:min-h-0 min-w-[44px] sm:min-w-0 p-1 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 rounded"
                        aria-label={t('routingRules.editAria', { name: rule.name })}
                        title={t('common.edit')}
                      >
                        <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(rule)}
                        disabled={deletingId === rule.id}
                        className="min-h-[44px] sm:min-h-0 min-w-[44px] sm:min-w-0 p-1 text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/30 rounded disabled:opacity-50"
                        aria-label={t('routingRules.deleteAria', { name: rule.name })}
                        title={t('common.delete')}
                      >
                        {deletingId === rule.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                        ) : (
                          <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                        )}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Dry-run preview */}
      {data && (
        <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 rounded-lg p-4 space-y-3">
          <div className="flex items-start gap-2">
            <ChevronUp className="w-4 h-4 text-blue-700 dark:text-blue-400 mt-0.5 flex-shrink-0" aria-hidden="true" />
            <div>
              <h3 className="text-md font-semibold text-slate-900 dark:text-slate-100">
                {t('routingRules.testRouting')}
              </h3>
              <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">
                {t('routingRules.testHelp')}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <Input
              type="text"
              placeholder={t('routingRules.channelPlaceholder')}
              aria-label={t('routingRules.channelPlaceholder')}
              value={previewInput.channel}
              onChange={(e) => setPreviewInput((s) => ({ ...s, channel: e.target.value }))}
            />
            <Input
              type="text"
              placeholder={t('routingRules.marketplacePlaceholder')}
              aria-label={t('routingRules.marketplacePlaceholder')}
              value={previewInput.marketplace}
              onChange={(e) => setPreviewInput((s) => ({ ...s, marketplace: e.target.value }))}
            />
            <Input
              type="text"
              placeholder={t('routingRules.countryPlaceholder')}
              aria-label={t('routingRules.countryPlaceholder')}
              value={previewInput.shippingCountry}
              onChange={(e) => setPreviewInput((s) => ({ ...s, shippingCountry: e.target.value }))}
            />
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <Button variant="primary" size="sm" onClick={handlePreview} disabled={previewing}>
              {previewing ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />}
              {t('routingRules.test')}
            </Button>
            {previewResult && (
              <div className="text-base text-slate-700 dark:text-slate-300 inline-flex items-center gap-2 flex-wrap" role="status" aria-live="polite">
                <span>{t('routingRules.result')}</span>
                {previewResult.warehouseId ? (
                  <span className="font-medium">
                    → {previewWarehouseName ?? previewResult.warehouseId}
                  </span>
                ) : (
                  <span className="text-red-700 dark:text-red-400 font-medium">
                    {t('routingRules.noResolve')}
                  </span>
                )}
                <Badge
                  variant={
                    previewResult.source === 'RULE_MATCH' ? 'success' :
                    previewResult.source === 'DEFAULT_WAREHOUSE' ? 'info' :
                    previewResult.source === 'NONE' ? 'danger' : 'default'
                  }
                  size="sm"
                >
                  {previewResult.source}
                </Badge>
                {previewResult.ruleName && (
                  <span className="text-sm text-slate-500 dark:text-slate-400">
                    {t('routingRules.viaRule', { name: previewResult.ruleName })}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Form modal */}
      {form && <RuleFormModal
        form={form}
        setForm={setForm}
        submitting={submitting}
        warehouses={data?.warehouses ?? []}
        onSubmit={handleSubmit}
        t={t}
      />}
    </div>
  )
}

function RuleFormModal({
  form, setForm, submitting, warehouses, onSubmit, t,
}: {
  form: RuleFormState
  setForm: (f: RuleFormState | null) => void
  submitting: boolean
  warehouses: Warehouse[]
  onSubmit: (e: React.FormEvent) => void
  t: (k: string, vars?: Record<string, string | number>) => string
}) {
  // F1.6 — Esc-key handler + focus trap baseline
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) setForm(null)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [submitting, setForm])

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-start justify-center pt-[10vh] px-4"
      onClick={() => !submitting && setForm(null)}
      role="dialog"
      aria-modal="true"
      aria-label={form.id ? t('routingRules.editTitle') : t('routingRules.newTitle')}
    >
      <div
        className="bg-white dark:bg-slate-900 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 w-full max-w-xl max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            {form.id ? t('routingRules.editTitle') : t('routingRules.newTitle')}
          </h2>
          <button
            type="button"
            onClick={() => setForm(null)}
            disabled={submitting}
            className="min-h-[44px] sm:min-h-0 min-w-[44px] sm:min-w-0 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-50"
            aria-label={t('common.close')}
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
        <form onSubmit={onSubmit} className="p-5 space-y-3">
          <div>
            <label htmlFor="rule-name" className="text-sm font-medium text-slate-700 dark:text-slate-300 uppercase tracking-wide">
              {t('routingRules.field.name')}
            </label>
            <Input
              id="rule-name"
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder={t('routingRules.field.namePlaceholder')}
              required
              className="mt-1"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="rule-priority" className="text-sm font-medium text-slate-700 dark:text-slate-300 uppercase tracking-wide">
                {t('routingRules.field.priority')}
              </label>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{t('routingRules.field.priorityHelp')}</p>
              <Input
                id="rule-priority"
                type="number"
                value={form.priority}
                onChange={(e) => setForm({ ...form, priority: Number(e.target.value) || 100 })}
                className="mt-1"
              />
            </div>
            <div>
              <label htmlFor="rule-warehouse" className="text-sm font-medium text-slate-700 dark:text-slate-300 uppercase tracking-wide">
                {t('routingRules.field.warehouse')}
              </label>
              <select
                id="rule-warehouse"
                value={form.warehouseId}
                onChange={(e) => setForm({ ...form, warehouseId: e.target.value })}
                className="mt-1 w-full px-3 py-1.5 text-md border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-300"
                required
              >
                <option value="">{t('routingRules.field.warehouseSelect')}</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code} — {w.name}{w.isDefault ? ` ${t('routingRules.field.defaultMarker')}` : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded p-3 space-y-2">
            <div className="text-sm font-medium text-slate-700 dark:text-slate-300 uppercase tracking-wide">
              {t('routingRules.field.criteria')}
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('routingRules.field.criteriaHelp')}
            </p>
            <Input
              type="text"
              value={form.channel}
              onChange={(e) => setForm({ ...form, channel: e.target.value })}
              placeholder={t('routingRules.field.channel')}
              aria-label={t('routingRules.field.channel')}
            />
            <Input
              type="text"
              value={form.marketplace}
              onChange={(e) => setForm({ ...form, marketplace: e.target.value })}
              placeholder={t('routingRules.field.marketplace')}
              aria-label={t('routingRules.field.marketplace')}
            />
            <Input
              type="text"
              value={form.shippingCountry}
              onChange={(e) => setForm({ ...form, shippingCountry: e.target.value })}
              placeholder={t('routingRules.field.country')}
              aria-label={t('routingRules.field.country')}
            />
          </div>

          <div>
            <label htmlFor="rule-notes" className="text-sm font-medium text-slate-700 dark:text-slate-300 uppercase tracking-wide">
              {t('routingRules.field.notes')}
            </label>
            <Input
              id="rule-notes"
              type="text"
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder={t('routingRules.field.notesPlaceholder')}
              className="mt-1"
            />
          </div>

          <label className="flex items-center gap-2 text-base text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
            />
            {t('routingRules.field.activeLabel')}
          </label>

          <div className="flex items-center gap-2 pt-2 border-t border-slate-200 dark:border-slate-700">
            <Button type="submit" variant="primary" size="sm" disabled={submitting}>
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Check className="w-3.5 h-3.5" aria-hidden="true" />}
              {form.id ? t('common.save') : t('routingRules.create')}
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => setForm(null)} disabled={submitting}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
