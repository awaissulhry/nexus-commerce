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
        <div className="text-base text-slate-500">
          {data?.rules.length ?? 0} rule{data?.rules.length === 1 ? '' : 's'}
          {data?.warehouses.length
            ? ` · ${data.warehouses.length} warehouse${data.warehouses.length === 1 ? '' : 's'}`
            : ''}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={fetchData} disabled={loading}>
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
            Refresh
          </Button>
          <Button variant="primary" size="sm" onClick={startCreate}>
            <Plus className="w-3.5 h-3.5" />
            New rule
          </Button>
        </div>
      </div>

      {error && (
        <div className="text-base text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 inline-flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5" />
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-14 bg-white border border-slate-200 rounded-lg animate-pulse" />
          ))}
        </div>
      )}

      {/* Rules table */}
      {data && data.rules.length === 0 && !loading && (
        <EmptyState
          icon={Network}
          title="No routing rules yet"
          description="Create a rule to assign incoming orders to specific warehouses by channel, marketplace, or shipping country. Without rules, every order falls back to the default warehouse."
          action={{ label: 'Create first rule', onClick: startCreate }}
        />
      )}

      {data && data.rules.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <table className="w-full text-base">
            <thead className="bg-slate-50 text-sm text-slate-600 border-b border-slate-200">
              <tr>
                <th className="text-left font-medium px-3 py-2 w-16">Priority</th>
                <th className="text-left font-medium px-3 py-2">Name / criteria</th>
                <th className="text-left font-medium px-3 py-2 w-48">→ Warehouse</th>
                <th className="text-left font-medium px-3 py-2 w-20">Status</th>
                <th className="text-right font-medium px-3 py-2 w-24"></th>
              </tr>
            </thead>
            <tbody>
              {data.rules.map((rule) => (
                <tr key={rule.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-3 py-2 font-mono tabular-nums text-slate-700">
                    {rule.priority}
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-900">{rule.name}</div>
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
                        <span className="text-xs text-slate-400 italic">
                          matches all (use priority to control)
                        </span>
                      )}
                    </div>
                    {rule.notes && (
                      <div className="text-sm text-slate-500 mt-1 italic">
                        {rule.notes}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="text-slate-900">{rule.warehouse.name}</div>
                    <div className="text-sm text-slate-500 font-mono">
                      {rule.warehouse.code}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <Badge
                      variant={rule.isActive ? 'success' : 'default'}
                      size="sm"
                    >
                      {rule.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => startEdit(rule)}
                        className="p-1 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded"
                        title="Edit"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(rule)}
                        disabled={deletingId === rule.id}
                        className="p-1 text-red-600 hover:text-red-800 hover:bg-red-50 rounded disabled:opacity-50"
                        title="Delete"
                      >
                        {deletingId === rule.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="w-3.5 h-3.5" />
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
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-3">
          <div className="flex items-start gap-2">
            <ChevronUp className="w-4 h-4 text-blue-700 mt-0.5 flex-shrink-0" />
            <div>
              <h3 className="text-md font-semibold text-slate-900">
                Test routing
              </h3>
              <p className="text-sm text-slate-600 mt-0.5">
                Type the order's channel / marketplace / shipping country to
                see which rule will match (or which fallback fires).
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <Input
              type="text"
              placeholder="Channel (e.g. AMAZON)"
              value={previewInput.channel}
              onChange={(e) =>
                setPreviewInput((s) => ({ ...s, channel: e.target.value }))
              }
            />
            <Input
              type="text"
              placeholder="Marketplace (e.g. IT)"
              value={previewInput.marketplace}
              onChange={(e) =>
                setPreviewInput((s) => ({ ...s, marketplace: e.target.value }))
              }
            />
            <Input
              type="text"
              placeholder="Country (e.g. DE)"
              value={previewInput.shippingCountry}
              onChange={(e) =>
                setPreviewInput((s) => ({ ...s, shippingCountry: e.target.value }))
              }
            />
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <Button
              variant="primary"
              size="sm"
              onClick={handlePreview}
              disabled={previewing}
            >
              {previewing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <ArrowRight className="w-3.5 h-3.5" />
              )}
              Test
            </Button>
            {previewResult && (
              <div className="text-base text-slate-700 inline-flex items-center gap-2 flex-wrap">
                <span>Result:</span>
                {previewResult.warehouseId ? (
                  <span className="font-medium">
                    → {previewWarehouseName ?? previewResult.warehouseId}
                  </span>
                ) : (
                  <span className="text-red-700 font-medium">
                    ❌ No warehouse resolved
                  </span>
                )}
                <Badge
                  variant={
                    previewResult.source === 'RULE_MATCH'
                      ? 'success'
                      : previewResult.source === 'DEFAULT_WAREHOUSE'
                        ? 'info'
                        : previewResult.source === 'NONE'
                          ? 'danger'
                          : 'default'
                  }
                  size="sm"
                >
                  {previewResult.source}
                </Badge>
                {previewResult.ruleName && (
                  <span className="text-sm text-slate-500">
                    via "{previewResult.ruleName}"
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Form modal */}
      {form && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-start justify-center pt-[10vh] px-4"
          onClick={() => !submitting && setForm(null)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="bg-white rounded-lg shadow-xl border border-slate-200 w-full max-w-xl max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">
                {form.id ? 'Edit rule' : 'New routing rule'}
              </h2>
              <button
                type="button"
                onClick={() => setForm(null)}
                disabled={submitting}
                className="text-slate-400 hover:text-slate-700 disabled:opacity-50"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-5 space-y-3">
              <div>
                <label className="text-sm font-medium text-slate-700 uppercase tracking-wide">
                  Name
                </label>
                <Input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder='e.g. "Italy AMAZON → IT-MAIN"'
                  required
                  className="mt-1"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm font-medium text-slate-700 uppercase tracking-wide">
                    Priority
                  </label>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Lower number wins
                  </p>
                  <Input
                    type="number"
                    value={form.priority}
                    onChange={(e) =>
                      setForm({ ...form, priority: Number(e.target.value) || 100 })
                    }
                    className="mt-1"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-700 uppercase tracking-wide">
                    Warehouse
                  </label>
                  <select
                    value={form.warehouseId}
                    onChange={(e) =>
                      setForm({ ...form, warehouseId: e.target.value })
                    }
                    className="mt-1 w-full px-3 py-1.5 text-md border border-slate-200 rounded bg-white focus:outline-none focus:ring-2 focus:ring-blue-300"
                    required
                  >
                    <option value="">Select…</option>
                    {data?.warehouses.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.code} — {w.name}
                        {w.isDefault ? ' (default)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded p-3 space-y-2">
                <div className="text-sm font-medium text-slate-700 uppercase tracking-wide">
                  Match criteria
                </div>
                <p className="text-xs text-slate-500">
                  All filled criteria must match. Leave blank to wildcard.
                </p>
                <Input
                  type="text"
                  value={form.channel}
                  onChange={(e) => setForm({ ...form, channel: e.target.value })}
                  placeholder="Channel (e.g. AMAZON, EBAY)"
                />
                <Input
                  type="text"
                  value={form.marketplace}
                  onChange={(e) =>
                    setForm({ ...form, marketplace: e.target.value })
                  }
                  placeholder="Marketplace (e.g. IT, DE, FR)"
                />
                <Input
                  type="text"
                  value={form.shippingCountry}
                  onChange={(e) =>
                    setForm({ ...form, shippingCountry: e.target.value })
                  }
                  placeholder="Shipping country code (e.g. IT, DE)"
                />
              </div>

              <div>
                <label className="text-sm font-medium text-slate-700 uppercase tracking-wide">
                  Notes (optional)
                </label>
                <Input
                  type="text"
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  placeholder="Why this rule exists, edge cases, etc."
                  className="mt-1"
                />
              </div>

              <label className="flex items-center gap-2 text-base text-slate-700">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                />
                Active (rule will be evaluated)
              </label>

              <div className="flex items-center gap-2 pt-2 border-t border-slate-200">
                <Button type="submit" variant="primary" size="sm" disabled={submitting}>
                  {submitting ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Check className="w-3.5 h-3.5" />
                  )}
                  {form.id ? 'Save' : 'Create rule'}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setForm(null)}
                  disabled={submitting}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
