'use client'

import { useEffect } from 'react'
import { installRouterGuard, webBuildOf } from './guard'

/**
 * fx-12: the guard over the Next router's own requests (guard.ts), once for the whole app (the root layout renders it): a tab of
 * another build, or a router stuck asking one address, never loops against the server. Renders nothing.
 */
export function RouterGuard() {
  useEffect(() => installRouterGuard(window, webBuildOf(process.env.NODE_ENV)), [])
  return null
}
