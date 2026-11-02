'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { useLiveChanges } from '../../../record-panels/live'
import { useFloor, useFloorRouter } from '../../FloorApp'
import { useFloorKeys } from '../../keys'
import { isBadgeCode } from '../../model'
import { AsOfMemory } from '../shared/as-of'
import { queuedView } from '../shared/queued'
import type { QueueItem } from '../../queue/model'
import { clockProved, fetchClock, fetchOpenWork, fetchTabletClock, newClockEventId, tapOrKeep, type ClockOutcome, type ClockProof, type Recorded } from './api'
import { afterAction, mainActionOf, pausedAtClockOut, RECEIPT_MS, runningBundles, type ClockAction, type ClockView, type OpenWork, type Receipt } from './model'
import { ClockScreen, type ClockAct, type ClockStep, type ClockViewModel } from './view/ClockView'

/**
 * The live SCR-170 (`/floor/clock`): the worker's time today from GET /people/clock/floor, Clock in, out and Break through
 * POST /people/clock/floor; a badge scanned here, or a name and PIN, through POST /people/clock/scan (the person of the
 * badge, not always the one signed in). Offline: the signed-in person's taps go through the tablet's queue
 * (`people.clock.record`) and a badge scanned is sealed until sent (kept.ts). Only a network failure falls back to them: a
 * refusal is shown, never queued. The fallback keeps the id of the try, so an answer lost on its way back is never a second
 * clock-in (queue/online-first.ts; B-W2b-77). Nobody signed in, the page is a kiosk: it stays on the scan, and a person's answer
 * leaves the screen after a few seconds. Read again on a shift change, on the live channel's reconnect and on a beat.
 */

/** The last answer per person for the rest of the visit: offline the page opens from it, with its as-of time; never another person's. */
const KEPT = new AsOfMemory<ClockView>(8)
const OPEN = new AsOfMemory<OpenWork>(8)

/** The live messages after which the person's time may differ (each a hint: the screen reads again). */
const MOVES = new Set(['shift.assigned', 'roster.published'])
const REREAD_MS = 60_000
/** The clock-out's pause runs in the worker: its answer is read a moment after. */
const PAUSE_READS_MS = [1500, 5000]

type Screen = 'loading' | 'ready' | 'closed' | 'noRole' | 'unavailable'

export function FloorClock() {
  const store = useFloor()
  const router = useFloorRouter()
  const feedback = useConfirmFeedback()
  const { me, device, online, api, kept, keptSnapshot, queue, queueSnapshot, sessionEnded } = store
  const signedIn = Boolean(me && !me.pinMustChange)
  const workerId = signedIn ? me!.worker.id : null
  const readsOpen = Boolean(me?.permissions.includes('production.scan'))
  const { frame, onFrame } = store.frame('tile.clock', { showHome: true, crew: true })

  const [screen, setScreen] = useState<Screen>('loading')
  const [read, setRead] = useState<{ view: ClockView; readAt: number; asOf: string | null } | null>(null)
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<readonly string[] | null>(null)
  const [open, setOpen] = useState<OpenWork | null>(null)
  const [willPause, setWillPause] = useState<readonly string[]>([])
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState<'clock' | 'names' | 'pin' | 'choose'>('clock')
  const [pinProblem, setPinProblem] = useState<ClockViewModel['pinProblem']>(null)
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null)
  const acting = useRef(false)
  const badge = useRef<{ readonly code: string; readonly clientEventId: string } | null>(null)
  const clearing = useRef<number | null>(null)

  const stayFor = useCallback((next: Receipt | null, timed: boolean) => {
    if (clearing.current !== null) window.clearTimeout(clearing.current)
    clearing.current = null
    setReceipt(next)
    if (next && timed) clearing.current = window.setTimeout(() => setReceipt(null), RECEIPT_MS)
  }, [])
  useEffect(() => () => {
    if (clearing.current !== null) window.clearTimeout(clearing.current)
  }, [])

  const readOpen = useCallback(async (): Promise<OpenWork | null> => {
    if (!readsOpen || !workerId) return null
    if (!online) return OPEN.get(workerId)?.value ?? null
    const answer = await fetchOpenWork(api)
    if (!answer.ok) return OPEN.get(workerId)?.value ?? null
    OPEN.keep(workerId, answer.value)
    setOpen(answer.value)
    return answer.value
  }, [api, online, readsOpen, workerId])

  const refresh = useCallback(async () => {
    if (!workerId) {
      // A clock known to be closed stays closed offline: nothing is kept for a site that does not clock.
      if (!online) return setScreen((now) => (now === 'closed' ? now : 'ready'))
      const answer = await fetchTabletClock(api)
      return setScreen(answer.ok ? (answer.value.open ? 'ready' : 'closed') : answer.problem.kind === 'offline' ? 'ready' : 'unavailable')
    }
    const memory = () => {
      const known = KEPT.get(workerId)
      setRead(known ? { view: known.value, readAt: Date.now(), asOf: known.asOf } : null)
      setScreen((now) => (now === 'closed' ? now : 'ready'))
    }
    if (!online) return memory()
    const answer = await fetchClock(api)
    if (answer.ok) {
      KEPT.keep(workerId, answer.value)
      setRead({ view: answer.value, readAt: Date.now(), asOf: null })
      return setScreen('ready')
    }
    switch (answer.problem.kind) {
      case 'closed':
        return setScreen('closed')
      case 'forbidden':
        return setScreen('noRole')
      case 'signedOut':
        return void sessionEnded()
      case 'offline':
        return memory()
      default:
        return setScreen('unavailable')
    }
  }, [api, online, sessionEnded, workerId])

  useEffect(() => {
    void refresh()
    void readOpen()
  }, [refresh, readOpen])
  useEffect(() => {
    if (!online) return
    const timer = window.setInterval(() => void refresh(), REREAD_MS)
    return () => window.clearInterval(timer)
  }, [online, refresh])
  useLiveChanges(
    {
      onChange: (change) => {
        if (MOVES.has(change.type)) void refresh()
      },
      onReconnect: () => void refresh(),
    },
    signedIn && online,
  )

  // A queued action reached the office: the person's time is read again.
  const queued = useMemo(() => queuedView({ items: queueSnapshot.items, online: queueSnapshot.online, sending: queueSnapshot.sending }, saved), [queueSnapshot.items, queueSnapshot.online, queueSnapshot.sending, saved])
  useEffect(() => {
    if (queued?.ticks !== 'recorded') return
    setSaved(null)
    void refresh()
  }, [queued?.ticks, refresh])

  const paused = () => pausedAtClockOut(open)

  /** After a clock-out: what it paused, read as the worker gets to it; until then what it will pause. */
  const afterOut = (will: readonly string[]) => {
    setWillPause(will)
    if (will.length === 0 && !readsOpen) return
    for (const wait of PAUSE_READS_MS) window.setTimeout(() => void readOpen(), wait)
  }

  const clockWrong = Boolean(queueSnapshot.clock?.off)

  /** The office's answer to a clock of any kind. */
  const answered = (outcome: ClockOutcome<Recorded>, how: { mine: boolean }): boolean => {
    if (outcome.ok) {
      const { event, repeated, clock } = outcome.value
      const own = clock.person.workerId === workerId
      if (own) {
        KEPT.keep(workerId!, clock)
        setRead({ view: clock, readAt: Date.now(), asOf: null })
      }
      feedback(repeated ? 'warning' : 'success')
      stayFor({ kind: 'recorded', action: event.kind, at: event.occurredAt, repeated, name: own ? null : clock.person.name, flags: event.flags }, !own)
      return true
    }
    feedback('error')
    switch (outcome.problem.kind) {
      case 'closed':
        setScreen('closed')
        break
      case 'refused':
        stayFor({ kind: 'refused', code: outcome.problem.code, message: outcome.problem.message, fix: outcome.problem.fix }, !how.mine)
        break
      case 'signedOut':
        // The person's own tap: their session ended. A badge or a PIN: the one uniform answer.
        if (how.mine) void sessionEnded()
        else stayFor({ kind: 'wrong' }, true)
        break
      case 'rateLimited':
        stayFor({ kind: 'rateLimited' }, true)
        break
      default:
        stayFor({ kind: 'unavailable' }, true)
    }
    return false
  }

  /** The signed-in person's action, kept on this tablet with its time. */
  const savedHere = (item: QueueItem, action: ClockAction) => {
    const at = item.occurredAt
    setSaved(item.clientEventId)
    setRead((current) => (current ? { ...current, view: afterAction(current.view, action, at) } : current))
    feedback('success')
    stayFor({ kind: 'saved', action, at, clockWrong }, false)
  }

  const act = async (action: ClockAction) => {
    if (acting.current) return
    acting.current = true
    setBusy(true)
    const will = action === 'OUT' ? runningBundles(open) : []
    try {
      const sent = await tapOrKeep(api, queue, online, action)
      if (sent.kept) {
        savedHere(sent.kept, action)
        if (action === 'OUT') setWillPause(will)
        return
      }
      if (sent.answer.ok && sent.answer.value.event.kind === 'OUT') afterOut(will)
      answered(sent.answer, { mine: true })
    } finally {
      acting.current = false
      setBusy(false)
    }
  }

  /** Clock out asks first when it pauses open work; a badge scanned never asks. */
  const tap = async (action: ClockAction) => {
    if (acting.current) return
    if (action !== 'OUT') return act(action)
    acting.current = true
    const work = await readOpen()
    acting.current = false
    const running = runningBundles(work)
    if (running.length > 0) return setConfirm(running)
    return act('OUT')
  }

  const prove = async (proof: ClockProof, clientEventId: string) => {
    setBusy(true)
    const answer = await clockProved(api, proof, clientEventId, new Date().toISOString())
    setBusy(false)
    return answer
  }

  const scan = async (code: string) => {
    if (acting.current) return
    if (!isBadgeCode(code)) {
      feedback('error')
      return stayFor({ kind: 'notBadge' }, true)
    }
    // One id for this scan: kept after a network failure it goes under the id the try used, and the office answers the event it may hold.
    const clientEventId = newClockEventId()
    if (!online) {
      badge.current = { code, clientEventId }
      return setStep('choose')
    }
    acting.current = true
    const answer = await prove({ badgeCode: code }, clientEventId)
    acting.current = false
    if (!answer.ok && answer.problem.kind === 'offline') {
      badge.current = { code, clientEventId }
      return setStep('choose')
    }
    if (answer.ok && answer.value.event.kind === 'OUT' && answer.value.clock.person.workerId === workerId) afterOut(runningBundles(open))
    answered(answer, { mine: false })
  }

  const onAction = async (action: ClockAct) => {
    switch (action.type) {
      case 'action':
        return tap(action.action)
      case 'scan':
        return scan(action.code)
      case 'confirm':
        setConfirm(null)
        return act('OUT')
      case 'cancel-confirm':
        return setConfirm(null)
      case 'forgot':
        if (!online) return
        setPinProblem(null)
        return setStep('names')
      case 'name': {
        const person = device?.roster.find((entry) => entry.id === action.workerId)
        setPicked(person ? { id: person.id, name: person.displayName } : null)
        setPinProblem(null)
        return setStep(person ? 'pin' : 'clock')
      }
      case 'pin': {
        if (!picked) return setStep('clock')
        const answer = await prove({ workerId: picked.id, pin: action.pin }, newClockEventId())
        if (!answer.ok && answer.problem.kind === 'signedOut') {
          feedback('error')
          return setPinProblem('wrong')
        }
        if (!answer.ok && answer.problem.kind === 'rateLimited') {
          feedback('error')
          return setPinProblem('rateLimited')
        }
        if (!answer.ok && (answer.problem.kind === 'offline' || answer.problem.kind === 'unavailable')) {
          feedback('error')
          return setPinProblem('unavailable')
        }
        setPicked(null)
        setStep('clock')
        answered(answer, { mine: false })
        return
      }
      case 'back':
        badge.current = null
        setPicked(null)
        return setStep(step === 'pin' ? 'names' : 'clock')
      case 'choose': {
        const held = badge.current
        badge.current = null
        if (!held) return setStep('clock')
        const at = new Date().toISOString()
        const done = await kept.add(held.code, action.action, held.clientEventId)
        setStep('clock')
        if (!done) {
          feedback('error')
          return stayFor({ kind: 'unavailable' }, true)
        }
        feedback('success')
        return stayFor({ kind: 'saved', action: action.action, at, clockWrong }, true)
      }
      case 'retry':
        setScreen('loading')
        return refresh()
      case 'dismiss-kept':
        return kept.dismiss(action.clientEventId)
      case 'sign-in':
        return router.replace('/floor/sign-in')
    }
  }

  const screenStep = (): ClockStep => {
    if (screen === 'loading') return { kind: 'loading' }
    if (screen === 'closed') return { kind: 'closed' }
    if (screen === 'noRole') return { kind: 'noRole' }
    if (screen === 'unavailable') return { kind: 'unavailable' }
    if (step === 'names') return { kind: 'names' }
    if (step === 'pin' && picked) return { kind: 'pin', name: picked.name }
    if (step === 'choose') return { kind: 'choose' }
    return signedIn ? { kind: 'mine', view: read?.view ?? null, readAt: read?.readAt ?? Date.now(), asOf: read?.asOf ?? null } : { kind: 'kiosk' }
  }
  const shown = screenStep()

  useFloorKeys({
    enter: shown.kind === 'mine' && !confirm && !busy ? () => void onAction({ type: 'action', action: mainActionOf(shown.view) }) : null,
    escape: step !== 'clock' ? () => void onAction({ type: 'back' }) : null,
    enterFromScan: true,
  })

  return (
    <ClockScreen
      model={{
        frame,
        step: shown,
        online,
        receipt,
        ticks: queued?.ticks ?? null,
        confirm,
        paused: paused(),
        willPause,
        busy,
        roster: (device?.roster ?? []).map((entry) => ({ id: entry.id, name: entry.displayName })),
        forgot: device?.rules?.signIn !== 'ONE_PERSON',
        pinProblem,
        kept: { waiting: keptSnapshot.waiting, available: keptSnapshot.available, refused: keptSnapshot.refused },
      }}
      onFrame={onFrame}
      onAction={(action) => void onAction(action)}
    />
  )
}
