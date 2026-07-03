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
}

export const ebayStatusPill = (status: string): { label: string; cls: string } =>
  EBAY_STATUS_PILL[status] ?? { label: status, cls: 'arch' }
