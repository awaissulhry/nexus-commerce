'use client'

import { useState, useCallback } from 'react'
import {
  BrainCircuit, ChevronDown, CheckSquare, Square, Loader2,
  X, CheckCircle2, AlertCircle, Sparkles,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import type { AiPanelCtx, FlatFileAiChange } from '@/components/flat-file/FlatFileGrid.types'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AiChange extends FlatFileAiChange {
  selected: boolean
}

type PanelState = 'idle' | 'running' | 'review' | 'applied'

interface UsageInfo {
  inputTokens: number
  outputTokens: number
  costUSD: number
  model: string
}

const MODELS = [
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (fast)' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (smart)' },
] as const

// ── Main component ────────────────────────────────────────────────────────────

interface Props extends AiPanelCtx {
  channel: 'amazon' | 'ebay'
}

export function FlatFileAiPanel({ rows, columns, marketplace, onApplyChanges, channel }: Props) {
  const { toast } = useToast()
  const [state, setState] = useState<PanelState>('idle')
  const [instruction, setInstruction] = useState('')
  const [model, setModel] = useState<string>(MODELS[0].value)
  const [changes, setChanges] = useState<AiChange[]>([])
  const [summary, setSummary] = useState('')
  const [usage, setUsage] = useState<UsageInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  const selectedCount = changes.filter((c) => c.selected).length

  const run = useCallback(async () => {
    const trimmed = instruction.trim()
    if (!trimmed) return

    setState('running')
    setError(null)

    try {
      const endpoint =
        channel === 'amazon'
          ? '/api/amazon/flat-file/ai-assist'
          : '/api/ebay/flat-file/ai-assist'

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instruction: trimmed,
          rows,
          columnMeta: columns.map((c) => ({ id: c.id, label: c.label, description: c.description })),
          marketplace,
          model,
        }),
      })

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }

      const data = (await res.json()) as {
        changes: FlatFileAiChange[]
        summary: string
        usage: UsageInfo
      }

      if (data.changes.length === 0) {
        setSummary(data.summary)
        setUsage(data.usage)
        setChanges([])
        setState('review')
        return
      }

      setChanges(data.changes.map((c) => ({ ...c, selected: true })))
      setSummary(data.summary)
      setUsage(data.usage)
      setState('review')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
      setState('idle')
    }
  }, [instruction, rows, columns, marketplace, model, channel])

  const apply = useCallback(() => {
    const toApply = changes.filter((c) => c.selected)
    if (toApply.length === 0) return
    onApplyChanges(toApply)
    toast({ title: `${toApply.length} cell${toApply.length !== 1 ? 's' : ''} updated`, tone: 'success' })
    setState('applied')
  }, [changes, onApplyChanges, toast])

  const reset = useCallback(() => {
    setState('idle')
    setChanges([])
    setSummary('')
    setUsage(null)
    setError(null)
  }, [])

  const toggleChange = useCallback((idx: number) => {
    setChanges((prev) => prev.map((c, i) => i === idx ? { ...c, selected: !c.selected } : c))
  }, [])

  const toggleAll = useCallback(() => {
    const allSelected = changes.every((c) => c.selected)
    setChanges((prev) => prev.map((c) => ({ ...c, selected: !allSelected })))
  }, [changes])

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full text-sm">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 dark:border-slate-700 bg-violet-50 dark:bg-violet-950/20 flex-shrink-0">
        <BrainCircuit className="w-4 h-4 text-violet-600 dark:text-violet-400 flex-shrink-0" />
        <span className="font-semibold text-slate-900 dark:text-slate-100">Claude AI Assistant</span>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5">
          <ChevronDown className="w-3 h-3 text-slate-400" />
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={state === 'running'}
            className="text-xs border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 py-0.5 px-1.5 focus:outline-none focus:ring-1 focus:ring-violet-500"
          >
            {MODELS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Context line */}
      <div className="px-4 py-2 text-xs text-slate-500 dark:text-slate-400 border-b border-slate-100 dark:border-slate-800 flex-shrink-0">
        {rows.length} rows · {channel.toUpperCase()} · {marketplace} · {columns.length} columns
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-4">
        {/* ── Idle / Error state ── */}
        {(state === 'idle' || error) && (
          <>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                What should Claude do with this flat file?
              </label>
              <textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder={`e.g. "Fill missing item_description for all jackets using the product name and brand"\n\ne.g. "Translate all titles to Italian"\n\ne.g. "Lower prices by 5% for items under €50"`}
                rows={6}
                className="w-full text-xs border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 placeholder:text-slate-400 p-3 focus:outline-none focus:ring-2 focus:ring-violet-500 resize-none"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    void run()
                  }
                }}
              />
              <p className="mt-1 text-[10px] text-slate-400">⌘↵ to run</p>
            </div>

            {error && (
              <div className="flex items-start gap-2 p-3 rounded-md bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-xs">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <Button
              onClick={() => void run()}
              disabled={!instruction.trim()}
              className="w-full bg-violet-600 hover:bg-violet-700 text-white gap-2"
              size="sm"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Run with Claude
            </Button>
          </>
        )}

        {/* ── Running state ── */}
        {state === 'running' && (
          <div className="flex flex-col items-center gap-4 py-8">
            <div className="relative">
              <div className="w-10 h-10 rounded-full bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center">
                <BrainCircuit className="w-5 h-5 text-violet-600 dark:text-violet-400" />
              </div>
              <Loader2 className="w-4 h-4 text-violet-500 animate-spin absolute -bottom-0.5 -right-0.5" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium text-slate-700 dark:text-slate-300">Claude is reading the flat file…</p>
              <p className="text-xs text-slate-400 mt-1">{rows.length} rows · {columns.length} columns</p>
            </div>
          </div>
        )}

        {/* ── Review state ── */}
        {state === 'review' && (
          <>
            <div className="rounded-md bg-violet-50 dark:bg-violet-950/20 border border-violet-200 dark:border-violet-800 p-3 text-xs text-violet-800 dark:text-violet-300">
              {summary}
            </div>

            {usage && (
              <div className="text-xs text-slate-400 flex items-center gap-2">
                <span>{usage.inputTokens + usage.outputTokens} tokens</span>
                <span>·</span>
                <span>${usage.costUSD.toFixed(4)}</span>
                <span>·</span>
                <span className="font-mono">{usage.model.split('-').slice(-2).join('-')}</span>
              </div>
            )}

            {changes.length === 0 ? (
              <div className="text-center py-6 text-slate-400">
                <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-emerald-400" />
                <p className="text-sm">No changes needed</p>
                <p className="text-xs mt-1">All rows already have the requested content.</p>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                    Proposed changes ({changes.length})
                  </span>
                  <button
                    type="button"
                    onClick={toggleAll}
                    className="text-xs text-violet-600 dark:text-violet-400 hover:underline"
                  >
                    {changes.every((c) => c.selected) ? 'Deselect all' : 'Select all'}
                  </button>
                </div>

                <div className="rounded-md border border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-800 overflow-hidden">
                  {changes.map((ch, i) => (
                    <div
                      key={i}
                      onClick={() => toggleChange(i)}
                      className={cn(
                        'flex items-start gap-2 px-3 py-2.5 cursor-pointer transition-colors text-xs',
                        ch.selected
                          ? 'bg-white dark:bg-slate-900 hover:bg-violet-50/50 dark:hover:bg-violet-950/10'
                          : 'bg-slate-50 dark:bg-slate-800/50 opacity-50 hover:opacity-70',
                      )}
                    >
                      <div className="flex-shrink-0 mt-0.5 text-violet-500">
                        {ch.selected ? <CheckSquare className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className="font-mono font-semibold text-slate-700 dark:text-slate-300 truncate">
                            {ch.sku || ch.rowId}
                          </span>
                          <span className="text-slate-400">·</span>
                          <span className="font-mono text-violet-600 dark:text-violet-400 truncate">{ch.field}</span>
                        </div>
                        {ch.oldValue != null && String(ch.oldValue) !== '' && (
                          <p className="text-slate-400 line-through truncate text-[10px] mb-0.5">
                            {String(ch.oldValue).slice(0, 80)}
                          </p>
                        )}
                        <p className="text-slate-700 dark:text-slate-200 truncate">
                          {Array.isArray(ch.newValue)
                            ? (ch.newValue as string[]).join(' • ')
                            : String(ch.newValue).slice(0, 120)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="flex items-center gap-2">
              {changes.length > 0 && (
                <Button
                  onClick={apply}
                  disabled={selectedCount === 0}
                  size="sm"
                  className="flex-1 bg-violet-600 hover:bg-violet-700 text-white"
                >
                  <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
                  Apply {selectedCount > 0 ? selectedCount : ''} change{selectedCount !== 1 ? 's' : ''}
                </Button>
              )}
              <Button onClick={reset} size="sm" variant="ghost" className="text-slate-500">
                <X className="w-3.5 h-3.5 mr-1" />
                {changes.length === 0 ? 'Close' : 'Discard'}
              </Button>
            </div>
          </>
        )}

        {/* ── Applied state ── */}
        {state === 'applied' && (
          <div className="flex flex-col items-center gap-4 py-8">
            <div className="w-12 h-12 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
              <CheckCircle2 className="w-6 h-6 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium text-slate-700 dark:text-slate-300">Changes applied</p>
              <p className="text-xs text-slate-400 mt-1">
                {selectedCount} cell{selectedCount !== 1 ? 's' : ''} updated · rows marked dirty
              </p>
            </div>
            <Button onClick={reset} size="sm" variant="secondary" className="mt-2">
              New instruction
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
