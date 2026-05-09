/**
 * W2.7 — Shared formatters for the replenishment workspace cards.
 *
 * Five cards (CommandCenterKpis, ScenariosCard, SlowMoversCard,
 * SupplierSpendCard, AutomationRulesCard) each shipped private copies
 * of formatEur + relativeTime. This module is the single source of
 * truth — drift across copies was already starting (one card had the
 * sign prefix, another didn't; one used 'd ago', another '{d}d').
 *
 * Pure functions, no React, no I18n — calling code passes pre-resolved
 * strings when the output needs to be localised. These are display
 * helpers, not content.
 */

/**
 * EUR cents → compact string. Returns:
 *   €0       when cents is 0 / NaN
 *   €X       under €1,000 (no decimal)
 *   €X.XK    €1,000 ≤ cents < €100,000,000
 *   €X.XM    €100,000,000 and up
 *
 * Optional sign prefix (used by delta columns in scenario / KPI cards).
 */
export function formatEur(cents: number, opts?: { sign?: boolean }): string {
  if (!Number.isFinite(cents) || cents === 0) return '€0'
  const abs = Math.abs(cents)
  const prefix = opts?.sign ? (cents < 0 ? '-' : '+') : cents < 0 ? '-' : ''
  if (abs >= 100_000_00) return `${prefix}€${(abs / 100_000_00).toFixed(1)}M`
  if (abs >= 1_000_00) return `${prefix}€${(abs / 100_000).toFixed(1)}K`
  return `${prefix}€${(abs / 100).toFixed(0)}`
}

/**
 * ISO datetime → "{n}{unit} ago" with units that cap at days.
 * Smallest unit shown is seconds; everything else collapses to the
 * most-specific bucket that's >= 1.
 *
 *   < 1 minute  → "Xs ago" (clamped to ≥ 1)
 *   < 1 hour    → "Xm ago"
 *   < 1 day     → "Xh ago"
 *   else        → "Xd ago"
 */
export function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}

/**
 * Days-of-cover → compact string. Returns:
 *   ∞     when null (zero or unknown velocity)
 *   <1d   when fractional cover
 *   Xd    1 ≤ d < 100
 *   Xw    100 ≤ d (weekly buckets at the long tail keep tables narrow)
 */
export function formatCoverDays(d: number | null): string {
  if (d == null) return '∞'
  if (d < 1) return '<1d'
  if (d < 100) return `${Math.round(d)}d`
  return `${Math.round(d / 7)}w`
}
