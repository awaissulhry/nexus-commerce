'use client'

/**
 * PIM D.6 — Dry-run payload preview modal.
 *
 * Shows the exact JSON payload that would publish for one product on
 * the active marketplace, alongside per-field provenance so operators
 * can audit:
 *   - which source path the value came from
 *   - which transforms applied (truncate / case / replace / etc.)
 *   - warnings (e.g. "truncated from 250 → 200")
 *   - missing required fields highlighted
 *
 * Two-pane: left = per-field rows, right = pretty-printed JSON.
 * Operator can copy the JSON to clipboard to paste into an SP-API
 * tester (or D.7 future direct-publish gate).
 */

import { useState } from 'react'
import {
  X,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Copy,
  Check,
  AlertTriangle,
  FileCode,
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface PreviewField {
  fieldKey: string
  rule: {
    source: string
    fallback?: string
    transforms?: Array<{ type: string; [k: string]: unknown }>
    required?: boolean
  }
  value: unknown
  source: 'source' | 'fallback' | 'default' | 'missing'
  raw: unknown
  appliedTransforms: string[]
  warnings: string[]
  required: boolean
}

interface PreviewResult {
  productId: string
  productSku: string
  channel: string
  marketplace: string
  payload: Record<string, unknown>
  fields: PreviewField[]
  missingRequired: string[]
}

interface Props {
  open: boolean
  onClose: () => void
  result: PreviewResult | null
  loading: boolean
  error: string | null
}

export default function PayloadPreviewModal({ open, onClose, result, loading, error }: Props) {
  const [copied, setCopied] = useState(false)

  if (!open) return null

  const handleCopy = async () => {
    if (!result) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(result.payload, null, 2))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard might be unavailable in some browsers — quiet fail */
    }
  }

  const ok = result && result.missingRequired.length === 0

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <div
        className="bg-white dark:bg-zinc-900 rounded-lg shadow-xl w-full max-w-5xl h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileCode className="w-4 h-4 text-zinc-500" />
            <div>
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                Payload preview
              </h2>
              {result && (
                <p className="text-[11px] text-zinc-500">
                  {result.channel} · {result.marketplace} · {result.productSku}
                </p>
              )}
            </div>
            {result && (
              <span
                className={cn(
                  'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ml-2',
                  ok
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                    : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
                )}
              >
                {ok ? (
                  <>
                    <CheckCircle2 className="w-2.5 h-2.5" /> publish-ready
                  </>
                ) : (
                  <>
                    <AlertCircle className="w-2.5 h-2.5" />
                    {result.missingRequired.length} required missing
                  </>
                )}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="flex-1 overflow-hidden flex">
          {loading && (
            <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              Generating preview…
            </div>
          )}
          {error && (
            <div className="flex-1 flex items-start gap-2 p-4 text-red-700 dark:text-red-300 text-sm">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              {error}
            </div>
          )}
          {!loading && !error && result && (
            <>
              {/* Left: per-field rows */}
              <aside className="w-1/2 overflow-y-auto border-r border-zinc-200 dark:border-zinc-800">
                {result.fields.length === 0 ? (
                  <div className="p-6 text-center text-zinc-500 text-sm italic">
                    No mapping rules defined yet — author rules in the editor to see them
                    resolve here.
                  </div>
                ) : (
                  <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {result.fields.map((f) => (
                      <FieldRow key={f.fieldKey} field={f} />
                    ))}
                  </ul>
                )}
              </aside>

              {/* Right: pretty JSON */}
              <main className="w-1/2 flex flex-col bg-zinc-50 dark:bg-zinc-950/40">
                <div className="px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
                  <span className="text-[11px] uppercase tracking-wide text-zinc-500 font-semibold">
                    Generated payload
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleCopy()}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-zinc-600 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  >
                    {copied ? (
                      <>
                        <Check className="w-2.5 h-2.5 text-emerald-600" /> copied
                      </>
                    ) : (
                      <>
                        <Copy className="w-2.5 h-2.5" /> copy JSON
                      </>
                    )}
                  </button>
                </div>
                <pre className="flex-1 overflow-auto p-3 text-xs font-mono text-zinc-800 dark:text-zinc-200">
                  {JSON.stringify(result.payload, null, 2)}
                </pre>
              </main>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function FieldRow({ field }: { field: PreviewField }) {
  const provenanceTone =
    field.source === 'source'
      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
      : field.source === 'fallback'
      ? 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
      : field.source === 'default'
      ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
      : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300'

  return (
    <li className={cn('px-3 py-2', field.source === 'missing' && field.required && 'bg-red-50/30 dark:bg-red-900/10')}>
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <div className="flex items-baseline gap-1.5 min-w-0">
          <span className="font-mono text-xs text-zinc-700 dark:text-zinc-300 truncate">
            {field.fieldKey}
          </span>
          {field.required && (
            <span className="text-[9px] text-red-600 dark:text-red-400">required</span>
          )}
        </div>
        <span className={cn('text-[9px] font-medium px-1 py-0.5 rounded', provenanceTone)}>
          {field.source}
        </span>
      </div>
      <div className="text-xs text-zinc-900 dark:text-zinc-100 break-words font-mono">
        {field.source === 'missing' ? (
          <span className="italic text-zinc-400">(no value)</span>
        ) : (
          formatValue(field.value)
        )}
      </div>
      {field.appliedTransforms.length > 0 && (
        <div className="mt-1 flex items-center gap-1 flex-wrap">
          {field.appliedTransforms.map((t, i) => (
            <span
              key={i}
              className="text-[9px] px-1 py-0.5 rounded bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400 font-mono"
            >
              {t}
            </span>
          ))}
        </div>
      )}
      {field.warnings.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {field.warnings.map((w, i) => (
            <div
              key={i}
              className="text-[10px] text-amber-700 dark:text-amber-300 flex items-start gap-1"
            >
              <AlertTriangle className="w-2.5 h-2.5 mt-0.5 flex-shrink-0" />
              {w}
            </div>
          ))}
        </div>
      )}
      <div className="text-[9px] text-zinc-400 mt-1 font-mono">
        ← {field.rule.source}
        {field.rule.fallback && ` / fallback: ${field.rule.fallback}`}
      </div>
    </li>
  )
}

function formatValue(v: unknown): string {
  if (v == null) return '—'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return JSON.stringify(v, null, 0)
  } catch {
    return String(v)
  }
}
