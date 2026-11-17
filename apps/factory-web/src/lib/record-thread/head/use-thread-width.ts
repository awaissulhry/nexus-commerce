'use client'

import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_DOCK_WIDTH, isDockWidth, widthKey, type DockWidth } from './model'

/** The width remembered on this device for the person and record type; 40 % when none (or storage is closed). */
export function readWidth(storage: Pick<Storage, 'getItem'> | null, recordType: string, personId: string | null): DockWidth {
  try {
    const value = storage?.getItem(widthKey(recordType, personId))
    return isDockWidth(value) ? value : DEFAULT_DOCK_WIDTH
  } catch {
    return DEFAULT_DOCK_WIDTH
  }
}

/** B-TH-213: whether the person chose a width for this record type on this device (else the frame's own rule decides). */
export function isRemembered(storage: Pick<Storage, 'getItem'> | null, recordType: string, personId: string | null): boolean {
  try {
    return isDockWidth(storage?.getItem(widthKey(recordType, personId)))
  } catch {
    return false
  }
}

/** Remembers a width (null: forget it, back to 40 %). A closed storage (a private window) forgets quietly. */
export function writeWidth(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, recordType: string, personId: string | null, width: DockWidth | null): void {
  try {
    if (width === null) storage?.removeItem(widthKey(recordType, personId))
    else storage?.setItem(widthKey(recordType, personId), width)
  } catch {
    // Nothing to do: the width is only a convenience of this device.
  }
}

const storageOf = (): Storage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/**
 * The dock's width and its visibility (T1-F07): one third / 40 % / 50 % / full, remembered on this device per person and
 * record type, so the next record of the same type opens the same; ⌘J (Ctrl J) shows or hides the thread; "Reset width"
 * goes back to 40 %. The dock (B-TH-214) reads `width` and `hidden`; the Head's width menu calls `choose`.
 */
export function useThreadWidth(recordType: string, personId: string | null, options: { readonly keys?: boolean } = {}) {
  // Server and first client render: the default; the remembered one after mounting (no mismatch).
  const [width, setWidth] = useState<DockWidth>(DEFAULT_DOCK_WIDTH)
  const [hidden, setHidden] = useState(false)
  // B-TH-213: RecordFrame reads whether a width was chosen (a wide grid tab gives one third otherwise) and owns ⌘J itself.
  const [remembered, setRemembered] = useState(false)
  const keys = options.keys ?? true
  useEffect(() => {
    setWidth(readWidth(storageOf(), recordType, personId))
    setRemembered(isRemembered(storageOf(), recordType, personId))
  }, [recordType, personId])
  useEffect(() => {
    if (!keys) return
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        setHidden((value) => !value)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [keys])
  const choose = useCallback(
    (choice: DockWidth | 'hide' | 'reset') => {
      if (choice === 'hide') return setHidden(true)
      setHidden(false)
      const next = choice === 'reset' ? DEFAULT_DOCK_WIDTH : choice
      writeWidth(storageOf(), recordType, personId, choice === 'reset' ? null : next)
      setWidth(next)
      setRemembered(choice !== 'reset')
    },
    [recordType, personId],
  )
  const toggle = useCallback(() => setHidden((value) => !value), [])
  return { width, hidden, remembered, choose, toggle, show: () => setHidden(false) }
}
