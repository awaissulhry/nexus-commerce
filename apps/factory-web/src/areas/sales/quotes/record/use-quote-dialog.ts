'use client'

import { useCallback, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { getQuote, type QuoteDetail } from '../api'
import type { Grains, QuoteAbilities } from '../model'
import { readProblem, writeProblem } from '../problems'
import { QUOTE_ACTS } from './acts'
import type { QuoteDialog, QuoteNotice } from './record-model'
import type { QuoteDialogsActions, QuoteDialogsModel } from './view/Dialogs'

/**
 * F-CQ-204 (customer page › Quotes & incoming, 13-backend §11 "Quote windows in place"; settles C1, C28) — the quote's OWN small windows
 * (QuoteDialogs: Ask for approval, Approve, Reject, Cancel, Make revision N, Send a new link) opened on a list's row, in place: the
 * quote is read once when a window opens (GET /sales/quotes/:id — never for every row), the act is the quote page's own (QUOTE_ACTS,
 * at the version read), its receipt goes to the list's notice and the list reads again. Approve / Reject keep the quote page's rule
 * (the asker never decides; the margin floor needs the margin grain: decideHeld inside the window).
 */
export interface QuoteDialogHost {
  readonly api: ApiClient
  readonly me: string
  readonly can: QuoteAbilities
  readonly grains: Grains
  /** A run ended (its receipt, or why it failed): the list says it and reads again. */
  readonly onDone: (notice: QuoteNotice) => void
}

export interface QuoteDialogOpen {
  readonly quote: QuoteDetail
  readonly model: QuoteDialogsModel
}

export function useQuoteDialog(host: QuoteDialogHost): { open: QuoteDialogOpen | null; openOn: (quoteId: string, dialog: QuoteDialog) => void; actions: QuoteDialogsActions } {
  const [quote, setQuote] = useState<QuoteDetail | null>(null)
  const [dialog, setDialog] = useState<QuoteDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const quoteRef = useRef(quote)
  quoteRef.current = quote
  const told = useRef(host)
  told.current = host
  const reading = useRef(0)

  const openOn = useCallback((quoteId: string, next: QuoteDialog) => {
    const id = ++reading.current
    setDialog(null)
    getQuote(told.current.api, quoteId)
      .then((value) => {
        if (id !== reading.current) return
        setQuote(value)
        setDialog(next)
      })
      .catch((error: unknown) => id === reading.current && told.current.onDone({ key: readProblem(error), tone: 'danger' }))
  }, [])

  const run = (kind: QuoteDialog) => async (text: string): Promise<boolean> => {
    const before = quoteRef.current
    if (!before) return false
    setBusy(true)
    const extra: { notice: QuoteNotice | null } = { notice: null }
    try {
      await QUOTE_ACTS[kind].run(told.current.api, before, text, (notice) => {
        extra.notice = notice
      })
      told.current.onDone(extra.notice ?? QUOTE_ACTS[kind].done(before))
      return true
    } catch (error) {
      told.current.onDone({ key: writeProblem(error).key, tone: 'danger' })
      return false
    } finally {
      setBusy(false)
    }
  }

  const actions: QuoteDialogsActions = {
    onDialog: (next) => {
      setDialog(next)
      if (!next) setQuote(null)
    },
    onAsk: run('ask'),
    onWithdraw: run('withdraw'),
    onApprove: run('approve'),
    onReject: run('reject'),
    onCancelQuote: run('cancel'),
    onRevise: run('revise'),
    onNewLink: () => run('newLink')(''),
  }

  return { open: quote && dialog ? { quote, model: { dialog, me: host.me, can: host.can, grains: host.grains, busy } } : null, openOn, actions }
}
