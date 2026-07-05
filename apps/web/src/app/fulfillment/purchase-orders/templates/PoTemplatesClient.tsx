'use client'

// PO-Plus.6 — Templates + recurring-schedules workspace.
//
// Two columns visually:
//   - Left: template list (name, supplier, line count, currency)
//   - Right: detail drawer when a template is selected — show items
//     read-only + a Schedules section (add cadence, pause, delete)
//
// Operator can:
//   - Create a fresh DRAFT from any template (one-click)
//   - Add / pause / edit / delete a recurring schedule on a template
//   - Soft-delete a template (operator-side cleanup; cron handles
//     soft-deleted templates by deactivating any live schedules)

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Clock,
  Loader2,
  Pause,
  Play,
  Plus,
  Repeat,
  Trash2,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { DateField } from '@/design-system/components/DateField'
import { Listbox } from '@/design-system/components/Listbox'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import { formatCurrency, relativeTime } from '../_shared/po-lens'

interface TemplateItem {
  id: string
  sku: string
  supplierSku: string | null
  productId: string | null
  quantityOrdered: number
  unitCostCents: number
  note: string | null
  lineOrder: number
}

interface Schedule {
  id: string
  cadence: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY'
  cadenceInterval: number
  startsAt: string
  nextRunAt: string
  lastRunAt: string | null
  lastGeneratedPoId: string | null
  isActive: boolean
  expectedLeadDays: number | null
}

interface Template {
  id: string
  name: string
  description: string | null
  supplierId: string | null
  supplier: { id: string; name: string } | null
  warehouseId: string | null
  warehouse: { code: string } | null
  currencyCode: string
  notes: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
  items: TemplateItem[]
  schedules: Schedule[]
}

const CADENCE_LABELS: Record<Schedule['cadence'], string> = {
  DAILY: 'day',
  WEEKLY: 'week',
  MONTHLY: 'month',
  QUARTERLY: 'quarter',
}

function describeCadence(s: Schedule): string {
  const unit = CADENCE_LABELS[s.cadence] ?? s.cadence.toLowerCase()
  return s.cadenceInterval === 1
    ? `Every ${unit}`
    : `Every ${s.cadenceInterval} ${unit}s`
}

export default function PoTemplatesClient() {
  const [templates, setTemplates] = useState<Template[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [instantiating, setInstantiating] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/po-templates`, {
        cache: 'no-store',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      const data = await res.json()
      setTemplates(data.items ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const selected = templates?.find((t) => t.id === selectedId) ?? null

  const instantiate = async (templateId: string) => {
    setInstantiating(templateId)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/po-templates/${templateId}/instantiate`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      const data = await res.json()
      window.location.href = `/fulfillment/purchase-orders/${data.poId}`
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setInstantiating(null)
    }
  }

  const deleteTemplate = async (templateId: string) => {
    if (!window.confirm('Delete this template? Linked schedules will also be removed.')) return
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/po-templates/${templateId}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      if (selectedId === templateId) setSelectedId(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Purchase order templates"
        breadcrumbs={[
          { label: 'Fulfillment', href: '/fulfillment' },
          { label: 'Purchase orders', href: '/fulfillment/purchase-orders' },
          { label: 'Templates' },
        ]}
        actions={
          <Link
            href="/fulfillment/purchase-orders"
            className="h-8 px-3 inline-flex items-center gap-1.5 text-base border border-default dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            ← Back to POs
          </Link>
        }
      />

      {error && (
        <div className="text-md text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded px-3 py-2 inline-flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          {error}
        </div>
      )}

      <div className="bg-blue-50/40 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900 rounded p-3 text-base text-slate-700 dark:text-slate-300">
        Save a recurring restock as a template, then either click "Use" any
        time you want a fresh DRAFT, or attach a schedule to auto-create
        one every week / month / quarter. Templates capture supplier,
        warehouse, currency, and the line basket — instantiated POs are
        independent and editable after creation.
      </div>

      {loading && !templates && (
        <div className="text-base text-slate-500 dark:text-slate-400 inline-flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading templates…
        </div>
      )}

      {templates && templates.length === 0 && (
        <EmptyState
          icon={Repeat}
          title="No templates yet"
          description="From any DRAFT PO's detail page, click 'Save as template' in the action cluster. The template will land here and become instantiable in one click."
          action={{
            label: 'Open purchase orders',
            href: '/fulfillment/purchase-orders',
          }}
        />
      )}

      {templates && templates.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Left — template list */}
          <div className="lg:col-span-1 space-y-2">
            {templates.map((tpl) => {
              const active = selectedId === tpl.id
              const totalCents = tpl.items.reduce(
                (s, it) => s + it.unitCostCents * it.quantityOrdered,
                0,
              )
              const activeSchedules = tpl.schedules.filter((s) => s.isActive).length
              return (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => setSelectedId(tpl.id)}
                  className={cn(
                    'w-full text-left px-4 py-3 rounded border transition-colors',
                    active
                      ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-900'
                      : 'bg-white dark:bg-slate-900 border-default dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800',
                  )}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-semibold text-slate-900 dark:text-slate-100">
                      {tpl.name}
                    </span>
                    {activeSchedules > 0 && (
                      <Badge variant="info" size="sm">
                        <Repeat className="w-3 h-3" /> {activeSchedules} active
                      </Badge>
                    )}
                  </div>
                  <div className="text-sm text-slate-500 dark:text-slate-400 space-y-0.5">
                    <div>{tpl.supplier?.name ?? '(no supplier)'}</div>
                    <div>
                      {tpl.items.length} line{tpl.items.length === 1 ? '' : 's'} ·{' '}
                      {formatCurrency(totalCents, tpl.currencyCode)}
                    </div>
                    {tpl.description && (
                      <div className="text-tertiary dark:text-slate-500 italic truncate">
                        {tpl.description}
                      </div>
                    )}
                  </div>
                </button>
              )
            })}
          </div>

          {/* Right — selected template detail */}
          <div className="lg:col-span-2">
            {selected ? (
              <TemplateDetail
                template={selected}
                instantiating={instantiating === selected.id}
                onInstantiate={() => instantiate(selected.id)}
                onDelete={() => deleteTemplate(selected.id)}
                onRefresh={load}
              />
            ) : (
              <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-700 rounded-lg p-8 text-center text-base text-slate-500 dark:text-slate-400">
                <ChevronRight className="w-5 h-5 mx-auto mb-2 text-tertiary dark:text-slate-500" />
                Pick a template from the left to view items, manage
                schedules, or instantiate as a fresh DRAFT.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function TemplateDetail({
  template,
  instantiating,
  onInstantiate,
  onDelete,
  onRefresh,
}: {
  template: Template
  instantiating: boolean
  onInstantiate: () => void
  onDelete: () => void
  onRefresh: () => Promise<void>
}) {
  const totalCents = template.items.reduce(
    (s, it) => s + it.unitCostCents * it.quantityOrdered,
    0,
  )

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-700 rounded-lg p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              {template.name}
            </h2>
            {template.description && (
              <p className="text-base text-slate-500 dark:text-slate-400 mt-0.5">
                {template.description}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="primary"
              size="sm"
              onClick={onInstantiate}
              disabled={instantiating}
            >
              {instantiating ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Plus className="w-3.5 h-3.5" />
              )}
              Use template
            </Button>
            <button
              type="button"
              onClick={onDelete}
              className="h-8 px-3 inline-flex items-center gap-1.5 text-base font-medium rounded border bg-white dark:bg-slate-900 text-red-700 dark:text-red-300 border-red-200 dark:border-red-900 hover:bg-red-50 dark:hover:bg-red-950/40"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-base">
          <Stat label="Supplier" value={template.supplier?.name ?? '—'} />
          <Stat label="Warehouse" value={template.warehouse?.code ?? '—'} />
          <Stat label="Currency" value={template.currencyCode} mono />
          <Stat label="Total" value={formatCurrency(totalCents, template.currencyCode)} />
        </div>
      </div>

      {/* Schedules */}
      <SchedulesPanel template={template} onRefresh={onRefresh} />

      {/* Items */}
      <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-700 rounded-lg overflow-hidden">
        <div className="px-4 py-2 border-b border-default dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
          Items ({template.items.length})
        </div>
        <table className="w-full text-base">
          <thead className="bg-slate-50 dark:bg-slate-800 text-sm text-slate-600 dark:text-slate-400 border-b border-default dark:border-slate-700">
            <tr>
              <th className="text-left font-medium px-4 py-1.5">SKU</th>
              <th className="text-right font-medium px-4 py-1.5">Qty</th>
              <th className="text-right font-medium px-4 py-1.5">Unit cost</th>
              <th className="text-right font-medium px-4 py-1.5">Subtotal</th>
            </tr>
          </thead>
          <tbody>
            {template.items.map((it) => (
              <tr key={it.id} className="border-b border-subtle dark:border-slate-800 last:border-0">
                <td className="px-4 py-2 font-mono text-sm">
                  {it.sku}
                  {it.note && (
                    <div className="text-xs text-slate-500 dark:text-slate-400 italic mt-0.5 font-sans">
                      {it.note}
                    </div>
                  )}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{it.quantityOrdered}</td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {formatCurrency(it.unitCostCents, template.currencyCode)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums font-medium">
                  {formatCurrency(
                    it.unitCostCents * it.quantityOrdered,
                    template.currencyCode,
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SchedulesPanel({
  template,
  onRefresh,
}: {
  template: Template
  onRefresh: () => Promise<void>
}) {
  const [addingOpen, setAddingOpen] = useState(false)
  const [cadence, setCadence] = useState<Schedule['cadence']>('WEEKLY')
  const [cadenceInterval, setCadenceInterval] = useState(1)
  const [startsAt, setStartsAt] = useState(() =>
    new Date().toISOString().slice(0, 10),
  )
  const [expectedLeadDays, setExpectedLeadDays] = useState<number | ''>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const addSchedule = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/po-templates/${template.id}/schedules`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cadence,
            cadenceInterval,
            startsAt,
            expectedLeadDays: expectedLeadDays === '' ? null : expectedLeadDays,
          }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      setAddingOpen(false)
      setCadenceInterval(1)
      setExpectedLeadDays('')
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const toggleActive = async (schedule: Schedule) => {
    try {
      await fetch(`${getBackendUrl()}/api/fulfillment/po-schedules/${schedule.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !schedule.isActive }),
      })
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const removeSchedule = async (schedule: Schedule) => {
    if (!window.confirm('Delete this schedule? Auto-generation stops immediately.')) return
    try {
      await fetch(`${getBackendUrl()}/api/fulfillment/po-schedules/${schedule.id}`, {
        method: 'DELETE',
      })
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-700 rounded-lg overflow-hidden">
      <div className="px-4 py-2 border-b border-default dark:border-slate-700 bg-slate-50 dark:bg-slate-800 flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide inline-flex items-center gap-1.5">
          <Repeat className="w-3.5 h-3.5" />
          Schedules
        </span>
        {!addingOpen && (
          <button
            type="button"
            onClick={() => setAddingOpen(true)}
            className="text-sm px-2 py-1 border border-default dark:border-slate-700 rounded hover:bg-white dark:hover:bg-slate-900 inline-flex items-center gap-1 normal-case font-normal"
          >
            <Plus size={11} /> Add schedule
          </button>
        )}
      </div>

      <div className="p-3 space-y-2">
        {addingOpen && (
          <div className="border border-blue-200 dark:border-blue-900 bg-blue-50/40 dark:bg-blue-950/20 rounded p-3 space-y-2">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <SchedField label="Every">
                <input
                  type="number"
                  min="1"
                  value={cadenceInterval}
                  onChange={(e) => setCadenceInterval(parseInt(e.target.value, 10) || 1)}
                  disabled={busy}
                  className="w-full h-8 px-2 text-base text-right tabular-nums border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900"
                />
              </SchedField>
              <SchedField label="Cadence">
                <Listbox
                  value={cadence}
                  onChange={(v) => setCadence(v as Schedule['cadence'])}
                  disabled={busy}
                  ariaLabel="Cadence"
                  className="w-full"
                  options={[
                    { value: 'DAILY', label: 'day(s)' },
                    { value: 'WEEKLY', label: 'week(s)' },
                    { value: 'MONTHLY', label: 'month(s)' },
                    { value: 'QUARTERLY', label: 'quarter(s)' },
                  ]}
                />
              </SchedField>
              <SchedField label="Starts">
                <DateField
                  value={startsAt}
                  onChange={(v) => setStartsAt(v)}
                  disabled={busy}
                  ariaLabel="Starts"
                  className="w-full"
                />
              </SchedField>
              <SchedField label="Lead days">
                <input
                  type="number"
                  min="0"
                  value={expectedLeadDays}
                  onChange={(e) =>
                    setExpectedLeadDays(e.target.value === '' ? '' : parseInt(e.target.value, 10) || 0)
                  }
                  disabled={busy}
                  placeholder="optional"
                  className="w-full h-8 px-2 text-base text-right tabular-nums border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900"
                />
              </SchedField>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="primary" size="sm" onClick={addSchedule} disabled={busy}>
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                Save
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setAddingOpen(false)}
                disabled={busy}
              >
                Cancel
              </Button>
            </div>
            {error && (
              <div className="text-sm text-red-700 dark:text-red-300 inline-flex items-center gap-1">
                <AlertCircle className="w-3 h-3" /> {error}
              </div>
            )}
          </div>
        )}

        {template.schedules.length === 0 && !addingOpen && (
          <div className="text-base text-slate-500 dark:text-slate-400 italic px-1 py-2">
            No schedules. Click "Add schedule" to auto-create POs on a cadence.
          </div>
        )}

        {template.schedules.map((s) => (
          <div
            key={s.id}
            className={cn(
              'border rounded p-3 flex items-center gap-3 flex-wrap',
              s.isActive
                ? 'border-default dark:border-slate-700'
                : 'border-default dark:border-slate-700 bg-slate-50/40 dark:bg-slate-800/40',
            )}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-slate-900 dark:text-slate-100">
                  {describeCadence(s)}
                </span>
                <Badge variant={s.isActive ? 'success' : 'default'} size="sm">
                  {s.isActive ? 'active' : 'paused'}
                </Badge>
              </div>
              <div className="text-sm text-slate-500 dark:text-slate-400 mt-0.5 inline-flex items-center gap-2 flex-wrap">
                <Clock className="w-3 h-3" />
                Next run {new Date(s.nextRunAt).toLocaleString()}
                {s.lastRunAt && (
                  <span>· last ran {relativeTime(s.lastRunAt)}</span>
                )}
                {s.expectedLeadDays && (
                  <span>· lead {s.expectedLeadDays}d</span>
                )}
              </div>
            </div>
            <div className="inline-flex items-center gap-1">
              <button
                type="button"
                onClick={() => toggleActive(s)}
                className="h-7 px-2 text-sm rounded border border-default dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1"
                title={s.isActive ? 'Pause this schedule' : 'Resume this schedule'}
              >
                {s.isActive ? <Pause size={12} /> : <Play size={12} />}
                {s.isActive ? 'Pause' : 'Resume'}
              </button>
              <button
                type="button"
                onClick={() => removeSchedule(s)}
                className="h-7 w-7 inline-flex items-center justify-center rounded text-tertiary dark:text-slate-500 hover:text-rose-700 dark:hover:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                aria-label="Delete schedule"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div>
      <div className="text-sm text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1">
        {label}
      </div>
      <div
        className={cn('text-slate-900 dark:text-slate-100', mono && 'font-mono')}
      >
        {value}
      </div>
    </div>
  )
}

function SchedField({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="text-xs text-slate-500 dark:text-slate-400 mb-0.5">{label}</div>
      {children}
    </div>
  )
}
