'use client'

import { useCallback, useEffect, useState } from 'react'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { newIdempotencyKey } from '../../lib/api/client'
import { useT } from '../../lib/i18n/provider'
import { useLiveChanges } from '../../record-panels/live'
import { FloorFrameView } from '../frame/view/FloorFrameView'
import { useFloor, useFloorRouter } from '../FloorApp'
import { useFloorKeys } from '../keys'
import { readFloorChain, reportNext, type FloorChain } from './api'
import { lineOf, reportBody, stepOf, undoOpen, undoPayload, UNDO_KIND, type LastReport } from './model'
import { ChainView, type ChainAction } from './view/ChainView'

/**
 * owb-fl9 step 3 — the live `/floor/chains`: the device's chain (a line tablet's line), ONE step, its lots; "+12" online (the server
 * picks the bundle: `POST /production/chains/report`), "−12" = the own Undo of that report through the queue (works offline too, while
 * today's two minutes last). Read again on a live change of the floor.
 */
export function FloorChainPage() {
  const store = useFloor()
  const router = useFloorRouter()
  const t = useT('floor-board')
  const feedback = useConfirmFeedback()
  const { frame, onFrame } = store.frame('tile.chains', { showHome: true })
  const { api, me, device, online, queue, sessionEnded } = store
  const lineId = lineOf(me, device)
  const [chain, setChain] = useState<FloorChain | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [step, setStep] = useState<string | null>(null)
  const [last, setLast] = useState<LastReport | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const read = useCallback(async () => {
    if (!lineId) return
    const answer = await readFloorChain(api, lineId)
    if (answer.ok) {
      setChain(answer.value)
      setState('ready')
      setStep((current) => stepOf(answer.value, current))
      return
    }
    if (answer.problem.kind === 'signedOut') return void sessionEnded()
    setState((current) => (current === 'ready' ? current : 'failed'))
  }, [api, lineId, sessionEnded])

  useEffect(() => {
    if (me) void read()
  }, [me, online, read])

  useLiveChanges({ onChange: (change) => (change.type.startsWith('production.') ? void read() : undefined), onReconnect: () => void read() }, Boolean(me) && online && Boolean(lineId))

  // The −12 stands for today's two minutes: the clock ticks while one is open.
  useEffect(() => {
    if (!last) return
    const timer = window.setInterval(() => setNow(Date.now()), 5_000)
    return () => window.clearInterval(timer)
  }, [last])

  const plus = async (workOrderSizeId: string) => {
    if (!lineId || !step || busy || !online) return
    setBusy(workOrderSizeId)
    setProblem(null)
    const answer = await reportNext(api, reportBody(lineId, step, workOrderSizeId, newIdempotencyKey()))
    setBusy(null)
    if (!answer.ok) {
      if (answer.problem.kind === 'signedOut') return void sessionEnded()
      feedback('error')
      return setProblem(answer.problem.kind === 'refused' ? answer.problem.message || t('chain.failed') : answer.problem.kind === 'offline' ? t('chain.offline') : t('chain.failed'))
    }
    feedback('success')
    setLast({ workOrderSizeId, operationId: step, scanId: answer.value.scan.id, quantity: answer.value.bundle.quantity, bundleCode: answer.value.bundle.code, at: Date.now() })
    setNow(Date.now())
    void read()
  }

  const minus = async () => {
    if (!last || !undoOpen(last, last.workOrderSizeId, last.operationId, Date.now())) return
    try {
      await queue.enqueue(UNDO_KIND, undoPayload(last))
      feedback('success')
      setLast(null)
      void read()
    } catch {
      feedback('error')
      setProblem(t('chain.failed'))
    }
  }

  const onAction = (action: ChainAction) => {
    switch (action.type) {
      case 'step':
        return setStep(action.operationId)
      case 'plus':
        return void plus(action.workOrderSizeId)
      case 'minus':
        return void minus()
      case 'retry':
        setState('loading')
        return void read()
    }
  }

  useFloorKeys({ escape: () => router.push('/floor') })

  if (!me) return null
  return (
    <FloorFrameView frame={frame} onFrame={onFrame}>
      <ChainView model={{ lineId, chain, step, state, online, last, now, busy, problem }} onAction={onAction} />
    </FloorFrameView>
  )
}
