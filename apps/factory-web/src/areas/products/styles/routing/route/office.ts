'use client'

import { useMemo } from 'react'
import { browserApi } from '../../../../../lib/api/browser'
import type { ApiClient } from '../../../../../lib/api/client'
import { useOfficeSession } from '../../../../../lib/session/context'
import { permissionCheck, type OfficeSession } from '../../../../../lib/session/session'

/**
 * owb-pd6 (S4) — the office person's API client and rights for the route parts, which read for themselves (the Route tab's face and
 * the order's "Route of each line" are mounted by views that hand them no client). Outside the office layout (the design index, a
 * test's render) there is no session: `api` is null and every right is false, so the parts draw their quiet state and never throw.
 * The client is the office one: same-origin `/api`, the CSRF header on writes, the page's company.
 */
export interface OfficeReach {
  readonly api: ApiClient | null
  readonly can: (permission: string) => boolean
}

function useSessionOrNull(): OfficeSession | null {
  // useOfficeSession reads the context first and throws only after, so the hook order is the same with or without a session.
  try {
    return useOfficeSession()
  } catch {
    return null
  }
}

export function useOfficeReach(): OfficeReach {
  const session = useSessionOrNull()
  const company = session?.company?.code ?? null
  const permissions = session?.permissions ?? null
  const present = session !== null
  return useMemo<OfficeReach>(() => ({ api: present ? browserApi({ company }) : null, can: permissionCheck(permissions ?? []) }), [present, company, permissions])
}
