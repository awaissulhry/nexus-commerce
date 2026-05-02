'use client'

import { useEffect } from 'react'
import { AlertCircle, ClipboardPaste, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'

export interface PasteCell {
  rowIdx: number
  colIdx: number
  rowId: string
  columnId: string
  oldValue: unknown
  newValue: unknown
  sku: string
  fieldLabel: string
}

export interface PasteError {
  rowIdx: number
  colIdx: number
  sku: string
  fieldLabel: string
  reason: string
}

export interface PastePreview {
  plan: PasteCell[]
  errors: PasteError[]
}

interface Props {
  preview: PastePreview | null
  onCancel: () => void
  onApply: () => void
}

const PREVIEW_LIMIT = 6

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  return String(value)
}

export default function PastePreviewModal({ preview, onCancel, onApply }: Props) {
  useEffect(() => {
    if (!preview) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        onApply()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview, onCancel, onApply])

  if (!preview) return null

  const { plan, errors } = preview
  const hasChanges = plan.length > 0
  const previewItems = plan.slice(0, PREVIEW_LIMIT)
  const hiddenCount = plan.length - previewItems.length

  return (
    <div
      className="fixed inset-0 bg-slate-900/40 backdrop-blur-[1px] z-50 flex items-center justify-center p-6"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label="Paste preview"
    >
      <div
        className="bg-white rounded-lg shadow-2xl border border-slate-200 w-full max-w-3xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ClipboardPaste className="w-4 h-4 text-slate-500" />
            <h2 className="text-[14px] font-semibold text-slate-900">
              Paste preview
            </h2>
            <span className="text-[12px] text-slate-500 tabular-nums">
              {plan.length} change{plan.length === 1 ? '' : 's'}
              {errors.length > 0 && ` · ${errors.length} skipped`}
            </span>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-slate-400 hover:text-slate-700 rounded p-1 hover:bg-slate-100"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-3">
          {hasChanges ? (
            <div>
              <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-2">
                Changes
              </div>
              <ul className="divide-y divide-slate-100 border border-slate-200 rounded-md bg-slate-50/50">
                {previewItems.map((c) => (
                  <li
                    key={`${c.rowId}:${c.columnId}`}
                    className="px-3 py-1.5 flex items-center gap-2 text-[12px]"
                  >
                    <span className="font-mono text-slate-500 truncate max-w-[180px]">
                      {c.sku}
                    </span>
                    <span className="text-slate-700">{c.fieldLabel}:</span>
                    <span className="text-slate-400 line-through tabular-nums">
                      {formatValue(c.oldValue)}
                    </span>
                    <span className="text-slate-400">→</span>
                    <span className="bg-yellow-100 text-yellow-900 px-1.5 py-0.5 rounded tabular-nums">
                      {formatValue(c.newValue)}
                    </span>
                  </li>
                ))}
              </ul>
              {hiddenCount > 0 && (
                <div className="mt-1 text-[11px] text-slate-500">
                  + {hiddenCount} more
                </div>
              )}
            </div>
          ) : (
            <div className="text-[12px] text-slate-500 italic">
              Nothing applicable to paste.
            </div>
          )}

          {errors.length > 0 && (
            <div>
              <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <AlertCircle className="w-3 h-3 text-amber-600" />
                Skipped ({errors.length})
              </div>
              <ul className="divide-y divide-slate-100 border border-amber-200 rounded-md bg-amber-50/40">
                {errors.slice(0, PREVIEW_LIMIT).map((e, i) => (
                  <li
                    key={`${e.rowIdx}:${e.colIdx}:${i}`}
                    className="px-3 py-1.5 flex items-center gap-2 text-[12px]"
                  >
                    <span className="font-mono text-slate-500 truncate max-w-[180px]">
                      {e.sku}
                    </span>
                    <span className="text-slate-700">{e.fieldLabel}:</span>
                    <span className="text-amber-700">{e.reason}</span>
                  </li>
                ))}
              </ul>
              {errors.length > PREVIEW_LIMIT && (
                <div className="mt-1 text-[11px] text-slate-500">
                  + {errors.length - PREVIEW_LIMIT} more
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={onApply}
            disabled={!hasChanges}
          >
            Apply paste
          </Button>
        </div>
      </div>
    </div>
  )
}
