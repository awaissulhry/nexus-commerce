'use client'

import { useCallback, useEffect, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { isStepUpCancelled, useCoalesced, useLive, useStepUp } from '../../_shared/hooks'
import { readProblem } from '../../_shared/model'
import { eInvoicingTouched, getCopies, getEInvoicing, makeCopies, putTestMode, type CompanyEInvoicing, type Readiness, type SendCopy, type SimulatedOutcome } from '../../invoices/test-mode/api'
import { depthProblem, scoped, type DepthProblem } from '../../invoices/test-mode/depth'
import { DepthStepUp } from '../../invoices/test-mode/view/DepthStepUp'
import { EInvoicingCards, type EInvoicingModel } from './view/EInvoicingCards'

/** The refusal codes of the e-invoicing settings this step words. */
const SDI_REFUSALS = ['GO_LIVE', 'DATABASE', 'COPY_FILES'] as const

/**
 * Finance settings › E-invoicing in depth, the container (B-W2b-417 on B-W2b-401's API), for the company the settings page
 * shows: reads its e-invoicing settings and our copies of its sends; going live, back to test mode and the simulated answer
 * are ONE command each after a fresh authenticator code (asked first); Make the copies is one command (invoices.issue).
 */
export function EInvoicing({ companyId }: { companyId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const canIssue = session.permissions.includes('invoices.issue')
  const [company, setCompany] = useState<{ value: CompanyEInvoicing | null; problem: string | null }>({ value: null, problem: null })
  const [copies, setCopies] = useState<{ value: { readiness: Readiness; sends: SendCopy[] } | null; problem: string | null }>({ value: null, problem: null })
  const [confirm, setConfirm] = useState<'live' | 'test' | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<DepthProblem | null>(null)
  const [notice, setNotice] = useState<EInvoicingModel['notice']>(null)
  const { stepUp, guard, ensureFresh, submitStepUp, cancelStepUp } = useStepUp(api)

  const read = useCallback(async () => {
    const [settings, copied] = await Promise.allSettled([getEInvoicing(api), getCopies(api, companyId)])
    if (settings.status === 'fulfilled') {
      const mine = settings.value.find((entry) => entry.companyId === companyId) ?? null
      setCompany(mine ? { value: mine, problem: null } : { value: null, problem: 'problem.read.not_found' })
    } else setCompany({ value: null, problem: readProblem(settings.reason) })
    if (copied.status === 'fulfilled') setCopies({ value: copied.value, problem: null })
    else setCopies({ value: null, problem: readProblem(copied.reason) })
  }, [api, companyId])
  useEffect(() => {
    setCompany({ value: null, problem: null })
    setCopies({ value: null, problem: null })
    void read()
  }, [read])
  const reread = useCoalesced(() => void read(), 900)
  useLive(
    (change) => {
      if (eInvoicingTouched(change)) reread()
    },
    () => reread(),
  )

  /** A settings write after a fresh code: the pop-up closed, a notice; a refusal said on the card (the pop-up closed too). */
  const settingsWrite = (body: { testMode?: boolean; simulateOutcome?: SimulatedOutcome }, done: EInvoicingModel['notice']) => {
    const current = company.value
    if (busy || !current) return
    const key = newIdempotencyKey()
    setBusy(true)
    setProblem(null)
    setNotice(null)
    void (async () => {
      try {
        await ensureFresh(scoped('sdi.stepUp'))
        const saved = await guard(scoped('sdi.stepUp'), () => putTestMode(api, companyId, { ...(current.version !== null ? { version: current.version } : {}), ...body }, key))
        setCompany({ value: saved, problem: null })
        setConfirm(null)
        setNotice(done)
      } catch (error) {
        if (isStepUpCancelled(error)) return
        const words = depthProblem(error, SDI_REFUSALS)
        setConfirm((open) => (open === 'test' ? open : null))
        setProblem(words)
        if (words.reload) void read()
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <>
      <EInvoicingCards
        model={{ canIssue, company, copies, confirm, busy, problem, notice }}
        actions={{
          onRetry: () => void read(),
          onDismissNotice: () => setNotice(null),
          onConfirm: (next) => {
            setProblem(null)
            setConfirm(next)
          },
          onGoLive: () => settingsWrite({ testMode: false }, { tone: 'success', words: { key: 'sdi.wentLive' } }),
          onBackToTest: () => settingsWrite({ testMode: true }, { tone: 'success', words: { key: 'sdi.backInTest' } }),
          onSimulate: (outcome) => settingsWrite({ simulateOutcome: outcome }, { tone: 'success', words: { key: `sdi.simulated.${outcome}` } }),
          onMakeCopies: () => {
            if (busy) return
            setBusy(true)
            setProblem(null)
            setNotice(null)
            void (async () => {
              try {
                const answer = await makeCopies(api, companyId, newIdempotencyKey())
                setCopies((current) => (current.value ? { value: { ...current.value, readiness: answer.readiness }, problem: null } : current))
                setNotice({ tone: answer.remaining > 0 ? 'warning' : 'success', words: { key: 'swap.made', params: { made: answer.made, completed: answer.completed, remaining: answer.remaining } } })
                void read()
              } catch (error) {
                setProblem(depthProblem(error, SDI_REFUSALS))
              } finally {
                setBusy(false)
              }
            })()
          },
        }}
      />
      <DepthStepUp stepUp={stepUp} onSubmit={(code) => void submitStepUp(code)} onCancel={cancelStepUp} />
    </>
  )
}
