'use client'

import type { ApiClient } from '../../../../lib/api/client'
import { startPreview } from './api'

/**
 * "Open preview" (design new tab customers.portalPreview, "see exactly what they see without signing in as them"): a new
 * tab opens at once (the click's own window: a tab opened after an answer is a pop-up the browser may block), the office
 * person's preview session of the party starts (POST /partners/:id/preview: the portal cookie in this browser, read-only,
 * an hour, recorded), then the tab goes to the portal address. A refusal closes the tab and goes up to the caller.
 */
export async function openPreview(api: ApiClient, partyId: string, address: string): Promise<void> {
  const tab = typeof window === 'undefined' ? null : window.open('', '_blank')
  try {
    await startPreview(api, partyId)
  } catch (error) {
    tab?.close()
    throw error
  }
  if (tab) {
    tab.opener = null
    tab.location.href = address
  } else window.open(address, '_blank', 'noopener')
}
