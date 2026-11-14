'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import { captureInboxes, makeCapture, pointCapture, readCapture, turnOffCapture, type CaptureRead } from './api'
import { captureReadProblem, captureWriteProblem, type CaptureCardModel, type CaptureConfirm, type Read } from './model'
import type { CaptureCardActions } from './view/CaptureCard'

/**
 * The container of the capture address card (B-W2b-397): reads the company's address (`GET /email/capture?companyId`) and,
 * for the default's choice, its switched-on team inboxes (only with email.triage); makes, replaces (with the live one's
 * version), points and turns it off — each write once, then the address is read again. Null without email.send.
 */
export function useCaptureAdmin(api: ApiClient, options: { readonly companyId: string | null; readonly prefix: string; readonly enabled: boolean; readonly readsInboxes: boolean }): { model: CaptureCardModel | null; actions: CaptureCardActions } {
  const [read, setRead] = useState<Read<CaptureRead>>({ status: 'loading' })
  const [inboxes, setInboxes] = useState<CaptureCardModel['inboxes']>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<CaptureCardModel['notice']>(null)
  const [confirm, setConfirm] = useState<CaptureConfirm | null>(null)

  const load = useCallback(async () => {
    if (!options.enabled || !options.companyId) return
    try {
      setRead({ status: 'ready', data: await readCapture(api, options.companyId) })
    } catch (error) {
      setRead({ status: 'error', problem: captureReadProblem(error) })
    }
    if (options.readsInboxes) {
      captureInboxes(api, options.companyId)
        .then((rows) => setInboxes(rows.map((row) => ({ id: row.id, name: row.name }))))
        .catch(() => setInboxes(null))
    }
  }, [api, options.enabled, options.companyId, options.readsInboxes])

  useEffect(() => {
    void load()
  }, [load])

  const write = async (run: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      await run()
      setNotice({ key: done, tone: 'success' })
      setConfirm(null)
    } catch (error) {
      const problem = captureWriteProblem(error)
      setNotice({ key: problem.key, tone: problem.reload ? 'warning' : 'danger' })
      setConfirm(null)
    } finally {
      setBusy(false)
      void load()
    }
  }

  const current = read.status === 'ready' ? read.data.capture : null
  const actions: CaptureCardActions = {
    onMake: () => options.companyId && void write(() => makeCapture(api, options.companyId!, null), 'captureAdmin.done.made'),
    onConfirm: setConfirm,
    onReplace: () => options.companyId && current && void write(() => makeCapture(api, options.companyId!, current), 'captureAdmin.done.replaced'),
    onTurnOff: () => current && void write(() => turnOffCapture(api, current), 'captureAdmin.done.turnedOff'),
    onDefault: (inboxId) => current && void write(() => pointCapture(api, current, inboxId), 'captureAdmin.done.pointed'),
    onRetry: () => {
      setRead({ status: 'loading' })
      void load()
    },
    onDismissNotice: () => setNotice(null),
  }

  return { model: options.enabled && options.companyId ? { read, inboxes, busy, notice, confirm, prefix: options.prefix } : null, actions }
}
