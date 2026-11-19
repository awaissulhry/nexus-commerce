'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DEFAULT_DOCK_WIDTH, hiddenKey, isDockWidth, widthKey, type DockWidth } from './model'

/** The width remembered on this device for the person and record type (F-OP-301: one for every tab); 40 % when none (or storage is closed). */
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

/** Remembers a width (null: forget it, back to the default). A closed storage (a private window) forgets quietly. */
export function writeWidth(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, recordType: string, personId: string | null, width: DockWidth | null): void {
  try {
    if (width === null) storage?.removeItem(widthKey(recordType, personId))
    else storage?.setItem(widthKey(recordType, personId), width)
  } catch {
    // Nothing to do: the width is only a convenience of this device.
  }
}

// ---- F-SA-263: "hidden" kept per person + record type (10-order-page §6.3); a closed storage (a private window) keeps nothing.
/** Whether the person hid the dock on this record type the last time (false when nothing is kept, or storage is closed). */
export function readHidden(storage: Pick<Storage, 'getItem'> | null, recordType: string, personId: string | null): boolean {
  try {
    return storage?.getItem(hiddenKey(recordType, personId)) === '1'
  } catch {
    return false
  }
}

/** Keeps "hidden" (true) or forgets it (false: the dock shows next time). A closed storage forgets quietly. */
export function writeHidden(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, recordType: string, personId: string | null, hidden: boolean): void {
  try {
    if (hidden) storage?.setItem(hiddenKey(recordType, personId), '1')
    else storage?.removeItem(hiddenKey(recordType, personId))
  } catch {
    // Only a convenience of this device.
  }
}
// ---- end F-SA-263

const storageOf = (): Storage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/**
 * The dock's width and its visibility (T1-F07): one third / 40 % / 50 % / full, remembered on this device per person and
 * record type, so the next record of the same type opens the same; ⌘J (Ctrl J) shows or hides the thread; "Default width"
 * forgets the choice. The dock (B-TH-214) reads `width` and `hidden`; the Head's width menu calls `choose`.
 * F-SA-263: with `rememberHidden`, hiding and showing are kept per person + record type (the next record of the type opens the same).
 * F-OP-301 (walk #5): the chosen width is one per person + record type on every tab of the page.
 */
export function useThreadWidth(
  recordType: string,
  personId: string | null,
  options: { readonly keys?: boolean; /* B-TH-269 */ readonly startHidden?: boolean; /* F-SA-263 */ readonly rememberHidden?: boolean } = {},
) {
  const rememberHidden = (options.rememberHidden ?? false) && !options.startHidden // F-SA-263: a page that docks closed keeps nothing
  // Server and first client render: the default; the remembered one after mounting (no mismatch).
  const [width, setWidth] = useState<DockWidth>(DEFAULT_DOCK_WIDTH)
  // ---- B-TH-269 (R-10): a person's record (a colleague, a worker) docks its thread CLOSED; the Thread button or ⌘J shows it.
  const [hidden, setHiddenNow] = useState(options.startHidden ?? false)
  // ---- end B-TH-269
  // B-TH-213: RecordFrame reads whether a width was chosen (a wide grid tab gives one third otherwise) and owns ⌘J itself.
  const [remembered, setRemembered] = useState(false)
  const keys = options.keys ?? true
  // Read before paint (never a flash of the default width first).
  useLayoutEffect(() => {
    setWidth(readWidth(storageOf(), recordType, personId))
    setRemembered(isRemembered(storageOf(), recordType, personId))
  }, [recordType, personId])
  // ---- F-SA-263: hidden as the person left it on this record type (before paint: the dock never flashes open first).
  useLayoutEffect(() => {
    if (rememberHidden) setHiddenNow(readHidden(storageOf(), recordType, personId))
  }, [recordType, personId, rememberHidden])
  const hiddenNow = useRef(hidden)
  hiddenNow.current = hidden
  const setHidden = useCallback(
    (next: boolean) => {
      if (rememberHidden) writeHidden(storageOf(), recordType, personId, next)
      setHiddenNow(next)
    },
    [recordType, personId, rememberHidden],
  )
  // ---- end F-SA-263
  useEffect(() => {
    if (!keys) return
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        setHidden(!hiddenNow.current)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [keys, setHidden])
  const choose = useCallback(
    (choice: DockWidth | 'hide' | 'reset') => {
      if (choice === 'hide') return setHidden(true)
      setHidden(false)
      const next = choice === 'reset' ? DEFAULT_DOCK_WIDTH : choice
      writeWidth(storageOf(), recordType, personId, choice === 'reset' ? null : next)
      setWidth(next)
      setRemembered(choice !== 'reset')
    },
    [recordType, personId, setHidden],
  )
  const toggle = useCallback(() => setHidden(!hiddenNow.current), [setHidden])
  const show = useCallback(() => setHidden(false), [setHidden])
  return { width, hidden, remembered, choose, toggle, show }
}
