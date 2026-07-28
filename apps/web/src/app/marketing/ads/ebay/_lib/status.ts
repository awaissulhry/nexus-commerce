/**
 * ER1 (C9) — eBay native statuses → the shared StatusPill vocabulary
 * (ok = blue Enabled, warn = amber, arch = grey), single-sourced here and
 * rendered through ads/_shared/StatusPill (extracted for both channels;
 * Amazon adoption is a future workstream per protocol).
 */
export const EBAY_STATUS_PILL: Record<string, { label: string; cls: string }> = {
  RUNNING: { label: 'Enabled', cls: 'ok' },
  ACTIVE: { label: 'Enabled', cls: 'ok' },
  PAUSED: { label: 'Paused', cls: 'warn' },
  DRAFT: { label: 'Draft', cls: 'arch' },
  ENDED: { label: 'Ended', cls: 'arch' },
  SUSPENDED: { label: 'Suspended', cls: 'warn' },
  STALE: { label: 'Stale', cls: 'warn' },
  SANDBOX: { label: 'Sandbox', cls: 'arch' },
  // D1 — eBay paused this itself when seller standing dropped (error 35077).
  // Distinct from our own PAUSED: nothing we do resumes it, so it reads as a
  // blocking state rather than an operator choice.
  SYSTEM_PAUSED: { label: 'Paused by eBay', cls: 'bad' },
}

/** Why a status is what it is, when the reason is not the operator's doing. */
export const EBAY_STATUS_HINT: Record<string, string> = {
  SYSTEM_PAUSED:
    'eBay paused this campaign — not Nexus. It happens when seller standing falls below Above Standard, '
    + 'and every Promoted Listings write is refused until standing recovers. Check Seller Hub → Performance.',
  SUSPENDED: 'eBay suspended this campaign.',
  STALE: 'The listing behind this ad is no longer live on eBay.',
}

export const ebayStatusPill = (status: string): { label: string; cls: string } =>
  EBAY_STATUS_PILL[status] ?? { label: status, cls: 'arch' }
