'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { useLiveChanges } from '../../../record-panels/live'
import { zxingCamera } from '../../camera'
import { useFloor, useFloorRouter } from '../../FloorApp'
import { useFloorKeys } from '../../keys'
import { homeTiles, modeOf } from '../../model'
import { readScan } from '../../scan/scan-model'
import { fetchListReasons, keptListReasons } from '../reasons/api'
import type { PickerReason } from '../reasons/model'
import type { ReasonPickerAction, ReasonPickerModel } from '../reasons/view/ReasonPicker'
import { queuedView } from '../shared/queued'
import { TASK_ROUTES, taskForScan } from '../routes'
import { fetchMyMessages, fetchStationHelp, fetchWorkList, keptMyMessages, keptStationHelp, keptWorkList } from './api'
import { arranged, changedRows, helpHeld, helpPayload, listChanged, materialTile, PUT_LAST_KEY, putLastIn, readPutLast, readSeen, SEEN_KEY, withPutLast, withSeen, type DispatchList, type MyMessages, type PutLast, type StationHelp } from './model'
import { MyWorkView, type MyWorkAction, type MyWorkCall, type MyWorkStep } from './view/MyWorkView'

/**
 * The live SCR-089 (`/floor/mywork`): the list to work from (the person's, else the station's queue: `fetchWorkList`) read on view, again when
 * the live channel says the floor's list may have moved (a plan published, a bundle reported, a hold placed or lifted,
 * a work order's status) or the stream comes back, every 30 s while in view, and on Try again. A fresher list never replaces the one on screen by
 * itself: it waits behind "List changed · Show". A scan here opens the station's job with the label (Home's scan router).
 * "I can't find it" → Put it last with a reason tile from the office's PAUSE list (`GET /reasons?list=PAUSE`), kept on
 * this tablet only (browser storage, wrapped: the office's plan never changes from the floor, Owner answer P3).
 *
 * B-W2b-71: "For your work" reads the open messages on the same beat; which ones were opened stays on this tablet (browser
 * storage, wrapped), never per person. Call for help: Material goes through the tablet's queue (kind `andon.call.send`): one
 * tap, online or not; who to call was read earlier in the visit, and the call says its two ticks.
 */

/** The live changes after which the station's list may differ (each a hint: the screen reads again). */
const MOVES = new Set(['planning.schedule_published', 'production.scan_recorded', 'quality.hold_placed', 'quality.hold_released', 'workorder.status_changed', 'dispatch.assignment_changed'])
/**
 * While the screen is in view it also reads again on this beat: the live rules of those events ask office permissions
 * (planning.view, workorders.view, quality.holds.view) that no floor role holds, so today they never reach a tablet
 * (named for the lead in the step's notes). One small read per tablet; a fresher list still waits for "Show".
 */
const REREAD_MS = 30_000
const PUT_LAST_LISTS = ['PAUSE']

function loadPutLast(): PutLast[] {
  try {
    return readPutLast(window.localStorage.getItem(PUT_LAST_KEY))
  } catch {
    return []
  }
}

function savePutLast(items: readonly PutLast[]): void {
  try {
    window.localStorage.setItem(PUT_LAST_KEY, JSON.stringify(items))
  } catch {
    // Private window or blocked storage: the mark lives for this visit only.
  }
}

function loadSeen(): string[] {
  try {
    return readSeen(window.localStorage.getItem(SEEN_KEY))
  } catch {
    return []
  }
}

function saveSeen(ids: readonly string[]): void {
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(ids))
  } catch {
    // Private window or blocked storage: the marks live for this visit only.
  }
}

export function FloorMyWork() {
  const store = useFloor()
  const router = useFloorRouter()
  const feedback = useConfirmFeedback()
  const { frame, onFrame } = store.frame('tile.mywork', { showHome: true })
  const { me, api, online, sessionEnded, queue, queueSnapshot } = store
  const allowed = Boolean(me?.permissions.includes('floor.work'))
  const [step, setStep] = useState<MyWorkStep>(allowed ? { kind: 'loading' } : { kind: 'noPermission' })
  const [shown, setShown] = useState<DispatchList | null>(null)
  const [fresh, setFresh] = useState<DispatchList | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [problem, setProblem] = useState<'error' | 'offline' | null>(null)
  const [putLast, setPutLast] = useState<PutLast[]>([])
  const [cantFind, setCantFind] = useState<string | null>(null)
  const [putLastDone, setPutLastDone] = useState<{ slotId: string } | null>(null)
  const [messages, setMessages] = useState<MyMessages | null>(null)
  const [messagesAsOf, setMessagesAsOf] = useState<string | null>(null)
  const [messagesFailed, setMessagesFailed] = useState(false)
  const [seen, setSeen] = useState<string[]>([])
  const [help, setHelp] = useState<StationHelp | null>(null)
  const [helpProblem, setHelpProblem] = useState<'reading' | 'offline' | 'failed' | null>('reading')
  const [called, setCalled] = useState<{ id: string | null; number: string; seq: number } | null>(null)
  const shownRef = useRef<DispatchList | null>(null)
  shownRef.current = shown

  useEffect(() => {
    setPutLast(loadPutLast())
    setSeen(loadSeen())
  }, [])

  /** The open messages: a failed read keeps what this tablet read, with its time. */
  const readMessages = useCallback(async () => {
    if (!allowed) return
    const answer = await fetchMyMessages(api)
    if (answer.ok) {
      setMessages(answer.value)
      setMessagesAsOf(null)
      setMessagesFailed(false)
      return
    }
    if (answer.problem.kind === 'signedOut') return void sessionEnded()
    const kept = keptMyMessages()
    setMessages(kept?.value ?? null)
    setMessagesAsOf(kept?.asOf ?? null)
    setMessagesFailed(!kept)
  }, [allowed, api, sessionEnded])

  /** Who to call for material: read once on view and when the dialog opens; offline it stays what this tablet read. */
  const readHelp = useCallback(async () => {
    if (!allowed) return
    const answer = await fetchStationHelp(api)
    if (answer.ok) {
      setHelp(answer.value)
      setHelpProblem(null)
      return
    }
    if (answer.problem.kind === 'signedOut') return void sessionEnded()
    const kept = keptStationHelp()
    setHelp(kept?.value ?? null)
    setHelpProblem(kept ? null : answer.problem.kind === 'offline' ? 'offline' : 'failed')
  }, [allowed, api, sessionEnded])

  /** Reads the queue: the first answer goes on screen; a later one that differs waits behind "List changed · Show". */
  const read = useCallback(
    async (show: boolean) => {
      if (!allowed) return
      void readMessages()
      const answer = await fetchWorkList(api)
      if (answer.ok) {
        setProblem(null)
        setAsOf(null)
        if (show || shownRef.current === null) {
          setShown(answer.value)
          setFresh(null)
        } else if (listChanged(shownRef.current, answer.value)) setFresh(answer.value)
        else setFresh(null)
        setStep((current) => (current.kind === 'loading' ? { kind: 'list' } : current))
        return
      }
      if (answer.problem.kind === 'signedOut') return void sessionEnded()
      // Offline, or the office did not answer: the queue this tablet read earlier, with its time.
      const kept = keptWorkList()
      if (kept && shownRef.current === null) {
        setShown(kept.value)
        setAsOf(kept.asOf)
      } else if (shownRef.current !== null) setAsOf((current) => current ?? shownRef.current!.asOf)
      setProblem(answer.problem.kind === 'offline' ? 'offline' : 'error')
      setStep((current) => (current.kind === 'loading' ? { kind: 'list' } : current))
    },
    [allowed, api, sessionEnded, readMessages],
  )

  useEffect(() => {
    void read(true)
    void readHelp()
  }, [read, readHelp])

  // Back online: read again (the list shown stays until "Show").
  useEffect(() => {
    if (online && asOf) void read(false)
  }, [online, asOf, read])

  // In view: read again on the beat, and when the tablet comes back to this screen.
  useEffect(() => {
    if (!allowed || !online) return
    const again = () => {
      if (document.visibilityState === 'visible') void read(false)
    }
    const timer = window.setInterval(again, REREAD_MS)
    document.addEventListener('visibilitychange', again)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', again)
    }
  }, [allowed, online, read])

  useLiveChanges(
    {
      onChange: (change) => {
        if (MOVES.has(change.type)) void read(false)
      },
      onReconnect: () => void read(false),
    },
    allowed && online,
  )

  // Marks of tasks no longer open drop off (the plan changed, the task got done).
  useEffect(() => {
    if (!shown) return
    setPutLast((current) => {
      const kept = putLastIn(shown, current)
      if (kept.length !== current.length) savePutLast(kept)
      return kept.length !== current.length ? kept : current
    })
  }, [shown])

  const openReasons = useCallback(
    async (slotId: string) => {
      const view = shown ? arranged(shown, putLast) : null
      const row = view ? [view.next, ...view.queue].find((entry) => entry?.entry.slotId === slotId) : null
      if (!row) return
      const subject = `${row.entry.workOrder.number} · Op ${row.entry.operation.seq} ${row.entry.operation.name}`
      const kept = keptListReasons(PUT_LAST_LISTS)
      const picker = (reasons: readonly PickerReason[], extra: Partial<ReasonPickerModel> = {}): MyWorkStep => ({ kind: 'reason', slotId, picker: { purpose: 'putLast', subject, reasons, value: null, ...extra } })
      if (!online) return setStep(kept ? picker(kept.value, { asOf: kept.asOf }) : picker([], { state: 'offline' }))
      setStep(picker(kept?.value ?? [], kept ? {} : { state: 'loading' }))
      const answer = await fetchListReasons(api, PUT_LAST_LISTS)
      if (!answer.ok) {
        if (answer.problem.kind === 'signedOut') return void sessionEnded()
        const again = keptListReasons(PUT_LAST_LISTS)
        return setStep((current) => (current.kind === 'reason' && current.slotId === slotId ? (again ? picker(again.value, { asOf: again.asOf, value: current.picker.value }) : picker([], { state: answer.problem.kind === 'offline' ? 'offline' : 'error' })) : current))
      }
      setStep((current) => (current.kind === 'reason' && current.slotId === slotId ? picker(answer.value, { value: current.picker.value ?? null }) : current))
    },
    [shown, putLast, online, api, sessionEnded],
  )

  // ---- Call for help: Material -------------------------------------------------------------------------------------------

  const sentCall = called?.id ? queuedView(queueSnapshot, called.id) : null
  const sentTicks = sentCall?.ticks ?? null
  // Once the office has it, the station's open call is what the dialog says next.
  useEffect(() => {
    if (sentTicks === 'recorded' || sentTicks === 'refused') void readHelp()
  }, [sentTicks, readHelp])

  const call: MyWorkCall | null = called ? { number: called.number, seq: called.seq, ticks: sentTicks ?? (called.id ? 'saved' : 'refused'), refusal: sentCall?.refusal?.code ?? null } : null
  const held = called?.id && (sentTicks === 'saved' || sentTicks === 'sending') ? 'waiting' : helpHeld({ help, problem: helpProblem })

  const sendHelp = async () => {
    const view = shown ? arranged(shown, putLast) : null
    const row = view ? [view.next, ...view.queue].find((entry) => entry?.entry.slotId === cantFind) : null
    const tile = materialTile(help)
    if (!row || !tile || held) return
    const about = { number: row.entry.workOrder.number, seq: row.entry.operation.seq }
    setCantFind(null)
    // The line that says where the call stands is on the list (a row's card has none).
    setStep({ kind: 'list' })
    try {
      const item = await queue.enqueue('andon.call.send', helpPayload(tile.type.id, row.entry))
      setCalled({ id: item.clientEventId, ...about })
      feedback('success')
    } catch {
      setCalled({ id: null, ...about })
      feedback('error')
    }
  }

  const reasonDone = () => {
    if (step.kind !== 'reason') return
    const picked = step.picker.reasons.find((reason) => reason.id === step.picker.value)
    if (!picked) {
      feedback('warning')
      return
    }
    const next = withPutLast(putLast, { slotId: step.slotId, code: picked.code, labelIt: picked.labelIt, labelEn: picked.labelEn, at: new Date().toISOString() })
    setPutLast(next)
    savePutLast(next)
    setPutLastDone({ slotId: step.slotId })
    setStep({ kind: 'list' })
    feedback('success')
  }

  const onReason = (action: ReasonPickerAction) => {
    if (step.kind !== 'reason') return
    if (action.type === 'pick') return setStep({ ...step, picker: { ...step.picker, value: action.id } })
    if (action.type === 'retry') return void openReasons(step.slotId)
  }

  const onScan = async (code: string) => {
    if (!me) return
    const read = readScan(code, me.scanTag)
    const mode = modeOf(me.device.station, me.device.mode)
    const task = taskForScan(mode, read, homeTiles(mode, me.permissions, me.notice.blocksScans, me.device.mode))
    if (task) return store.openWith(TASK_ROUTES[task], read.code)
    if (read.kind !== 'badge') return store.openScan(code)
    if (await store.switchTo(read.code)) feedback('error')
  }

  const back = () => {
    setCantFind(null)
    setStep(step.kind === 'message' ? { kind: 'messages' } : allowed ? { kind: 'list' } : { kind: 'noPermission' })
  }

  const openMessage = (id: string) => {
    const next = withSeen(seen, id)
    setSeen(next)
    saveSeen(next)
    setStep({ kind: 'message', id })
  }

  const onAction = (action: MyWorkAction) => {
    switch (action.type) {
      case 'scan':
        return void onScan(action.code)
      case 'open':
        setPutLastDone(null)
        return setStep({ kind: 'entry', slotId: action.slotId })
      case 'back':
        return back()
      case 'home':
        return router.push('/floor')
      case 'retry':
        setStep({ kind: 'loading' })
        return void read(true)
      case 'show':
        if (fresh) {
          setShown(fresh)
          setFresh(null)
          setAsOf(null)
        }
        return
      case 'cantFind':
        if (action.slotId && online) void readHelp()
        return setCantFind(action.slotId)
      case 'help':
        return void sendHelp()
      case 'messages':
        setPutLastDone(null)
        return setStep({ kind: 'messages' })
      case 'message':
        return openMessage(action.id)
      case 'putLast':
        setCantFind(null)
        return void openReasons(action.slotId)
      case 'reason':
        return onReason(action.action)
      case 'reasonDone':
        return reasonDone()
    }
  }

  useFloorKeys({
    enter: step.kind === 'reason' ? reasonDone : null,
    escape: cantFind !== null ? null : step.kind === 'entry' || step.kind === 'reason' || step.kind === 'messages' || step.kind === 'message' ? back : () => router.push('/floor'),
  })

  if (!me) return null

  return (
    <MyWorkView
      model={{
        frame,
        step,
        list: shown,
        putLast,
        problem,
        asOf,
        changed: fresh !== null,
        pending: fresh && shown ? changedRows(shown, fresh) : 0,
        cantFind,
        putLastDone,
        held: me.notice.blocksScans,
        mode: modeOf(me.device.station, me.device.mode),
        messages,
        seen,
        messagesAsOf: messagesAsOf ?? (!online && messages ? messages.asOf : null),
        messagesFailed,
        helpHeld: held,
        call,
      }}
      onFrame={onFrame}
      onAction={onAction}
      camera={zxingCamera}
    />
  )
}
