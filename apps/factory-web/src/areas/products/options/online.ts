'use client'

import { useEffect, useState } from 'react'

/**
 * Whether the browser is online (B-W2b-242): the Office has no queue of its own, so while offline every write of Options &
 * rules is held with its reason and the rows stay readable with their time (design: "Offline — changes wait to be sent").
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  return online
}
