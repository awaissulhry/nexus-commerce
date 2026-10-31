'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { newIdempotencyKey } from '../../../lib/api/client'
import { zxingCamera } from '../../camera'
import { useFloor } from '../../FloorApp'
import { useFloorKeys } from '../../keys'
import { readScan } from '../../scan/scan-model'
import type { TaskProblem } from '../shared/task-api'
import { fetchReturn, findReturn, postGrades, postReceipt, uploadPhoto, type DockReturn, type ReturnGrade } from './api'
import { anyOpen, countAll, countLine, emptyArrival, lineToGrade, matchScan, MAX_PARCELS, MAX_PHOTOS, piecesIn, placeConfirmed, placeOf, receiptBody, receiveHeld, toGrade, type Arrival, type ReturnsStage } from './model'
import { ReturnsInView, type ReturnsInAction } from './view/ReturnsInView'

/**
 * The live SCR-180 (`/floor/returnsin`): the RMA a scanned number names (on Home's scan or here), the parcel (condition,
 * parcels, photos, the customer's DDT number scanned), the lines it brings, then ONE receipt with its Idempotency-Key (kept
 * while the body is the same: a lost answer is sent again, never applied twice) and the parcel's photos onto it; then each
 * garment graded (one call per garment, its photos onto its line), then the place it goes. The receipt and the grades are
 * online only (the office's records); offline the entries stay and the actions are held with the reason. The RMA is read
 * again when the tablet's screen comes back (the office may have changed it meanwhile).
 */

interface Shot {
  readonly key: string
  readonly blob: Blob
}

export function FloorReturnsIn() {
  const store = useFloor()
  const router = useRouter()
  const feedback = useConfirmFeedback()
  const { frame, onFrame } = store.frame('tile.returnsin', { showHome: true })
  const { me, api, online, sessionEnded } = store
  const may = Boolean(me?.permissions.includes('sales.returns.receive'))
  const mayGrade = Boolean(me?.permissions.includes('sales.returns.inspect'))

  const [stage, setStage] = useState<ReturnsStage>('scan')
  const [dock, setDock] = useState<DockReturn | null>(null)
  const [arrival, setArrival] = useState<Arrival | null>(null)
  const [lastLineId, setLastLineId] = useState<string | null>(null)
  const [gradeLineId, setGradeLineId] = useState<string | null>(null)
  const [grade, setGrade] = useState<ReturnGrade | null>(null)
  const [camera, setCamera] = useState<'parcel' | 'line' | null>(null)
  const [linePhotos, setLinePhotos] = useState<Shot[]>([])
  const [placeOk, setPlaceOk] = useState(false)
  const [busy, setBusy] = useState<'read' | 'receive' | 'grade' | null>(null)
  const [photosFailed, setPhotosFailed] = useState(0)
  const [done, setDone] = useState({ pieces: 0, graded: 0 })
  const [problem, setProblem] = useState<{ problem: TaskProblem; code: string | null } | null>(null)
  const parcelShots = useRef(new Map<string, Blob>())
  const started = useRef(false)
  const receiptKey = useRef<{ body: string; key: string } | null>(null)

  const fail = useCallback(
    (found: TaskProblem, code: string | null) => {
      if (found.kind === 'signedOut') return void sessionEnded()
      feedback(found.kind === 'offline' || found.kind === 'unavailable' ? 'warning' : 'error')
      setProblem({ problem: found, code })
    },
    [feedback, sessionEnded],
  )
  const refuse = useCallback((code: string, shown: string | null) => fail({ kind: 'refused', code, message: code, fix: null }, shown), [fail])

  const reset = useCallback(() => {
    setStage('scan')
    setDock(null)
    setArrival(null)
    setLastLineId(null)
    setGradeLineId(null)
    setGrade(null)
    setCamera(null)
    setLinePhotos([])
    setPlaceOk(false)
    setPhotosFailed(0)
    setDone({ pieces: 0, graded: 0 })
    setProblem(null)
    parcelShots.current.clear()
    receiptKey.current = null
  }, [])

  /** Where an RMA opens: its parcel when lines still expect goods; else grading, else the place. */
  const firstStage = useCallback((value: DockReturn): ReturnsStage => (anyOpen(value) ? 'parcel' : mayGrade && toGrade(value).length > 0 ? 'grade' : 'route'), [mayGrade])

  const openCode = useCallback(
    async (code: string) => {
      const text = code.trim()
      if (!navigator.onLine) return fail({ kind: 'offline' }, text)
      setBusy('read')
      const answer = await findReturn(api, text)
      setBusy(null)
      if (!answer.ok) return answer.problem.kind === 'notFound' ? refuse('NOT_OPEN', text) : fail(answer.problem, text)
      feedback('success')
      reset()
      setDock(answer.value)
      setArrival(emptyArrival())
      setStage(firstStage(answer.value))
    },
    [api, fail, feedback, firstStage, refuse, reset],
  )

  const reread = useCallback(async () => {
    if (!dock || !navigator.onLine) return
    const answer = await fetchReturn(api, dock.id)
    if (answer.ok) setDock(answer.value)
    else if (answer.problem.kind === 'notFound') refuse('NOT_OPEN', dock.number)
  }, [api, dock, refuse])

  /** The photos onto their record, one after another; how many could not go (the record stands either way). */
  const sendPhotos = useCallback(
    async (returnId: string, target: { kind: 'receipt' | 'line'; id: string }, shots: readonly Shot[], name: string) => {
      let failed = 0
      for (const [index, shot] of shots.entries()) {
        const answer = await uploadPhoto(api, returnId, target, shot.blob, `${name}-${index + 1}.jpg`)
        if (!answer.ok) failed += 1
      }
      if (failed > 0) setPhotosFailed((count) => count + failed)
    },
    [api],
  )

  const receive = useCallback(async () => {
    if (!dock || !arrival || busy) return
    if (!navigator.onLine || receiveHeld(arrival)) return void feedback('warning')
    const body = receiptBody(dock, arrival)
    const text = JSON.stringify(body)
    if (receiptKey.current?.body !== text) receiptKey.current = { body: text, key: newIdempotencyKey() }
    setBusy('receive')
    const answer = await postReceipt(api, dock.id, body, receiptKey.current.key)
    if (!answer.ok) {
      setBusy(null)
      if (answer.problem.kind === 'conflict' || answer.problem.kind === 'invalid') {
        const again = await fetchReturn(api, dock.id)
        if (again.ok) setDock(again.value)
        return refuse('CHANGED', dock.number)
      }
      return fail(answer.problem, dock.number)
    }
    feedback('success')
    const shots = arrival.photos.flatMap((photo) => {
      const blob = parcelShots.current.get(photo.key)
      return blob ? [{ key: photo.key, blob }] : []
    })
    await sendPhotos(answer.value.return.id, { kind: 'receipt', id: answer.value.receiptId }, shots, `${answer.value.return.number}-parcel`)
    setBusy(null)
    parcelShots.current.clear()
    receiptKey.current = null
    setDone((before) => ({ ...before, pieces: before.pieces + piecesIn(arrival) }))
    setDock(answer.value.return)
    setArrival(emptyArrival())
    setLastLineId(null)
    setGradeLineId(null)
    setGrade(null)
    setStage(mayGrade && toGrade(answer.value.return).length > 0 ? 'grade' : 'route')
  }, [api, arrival, busy, dock, fail, feedback, mayGrade, refuse, sendPhotos])

  const confirmGrade = useCallback(async () => {
    if (!dock || busy) return
    const line = lineToGrade(dock, gradeLineId)
    if (!line || !grade || !navigator.onLine) return void feedback('warning')
    setBusy('grade')
    const answer = await postGrades(api, dock.id, { version: dock.version, lines: [{ lineId: line.id, grade }] }, newIdempotencyKey())
    if (!answer.ok) {
      setBusy(null)
      if (answer.problem.kind === 'conflict' || answer.problem.kind === 'invalid') {
        const again = await fetchReturn(api, dock.id)
        if (again.ok) setDock(again.value)
        return refuse('CHANGED', dock.number)
      }
      return fail(answer.problem, dock.number)
    }
    feedback('success')
    await sendPhotos(dock.id, { kind: 'line', id: line.id }, linePhotos, `${dock.number}-line-${line.seq}`)
    setBusy(null)
    setDone((before) => ({ ...before, graded: before.graded + 1 }))
    setDock(answer.value)
    setLinePhotos([])
    setGrade(null)
    const next = lineToGrade(answer.value, null)
    setGradeLineId(next?.id ?? null)
    if (!next) setStage('route')
  }, [api, busy, dock, fail, feedback, grade, gradeLineId, linePhotos, refuse, sendPhotos])

  const onScan = useCallback(
    async (code: string) => {
      if (!me) return
      const read = readScan(code, me.scanTag)
      if (read.kind === 'badge') {
        const refused = await store.switchTo(read.code)
        if (refused) refuse('BADGE', null)
        return
      }
      setProblem(null)
      const text = read.code.trim()
      if (stage === 'scan' || !dock || !arrival) return openCode(text)
      if (stage === 'parcel') {
        // The customer's delivery note travels with the parcel: its number is kept for the receipt.
        feedback('success')
        return setArrival({ ...arrival, ddtNumber: text.slice(0, 40) })
      }
      if (stage === 'lines') {
        const match = matchScan(dock, arrival, text)
        if (match.kind === 'line') {
          const line = dock.lines.find((entry) => entry.id === match.lineId)!
          feedback('success')
          setLastLineId(line.id)
          return setArrival(countLine(arrival, line, 1))
        }
        return refuse(match.kind === 'full' ? 'FULL' : 'NO_LINE', text)
      }
      if (stage === 'grade') {
        const waiting = toGrade(dock)
        const line = waiting.find((entry) => [entry.serial, entry.batchNumber].some((value) => value && value.trim().toUpperCase() === text.toUpperCase()))
        if (line) {
          feedback('success')
          setGrade(null)
          setLinePhotos([])
          return setGradeLineId(line.id)
        }
        return refuse(dock.lines.some((entry) => entry.grade !== null && [entry.serial, entry.batchNumber].includes(text)) ? 'GRADED' : 'NO_LINE', text)
      }
      if (stage === 'route') {
        if (placeConfirmed(placeOf(dock), text)) {
          feedback('success')
          return setPlaceOk(true)
        }
        return refuse('PLACE', text)
      }
      feedback('warning')
    },
    [arrival, dock, feedback, me, openCode, refuse, stage, store],
  )

  const takePhoto = (target: 'parcel' | 'line', photo: CapturedPhoto) => {
    const blob = photo.marked ?? photo.photo
    const key = newIdempotencyKey()
    if (target === 'parcel' && arrival) {
      if (arrival.photos.length >= MAX_PHOTOS) return void feedback('warning')
      parcelShots.current.set(key, blob)
      setArrival({ ...arrival, photos: [...arrival.photos, { key }] })
    } else if (target === 'line') {
      if (linePhotos.length >= MAX_PHOTOS) return void feedback('warning')
      setLinePhotos((before) => [...before, { key, blob }])
    }
    feedback('success')
    setCamera(null)
  }

  // A code handed from Home opens its RMA.
  useEffect(() => {
    if (started.current || !me || !may) return
    started.current = true
    const code = store.takeScan()
    if (code) void openCode(code)
  }, [may, me, openCode, store])

  // The screen comes back (the tablet woke, the network returned): the RMA is read again before more goods are counted.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && (stage === 'parcel' || stage === 'lines' || stage === 'grade')) void reread()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [reread, stage])

  const onAction = (action: ReturnsInAction) => {
    switch (action.type) {
      case 'scan':
        return void onScan(action.code)
      case 'condition':
        return setArrival((before) => (before ? { ...before, condition: action.condition } : before))
      case 'parcels':
        return setArrival((before) => (before ? { ...before, parcels: Math.min(Math.max(1, action.value ?? 1), MAX_PARCELS) } : before))
      case 'camera':
        return setCamera(action.target)
      case 'photo':
        return takePhoto(action.target, action.photo)
      case 'removePhoto':
        parcelShots.current.delete(action.key)
        return setArrival((before) => (before ? { ...before, photos: before.photos.filter((photo) => photo.key !== action.key) } : before))
      case 'clearDdt':
        return setArrival((before) => (before ? { ...before, ddtNumber: null } : before))
      case 'toLines':
        if (!arrival?.condition) return void feedback('warning')
        return setStage('lines')
      case 'toParcel':
        return setStage('parcel')
      case 'count': {
        const line = dock?.lines.find((entry) => entry.id === action.lineId)
        if (!line || !arrival) return
        const after = countLine(arrival, line, action.delta)
        if (after === arrival) return void feedback('warning')
        feedback('success')
        setLastLineId(action.delta === 1 ? line.id : (after.counts[line.id] ?? 0) > 0 ? line.id : null)
        return setArrival(after)
      }
      case 'countAll':
        if (!dock || !arrival) return
        feedback('success')
        setLastLineId(null)
        return setArrival(countAll(arrival, dock))
      case 'receive':
        return void receive()
      case 'toGrade':
        setPlaceOk(false)
        return setStage('grade')
      case 'pickLine':
        setGrade(null)
        setLinePhotos([])
        return setGradeLineId(action.lineId)
      case 'grade':
        return setGrade(action.grade)
      case 'confirmGrade':
        return void confirmGrade()
      case 'toRoute':
        return setStage('route')
      case 'finish':
        if (dock && placeOf(dock) && !placeOk) return void feedback('warning')
        feedback('success')
        return setStage('done')
      case 'next':
        return reset()
      case 'dismiss':
        return setProblem(null)
      case 'retry':
        setProblem(null)
        return void reread()
    }
  }

  useFloorKeys({
    enter: problem
      ? () => setProblem(null)
      : camera
        ? null
        : stage === 'parcel'
          ? () => onAction({ type: 'toLines' })
          : stage === 'lines'
            ? () => onAction({ type: 'receive' })
            : stage === 'grade'
              ? () => onAction({ type: 'confirmGrade' })
              : stage === 'route'
                ? () => onAction({ type: 'finish' })
                : stage === 'done'
                  ? reset
                  : null,
    escape: problem
      ? () => setProblem(null)
      : camera
        ? () => setCamera(null)
        : stage === 'lines'
          ? () => setStage('parcel')
          : stage === 'parcel' || stage === 'done'
            ? reset
            : stage === 'grade' || stage === 'route'
              ? () => setStage(stage === 'route' && dock && toGrade(dock).length > 0 && mayGrade ? 'grade' : 'route')
              : () => router.push('/floor'),
  })

  if (!me) return null
  return (
    <ReturnsInView
      model={{
        frame,
        online,
        held: me.notice.blocksScans,
        stage: may ? stage : 'noPermission',
        mayGrade,
        dock,
        arrival,
        lastLineId,
        gradeLineId,
        grade,
        linePhotos: linePhotos.length,
        camera,
        placeOk,
        busy,
        photosFailed,
        done,
        problem,
      }}
      onFrame={onFrame}
      onAction={onAction}
      camera={zxingCamera}
    />
  )
}
