'use client'

// ── ED v2 P4b — push results, rendered VERBATIM per listing ──────────────────
// Every itemId, lane, outcome, message and warning string from the endpoint
// renders in full. PARITY MISMATCH warnings are red and impossible to miss;
// nothing is ever folded away into a bare success toast.

import { cn } from '@/lib/utils'
import { Banner } from '@/design-system/components/Banner'
import type { PushListingResult, PushResult } from './types'

const OUTCOME_CHIP: Record<PushListingResult['outcome'], string> = {
  revised: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  'dry-run': 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  'inventory-managed': 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  'skipped-empty-body': 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
}

export function PushResults({ res, themeName, at }: { res: PushResult; themeName: string; at: string }) {
  const { listings, products } = res
  const count = (o: PushListingResult['outcome']) => listings.filter((l) => l.outcome === o).length
  const revised = count('revised')
  const invManaged = count('inventory-managed')
  const emptySkipped = count('skipped-empty-body')
  const dryRun = count('dry-run')
  const failed = count('failed')
  const parityMismatches = listings.filter((l) => l.warnings.some((w) => w.includes('PARITY MISMATCH'))).length
  const listingWarnings = listings.reduce((n, l) => n + l.warnings.length, 0)
  const productIssues = products.filter((p) => p.error || p.warnings.length > 0 || p.themePersisted === false)
  const productErrors = products.filter((p) => p.error).length

  const hasProblems = failed > 0 || parityMismatches > 0 || productErrors > 0
  const clean = listings.length > 0 && revised === listings.length && listingWarnings === 0 && productIssues.length === 0
  const allDryRun = listings.length > 0 && dryRun === listings.length && productErrors === 0

  const summaryLine = `${listings.length} listing${listings.length === 1 ? '' : 's'} — ${revised} revised · ${invManaged} inventory-managed (need Full Publish) · ${emptySkipped} skipped (empty body) · ${dryRun} dry-run · ${failed} failed`

  return (
    <div className="flex flex-col gap-2" data-testid="description-push-results">
      {hasProblems ? (
        <Banner tone="danger" title={`Push finished WITH PROBLEMS — ${failed} failed · ${parityMismatches} parity mismatch${parityMismatches === 1 ? '' : 'es'} · ${productErrors} product error${productErrors === 1 ? '' : 's'}`}>
          {summaryLine}. Do not trust any listing until you have read its row below.
        </Banner>
      ) : clean ? (
        <Banner tone="success" title={`Clean push — all ${revised} listing${revised === 1 ? '' : 's'} revised, parity verified`}>
          {summaryLine}
        </Banner>
      ) : allDryRun ? (
        <Banner tone="info" title="Dry run — nothing was sent to eBay">
          NEXUS_EBAY_REAL_API is not enabled, so every revise was skipped. {summaryLine}
        </Banner>
      ) : (
        <Banner tone="warning" title="Partial push — not every listing was revised">
          {summaryLine}. Every skipped or warned listing is listed below with the exact reason.
        </Banner>
      )}
      <p className="text-[10px] text-slate-400">
        Pushed at {at} · theme "{themeName}" · market {res.marketplace}
      </p>

      {productIssues.length > 0 && (
        <div className="rounded border border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/20 px-2 py-1.5 flex flex-col gap-1">
          <p className="text-[11px] font-semibold text-amber-800 dark:text-amber-300">Per-product notes ({productIssues.length})</p>
          {productIssues.map((p) => (
            <div key={p.productId} className="flex flex-col gap-0.5">
              <p className="text-[11px] font-medium text-slate-700 dark:text-slate-200">
                {p.parentSku ?? p.productId} — {p.listings} listing{p.listings === 1 ? '' : 's'}
                {p.themePersisted === false ? ' · theme NOT persisted' : ''}
              </p>
              {p.error && <p className="text-[11px] text-red-600 dark:text-red-400 whitespace-pre-wrap">✗ {p.error}</p>}
              {p.warnings.map((w, i) => (
                <p key={i} className="text-[11px] text-amber-700 dark:text-amber-300 whitespace-pre-wrap">⚠ {w}</p>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        {listings.map((l) => {
          const parity = l.warnings.some((w) => w.includes('PARITY MISMATCH'))
          const rowBorder = l.outcome === 'failed' || parity
            ? 'border-red-300 dark:border-red-800'
            : l.warnings.length > 0 || l.outcome === 'skipped-empty-body'
              ? 'border-amber-300 dark:border-amber-800'
              : 'border-slate-200 dark:border-slate-700'
          return (
            <div key={l.itemId} className={cn('rounded border bg-white dark:bg-slate-900 px-2 py-1.5 flex flex-col gap-1', rowBorder)}>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-xs font-semibold text-slate-900 dark:text-slate-100">{l.itemId}</span>
                <span className="text-[11px] text-slate-500 dark:text-slate-400">{l.parentSku}</span>
                <span className="text-[9px] uppercase px-1 rounded bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">{l.lane}</span>
                <span className={cn('text-[9px] uppercase px-1 rounded font-semibold', OUTCOME_CHIP[l.outcome])}>{l.outcome}</span>
                {l.themed
                  ? <span className="text-[9px] px-1 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">theme: {l.themeName ?? 'themed'}</span>
                  : l.outcome !== 'inventory-managed' && (
                    <span className="text-[9px] px-1 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">raw body (no theme)</span>
                  )}
                {l.bodySource && (
                  <span className="text-[9px] px-1 rounded bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                    title="Where the body copy came from: the listing's own saved membership row, or the family parent's per-market content">
                    body: {l.bodySource === 'membership' ? "listing's own" : 'family parent'}
                  </span>
                )}
              </div>
              {l.message && (
                <p className={cn('text-[11px] whitespace-pre-wrap', l.outcome === 'failed' ? 'font-medium text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400')}>
                  {l.message}
                </p>
              )}
              {l.warnings.map((w, i) => (
                <p key={i} className={cn('text-[11px] whitespace-pre-wrap rounded border px-2 py-1',
                  w.includes('PARITY MISMATCH')
                    ? 'font-semibold bg-red-50 dark:bg-red-950/40 border-red-300 dark:border-red-800 text-red-700 dark:text-red-300'
                    : 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300')}>
                  ⚠ {w}
                </p>
              ))}
            </div>
          )
        })}
        {listings.length === 0 && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            No live listings were found for the selected products — nothing was revised. The per-product notes above say why.
          </p>
        )}
      </div>
    </div>
  )
}
