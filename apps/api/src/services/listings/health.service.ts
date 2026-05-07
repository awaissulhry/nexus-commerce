// S.3 — Listing health computation.
//
// Synthesizes sync state, validation, data completeness, drift, and
// staleness into a single 0-100 score per listing plus a structured
// list of actionable issues. The frontend's HealthPanel renders this
// without needing to recompute on the client (and without the client
// reasoning about which fields constitute a problem).
//
// Why computed vs persisted
// ─────────────────────────
// Health is a pure function of the listing's current state. Persisting
// it would mean a separate ChannelListingHealth row that has to be
// recomputed on every relevant write — extra writes, extra moving
// parts, drift between persisted score and live state. As long as the
// computation is cheap (it is — pure JS, no I/O), inline computation
// per-request is the right shape.
//
// Health-score buckets
// ────────────────────
//   90-100  HEALTHY   green
//   70-89   WARNING   amber
//   0-69    CRITICAL  red
//
// Penalty model (additive, score caps at 100, floors at 0)
// ────────────────────────────────────────────────────────
//   ERROR listingStatus              -50
//   SUPPRESSED listingStatus         -40
//   FAILED syncStatus or lastSync   -25
//   never synced (lastSyncedAt null) -15
//   stale > 7d                       -15
//   stale 24h-7d                      -5
//   validationErrors[]                -5 each, capped at -20
//   missing title / price / qty       -10 each
//   retry count >= 3                  -10
//
// Drift is reported as a warning issue but doesn't penalise the score —
// per-channel overrides are often intentional (regional pricing, etc.).
// Operators can still see it and choose to snap-to-master.

export type HealthCategory = 'HEALTHY' | 'WARNING' | 'CRITICAL'
export type IssueSeverity = 'error' | 'warning' | 'info'
export type IssueCategory =
  | 'sync'
  | 'validation'
  | 'data'
  | 'drift'
  | 'staleness'
  | 'suppression'
  | 'retry'

export type FixAction =
  | { type: 'resync'; label: string }
  | { type: 'snap-master'; label: string; field: 'price' | 'quantity' | 'title' }
  | { type: 'edit'; label: string }
  | { type: 'view-marketplace'; label: string }

export interface HealthIssue {
  id: string // Stable enough for React keying
  severity: IssueSeverity
  category: IssueCategory
  title: string
  detail: string
  fix?: FixAction
}

export interface ListingHealth {
  score: number // 0-100
  category: HealthCategory
  issues: HealthIssue[]
}

interface ListingHealthInput {
  listingStatus: string
  syncStatus: string | null
  lastSyncStatus: string | null
  lastSyncError: string | null
  lastSyncedAt: Date | null
  syncRetryCount: number
  validationErrors: string[] | null
  title: string | null
  price: number | null
  quantity: number | null
  externalListingId: string | null
  channel: string
  marketplace: string
  followMasterPrice: boolean
  followMasterQuantity: boolean
  followMasterTitle: boolean
  masterPrice: number | null
  masterQuantity: number | null
  masterTitle: string | null
}

const DAY_MS = 86_400_000

export function computeHealth(l: ListingHealthInput): ListingHealth {
  let score = 100
  const issues: HealthIssue[] = []

  // ── ERROR / SUPPRESSED status ──
  if (l.listingStatus === 'ERROR') {
    score -= 50
    issues.push({
      id: 'status-error',
      severity: 'error',
      category: 'sync',
      title: 'Listing in error state',
      detail:
        l.lastSyncError ??
        'The marketplace flagged this listing as ERROR. Resync to refresh state from the channel.',
      fix: { type: 'resync', label: 'Resync from channel' },
    })
  }
  if (l.listingStatus === 'SUPPRESSED') {
    score -= 40
    issues.push({
      id: 'status-suppressed',
      severity: 'error',
      category: 'suppression',
      title: 'Listing suppressed',
      detail:
        'The marketplace has hidden this listing from buyers. Open in editor to fix the cause (often missing safety warnings, GTIN issues, or category attributes).',
      fix: { type: 'edit', label: 'Open in editor' },
    })
  }

  // ── Sync failures ──
  if (l.syncStatus === 'FAILED' || l.lastSyncStatus === 'FAILED') {
    score -= 25
    issues.push({
      id: 'sync-failed',
      severity: 'error',
      category: 'sync',
      title: 'Last sync attempt failed',
      detail: l.lastSyncError ?? 'Sync failed; reason not recorded. Retry to capture a fresh error message.',
      fix: { type: 'resync', label: 'Retry sync' },
    })
  }

  // ── Staleness ──
  if (l.lastSyncedAt == null) {
    score -= 15
    issues.push({
      id: 'never-synced',
      severity: 'warning',
      category: 'staleness',
      title: 'Never synced',
      detail:
        'This listing has never been pulled from the marketplace. Resync to capture current state (price, stock, status from the channel).',
      fix: { type: 'resync', label: 'Sync now' },
    })
  } else {
    const ageMs = Date.now() - new Date(l.lastSyncedAt).getTime()
    if (ageMs > 7 * DAY_MS) {
      score -= 15
      issues.push({
        id: 'stale-7d',
        severity: 'warning',
        category: 'staleness',
        title: 'Stale > 7 days',
        detail: `Last synced ${formatRel(ageMs)}. Channel state may have drifted.`,
        fix: { type: 'resync', label: 'Refresh' },
      })
    } else if (ageMs > DAY_MS) {
      score -= 5
      issues.push({
        id: 'stale-24h',
        severity: 'info',
        category: 'staleness',
        title: 'Stale > 24h',
        detail: `Last synced ${formatRel(ageMs)}.`,
      })
    }
  }

  // ── Validation errors ──
  if (l.validationErrors && l.validationErrors.length > 0) {
    const cap = Math.min(20, l.validationErrors.length * 5)
    score -= cap
    for (let i = 0; i < l.validationErrors.length; i++) {
      issues.push({
        id: `validation-${i}`,
        severity: 'warning',
        category: 'validation',
        title: 'Validation issue',
        detail: l.validationErrors[i],
        fix: { type: 'edit', label: 'Open in editor' },
      })
    }
  }

  // ── Data completeness ──
  if (!l.title || l.title.trim() === '') {
    score -= 10
    issues.push({
      id: 'missing-title',
      severity: 'warning',
      category: 'data',
      title: 'Missing title',
      detail: 'No title set on this listing. The marketplace may reject the listing or use a fallback.',
      fix: { type: 'edit', label: 'Add title' },
    })
  }
  if (l.price == null || l.price === 0) {
    score -= 10
    issues.push({
      id: 'missing-price',
      severity: 'error',
      category: 'data',
      title: 'No price set',
      detail: 'The listing has no price. Set one inline or open the editor.',
      fix: { type: 'edit', label: 'Set price' },
    })
  }
  if (l.quantity == null || l.quantity === 0) {
    score -= 5
    issues.push({
      id: 'missing-quantity',
      severity: 'warning',
      category: 'data',
      title: 'Out of stock',
      detail: 'Channel quantity is 0 — the listing may be unbuyable. Update stock or follow master.',
      fix: { type: 'snap-master', label: 'Use master stock', field: 'quantity' },
    })
  }

  // ── Retry exhaustion ──
  if (l.syncRetryCount >= 3) {
    score -= 10
    issues.push({
      id: 'retry-exhausted',
      severity: 'warning',
      category: 'retry',
      title: `${l.syncRetryCount} sync retries`,
      detail:
        'Sync has retried 3+ times. The underlying error is likely persistent — investigate before retrying again.',
    })
  }

  // ── Drift (no score penalty; informational) ──
  if (
    !l.followMasterPrice &&
    l.price != null &&
    l.masterPrice != null &&
    Number(l.price) !== Number(l.masterPrice)
  ) {
    const delta = Number(l.price) - Number(l.masterPrice)
    issues.push({
      id: 'drift-price',
      severity: 'info',
      category: 'drift',
      title: 'Price differs from master',
      detail: `Channel price ${Number(l.price).toFixed(2)} · master ${Number(l.masterPrice).toFixed(2)} (${delta > 0 ? '+' : ''}${delta.toFixed(2)}). Drift may be intentional.`,
      fix: { type: 'snap-master', label: 'Snap to master', field: 'price' },
    })
  }
  if (
    !l.followMasterQuantity &&
    l.quantity != null &&
    l.masterQuantity != null &&
    Number(l.quantity) !== Number(l.masterQuantity)
  ) {
    issues.push({
      id: 'drift-quantity',
      severity: 'info',
      category: 'drift',
      title: 'Quantity differs from master',
      detail: `Channel quantity ${l.quantity} · master ${l.masterQuantity}. Drift may be intentional.`,
      fix: { type: 'snap-master', label: 'Snap to master', field: 'quantity' },
    })
  }
  if (
    !l.followMasterTitle &&
    l.title != null &&
    l.masterTitle != null &&
    l.title !== l.masterTitle
  ) {
    issues.push({
      id: 'drift-title',
      severity: 'info',
      category: 'drift',
      title: 'Title differs from master',
      detail: 'Channel-specific title in use. Snap to master to revert, or open the editor for fine-grained edits.',
      fix: { type: 'snap-master', label: 'Snap to master', field: 'title' },
    })
  }

  score = Math.max(0, Math.min(100, score))
  const category: HealthCategory =
    score >= 90 ? 'HEALTHY' : score >= 70 ? 'WARNING' : 'CRITICAL'

  return { score, category, issues }
}

function formatRel(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

/**
 * Aggregate issue counts by category across many listings. Used by
 * the HealthLens rollup so the operator sees "12 sync · 3 data · 5
 * staleness" at a glance instead of a flat error count.
 */
export function aggregateIssuesByCategory(
  healths: ListingHealth[],
): Record<IssueCategory, number> {
  const counts: Record<IssueCategory, number> = {
    sync: 0,
    validation: 0,
    data: 0,
    drift: 0,
    staleness: 0,
    suppression: 0,
    retry: 0,
  }
  for (const h of healths) {
    for (const issue of h.issues) {
      counts[issue.category] += 1
    }
  }
  return counts
}
