'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { zxingCamera } from '../../camera'
import { useFloor, useFloorRouter } from '../../FloorApp'
import { useFloorKeys } from '../../keys'
import { readScan } from '../../scan/scan-model'
import { queuedView } from '../shared/queued'
import type { TaskProblem } from '../shared/task-api'
import { fetchBin, fetchBinDone, fetchToCount, finishOrKeep, keepBin, keptBin, keptToCount, scanOrKeep, type ScanBody } from './api'
import { binOfCode, padBounds, placeCodeOf, quantityText, unitName, unitOfScan, withLine, type BinDone, type BinRead, type CountLast, type CountPad, type KeptUnit, type ToCount } from './model'
import { CountView, type CountAction, type CountFinish, type CountProblem, type CountStep } from './view/CountView'

/**
 * The live SCR-178 (`/floor/count`; B-W2b-310 on B-W2b-299's API): Count at the warehouse. What to count is the site's running
 * counts' bins (read on view and again when the network comes back); a bin's label scanned here, a row tapped, or a COUNT task
 * handed from My work (its place) opens the bin, blind. Every unit is ONE call, online first, else kept in the tablet's queue
 * (inventory.count.scan) under the try's id and counted on this tablet's copy of the bin; Bin done reads the differences (online:
 * the expected numbers are the office's), Finish bin records the bin (online first, else kept: inventory.count.finishBin, sent
 * after the units it waits for). Offline: what the tablet read in this visit opens "as of"; a bin it never read opens from the
 * What to count it read, its lines unknown (the office matches each unit when it arrives).
 */

const binKey = (bin: Pick<BinRead, 'location' | 'count'>) => `${bin.count?.id ?? '-'}|${bin.location.id}`

export function FloorCount() {
  const store = useFloor()
  const router = useFloorRouter()
  const feedback = useConfirmFeedback()
  const { frame, onFrame } = store.frame('tile.count', { showHome: true })
  const { me, api, online, sessionEnded, queue, queueSnapshot } = store
  const may = Boolean(me?.permissions.includes('floor.work') && me.permissions.includes('inventory.counts.scan'))
  const deviceId = store.device?.device.id ?? null
  const siteId = me?.site.id ?? ''

  const [step, setStep] = useState<CountStep>(may ? { kind: 'what' } : { kind: 'noPermission' })
  const [toCount, setToCount] = useState<ToCount | null>(null)
  const [toCountAsOf, setToCountAsOf] = useState<string | null>(null)
  const [toCountProblem, setToCountProblem] = useState<'offline' | 'error' | null>(null)
  const [bin, setBin] = useState<BinRead | null>(null)
  const [placeCode, setPlaceCode] = useState<string | null>(null)
  const [binAsOf, setBinAsOf] = useState<string | null>(null)
  const [pad, setPad] = useState<CountPad | null>(null)
  const [last, setLast] = useState<CountLast | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<BinDone | null>(null)
  const [finish, setFinish] = useState<CountFinish | null>(null)
  const [problem, setProblem] = useState<CountProblem | null>(null)
  const [lastCode, setLastCode] = useState<string | null>(null)
  // Units kept on this tablet per bin in this visit (offline), until the office has them.
  const [keptByBin, setKeptByBin] = useState<Readonly<Record<string, readonly KeptUnit[]>>>({})
  const started = useRef(false)

  const fail = useCallback(
    (found: TaskProblem, code: string | null) => {
      if (found.kind === 'signedOut') return void sessionEnded()
      feedback(found.kind === 'offline' || found.kind === 'unavailable' ? 'warning' : 'error')
      setProblem({ problem: found, code })
    },
    [feedback, sessionEnded],
  )

  /** What this tablet keeps of the bin: only the units still waiting in the queue (recorded ones are the office's now). */
  const kept = useMemo(() => {
    if (!bin) return []
    return (keptByBin[binKey(bin)] ?? []).filter((unit) => {
      const view = queuedView(queueSnapshot, unit.clientEventId)
      return view !== null && (view.ticks === 'saved' || view.ticks === 'sending')
    })
  }, [bin, keptByBin, queueSnapshot])

  const loadToCount = useCallback(async () => {
    if (!navigator.onLine) {
      const remembered = keptToCount(siteId)
      setToCount(remembered?.value ?? null)
      setToCountAsOf(remembered?.asOf ?? null)
      setToCountProblem(remembered ? null : 'offline')
      return
    }
    const answer = await fetchToCount(api, siteId)
    if (answer.ok) {
      setToCount(answer.value)
      setToCountAsOf(null)
      setToCountProblem(null)
      return
    }
    if (answer.problem.kind === 'signedOut') return void sessionEnded()
    const remembered = keptToCount(siteId)
    setToCount(remembered?.value ?? null)
    setToCountAsOf(remembered?.asOf ?? null)
    setToCountProblem(remembered ? null : answer.problem.kind === 'offline' ? 'offline' : 'error')
  }, [api, sessionEnded, siteId])

  /** The bin in hand: its lines, blind; the pad and the strip start empty. */
  const holdBin = useCallback((found: BinRead, code: string, asOf: string | null) => {
    setBin(found)
    setPlaceCode(found.location.labelCode ?? code)
    setBinAsOf(asOf)
    setPad(null)
    setLast(null)
    setDone(null)
    setFinish(null)
    setStep({ kind: 'bin' })
  }, [])

  /** Offline: the bin as this tablet read it, else the What to count row it read (its lines unknown), else not on this tablet. */
  const offlineBin = useCallback(
    (code: string, countId: string | null) => {
      const remembered = keptBin(code, countId)
      if (remembered?.value.count) {
        feedback('success')
        return holdBin(remembered.value, code, remembered.asOf)
      }
      const kept = keptToCount(siteId)
      const row = kept ? binOfCode(kept.value, code) : null
      if (row && (!countId || row.count.id === countId)) {
        feedback('success')
        return holdBin({ location: row.location, counts: [row.count], count: row.count, lines: [] }, code, kept!.asOf)
      }
      setStep({ kind: 'what' })
      fail({ kind: 'offline' }, code)
    },
    [fail, feedback, holdBin, siteId],
  )

  const openBin = useCallback(
    async (code: string, countId: string | null = null) => {
      setProblem(null)
      setLastCode(code)
      if (!navigator.onLine) return offlineBin(code, countId)
      setStep({ kind: 'reading', code })
      const answer = await fetchBin(api, code, countId)
      if (!answer.ok) {
        if (answer.problem.kind === 'offline') return offlineBin(code, countId)
        setStep({ kind: 'what' })
        return fail(answer.problem, code)
      }
      const found = answer.value
      if (!found.count) {
        if (found.counts.length > 1) {
          feedback('success')
          setBin(found)
          setPlaceCode(found.location.labelCode ?? code)
          return setStep({ kind: 'choose' })
        }
        setStep({ kind: 'what' })
        return fail({ kind: 'refused', code: 'NO_COUNT_HERE', message: '', fix: null }, found.location.code)
      }
      feedback('success')
      holdBin(found, code, null)
    },
    [api, fail, feedback, holdBin, offlineBin],
  )

  /** One unit (a tag, a lot's label with its quantity, a line on the pad): online first, else kept on this tablet. */
  const post = useCallback(
    async (body: Omit<ScanBody, 'placeCode'>, shown: { code: string | null; item: string | null; uom: string | null; lineId: string | null }) => {
      if (!bin?.count || !placeCode || busy) return
      setBusy(true)
      try {
        const outcome = await scanOrKeep(api, queue, online, deviceId, bin.count.id, { placeCode, ...body })
        if (outcome.kept) {
          const unit: KeptUnit = { clientEventId: outcome.kept.clientEventId, code: body.code ?? null, lineId: shown.lineId, quantity: body.quantity ?? null }
          const key = binKey(bin)
          setKeptByBin((current) => ({ ...current, [key]: [...(current[key] ?? []), unit] }))
          setLast({ kind: 'kept', code: shown.code, item: shown.item, quantity: body.quantity ?? null, uom: shown.uom, ticks: 'saved', clientEventId: outcome.kept.clientEventId })
          setPad(null)
          return void feedback('success')
        }
        const answer = outcome.answer
        if (answer.ok) {
          const next = withLine(bin, answer.value.line)
          setBin(next)
          keepBin(placeCode, next)
          setPad(null)
          setLast({ kind: 'counted', code: body.code ?? null, item: unitName(answer.value.line), quantity: answer.value.quantity, uom: answer.value.line.item.uom, added: answer.value.added, ticks: 'recorded', clientEventId: null })
          return void feedback(answer.value.added ? 'warning' : 'success')
        }
        const found = answer.problem
        if (found.kind === 'refused' && found.code === 'ALREADY_COUNTED' && body.code) {
          setPad(null)
          setLast({ kind: 'already', code: body.code })
          return void feedback('warning')
        }
        // A lot's label the bin's copy did not know: the office asks how much it holds. The pad opens for it.
        if (found.kind === 'refused' && found.code === 'QUANTITY' && body.code && body.quantity === undefined) {
          setLast(null)
          setPad({ target: { kind: 'code', code: body.code, lineId: null, uom: null }, value: null })
          return void feedback('warning')
        }
        setPad(null)
        fail(found, body.code ?? shown.item)
      } finally {
        setBusy(false)
      }
    },
    [api, bin, busy, deviceId, fail, feedback, online, placeCode, queue],
  )

  const scanUnit = useCallback(
    (code: string) => {
      if (!bin || !me) return
      const read = readScan(code, me.scanTag)
      const unit = unitOfScan(bin, read)
      if (unit.kind === 'quantity') {
        feedback('success')
        setLast(null)
        return setPad({ target: { kind: 'code', code: unit.code, lineId: unit.line.lineId, uom: unit.line.item.uom }, value: null })
      }
      const line = unit.kind === 'tag' ? unit.line : null
      void post({ code: unit.code }, { code: unit.code, item: line ? unitName(line) : null, uom: line?.item.uom ?? null, lineId: line?.lineId ?? null })
    },
    [bin, feedback, me, post],
  )

  const countPad = useCallback(() => {
    if (!pad || !bin || pad.value === null) return
    const bounds = padBounds(pad.target.uom)
    if (pad.value < bounds.min) return
    const quantity = quantityText(pad.value, bounds.decimals)
    if (pad.target.kind === 'line') {
      const line = bin.lines.find((entry) => entry.lineId === (pad.target as { lineId: string }).lineId)
      return void post({ lineId: pad.target.lineId, quantity }, { code: null, item: line ? unitName(line) : null, uom: pad.target.uom, lineId: pad.target.lineId })
    }
    return void post({ code: pad.target.code, quantity }, { code: pad.target.code, item: null, uom: pad.target.uom, lineId: pad.target.lineId })
  }, [bin, pad, post])

  const binDone = useCallback(async () => {
    if (!bin?.count || !navigator.onLine || busy || kept.length > 0) return void feedback('warning')
    setStep({ kind: 'doneReading' })
    const answer = await fetchBinDone(api, bin.count.id, bin.location.id)
    if (!answer.ok) {
      setStep({ kind: 'bin' })
      return fail(answer.problem, bin.location.code)
    }
    feedback(answer.value.none ? 'success' : 'warning')
    setDone(answer.value)
    setStep({ kind: 'done' })
  }, [api, bin, busy, fail, feedback, kept.length])

  const finishBin = useCallback(async () => {
    if (!bin?.count || busy) return
    setBusy(true)
    try {
      const outcome = await finishOrKeep(api, queue, online, deviceId, bin.count.id, bin.location.id)
      const base = { place: bin.location.code, count: bin.count.number }
      if (outcome.kept) {
        setFinish({ ...base, answer: null, ticks: 'saved', clientEventId: outcome.kept.clientEventId })
        setStep({ kind: 'finished' })
        return void feedback('success')
      }
      if (!outcome.answer.ok) return fail(outcome.answer.problem, bin.location.code)
      setFinish({ ...base, answer: outcome.answer.value, ticks: 'recorded' })
      setStep({ kind: 'finished' })
      feedback(outcome.answer.value.recountsAsked.length > 0 ? 'warning' : 'success')
      void loadToCount()
    } finally {
      setBusy(false)
    }
  }, [api, bin, busy, deviceId, fail, feedback, loadToCount, online, queue])

  const clearBin = useCallback(() => {
    setBin(null)
    setPlaceCode(null)
    setBinAsOf(null)
    setPad(null)
    setLast(null)
    setDone(null)
    setFinish(null)
  }, [])

  const toWhat = useCallback(() => {
    clearBin()
    setProblem(null)
    setStep({ kind: 'what' })
    void loadToCount()
  }, [clearBin, loadToCount])

  const back = useCallback(() => {
    setProblem(null)
    if (pad) return setPad(null)
    if (step.kind === 'done') {
      setDone(null)
      return setStep({ kind: 'bin' })
    }
    if (step.kind === 'bin' || step.kind === 'choose' || step.kind === 'reading' || step.kind === 'finished') return toWhat()
    router.push('/floor')
  }, [pad, router, step.kind, toWhat])

  const onScan = useCallback(
    async (raw: string) => {
      if (!me || !may) return
      const read = readScan(raw, me.scanTag)
      if (read.kind === 'badge') {
        const refused = await store.switchTo(read.code)
        if (refused) fail({ kind: 'refused', code: 'BADGE', message: '', fix: null }, null)
        return
      }
      const scanned = raw.trim()
      if (scanned === '' || me.notice.blocksScans || busy) return
      setProblem(null)
      if (step.kind === 'bin' && bin?.count) {
        // The bin's own label scanned again while counting it: nothing to count (a scanner's second read).
        if (bin.location.labelCode && bin.location.labelCode.toUpperCase() === scanned.toUpperCase()) return void feedback('warning')
        return scanUnit(scanned)
      }
      if (step.kind === 'what' || step.kind === 'finished') return openBin(scanned)
    },
    [bin, busy, fail, feedback, may, me, openBin, scanUnit, step.kind, store],
  )

  // A kept unit the office recorded: the bin is read again (its lines are the office's now); a refused one leaves the count.
  const keptIds = useMemo(() => Object.values(keptByBin).flat().map((unit) => unit.clientEventId), [keptByBin])
  const recordedNow = keptIds.filter((id) => queuedView(queueSnapshot, id)?.ticks === 'recorded').length
  useEffect(() => {
    if (recordedNow === 0 || !online || !bin?.count || !placeCode || step.kind !== 'bin') return
    void fetchBin(api, placeCode, bin.count.id).then((answer) => {
      if (answer.ok && answer.value.count) setBin((current) => (current && binKey(current) === binKey(answer.value) ? answer.value : current))
    })
    // Only a newly recorded unit reads the bin again.
  }, [recordedNow])

  // The strip's and the finish's two ticks follow the queue for what is kept on this tablet.
  const lastQueued = last && last.kind === 'kept' ? queuedView(queueSnapshot, last.clientEventId) : null
  const finishId = finish?.clientEventId ?? null
  const finishQueued = finishId ? queuedView(queueSnapshot, finishId) : null

  // A label handed from Home or My work (a COUNT task's place) opens its bin; else What to count.
  useEffect(() => {
    if (started.current || !me || !may) return
    started.current = true
    void loadToCount()
    const handed = store.takeScan()
    if (handed) void openBin(handed)
  }, [loadToCount, may, me, openBin, store])

  // Back online: what is on screen is read again (it was this tablet's copy).
  useEffect(() => {
    if (!online || !may) return
    if (toCountAsOf || toCountProblem) void loadToCount()
    if (step.kind === 'bin' && binAsOf && bin?.count && placeCode) {
      void fetchBin(api, placeCode, bin.count.id).then((answer) => {
        if (answer.ok && answer.value.count) {
          setBin(answer.value)
          setBinAsOf(null)
        }
      })
    }
    // Only the network coming back reads again.
  }, [online])

  const onAction = (action: CountAction) => {
    switch (action.type) {
      case 'scan':
        return void onScan(action.code)
      case 'openBin':
        return void openBin(action.placeCode, action.countId)
      case 'pickCount':
        return void (placeCode ? openBin(placeCode, action.countId) : undefined)
      case 'line': {
        const line = bin?.lines.find((entry) => entry.lineId === action.lineId)
        if (!line || line.hide || line.pass === null) return
        setLast(null)
        return setPad({ target: { kind: 'line', lineId: line.lineId, uom: line.item.uom }, value: null })
      }
      case 'pad':
        return setPad((current) => (current ? { ...current, value: action.value } : current))
      case 'countPad':
        return countPad()
      case 'cancelPad':
        return setPad(null)
      case 'binDone':
        return void binDone()
      case 'lookAgain':
        setDone(null)
        return setStep({ kind: 'bin' })
      case 'finish':
        return void finishBin()
      case 'another':
        return toWhat()
      case 'back':
        return back()
      case 'dismiss':
        setProblem(null)
        if (step.kind === 'reading' || step.kind === 'doneReading') setStep(bin?.count && step.kind === 'doneReading' ? { kind: 'bin' } : { kind: 'what' })
        return
      case 'retry':
        setProblem(null)
        if (step.kind === 'bin' && bin?.count && placeCode) return void openBin(placeCode, bin.count.id)
        if (lastCode && step.kind !== 'bin') return void openBin(lastCode)
        return void loadToCount()
    }
  }

  useFloorKeys({
    enter: problem ? () => onAction({ type: 'dismiss' }) : step.kind === 'bin' ? (pad ? countPad : () => void binDone()) : step.kind === 'done' ? () => void finishBin() : step.kind === 'finished' ? toWhat : null,
    escape: problem ? () => onAction({ type: 'dismiss' }) : back,
    enterFromScan: step.kind === 'bin' && !pad,
  })

  if (!me) return null
  const shownLast: CountLast | null = last && last.kind === 'kept' && lastQueued ? { ...last, ticks: lastQueued.ticks } : last
  const shownFinish: CountFinish | null = finish && finishQueued && finish.ticks !== 'recorded' ? { ...finish, ticks: finishQueued.ticks } : finish
  return (
    <CountView
      model={{
        frame,
        online,
        held: me.notice.blocksScans,
        step: may ? step : { kind: 'noPermission' },
        toCount,
        toCountAsOf,
        toCountProblem,
        bin,
        placeCode: bin ? placeCodeOf(bin.location) : null,
        binAsOf,
        kept,
        pad,
        last: shownLast,
        busy,
        done,
        finish: shownFinish,
        problem,
      }}
      onFrame={onFrame}
      onAction={onAction}
      camera={zxingCamera}
    />
  )
}
