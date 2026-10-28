'use client'

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { browserApi } from '../api/browser'
import type { ApiClient } from '../api/client'
import type { OfficeSession } from './session'

const SessionContext = createContext<OfficeSession | null>(null)

/** Gives the office pages under it the signed-in person (loaded by the office layout). */
export function OfficeSessionProvider({ session, children }: { session: OfficeSession; children?: ReactNode }) {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>
}

/** The signed-in office person. Only inside the office layout. */
export function useOfficeSession(): OfficeSession {
  const session = useContext(SessionContext)
  if (!session) throw new Error('useOfficeSession: outside the office layout')
  return session
}

/**
 * The API client for office pages: same-origin `/api`, the CSRF header on writes, and `x-factory-company` = the company
 * the page works in (the address's `/w/<company>`).
 */
export function useOfficeApi(): ApiClient {
  const session = useOfficeSession()
  const company = session.company?.code ?? null
  return useMemo(() => browserApi({ company }), [company])
}
