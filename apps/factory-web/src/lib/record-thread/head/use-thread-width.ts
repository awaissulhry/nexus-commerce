'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DEFAULT_DOCK_WIDTH, hiddenKey, isDockWidth, tabWidthKey, widthKey, type DockWidth } from './model'

// F-SA-263: a page whose dock adapts per tab keeps the width per tab (the record type's key + `.tab`); without a tab, per record type.
const keyOf = (recordType: string, personId: string | null, tab?: string | null) => (tab ? tabWidthKey(recordType, personId, tab) : widthKey(recordType, personId))

/** The width remembered on this device for the person and record type (F-SA-263: and tab); 40 % when none (or storage is closed). */
export function readWidth(storage: Pick<Storage, 'getItem'> | null, recordType: string, personId: string | null, tab?: string | null): DockWidth {
  try {
    const value = storage?.getItem(keyOf(recordType, personId, tab))
    return isDockWidth(value) ? value : DEFAULT_DOCK_WIDTH
  } catch {
    return DEFAULT_DOCK_WIDTH
  }
}

/** B-TH-213: whether the person chose a width for this record type (F-SA-263: and tab) on this device (else the frame's own rule decides). */
export function isRemembered(storage: Pick<Storage, 'getItem'> | null, recordType: string, personId: string | null, tab?: string | null): boolean {
  try {
    return isDockWidth(storage?.getItem(keyOf(recordType, personId, tab)))
  } catch {
    return false
  }
}

/** Remembers a width (null: forget it, back to the default). A closed storage (a private window) forgets quietly. */
export function writeWidth(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, recordType: string, personId: string | null, width: DockWidth | null, tab?: string | null): void {
  try {
    if (width === null) storage?.removeItem(keyOf(recordType, personId, tab))
    else storage?.setItem(keyOf(recordType, personId, tab), width)
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
 * F-SA-263: with `tab`, the choice is kept per person + record type + tab (each tab its own default when none); with
 * `rememberHidden`, hiding and showing are kept per person + record type (the next record of the type opens the same).
 */
export function useThreadWidth(
  recordType: string,
  personId: string | null,
  options: { readonly keys?: boolean; /* B-TH-269 */ readonly startHidden?: boolean; /* F-SA-263 */ readonly tab?: string | null; readonly rememberHidden?: boolean } = {},
) {
  const tab = options.tab ?? null // F-SA-263
  const rememberHidden = (options.rememberHidden ?? false) && !options.startHidden // F-SA-263: a page that docks closed keeps nothing
  // Server and first client render: the default; the remembered one after mounting (no mismatch).
  const [width, setWidth] = useState<DockWidth>(DEFAULT_DOCK_WIDTH)
  // ---- B-TH-269 (R-10): a person's record (a colleague, a worker) docks its thread CLOSED; the Thread button or ⌘J shows it.
  const [hidden, setHiddenNow] = useState(options.startHidden ?? false)
  // ---- end B-TH-269
  // B-TH-213: RecordFrame reads whether a width was chosen (a wide grid tab gives one third otherwise) and owns ⌘J itself.
  const [remembered, setRemembered] = useState(false)
  const keys = options.keys ?? true
  // F-SA-263: read before paint, so another tab opens at ITS width (never a flash of the previous tab's).
  useLayoutEffect(() => {
    setWidth(readWidth(storageOf(), recordType, personId, tab))
    setRemembered(isRemembered(storageOf(), recordType, personId, tab))
  }, [recordType, personId, tab])
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
      writeWidth(storageOf(), recordType, personId, choice === 'reset' ? null : next, tab)
      setWidth(next)
      setRemembered(choice !== 'reset')
    },
    [recordType, personId, tab, setHidden],
  )
  const toggle = useCallback(() => setHidden(!hiddenNow.current), [setHidden])
  const show = useCallback(() => setHidden(false), [setHidden])
  return { width, hidden, remembered, choose, toggle, show }
}
