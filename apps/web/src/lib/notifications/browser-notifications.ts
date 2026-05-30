'use client'

/**
 * RT.17 — Browser desktop notifications shared helper.
 *
 * Single source of truth for which sync alert classes the operator
 * wants to be notified about, plus the permission flow + the actual
 * fire-a-notification call.
 *
 * Operators configure preferences on /settings/notifications. The
 * config lives in localStorage (not server-side) because browser
 * notification permission is per-browser-profile and there's no point
 * round-tripping the preference through the server.
 *
 * Defaults err on the side of NOT spamming: only DLQ + account health
 * (the two critical-ops alerts) are on by default. Operator opts in
 * to the rest on the settings page.
 */

export type AlertClass =
  | 'dlq'
  | 'accountHealth'
  | 'buyBoxLost'
  | 'listingSuppressed'
  | 'highValueOrder'
  // PB.15 — image publish completion / failure on any channel.
  // Amazon SP-API feeds take 5–30 minutes to process; without these
  // the operator has to come back and poll the recent-jobs strip.
  | 'imagePublishComplete'
  | 'imagePublishFailed'
  // RX.3 — review alerts.
  | 'reviewNegative'
  | 'reviewSpike'

interface BrowserNotificationConfig {
  enabled: boolean
  classes: Record<AlertClass, boolean>
  /** Threshold for the high-value-order class, in cents (EUR). */
  highValueOrderThresholdCents: number
}

const STORAGE_KEY = 'nexus.browserNotifications.config.v1'

export const DEFAULT_CONFIG: BrowserNotificationConfig = {
  enabled: false,
  classes: {
    dlq: true,
    accountHealth: true,
    buyBoxLost: false,
    listingSuppressed: false,
    highValueOrder: false,
    // PB.15 — defaults: failure on, success off. Operators care
    // about errors immediately but success notifications can be
    // noisy on a busy day.
    imagePublishComplete: false,
    imagePublishFailed: true,
    // RX.3 — negative reviews on by default (operators want to respond
    // fast); spikes off by default to avoid noise.
    reviewNegative: true,
    reviewSpike: false,
  },
  highValueOrderThresholdCents: 10_000, // €100
}

export const ALERT_CLASS_META: Record<
  AlertClass,
  { label: string; description: string }
> = {
  dlq: {
    label: 'Sync pipeline DLQ',
    description: 'A non-empty dead-letter queue means push notifications are silently failing.',
  },
  accountHealth: {
    label: 'Account health',
    description: 'Amazon flags account as at-risk / suspended / deactivated.',
  },
  buyBoxLost: {
    label: 'Buy Box loss',
    description: 'A competitor takes the Buy Box on an ASIN where you have an offer.',
  },
  listingSuppressed: {
    label: 'Listing suppressed',
    description: 'Amazon search-suppresses one of your listings.',
  },
  highValueOrder: {
    label: 'High-value order',
    description: 'New order above your configured threshold lands on any channel.',
  },
  imagePublishComplete: {
    label: 'Image publish — completed',
    description: 'An Amazon SP-API feed finished processing, or an eBay/Shopify image publish landed.',
  },
  imagePublishFailed: {
    label: 'Image publish — failed',
    description: 'A channel image publish failed (FATAL feed, eBay ReviseItem error, Shopify 4xx/5xx).',
  },
  reviewNegative: {
    label: 'Negative review',
    description: 'A new negative review (or ≤2★) landed on any channel — respond fast from the Desk.',
  },
  reviewSpike: {
    label: 'Review spike',
    description: 'A surge in negative reviews for a product/category vs its baseline.',
  },
}

export function loadBrowserNotificationConfig(): BrowserNotificationConfig {
  if (typeof window === 'undefined') return DEFAULT_CONFIG
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_CONFIG
    const parsed = JSON.parse(raw) as Partial<BrowserNotificationConfig>
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      classes: { ...DEFAULT_CONFIG.classes, ...(parsed.classes ?? {}) },
    }
  } catch {
    return DEFAULT_CONFIG
  }
}

export function saveBrowserNotificationConfig(
  config: BrowserNotificationConfig,
): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  } catch {
    /* quota exceeded — ignore */
  }
}

export async function requestBrowserNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    return 'denied'
  }
  if (Notification.permission === 'granted' || Notification.permission === 'denied') {
    return Notification.permission
  }
  try {
    return await Notification.requestPermission()
  } catch {
    return 'denied'
  }
}

/**
 * Fires a notification only if:
 *   1. The operator enabled browser notifications globally.
 *   2. The specific alert class is opted-in.
 *   3. Browser permission was previously granted.
 *
 * Returns true when a notification was actually fired so callers
 * can fall back to a different surface (console.warn, banner) when
 * notifications are off.
 */
export function fireBrowserNotification(
  alertClass: AlertClass,
  title: string,
  options: NotificationOptions & { tagSuffix?: string } = {},
): boolean {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return false
  if (Notification.permission !== 'granted') return false
  const config = loadBrowserNotificationConfig()
  if (!config.enabled || !config.classes[alertClass]) return false
  const { tagSuffix, ...nativeOptions } = options
  const tag = tagSuffix ? `nexus-${alertClass}-${tagSuffix}` : `nexus-${alertClass}`
  try {
    new Notification(title, { tag, icon: '/favicon.ico', ...nativeOptions })
    return true
  } catch {
    return false
  }
}
