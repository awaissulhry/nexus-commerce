'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { useT } from '../../../../lib/i18n/provider'
import { usePortalFrame, usePortalLive } from '../../../shell/frame'
import { proveStepUp, startStepUp } from '../../../shared/account/api'
import { maskedEmail, stepUpFresh } from '../../../shared/account/model'
import { stepUpWords } from '../../../shared/account/words'
import { useOffline } from '../../orders/parts'
import { proposeSupplierBank, readSupplierBank, type PortalBank } from './api'
import { BANK_NS, changeHeld, draftProblems, EMPTY_DRAFT, hasWaiting, proposalOf, sendFailed, type BankDraft } from './model'
import { BankSection, type BankDialog } from './view/BankSection'

/**
 * Profile › Bank details for a supplier or a workshop (B-W2b-334 on B-W2b-315's API): reads GET /portal/supplier-bank and
 * again on its live events and a reconnect; "Change bank details" asks a fresh code by e-mail first (POST
 * /portal/step-up/start + /portal/step-up; skipped while the session has one), then New bank details, the review and
 * POST /portal/supplier-bank (one Idempotency-Key per send; a late 403 asking for the code asks it again and sends once
 * more). Nothing changes on our side until we call back and a second person checks it. Shown with portal.supplierBank.view.
 */
export function SupplierBank() {
  const frame = usePortalFrame()
  const { api, me } = frame
  const t = useT(BANK_NS)
  const account = useT('portal-account')
  const offline = useOffline()
  const [bank, setBank] = useState<{ state: 'loading' | 'error' | 'ready'; value: PortalBank | null }>({ state: 'loading', value: null })
  const [slow, setSlow] = useState(false)
  const [dialog, setDialog] = useState<BankDialog | null>(null)
  const [receipt, setReceipt] = useState<string | null>(null)
  const [stepUpUntil, setStepUpUntil] = useState<string | null>(me.session.stepUpUntil)
  const sendKey = useRef<string | null>(null)
  const afterCode = useRef<'form' | 'send'>('form')

  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 1000)
    return () => window.clearTimeout(timer)
  }, [])

  const read = useCallback(async () => {
    try {
      setBank({ state: 'ready', value: await readSupplierBank(api) })
    } catch {
      setBank((current) => (current.value ? current : { state: 'error', value: null }))
    }
  }, [api])
  useEffect(() => {
    void read()
  }, [read])
  usePortalLive({ onChange: (change) => (bank.value?.live.events.includes(change.type) ? void read() : undefined), onReconnect: () => void read() })

  const askCode = async (next: 'form' | 'send') => {
    afterCode.current = next
    const to = maskedEmail(me.user.email)
    setDialog({ kind: 'stepUp', to, busy: true, error: null })
    try {
      await startStepUp(api)
      setDialog({ kind: 'stepUp', to, busy: false, error: null })
    } catch (error) {
      setDialog({ kind: 'stepUp', to, busy: false, error: isApiError(error) && error.kind === 'rate_limited' ? account('stepUp.wait') : account('stepUp.sendFailed') })
    }
  }

  const draftRef = useRef<BankDraft>(EMPTY_DRAFT)
  const send = async (draft: BankDraft) => {
    sendKey.current ??= newIdempotencyKey()
    setDialog({ kind: 'review', draft, sending: true, failed: null })
    try {
      const answer = await proposeSupplierBank(api, proposalOf(draft), sendKey.current)
      sendKey.current = null
      setBank({ state: 'ready', value: answer })
      setDialog(null)
      setReceipt(t('portalBank.sent'))
    } catch (error) {
      if (isApiError(error) && error.kind === 'step_up') {
        draftRef.current = draft
        void askCode('send')
        return
      }
      if (!isApiError(error) || error.kind !== 'rate_limited') sendKey.current = null
      setDialog({ kind: 'review', draft, sending: false, failed: sendFailed(error) })
      if (isApiError(error) && error.kind === 'conflict') void read()
    }
  }

  const value = bank.value
  const held = changeHeld({ preview: me.preview, offline, mayPropose: value?.mayPropose ?? false, waiting: value ? hasWaiting(value) : false })

  return (
    <BankSection
      model={{ state: bank.state, slow, bank: value, held, dialog, receipt }}
      actions={{
        onRetry: () => void read(),
        onChange: () => {
          if (held) return
          setReceipt(null)
          sendKey.current = null
          if (stepUpFresh(stepUpUntil, Date.now())) setDialog({ kind: 'form', draft: EMPTY_DRAFT, tried: false })
          else void askCode('form')
        },
        onStepUpCode: async (code) => {
          setDialog((current) => (current?.kind === 'stepUp' ? { ...current, busy: true, error: null } : current))
          try {
            const proved = await proveStepUp(api, code)
            setStepUpUntil(proved.stepUpUntil)
            if (afterCode.current === 'send') void send(draftRef.current)
            else setDialog({ kind: 'form', draft: draftRef.current === EMPTY_DRAFT ? EMPTY_DRAFT : draftRef.current, tried: false })
          } catch (error) {
            setDialog((current) => (current?.kind === 'stepUp' ? { ...current, busy: false, error: stepUpWords(error, account) } : current))
          }
        },
        onDraft: (draft) => setDialog((current) => (current?.kind === 'form' ? { ...current, draft } : current)),
        onReview: () =>
          setDialog((current) => {
            if (current?.kind !== 'form') return current
            if (Object.keys(draftProblems(current.draft)).length > 0) return { ...current, tried: true }
            return { kind: 'review', draft: current.draft, sending: false, failed: null }
          }),
        onBack: () => setDialog((current) => (current?.kind === 'review' && !current.sending ? { kind: 'form', draft: current.draft, tried: false } : current)),
        onSend: () => {
          if (dialog?.kind === 'review' && !dialog.sending) void send(dialog.draft)
        },
        onClose: () =>
          setDialog((current) => {
            if (current?.kind === 'review' && current.sending) return current
            draftRef.current = EMPTY_DRAFT
            return null
          }),
      }}
    />
  )
}
