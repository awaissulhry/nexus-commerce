// MC.12.5 — Per-channel publish dashboard.

import { getBackendUrl } from '@/lib/backend-url'
import PublishDashboardClient from './PublishDashboardClient'

export const dynamic = 'force-dynamic'

interface ModeMap {
  AMAZON: 'sandbox' | 'live'
  EBAY: 'sandbox' | 'live'
  SHOPIFY: 'sandbox' | 'live'
  WOOCOMMERCE: 'sandbox' | 'live'
}

async function fetchModes(): Promise<ModeMap> {
  const backend = getBackendUrl()
  try {
    const res = await fetch(`${backend}/api/channel-publish/_meta/mode`, {
      cache: 'no-store',
    })
    if (!res.ok)
      return {
        AMAZON: 'sandbox',
        EBAY: 'sandbox',
        SHOPIFY: 'sandbox',
        WOOCOMMERCE: 'sandbox',
      }
    const data = (await res.json()) as { modes: ModeMap }
    return data.modes
  } catch {
    return {
      AMAZON: 'sandbox',
      EBAY: 'sandbox',
      SHOPIFY: 'sandbox',
      WOOCOMMERCE: 'sandbox',
    }
  }
}

export default async function PublishDashboardPage() {
  const modes = await fetchModes()
  const apiBase = getBackendUrl()
  return <PublishDashboardClient modes={modes} apiBase={apiBase} />
}
