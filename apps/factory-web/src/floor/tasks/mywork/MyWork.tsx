'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { useLiveChanges } from '../../../record-panels/live'
import { zxingCamera } from '../../camera'
import { useFloor } from '../../FloorApp'
import { useFloorKeys } from '../../keys'
import { homeTiles, modeOf } from '../../model'
import { readScan } from '../../scan/scan-model'
import { fetchListReasons, keptListReasons } from '../reasons/api'
import type { PickerReason } from '../reasons/model'
import type { ReasonPickerAction, ReasonPickerModel } from '../reasons/view/ReasonPicker'
import { TASK_ROUTES, taskForScan } from '../routes'
import { fetchStationQueue, keptStationQueue } from './api'
import { arranged, listChanged, PUT_LAST_KEY, putLastIn, readPutLast, withPutLast, type DispatchList, type PutLast } from './model'
import { MyWorkView, type MyWorkAction, type MyWorkStep } from './view/MyWorkView'

/**
 * The live SCR-089 (`/floor/mywork`): the station's queue (`GET /production/dispatch/station`) read on view, again when
 * the live channel says the floor's list may have moved (a plan published, a bundle reported, a hold placed or lifted,
 * a work order's status) or the stream comes back, every 30 s while in view, and on Try again. A fresher list never replaces the one on screen by
 * itself: it waits behind "List changed · Show". A scan here opens the station's job with the label (Home's scan router).
 * "I can't find it" → Put it last with a reason tile from the office's PAUSE list (`GET /reasons?list=PAUSE`), kept on
 * this tablet only (browser storage, wrapped: the office's plan never changes from the floor, Owner answer P3).
 */

/** The live changes after which the station's list may differ (each a hint: the screen reads again). */
const MOVES = new Set(['planning.schedule_published', 'production.scan_recorded', 'quality.hold_placed', 'quality.hold_released', 'workorder.status_changed'])
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

export function FloorMyWork() {
  const store = useFloor()
  const router = useRouter()
  const feedback = useConfirmFeedback()
  const { frame, onFrame } = store.frame('tile.mywork', { showHome: true })
  const { me, api, online, sessionEnded } = store
  const allowed = Boolean(me?.permissions.includes('floor.work'))
  const [step, setStep] = useState<MyWorkStep>(allowed ? { kind: 'loading' } : { kind: 'noPermission' })
  const [shown, setShown] = useState<DispatchList | null>(null)
  const [fresh, setFresh] = useState<DispatchList | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [problem, setProblem] = useState<'error' | 'offline' | null>(null)
  const [putLast, setPutLast] = useState<PutLast[]>([])
  const [cantFind, setCantFind] = useState<string | null>(null)
  const [putLastDone, setPutLastDone] = useState<{ slotId: string } | null>(null)
  const shownRef = useRef<DispatchList | null>(null)
  shownRef.current = shown

  useEffect(() => setPutLast(loadPutLast()), [])

  /** Reads the queue: the first answer goes on screen; a later one that differs waits behind "List changed · Show". */
  const read = useCallback(
    async (show: boolean) => {
      if (!allowed) return
      const answer = await fetchStationQueue(api)
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
      const kept = keptStationQueue()
      if (kept && shownRef.current === null) {
        setShown(kept.value)
        setAsOf(kept.asOf)
      } else if (shownRef.current !== null) setAsOf((current) => current ?? shownRef.current!.asOf)
      setProblem(answer.problem.kind === 'offline' ? 'offline' : 'error')
      setStep((current) => (current.kind === 'loading' ? { kind: 'list' } : current))
    },
    [allowed, api, sessionEnded],
  )

  useEffect(() => {
    void read(true)
  }, [read])

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
    const mode = modeOf(me.device.station)
    const task = taskForScan(mode, read, homeTiles(mode, me.permissions, me.notice.blocksScans))
    if (task) return store.openWith(TASK_ROUTES[task], read.code)
    if (read.kind !== 'badge') return store.openScan(code)
    if (await store.switchTo(read.code)) feedback('error')
  }

  const back = () => {
    setCantFind(null)
    setStep(allowed ? { kind: 'list' } : { kind: 'noPermission' })
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
        return setCantFind(action.slotId)
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
    escape: cantFind !== null ? null : step.kind === 'entry' || step.kind === 'reason' ? back : () => router.push('/floor'),
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
        cantFind,
        putLastDone,
        held: me.notice.blocksScans,
        mode: modeOf(me.device.station),
      }}
      onFrame={onFrame}
      onAction={onAction}
      camera={zxingCamera}
    />
  )
}
