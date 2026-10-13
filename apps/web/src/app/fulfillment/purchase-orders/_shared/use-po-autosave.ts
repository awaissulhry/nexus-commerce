'use client'

// React side of po-autosave.ts, shared by the PO draft editor and the PO
// revision editor.

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { createSaveQueue, type SaveQueue } from './po-autosave'

/**
 * The editor's draft, held in state (for render) and in a ref (for the save,
 * which reads it when it is sent). setDraft updates both at once; an updater
 * gets the ref's value, so two edits in one event both land.
 */
export function useDraft<T extends object>(
  init: () => T,
): [T, RefObject<T>, (next: T | ((prev: T) => T)) => void] {
  const [draft, setDraftState] = useState<T>(init)
  const draftRef = useRef<T>(draft)
  const setDraft = useCallback((next: T | ((prev: T) => T)) => {
    const value =
      typeof next === 'function' ? (next as (prev: T) => T)(draftRef.current) : next
    draftRef.current = value
    setDraftState(value)
  }, [])
  return [draft, draftRef, setDraft]
}

/**
 * One save queue for the editor's lifetime; it always calls the latest `save`
 * and `onIdle` the editor rendered. On unmount, a save that still waits is
 * sent rather than lost.
 */
export function useSaveQueue(
  save: () => Promise<boolean>,
  delayMs: number,
  onIdle?: () => void,
): SaveQueue {
  const saveRef = useRef(save)
  const onIdleRef = useRef(onIdle)
  saveRef.current = save
  onIdleRef.current = onIdle
  const [queue] = useState(() =>
    createSaveQueue({
      save: () => saveRef.current(),
      delayMs,
      onIdle: () => onIdleRef.current?.(),
    }),
  )
  useEffect(
    () => () => {
      if (queue.busy()) void queue.flush()
    },
    [queue],
  )
  return queue
}
