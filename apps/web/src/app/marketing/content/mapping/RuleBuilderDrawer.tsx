'use client'

import { useState } from 'react'
import { X, Loader2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface SchemaField {
  id: string
  channel: string
  marketplace: string | null
  fieldKey: string
  label: string
  maxLength: number | null
  required: boolean
}

interface TransformRule {
  id: string
  name: string
  description: string | null
  channel: string
  marketplace: string | null
  field: string
  priority: number
  enabled: boolean
  condition: { field: string; op: string; value: unknown } | null
  action: { type: string; value?: string; template?: string }
  createdAt: string
  updatedAt: string
}

const CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY', 'ALL']
const MARKETPLACES = ['IT', 'DE', 'FR', 'UK', 'ES', 'PL', 'NL', 'BE', 'SE']
const OPS = [
  { value: 'eq',       label: '== equals' },
  { value: 'ne',       label: '≠ not equals' },
  { value: 'contains', label: 'CONTAINS' },
  { value: 'in',       label: 'IN (comma-separated)' },
  { value: 'lt',       label: '< less than' },
  { value: 'lte',      label: '≤ less than or equal' },
  { value: 'gt',       label: '> greater than' },
  { value: 'gte',      label: '≥ greater than or equal' },
  { value: 'exists',   label: 'EXISTS (not null)' },
]

// Product-level fields that conditions can match on
const PRODUCT_FIELDS = [
  { value: 'brand',       label: 'Brand' },
  { value: 'productType', label: 'Product type' },
  { value: 'name',        label: 'Name' },
  { value: 'description', label: 'Description' },
  { value: 'ean',         label: 'EAN / barcode' },
  { value: 'sku',         label: 'SKU' },
]

function dedupeFields(schema: SchemaField[], channel: string): SchemaField[] {
  if (channel === 'ALL') return schema
  const relevant = schema.filter((f) => f.channel === channel || f.channel === 'ALL')
  const seen = new Set<string>()
  return relevant.filter((f) => {
    if (seen.has(f.fieldKey)) return false
    seen.add(f.fieldKey)
    return true
  })
}

export function RuleBuilderDrawer({
  rule,
  schemaFields,
  onClose,
  onSaved,
}: {
  rule: TransformRule | null
  schemaFields: SchemaField[]
  onClose: () => void
  onSaved: (saved: TransformRule) => void
}) {
  const isEdit = rule !== null

  const [name, setName] = useState(rule?.name ?? '')
  const [description, setDescription] = useState(rule?.description ?? '')
  const [channel, setChannel] = useState(rule?.channel ?? 'AMAZON')
  const [marketplace, setMarketplace] = useState(rule?.marketplace ?? '')
  const [field, setField] = useState(rule?.field ?? '')
  const [priority, setPriority] = useState(String(rule?.priority ?? '100'))
  const [enabled, setEnabled] = useState(rule?.enabled ?? true)

  // Condition
  const [hasCondition, setHasCondition] = useState(rule?.condition != null)
  const [condField, setCondField] = useState(
    rule?.condition ? (rule.condition as { field: string }).field : 'brand',
  )
  const [condOp, setCondOp] = useState(
    rule?.condition ? (rule.condition as { op: string }).op : 'eq',
  )
  const [condValue, setCondValue] = useState(
    rule?.condition
      ? String((rule.condition as { value: unknown }).value ?? '')
      : '',
  )

  // Action
  const [actionType, setActionType] = useState<'set' | 'append' | 'prepend' | 'template'>(
    (rule?.action?.type as 'set' | 'append' | 'prepend' | 'template') ?? 'set',
  )
  const [actionValue, setActionValue] = useState(rule?.action?.value ?? '')
  const [actionTemplate, setActionTemplate] = useState(rule?.action?.template ?? '')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const targetFields = dedupeFields(schemaFields, channel)

  async function save() {
    if (!name.trim() || !channel || !field) {
      setError('Name, channel, and field are required')
      return
    }
    setBusy(true)
    setError(null)

    let conditionValue: unknown = condValue
    if (condOp === 'in') {
      conditionValue = condValue.split(',').map((v) => v.trim()).filter(Boolean)
    } else if (!isNaN(Number(condValue)) && condValue !== '') {
      conditionValue = Number(condValue)
    }

    const body = {
      name: name.trim(),
      description: description.trim() || null,
      channel,
      marketplace: marketplace || null,
      field,
      priority: parseInt(priority, 10) || 100,
      enabled,
      condition: hasCondition && condOp !== 'exists'
        ? { field: condField, op: condOp, value: conditionValue }
        : hasCondition && condOp === 'exists'
          ? { field: condField, op: condOp }
          : null,
      action: actionType === 'template'
        ? { type: 'template', template: actionTemplate }
        : { type: actionType, value: actionValue },
    }

    try {
      const url = isEdit
        ? `${getBackendUrl()}/api/feed-transform/rules/${rule!.id}`
        : `${getBackendUrl()}/api/feed-transform/rules`
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
      const json = (await res.json()) as { rule: TransformRule }
      onSaved(json.rule)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 dark:bg-black/50 z-40"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="fixed right-0 top-0 bottom-0 w-full max-w-lg bg-white dark:bg-slate-900 shadow-xl z-50 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {isEdit ? 'Edit transform rule' : 'New transform rule'}
          </h2>
          <button type="button" onClick={onClose} className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Name + description */}
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Rule name <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder='e.g. "Xavia: append Premium to title"'
                className="w-full text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 focus:outline-none focus:ring-1 focus:ring-violet-400"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Description
              </label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional note for the team"
                className="w-full text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 focus:outline-none focus:ring-1 focus:ring-violet-400"
              />
            </div>
          </div>

          {/* Channel + marketplace + priority */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Channel <span className="text-rose-500">*</span>
              </label>
              <select
                value={channel}
                onChange={(e) => { setChannel(e.target.value); setField('') }}
                className="w-full text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-2 focus:outline-none focus:ring-1 focus:ring-violet-400"
              >
                {CHANNELS.map((c) => (
                  <option key={c} value={c}>{c === 'ALL' ? 'All channels' : c}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Marketplace
              </label>
              <select
                value={marketplace}
                onChange={(e) => setMarketplace(e.target.value)}
                className="w-full text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-2 focus:outline-none focus:ring-1 focus:ring-violet-400"
              >
                <option value="">All markets</option>
                {MARKETPLACES.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Priority
              </label>
              <input
                type="number"
                min={1}
                max={999}
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className="w-full text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 focus:outline-none focus:ring-1 focus:ring-violet-400"
              />
            </div>
          </div>

          {/* Target field */}
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
              Target field <span className="text-rose-500">*</span>
            </label>
            {targetFields.length > 0 ? (
              <select
                value={field}
                onChange={(e) => setField(e.target.value)}
                className="w-full text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-2 focus:outline-none focus:ring-1 focus:ring-violet-400"
              >
                <option value="">— select field —</option>
                {targetFields.map((f) => (
                  <option key={f.fieldKey} value={f.fieldKey}>
                    {f.label} ({f.fieldKey}){f.required ? ' *' : ''}{f.maxLength ? ` ≤${f.maxLength}` : ''}
                  </option>
                ))}
              </select>
            ) : (
              <div className="space-y-1">
                <input
                  type="text"
                  value={field}
                  onChange={(e) => setField(e.target.value)}
                  placeholder="e.g. title, description, brand"
                  className="w-full text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 focus:outline-none focus:ring-1 focus:ring-violet-400 font-mono"
                />
                <p className="text-xs text-slate-500">
                  Seed channel schemas to get a dropdown picker.
                </p>
              </div>
            )}
          </div>

          {/* Condition */}
          <div className="border border-slate-200 dark:border-slate-800 rounded-md p-3 space-y-3">
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={hasCondition}
                  onChange={(e) => setHasCondition(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  Add condition (IF)
                </span>
              </label>
              <span className="text-xs text-slate-400">
                {hasCondition ? '' : 'Rule applies to all products unconditionally'}
              </span>
            </div>

            {hasCondition && (
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Field</label>
                  <select
                    value={condField}
                    onChange={(e) => setCondField(e.target.value)}
                    className="w-full text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-violet-400"
                  >
                    {PRODUCT_FIELDS.map((f) => (
                      <option key={f.value} value={f.value}>{f.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Operator</label>
                  <select
                    value={condOp}
                    onChange={(e) => setCondOp(e.target.value)}
                    className="w-full text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-violet-400"
                  >
                    {OPS.map((op) => (
                      <option key={op.value} value={op.value}>{op.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Value</label>
                  <input
                    type="text"
                    value={condValue}
                    onChange={(e) => setCondValue(e.target.value)}
                    disabled={condOp === 'exists'}
                    placeholder={condOp === 'in' ? 'val1, val2' : condOp === 'exists' ? '—' : 'value'}
                    className="w-full text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-violet-400 disabled:opacity-40"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Action */}
          <div className="border border-slate-200 dark:border-slate-800 rounded-md p-3 space-y-3">
            <h3 className="text-sm font-medium text-slate-700 dark:text-slate-300">
              Action (THEN)
            </h3>
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">
                Action type
              </label>
              <div className="grid grid-cols-2 gap-2">
                {(['set', 'append', 'prepend', 'template'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setActionType(t)}
                    className={`px-3 py-2 text-sm rounded border text-left transition-colors ${
                      actionType === t
                        ? 'border-violet-500 bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300'
                        : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-slate-300'
                    }`}
                  >
                    <span className="font-semibold uppercase text-[11px]">{t}</span>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
                      {t === 'set' && 'Replace with literal value'}
                      {t === 'append' && 'Add text to the end'}
                      {t === 'prepend' && 'Add text to the start'}
                      {t === 'template' && 'Interpolate {field} vars'}
                    </p>
                  </button>
                ))}
              </div>
            </div>

            {actionType === 'template' ? (
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Template string
                </label>
                <input
                  type="text"
                  value={actionTemplate}
                  onChange={(e) => setActionTemplate(e.target.value)}
                  placeholder="{name} - {brand} Premium Gear"
                  className="w-full text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 focus:outline-none focus:ring-1 focus:ring-violet-400 font-mono"
                />
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  Use <code className="text-[11px] px-1 py-0.5 bg-slate-100 dark:bg-slate-800 rounded">{'{fieldName}'}</code> to interpolate
                  any top-level product field (name, brand, productType, sku, ean).
                </p>
              </div>
            ) : (
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  {actionType === 'set' ? 'Value' : `Text to ${actionType}`}
                </label>
                <input
                  type="text"
                  value={actionValue}
                  onChange={(e) => setActionValue(e.target.value)}
                  placeholder={
                    actionType === 'append'
                      ? 'e.g. " - Premium Motorcycle Gear"'
                      : actionType === 'prepend'
                        ? 'e.g. "XAVIA "'
                        : 'Literal value'
                  }
                  className="w-full text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 focus:outline-none focus:ring-1 focus:ring-violet-400"
                />
              </div>
            )}
          </div>

          {/* Enabled toggle */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="rounded border-slate-300"
            />
            <span className="text-sm text-slate-700 dark:text-slate-300">Enabled</span>
          </label>

          {error && (
            <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm rounded bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {isEdit ? 'Save changes' : 'Create rule'}
          </button>
        </div>
      </div>
    </>
  )
}
