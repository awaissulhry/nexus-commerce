'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Plus,
  Loader2,
  Trash2,
  Play,
  Download,
  Tag,
  Users,
  RefreshCw,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { SegmentBuilderDrawer } from './SegmentBuilderDrawer'

interface Segment {
  id: string
  name: string
  description: string | null
  conditions: Array<{ field: string; op: string; value?: unknown }>
  customerCount: number
  lastCountedAt: string | null
  createdAt: string
}

const FIELD_LABELS: Record<string, string> = {
  totalSpentCents: 'LTV (cents)',
  totalOrders: 'Total orders',
  rfmLabel: 'RFM label',
  fiscalKind: 'Customer type',
  riskFlag: 'Risk flag',
  lastOrderAt: 'Last order',
  firstOrderAt: 'First order',
  tags: 'Tags',
}

const OP_LABELS: Record<string, string> = {
  eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', in: 'in', contains: 'contains', exists: 'exists',
}

export function SegmentsClient({ initialSegments }: { initialSegments: Segment[] }) {
  const router = useRouter()
  const [segments, setSegments] = useState<Segment[]>(initialSegments)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editingSegment, setEditingSegment] = useState<Segment | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [evaluatingId, setEvaluatingId] = useState<string | null>(null)
  const [tagInputs, setTagInputs] = useState<Record<string, string>>({})
  const [taggingId, setTaggingId] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  async function deleteSegment(id: string) {
    if (!confirm('Delete this segment?')) return
    setDeletingId(id)
    try {
      await fetch(`${getBackendUrl()}/api/customers/segments/${id}`, { method: 'DELETE' })
      setSegments((prev) => prev.filter((s) => s.id !== id))
    } finally {
      setDeletingId(null)
    }
  }

  async function evaluate(seg: Segment) {
    setEvaluatingId(seg.id)
    try {
      const res = await fetch(`${getBackendUrl()}/api/customers/segments/${seg.id}/evaluate`, { method: 'POST' })
      const json = (await res.json()) as { count: number }
      setSegments((prev) =>
        prev.map((s) => s.id === seg.id ? { ...s, customerCount: json.count, lastCountedAt: new Date().toISOString() } : s),
      )
    } finally {
      setEvaluatingId(null)
    }
  }

  async function exportCSV(id: string) {
    const url = `${getBackendUrl()}/api/customers/segments/${id}/export`
    const res = await fetch(url, { method: 'POST' })
    if (!res.ok) return
    const blob = await res.blob()
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `segment-${id}.csv`
    a.click()
  }

  async function bulkTag(id: string) {
    const tag = tagInputs[id]?.trim()
    if (!tag) return
    setTaggingId(id)
    try {
      const res = await fetch(`${getBackendUrl()}/api/customers/segments/${id}/tag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag }),
      })
      const json = (await res.json()) as { updated: number }
      alert(`Tagged ${json.updated} customers with "${tag}"`)
      setTagInputs((prev) => ({ ...prev, [id]: '' }))
    } finally {
      setTaggingId(null)
    }
  }

  function onSaved(seg: Segment) {
    setDrawerOpen(false)
    if (editingSegment) {
      setSegments((prev) => prev.map((s) => s.id === seg.id ? seg : s))
    } else {
      setSegments((prev) => [seg, ...prev])
    }
    startTransition(() => router.refresh())
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => { setEditingSegment(null); setDrawerOpen(true) }}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-violet-600 hover:bg-violet-700 text-white"
        >
          <Plus className="h-4 w-4" />
          New segment
        </button>
        <button
          type="button"
          onClick={() => startTransition(() => router.refresh())}
          className="p-1.5 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Segment cards */}
      {segments.length === 0 ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-6 py-10 text-center">
          <Users className="h-8 w-8 text-slate-300 dark:text-slate-700 mx-auto mb-3" />
          <p className="text-sm text-slate-500">No segments yet.</p>
          <p className="text-xs text-slate-400 mt-1">
            Click <strong>New segment</strong> to define your first customer cohort.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {segments.map((seg) => (
            <div
              key={seg.id}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md p-4"
            >
              <div className="flex items-start justify-between gap-3 mb-2">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{seg.name}</h3>
                  {seg.description && (
                    <p className="text-xs text-slate-500 mt-0.5">{seg.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => { setEditingSegment(seg); setDrawerOpen(true) }}
                    className="px-2 py-1 text-xs rounded ring-1 ring-inset ring-slate-300 dark:ring-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteSegment(seg.id)}
                    disabled={deletingId === seg.id}
                    className="p-1 rounded text-slate-400 hover:text-rose-600 disabled:opacity-40"
                  >
                    {deletingId === seg.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>

              {/* Conditions summary */}
              <div className="flex items-center gap-1.5 flex-wrap mb-3">
                {seg.conditions.map((c, i) => (
                  <span
                    key={i}
                    className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400"
                  >
                    {FIELD_LABELS[c.field] ?? c.field}{' '}
                    <span className="text-violet-600 dark:text-violet-400">{OP_LABELS[c.op] ?? c.op}</span>{' '}
                    {c.value !== undefined ? JSON.stringify(c.value) : ''}
                  </span>
                ))}
                {seg.conditions.length === 0 && (
                  <span className="text-xs text-slate-400 italic">No conditions — matches all customers</span>
                )}
              </div>

              {/* Count + actions row */}
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-1.5">
                  <Users className="h-3.5 w-3.5 text-slate-400" />
                  <span className="text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                    {seg.customerCount.toLocaleString()}
                  </span>
                  <span className="text-xs text-slate-400">customers</span>
                  {seg.lastCountedAt && (
                    <span className="text-[10px] text-slate-400">
                      · counted {new Date(seg.lastCountedAt).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })}
                    </span>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => evaluate(seg)}
                  disabled={evaluatingId === seg.id}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded ring-1 ring-inset ring-slate-300 dark:ring-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 disabled:opacity-40"
                >
                  {evaluatingId === seg.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                  Recount
                </button>

                <button
                  type="button"
                  onClick={() => exportCSV(seg.id)}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded ring-1 ring-inset ring-slate-300 dark:ring-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50"
                >
                  <Download className="h-3 w-3" />
                  Export CSV
                </button>

                {/* Bulk tag */}
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    placeholder="tag name"
                    value={tagInputs[seg.id] ?? ''}
                    onChange={(e) => setTagInputs((prev) => ({ ...prev, [seg.id]: e.target.value }))}
                    onKeyDown={(e) => e.key === 'Enter' && bulkTag(seg.id)}
                    className="w-24 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 focus:outline-none focus:ring-1 focus:ring-violet-400"
                  />
                  <button
                    type="button"
                    onClick={() => bulkTag(seg.id)}
                    disabled={taggingId === seg.id || !tagInputs[seg.id]?.trim()}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded ring-1 ring-inset ring-slate-300 dark:ring-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 disabled:opacity-40"
                  >
                    {taggingId === seg.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Tag className="h-3 w-3" />}
                    Tag all
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {drawerOpen && (
        <SegmentBuilderDrawer
          segment={editingSegment}
          onClose={() => setDrawerOpen(false)}
          onSaved={onSaved}
        />
      )}
    </div>
  )
}
