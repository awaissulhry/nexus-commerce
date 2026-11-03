'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { useLiveChanges } from '../../../record-panels/live'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useFloor, useFloorRouter } from '../../FloorApp'
import { useFloorKeys } from '../../keys'
import { TASK_ROUTES } from '../routes'
import { AsOfMemory } from '../shared/as-of'
import { queuedView } from '../shared/queued'
import type { TaskProblem } from '../shared/task-api'
import { addDetails, readHelpStation, type HelpCall, type HelpStation } from './api'
import { askOf, CALL_ANSWER, CALL_SEND, callWords, closePayload, detailsHeld, detailsOf, newlyOnTheWay, queuedCalls, reasonPicked, sendPayload, tilePress } from './model'
import { HelpView, type HelpAction, type HelpStep } from './view/HelpView'

/**
 * The live SCR-172 (`/floor/help`; B-W2b-70 on the API of B-W2b-35): one tap saves the call in the tablet's queue
 * (`andon.call.send`: it works offline and the office records it once; a second tap shows the call, never a second one),
 * the two ticks follow it, and the open call is read again when the office recorded it, on every live hint from the
 * responder (`help_call.*`: "On my way" plays the success sound) and on a beat while the screen is in view (a missed hint).
 * "It's solved" and "Cancel call" queue too (`andon.call.answer`); details on a call need the network: words, and on a
 * material call why and how much (B-W2b-81; MES-137). What the tablet read stays for this visit with its time (offline: "as of").
 */

const KEPT = new AsOfMemory<HelpStation>(1)
const REREAD_MS = 20_000
const LIVE = new Set(['help_call.raised', 'help_call.answered', 'help_call.changed', 'help_call_type.changed'])

export function FloorHelp() {
  const store = useFloor()
  const router = useFloorRouter()
  const feedback = useConfirmFeedback()
  const { frame, onFrame } = store.frame('tile.help', { showHome: true })
  const { api, me, online, sessionEnded, queue, queueSnapshot } = store
  const [station, setStation] = useState<{ readonly value: HelpStation; readonly asOf: string | null } | null>(null)
  const [step, setStep] = useState<HelpStep>({ kind: 'loading' })
  const current = useRef(step)
  current.current = step
  const open = useRef<readonly HelpCall[]>([])
  /** The words' key, kept while their answer is lost (a resend is answered once). */
  const detailsKey = useRef<string | null>(null)
  const followed = useRef<string | null>(null)

  const read = useCallback(async (): Promise<HelpStation | null> => {
    const answer = await readHelpStation(api)
    if (!answer.ok) {
      if (answer.problem.kind === 'signedOut') {
        void sessionEnded()
        return null
      }
      const kept = KEPT.get('station')
      const waits = answer.problem.kind === 'offline' || answer.problem.kind === 'unavailable'
      if (kept && waits) {
        setStation({ value: kept.value, asOf: kept.asOf })
        setStep((now) => (now.kind === 'loading' ? { kind: 'tiles' } : now))
        return kept.value
      }
      const problem: TaskProblem = answer.problem
      setStep((now) => (now.kind === 'loading' || now.kind === 'tiles' ? { kind: 'problem', problem } : now))
      return null
    }
    KEPT.keep('station', answer.value)
    if (newlyOnTheWay(open.current, answer.value.open)) feedback('success')
    open.current = answer.value.open
    setStation({ value: answer.value, asOf: null })
    setStep((now) => (now.kind === 'loading' ? { kind: 'tiles' } : now))
    return answer.value
  }, [api, feedback, sessionEnded])

  // On opening, and when the network is back.
  useEffect(() => {
    if (me) void read()
  }, [me, online, read])

  // In view: read again on the beat, and when the tablet comes back to this screen.
  useEffect(() => {
    if (!me || !online) return
    const again = () => {
      if (document.visibilityState === 'visible') void read()
    }
    const timer = window.setInterval(again, REREAD_MS)
    document.addEventListener('visibilitychange', again)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', again)
    }
  }, [me, online, read])

  useLiveChanges(
    {
      onChange: (change) => {
        if (LIVE.has(change.type)) void read()
      },
      onReconnect: () => void read(),
    },
    Boolean(me) && online,
  )

  // The saved call's and close's ticks; once the office recorded a call, the card opens with who is coming.
  useEffect(() => {
    const shown = current.current
    if (shown.kind !== 'queued' && shown.kind !== 'closed') return
    const view = queuedView(queueSnapshot, shown.clientEventId)
    if (!view) return
    const refusal = view.refusal ? { code: view.refusal.code, message: view.refusal.message } : null
    if (view.ticks !== shown.ticks || (refusal?.code ?? null) !== (shown.refusal?.code ?? null)) setStep({ ...shown, ticks: view.ticks, refusal })
    if (view.ticks !== 'recorded' || followed.current === shown.clientEventId) return
    followed.current = shown.clientEventId
    if (shown.kind === 'closed') return void read()
    void read().then((value) => {
      const now = current.current
      if (now.kind !== 'queued' || now.clientEventId !== shown.clientEventId) return
      const call = value?.open.find((entry) => entry.type.id === shown.typeId)
      if (call) setStep({ kind: 'call', callId: call.id })
    })
  }, [queueSnapshot, read])

  const callOf = useCallback((id: string) => station?.value.open.find((call) => call.id === id) ?? null, [station])
  const queued = useMemo(() => queuedCalls(queueSnapshot.items), [queueSnapshot.items])

  const press = async (typeId: string) => {
    const tile = station?.value.tiles.find((entry) => entry.type.id === typeId)
    if (!tile || !station?.value.station) return
    const what = tilePress(tile, queued)
    feedback('success')
    if (what.kind === 'open') return setStep({ kind: 'call', callId: what.callId })
    if (what.kind === 'queued') return setStep({ kind: 'queued', clientEventId: what.clientEventId, typeId, ticks: 'saved', refusal: null })
    try {
      const item = await queue.enqueue(CALL_SEND, sendPayload(what.type))
      setStep({ kind: 'queued', clientEventId: item.clientEventId, typeId, ticks: 'saved', refusal: null })
    } catch {
      feedback('error')
      setStep({ kind: 'problem', problem: { kind: 'unavailable' } })
    }
  }

  const close = async (what: 'SOLVED' | 'CANCELLED') => {
    const shown = current.current
    const call = shown.kind === 'call' ? callOf(shown.callId) : null
    if (!call) return
    try {
      const item = await queue.enqueue(CALL_ANSWER, closePayload(call, what))
      feedback('success')
      setStep({ kind: 'closed', clientEventId: item.clientEventId, what, type: callWords(call.type, store.locale), ticks: 'saved', refusal: null })
    } catch {
      feedback('error')
      setStep({ kind: 'problem', problem: { kind: 'unavailable' } })
    }
  }

  const sendDetails = async () => {
    const shown = current.current
    if (shown.kind !== 'details' || shown.busy) return
    const call = callOf(shown.callId)
    if (!call || detailsHeld(shown.words, online, shown.ask, Boolean(call.note))) return
    detailsKey.current ??= newIdempotencyKey()
    setStep({ ...shown, busy: true, problem: null })
    const answer = await addDetails(api, call, detailsOf(shown.words, shown.ask), detailsKey.current)
    if (!answer.ok) {
      if (answer.problem.kind === 'signedOut') return void sessionEnded()
      feedback('error')
      return setStep({ ...shown, busy: false, problem: answer.problem })
    }
    detailsKey.current = null
    feedback('success')
    await read()
    setStep({ kind: 'call', callId: call.id, done: shown.ask ? 'ask' : 'details' })
  }

  const back = () => {
    const shown = current.current
    switch (shown.kind) {
      case 'tiles':
      case 'loading':
        return router.push('/floor')
      case 'details': {
        const ask = shown.ask
        if (ask?.stage === 'words') return setStep({ ...shown, ask: { ...ask, stage: ask.askQuantity ? 'quantity' : 'reason' } })
        if (ask?.stage === 'quantity' && ask.reason !== null) return setStep({ ...shown, ask: { ...ask, stage: 'reason' } })
        return setStep({ kind: 'call', callId: shown.callId })
      }
      default:
        setStep({ kind: 'tiles' })
        return void read()
    }
  }

  const onAction = (action: HelpAction) => {
    const shown = current.current
    switch (action.type) {
      case 'tile':
        return void press(action.typeId)
      case 'back':
        return back()
      case 'home':
        return router.push('/floor')
      case 'solved':
        return void close('SOLVED')
      case 'askCancel':
        if (shown.kind === 'call') setStep({ ...shown, cancelling: true })
        return
      case 'keep':
        if (shown.kind === 'call') setStep({ ...shown, cancelling: false })
        return
      case 'cancel':
        return void close('CANCELLED')
      case 'details':
        if (shown.kind === 'call') {
          detailsKey.current = null
          const call = callOf(shown.callId)
          setStep({ kind: 'details', callId: shown.callId, words: '', ask: call ? askOf(call) : null })
        }
        return
      case 'reason':
        if (shown.kind === 'details' && shown.ask) setStep({ ...shown, ask: reasonPicked(shown.ask, action.code) })
        return
      case 'quantity':
        if (shown.kind === 'details' && shown.ask) setStep({ ...shown, ask: { ...shown.ask, quantity: action.value } })
        return
      case 'addWords':
        if (shown.kind === 'details' && shown.ask) setStep({ ...shown, ask: { ...shown.ask, stage: 'words' } })
        return
      case 'words':
        if (shown.kind === 'details') setStep({ ...shown, words: action.text })
        return
      case 'sendDetails':
        return void sendDetails()
      case 'machine':
        return router.push(TASK_ROUTES.machine)
    }
  }

  useFloorKeys({ escape: back })

  if (!me) return null
  return <HelpView model={{ frame, online, step, station: station?.value ?? null, asOf: station?.asOf ?? null, queued }} onAction={onAction} onFrame={onFrame} />
}
