'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { speechLang } from '@nexus/factory-domain/auth/floor/literacy'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useDepartments } from '../../../lib/department/use-departments'
import { useT } from '../../../lib/i18n/provider'
import { useFloor, useFloorRouter } from '../../FloorApp'
import { gateOf, gotItHere, markGotIt } from '../../tasks/mywork/order-change-seen'
import { useOrderChangeGate } from '../../tasks/mywork/use-order-change-gate'
import { timingOrKeep } from '../../tasks/scans/api'
import type { TaskProblem } from '../../tasks/shared/task-api'
import { fetchBasket, moveBaskets, reportDone, tickQuality, uploadQualityPhoto, type BasketRead, type QualityStep } from '../api'
import { HELP_READY } from '../help'
import { basketHomeOf, deptOf, dockOf, elsewhereOf, putFlash, qualityOf, stepBarOf, stepDone, viewOf, type BasketView } from '../model'
import { BASKET_NS } from '../parts'
import { STEPS_READY } from '../steps'
import type { DockAction } from '../dock/BasketDock'
import type { QcAction } from '../dock/QcCard'
import { BasketPageView, type BasketPageAction } from './view/BasketPageView'
import { undoStore } from '../undo/store'
import { useUndoChanges } from '../undo/use-undo'

/**
 * owb-fl5 steps 2–4 — the basket page's container (`/floor/basket/<code>`). It reads `GET /production/baskets/:code` (with `via=scan`
 * when a scan opened it: the code Home's router handed over), and sends each tap of the dock:
 *   Start · Resume · Pause   today's `POST /production/terminal/*`, online first, kept on the phone when the network is gone
 *   Done · Passed · Packed   today's REPORT of the whole basket as good (`POST /production/scans`, online first, kept on the phone);
 *                            `moved` in the answer = a second Done that wrote a forward move ("Moved on to 5 Quality"); then home
 *   I saw the new design     today's order-change gate's own mark (this device only, never sent)
 *   Take it here             fl2's TAKEN_HERE move (online; logged with the warning)
 *   Not good: send back      fl2's BACK move, reason Work again (online)
 *   a quality tick           today's checklist tick (kept on the phone first); a quality photo: the QC photo route (online)
 * The worker's name never appears; the customer is its CODE.
 */

type Load = { readonly state: 'loading' | 'offline' | 'unavailable' } | { readonly state: 'refused'; readonly words: string } | { readonly state: 'ready'; readonly read: BasketRead; readonly at: number }

/** The step a timing action and a report name: the one it is at. */
const hereOperationOf = (view: BasketView): string | null => view.route.steps.find((step) => step.state === 'HERE')?.operationId ?? view.place.operationId

export function BasketPage({ code }: { readonly code: string }) {
  const store = useFloor()
  const router = useFloorRouter()
  const feedback = useConfirmFeedback()
  const tb = useT(BASKET_NS)
  const { me, api, online, locale, queue, sessionEnded } = store
  const { frame, onFrame } = store.frame('tile.baskets', { showHome: true })
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [scanned, setScanned] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [steps, setSteps] = useState<readonly QualityStep[]>([])
  const [stepsOpen, setStepsOpen] = useState(false)
  const [askOpen, setAskOpen] = useState(false)
  const [photo, setPhoto] = useState<{ readonly code: string; readonly words: string } | null>(null)
  const [gotIt, setGotIt] = useState<readonly string[]>(() => gotItHere())
  const taken = useRef(false)
  const { departments } = useDepartments(api)
  const undone = useUndoChanges()

  const read = useCallback(
    async (asScan: boolean) => {
      if (!navigator.onLine) return setLoad({ state: 'offline' })
      const answer = await fetchBasket(api, code, asScan)
      if (answer.ok) {
        if (answer.value.refusal) return setLoad({ state: 'refused', words: answer.value.refusal.message })
        setSteps(answer.value.quality?.steps ?? [])
        return setLoad({ state: 'ready', read: answer.value, at: Date.now() })
      }
      if (answer.problem.kind === 'signedOut') return void sessionEnded()
      if (answer.problem.kind === 'notFound') return setLoad({ state: 'refused', words: tb('page.notFound') })
      if (answer.problem.kind === 'refused') return setLoad({ state: 'refused', words: answer.problem.message })
      setLoad({ state: answer.problem.kind === 'offline' ? 'offline' : 'unavailable' })
    },
    [api, code, sessionEnded, tb],
  )

  // The code a scan handed over (Home's router) says "the basket is in front of me": read once, as a scan.
  useEffect(() => {
    if (taken.current) return
    taken.current = true
    const asScan = store.takeScan() === code
    setScanned(asScan)
    void read(asScan)
  }, [store, code, read])

  // Back online: read what could not be read.
  useEffect(() => {
    if (online && load.state === 'offline') void read(scanned)
  }, [online, load.state, read, scanned])

  // owb-fl6: an Undo went through (the bar at the foot): read again.
  const undoneSeen = useRef(undone)
  useEffect(() => {
    if (undoneSeen.current === undone) return
    undoneSeen.current = undone
    void read(scanned)
  }, [undone, read, scanned])

  const view = load.state === 'ready' ? viewOf(load.read) : null
  const gate = useOrderChangeGate({ api, online, workOrderIds: view ? [view.basket.workOrderId] : [], enabled: view !== null })
  if (!me) return null

  const leader = me.permissions.includes('floor.lead')
  const note = view ? (gate.notes[view.basket.workOrderId] ?? null) : null
  const pendingNote = gateOf([note], gotIt)
  const quality = view ? qualityOf(view.quality, steps) : null
  const dock = view ? dockOf({ view, scanned, leader, designPending: pendingNote !== null, stepsReady: STEPS_READY, quality }) : ({ kind: 'none' } as const)
  const nextDept = view ? deptOf(view.next.department, locale) : null
  const hereDept = view && view.here.departmentId ? (departments.find((dept) => dept.id === view.here.departmentId) ?? null) : null
  const back = dock.kind === 'working' ? dock.back : null

  const said = (found: TaskProblem): string => {
    if (found.kind === 'refused') return found.message || tb('dock.failed')
    if (found.kind === 'offline') return tb('dock.needsNetwork')
    return tb('dock.failed')
  }

  /** One action at a time; a refusal is said in the dock, a session that ended goes to sign-in. */
  const act = async (run: () => Promise<TaskProblem | null>) => {
    if (busy) return
    setBusy(true)
    setProblem(null)
    try {
      const found = await run()
      if (found?.kind === 'signedOut') return void sessionEnded()
      if (found) {
        feedback('error')
        setProblem(said(found))
      }
    } catch {
      feedback('error')
      setProblem(tb('dock.failed'))
    } finally {
      setBusy(false)
    }
  }

  const goHome = () => router.replace(basketHomeOf(me.device.mode))

  const timing = (route: 'start' | 'resume' | 'pause') =>
    act(async () => {
      const operationId = view ? hereOperationOf(view) : null
      if (!view || !operationId) return { kind: 'unavailable' }
      const sent = await timingOrKeep(api, queue, online, route, { code: view.basket.code, workOrderOperationId: operationId })
      if (sent.kept) {
        feedback('success')
        setLoad((now) => (now.state === 'ready' && now.read.work ? { ...now, read: { ...now.read, work: { ...now.read.work, state: route === 'pause' ? 'PAUSED' : 'WORKING', mine: true } } } : now))
        return null
      }
      if (!sent.answer.ok) return sent.answer.problem
      feedback('success')
      await read(scanned)
      return null
    })

  const done = () =>
    act(async () => {
      const operationId = view ? hereOperationOf(view) : null
      if (!view || !operationId) return { kind: 'unavailable' }
      const sent = await reportDone(api, queue, online, { code: view.basket.code, workOrderOperationId: operationId, good: view.basket.quantity })
      if (sent.kept) {
        putFlash({ code: view.basket.code, to: nextDept, moved: false, saved: true })
      } else if (sent.answer.ok) {
        putFlash({ code: view.basket.code, to: nextDept, moved: sent.answer.value.moved === true, saved: false })
      } else {
        return sent.answer.problem
      }
      feedback('success')
      goHome()
      return null
    })

  const move = (kind: 'TAKEN_HERE' | 'BACK', toOperationId: string) =>
    act(async () => {
      if (!view) return { kind: 'unavailable' }
      if (!online) return { kind: 'offline' }
      const answer = await moveBaskets(api, { bundleIds: [view.basket.id], toOperationId, kind, ...(kind === 'BACK' ? { reason: 'REDO' as const } : {}), clientEventId: newIdempotencyKey() })
      if (!answer.ok) return answer.problem
      if (answer.value.moved === 0) return { kind: 'refused', code: 'STAY', message: answer.value.stayWords[0] ?? tb('dock.failed'), fix: null }
      feedback('success')
      // owb-fl6: the Undo bar offers it back (from where it was to where it went).
      const bar = stepBarOf(view, locale)
      undoStore.put(me.worker.id, { kind: 'move', groupIds: [answer.value.groupId], code: view.basket.code, count: 1, from: bar.now?.dept ?? null, to: kind === 'BACK' && back ? deptOf(back.department, locale) : hereDept, toReady: false })
      if (kind === 'BACK' && back) {
        putFlash({ code: view.basket.code, to: deptOf(back.department, locale), moved: false, saved: false })
        goHome()
        return null
      }
      await read(scanned)
      return null
    })

  const onDock = (action: DockAction) => {
    switch (action) {
      case 'start':
        if (!view) return
        // Today's gate stands before every Start (a changed design not marked here opens it); the dock asks first anyway.
        if (!gate.before([view.basket.workOrderId], () => void timing(view.work.state === 'PAUSED' ? 'resume' : 'start'))) return
        return void timing(view.work.state === 'PAUSED' ? 'resume' : 'start')
      case 'pause':
        return void timing('pause')
      case 'done':
        return void done()
      case 'sawDesign':
        if (!pendingNote) return
        feedback('success')
        return setGotIt(markGotIt(pendingNote.id))
      case 'takeHere':
        return dock.kind === 'takeHere' ? void move('TAKEN_HERE', dock.operationId) : undefined
      case 'changeStep':
        return setStepsOpen(true)
      case 'askLeader':
        return setAskOpen(true)
    }
  }

  const onQc = (action: QcAction) => {
    if (!view) return
    const operationId = hereOperationOf(view)
    switch (action.type) {
      case 'tick':
        if (!operationId) return
        void tickQuality(queue, { code: view.basket.code, workOrderOperationId: operationId, stepCode: action.code })
          .then(() => {
            feedback('success')
            setSteps((now) => stepDone(now, action.code))
          })
          .catch(() => {
            feedback('error')
            setProblem(tb('dock.failed'))
          })
        return
      case 'photo': {
        if (!online) return setProblem(tb('qc.photoOffline'))
        const step = steps.find((one) => one.code === action.code)
        return setPhoto({ code: action.code, words: step?.words ?? action.code })
      }
      case 'sendBack':
        return back ? void move('BACK', back.operationId) : undefined
    }
  }

  const onAction = (action: BasketPageAction) => {
    switch (action.type) {
      case 'dock':
        return onDock(action.action)
      case 'qc':
        return onQc(action.action)
      case 'retry':
        setLoad({ state: 'loading' })
        return void read(scanned)
      case 'designPage':
        return load.state === 'ready' && load.read.designPageHref ? router.push(load.read.designPageHref) : undefined
      case 'closeSteps':
        return setStepsOpen(false)
      case 'closeAsk':
        return setAskOpen(false)
      case 'photoCancel':
        return setPhoto(null)
      case 'photoTaken': {
        const shot = photo
        if (!view || !shot) return
        return void act(async () => {
          const operationId = hereOperationOf(view)
          if (!operationId) return { kind: 'unavailable' }
          const sent = await uploadQualityPhoto(api, view.basket.id, shot.code, operationId, action.photo)
          if (!sent.ok) return sent.problem.kind === 'offline' ? { kind: 'refused', code: 'PHOTO', message: tb('qc.photoOffline'), fix: null } : { kind: 'refused', code: 'PHOTO', message: tb('qc.photoFailed'), fix: null }
          setSteps((now) => stepDone(now, shot.code))
          setPhoto(null)
          return null
        })
      }
      case 'changed':
        setStepsOpen(false)
        setAskOpen(false)
        return void read(scanned)
    }
  }

  const ready = load.state === 'ready'
  return (
    <BasketPageView
      model={{
        frame: { ...frame, title: tb('page.title', { code: view?.basket.code ?? code }) },
        state: ready && !view && !load.read.restricted ? 'unavailable' : load.state,
        refusal: load.state === 'refused' ? load.words : null,
        read: ready ? load.read : null,
        view,
        bar: view ? stepBarOf(view, locale) : null,
        readAt: ready ? load.at : 0,
        speechLang: me.speech?.lang ?? speechLang(locale),
        scanned,
        leader,
        stepsReady: STEPS_READY,
        helpReady: HELP_READY,
        designWords: view?.changedDesign?.words ?? note?.text ?? null,
        designPending: pendingNote !== null,
        elsewhere: view ? elsewhereOf(view) : false,
        dock: { dock, next: nextDept, here: hereDept, canAsk: HELP_READY, busy, problem },
        qc: view && quality && dock.kind === 'working' && view.quality ? { steps, progress: quality, back: back ? { dept: deptOf(back.department, locale), name: back.name } : null, busy } : null,
        stepsOpen,
        askOpen,
        photo,
        online,
      }}
      onFrame={onFrame}
      onAction={onAction}
    />
  )
}
