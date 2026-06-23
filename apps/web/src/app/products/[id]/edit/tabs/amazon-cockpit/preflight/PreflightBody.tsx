'use client'

// ALA Phase 8 — shared renderers for the Pre-Flight report (used by both the
// in-cockpit PreflightPanel and the Review-and-Confirm modal). Styling mirrors
// SuppressionCard's cockpit-native conventions for pixel consistency.

import { cn } from '@/lib/utils'
import {
  AlertOctagon,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
} from 'lucide-react'
import {
  SOURCE_LABEL,
  FIELD_LABEL,
  type PreflightIssueItem,
  type PreflightDiffItem,
  type PreflightListingReport,
} from './types'

/** Small neutral tag naming the detector an issue came from. */
function SourceTag({ source }: { source: PreflightIssueItem['source'] }) {
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-[9.5px] font-semibold uppercase tracking-wide">
      {SOURCE_LABEL[source]}
    </span>
  )
}

function IssueRow({ issue }: { issue: PreflightIssueItem }) {
  const isErr = issue.severity === 'error'
  return (
    <li className="rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-900 p-2">
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className={cn(
            'w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0',
            isErr ? 'bg-rose-500' : 'bg-amber-400',
          )}
        />
        <div className="min-w-0 flex-1 leading-snug">
          <div className="text-[12px] font-medium text-slate-900 dark:text-slate-100">
            {issue.message}
          </div>
          <div className="mt-1 flex items-center gap-2 flex-wrap">
            <SourceTag source={issue.source} />
            {issue.field && (
              <span className="font-mono text-[10px] text-slate-500 dark:text-slate-400">
                {issue.field}
              </span>
            )}
            {issue.code && (
              <span className="font-mono text-[10px] text-tertiary dark:text-slate-500">
                {issue.code}
              </span>
            )}
          </div>
        </div>
      </div>
    </li>
  )
}

/** Severity-grouped issue list: errors first, then warnings. */
export function PreflightIssues({ report }: { report: PreflightListingReport }) {
  const errors = report.issues.filter((i) => i.severity === 'error')
  const warnings = report.issues.filter((i) => i.severity === 'warning')

  if (errors.length === 0 && warnings.length === 0) {
    return (
      <div className="text-[11.5px] text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1.5">
        <CheckCircle2 className="w-3.5 h-3.5" />
        No issues — ready to publish on {report.marketplace}.
      </div>
    )
  }

  return (
    <div className="space-y-2.5">
      {errors.length > 0 && (
        <div className="space-y-1.5">
          <div className="inline-flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-400">
            <AlertOctagon className="w-3.5 h-3.5" />
            {errors.length} error{errors.length === 1 ? '' : 's'}
          </div>
          <ul className="space-y-1.5">
            {errors.map((i, n) => (
              <IssueRow key={`e${n}`} issue={i} />
            ))}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="space-y-1.5">
          <div className="inline-flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
            <AlertTriangle className="w-3.5 h-3.5" />
            {warnings.length} warning{warnings.length === 1 ? '' : 's'}
          </div>
          <ul className="space-y-1.5">
            {warnings.map((i, n) => (
              <IssueRow key={`w${n}`} issue={i} />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function DiffRow({ item }: { item: PreflightDiffItem }) {
  return (
    <div className="flex items-center gap-2 text-[11.5px] py-0.5">
      <span className="w-20 flex-shrink-0 text-slate-500 dark:text-slate-400">
        {FIELD_LABEL[item.field] ?? item.field}
      </span>
      <span
        className={cn(
          'truncate',
          item.changed
            ? 'text-tertiary dark:text-slate-500 line-through'
            : 'text-slate-600 dark:text-slate-300',
        )}
      >
        {item.live ?? '—'}
      </span>
      {item.changed && (
        <>
          <ArrowRight className="w-3 h-3 flex-shrink-0 text-tertiary dark:text-slate-500" />
          <span className="truncate font-medium text-slate-900 dark:text-slate-100">
            {item.pending ?? '—'}
          </span>
        </>
      )}
    </div>
  )
}

/** Per-attribute diff of pending edits vs live Amazon state. */
export function PreflightDiff({ report }: { report: PreflightListingReport }) {
  const changed = report.diff.filter((d) => d.changed)
  if (report.diff.length === 0) return null
  return (
    <div className="pt-2 border-t border-subtle dark:border-slate-800 space-y-0.5">
      <div className="text-[10.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Changes vs live{changed.length === 0 ? ' — none' : ` (${changed.length})`}
      </div>
      {report.diff.map((d, n) => (
        <DiffRow key={n} item={d} />
      ))}
    </div>
  )
}
