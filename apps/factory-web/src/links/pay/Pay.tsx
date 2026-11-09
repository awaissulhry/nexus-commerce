'use client'

import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { brandPortals, checkBranding } from '@nexus/ui/tokens/branding'
import type { ApiClient } from '../../lib/api/client'
import { isApiError } from '../../lib/api/errors'
import { confirmFake, isFinal, POLL_MS, providerRuns, startRefusalOf, type FakeScenario, type PaymentMethod } from '../../lib/payments/online'
import { LinkBrandingContext } from '../../shell/links/view/LinkFrameView'
import { readDepositFacts, readLinkIntent, readPayPage, startLinkPayment } from './api'
import { cardFromPage, IDLE_CARD, underWay, type CardStepModel, type PayPurpose, type PayViewModel } from './model'
import { PayView } from './view/PayView'

/** A refused start, in this page's words (`link-pay`). */
function startProblem(error: unknown): string {
  const code = startRefusalOf(error)
  if (code) return `card.refusal.${code}`
  if (isApiError(error) && error.kind === 'rate_limited') return 'card.refusal.rateLimited'
  return 'card.refusal.other'
}

/**
 * A PAYMENT or DEPOSIT_INFO link, once it opened (the link landing did `POST /link/open`): reads what is paid
 * (`GET /payments/link/pay`; for DEPOSIT_INFO also W1's deposit facts, acconto or caparra), starts a card or SEPA payment
 * (`POST …/intents`, an Idempotency-Key each press; the same payer's payment under way is taken up again), plays the FAKE
 * provider's fields (`POST /payment-fake/confirm` with the client secret, kept in memory only) and asks how the payment
 * stands every few seconds until the provider decided (the webhook moves it, even when the page was closed); paid, the
 * page is read again and turns to Paid. Reading and paying use nothing of the link. The token stays in the client's
 * `x-factory-link` header. The tenant's colour goes on anything the DS draws over the page (brandPortals, D24).
 */
export function Pay({ api, purpose }: { api: ApiClient; purpose: PayPurpose }) {
  const [model, setModel] = useState<PayViewModel>({ link: 'valid', purpose, page: null, deposit: null, problem: null, copied: null, card: IDLE_CARD })
  const latest = useRef(model)
  latest.current = model
  // The provider's client secret of this page's payment: memory only, never in the model, an address or storage.
  const secret = useRef<string | null>(null)
  const polling = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollRef = useRef<(intentId: string) => void>(() => undefined)

  const branding = useContext(LinkBrandingContext)
  useEffect(() => brandPortals(branding ? checkBranding(branding) : null), [branding])

  useEffect(() => {
    const sync = () => setModel((current) => ({ ...current, offline: !navigator.onLine }))
    sync()
    window.addEventListener('online', sync)
    window.addEventListener('offline', sync)
    return () => {
      window.removeEventListener('online', sync)
      window.removeEventListener('offline', sync)
      if (polling.current) clearTimeout(polling.current)
    }
  }, [])

  const setCard = (change: (card: CardStepModel) => CardStepModel) => setModel((current) => ({ ...current, card: change(current.card) }))

  const load = useCallback(async () => {
    try {
      const [page, deposit] = await Promise.all([readPayPage(api), purpose === 'DEPOSIT_INFO' ? readDepositFacts(api).catch(() => null) : Promise.resolve(null)])
      setModel((current) => ({ ...current, link: 'valid', page, deposit: deposit ?? current.deposit, problem: null, card: cardFromPage(page, current.card) }))
      if (page.status === 'TO_PAY' && underWay(page.intent)) pollRef.current(page.intent!.id)
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setModel((current) => ({ ...current, link: 'unavailable' }))
      else setModel((current) => (current.page ? current : { ...current, problem: 'problem.read' }))
    }
  }, [api, purpose])

  // The provider decides (its webhook moves the payment): ask again every few seconds until it is final; paid → read the page.
  const poll = useCallback(
    (intentId: string) => {
      if (polling.current) clearTimeout(polling.current)
      polling.current = setTimeout(async () => {
        try {
          const intent = await readLinkIntent(api, intentId)
          if (latest.current.card.intent?.id !== intentId) return
          setCard((card) => (card.intent?.id === intentId ? { ...card, intent, ...(isFinal(intent) ? { sending: false, confirming: false, fields: false } : {}) } : card))
          if (intent.status === 'SUCCEEDED') void load()
          else if (!isFinal(intent)) pollRef.current(intentId)
          else secret.current = null
        } catch (error) {
          if (isApiError(error) && error.kind === 'not_found') setModel((current) => ({ ...current, link: 'unavailable' }))
          else pollRef.current(intentId)
        }
      }, POLL_MS)
    },
    [api, load],
  )
  pollRef.current = poll

  useEffect(() => {
    void load()
  }, [load])

  const start = (resume: boolean) => {
    const card = latest.current.card
    const method = card.method
    if (!method || card.phase === 'starting' || card.sending) return
    if (!resume) {
      secret.current = null
      setCard((current) => ({ ...current, phase: 'starting', problem: null, intent: null, fields: false, confirming: false, resumed: false }))
    } else setCard((current) => ({ ...current, sending: true, problem: null }))
    startLinkPayment(api, method)
      .then((started) => {
        const runs = started.provider !== null && providerRuns(started.provider)
        secret.current = runs ? started.provider!.clientSecret : null
        setCard((current) => {
          // Taken up again where it stands: a SEPA debit on its way keeps waiting (the bank's later answer); a card is confirmed anew.
          const same = resume && started.resumed && current.intent?.id === started.intent.id
          const phase = same && method === 'SEPA_DEBIT' ? 'paying' : 'ready'
          return { ...current, phase, intent: started.intent, fields: runs, sending: false, confirming: false, resumed: started.resumed, problem: runs ? null : 'card.unavailable.GATE_SPEND' }
        })
        if (underWay(started.intent) && (!runs || (resume && method === 'SEPA_DEBIT'))) pollRef.current(started.intent.id)
      })
      .catch((error: unknown) => {
        if (isApiError(error) && error.kind === 'not_found') {
          setModel((current) => ({ ...current, link: 'unavailable' }))
          return
        }
        const code = startRefusalOf(error)
        setCard((current) => ({ ...current, phase: resume ? current.phase : 'idle', sending: false, problem: startProblem(error) }))
        // Paid meanwhile, or a payment under way of this link: the page says where it stands.
        if (code === 'NOT_OPEN' || code === 'IN_PROGRESS') void load()
      })
  }

  const scenario = (which: FakeScenario) => {
    const card = latest.current.card
    const intentId = card.intent?.id
    if (!secret.current || !intentId || card.sending) return
    setCard((current) => ({ ...current, sending: true, problem: null }))
    confirmFake(api, secret.current, which)
      .then((answer) => {
        // 3-D Secure asked: the bank's window would open; its buttons confirm or fail it. Anything else: the bank decides.
        setCard((current) => (answer.state === 'requires_action' ? { ...current, sending: false, phase: 'ready', confirming: true } : { ...current, sending: false, phase: 'paying', confirming: false }))
        pollRef.current(intentId)
      })
      .catch((error: unknown) => {
        const ended = isApiError(error) && error.kind === 'conflict'
        setCard((current) => ({ ...current, sending: false, problem: ended ? 'card.refusal.ended' : 'card.refusal.other' }))
        if (ended) pollRef.current(intentId)
      })
  }

  return (
    <PayView
      model={model}
      actions={{
        onRetry: () => {
          setModel((current) => ({ ...current, problem: null }))
          void load()
        },
        onCopy: (what, text) => {
          void navigator.clipboard
            ?.writeText(text)
            .then(() => setModel((current) => ({ ...current, copied: what })))
            .catch(() => undefined)
        },
        onMethod: (method: PaymentMethod) => setCard((current) => (current.phase === 'idle' || current.intent?.status === 'FAILED' || current.intent?.status === 'CANCELLED' ? { ...IDLE_CARD, method } : current)),
        onStart: () => start(false),
        onResume: () => start(true),
        onScenario: scenario,
        onAgain: () => {
          secret.current = null
          setCard((current) => ({ ...IDLE_CARD, method: current.method }))
        },
      }}
    />
  )
}
