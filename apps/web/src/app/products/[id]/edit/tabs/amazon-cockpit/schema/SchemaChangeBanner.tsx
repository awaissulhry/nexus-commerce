'use client'

// CX.7 — Schema change banner.
//
// Shown inside AmazonCockpit when useSchemaChangeDetector detects that
// the flat-file manifest has new or removed REQUIRED/RECOMMENDED fields
// since the operator last visited. Prompts them to review and dismiss.

import { AlertTriangle, X, ChevronDown } from 'lucide-react'

interface Props {
  productType: string
  marketplace: string
  newFields: string[]
  removedFields: string[]
  onDismiss: () => void
  onReview: () => void
}

export default function SchemaChangeBanner({
  productType,
  marketplace,
  newFields,
  removedFields,
  onDismiss,
  onReview,
}: Props) {
  const totalChanges = newFields.length + removedFields.length
  if (totalChanges === 0) return null

  return (
    <div
      role="alert"
      className="flex items-start gap-3 px-4 py-3 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-[12px]"
    >
      <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" aria-hidden />
      <div className="flex-1 min-w-0">
        <span className="font-semibold text-amber-900 dark:text-amber-200">
          Amazon updated the {productType} schema for {marketplace}.
        </span>
        {newFields.length > 0 && (
          <span className="text-amber-800 dark:text-amber-300 ml-1">
            {newFields.length} new field{newFields.length > 1 ? 's' : ''}
            {newFields.length <= 3 ? ': ' + newFields.join(', ') : ''}.
          </span>
        )}
        {removedFields.length > 0 && (
          <span className="text-amber-800 dark:text-amber-300 ml-1">
            {removedFields.length} field{removedFields.length > 1 ? 's' : ''} removed.
          </span>
        )}
        <div className="mt-1.5 flex items-center gap-2">
          <button
            type="button"
            onClick={onReview}
            className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300 font-medium hover:text-amber-900 dark:hover:text-amber-100 underline underline-offset-2"
          >
            <ChevronDown className="w-3 h-3" aria-hidden /> Review fields
          </button>
          <span className="text-amber-400">·</span>
          <button
            type="button"
            onClick={onDismiss}
            className="text-amber-600 dark:text-amber-400 hover:text-amber-900 dark:hover:text-amber-100"
          >
            Mark as reviewed
          </button>
        </div>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss schema change notice"
        className="text-amber-500 hover:text-amber-800 dark:hover:text-amber-200 shrink-0"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  )
}
