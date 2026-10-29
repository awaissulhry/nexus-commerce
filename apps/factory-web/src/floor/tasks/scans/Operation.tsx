'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { useT } from '../../../lib/i18n/provider'
import { zxingCamera } from '../../camera'
import { useFloor } from '../../FloorApp'
import { useFloorKeys } from '../../keys'
import { readScan } from '../../scan/scan-model'
import { AsOfMemory, codeKey } from '../shared/as-of'
import { queuedView } from '../shared/queued'
import type { TaskProblem } from '../shared/task-api'
import { fetchCard, fetchMine, fetchReasons } from './api'
import {
  addReason,
  afterReport,
  askPayload,
  correctionHeld,
  countsOfTarget,
  finishHeld,
  goodOf,
  NO_COUNTS,
  openingOf,
  removeReason,
  reportPayload,
  reworkOf,
  scrapOf,
  setGood,
  touched,
  undoClosesIn,
  undoOpen,
  UNDO_WINDOW_MS,
  type BundleCard,
  type CardReason,
  type CorrectionTarget,
  type LastAction,
} from './model'
import { useWedgeScans } from './wedge'
import { OperationView, type LastStrip, type OperationAction, type OperationStep } from './view/OperationView'

/**
 * The live SCR-090 (`/floor/operation`): a scanned bundle ticket opens its card (`GET /production/scans/card`), the
 * counts open at the expected number, Finish saves the report in the tablet's queue (floor-sync
 * `production.scan.report`: it works offline and is sent in order), the receipt shows its two ticks, Undo stays until the
 * next scan or two minutes (`production.scan.undo`, queued too), then "Ask a correction" (`GET /production/scans/mine`
 * online, `production.scan.ask` queued). Cards read this visit are remembered, so a bundle seen before can be reported
 * offline (the screen says "from this tablet, as of …"); one never seen says it is not on this tablet.
 */

const CARDS = new AsOfMemory<BundleCard>()
let REASONS: readonly CardReason[] | null = null

export function FloorOperation() {
  const store = useFloor()
  const router = useRouter()
  const feedback = useConfirmFeedback()
  const t = useT('floor-scans')
  const { frame, onFrame } = store.frame('tile.operation', { showHome: true })
  const { me, api, online, queue, queueSnapshot, sessionEnded } = store
  const allowed = Boolean(me?.permissions.includes('production.scan'))
  const held = Boolean(me?.notice.blocksScans)
  const [step, setStep] = useState<OperationStep>(allowed ? { kind: 'scan' } : { kind: 'noPermission' })
  const [last, setLast] = useState<LastAction | null>(null)
  const [receipt, setReceipt] = useState(false)
  const [leave, setLeave] = useState<string | null>(null)
  const [askedId, setAskedId] = useState<string | null>(null)
  const [, setTick] = useState(0)
  const prior = useRef(new Map<string, BundleCard>())
  const taken = useRef(false)
  const lastCode = useRef<string | null>(null)

  // The undo window closes by itself after two minutes: draw the strip again then.
  const closesIn = undoClosesIn(last, new Date())
  useEffect(() => {
    if (closesIn === null) return
    const timer = window.setTimeout(() => setTick((value) => value + 1), closesIn + 50)
    return () => window.clearTimeout(timer)
  }, [closesIn])

  const openCard = useCallback((card: BundleCard, asOf: string | null, scanned: string) => {
    const opening = openingOf(card)
    switch (opening.kind) {
      case 'refused':
        feedback('error')
        return setStep({ kind: 'refused', code: opening.code, message: opening.message, fix: opening.fix, card, scanned })
      case 'pick':
        feedback('success')
        return setStep({ kind: 'pick', card, options: opening.options, asOf })
      case 'counts':
        feedback('success')
        return setStep({ kind: 'counts', card, operation: opening.operation, counts: NO_COUNTS, open: null, asOf })
      case 'already': {
        feedback(opening.report.own ? 'warning' : 'error')
        const undo = opening.report.own && Date.now() - Date.parse(opening.report.serverTime) < UNDO_WINDOW_MS
        return setStep({ kind: 'already', card, operation: opening.operation, report: opening.report, undo })
      }
    }
  }, [feedback])

  const problem = useCallback(
    (found: TaskProblem, code: string) => {
      if (found.kind === 'signedOut') return void sessionEnded()
      feedback('error')
      if (found.kind === 'notFound') return setStep({ kind: 'refused', code: 'UNKNOWN_BUNDLE', message: '', fix: null, card: null, scanned: code })
      if (found.kind === 'invalid') return setStep({ kind: 'unknownCode', reason: 'typo', code })
      setStep({ kind: 'problem', problem: found, code })
    },
    [feedback, sessionEnded],
  )

  const look = useCallback(
    async (raw: string) => {
      if (!me || !allowed || held) return
      const read = readScan(raw, me.scanTag)
      if (read.kind === 'badge') {
        if (await store.switchTo(read.code)) feedback('error')
        return
      }
      setReceipt(false)
      setLeave(null)
      // Any scan ends the undo window of the last report (MES-095).
      setLast((current) => (current && !current.scannedAfter ? { ...current, scannedAfter: true } : current))
      if (read.kind === 'otherFactory' || read.kind === 'typo') {
        feedback('error')
        return setStep({ kind: 'unknownCode', reason: read.kind, code: read.code })
      }
      if (read.kind === 'label' && read.type !== 'bundle') {
        feedback('error')
        return setStep({ kind: 'wrongType', type: read.type, code: read.code })
      }
      const code = read.code
      lastCode.current = code
      const remembered = () => {
        const kept = CARDS.get(codeKey(code))
        if (kept) return openCard(kept.value, kept.asOf, code)
        feedback('warning')
        setStep({ kind: 'notOnTablet', code })
      }
      if (!online) return remembered()
      setStep({ kind: 'loading', code })
      const answer = await fetchCard(api, code)
      if (!answer.ok) {
        if (answer.problem.kind === 'offline') return remembered()
        return problem(answer.problem, code)
      }
      const card = answer.value
      CARDS.keep(codeKey(card.bundle.code), card)
      if (codeKey(card.scanned) !== codeKey(card.bundle.code)) CARDS.keep(codeKey(card.scanned), card)
      REASONS = card.reasons
      openCard(card, null, code)
    },
    [me, allowed, held, store, feedback, online, api, openCard, problem],
  )

  // A scan while counts are typed asks first (design frame.leave-count).
  const onScan = useCallback(
    (code: string) => {
      if ((step.kind === 'counts' && touched(step.counts)) || step.kind === 'correct') return setLeave(code)
      void look(code)
    },
    [step, look],
  )

  // A code scanned on Home opens here with it.
  useEffect(() => {
    if (taken.current) return
    taken.current = true
    const code = store.takeScan()
    if (code) void look(code)
  }, [look, store])

  useWedgeScans(onScan, step.kind !== 'scan' && step.kind !== 'noPermission' && leave === null)

  const undo = async () => {
    if (!last || !undoOpen(last, new Date())) return
    try {
      const item = await queue.enqueue('production.scan.undo', { undoesClientScanId: last.clientEventId })
      const before = prior.current.get(last.clientEventId)
      if (before) CARDS.keep(codeKey(last.bundleCode), before)
      setLast({ ...last, undoEventId: item.clientEventId })
      setReceipt(false)
      setStep({ kind: 'scan' })
      feedback('success')
    } catch {
      feedback('error')
      setStep({ kind: 'problem', problem: { kind: 'unavailable' }, code: null })
    }
  }

  const finish = async () => {
    if (step.kind !== 'counts' || step.busy) return
    const { card, operation, counts } = step
    const expected = operation.expected ?? card.bundle.quantity
    if (finishHeld(counts, operation.expected)) {
      feedback('warning')
      return
    }
    setStep({ ...step, busy: true })
    try {
      const item = await queue.enqueue('production.scan.report', reportPayload(card, operation.id, counts, expected))
      prior.current.set(item.clientEventId, card)
      CARDS.keep(codeKey(card.bundle.code), afterReport(card, operation.id, counts, expected, new Date(item.occurredAt)))
      setLast({
        clientEventId: item.clientEventId,
        bundleCode: card.bundle.code,
        operation: { id: operation.id, seq: operation.seq, code: operation.code, name: operation.name },
        good: goodOf(counts, expected),
        scrap: counts.scrap,
        rework: counts.rework,
        at: item.occurredAt,
        scannedAfter: false,
        undoEventId: null,
        askEventId: null,
      })
      setReceipt(true)
      setStep({ kind: 'scan' })
      feedback('success')
    } catch {
      feedback('error')
      setStep({ kind: 'problem', problem: { kind: 'unavailable' }, code: card.bundle.code })
    }
  }

  const localTarget = (): CorrectionTarget | null =>
    last && !last.undoEventId
      ? { key: `local:${last.clientEventId}`, scanId: null, clientScanId: last.clientEventId, bundleCode: last.bundleCode, operation: last.operation, good: last.good, scrap: last.scrap, rework: last.rework, at: last.at, pending: Boolean(last.askEventId) }
      : null

  const openCorrections = async () => {
    const local = localTarget()
    if (!online) return setStep({ kind: 'corrections', targets: local ? [local] : [], offline: true })
    setStep({ kind: 'corrections', targets: null, offline: false })
    const [mine, reasons] = await Promise.all([fetchMine(api), REASONS ? Promise.resolve(null) : fetchReasons(api)])
    if (reasons?.ok) REASONS = reasons.value
    if (!mine.ok) {
      if (mine.problem.kind === 'signedOut') return void sessionEnded()
      return setStep({ kind: 'corrections', targets: local ? [local] : [], offline: mine.problem.kind === 'offline', problem: mine.problem.kind === 'offline' ? null : mine.problem })
    }
    const targets = mine.value.targets
    const merged = local && !targets.some((target) => target.clientScanId === local.clientScanId) ? [local, ...targets] : targets
    setStep({ kind: 'corrections', targets: merged, offline: false })
  }

  const sendCorrection = async () => {
    if (step.kind !== 'correct' || !step.reason) return
    if (correctionHeld(step.target, step.counts, step.reason)) {
      feedback('warning')
      return
    }
    try {
      const item = await queue.enqueue('production.scan.ask', askPayload(step.target, step.counts, t(`correction.reason.${step.reason}`)))
      if (last && step.target.clientScanId === last.clientEventId) setLast({ ...last, askEventId: item.clientEventId })
      setAskedId(item.clientEventId)
      setStep({ kind: 'asked', target: step.target, ticks: 'saved' })
      feedback('success')
    } catch {
      feedback('error')
      setStep({ kind: 'problem', problem: { kind: 'unavailable' }, code: null })
    }
  }

  const back = () => {
    setLeave(null)
    setStep(allowed ? { kind: 'scan' } : { kind: 'noPermission' })
  }

  const onAction = (action: OperationAction) => {
    switch (action.type) {
      case 'scan':
        return onScan(action.code)
      case 'pick':
        if (step.kind !== 'pick') return
        return setStep({ kind: 'counts', card: step.card, operation: step.options.find((operation) => operation.id === action.operationId) ?? step.options[0]!, counts: NO_COUNTS, open: null, asOf: step.asOf })
      case 'reason':
      case 'unreason':
      case 'good':
      case 'open': {
        if (step.kind !== 'counts' && step.kind !== 'correct') return
        const expected = step.kind === 'counts' ? (step.operation.expected ?? step.card.bundle.quantity) : step.target.good + scrapOf(step.target) + reworkOf(step.target)
        if (action.type === 'open') return setStep({ ...step, open: action.what, problem: null })
        const move =
          action.type === 'reason' ? addReason(step.counts, action.kind, action.code, expected) : action.type === 'unreason' ? { ok: true as const, counts: removeReason(step.counts, action.kind, action.code) } : setGood(step.counts, action.value, expected)
        if (!move.ok) {
          feedback('warning')
          return setStep({ ...step, problem: 'atMost' })
        }
        return setStep({ ...step, counts: move.counts, problem: null })
      }
      case 'finish':
        return void finish()
      case 'back':
        return back()
      case 'undo':
        return void undo()
      case 'undoReport': {
        if (step.kind !== 'already') return
        // The report just made here: its queue id; else the office's id of the own report on this device.
        if (last && last.bundleCode === step.card.bundle.code && last.operation.id === step.operation.id) return void undo()
        if (!action.scanId) return
        void queue
          .enqueue('production.scan.undo', { scanId: action.scanId })
          .then((item) => {
            const report = step.report
            setLast({
              clientEventId: '',
              bundleCode: step.card.bundle.code,
              operation: { id: step.operation.id, seq: step.operation.seq, code: step.operation.code, name: step.operation.name },
              good: report.goodQuantity,
              scrap: report.scrapQuantity > 0 ? { '': report.scrapQuantity } : {},
              rework: report.reworkQuantity > 0 ? { '': report.reworkQuantity } : {},
              at: report.serverTime,
              scannedAfter: true,
              undoEventId: item.clientEventId,
              askEventId: null,
            })
            CARDS.forget(codeKey(step.card.bundle.code))
            setStep({ kind: 'scan' })
            feedback('success')
          })
          .catch(() => feedback('error'))
        return
      }
      case 'corrections':
        return void openCorrections()
      case 'target': {
        if (step.kind !== 'corrections') return
        const target = step.targets?.find((row) => row.key === action.key)
        if (!target || target.pending) return
        return setStep({ kind: 'correct', target, counts: countsOfTarget(target), open: null, reason: null, reasons: REASONS ?? [] })
      }
      case 'correctionReason':
        if (step.kind !== 'correct') return
        return setStep({ ...step, reason: action.reason })
      case 'send':
        return void sendCorrection()
      case 'retry':
        if (lastCode.current) return void look(lastCode.current)
        return back()
      case 'home':
        return router.push('/floor')
      case 'leave': {
        const code = leave
        setLeave(null)
        if (action.leave && code) void look(code)
        return
      }
    }
  }

  useFloorKeys({
    enter: step.kind === 'counts' ? () => void finish() : step.kind === 'pick' ? () => onAction({ type: 'pick', operationId: step.options[0]!.id }) : step.kind === 'correct' ? () => void sendCorrection() : null,
    escape: leave !== null ? null : step.kind === 'scan' || step.kind === 'noPermission' ? () => router.push('/floor') : step.kind === 'correct' ? () => void openCorrections() : back,
  })

  if (!me) return null

  // The last report's strip, with its two ticks from the queue (and the undo's own once undone).
  const now = new Date()
  const reportTicks = last?.clientEventId ? (queuedView(queueSnapshot, last.clientEventId)?.ticks ?? 'recorded') : null
  const strip: LastStrip | null = last
    ? {
        bundleCode: last.bundleCode,
        operationSeq: last.operation.seq,
        good: last.good,
        scrap: scrapOf(last),
        rework: reworkOf(last),
        ticks: reportTicks,
        undo: last.undoEventId ? 'undone' : undoOpen(last, now) ? 'open' : 'closed',
        undoTicks: last.undoEventId ? (queuedView(queueSnapshot, last.undoEventId)?.ticks ?? 'recorded') : null,
      }
    : null
  const shown: OperationStep = step.kind === 'asked' && askedId ? { ...step, ticks: queuedView(queueSnapshot, askedId)?.ticks ?? 'recorded' } : step
  const pending = step.kind === 'counts' ? step : null

  return (
    <OperationView
      model={{
        frame,
        step: shown,
        last: strip,
        receipt,
        online,
        held,
        leave: leave && pending ? { bundleCode: pending.card.bundle.code, operationSeq: pending.operation.seq, scrap: scrapOf(pending.counts), rework: reworkOf(pending.counts) } : leave && step.kind === 'correct' ? { bundleCode: step.target.bundleCode, operationSeq: step.target.operation.seq, scrap: scrapOf(step.counts), rework: reworkOf(step.counts) } : null,
      }}
      onFrame={onFrame}
      onAction={onAction}
      camera={zxingCamera}
    />
  )
}
