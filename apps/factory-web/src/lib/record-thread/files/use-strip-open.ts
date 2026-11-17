'use client'

import { useCallback, useEffect, useState } from 'react'
import { stripKey } from './model'

/** Whether the strip was left open on this device (closed when unknown or storage is closed). */
export function readStripOpen(storage: Pick<Storage, 'getItem'> | null, personId: string | null): boolean {
  try {
    return storage?.getItem(stripKey(personId)) === 'open'
  } catch {
    return false
  }
}

export function writeStripOpen(storage: Pick<Storage, 'setItem'> | null, personId: string | null, open: boolean): void {
  try {
    storage?.setItem(stripKey(personId), open ? 'open' : 'closed')
  } catch {
    // Only a convenience of this device.
  }
}

const storageOf = (): Storage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/** The files strip's open or closed state, remembered on this device per person (T2-F02 "open or closed is remembered"). */
export function useStripOpen(personId: string | null) {
  const [open, setOpen] = useState(false)
  useEffect(() => setOpen(readStripOpen(storageOf(), personId)), [personId])
  const toggle = useCallback(
    (next: boolean) => {
      setOpen(next)
      writeStripOpen(storageOf(), personId, next)
    },
    [personId],
  )
  return { open, toggle }
}
