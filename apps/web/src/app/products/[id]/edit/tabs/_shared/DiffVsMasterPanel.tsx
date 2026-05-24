'use client'

/**
 * PIM B.3 — Diff vs Master panel.
 *
 * Renders below the InheritancePanel on every ChannelListingTab. Shows
 * only the SSOT fields where this channel diverges from master, side-
 * by-side: master value | channel override value | which one ships.
 * Empty state when nothing diverges.
 *
 * Backend reuse: GET /channel-listing/:clId/inheritance already returns
 * { effective, master, isOverridden, source } per SSOT field. No new
 * endpoint needed; this is pure rendering on top of B.2's substrate.
 *
 * Out of scope (B.3b):
 *   - "Accept channel value into master" action (promotes override
 *     into Global tab — needs a new write endpoint + confirmation flow)
 *   - Diff for non-SSOT fields (browseNodeId, itemSpecifics) — those
 *     live in platformAttributes and need their own diff logic
 */

import { useCallback, useEffect, useState } from 'react'
import {
  GitCompare,
  Loader2,
  AlertCircle,
  CheckCircle2,
  ArrowRight,
  Equal,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/utils'

type SsotKey = 'title' | 'description' | 'price' | 'quantity' | 'bulletPoints'

interface FieldState {
  effective: unknown
  master: unknown
  isOverridden: boolean
  source: string | null
}

interface InheritanceView {
  productId: string
  channelListingId: string
  channel: string
  marketplace: string
  fields: Record<SsotKey, FieldState>
}

interface Props {
  productId: string
  channelListingId: string
  targetLabel: string
  /** Bumped by parent after an edit so the diff refreshes. */
  refreshSignal?: number
}

const FIELD_ORDER: SsotKey[] = ['title', 'description', 'price', 'quantity', 'bulletPoints']

export default function DiffVsMasterPanel({
  productId,
  channelListingId,
  targetLabel,
  refreshSignal = 0,
}: Props) {
  const [view, setView] = useState<InheritanceView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchView = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch(
        `${getBackendUrl()}/api/products/${productId}/channel-listing/${channelListingId}/inheritance`,
        { cache: 'no-store' },
      )
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = (await r.json()) as InheritanceView
      setView(data)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load diff')
    } finally {
      setLoading(false)
    }
  }, [productId, channelListingId])

  useEffect(() => {
    void fetchView()
  }, [fetchView, refreshSignal])

  if (loading) {
    return (
      <Card>
        <div className="flex items-center justify-center py-4 text-zinc-500 text-xs">
          <Loader2 className="w-3 h-3 animate-spin mr-2" />
          Computing diff…
        </div>
      </Card>
    )
  }
  if (error || !view) {
    // Silent fall-back — InheritancePanel above already surfaces errors
    // and we don't want to double-toast.
    return null
  }

  const diverged = FIELD_ORDER.filter((k) => view.fields[k]?.isOverridden)

  if (diverged.length === 0) {
    return (
      <Card>
        <div className="px-4 py-3 flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="w-3.5 h-3.5" />
          <span>
            No diff vs master — every SSOT field on{' '}
            <span className="font-medium">{targetLabel}</span> inherits from Global.
          </span>
        </div>
      </Card>
    )
  }

  return (
    <Card>
      <header className="px-4 py-2.5 border-b border-zinc-100 dark:border-zinc-800 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
            <GitCompare className="w-3.5 h-3.5 text-zinc-400" />
            Diff vs master ({targetLabel})
          </h3>
          <p className="text-[11px] text-zinc-500 mt-0.5">
            {diverged.length} field{diverged.length === 1 ? '' : 's'} diverge from Global.
            What ships on {targetLabel} is the override.
          </p>
        </div>
      </header>
      <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {diverged.map((key) => (
          <DiffRow key={key} fieldKey={key} state={view.fields[key]} targetLabel={targetLabel} />
        ))}
      </div>
    </Card>
  )
}

function DiffRow({
  fieldKey,
  state,
  targetLabel,
}: {
  fieldKey: SsotKey
  state: FieldState
  targetLabel: string
}) {
  const equal = isEqualish(state.master, state.effective)
  return (
    <div className="px-4 py-3">
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300 capitalize">
          {fieldKey}
        </span>
        <span className="text-[10px] text-amber-700 dark:text-amber-400">overridden</span>
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-3">
        <DiffPane label="Global (master)" value={state.master} variant="master" />
        {equal ? (
          <Equal className="w-3 h-3 text-zinc-400 mt-1 self-center" />
        ) : (
          <ArrowRight className="w-3 h-3 text-zinc-400 mt-1 self-center" />
        )}
        <DiffPane
          label={`Ships on ${targetLabel}`}
          value={state.effective}
          variant="channel"
        />
      </div>
      {equal && (
        <div className="mt-1 flex items-center gap-1 text-[10px] text-zinc-500 italic">
          <AlertCircle className="w-2.5 h-2.5" />
          Override matches master — clearing the override would have no visible effect.
        </div>
      )}
    </div>
  )
}

function DiffPane({
  label,
  value,
  variant,
}: {
  label: string
  value: unknown
  variant: 'master' | 'channel'
}) {
  return (
    <div
      className={cn(
        'rounded border p-2',
        variant === 'master'
          ? 'border-zinc-200 bg-zinc-50/60 dark:border-zinc-700 dark:bg-zinc-900/50'
          : 'border-amber-200 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-900/20',
      )}
    >
      <div
        className={cn(
          'text-[10px] uppercase tracking-wide font-semibold mb-1',
          variant === 'master'
            ? 'text-zinc-500'
            : 'text-amber-700 dark:text-amber-300',
        )}
      >
        {label}
      </div>
      <ValueRender value={value} />
    </div>
  )
}

function ValueRender({ value }: { value: unknown }) {
  if (value == null || value === '') {
    return <div className="text-xs italic text-zinc-400">empty</div>
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <div className="text-xs italic text-zinc-400">empty list</div>
    }
    return (
      <ul className="list-disc list-inside text-xs text-zinc-800 dark:text-zinc-200 space-y-0.5">
        {value.map((v, i) => (
          <li key={i} className="truncate">
            {String(v)}
          </li>
        ))}
      </ul>
    )
  }
  if (typeof value === 'object') {
    return (
      <pre className="text-[10px] font-mono text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap break-words">
        {safeJson(value)}
      </pre>
    )
  }
  return (
    <div className="text-xs text-zinc-800 dark:text-zinc-200 break-words whitespace-pre-wrap">
      {String(value)}
    </div>
  )
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

function isEqualish(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => isEqualish(v, b[i]))
  }
  if (typeof a === 'object' || typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b)
    } catch {
      return false
    }
  }
  return String(a) === String(b)
}
