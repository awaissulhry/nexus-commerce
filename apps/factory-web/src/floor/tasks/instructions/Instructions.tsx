'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { zxingCamera } from '../../camera'
import { useFloor, useFloorRouter } from '../../FloorApp'
import { useFloorKeys } from '../../keys'
import { onlineFirst } from '../../queue/online-first'
import { readScan } from '../../scan/scan-model'
import { TASK_ROUTES } from '../routes'
import { fetchOpenWork } from '../scans/api'
import { withLeft } from '../scans/left'
import type { OpenItem } from '../scans/timing'
import { queuedView } from '../shared/queued'
import { fetchInstruction, fetchNewerSpec, fetchSpec, sendSeen, sendSpecProblem, uploadProblemPhoto, type FloorInstruction } from './api'
import { forPerson, keepInstruction, keepMediaOf, keepNewer, keepSpec, keptInstruction, keptMedium, keptNewer, keptSpec, loadMedium, markSeen, mediumFailed, seenHere, takeInstructionsOffer, type InstructionsOffer } from './memory'
import { useMine } from './mine'
import { bundleForDue, clampStep, dueOf, dueRows, EMPTY_PROBLEM, inHand, openByItself, photoName, problemBody, seenBody, seenHeld, sendHeld, withShown, type ProblemDraft } from './model'
import { InstructionsView, type InstructionsAction, type InstructionsStep, type OpenWork } from './view/InstructionsView'

/**
 * The live SCR-174 (`/floor/instructions`; B-W2b-232 on the merged APIs of B-W2b-214, -220 and -226).
 *
 *   opens        for the bundle the Operation screen hands over (its card's Instructions, or the Start that waits for a new
 *                version: MES-110), else the one running bundle of this person on this tablet, else For this work: scan a
 *                bundle's ticket, or tap an open bundle or a version waiting for the person's Seen ("New for you")
 *   reads        the instruction in force (`…/floor/operation`), the frozen spec (`…/floor/spec`), the newer-spec banner
 *                (`…/spec/newer`), the photos and videos through the floor's own route (blobs kept for the visit); offline, what
 *                the tablet kept (the Operation screen keeps every bundle it opens), with its time
 *   Seen         online first, else saved in the queue (`production.instruction.ack`) under ONE client id; held until every step
 *                was on screen; the version is then marked seen on this tablet, so nothing reopens it before the queue is sent
 *   spec problem online first, else the queue (`product.change.report`); the photo goes up once the request has its id (the
 *                answer, or the queue's receipt), online only
 */

const BLANK: Pick<OpenWork, 'tab' | 'index' | 'shown' | 'media' | 'zoom' | 'seen' | 'busy'> = { tab: 'steps', index: 0, shown: [0], media: {}, zoom: null, seen: null, busy: false }

export function FloorInstructions() {
  const store = useFloor()
  const router = useFloorRouter()
  const feedback = useConfirmFeedback()
  const { frame, onFrame } = store.frame('tile.instructions', { showHome: true })
  const { api, me, online, queue, queueSnapshot, sessionEnded } = store
  const person = me?.worker.id ?? null
  forPerson(person)
  const allowed = Boolean(me?.permissions.includes('production.scan'))
  const held = Boolean(me?.notice.blocksScans)
  const offer = useRef<InstructionsOffer | null | undefined>(undefined)
  if (offer.current === undefined) offer.current = takeInstructionsOffer()
  const handed = useRef<string | null | undefined>(undefined)
  if (handed.current === undefined) handed.current = store.takeScan()
  const from = offer.current?.from ?? null
  const [step, setStep] = useState<InstructionsStep>(() => (allowed ? (offer.current?.code || handed.current ? { kind: 'loading', code: offer.current?.code ?? handed.current ?? '' } : { kind: 'scan' }) : { kind: 'noPermission' }))
  const latest = useRef(step)
  latest.current = step
  const [items, setItems] = useState<readonly OpenItem[]>(() => (person ? withLeft(person, []) : []))
  const [src, setSrc] = useState<Readonly<Record<string, string | null | undefined>>>({})
  const [failed, setFailed] = useState<readonly string[]>([])
  const run = useRef(0)
  const seenEvent = useRef<string | null>(null)
  const problemEvent = useRef<{ clientEventId: string | null; requestId: string | null; uploading: boolean } | null>(null)
  const photo = useRef<{ blob: Blob; name: string } | null>(null)
  const autoOpened = useRef(false)
  const signedOut = useCallback(() => void sessionEnded(), [sessionEnded])
  const { mine } = useMine({ api, online, workerId: person, allowed, onSignedOut: signedOut })
  const seen = useMemo(() => seenHere(person), [person])

  // ---- opening the bundle in hand ------------------------------------------------------------------------------------------

  const workOf = useCallback(
    (answer: FloorInstruction, asOf: string | null, code: string): OpenWork => {
      const spec = keptSpec(code) ?? keptSpec(answer.bundle.code)
      const newer = keptNewer(answer.workOrder.id)
      return { answer, asOf, spec: spec?.value ?? null, specAsOf: spec && asOf ? spec.asOf : null, specProblem: spec ? null : online ? 'unavailable' : 'offline', newer: newer?.value ?? null, due: dueOf(answer, seen), from, ...BLANK }
    },
    [from, online, seen],
  )

  const openBundle = useCallback(
    async (code: string, operationId: string | null) => {
      if (!me || !allowed) return
      const mine = ++run.current
      const kept = keptInstruction(code, operationId)
      if (!online) {
        if (!kept) {
          feedback('warning')
          return setStep({ kind: 'notOnTablet', code })
        }
        feedback('success')
        return setStep({ kind: 'open', work: workOf(kept.value, kept.asOf, code) })
      }
      setStep({ kind: 'loading', code })
      const [answer, spec] = await Promise.all([fetchInstruction(api, code, operationId), fetchSpec(api, code)])
      if (mine !== run.current) return
      if (!answer.ok) {
        if (answer.problem.kind === 'signedOut') return void sessionEnded()
        if (answer.problem.kind === 'offline') {
          if (kept) return setStep({ kind: 'open', work: workOf(kept.value, kept.asOf, code) })
          return setStep({ kind: 'notOnTablet', code })
        }
        feedback('error')
        return setStep({ kind: 'failed', code, problem: answer.problem })
      }
      keepInstruction(code, operationId, answer.value)
      if (spec.ok) keepSpec(code, spec.value)
      const newer = await fetchNewerSpec(api, answer.value.workOrder.id)
      if (mine !== run.current) return
      if (newer.ok) keepNewer(answer.value.workOrder.id, newer.value)
      const work = workOf(answer.value, null, code)
      feedback(work.due ? 'warning' : 'success')
      setStep({ kind: 'open', work: { ...work, spec: spec.ok ? spec.value : work.spec, specProblem: spec.ok ? null : work.spec ? null : 'unavailable' } })
      void keepMediaOf(api, answer.value)
    },
    [allowed, api, feedback, me, online, sessionEnded, workOf],
  )

  // The bundle handed over (the Operation screen, a scan on another page), once.
  const opened = useRef(false)
  useEffect(() => {
    if (opened.current || !me || !allowed) return
    opened.current = true
    const code = offer.current?.code ?? handed.current ?? null
    if (code) void openBundle(code, offer.current?.operationId ?? null)
  }, [me, allowed, openBundle])

  // The person's open bundles here (For this work): one running opens by itself when nothing was handed over.
  useEffect(() => {
    if (!me || !allowed || !person) return
    if (!online) return setItems(withLeft(person, []))
    let gone = false
    void fetchOpenWork(api).then((answer) => {
      if (gone) return
      if (!answer.ok && answer.problem.kind === 'signedOut') return void sessionEnded()
      const list = inHand(withLeft(person, answer.ok ? answer.value : []))
      setItems(list)
      const one = openByItself(list)
      if (one && !autoOpened.current && !offer.current?.code && !handed.current && from !== 'mywork' && latest.current.kind === 'scan') {
        autoOpened.current = true
        void openBundle(one.bundleCode, one.operation.id)
      }
    })
    return () => {
      gone = true
    }
  }, [allowed, api, from, me, online, openBundle, person, sessionEnded])

  // Back online with the spec or the banner not read (opened offline): read them now, once per bundle.
  const reread = useRef<string | null>(null)
  const missing = step.kind === 'open' && (step.work.spec === null || step.work.asOf !== null) ? step.work.answer : null
  useEffect(() => {
    if (!online || !missing || reread.current === missing.bundle.code) return
    reread.current = missing.bundle.code
    const code = missing.bundle.code
    void Promise.all([fetchSpec(api, code), fetchNewerSpec(api, missing.workOrder.id)]).then(([spec, newer]) => {
      if (spec.ok) keepSpec(code, spec.value)
      if (newer.ok) keepNewer(missing.workOrder.id, newer.value)
      setStep((now) =>
        now.kind === 'open' && now.work.answer.bundle.code === code
          ? { ...now, work: { ...now.work, ...(spec.ok ? { spec: spec.value, specAsOf: null, specProblem: null } : {}), ...(newer.ok ? { newer: newer.value } : {}) } }
          : now,
      )
    })
  }, [api, online, missing])

  // ---- the photos and videos of the step on screen (then the rest, in the background) ---------------------------------------

  const openWork = step.kind === 'open' || step.kind === 'problem' || step.kind === 'sent' ? step.work : null
  const shownStep = openWork?.answer.instruction?.steps[openWork.index] ?? null
  useEffect(() => {
    const media = shownStep?.media ?? []
    if (media.length === 0) return
    let gone = false
    for (const medium of media) {
      const kept = keptMedium(medium.id)
      if (kept) {
        setSrc((now) => (now[medium.id] === kept ? now : { ...now, [medium.id]: kept }))
        continue
      }
      if (mediumFailed(medium.id)) {
        setFailed((now) => (now.includes(medium.id) ? now : [...now, medium.id]))
        continue
      }
      if (!online) continue
      setSrc((now) => ({ ...now, [medium.id]: now[medium.id] ?? null }))
      void loadMedium(api, medium.id).then((url) => {
        if (gone) return
        if (url) setSrc((now) => ({ ...now, [medium.id]: url }))
        else {
          setSrc((now) => ({ ...now, [medium.id]: undefined }))
          if (mediumFailed(medium.id)) setFailed((now) => (now.includes(medium.id) ? now : [...now, medium.id]))
        }
      })
    }
    return () => {
      gone = true
    }
  }, [api, online, shownStep])

  // ---- Seen and the spec problem: their ticks from the queue -----------------------------------------------------------------

  useEffect(() => {
    const now = latest.current
    if (now.kind === 'open' && seenEvent.current && now.work.seen) {
      const view = queuedView(queueSnapshot, seenEvent.current)
      if (view && (view.ticks !== now.work.seen.ticks || (view.refusal?.code ?? null) !== now.work.seen.refusal)) setStep({ ...now, work: { ...now.work, seen: { ticks: view.ticks, refusal: view.refusal?.code ?? null } } })
    }
    const event = problemEvent.current
    if (now.kind === 'sent' && event?.clientEventId) {
      const view = queuedView(queueSnapshot, event.clientEventId)
      if (!view) return
      const result = view.ticks === 'recorded' ? view.item?.result : null
      if (result && result.type === 'ChangeRequest' && !event.requestId) event.requestId = result.id
      if (view.ticks !== now.sent.ticks || (view.refusal?.code ?? null) !== now.sent.refusal) setStep({ ...now, sent: { ...now.sent, ticks: view.ticks, refusal: view.refusal?.code ?? null } })
      if (event.requestId && photo.current && online && !event.uploading) void sendPhoto(event.requestId, now.work)
    }
  }, [queueSnapshot, online])

  const sendPhoto = async (requestId: string, work: OpenWork) => {
    const taken = photo.current
    const event = problemEvent.current
    if (!taken || !event || event.uploading) return
    event.uploading = true
    setStep((now) => (now.kind === 'sent' ? { ...now, sent: { ...now.sent, photo: 'sending' } } : now))
    const done = await uploadProblemPhoto(api, requestId, taken.blob, taken.name)
    event.uploading = false
    if (done.ok) photo.current = null
    else if (done.problem.kind === 'signedOut') return void sessionEnded()
    setStep((now) => (now.kind === 'sent' && now.work.answer.workOrder.id === work.answer.workOrder.id ? { ...now, sent: { ...now.sent, photo: done.ok ? 'sent' : 'failed' } } : now))
  }

  // ---- actions --------------------------------------------------------------------------------------------------------------

  const updateWork = (change: Partial<OpenWork>) => setStep((now) => (now.kind === 'open' ? { ...now, work: { ...now.work, ...change } } : now))

  const goStep = (work: OpenWork, index: number) => {
    const count = work.answer.instruction?.steps.length ?? 0
    const next = clampStep(index, count)
    updateWork({ index: next, shown: withShown(work.shown, next) })
  }

  const back = () => {
    const now = latest.current
    const work = now.kind === 'open' || now.kind === 'problem' || now.kind === 'sent' ? now.work : null
    if (now.kind === 'problem') return setStep({ kind: 'open', work: now.work })
    if (work && (work.from === 'operation' || work.from === 'start')) return store.openWith(TASK_ROUTES.operation, work.answer.bundle.code)
    if (now.kind === 'scan' || now.kind === 'noPermission') return router.push('/floor')
    run.current += 1
    setStep({ kind: 'scan' })
  }

  const look = (raw: string) => {
    if (!me || held) return
    const read = readScan(raw, me.scanTag)
    if (read.kind === 'badge') return void store.switchTo(read.code)
    if (read.kind === 'otherFactory' || read.kind === 'typo') {
      feedback('error')
      return setStep({ kind: 'scan', problem: { kind: 'unknownCode', reason: read.kind, code: read.code } })
    }
    if (read.kind === 'label' && read.type !== 'bundle') {
      feedback('error')
      return setStep({ kind: 'scan', problem: { kind: 'wrongLabel', type: read.type, code: read.code } })
    }
    void openBundle(read.code, null)
  }

  const markSeenNow = async (work: OpenWork) => {
    const body = seenBody(work.answer)
    if (!body || !person || held || work.busy) return
    if (seenHeld({ count: work.answer.instruction?.steps.length ?? 0, shown: work.shown, busy: work.busy })) return
    updateWork({ busy: true })
    const result = await onlineFirst(queue, { online, kind: 'production.instruction.ack', payload: body, attempt: (id) => sendSeen(api, body, id) })
    if (result.answer && !result.answer.ok) {
      if (result.answer.problem.kind === 'signedOut') return void sessionEnded()
      feedback('error')
      const refusal = result.answer.problem.kind === 'refused' ? result.answer.problem.code : 'UNAVAILABLE'
      return updateWork({ busy: false, seen: { ticks: 'refused', refusal } })
    }
    markSeen(person, body.versionId)
    seenEvent.current = result.kept?.clientEventId ?? null
    feedback('success')
    updateWork({ busy: false, due: null, seen: { ticks: result.kept ? 'saved' : 'recorded', refusal: null } })
  }

  const sendProblem = async (work: OpenWork, draft: ProblemDraft) => {
    const body = problemBody(work.answer, draft)
    if (!body || sendHeld(draft)) return
    setStep({ kind: 'problem', work, draft: { ...draft, busy: true } })
    photo.current = draft.photo ? { blob: draft.photo.blob, name: draft.photo.name } : null
    const result = await onlineFirst(queue, { online, kind: 'product.change.report', payload: body, attempt: (id) => sendSpecProblem(api, body, id) })
    if (result.answer && !result.answer.ok) {
      if (result.answer.problem.kind === 'signedOut') return void sessionEnded()
      feedback('error')
      const refusal = result.answer.problem.kind === 'refused' ? result.answer.problem.code : 'UNAVAILABLE'
      problemEvent.current = null
      return setStep({ kind: 'sent', work, sent: { ticks: 'refused', refusal, photo: 'none' } })
    }
    feedback('success')
    const requestId = result.answer?.ok ? result.answer.value.requestId : null
    problemEvent.current = { clientEventId: result.kept?.clientEventId ?? null, requestId, uploading: false }
    setStep({ kind: 'sent', work, sent: { ticks: result.kept ? 'saved' : 'recorded', refusal: null, photo: photo.current ? (requestId ? 'sending' : 'waiting') : 'none' } })
    if (requestId && photo.current) void sendPhoto(requestId, work)
  }

  const onAction = (action: InstructionsAction) => {
    const now = latest.current
    const work = now.kind === 'open' ? now.work : null
    switch (action.type) {
      case 'scan':
        return look(action.code)
      case 'openItem':
        return void openBundle(action.code, action.operationId)
      case 'openDue': {
        const row = dueRows(mine, seen).find((entry) => entry.versionId === action.versionId)
        if (!row) return
        const item = bundleForDue(row, items)
        if (item) return void openBundle(item.bundleCode, item.operation.id)
        return setStep({ kind: 'scan', prompt: { operation: `${row.operation.code} · ${row.operation.name}`, version: row.versionNumber } })
      }
      case 'tab':
        return updateWork({ tab: action.tab })
      case 'step':
        return work ? goStep(work, action.index) : undefined
      case 'next':
        return work ? goStep(work, work.index + 1) : undefined
      case 'prev':
        return work ? goStep(work, work.index - 1) : undefined
      case 'medium':
        return work ? updateWork({ media: { ...work.media, [work.index]: action.index } }) : undefined
      case 'zoom':
        return updateWork({ zoom: { mediaId: action.mediaId, level: 1 } })
      case 'zoomLevel':
        return work?.zoom ? updateWork({ zoom: { ...work.zoom, level: action.level } }) : undefined
      case 'zoomClose':
        return updateWork({ zoom: null })
      case 'seen':
        return work ? void markSeenNow(work) : undefined
      case 'problemOpen':
        return work ? setStep({ kind: 'problem', work, draft: EMPTY_PROBLEM }) : undefined
      case 'problemTile':
        return now.kind === 'problem' ? setStep({ ...now, draft: { ...now.draft, problem: action.problem } }) : undefined
      case 'problemNote':
        return now.kind === 'problem' ? setStep({ ...now, draft: { ...now.draft, note: action.note } }) : undefined
      case 'problemCapture':
        return now.kind === 'problem' && (online || !action.open) ? setStep({ ...now, draft: { ...now.draft, capture: action.open } }) : undefined
      case 'problemPhoto':
        return now.kind === 'problem' ? setStep({ ...now, draft: { ...now.draft, capture: false, photo: { id: `photo-${Date.now()}`, blob: action.photo, name: photoName(now.work.answer) } } }) : undefined
      case 'problemDrop':
        return now.kind === 'problem' ? setStep({ ...now, draft: { ...now.draft, photo: null } }) : undefined
      case 'problemSend':
        return now.kind === 'problem' ? void sendProblem(now.work, now.draft) : undefined
      case 'problemBack':
        return now.kind === 'problem' || now.kind === 'sent' ? setStep({ kind: 'open', work: now.work }) : undefined
      case 'back':
        return back()
      case 'home':
        return router.push('/floor')
      case 'retry':
      case 'scanAnother':
        run.current += 1
        return setStep({ kind: 'scan' })
    }
  }

  // Keys (design floor.instructions kb): arrows or Enter = next step (Enter on the last one = Seen), Esc = back.
  const onSteps = step.kind === 'open' && step.work.tab === 'steps' && step.work.zoom === null && (step.work.answer.instruction?.steps.length ?? 0) > 0
  useFloorKeys({
    enter: onSteps && step.kind === 'open' ? () => (step.work.index < (step.work.answer.instruction?.steps.length ?? 0) - 1 ? onAction({ type: 'next' }) : step.work.due && !step.work.seen ? onAction({ type: 'seen' }) : undefined) : step.kind === 'problem' && !step.draft.capture ? () => onAction({ type: 'problemSend' }) : null,
    escape: step.kind === 'open' && step.work.zoom ? null : step.kind === 'problem' && step.draft.capture ? null : back,
  })
  useEffect(() => {
    if (!onSteps) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
      const active = document.activeElement
      if (active?.closest('input, textarea, select, [aria-modal="true"]')) return
      event.preventDefault()
      onAction({ type: event.key === 'ArrowRight' ? 'next' : 'prev' })
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  if (!me) return null

  return (
    <InstructionsView
      model={{
        frame,
        step,
        online,
        held,
        inHand: items,
        due: dueRows(mine, seen),
        src,
        failed,
      }}
      onFrame={onFrame}
      onAction={onAction}
      camera={zxingCamera}
    />
  )
}
