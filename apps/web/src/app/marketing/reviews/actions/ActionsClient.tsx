'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Loader2, CheckCircle2, XCircle, Copy, ShieldAlert, FileText, List } from 'lucide-react'

export interface ActionItem {
  id: string
  spikeId: string | null
  productId: string | null
  marketplace: string | null
  category: string | null
  type: 'BULLETS' | 'APLUS' | 'RECALL_FLAG' | 'TASK'
  title: string
  detail: string | null
  payload: {
    bullets?: string[]
    module?: { headline: string; body: string } | null
    recallsHref?: string
  } | null
  status: string
  source: string
  createdAt: string
}

const STATUSES = [
  { key: 'OPEN', label: 'Open' },
  { key: 'APPLIED', label: 'Applied' },
  { key: 'DISMISSED', label: 'Dismissed' },
]

const TYPE_META: Record<string, { label: string; icon: React.ReactNode; tone: string }> = {
  BULLETS: { label: 'Bullets', icon: <List className="h-4 w-4" />, tone: 'text-blue-600 dark:text-blue-400' },
  APLUS: { label: 'A+ module', icon: <FileText className="h-4 w-4" />, tone: 'text-violet-600 dark:text-violet-400' },
  RECALL_FLAG: { label: 'Recall', icon: <ShieldAlert className="h-4 w-4" />, tone: 'text-rose-600 dark:text-rose-400' },
  TASK: { label: 'Task', icon: <FileText className="h-4 w-4" />, tone: 'text-slate-600 dark:text-slate-400' },
}

export function ActionsClient({ initial }: { initial: ActionItem[] }) {
  const [status, setStatus] = useState('OPEN')
  const [items, setItems] = useState<ActionItem[]>(initial)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (st: string) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/reviews/action-items?status=${st}&limit=200`, { cache: 'no-store' })
      const json = await res.json()
      setItems(json.items ?? [])
    } catch {
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (status !== 'OPEN' || items !== initial) load(status)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  const setItemStatus = useCallback(
    async (id: string, newStatus: string) => {
      setItems((prev) => prev.filter((i) => i.id !== id))
      await fetch(`/api/reviews/action-items/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      }).catch(() => {})
    },
    [],
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5">
        {STATUSES.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setStatus(s.key)}
            className={`text-sm px-3 py-1.5 rounded-md ring-1 ring-inset ${
              status === s.key
                ? 'bg-slate-900 text-white ring-slate-900 dark:bg-slate-100 dark:text-slate-900 dark:ring-slate-100'
                : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-12 text-tertiary">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-sm text-slate-500 dark:text-slate-400">
          Nothing here. Open the <Link href="/marketing/reviews/spikes" className="text-blue-600 dark:text-blue-400 hover:underline">Spikes</Link> tab and “Generate fixes”.
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((it) => (
            <ActionCard key={it.id} item={it} onStatus={setItemStatus} />
          ))}
        </div>
      )}
    </div>
  )
}

function ActionCard({ item, onStatus }: { item: ActionItem; onStatus: (id: string, s: string) => void }) {
  const [copied, setCopied] = useState(false)
  const meta = TYPE_META[item.type] ?? TYPE_META.TASK

  const copyText = () => {
    let text = ''
    if (item.type === 'BULLETS') text = (item.payload?.bullets ?? []).map((b) => `• ${b}`).join('\n')
    else if (item.type === 'APLUS' && item.payload?.module)
      text = `${item.payload.module.headline}\n\n${item.payload.module.body}`
    if (!text) return
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const canCopy = item.type === 'BULLETS' || item.type === 'APLUS'

  return (
    <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-800 rounded-md p-3">
      <div className="flex items-center gap-2 mb-1.5">
        <span className={meta.tone}>{meta.icon}</span>
        <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{item.title}</span>
        {item.marketplace && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">{item.marketplace}</span>}
        <span className="ml-auto text-[10px] text-tertiary">{new Date(item.createdAt).toLocaleDateString()}</span>
      </div>
      {item.detail && <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">{item.detail}</p>}

      {/* Payload */}
      {item.type === 'BULLETS' && item.payload?.bullets && (
        <ul className="text-sm text-slate-700 dark:text-slate-300 list-disc pl-5 space-y-0.5 mb-2">
          {item.payload.bullets.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
      )}
      {item.type === 'APLUS' && item.payload?.module && (
        <div className="mb-2 rounded bg-slate-50 dark:bg-slate-950/40 p-2">
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{item.payload.module.headline}</div>
          <div className="text-sm text-slate-700 dark:text-slate-300">{item.payload.module.body}</div>
        </div>
      )}

      <div className="flex items-center gap-2">
        {canCopy && (
          <button
            type="button"
            onClick={copyText}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded ring-1 ring-inset bg-slate-50 text-slate-700 ring-slate-200 hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700"
          >
            <Copy className="h-3.5 w-3.5" />
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
        {item.type === 'RECALL_FLAG' && (
          <Link
            href={item.payload?.recallsHref ?? '/fulfillment/stock/recalls'}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded ring-1 ring-inset bg-rose-50 text-rose-700 ring-rose-200 hover:bg-rose-100 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900"
          >
            <ShieldAlert className="h-3.5 w-3.5" />
            Open recalls
          </Link>
        )}
        {item.productId && (
          <Link href={`/products/${item.productId}`} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
            View product
          </Link>
        )}
        {item.status === 'OPEN' && (
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onStatus(item.id, 'APPLIED')}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded ring-1 ring-inset bg-emerald-50 text-emerald-700 ring-emerald-200 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900"
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              Mark applied
            </button>
            <button
              type="button"
              onClick={() => onStatus(item.id, 'DISMISSED')}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded ring-1 ring-inset bg-slate-50 text-slate-500 ring-slate-200 hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700"
            >
              <XCircle className="h-3.5 w-3.5" />
              Dismiss
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
