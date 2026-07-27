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
  // Amber, not slate: this one needs the operator to DO something. Slate read
  // as "nothing to see here" next to the emerald successes.
  'inventory-managed': 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  'skipped-empty-body': 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
}

/** Plain-language row headline for the one outcome that needs an operator
 *  action. The server's own message still renders verbatim underneath — the
 *  Studio never replaces the API's words, it explains them. */
const LANE_A_EXPLAINER =
  'Skipped on purpose — this listing is published through eBay\'s Inventory API, and eBay rejects description-only revises on those. Nothing was sent, and nothing on the listing changed.'

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
  /** Families whose listings were handed off to Full Publish — named, so the
   *  operator knows exactly which ones still need doing. */
  const invManagedFamilies = [
    ...new Set(listings.filter((l) => l.outcome === 'inventory-managed').map((l) => l.parentSku)),
  ]

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
        <Banner
          tone="warning"
          title={
            // When the ONLY shortfall is the Inventory-API handoff, say so:
            // "not every listing was revised" reads like a fault, and this
            // isn't one — it's a listing that needs a different push.
            revised + invManaged === listings.length && invManaged > 0 && listingWarnings === 0 && productErrors === 0
              ? `${revised} revised · ${invManaged} need${invManaged === 1 ? 's' : ''} a Full Publish (not a failure)`
              : 'Partial push — not every listing was revised'
          }
        >
          {summaryLine}. Every skipped or warned listing is listed below with the exact reason.
        </Banner>
      )}
      <p className="text-[10px] text-slate-400">
        Pushed at {at} · theme "{themeName}" · market {res.marketplace}
      </p>

      {/* The ONE outcome that is neither success nor failure but a handoff:
          Inventory-API-managed listings can't take a description-only revise.
          Say what to do and where, by name — "update via Full Publish" alone
          reads as jargon and looks like something broke. */}
      {invManagedFamilies.length > 0 && (
        <div className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 px-2.5 py-2 flex flex-col gap-1.5">
          <p className="text-[11.5px] font-bold text-amber-900 dark:text-amber-200">
            Action needed — {invManaged} listing{invManaged === 1 ? '' : 's'} need{invManaged === 1 ? 's' : ''} a Full Publish instead
          </p>
          <p className="text-[11px] leading-5 text-amber-900 dark:text-amber-200">
            {invManagedFamilies.length === 1 ? 'This family is' : 'These families are'} published through eBay's
            Inventory API, which rejects description-only revises — so nothing was sent and nothing changed on{' '}
            {invManagedFamilies.length === 1 ? 'that listing' : 'those listings'}:{' '}
            <span className="font-semibold">{invManagedFamilies.join(', ')}</span>.
          </p>
          <p className="text-[11px] leading-5 text-amber-900 dark:text-amber-200">
            To apply this theme to {invManagedFamilies.length === 1 ? 'it' : 'them'}: close the Studio and use{' '}
            <span className="font-semibold">“Push to eBay”</span> (Full Publish) on the flat-file toolbar for{' '}
            {invManagedFamilies.length === 1 ? 'that family' : 'those families'}. It renders the same theme and
            clears the staleness badge.
          </p>
          <p className="text-[11px] leading-5 text-amber-800 dark:text-amber-300">
            Why it isn’t automatic: a Full Publish republishes the whole inventory group — title, aspects, images and
            variants — not just the description. That is a bigger operation than a description edit, so it stays an
            explicit choice.
          </p>
        </div>
      )}

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
              {l.outcome === 'inventory-managed' && (
                <p className="text-[11px] leading-5 font-medium text-amber-700 dark:text-amber-300">
                  {LANE_A_EXPLAINER} Apply this theme with <span className="font-semibold">“Push to eBay”</span> (Full
                  Publish) on <span className="font-semibold">{l.parentSku}</span>.
                </p>
              )}
              {l.message && (
                <p className={cn('text-[11px] whitespace-pre-wrap',
                  l.outcome === 'failed'
                    ? 'font-medium text-red-600 dark:text-red-400'
                    : 'text-slate-500 dark:text-slate-400')}>
                  {l.outcome === 'inventory-managed' ? <span className="text-[10px]">server: </span> : null}
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
