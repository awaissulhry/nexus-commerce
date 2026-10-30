'use client'

import { useEffect } from 'react'
import { createClientTracker, installErrorReporting, memorySink, offSink, sourceOf } from './tracker'

/**
 * The browser's error tracking (PLT-218; B-W2a-42), once for the whole app (the root layout renders it): uncaught errors
 * and unhandled rejections become redacted reports in the fake sink (every build but production; production keeps
 * nothing until a live service is agreed, GATE-SPEND + GDPR art. 28). Renders nothing.
 */
export function ErrorReporting() {
  useEffect(() => {
    const production = process.env.NODE_ENV === 'production'
    const memory = production ? null : memorySink()
    const tracker = createClientTracker({ source: sourceOf(window.location.pathname), sink: memory ?? offSink })
    // The test seam of the live check (never in a production build): the redacted reports this page kept.
    if (memory) (window as unknown as { __nexusErrorReports?: () => unknown }).__nexusErrorReports = memory.reports
    return installErrorReporting(window, tracker, () => window.location.pathname)
  }, [])
  return null
}
