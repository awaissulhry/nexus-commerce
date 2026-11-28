'use client'

import { useMemo } from 'react'
import { browserApi } from '../../../lib/api/browser'
import type { ApiClient } from '../../../lib/api/client'
import { useOfficeSession } from '../../../lib/session/context'
import type { OfficeSession } from '../../../lib/session/session'

/**
 * owb-ss7 — the office session and its API client for a PART that another page mounts (the order's Team part in the Production
 * tab, owb-b5's slot): in the office both are there; where nothing gives a session (the design index's order cases, the order
 * page's own tests that draw the tab on the server) the part draws nothing instead of failing the whole tab. `useOfficeSession`
 * throws outside the office layout; its context is read on every render either way, so the hooks keep their order.
 */
export function useOfficeOrNull(): { readonly session: OfficeSession; readonly api: ApiClient } | null {
  let session: OfficeSession | null = null
  try {
    session = useOfficeSession()
  } catch {
    session = null
  }
  const company = session?.company?.code ?? null
  const signedIn = session !== null
  const api = useMemo(() => (signedIn ? browserApi({ company }) : null), [signedIn, company])
  return session && api ? { session, api } : null
}
