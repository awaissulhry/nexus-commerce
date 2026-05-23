// PB.11 — Per-(productId, channel) auto-publish preference, stored
// client-side in localStorage. When enabled for a channel, the
// images tab fires that channel's publish endpoint automatically
// after a successful Save (only for channels with pending changes).
//
// Browser-side preferences are intentional — auto-publish is a
// per-operator choice. Operator A wants Shopify auto-publish on
// their dev product; operator B doesn't on the same product. A
// future PB.11b could add server-side org-level defaults.

export type AutoPublishChannel = 'AMAZON' | 'EBAY' | 'SHOPIFY'

const STORAGE_PREFIX = 'nexus.images.autoPublish'

function key(productId: string, channel: AutoPublishChannel): string {
  return `${STORAGE_PREFIX}.${productId}.${channel}`
}

export function getAutoPublishEnabled(productId: string, channel: AutoPublishChannel): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(key(productId, channel)) === '1'
  } catch {
    return false
  }
}

export function setAutoPublishEnabled(
  productId: string,
  channel: AutoPublishChannel,
  enabled: boolean,
): void {
  if (typeof window === 'undefined') return
  try {
    if (enabled) {
      window.localStorage.setItem(key(productId, channel), '1')
    } else {
      window.localStorage.removeItem(key(productId, channel))
    }
  } catch {
    // localStorage unavailable (private browsing). Toggle is a no-op.
  }
}

export function readAllPrefs(productId: string): Record<AutoPublishChannel, boolean> {
  return {
    AMAZON: getAutoPublishEnabled(productId, 'AMAZON'),
    EBAY: getAutoPublishEnabled(productId, 'EBAY'),
    SHOPIFY: getAutoPublishEnabled(productId, 'SHOPIFY'),
  }
}
