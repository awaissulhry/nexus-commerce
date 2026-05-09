'use client'

import { useEffect, useRef, useState } from 'react'
import { Plus, Trash2, X, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  OP_LABELS,
  TONE_LABELS,
  TONE_CLASSES,
  type ConditionalRule,
  type RuleOp,
  type RuleTone,
} from '../lib/conditional-format'

/**
 * W4.2 — Conditional formatting rule editor.
 *
 * Floating panel that mirrors FindReplaceBar's positioning + open/
 * close contract. Each rule row exposes column / op / value / tone /
 * enabled — the parent owns the rule list state, this component is
 * a controlled editor that emits the next list on every change.
 *
 * Operators discover the surface via a "Rules" toolbar button; the
 * panel opens to a single starter rule when there are no rules yet
 * so adding the first one is one form-fill, not "click Add then
 * fill". Deleting the last rule keeps the panel open with a fresh
 * starter so the operator never sees an empty editor.
 */

export interface ConditionalFormatBarProps {
  open: boolean
  onClose: () => void
  rules: ConditionalRule[]
  onChange: (next: ConditionalRule[]) => void
  visibleColumns: Array<{ id: string; label: string }>
}

const ALL_OPS: RuleOp[] = [
  'lt',
  'lte',
  'gt',
  'gte',
  'eq',
  'neq',
  'contains',
  'startsWith',
  'endsWith',
  'empty',
  'notEmpty',
]
const ALL_TONES: RuleTone[] = ['red', 'amber', 'green', 'blue', 'slate']

function makeRule(columnId: string): ConditionalRule {
  return {
    id: `cf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    columnId,
    op: 'lt',
    value: 0,
    tone: 'red',
    enabled: true,
  }
}

export function ConditionalFormatBar(props: ConditionalFormatBarProps) {
  const { open, onClose, rules, onChange, visibleColumns } = props
  const panelRef = useRef<HTMLDivElement>(null)
  const [pendingFocus, setPendingFocus] = useState(false)

  // Focus first input on open so operators can start typing the
  // threshold straight away.
  useEffect(() => {
    if (open && pendingFocus) {
      const first = panelRef.current?.querySelector(
        'input[type="text"], input[type="number"], select',
      ) as HTMLElement | null
      first?.focus()
      setPendingFocus(false)
    }
  }, [open, pendingFocus])

  if (!open) return null

  const seedColumn = visibleColumns[0]?.id ?? ''
  const list = rules.length === 0 ? [makeRule(seedColumn)] : rules

  const update = (id: string, patch: Partial<ConditionalRule>) => {
    onChange(list.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }
  const add = () => {
    onChange([...list, makeRule(seedColumn)])
    setPendingFocus(true)
  }
  const remove = (id: string) => {
    const next = list.filter((r) => r.id !== id)
    onChange(next)
  }

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Conditional formatting rules"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        }
      }}
      className="absolute right-3 top-3 z-20 w-[640px] bg-white border border-slate-200 rounded-lg shadow-lg p-3 space-y-2"
    >
      <div className="flex items-center justify-between">
        <div className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-700">
          <Sparkles className="w-3.5 h-3.5 text-amber-500" />
          Conditional formatting
          <span className="text-xs font-normal text-slate-500 tabular-nums">
            ({rules.filter((r) => r.enabled).length} active /
            {' '}
            {rules.length} total)
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="h-7 w-7 inline-flex items-center justify-center text-slate-600 hover:bg-slate-100 rounded"
          aria-label="Close"
          title="Close (Esc)"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="space-y-1.5">
        {list.map((rule) => {
          const showValueInput = rule.op !== 'empty' && rule.op !== 'notEmpty'
          return (
            <div
              key={rule.id}
              className={cn(
                'flex items-center gap-1.5 p-1.5 rounded border',
                rule.enabled
                  ? 'border-slate-200 bg-white'
                  : 'border-slate-100 bg-slate-50/50 opacity-70',
              )}
            >
              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={(e) => update(rule.id, { enabled: e.target.checked })}
                aria-label="Enable rule"
              />
              {/* Column dropdown */}
              <select
                value={rule.columnId}
                onChange={(e) => update(rule.id, { columnId: e.target.value })}
                className="h-7 px-1.5 text-xs border border-slate-200 rounded bg-white max-w-[140px]"
              >
                {visibleColumns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
              {/* Op dropdown */}
              <select
                value={rule.op}
                onChange={(e) =>
                  update(rule.id, { op: e.target.value as RuleOp })
                }
                className="h-7 px-1.5 text-xs border border-slate-200 rounded bg-white"
              >
                {ALL_OPS.map((op) => (
                  <option key={op} value={op}>
                    {OP_LABELS[op]}
                  </option>
                ))}
              </select>
              {/* Value input — hidden for empty / notEmpty */}
              {showValueInput && (
                <input
                  type="text"
                  value={
                    rule.value === null || rule.value === undefined
                      ? ''
                      : String(rule.value)
                  }
                  onChange={(e) => update(rule.id, { value: e.target.value })}
                  placeholder="value"
                  className="flex-1 h-7 px-2 text-xs border border-slate-200 rounded outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                />
              )}
              {!showValueInput && <div className="flex-1" />}
              {/* Tone picker — small swatch buttons */}
              <div className="flex items-center gap-0.5">
                {ALL_TONES.map((tone) => (
                  <button
                    key={tone}
                    type="button"
                    onClick={() => update(rule.id, { tone })}
                    className={cn(
                      'h-5 w-5 rounded border-2 transition-transform',
                      rule.tone === tone
                        ? 'border-slate-700 scale-110'
                        : 'border-slate-200 hover:border-slate-400',
                      TONE_CLASSES[tone],
                    )}
                    aria-label={`Tone ${TONE_LABELS[tone]}`}
                    title={TONE_LABELS[tone]}
                  />
                ))}
              </div>
              <button
                type="button"
                onClick={() => remove(rule.id)}
                className="h-7 w-7 inline-flex items-center justify-center text-slate-500 hover:text-red-600 hover:bg-red-50 rounded"
                aria-label="Delete rule"
                title="Delete rule"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )
        })}
      </div>

      <div className="flex items-center justify-between pt-1">
        <button
          type="button"
          onClick={add}
          className="inline-flex items-center gap-1 px-2 h-7 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-50"
        >
          <Plus className="w-3 h-3" />
          Add rule
        </button>
        <span className="text-xs text-slate-500">
          First match wins · ops: {OP_LABELS.lt}/{OP_LABELS.gt}/{OP_LABELS.eq}/contains/empty/…
        </span>
      </div>
    </div>
  )
}
