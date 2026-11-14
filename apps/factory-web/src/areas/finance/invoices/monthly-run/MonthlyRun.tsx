'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { isStepUpCancelled, useCoalesced, useLive, useStepUp } from '../../_shared/hooks'
import { abilitiesOf, readProblem, romeToday, type Phrase } from '../../_shared/model'
import { scoped, type DepthProblem } from '../test-mode/depth'
import { DepthStepUp } from '../test-mode/view/DepthStepUp'
import { createRun, deleteRun, getRun, issueRun, listRuns, pickRun, runCandidates, runTouched, type Candidates, type IssuedRun, type Run, type RunRow } from './api'
import { presetPicked, runMonths, runProblem, type RunPhase } from './model'
import { MonthlyRunDialog } from './view/MonthlyRunDialog'

/**
 * The monthly invoice run's container (B-W2b-417 on B-W2b-396's API), opened from Invoices' ⋯: the company of the address,
 * the month (the one before by default). It opens the month's live PREVIEW when there is one, else reads the customers
 * with deferred invoicing; writes one at a time, each with an Idempotency-Key and the run's version (a moved run is read
 * again and said); issuing asks the month typed, then a fresh authenticator code first. Live: a run, an invoice or a DDT
 * event reads the open step again (never while the person types the phrase or a write runs).
 */
export function MonthlyRun({ onClose }: { onClose: () => void }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const pathname = usePathname()
  const prefix = pathname.replace(/\/finance\/invoices(\/.*)?$/, '')
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  const companyId = session.company?.id ?? null
  const { months, preset } = useMemo(() => runMonths(romeToday()), [])
  const [month, setMonth] = useState(preset)
  const [phase, setPhase] = useState<RunPhase>('pick')
  const [candidates, setCandidates] = useState<{ value: Candidates | null; problem: string | null }>({ value: null, problem: null })
  const [issuedRun, setIssuedRun] = useState<RunRow | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [run, setRun] = useState<Run | null>(null)
  const [skipped, setSkipped] = useState(0)
  const [repick, setRepick] = useState(false)
  const [send, setSend] = useState(true)
  const [typed, setTyped] = useState('')
  const [result, setResult] = useState<IssuedRun | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<DepthProblem | null>(null)
  const [notice, setNotice] = useState<Phrase | null>(null)
  const { stepUp, guard, ensureFresh, submitStepUp, cancelStepUp } = useStepUp(api)
  const quiet = useRef(false)
  quiet.current = busy || phase === 'confirm' || phase === 'done'

  const readCandidates = useCallback(
    async (forMonth: string, runId: string | null, keep: string[] | null) => {
      if (!companyId) return
      setCandidates({ value: null, problem: null })
      try {
        const answer = await runCandidates(api, companyId, forMonth)
        setCandidates({ value: answer, problem: null })
        setPicked(keep ?? presetPicked(answer.customers, runId))
      } catch (error) {
        setCandidates({ value: null, problem: readProblem(error) })
      }
    },
    [api, companyId],
  )

  const readMonth = useCallback(
    async (forMonth: string) => {
      if (!companyId) return
      setRun(null)
      setIssuedRun(null)
      setRepick(false)
      setPhase('pick')
      setCandidates({ value: null, problem: null })
      try {
        const runs = await listRuns(api, companyId, forMonth)
        setIssuedRun(runs.find((row) => row.status === 'ISSUED') ?? null)
        const preview = runs.find((row) => row.status === 'PREVIEW')
        if (preview) {
          setRun(await getRun(api, preview.id))
          setPhase('preview')
          return
        }
      } catch (error) {
        setCandidates({ value: null, problem: readProblem(error) })
        return
      }
      await readCandidates(forMonth, null, null)
    },
    [api, companyId, readCandidates],
  )

  useEffect(() => {
    void readMonth(month)
  }, [readMonth, month])

  const readRun = useCallback(async () => {
    if (!run) return
    try {
      setRun(await getRun(api, run.id))
    } catch (error) {
      setProblem({ key: readProblem(error), reload: false })
    }
  }, [api, run])

  const reread = useCoalesced(() => {
    if (quiet.current) return
    if (phase === 'preview') void readRun()
    else if (phase === 'pick' && !repick) void readCandidates(month, null, picked)
  }, 900)
  useLive(
    (change) => {
      if (runTouched(change)) reread()
    },
    () => reread(),
  )

  /** One write: busy while it runs, its refusal said in the dialog (a moved run read again). */
  const write = async (work: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setProblem(null)
    setNotice(null)
    try {
      await work()
    } catch (error) {
      if (isStepUpCancelled(error)) return
      const words = runProblem(error)
      setProblem(words)
      if (words.reload) {
        if (run) void readRun()
        else void readCandidates(month, null, picked)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <MonthlyRunDialog
        model={{ can, prefix, months, month, phase, candidates, issuedRun, picked, run, skipped, repick, send, typed, result, busy, problem, notice }}
        actions={{
          onMonth: (next) => {
            setProblem(null)
            setNotice(null)
            setMonth(next)
          },
          onPicked: setPicked,
          onRetry: () => void readMonth(month),
          onCreate: () =>
            void write(async () => {
              if (!companyId) return
              const answer = await createRun(api, { companyId, month, partyIds: picked }, newIdempotencyKey())
              setRun(answer.run)
              setSkipped(answer.skipped.length)
              setPhase('preview')
            }),
          onRepick: () => {
            if (!run) return
            setProblem(null)
            setRepick(true)
            setPhase('pick')
            void readCandidates(run.month, run.id, run.customers.map((customer) => customer.partyId))
          },
          onUsePicked: () =>
            void write(async () => {
              if (!run) return
              const answer = await pickRun(api, run, picked, newIdempotencyKey())
              setRun(answer.run)
              setSkipped(answer.skipped.length)
              setRepick(false)
              setPhase('preview')
            }),
          onDelete: () =>
            void write(async () => {
              if (!run) return
              const answer = await deleteRun(api, run, newIdempotencyKey())
              await readMonth(month)
              setNotice({ key: 'run.deleted', params: { count: answer.draftsLetGo } })
            }),
          onConfirm: () => {
            setProblem(null)
            setTyped('')
            setPhase('confirm')
          },
          onBack: () => {
            setProblem(null)
            setRepick(false)
            setPhase('preview')
          },
          onSend: setSend,
          onTyped: setTyped,
          onIssue: () => {
            const key = newIdempotencyKey()
            void write(async () => {
              if (!run) return
              await ensureFresh(scoped('run.stepUp'))
              const answer = await guard(scoped('run.stepUp'), () => issueRun(api, run, send, key))
              setResult(answer)
              setRun(answer.run)
              setPhase('done')
            })
          },
          onClose,
        }}
      />
      <DepthStepUp stepUp={stepUp} onSubmit={(code) => void submitStepUp(code)} onCancel={cancelStepUp} />
    </>
  )
}
