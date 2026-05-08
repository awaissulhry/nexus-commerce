// Shared color-tone tokens for the /orders surface. Extracted from
// OrdersWorkspace.tsx during the O.8 monolith decomposition so each
// extracted lens (CustomerLens, FinancialsLens, ReturnsLens,
// ReviewsLens, GridLens) imports the same source of truth.
//
// Pattern matches the rest of the app (e.g. /products _lib/) — the
// tone strings are full Tailwind classlists for inline `<span>`
// channel/status badges. Move to the foundation Badge primitive
// during O.9 (Button + IconButton + Badge adoption sweep).

export const CHANNEL_TONE: Record<string, string> = {
  AMAZON: 'bg-orange-50 text-orange-700 border-orange-200',
  EBAY: 'bg-blue-50 text-blue-700 border-blue-200',
  SHOPIFY: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  WOOCOMMERCE: 'bg-violet-50 text-violet-700 border-violet-200',
  ETSY: 'bg-rose-50 text-rose-700 border-rose-200',
  MANUAL: 'bg-slate-50 text-slate-700 border-slate-200',
}

// Mirrors the canonical OrdersWorkspace mapping. Bumped from the
// O.8b extraction where ELIGIBLE/SCHEDULED colors were swapped by
// mistake (this commit corrects it).
export const REVIEW_STATUS_TONE: Record<string, string> = {
  SENT: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  SCHEDULED: 'bg-blue-50 text-blue-700 border-blue-200',
  ELIGIBLE: 'bg-amber-50 text-amber-700 border-amber-200',
  SUPPRESSED: 'bg-slate-50 text-slate-500 border-slate-200',
  FAILED: 'bg-rose-50 text-rose-700 border-rose-200',
  SKIPPED: 'bg-slate-50 text-slate-500 border-slate-200',
}

// Maps OrderStatus → Badge variant. Used by GridLens OrderCell.
// Kept here next to the channel/review tone maps so any future
// status-color tweak lives in one file.
export const STATUS_VARIANT: Record<
  string,
  'success' | 'warning' | 'danger' | 'default' | 'info'
> = {
  PENDING: 'warning',
  PROCESSING: 'warning',
  PARTIALLY_SHIPPED: 'info',
  ON_HOLD: 'warning',
  AWAITING_PAYMENT: 'warning',
  SHIPPED: 'info',
  DELIVERED: 'success',
  CANCELLED: 'default',
  REFUNDED: 'danger',
  RETURNED: 'danger',
}

export function channelTone(channel: string): string {
  return (
    CHANNEL_TONE[channel] ??
    'bg-slate-50 text-slate-600 border-slate-200'
  )
}
