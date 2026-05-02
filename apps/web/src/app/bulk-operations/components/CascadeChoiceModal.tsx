'use client'

import { useEffect, useRef, useState } from 'react'
import { X, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'

interface ChildPreview {
  id: string
  sku: string
}

export interface CascadeChoiceProps {
  open: boolean
  fieldLabel: string
  oldValue: unknown
  newValue: unknown
  parentSku: string
  children: ChildPreview[]
  onApply: (cascade: boolean) => void
  onCancel: () => void
}

const LARGE_CASCADE_THRESHOLD = 50
const CONFIRM_TOKEN = 'CASCADE'

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  return String(v)
}

export default function CascadeChoiceModal({
  open,
  fieldLabel,
  oldValue,
  newValue,
  parentSku,
  children,
  onApply,
  onCancel,
}: CascadeChoiceProps) {
  const [cascade, setCascade] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [confirmStep, setConfirmStep] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const applyRef = useRef<HTMLButtonElement>(null)

  // Reset when opened with a new edit
  useEffect(() => {
    if (open) {
      setCascade(false)
      setShowAll(false)
      setConfirmStep(false)
      setConfirmText('')
    }
  }, [open, fieldLabel, parentSku])

  // Focus the Apply button on open for keyboard accessibility
  useEffect(() => {
    if (!open) return
    requestAnimationFrame(() => applyRef.current?.focus())
  }, [open])

  // Esc to cancel, Enter to apply (when valid)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      } else if (e.key === 'Enter' && (e.target as HTMLElement)?.tagName !== 'INPUT') {
        // Enter only applies if not typing in the confirm input
        e.preventDefault()
        triggerApply()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cascade, confirmStep, confirmText])

  if (!open) return null

  const childCount = children.length
  const requiresConfirmation = cascade && childCount > LARGE_CASCADE_THRESHOLD
  const visibleChildren = showAll ? children : children.slice(0, 5)

  function triggerApply() {
    if (!cascade) {
      onApply(false)
      return
    }
    if (requiresConfirmation) {
      if (!confirmStep) {
        setConfirmStep(true)
        return
      }
      if (confirmText !== CONFIRM_TOKEN) return
      onApply(true)
      return
    }
    onApply(true)
  }

  return (
    <div
      className="fixed inset-0 bg-slate-900/40 backdrop-blur-[1px] z-50 flex items-center justify-center p-6"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label="Apply change to"
    >
      <div
        className="bg-white rounded-lg shadow-2xl border border-slate-200 w-full max-w-[520px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 flex-shrink-0">
          <h2 className="text-[15px] font-semibold text-slate-900">
            {confirmStep ? 'Confirm large cascade' : 'Apply change to'}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            className="p-1 rounded hover:bg-slate-100 text-slate-500 hover:text-slate-900"
            aria-label="Cancel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {!confirmStep ? (
          <>
            <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">
              {/* Field summary */}
              <dl className="space-y-1.5 text-[13px]">
                <div className="flex gap-3">
                  <dt className="text-slate-500 w-16 flex-shrink-0">Field</dt>
                  <dd className="text-slate-900 font-medium">{fieldLabel}</dd>
                </div>
                <div className="flex gap-3">
                  <dt className="text-slate-500 w-16 flex-shrink-0">Was</dt>
                  <dd className="text-slate-500 line-through truncate">
                    {formatValue(oldValue)}
                  </dd>
                </div>
                <div className="flex gap-3">
                  <dt className="text-slate-500 w-16 flex-shrink-0">New</dt>
                  <dd className="text-slate-900 font-medium truncate">
                    {formatValue(newValue)}
                  </dd>
                </div>
              </dl>

              {/* Choice */}
              <fieldset className="space-y-2">
                <legend className="sr-only">Apply to</legend>
                <Choice
                  selected={!cascade}
                  onSelect={() => setCascade(false)}
                  title="This product only"
                  subtitle={`Updates ${parentSku} only. Children keep their current value.`}
                />
                <Choice
                  selected={cascade}
                  onSelect={() => setCascade(true)}
                  title={`This product + ${childCount} ${
                    childCount === 1 ? 'child' : 'children'
                  }`}
                  subtitle={
                    childCount === 0
                      ? 'No children to cascade to.'
                      : `Updates ${parentSku} and all ${childCount} variants.`
                  }
                  disabled={childCount === 0}
                />
              </fieldset>

              {/* Child preview */}
              {cascade && childCount > 0 && (
                <div className="border border-slate-200 rounded-md p-3 bg-slate-50">
                  <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                    Will update {childCount} {childCount === 1 ? 'child' : 'children'}
                  </div>
                  <ul className="text-[12px] font-mono text-slate-700 space-y-0.5 max-h-32 overflow-y-auto">
                    {visibleChildren.map((c) => (
                      <li key={c.id} className="truncate">
                        · {c.sku}
                      </li>
                    ))}
                  </ul>
                  {!showAll && childCount > 5 && (
                    <button
                      type="button"
                      onClick={() => setShowAll(true)}
                      className="mt-2 text-[11px] text-blue-600 hover:underline"
                    >
                      Show all {childCount}
                    </button>
                  )}
                </div>
              )}

              {childCount > LARGE_CASCADE_THRESHOLD && cascade && (
                <div className="flex items-start gap-2 text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                  <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  <span>
                    This is a large cascade. You'll be asked to type{' '}
                    <code className="px-1 bg-amber-100 rounded font-mono">
                      {CONFIRM_TOKEN}
                    </code>{' '}
                    to confirm.
                  </span>
                </div>
              )}
            </div>

            <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-end gap-2 flex-shrink-0">
              <Button variant="secondary" size="sm" onClick={onCancel}>
                Cancel
              </Button>
              <Button
                ref={applyRef}
                variant="primary"
                size="sm"
                onClick={triggerApply}
                disabled={cascade && childCount === 0}
              >
                Apply
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="overflow-y-auto flex-1 px-5 py-4 space-y-3">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg bg-amber-50 border border-amber-200 flex items-center justify-center flex-shrink-0">
                  <AlertTriangle className="w-4 h-4 text-amber-600" />
                </div>
                <div className="text-[13px] text-slate-700">
                  This will update <strong>{fieldLabel}</strong> on{' '}
                  <strong className="tabular-nums">{1 + childCount}</strong> products:
                  <ul className="mt-1.5 ml-4 list-disc text-[12px] text-slate-600 space-y-0.5">
                    <li>{parentSku} (parent)</li>
                    <li>
                      All {childCount} {childCount === 1 ? 'child' : 'children'}
                    </li>
                  </ul>
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-[12px] font-medium text-slate-700 block">
                  Type{' '}
                  <code className="px-1 bg-slate-100 rounded font-mono text-slate-900">
                    {CONFIRM_TOKEN}
                  </code>{' '}
                  to confirm:
                </label>
                <input
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder={CONFIRM_TOKEN}
                  className={cn(
                    'w-full h-8 px-3 text-[13px] font-mono border rounded',
                    'focus:outline-none focus:ring-2 focus:ring-blue-500/20',
                    confirmText === CONFIRM_TOKEN
                      ? 'border-green-400 focus:border-green-500'
                      : 'border-slate-200 focus:border-blue-500'
                  )}
                  autoFocus
                />
              </div>
            </div>
            <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-end gap-2 flex-shrink-0">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setConfirmStep(false)}
              >
                Back
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={triggerApply}
                disabled={confirmText !== CONFIRM_TOKEN}
              >
                Confirm Cascade
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Choice({
  selected,
  onSelect,
  title,
  subtitle,
  disabled,
}: {
  selected: boolean
  onSelect: () => void
  title: string
  subtitle: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onSelect()}
      disabled={disabled}
      className={cn(
        'w-full flex items-start gap-2.5 px-3 py-2.5 rounded-md border text-left transition-colors',
        selected
          ? 'bg-blue-50 border-blue-300 ring-1 ring-blue-300'
          : 'bg-white border-slate-200 hover:bg-slate-50',
        disabled && 'opacity-50 cursor-not-allowed'
      )}
    >
      <span
        className={cn(
          'mt-0.5 w-3.5 h-3.5 rounded-full border flex-shrink-0 flex items-center justify-center',
          selected ? 'border-blue-600 bg-blue-600' : 'border-slate-300'
        )}
      >
        {selected && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-slate-900">{title}</span>
        <span className="block text-[11px] text-slate-500 mt-0.5">{subtitle}</span>
      </span>
    </button>
  )
}
