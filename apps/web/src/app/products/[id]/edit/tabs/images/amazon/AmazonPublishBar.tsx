'use client'

// IM.4 — Amazon publish controls and feed status strip.

import { useState } from 'react'
import { AlertTriangle, ChevronDown, CheckCircle2, Loader2, Clock, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import type { AmazonMarketplace } from './useAmazonImages'
import { AMAZON_MARKETPLACES } from './useAmazonImages'

interface FeedJobStatus {
  jobId: string
  marketplace: string
  status: string
  submittedAt: string
  completedAt?: string | null
  errorMessage?: string | null
  skuCount: number
}

interface Props {
  activeMarketplace: AmazonMarketplace
  publishing: boolean
  publishingAll: boolean
  publishError: string | null
  feedJobs: FeedJobStatus[]
  dirtyCount: number
  onPublish: (marketplace: AmazonMarketplace) => void
  onPublishAll: () => void
  onExportZip: (marketplace: AmazonMarketplace) => void
  isExporting: boolean
  exportProgress?: { market: string; index: number; total: number } | null
  // IA.2 — Open the pre-publish preview modal for a given marketplace.
  onPreview?: (marketplace: AmazonMarketplace) => void
  // PB.9 — Open the rollback modal for the active marketplace.
  onOpenRollback?: (marketplace: AmazonMarketplace) => void
}

const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Queued',
  SUBMITTING: 'Submitting…',
  IN_QUEUE: 'Queued on Amazon',
  IN_PROGRESS: 'Processing…',
  DONE: 'Done',
  FATAL: 'Failed',
  CANCELLED: 'Cancelled',
}

function elapsed(from: string): string {
  const ms = Date.now() - new Date(from).getTime()
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h ago`
}

export default function AmazonPublishBar({
  activeMarketplace,
  publishing,
  publishingAll,
  publishError,
  feedJobs,
  dirtyCount,
  onPublish,
  onPublishAll,
  onExportZip,
  isExporting,
  exportProgress,
  onPreview,
  onOpenRollback,
}: Props) {
  const [zipMenuOpen, setZipMenuOpen] = useState(false)

  const recentJobs = feedJobs.slice(0, 3)
  return (
    <div
      data-publish-anchor
      className="sticky bottom-0 z-10 bg-white dark:bg-slate-900 rounded-b-xl border-t border-default dark:border-slate-700 shadow-[0_-2px_8px_-2px_rgba(0,0,0,0.08)] dark:shadow-[0_-2px_8px_-2px_rgba(0,0,0,0.5)] px-4 pt-3 pb-2 space-y-3"
    >
      {/* Publish buttons row */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400 mr-1">Publish:</span>

        {AMAZON_MARKETPLACES.map((mkt) => (
          <Button
            key={mkt}
            size="sm"
            variant={activeMarketplace === mkt ? 'primary' : 'ghost'}
            onClick={() => onPublish(mkt)}
            disabled={publishing || publishingAll}
            className={cn(
              'text-xs gap-1',
              activeMarketplace !== mkt && 'border border-default dark:border-slate-700',
            )}
          >
            {publishing && activeMarketplace === mkt
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : null}
            {mkt}
          </Button>
        ))}

        <Button
          size="sm"
          onClick={onPublishAll}
          disabled={publishing || publishingAll}
          className="text-xs gap-1 ml-1"
        >
          {publishingAll ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
          Publish all markets
        </Button>

        {/* IA.2 — Pre-publish preview. Only relevant when a specific
            marketplace is active; "All Markets" routes to per-market
            preview from the table. */}
        {onPreview && activeMarketplace !== 'ALL' && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onPreview(activeMarketplace)}
            disabled={publishing || publishingAll}
            className="text-xs gap-1 ml-1 border border-default dark:border-slate-700"
            title="Preview what will publish before submitting"
          >
            Preview
          </Button>
        )}

        {/* PB.9 — Revert to last published. Only relevant for a specific
            market — snapshots are captured per-marketplace. */}
        {onOpenRollback && activeMarketplace !== 'ALL' && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onOpenRollback(activeMarketplace)}
            disabled={publishing || publishingAll}
            className="text-xs gap-1 ml-1 border border-default dark:border-slate-700"
            title={`Revert images on Amazon ${activeMarketplace} to the last successful publish (per-browser snapshot)`}
          >
            <RotateCcw className="w-3 h-3" />
            Revert
          </Button>
        )}

        {/* ZIP fallback */}
        <div className="relative ml-auto">
          <button
            type="button"
            onClick={() => { if (!isExporting) setZipMenuOpen((p) => !p) }}
            disabled={isExporting}
            className="flex items-center gap-1 text-xs text-tertiary hover:text-slate-600 dark:hover:text-slate-300 px-2 py-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isExporting ? <Loader2 className="w-3 h-3 animate-spin" /> : '···'}
            {isExporting
              ? (exportProgress
                  ? (exportProgress.market === 'Packaging'
                      ? 'Packaging…'
                      : `Exporting ${exportProgress.market} (${exportProgress.index}/${exportProgress.total})…`)
                  : 'Exporting…')
              : 'Export ZIP'}
            {!isExporting && <ChevronDown className="w-3 h-3" />}
          </button>
          {zipMenuOpen && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setZipMenuOpen(false)} />
              <div className="absolute right-0 bottom-8 z-30 bg-white dark:bg-slate-800 border border-default dark:border-slate-700 rounded-xl shadow-xl py-1 min-w-[220px] text-sm">
                {AMAZON_MARKETPLACES.map((mkt) => (
                  <button
                    key={mkt}
                    className="w-full text-left px-3 py-1.5 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700"
                    onClick={() => { setZipMenuOpen(false); onExportZip(mkt) }}
                  >
                    Amazon {mkt} ZIP
                  </button>
                ))}
                {/* IA.1 — all-markets ZIP (per-market subfolders). */}
                <div className="h-px bg-slate-100 dark:bg-slate-700 my-1" />
                <button
                  className="w-full text-left px-3 py-1.5 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/30 font-medium"
                  onClick={() => { setZipMenuOpen(false); onExportZip('ALL' as AmazonMarketplace) }}
                >
                  All markets (one ZIP per market)
                </button>
                {/* IA.7 — filename convention reference. The toggle
                    itself lives in the dev-doc until the operator
                    asks for SKU-named exports; default ASIN matches
                    Amazon's bulk-upload spec. */}
                <div className="h-px bg-slate-100 dark:bg-slate-700 my-1" />
                <div className="px-3 py-1.5 text-[10px] text-tertiary leading-tight">
                  Filename: <span className="font-mono">{'{ASIN}.{SLOT}.jpg'}</span> · per Amazon spec
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Dirty warning */}
      {dirtyCount > 0 && (
        <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          {dirtyCount} unsaved change{dirtyCount === 1 ? '' : 's'} — save before publishing
        </div>
      )}

      {/* Publish error */}
      {publishError && (
        <div className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
          <AlertTriangle className="w-3.5 h-3.5" /> {publishError}
        </div>
      )}

      {/* Feed job status */}
      {recentJobs.length > 0 && (
        <div className="space-y-1.5">
          {recentJobs.map((job) => (
            <div key={job.jobId} className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              {['DONE'].includes(job.status) ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
              ) : ['FATAL', 'CANCELLED'].includes(job.status) ? (
                <AlertTriangle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />
              ) : (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-500 flex-shrink-0" />
              )}
              <span className="font-mono">Amazon {job.marketplace}</span>
              <span>—</span>
              <span>{STATUS_LABEL[job.status] ?? job.status}</span>
              {job.skuCount > 0 && <span>({job.skuCount} SKU{job.skuCount === 1 ? '' : 's'})</span>}
              <span className="ml-auto flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {elapsed(job.submittedAt)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
