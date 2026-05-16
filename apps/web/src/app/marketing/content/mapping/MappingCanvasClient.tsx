'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Plus,
  Pencil,
  Trash2,
  Loader2,
  Layers,
  RefreshCw,
  Play,
  Database,
  CheckCircle2,
  XCircle,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { RuleBuilderDrawer } from './RuleBuilderDrawer'

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

interface SchemaField {
  id: string
  channel: string
  marketplace: string | null
  fieldKey: string
  label: string
  maxLength: number | null
  required: boolean
}

interface FieldResult {
  field: string
  value: string
  ruleId: string
  ruleName: string
  actionType: string
}

interface PreviewResult {
  package: {
    channel: string
    marketplace: string | null
    fields: FieldResult[]
    resolved: Record<string, string>
  }
  validationErrors: { field: string; message: string }[]
}

const CHANNEL_COLORS: Record<string, string> = {
  AMAZON: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900',
  EBAY:   'bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:ring-blue-900',
  SHOPIFY:'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900',
  ALL:    'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:ring-violet-900',
}

const ACTION_LABEL: Record<string, string> = {
  set: 'SET',
  append: 'APPEND',
  prepend: 'PREPEND',
  template: 'TEMPLATE',
}

const OP_LABEL: Record<string, string> = {
  eq: '==',
  ne: '≠',
  lt: '<',
  lte: '≤',
  gt: '>',
  gte: '≥',
  in: 'IN',
  contains: 'CONTAINS',
  exists: 'EXISTS',
}

function ChannelBadge({ channel }: { channel: string }) {
  return (
    <span
      className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset font-medium ${CHANNEL_COLORS[channel] ?? CHANNEL_COLORS.ALL}`}
    >
      {channel}
    </span>
  )
}

function ConditionSummary({ condition }: { condition: TransformRule['condition'] }) {
  if (!condition) {
    return <span className="text-slate-400 dark:text-slate-500 italic text-xs">always</span>
  }
  return (
    <span className="text-xs font-mono text-slate-600 dark:text-slate-400">
      <span className="text-violet-600 dark:text-violet-400">{condition.field}</span>
      {' '}
      <span className="text-slate-500">{OP_LABEL[condition.op] ?? condition.op}</span>
      {' '}
      <span className="text-emerald-700 dark:text-emerald-400">
        {condition.value !== undefined ? JSON.stringify(condition.value) : '—'}
      </span>
    </span>
  )
}

function ActionSummary({ action }: { action: TransformRule['action'] }) {
  return (
    <span className="text-xs font-mono">
      <span className="text-amber-700 dark:text-amber-400 font-semibold">
        {ACTION_LABEL[action.type] ?? action.type}
      </span>
      {' '}
      <span className="text-slate-600 dark:text-slate-400 italic">
        {action.template
          ? `"${action.template.slice(0, 40)}${action.template.length > 40 ? '…' : ''}"`
          : action.value
            ? `"${String(action.value).slice(0, 40)}${String(action.value).length > 40 ? '…' : ''}"`
            : ''}
      </span>
    </span>
  )
}

export function MappingCanvasClient({
  initialRules,
  schemaFields,
}: {
  initialRules: TransformRule[]
  schemaFields: SchemaField[]
}) {
  const router = useRouter()
  const [rules, setRules] = useState<TransformRule[]>(initialRules)
  const [channelFilter, setChannelFilter] = useState<string>('ALL')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editingRule, setEditingRule] = useState<TransformRule | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [seedBusy, setSeedBusy] = useState(false)
  const [seedMsg, setSeedMsg] = useState<string | null>(null)
  const [previewProductId, setPreviewProductId] = useState('')
  const [previewChannel, setPreviewChannel] = useState<string>('AMAZON')
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewResult, setPreviewResult] = useState<PreviewResult | null>(null)
  const [browseNode, setBrowseNode] = useState<{
    nodeId: string; nodePath: string; confidence: number; reasoning: string
  } | null>(null)
  const [, startTransition] = useTransition()

  const displayed = channelFilter === 'ALL'
    ? rules
    : rules.filter((r) => r.channel === channelFilter || r.channel === 'ALL')

  async function seedSchemas() {
    setSeedBusy(true)
    setSeedMsg(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/feed-transform/seed-schemas`, { method: 'POST' })
      const json = (await res.json()) as { ok: boolean; upserted: number }
      setSeedMsg(`Seeded ${json.upserted} field definitions`)
      startTransition(() => router.refresh())
    } finally {
      setSeedBusy(false)
    }
  }

  async function toggleEnabled(rule: TransformRule) {
    setTogglingId(rule.id)
    try {
      await fetch(`${getBackendUrl()}/api/feed-transform/rules/${rule.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !rule.enabled }),
      })
      setRules((prev) =>
        prev.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r)),
      )
    } finally {
      setTogglingId(null)
    }
  }

  async function deleteRule(id: string) {
    if (!confirm('Delete this transform rule?')) return
    setDeletingId(id)
    try {
      await fetch(`${getBackendUrl()}/api/feed-transform/rules/${id}`, { method: 'DELETE' })
      setRules((prev) => prev.filter((r) => r.id !== id))
    } finally {
      setDeletingId(null)
    }
  }

  function openNew() {
    setEditingRule(null)
    setDrawerOpen(true)
  }

  function openEdit(rule: TransformRule) {
    setEditingRule(rule)
    setDrawerOpen(true)
  }

  async function onSaved(saved: TransformRule) {
    setDrawerOpen(false)
    if (editingRule) {
      setRules((prev) => prev.map((r) => (r.id === saved.id ? saved : r)))
    } else {
      setRules((prev) => [...prev, saved])
    }
  }

  async function runPreview() {
    if (!previewProductId.trim()) return
    setPreviewBusy(true)
    setPreviewResult(null)
    setBrowseNode(null)
    try {
      const [transformRes, browseRes] = await Promise.all([
        fetch(`${getBackendUrl()}/api/feed-transform/preview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productId: previewProductId.trim(), channel: previewChannel }),
        }),
        fetch(
          `${getBackendUrl()}/api/feed-transform/predict-browse-node/${previewProductId.trim()}?channel=${previewChannel}`,
          { method: 'POST' },
        ).catch(() => null),
      ])
      const json = (await transformRes.json()) as PreviewResult
      setPreviewResult(json)
      if (browseRes?.ok) {
        const bn = (await browseRes.json()) as {
          prediction: { nodeId: string; nodePath: string; confidence: number; reasoning: string }
        }
        setBrowseNode(bn.prediction)
      }
    } finally {
      setPreviewBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Channel filter */}
        {(['ALL', 'AMAZON', 'EBAY', 'SHOPIFY'] as const).map((ch) => (
          <button
            key={ch}
            type="button"
            onClick={() => setChannelFilter(ch)}
            className={`px-2.5 py-1 text-xs rounded-full ring-1 ring-inset transition-colors ${
              channelFilter === ch
                ? 'bg-violet-600 text-white ring-violet-600'
                : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 ring-slate-300 dark:ring-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'
            }`}
          >
            {ch === 'ALL' ? 'All channels' : ch.charAt(0) + ch.slice(1).toLowerCase()}
          </button>
        ))}

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={seedSchemas}
            disabled={seedBusy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded ring-1 ring-inset ring-slate-300 dark:ring-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40"
          >
            {seedBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Database className="h-3.5 w-3.5" />}
            Seed schemas
          </button>
          <button
            type="button"
            onClick={() => startTransition(() => router.refresh())}
            className="p-1.5 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={openNew}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-violet-600 hover:bg-violet-700 text-white"
          >
            <Plus className="h-4 w-4" />
            Add rule
          </button>
        </div>
      </div>

      {seedMsg && (
        <p className="text-xs text-slate-500 dark:text-slate-400">{seedMsg}</p>
      )}

      {/* Rules table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md overflow-hidden">
        {displayed.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <Layers className="h-8 w-8 text-slate-300 dark:text-slate-700 mx-auto mb-3" />
            <p className="text-sm text-slate-500 dark:text-slate-400">No transform rules yet.</p>
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
              Click <strong>Add rule</strong> to define your first IF/THEN field mapping.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-medium w-6">#</th>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-medium">Rule</th>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-medium">Channel</th>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-medium">Field</th>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-medium">Condition</th>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-medium">Action</th>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-medium w-20">Status</th>
                <th className="px-3 py-2 w-20" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {displayed.map((rule) => (
                <tr
                  key={rule.id}
                  className={`group ${!rule.enabled ? 'opacity-50' : ''}`}
                >
                  <td className="px-3 py-2 text-xs text-slate-400 tabular-nums">{rule.priority}</td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-900 dark:text-slate-100 text-sm leading-tight">
                      {rule.name}
                    </div>
                    {rule.description && (
                      <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-1">
                        {rule.description}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <ChannelBadge channel={rule.channel} />
                      {rule.marketplace && (
                        <span className="text-[10px] text-slate-500">{rule.marketplace}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <span className="text-xs font-mono text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">
                      {rule.field}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <ConditionSummary condition={rule.condition} />
                  </td>
                  <td className="px-3 py-2">
                    <ActionSummary action={rule.action} />
                  </td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => toggleEnabled(rule)}
                      disabled={togglingId === rule.id}
                      className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ring-1 ring-inset transition-colors ${
                        rule.enabled
                          ? 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900'
                          : 'bg-slate-100 text-slate-500 ring-slate-200 dark:bg-slate-800 dark:text-slate-500 dark:ring-slate-700'
                      }`}
                    >
                      {togglingId === rule.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : rule.enabled ? (
                        <CheckCircle2 className="h-3 w-3" />
                      ) : (
                        <XCircle className="h-3 w-3" />
                      )}
                      {rule.enabled ? 'Active' : 'Off'}
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        type="button"
                        onClick={() => openEdit(rule)}
                        className="p-1 rounded text-slate-400 hover:text-violet-600 dark:hover:text-violet-400"
                        title="Edit rule"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteRule(rule.id)}
                        disabled={deletingId === rule.id}
                        className="p-1 rounded text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 disabled:opacity-40"
                        title="Delete rule"
                      >
                        {deletingId === rule.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Preview panel */}
      <section>
        <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
          Preview — evaluate rules against a product
        </h2>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md p-4 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="text"
              placeholder="Product ID (cuid)"
              value={previewProductId}
              onChange={(e) => setPreviewProductId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runPreview()}
              className="flex-1 min-w-48 text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-violet-400 font-mono"
            />
            <select
              value={previewChannel}
              onChange={(e) => setPreviewChannel(e.target.value)}
              className="text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-violet-400"
            >
              <option value="AMAZON">Amazon</option>
              <option value="EBAY">eBay</option>
              <option value="SHOPIFY">Shopify</option>
            </select>
            <button
              type="button"
              onClick={runPreview}
              disabled={previewBusy || !previewProductId.trim()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded ring-1 ring-inset ring-slate-300 dark:ring-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40"
            >
              {previewBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Preview
            </button>
          </div>

          {browseNode && (
            <div className="flex items-center gap-2 p-2 rounded-md bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
              <span className="text-xs text-slate-500 shrink-0">Browse node</span>
              <span className="font-mono text-xs text-slate-700 dark:text-slate-300">
                {browseNode.nodeId}
              </span>
              {browseNode.nodePath && (
                <span className="text-xs text-slate-400 truncate">{browseNode.nodePath}</span>
              )}
              <span
                className={`ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                  browseNode.confidence >= 0.85
                    ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300'
                    : browseNode.confidence >= 0.65
                      ? 'bg-amber-50 text-amber-700 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300'
                      : 'bg-rose-50 text-rose-700 ring-1 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300'
                }`}
              >
                {Math.round(browseNode.confidence * 100)}% conf
              </span>
            </div>
          )}

          {previewResult && (
            <div className="space-y-3">
              {/* Validation errors */}
              {previewResult.validationErrors.length > 0 && (
                <div className="bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-md px-3 py-2">
                  <p className="text-xs font-medium text-rose-700 dark:text-rose-300 mb-1">
                    Schema validation errors
                  </p>
                  <ul className="space-y-0.5">
                    {previewResult.validationErrors.map((e) => (
                      <li key={e.field} className="text-xs text-rose-600 dark:text-rose-400">
                        <span className="font-mono">{e.field}</span>: {e.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Resolved fields */}
              {previewResult.package.fields.length === 0 ? (
                <div className="text-xs text-slate-500 dark:text-slate-400 text-center py-3">
                  No rules matched this product × channel combination.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-slate-800">
                        <th className="text-left pb-1.5 font-medium text-slate-500 pr-4">Field</th>
                        <th className="text-left pb-1.5 font-medium text-slate-500 pr-4">Rule applied</th>
                        <th className="text-left pb-1.5 font-medium text-slate-500 pr-4">Action</th>
                        <th className="text-left pb-1.5 font-medium text-slate-500">Resolved value</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {previewResult.package.fields.map((f) => (
                        <tr key={f.field}>
                          <td className="py-1.5 pr-4 font-mono text-slate-700 dark:text-slate-300">
                            {f.field}
                          </td>
                          <td className="py-1.5 pr-4 text-slate-500 dark:text-slate-400">
                            {f.ruleName}
                          </td>
                          <td className="py-1.5 pr-4">
                            <span className="text-amber-700 dark:text-amber-400 font-semibold uppercase text-[10px]">
                              {f.actionType}
                            </span>
                          </td>
                          <td className="py-1.5 text-slate-700 dark:text-slate-300 max-w-xs truncate">
                            {f.value || <span className="text-slate-400 italic">(empty)</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {/* How it works */}
      <section>
        <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
          How rules are evaluated
        </h2>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-4 py-3 text-sm text-slate-600 dark:text-slate-400 space-y-2">
          <div className="flex items-start gap-2">
            <span className="font-mono text-violet-600 dark:text-violet-400 text-xs mt-0.5">1</span>
            <span>
              <strong className="text-slate-900 dark:text-slate-100">Priority order</strong> — Rules
              are sorted by priority (lower = evaluated first). Within the same priority,
              marketplace-specific rules beat null-marketplace rules.
            </span>
          </div>
          <div className="flex items-start gap-2">
            <span className="font-mono text-violet-600 dark:text-violet-400 text-xs mt-0.5">2</span>
            <span>
              <strong className="text-slate-900 dark:text-slate-100">First match wins</strong> — For
              each output field, only the first matching rule is applied. Subsequent rules for the
              same field are skipped.
            </span>
          </div>
          <div className="flex items-start gap-2">
            <span className="font-mono text-violet-600 dark:text-violet-400 text-xs mt-0.5">3</span>
            <span>
              <strong className="text-slate-900 dark:text-slate-100">Actions</strong> —{' '}
              <code className="text-[11px] px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800">SET</code> replaces the value,{' '}
              <code className="text-[11px] px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800">APPEND</code> /{' '}
              <code className="text-[11px] px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800">PREPEND</code> concatenate,{' '}
              <code className="text-[11px] px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800">TEMPLATE</code> interpolates{' '}
              <code className="text-[11px] px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800">{'{field}'}</code> placeholders.
            </span>
          </div>
        </div>
      </section>

      {/* Rule builder drawer */}
      {drawerOpen && (
        <RuleBuilderDrawer
          rule={editingRule}
          schemaFields={schemaFields}
          onClose={() => setDrawerOpen(false)}
          onSaved={onSaved}
        />
      )}
    </div>
  )
}
