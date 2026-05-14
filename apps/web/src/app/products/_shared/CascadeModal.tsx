'use client'

/**
 * IN.2 — Cascade-to-siblings modal.
 *
 * Lets the operator choose which fields to push from a source variant's
 * ChannelListing to all sibling variants on the same channel/marketplace.
 *
 * Flow:
 *   1. Opens with field checkboxes pre-populated from the source row values.
 *   2. "Preview" calls POST /api/listings/cascade?dryRun=true to show count.
 *   3. "Apply" calls the real cascade and shows a success toast.
 */

import { useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowDownToLine,
  CheckCircle2,
  GitFork,
  Loader2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

// ── Types ─────────────────────────────────────────────────────────────

export interface CascadeField {
  key: string
  label: string
  value: unknown   // the current value from the source row
}

interface Props {
  sourceProductId: string
  sourceSku: string
  channel: string       // 'AMAZON' | 'EBAY'
  marketplace: string   // 'IT', 'DE', etc.
  availableFields: CascadeField[]
  onClose: () => void
  onSuccess?: (affected: number) => void
}

function formatFieldValue(key: string, value: unknown): string {
  if (value == null || value === '') return '—'
  if (key === 'price') return `€${Number(value).toFixed(2)}`
  if (Array.isArray(value)) return `${value.length} item${value.length !== 1 ? 's' : ''}`
  const s = String(value)
  return s.length > 50 ? s.slice(0, 50) + '…' : s
}

// ── Modal ─────────────────────────────────────────────────────────────

export function CascadeModal({
  sourceProductId,
  sourceSku,
  channel,
  marketplace,
  availableFields,
  onClose,
  onSuccess,
}: Props) {
  // Only include fields that actually have a value
  const withValues = availableFields.filter(
    (f) => f.value != null && f.value !== '' && !(Array.isArray(f.value) && (f.value as unknown[]).length === 0),
  )

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(withValues.map((f) => f.key)),
  )
  const [preview, setPreview] = useState<{ affected: number } | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [applying, setApplying] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggle(key: string) {
    setSelected((prev) => {
      const n = new Set(prev)
      n.has(key) ? n.delete(key) : n.add(key)
      return n
    })
    setPreview(null)
  }

  async function runCascade(dry: boolean) {
    if (selected.size === 0) return
    dry ? setPreviewing(true) : setApplying(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/listings/cascade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceProductId,
          channel,
          marketplace,
          fields: Array.from(selected),
          dryRun: dry,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const json: { affected: number; note?: string } = await res.json()
      if (dry) {
        setPreview({ affected: json.affected })
      } else {
        setDone(true)
        onSuccess?.(json.affected)
        setTimeout(onClose, 1500)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cascade failed')
    } finally {
      dry ? setPreviewing(false) : setApplying(false)
    }
  }

  const content = (
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-sm bg-white dark:bg-slate-900 rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-2">
            <GitFork className="h-4 w-4 text-blue-500" />
            <div>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Apply to sibling variants
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {channel} · {marketplace} · from <span className="font-mono">{sourceSku}</span>
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Field checkboxes */}
        <div className="px-4 py-3 space-y-1.5">
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">
            Select fields to push to all other variants in this product family:
          </p>
          {withValues.length === 0 ? (
            <p className="text-xs text-slate-400 italic">No field values available to cascade.</p>
          ) : (
            withValues.map((f) => (
              <label
                key={f.key}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors',
                  selected.has(f.key)
                    ? 'bg-blue-50 dark:bg-blue-900/20'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-800/50',
                )}
              >
                <input
                  type="checkbox"
                  checked={selected.has(f.key)}
                  onChange={() => toggle(f.key)}
                  className="w-3.5 h-3.5 accent-blue-600 shrink-0"
                />
                <span className="text-xs font-medium text-slate-700 dark:text-slate-300 w-24 shrink-0">
                  {f.label}
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400 truncate font-mono">
                  {formatFieldValue(f.key, f.value)}
                </span>
              </label>
            ))
          )}
        </div>

        {/* Preview result */}
        {preview && (
          <div className="mx-4 mb-3 flex items-center gap-2 rounded-md bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs">
            <ArrowDownToLine className="h-3.5 w-3.5 text-blue-500 shrink-0" />
            <span className="text-slate-700 dark:text-slate-300">
              {preview.affected === 0
                ? 'No sibling variants found for this channel/marketplace.'
                : `Will update ${preview.affected} sibling variant${preview.affected !== 1 ? 's' : ''}.`}
            </span>
          </div>
        )}

        {/* Success */}
        {done && (
          <div className="mx-4 mb-3 flex items-center gap-2 rounded-md bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> Applied successfully.
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mx-4 mb-3 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md px-3 py-2">
            {error}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
          <Button variant="ghost" size="sm" onClick={() => runCascade(true)} disabled={selected.size === 0 || previewing || applying || done}>
            {previewing ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
            Preview
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => runCascade(false)}
              disabled={selected.size === 0 || applying || done || (preview?.affected === 0)}
            >
              {applying ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <ArrowDownToLine className="h-3.5 w-3.5 mr-1" />}
              Apply to {preview != null ? preview.affected : '?'} variants
            </Button>
          </div>
        </div>
      </div>
    </div>
  )

  return typeof document !== 'undefined'
    ? createPortal(content, document.body)
    : null
}
