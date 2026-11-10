'use client'

import { useEffect, useState } from 'react'

/**
 * The browser says it is offline (B-W2b-235's containers): an explicit Save, Send or decision is then held with "Offline —
 * your changes are kept on this page" (design operation.min.smv / operation.machine.form `offline`), never sent half-way.
 */
export function useOffline(): boolean {
  const [offline, setOffline] = useState(false)
  useEffect(() => {
    const update = () => setOffline(typeof navigator !== 'undefined' && navigator.onLine === false)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  return offline
}
