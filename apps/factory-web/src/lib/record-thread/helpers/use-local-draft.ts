'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { draftKey, readDraft, writeDraft, type LocalDraft } from './model'

const storageOf = (): Storage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/**
 * The draft kept on this device (B-TH-208, T8-F07 until drafts live on the server, N6): per person, record and audience,
 * written a moment after typing stops, read back when the record opens again, forgotten on send or after 30 days. A closed
 * storage (a private window) keeps nothing and says nothing: the box still holds the text.
 *
 *   const draft = useLocalDraft(me.id, record, mode)
 *   <MentionInput value={draft.text} onChange={draft.setText} … />   <DraftLine draft={draft.kept} />
 *   after a send: draft.clear()
 */
export function useLocalDraft(personId: string | null, record: { readonly type: string; readonly id: string }, mode: 'note' | 'reply', waitMs = 600) {
  const key = personId ? draftKey(personId, record, mode) : null
  const [text, setTextState] = useState('')
  const [kept, setKept] = useState<LocalDraft | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Read after mounting (the server and the first client render agree on an empty box).
  useEffect(() => {
    const found = key ? readDraft(storageOf(), key, Date.now()) : null
    setTextState(found?.text ?? '')
    setKept(found)
  }, [key])
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const setText = useCallback(
    (next: string) => {
      setTextState(next)
      if (!key) return
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setKept(writeDraft(storageOf(), key, next, Date.now())), waitMs)
    },
    [key, waitMs],
  )
  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    setTextState('')
    setKept(null)
    if (key) writeDraft(storageOf(), key, '', Date.now())
  }, [key])
  return { text, setText, kept, clear }
}
