'use client'

import { useState } from 'react'
import { X, Plus, Trash2, Loader2, Users } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Condition {
  field: string
  op: string
  value?: unknown
}

interface Segment {
  id: string
  name: string
  description: string | null
  conditions: Condition[]
  customerCount: number
  lastCountedAt: string | null
  createdAt: string
}

const FIELD_OPTIONS = [
  { value: 'totalSpentCents', label: 'Lifetime Value (cents)', type: 'number', hint: 'e.g. 50000 = €500' },
  { value: 'totalOrders',     label: 'Total orders',           type: 'number' },
  { value: 'rfmLabel',        label: 'RFM label',              type: 'enum', values: ['CHAMPION','LOYAL','POTENTIAL','AT_RISK','LOST','NEW','ONE_TIME'] },
  { value: 'fiscalKind',      label: 'Customer type',          type: 'enum', values: ['B2B','B2C'] },
  { value: 'riskFlag',        label: 'Risk flag',              type: 'string' },
  { value: 'lastOrderAt',     label: 'Last order (days ago)',  type: 'daysAgo', hint: 'e.g. 30 = within last 30 days' },
  { value: 'firstOrderAt',    label: 'First order (days ago)', type: 'daysAgo' },
  { value: 'tags',            label: 'Has tag',                type: 'string' },
]

const NUMERIC_OPS = [
  { value: 'gte', label: '≥ (at least)' },
  { value: 'gt',  label: '> (more than)' },
  { value: 'lte', label: '≤ (at most)' },
  { value: 'lt',  label: '< (less than)' },
  { value: 'eq',  label: '= (exactly)' },
]

const STRING_OPS = [
  { value: 'eq',       label: '= equals' },
  { value: 'ne',       label: '≠ not equals' },
  { value: 'contains', label: 'contains' },
  { value: 'in',       label: 'is one of (comma-sep)' },
  { value: 'exists',   label: 'is set (not null)' },
]

const DAYS_AGO_OPS = [
  { value: 'gte', label: 'within last N days' },
  { value: 'lte', label: 'older than N days' },
]

function getOpsForField(field: string) {
  const f = FIELD_OPTIONS.find((o) => o.value === field)
  if (!f) return STRING_OPS
  if (f.type === 'number') return NUMERIC_OPS
  if (f.type === 'daysAgo') return DAYS_AGO_OPS
  if (f.type === 'enum') return [
    { value: 'eq', label: '= is' },
    { value: 'ne', label: '≠ is not' },
    { value: 'in', label: 'is one of' },
  ]
  return STRING_OPS
}

function serializeValue(field: string, op: string, raw: string): unknown {
  const f = FIELD_OPTIONS.find((o) => o.value === field)
  if (f?.type === 'daysAgo') return { daysAgo: parseInt(raw, 10) || 30 }
  if (f?.type === 'number') return parseInt(raw, 10) || 0
  if (op === 'in') return raw.split(',').map((v) => v.trim()).filter(Boolean)
  return raw
}

function displayValue(value: unknown): string {
  if (value && typeof value === 'object' && 'daysAgo' in value) {
    return String((value as { daysAgo: number }).daysAgo)
  }
  if (Array.isArray(value)) return value.join(', ')
  return String(value ?? '')
}

export function SegmentBuilderDrawer({
  segment,
  onClose,
  onSaved,
}: {
  segment: Segment | null
  onClose: () => void
  onSaved: (saved: Segment) => void
}) {
  const isEdit = segment !== null

  const [name, setName] = useState(segment?.name ?? '')
  const [description, setDescription] = useState(segment?.description ?? '')
  const [conditions, setConditions] = useState<Array<{ field: string; op: string; rawValue: string }>>(
    (segment?.conditions ?? []).map((c) => ({
      field: c.field,
      op: c.op,
      rawValue: displayValue(c.value),
    })),
  )

  const [previewCount, setPreviewCount] = useState<number | null>(segment?.customerCount ?? null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [saveBusy, setSaveBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function addCondition() {
    setConditions((prev) => [...prev, { field: 'totalSpentCents', op: 'gte', rawValue: '0' }])
  }

  function removeCondition(i: number) {
    setConditions((prev) => prev.filter((_, idx) => idx !== i))
  }

  function updateCondition(i: number, updates: Partial<{ field: string; op: string; rawValue: string }>) {
    setConditions((prev) => prev.map((c, idx) => idx === i ? { ...c, ...updates } : c))
  }

  function buildConditions(): Condition[] {
    return conditions.map((c) => ({
      field: c.field,
      op: c.op,
      ...(c.op !== 'exists' ? { value: serializeValue(c.field, c.op, c.rawValue) } : {}),
    }))
  }

  async function preview() {
    setPreviewBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/customers/segments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name || 'Preview', conditions: buildConditions() }),
      })
      // Don't actually save — use a temp evaluate approach
      // Instead hit a real segment evaluate with a temp payload
      if (res.ok) {
        const json = (await res.json()) as { segment: Segment }
        setPreviewCount(json.segment.customerCount)
        // Clean up temp segment
        await fetch(`${getBackendUrl()}/api/customers/segments/${json.segment.id}`, { method: 'DELETE' })
      }
    } finally {
      setPreviewBusy(false)
    }
  }

  async function save() {
    if (!name.trim()) { setError('Name is required'); return }
    setSaveBusy(true)
    setError(null)

    const body = {
      name: name.trim(),
      description: description.trim() || null,
      conditions: buildConditions(),
    }

    try {
      const url = isEdit
        ? `${getBackendUrl()}/api/customers/segments/${segment!.id}`
        : `${getBackendUrl()}/api/customers/segments`
      const res = await fetch(url, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = (await res.json()) as { error?: string }
        setError(err.error ?? 'Save failed')
        return
      }
      const json = (await res.json()) as { segment: Segment }
      onSaved(json.segment)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setSaveBusy(false)
    }
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/30 dark:bg-black/50 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 bottom-0 w-full max-w-lg bg-white dark:bg-slate-900 shadow-xl z-50 flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {isEdit ? 'Edit segment' : 'New customer segment'}
          </h2>
          <button type="button" onClick={onClose} className="p-1 rounded text-slate-400 hover:text-slate-700">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Name + description */}
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Segment name <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder='e.g. "High-value B2B Champions"'
                className="w-full text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 focus:outline-none focus:ring-1 focus:ring-violet-400"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Description</label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional note"
                className="w-full text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 focus:outline-none focus:ring-1 focus:ring-violet-400"
              />
            </div>
          </div>

          {/* Conditions */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-slate-700 dark:text-slate-300">Conditions (AND)</h3>
              <button
                type="button"
                onClick={addCondition}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded ring-1 ring-inset ring-slate-300 dark:ring-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50"
              >
                <Plus className="h-3 w-3" />
                Add
              </button>
            </div>

            {conditions.length === 0 ? (
              <p className="text-xs text-slate-400 italic">No conditions — segment will match all customers.</p>
            ) : (
              <div className="space-y-2">
                {conditions.map((c, i) => {
                  const fieldDef = FIELD_OPTIONS.find((f) => f.value === c.field)
                  const ops = getOpsForField(c.field)
                  return (
                    <div key={i} className="flex items-start gap-2 p-2 rounded-md bg-slate-50 dark:bg-slate-800/60">
                      <select
                        value={c.field}
                        onChange={(e) => updateCondition(i, { field: e.target.value, op: getOpsForField(e.target.value)[0].value })}
                        className="text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-violet-400"
                      >
                        {FIELD_OPTIONS.map((f) => (
                          <option key={f.value} value={f.value}>{f.label}</option>
                        ))}
                      </select>

                      <select
                        value={c.op}
                        onChange={(e) => updateCondition(i, { op: e.target.value })}
                        className="text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-violet-400"
                      >
                        {ops.map((op) => (
                          <option key={op.value} value={op.value}>{op.label}</option>
                        ))}
                      </select>

                      {c.op !== 'exists' && (
                        fieldDef?.type === 'enum' ? (
                          <select
                            value={c.rawValue}
                            onChange={(e) => updateCondition(i, { rawValue: e.target.value })}
                            className="flex-1 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-violet-400"
                          >
                            {fieldDef.values?.map((v) => <option key={v} value={v}>{v}</option>)}
                          </select>
                        ) : (
                          <input
                            type="text"
                            value={c.rawValue}
                            onChange={(e) => updateCondition(i, { rawValue: e.target.value })}
                            placeholder={fieldDef?.hint ?? 'value'}
                            className="flex-1 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-violet-400"
                          />
                        )
                      )}

                      <button
                        type="button"
                        onClick={() => removeCondition(i)}
                        className="p-1.5 rounded text-slate-400 hover:text-rose-600 shrink-0"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Preview count */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={preview}
              disabled={previewBusy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded ring-1 ring-inset ring-slate-300 dark:ring-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-50 disabled:opacity-40"
            >
              {previewBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Users className="h-3.5 w-3.5" />}
              Preview count
            </button>
            {previewCount !== null && (
              <span className="text-sm font-semibold text-violet-700 dark:text-violet-300 tabular-nums">
                {previewCount.toLocaleString()} customers match
              </span>
            )}
          </div>

          {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}
        </div>

        <div className="px-5 py-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-slate-600 dark:text-slate-400">
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saveBusy}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm rounded bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50"
          >
            {saveBusy && <Loader2 className="h-4 w-4 animate-spin" />}
            {isEdit ? 'Save changes' : 'Create segment'}
          </button>
        </div>
      </div>
    </>
  )
}
