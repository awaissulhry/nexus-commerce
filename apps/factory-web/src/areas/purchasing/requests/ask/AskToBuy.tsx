'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { DEFAULT_TIME_ZONE } from '../../../../lib/i18n/format'
import { readProblem, todayIn, type Loaded } from '../../../_shared/buying/model'
import { askFromShortage, askOptions, askToBuy, type AskOptions } from './api'
import { askBodyOf, askCan, doneOf, newDraft, sendHeld, sendRefusal, shortageBodyOf, shortageDraft, type AskDraft, type AskModel, type ShortageLine } from './model'
import { AskDialog } from './view/AskDialog'

/**
 * The Ask to buy dialog's container (B-W2b-332), for any page that opens it: Purchasing › Requests to buy (the band's "Ask to
 * buy") and Planning › What to buy & make ("Short on open work orders": a line asked, or drafted at once by a buyer). It
 * reads what the dialog offers (GET /purchasing/ask-to-buy/options, again when the site changes), keeps the draft and ONE
 * Idempotency-Key per opening (a resend answers the same), sends, and says what happened. `onAsked` lets the page read its
 * list again. `reasonFor` gives a shortage's default reason in the person's language.
 */
export function useAskToBuy(input: { api: ApiClient; prefix: string; permissions: readonly string[]; onAsked?: () => void; reasonFor?: (line: ShortageLine) => string; timeZone?: string }) {
  const { api, prefix, permissions, onAsked, reasonFor } = input
  const can = useMemo(() => askCan(permissions), [permissions])
  const timeZone = input.timeZone ?? DEFAULT_TIME_ZONE
  const [state, setState] = useState<Omit<AskModel, 'prefix' | 'can' | 'offline' | 'timeZone'> | null>(null)
  const [offline, setOffline] = useState(false)
  const key = useRef(newIdempotencyKey())
  const read = useRef(0)

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

  const loadOptions = useCallback(
    async (siteId: string | null) => {
      const id = ++read.current
      setState((current) => (current ? { ...current, options: { status: 'loading' } } : current))
      try {
        const value = await askOptions(api, { siteId })
        if (id !== read.current) return
        setState((current) => (current ? { ...current, options: { status: 'ready', value }, draft: current.draft.siteId ? current.draft : { ...current.draft, siteId: value.siteId } } : current))
      } catch (error) {
        if (id !== read.current) return
        setState((current) => (current ? { ...current, options: { status: 'error', problem: readProblem(error) } as Loaded<AskOptions> } : current))
      }
    },
    [api],
  )

  const open = useCallback(
    (shortage: ShortageLine | null = null) => {
      key.current = newIdempotencyKey()
      const today = todayIn(timeZone)
      const draft = shortage ? shortageDraft(shortage, today, reasonFor?.(shortage) ?? '', can.draft) : newDraft(today, null)
      setState({ draft, shortage, options: { status: 'loading' }, busy: false, problem: null, done: null })
      void loadOptions(shortage?.siteId ?? null)
    },
    [can.draft, loadOptions, reasonFor, timeZone],
  )

  const close = useCallback(() => setState(null), [])

  const send = useCallback(async () => {
    if (!state || sendHeld({ ...state, can, offline })) return
    setState({ ...state, busy: true, problem: null })
    try {
      const answer = state.shortage ? await askFromShortage(api, shortageBodyOf(state.draft, state.shortage), key.current) : await askToBuy(api, askBodyOf(state.draft), key.current)
      setState((current) => (current ? { ...current, busy: false, done: doneOf(answer) } : current))
      onAsked?.()
    } catch (error) {
      setState((current) => (current ? { ...current, busy: false, problem: sendRefusal(error) } : current))
    }
  }, [api, can, offline, onAsked, state])

  const model: AskModel | null = state ? { ...state, prefix, can, offline, timeZone } : null
  const element: ReactNode = model ? (
    <AskDialog
      model={model}
      actions={{
        onDraft: (draft: AskDraft) => setState((current) => (current ? { ...current, draft, problem: null } : current)),
        onSite: (siteId) => {
          setState((current) => (current ? { ...current, draft: { ...current.draft, siteId, itemId: null, itemColourId: null, uom: null, workOrderId: null } } : current))
          void loadOptions(siteId)
        },
        onRetry: () => void loadOptions(state?.draft.siteId ?? null),
        onSend: () => void send(),
        onClose: close,
        onAnother: () => open(null),
      }}
    />
  ) : null
  return { can, open, close, model, element }
}
