'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ApiClient } from '../../../lib/api/client'
import { checkMisSend, checkProblem } from './api'
import type { MisSendDraft, MisSendModel } from './model'
import { MisSendDialog } from './view/MisSendDialog'

interface Pending<D> {
  readonly draft: D
  readonly guard: MisSendDraft
  readonly resolve: (sent: boolean) => void
}

/**
 * The mis-send guard as a record's panels use it (B-W2b-397; COL-004): `ask(draft)` opens "Send to <party>?" over the
 * composer, checks the draft through the API and resolves true once the person sent it (the panel's own `send` ran and
 * answered true), false when they went back to edit or the send failed (the panel says why). One question at a time: a new
 * ask answers the open one with false.
 */
export function useMisSend<D>(
  api: ApiClient,
  record: { readonly type: string; readonly id: string },
  options: { readonly partyName: string | null; readonly guardOf: (draft: D) => MisSendDraft; readonly send: (draft: D) => Promise<boolean> },
): { ask: (draft: D) => Promise<boolean>; element: ReactNode } {
  const [pending, setPending] = useState<Pending<D> | null>(null)
  const [state, setState] = useState<MisSendModel['state']>({ status: 'checking' })
  const [sending, setSending] = useState(false)
  const pendingRef = useRef<Pending<D> | null>(null)
  const seq = useRef(0)
  const optionsRef = useRef(options)
  optionsRef.current = options

  const run = useCallback(
    (guard: MisSendDraft) => {
      const mine = ++seq.current
      setState({ status: 'checking' })
      checkMisSend(api, record, guard)
        .then((check) => {
          if (mine === seq.current) setState({ status: 'ready', check })
        })
        .catch((error: unknown) => {
          if (mine === seq.current) setState({ status: 'error', ...checkProblem(error) })
        })
    },
    [api, record],
  )

  const settle = useCallback((sent: boolean) => {
    const open = pendingRef.current
    pendingRef.current = null
    seq.current++
    setPending(null)
    setSending(false)
    open?.resolve(sent)
  }, [])

  const ask = useCallback(
    (draft: D) =>
      new Promise<boolean>((resolve) => {
        pendingRef.current?.resolve(false)
        const guard = optionsRef.current.guardOf(draft)
        const next = { draft, guard, resolve }
        pendingRef.current = next
        setPending(next)
        setSending(false)
        run(guard)
      }),
    [run],
  )

  useEffect(
    () => () => {
      pendingRef.current?.resolve(false)
      pendingRef.current = null
    },
    [],
  )

  const element = pending ? (
    <MisSendDialog
      model={{ state, draft: pending.guard, partyName: options.partyName, sending }}
      actions={{
        onBack: () => settle(false),
        onRetry: () => run(pending.guard),
        onSend: () => {
          setSending(true)
          void optionsRef.current
            .send(pending.draft)
            .then((sent) => settle(sent))
            .catch(() => settle(false))
        },
      }}
    />
  ) : null

  return { ask, element }
}
