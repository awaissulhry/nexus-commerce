'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useConfirmFeedback, useIdleSignOut } from '@nexus/ui/floor'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useLiveChanges } from '../../../record-panels/live'
import { useFloor, useFloorRouter } from '../../FloorApp'
import { useFloorKeys } from '../../keys'
import { readScan } from '../../scan/scan-model'
import { useWedgeScans } from '../scans/wedge'
import { floorStepUp, steppedUp } from '../shared/step-up'
import type { TaskProblem } from '../shared/task-api'
import { printStatement, raiseDispute, readMine, readMyDay, statementPdfHref, withdrawDispute, type MyDispute } from './api'
import { answeredDisputes, CLOSE_IDLE_MS, CLOSE_WARN_MS, firstOfMonth, markSeen, MESSAGE_MAX, readSeen, sendHeld, unreadAnswers, type MyDayData, type MyRow } from './model'
import { MyDayScreen, type MyDayAction, type MyDayStep } from './view/MyDayScreen'

/**
 * The live SCR-171 (`/floor/myday`; B-W2b-68). A worker's own day on a tablet other people can see, so the figures live in THIS
 * component's state and nowhere else: no memory, no cache, no storage, no queue. They go when the person changes (a new `key`),
 * when the tab leaves the view, when the network goes, after 60 s without a touch, and with Done. Opening always asks the PIN,
 * even a moment after a PIN sign-in: the API's two minutes stand for one moment at a tablet, not for whoever stands there next.
 * A later read that finds the two minutes over asks it again and goes on with the same act and the same key.
 */

type Resume =
  | { readonly type: 'open' }
  | { readonly type: 'month'; readonly month: string }
  | { readonly type: 'send'; readonly row: MyRow; readonly reason: string; readonly words: string }
  | { readonly type: 'withdraw'; readonly dispute: MyDispute }
  | { readonly type: 'print' }
  | { readonly type: 'pdf' }

const ANSWERED = 'labour_dispute.answered'

export function FloorMyDay() {
  const { me } = useFloor()
  // Another person on the tablet is another screen: nothing of the last one survives.
  return me ? <Open key={me.worker.id} /> : null
}

function Open() {
  const store = useFloor()
  const router = useFloorRouter()
  const feedback = useConfirmFeedback()
  const { frame, onFrame } = store.frame('tile.myday', { showHome: true })
  const { api, me, online, sessionEnded, landing } = store
  const [data, setData] = useState<MyDayData | null>(null)
  const [step, setStep] = useState<MyDayStep>(online ? { kind: 'pin' } : { kind: 'offline' })
  const [until, setUntil] = useState<string | null>(null)
  const [unread, setUnread] = useState(0)
  const proved = useRef(until)
  proved.current = until
  const current = useRef(step)
  current.current = step
  const shown = useRef(data)
  shown.current = data
  const resume = useRef<Resume>({ type: 'open' })
  const pending = useRef<{ what: string; key: string; clientEventId: string } | null>(null)
  // A read that lands after the figures were dropped must not bring them back.
  const generation = useRef(0)

  const wipe = useCallback((next: MyDayStep) => {
    generation.current += 1
    pending.current = null
    resume.current = { type: 'open' }
    setData(null)
    setUntil(null)
    setUnread(0)
    setStep(next)
  }, [])

  const leave = useCallback(() => {
    wipe({ kind: 'loading' })
    router.replace(landing)
  }, [wipe, router, landing])

  const idle = useIdleSignOut({ idleMs: CLOSE_IDLE_MS, warnMs: CLOSE_WARN_MS, enabled: data !== null, onSignOut: leave })

  useEffect(() => {
    const away = () => {
      if (document.visibilityState === 'hidden') wipe(navigator.onLine ? { kind: 'pin' } : { kind: 'offline' })
    }
    document.addEventListener('visibilitychange', away)
    window.addEventListener('pagehide', away)
    return () => {
      document.removeEventListener('visibilitychange', away)
      window.removeEventListener('pagehide', away)
    }
  }, [wipe])

  useEffect(() => {
    if (!online) wipe({ kind: 'offline' })
    else if (current.current.kind === 'offline') wipe({ kind: 'pin' })
  }, [online, wipe])

  const keyFor = (what: string) => {
    if (pending.current?.what !== what) pending.current = { what, key: newIdempotencyKey(), clientEventId: newIdempotencyKey() }
    return pending.current
  }

  const askPin = (then: Resume) => {
    resume.current = then
    setStep({ kind: 'pin', again: true })
  }

  /** Back to the statement, or the failure as a line on it. */
  const stopped = (problem: TaskProblem): boolean => {
    if (problem.kind === 'signedOut') {
      void sessionEnded()
      return true
    }
    if (problem.kind === 'offline') {
      wipe({ kind: 'offline' })
      return true
    }
    return false
  }

  const load = useCallback(
    async (month?: string) => {
      const run = generation.current
      setStep({ kind: 'loading' })
      const day = await readMyDay(api, month)
      if (run !== generation.current) return
      if (!day.ok) {
        if (day.problem.kind === 'stepUp') return askPin({ type: 'open' })
        if (stopped(day.problem)) return
        return setStep({ kind: 'problem', problem: day.problem })
      }
      if (day.value.subject === 'STATION') return setStep({ kind: 'station' })
      const mine = await readMine(api, firstOfMonth(day.value.today), day.value.today)
      if (run !== generation.current) return
      if (!mine.ok) {
        if (mine.problem.kind === 'stepUp') return askPin({ type: 'open' })
        if (stopped(mine.problem)) return
        return setStep({ kind: 'problem', problem: mine.problem })
      }
      setData({ day: day.value, mine: mine.value, statement: day.value })
      setUnread(unreadAnswers(answeredDisputes(mine.value).map((dispute) => dispute.id), readSeen()))
      setStep({ kind: 'today' })
    },
    // `stopped` and `askPin` read refs and stable setters only.
    [api],
  )

  /** The records again, after a change of ours or a live hint, only while the PIN stands: never a PIN pad for a hint. */
  const refresh = useCallback(async () => {
    const held = shown.current
    if (!held || !steppedUp(proved.current)) return
    const run = generation.current
    const mine = await readMine(api, firstOfMonth(held.day.today), held.day.today)
    if (run !== generation.current || !mine.ok) return
    setData((before) => (before ? { ...before, mine: mine.value } : before))
    setUnread(unreadAnswers(answeredDisputes(mine.value).map((dispute) => dispute.id), readSeen()))
  }, [api])

  useLiveChanges({ onChange: (change) => void (change.type === ANSWERED && refresh()), onReconnect: () => void refresh() }, data !== null)

  const changeMonth = async (month: string) => {
    const held = shown.current
    if (!held) return
    const run = generation.current
    setStep({ kind: 'statement', busy: true })
    const day = await readMyDay(api, month)
    if (run !== generation.current) return
    if (!day.ok) {
      if (day.problem.kind === 'stepUp') return askPin({ type: 'month', month })
      if (stopped(day.problem)) return
      return setStep({ kind: 'statement', problem: day.problem })
    }
    setData({ ...held, statement: day.value })
    setStep({ kind: 'statement' })
  }

  const sendDispute = async (row: MyRow, reason: string, words: string) => {
    const shownStep = current.current
    const draft = { reason, words }
    if (shownStep.kind === 'dispute') setStep({ ...shownStep, busy: true, problem: null })
    else setStep({ kind: 'dispute', row, draft, busy: true })
    const event = keyFor(`dispute:${row.recordId}`)
    const message = words.trim()
    const done = await raiseDispute(api, { clientEventId: event.clientEventId, recordType: row.recordType, recordId: row.recordId, reason, ...(message ? { message } : {}) }, event.key)
    if (!done.ok) {
      if (done.problem.kind === 'stepUp') return askPin({ type: 'send', row, reason, words })
      if (stopped(done.problem)) return
      feedback('error')
      return setStep({ kind: 'dispute', row, draft, problem: done.problem })
    }
    pending.current = null
    feedback('success')
    await refresh()
    setStep({ kind: 'records', span: row.workDate === shown.current?.day.today ? 'today' : 'period', done: done.value.existing ? 'existing' : 'sent' })
  }

  const withdraw = async (dispute: MyDispute) => {
    setStep({ kind: 'answer', dispute, busy: true })
    const event = keyFor(`withdraw:${dispute.id}`)
    const done = await withdrawDispute(api, dispute.id, event.clientEventId, event.key)
    if (!done.ok) {
      if (done.problem.kind === 'stepUp') return askPin({ type: 'withdraw', dispute })
      if (stopped(done.problem)) return
      feedback('error')
      return setStep({ kind: 'answer', dispute, problem: done.problem })
    }
    pending.current = null
    feedback('success')
    await refresh()
    setStep({ kind: 'disputes', done: 'withdrawn' })
  }

  const print = async () => {
    const statement = shown.current?.statement.pay?.statement
    if (!statement) return
    setStep({ kind: 'statement', busy: true })
    const event = keyFor(`print:${statement.id}`)
    const done = await printStatement(api, statement.id, event.key)
    if (!done.ok) {
      if (done.problem.kind === 'stepUp') return askPin({ type: 'print' })
      if (stopped(done.problem)) return
      feedback('error')
      return setStep({ kind: 'statement', problem: done.problem })
    }
    pending.current = null
    feedback('success')
    setStep({ kind: 'statement', sent: done.value.printer })
  }

  const pdf = () => {
    const statement = shown.current?.statement.pay?.statement
    if (!statement) return
    // The new tab has no PIN pad: a PIN that ran out asks here, and the button then opens it (a browser opens a tab on a press only).
    if (!steppedUp(proved.current)) return askPin({ type: 'pdf' })
    window.open(statementPdfHref(statement.id), '_blank', 'noopener')
  }

  const onPin = async (value: string) => {
    const shownStep = current.current
    if (shownStep.kind !== 'pin') return
    setStep({ ...shownStep, busy: true, problem: null })
    const answer = await floorStepUp(api, value)
    if (!answer.ok) {
      if (answer.problem === 'signedOut') return void sessionEnded()
      feedback('error')
      return setStep({ ...shownStep, busy: false, problem: answer.problem })
    }
    proved.current = answer.until
    setUntil(answer.until)
    const then = resume.current
    resume.current = { type: 'open' }
    switch (then.type) {
      case 'open':
        return load()
      case 'month':
        return changeMonth(then.month)
      case 'send':
        return sendDispute(then.row, then.reason, then.words)
      case 'withdraw':
        return withdraw(then.dispute)
      case 'print':
        return print()
      case 'pdf':
        return setStep({ kind: 'statement', pdfReady: true })
    }
  }

  const back = () => {
    const shownStep = current.current
    switch (shownStep.kind) {
      case 'records':
      case 'disputes':
      case 'statement':
        return setStep({ kind: 'today' })
      case 'dispute':
        return setStep({ kind: 'records', span: 'period' })
      case 'answer':
        return setStep({ kind: 'disputes' })
      case 'pin':
        return shownStep.again && shown.current ? setStep({ kind: 'today' }) : leave()
      default:
        return leave()
    }
  }

  const onAction = (action: MyDayAction) => {
    switch (action.type) {
      case 'pin':
        return void onPin(action.pin)
      case 'back':
        return back()
      case 'done':
        return leave()
      case 'stay':
        return idle.stay()
      case 'retry':
        return void load()
      case 'records':
        return setStep({ kind: 'records', span: action.span })
      case 'disputes': {
        const held = shown.current
        if (held) markSeen(answeredDisputes(held.mine).map((dispute) => dispute.id))
        setUnread(0)
        return setStep({ kind: 'disputes' })
      }
      case 'statement':
        return setStep({ kind: 'statement' })
      case 'row':
        return setStep({ kind: 'dispute', row: action.row, draft: { reason: null, words: '' } })
      case 'reason': {
        const shownStep = current.current
        return shownStep.kind === 'dispute' ? setStep({ ...shownStep, draft: { ...shownStep.draft, reason: action.code }, problem: null }) : undefined
      }
      case 'words': {
        const shownStep = current.current
        return shownStep.kind === 'dispute' ? setStep({ ...shownStep, draft: { ...shownStep.draft, words: action.text.slice(0, MESSAGE_MAX) } }) : undefined
      }
      case 'send': {
        const shownStep = current.current
        if (shownStep.kind !== 'dispute' || sendHeld(shownStep.draft)) return
        return void sendDispute(shownStep.row, shownStep.draft.reason!, shownStep.draft.words)
      }
      case 'answer':
        return setStep({ kind: 'answer', dispute: action.dispute })
      case 'withdraw': {
        const shownStep = current.current
        return shownStep.kind === 'answer' ? void withdraw(shownStep.dispute) : undefined
      }
      case 'month':
        return void changeMonth(action.month)
      case 'print':
        return void print()
      case 'pdf':
        return pdf()
    }
  }

  useFloorKeys({ enter: step.kind === 'dispute' ? () => onAction({ type: 'send' }) : null, escape: back })

  // "Switch person (scan a badge)": the app takes the switch; the figures go first.
  useWedgeScans((code) => {
    if (!me) return
    const read = readScan(code, me.scanTag)
    if (read.kind !== 'badge') return
    wipe({ kind: 'loading' })
    void store.switchTo(read.code).then((problem) => {
      if (!problem) return
      feedback('error')
      wipe({ kind: 'pin' })
    })
  }, true)

  return (
    <MyDayScreen
      model={{
        frame,
        step,
        data,
        online,
        phone: me?.device.mode === 'PHONE',
        unread,
        closing: idle.warning ? { secondsLeft: idle.secondsLeft } : null,
      }}
      onAction={onAction}
      onFrame={onFrame}
    />
  )
}
