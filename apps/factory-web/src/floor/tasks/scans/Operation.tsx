'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useConfirmFeedback } from '@nexus/ui/floor'
import type { FeedbackKind } from '@nexus/ui/floor'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useT } from '../../../lib/i18n/provider'
import { zxingCamera } from '../../camera'
import { useFloor, useFloorRouter } from '../../FloorApp'
import { useFloorKeys } from '../../keys'
import { readScan } from '../../scan/scan-model'
import { AsOfMemory, codeKey } from '../shared/as-of'
import { queuedView } from '../shared/queued'
import type { TaskProblem } from '../shared/task-api'
import { listBeforeRead, readListReasons } from '../reasons/api'
import type { PickerReason } from '../reasons/model'
import {
  checkLot,
  endOffStandard,
  fetchCard,
  fetchCheck,
  fetchCrew,
  fetchMine,
  fetchOffStandard,
  fetchOpenWork,
  fetchReasons,
  fetchSetCheck,
  fetchSteps,
  fetchTiming,
  finishSeveral,
  overrideReport,
  overrideStart,
  postTiming,
  startOffStandard,
  uploadNoteFile,
  type OverrideLead,
  type TimingAnswer,
  type TimingRoute,
} from './api'
import { addLot, componentLines, dropLot, garmentsOn, heldFindings, lineOf, overrideCounts, quantityRule, sameLot, stepLot, tickStep, toldFindings, workHold, type GuardLine, type StepOutcome } from './checks'
import { startedBlock, type OffStandardBlock, type OffStandardTile } from './indirect'
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
  totalOf,
  touched,
  undoClosesIn,
  undoOpen,
  UNDO_WINDOW_MS,
  type BundleCard,
  type CardOperation,
  type CardReason,
  type CorrectionTarget,
  type LastAction,
} from './model'
import { forgetLeft, keepLeft, leftCounts, withLeft } from './left'
import { moreFiles, NEW_NOTE, notePayload, noteHeld, type NoteDraft } from './notes'
import { addToStack, afterFinish, expectedOf, joinedBundles, stackItems, stackTotals, stepRow, takeOffStack, type StackRow } from './stack'
import { afterPause, afterResume, afterStart, piecesLeft, skewOf, type OpenItem } from './timing'
import { useWedgeScans } from './wedge'
import { NO_WORK, OperationView, type CountsStep, type DoneLine, type LastStrip, type OperationAction, type OperationStep, type Work } from './view/OperationView'
import type { OverrideModel } from './view/OverrideDialog'

/**
 * The live SCR-090 (`/floor/operation`): a scanned bundle ticket opens its card (`GET /production/scans/card`), the
 * counts open at the expected number, Finish saves the report in the tablet's queue (floor-sync
 * `production.scan.report`: it works offline and is sent in order), the receipt shows its two ticks, Undo stays until the
 * next scan or two minutes (`production.scan.undo`, queued too), then "Ask a correction" (`GET /production/scans/mine`
 * online, `production.scan.ask` queued). Cards read this visit are remembered, so a bundle seen before can be reported
 * offline (the screen says "from this tablet, as of …"); one never seen says it is not on this tablet.
 *
 * B-W2b-69: right after the scan the API says the rest of the bundle at this operation (`/production/terminal/state`, the checks,
 * the steps), kept for the visit beside the card. Timing actions and no-bundle tiles answer at once while online, so a refusal is a
 * screen and not a surprise in the queue, and queue the same action when the network is gone; a tick, a note and the report always
 * queue. A check that holds is a red screen; the team leader's override only exists online (the server checks the PIN).
 */

const CARDS = new AsOfMemory<BundleCard>()
/** What the API said about a bundle at an operation, kept beside the card for an offline scan of the same bundle. */
const WORK = new AsOfMemory<Work>()
let WORK_PERSON: string | null = null
let REASONS: readonly CardReason[] | null = null
const PAUSE_LIST = ['PAUSE']
const workKey = (code: string, operationId: string) => `${codeKey(code)}:${operationId}`

interface OverrideTarget {
  readonly target: 'report' | 'start' | 'stack'
  readonly clientScanId: string
  readonly body: Readonly<Record<string, unknown>>
  /** The counts step (report, start), or the stack row. */
  readonly from: CountsStep | null
  readonly rowId: string | null
  readonly rows: readonly StackRow[]
}

export function FloorOperation() {
  const store = useFloor()
  const router = useFloorRouter()
  const confirm = useConfirmFeedback()
  // Colour, vibration and sound together (MES-108): the screen's own area flashes.
  const feedback = useCallback((kind: FeedbackKind) => confirm(kind, document.getElementById('fw-op-flash')), [confirm])
  const t = useT('floor-scans')
  const { frame, onFrame } = store.frame('tile.operation', { showHome: true })
  const { me, api, online, queue, queueSnapshot, sessionEnded, device } = store
  const allowed = Boolean(me?.permissions.includes('production.scan'))
  // What the tablet kept about a bundle speaks of "you": it never reaches the next person on the tablet.
  if (me && me.worker.id !== WORK_PERSON) {
    WORK.clear()
    WORK_PERSON = me.worker.id
  }
  const held = Boolean(me?.notice.blocksScans)
  const [step, setStep] = useState<OperationStep>(allowed ? { kind: 'scan' } : { kind: 'noPermission' })
  const [last, setLast] = useState<LastAction | null>(null)
  const [receipt, setReceipt] = useState(false)
  const [leave, setLeave] = useState<string | null>(null)
  const [askedId, setAskedId] = useState<string | null>(null)
  const person = me?.worker.id ?? null
  // Online the read below answers; with the network gone, what this person left here.
  const [resume, setResume] = useState<readonly OpenItem[]>(() => (person ? withLeft(person, []) : []))
  const [running, setRunning] = useState<{ block: OffStandardBlock; skewMs: number } | null>(null)
  const [tiles, setTiles] = useState<readonly OffStandardTile[] | null>(null)
  const [override, setOverride] = useState<(OverrideModel & { readonly work: OverrideTarget }) | null>(null)
  const [handingBack, setHandingBack] = useState(false)
  const [leavingStack, setLeavingStack] = useState(false)
  const [done, setDone] = useState<(Omit<DoneLine, 'ticks'> & { readonly queued: string | null }) | null>(null)
  const [pauseReasons, setPauseReasons] = useState<readonly PickerReason[]>([])
  const [, setTick] = useState(0)
  const prior = useRef(new Map<string, BundleCard>())
  const taken = useRef(false)
  const lastCode = useRef<string | null>(null)
  // A second scan overtakes the first one's reads.
  const lookRun = useRef(0)
  const crew = useRef<readonly string[]>([])
  const sameTicket = useRef<(from: CountsStep) => void>(() => undefined)
  // The rest of the stack while one of its bundles is reported alone: it comes back after that report.
  const parked = useRef<readonly StackRow[]>([])
  // The stack as it stands now: a scanner reads the next ticket before this one's card has answered, and no ticket may be lost.
  const stackNow = useRef<readonly StackRow[]>([])
  stackNow.current = step.kind === 'stack' ? step.rows : []
  // One action at a time: a gloved double tap is one tap.
  const acting = useRef(false)

  // B-W2b-F6: a move to another page keeps what was typed and the open work (left.ts).
  useEffect(() => {
    if (person && step.kind === 'counts') keepLeft(person, step)
  }, [person, step])

  // The undo window closes by itself after two minutes: draw the strip again then.
  const closesIn = undoClosesIn(last, new Date())
  useEffect(() => {
    if (closesIn === null) return
    const timer = window.setTimeout(() => setTick((value) => value + 1), closesIn + 50)
    return () => window.clearTimeout(timer)
  }, [closesIn])

  /** The rest of the bundle at this operation: read while online (a read that fails leaves that part unknown), else what the tablet kept. */
  const readWork = useCallback(
    async (card: BundleCard, operation: CardOperation): Promise<Work> => {
      const key = workKey(card.bundle.code, operation.id)
      if (!online) return WORK.get(key)?.value ?? NO_WORK
      const [state, check, steps] = await Promise.all([fetchTiming(api, card.bundle.code, operation.id), fetchCheck(api, card.bundle.code, operation.id), fetchSteps(api, card.bundle.code, operation.id)])
      if ([state, check, steps].some((answer) => !answer.ok && answer.problem.kind === 'signedOut')) void sessionEnded()
      const work: Work = {
        ...NO_WORK,
        timing: state.ok ? state.value.timing : null,
        skewMs: state.ok ? skewOf(state.value.serverTime, new Date()) : 0,
        check: check.ok ? check.value : null,
        steps: steps.ok && steps.value.steps.length > 0 ? steps.value : null,
      }
      WORK.keep(key, work)
      return work
    },
    [api, online, sessionEnded],
  )

  const openOperation = useCallback(
    async (card: BundleCard, operation: CardOperation, asOf: string | null, run: number) => {
      const work = await readWork(card, operation)
      if (run !== lookRun.current) return
      // What reached the operation is the check's (a skipped operation has no `expected` on the card).
      const at = { ...operation, expected: work.check?.expected ?? operation.expected }
      // B-W2b-F6: what this person typed before moving to another page comes back with the bundle.
      const counts = (person && leftCounts(person, card.bundle.code, operation.id)) || NO_COUNTS
      const from: CountsStep = { kind: 'counts', card, operation: at, counts, open: null, asOf, work }
      const held = heldFindings(work.check).map(lineOf)
      if (held.length > 0) {
        feedback('error')
        return setStep({ kind: 'guard', from, lines: held, target: 'report' })
      }
      feedback(toldFindings(work.check).length > 0 ? 'warning' : 'success')
      setStep(from)
    },
    [feedback, person, readWork],
  )

  const openCard = useCallback(
    (card: BundleCard, asOf: string | null, scanned: string, run: number) => {
      const opening = openingOf(card)
      switch (opening.kind) {
        case 'refused':
          feedback('error')
          return setStep({ kind: 'refused', code: opening.code, message: opening.message, fix: opening.fix, card, scanned })
        case 'pick':
          feedback('success')
          return setStep({ kind: 'pick', card, options: opening.options, asOf })
        case 'counts':
          return void openOperation(card, opening.operation, asOf, run)
        case 'already': {
          feedback(opening.report.own ? 'warning' : 'error')
          const undo = opening.report.own && Date.now() - Date.parse(opening.report.serverTime) < UNDO_WINDOW_MS
          return setStep({ kind: 'already', card, operation: opening.operation, report: opening.report, undo })
        }
      }
    },
    [feedback, openOperation],
  )

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
      setDone(null)
      setLeave(null)
      const run = ++lookRun.current
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
        if (kept) return openCard(kept.value, kept.asOf, code, run)
        feedback('warning')
        setStep({ kind: 'notOnTablet', code })
      }
      if (!online) return remembered()
      setStep({ kind: 'loading', code })
      const answer = await fetchCard(api, code)
      if (run !== lookRun.current) return
      if (!answer.ok) {
        if (answer.problem.kind === 'offline') return remembered()
        return problem(answer.problem, code)
      }
      const card = answer.value
      CARDS.keep(codeKey(card.bundle.code), card)
      if (codeKey(card.scanned) !== codeKey(card.bundle.code)) CARDS.keep(codeKey(card.scanned), card)
      REASONS = card.reasons
      openCard(card, null, code, run)
    },
    [me, allowed, held, store, feedback, online, api, openCard, problem],
  )

  const updateCounts = useCallback((step: CountsStep, change: Partial<Work>) => {
    const work = { ...(step.work ?? NO_WORK), ...change }
    WORK.keep(workKey(step.card.bundle.code, step.operation.id), work)
    return { ...step, work }
  }, [])

  // ---- a lot scanned at the operation (MES-114) ---------------------------------------------------------------------------------
  const scanLot = useCallback(
    async (step: CountsStep, code: string) => {
      const work = step.work ?? NO_WORK
      const expected = step.operation.expected ?? step.card.bundle.quantity
      const asked = work.check?.components.asked ?? []
      const garments = garmentsOn(step.counts, expected)
      const add = (line: { code: string; itemId: string | null }, unchecked: boolean) => {
        feedback('success')
        setStep((now) => (now.kind === 'counts' ? updateCounts(now, { lots: addLot(asked, now.work?.lots ?? [], { ...line, garments: null }, garments), lotRefusal: null, lotsUnchecked: unchecked || now.work?.lotsUnchecked }) : now))
      }
      if (work.lots.some((line) => sameLot(line.code, code))) return void feedback('warning')
      if (!online) return add({ code, itemId: null }, true)
      const answer = await checkLot(api, { code, bundle: step.card.bundle.code, workOrderOperationId: step.operation.id })
      if (!answer.ok) {
        if (answer.problem.kind === 'signedOut') return void sessionEnded()
        if (answer.problem.kind === 'offline') return add({ code, itemId: null }, true)
        feedback('error')
        return setStep((now) => (now.kind === 'counts' ? { ...now, work: { ...(now.work ?? NO_WORK), lotRefusal: { code: 'UNKNOWN_LOT', message: '', fix: null } } } : now))
      }
      if (answer.value.refusal || !answer.value.lot) {
        feedback('error')
        const refusal = answer.value.refusal ?? { code: 'UNKNOWN_LOT', message: '', fix: '' }
        return setStep((now) => (now.kind === 'counts' ? { ...now, work: { ...(now.work ?? NO_WORK), lotRefusal: refusal } } : now))
      }
      add({ code: answer.value.lot.code, itemId: answer.value.lot.itemId }, false)
    },
    [api, feedback, online, sessionEnded, updateCounts],
  )

  // ---- the stack (MES-100) ----------------------------------------------------------------------------------------------------
  const stackScan = useCallback(
    async (raw: string) => {
      if (step.kind !== 'stack' || !me) return
      const say = (key: string, code: string, tone: 'warning' | 'danger') => {
        feedback(tone === 'danger' ? 'error' : 'warning')
        setStep((now) => (now.kind === 'stack' ? { ...now, line: { key, params: { code }, tone } } : now))
      }
      const read = readScan(raw, me.scanTag)
      if (read.kind === 'badge') return void (await store.switchTo(read.code))
      if (read.kind === 'otherFactory' || read.kind === 'typo' || (read.kind === 'label' && read.type !== 'bundle')) return say('notBundle', read.code, 'danger')
      const kept = CARDS.get(codeKey(read.code))
      let card = kept?.value ?? null
      if (online) {
        const answer = await fetchCard(api, read.code)
        if (answer.ok) {
          card = answer.value
          CARDS.keep(codeKey(card.bundle.code), card)
          REASONS = card.reasons
        } else if (answer.problem.kind === 'signedOut') return void sessionEnded()
        else if (answer.problem.kind !== 'offline') card = null
      }
      if (!card) return say(online ? 'notFound' : 'notOnTablet', read.code, 'warning')
      const opening = openingOf(card)
      if (opening.kind !== 'counts') return say(opening.kind === 'pick' ? 'pick' : opening.kind === 'already' ? 'already' : 'refused', card.bundle.code, opening.kind === 'pick' ? 'warning' : 'danger')
      const row: StackRow = { clientScanId: newIdempotencyKey(), card, operation: opening.operation, counts: NO_COUNTS, refusal: null }
      const added = addToStack(stackNow.current, row)
      if (!added.ok) return say(added.why, card.bundle.code, 'warning')
      stackNow.current = added.rows
      setStep((now) => (now.kind === 'stack' ? { ...now, rows: added.rows, line: null } : now))
      feedback('success')
      // Parts of one work order joined here must be of one shade (MES-078).
      const joined = joinedBundles(added.rows)
      let mismatch = false
      if (online && joined.length >= 2 && me.permissions.includes('production.bundles')) {
        const set = await fetchSetCheck(api, joined)
        mismatch = set.ok && !set.value.ok
        if (mismatch) feedback('error')
      }
      setStep((now) => (now.kind === 'stack' ? { ...now, line: mismatch ? { key: 'shade', tone: 'danger' } : null, mismatch } : now))
    },
    [api, feedback, me, online, sessionEnded, step, store, t],
  )

  // A scan while counts are typed asks first (design frame.leave-count). The ticket again starts or resumes it; a lot's label
  // goes to the lots; on the stack a scan adds a bundle.
  const onScan = useCallback(
    (code: string) => {
      if (step.kind === 'stack') return void stackScan(code)
      if (step.kind === 'counts' && me) {
        const read = readScan(code, me.scanTag)
        const asked = (step.work?.check?.components.asked.length ?? 0) > 0
        if ((read.kind === 'label' && read.type === 'lot') || (read.kind === 'free' && asked)) return void scanLot(step, read.code)
        if (read.kind === 'label' && read.type === 'bundle' && codeKey(read.code) === codeKey(step.card.bundle.code)) return sameTicket.current(step)
      }
      if ((step.kind === 'counts' && touched(step.counts)) || step.kind === 'correct') return setLeave(code)
      void look(code)
    },
    [step, look, me, scanLot, stackScan],
  )

  // A code scanned on Home opens here with it.
  useEffect(() => {
    if (taken.current) return
    taken.current = true
    const code = store.takeScan()
    if (code) void look(code)
  }, [look, store])

  useWedgeScans(onScan, step.kind !== 'scan' && step.kind !== 'stack' && step.kind !== 'note' && step.kind !== 'noPermission' && leave === null && override === null)

  // What runs for this person and the lists the screen needs: read once on opening (Continue, the running block, the crew).
  useEffect(() => {
    if (!me || !allowed || !online) return
    let live = true
    void fetchOpenWork(api).then((answer) => live && answer.ok && setResume(answer.value))
    void fetchOffStandard(api).then((answer) => {
      if (!live || !answer.ok) return
      setTiles(answer.value.codes)
      setRunning(answer.value.running ? { block: answer.value.running, skewMs: 0 } : null)
    })
    void fetchCrew(api).then((answer) => {
      if (live && answer.ok) crew.current = answer.value
    })
    void readListReasons(api, PAUSE_LIST, true).then(({ list }) => live && setPauseReasons(list.reasons))
    return () => {
      live = false
    }
    // Once a visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const undo = async () => {
    if (!last || !undoOpen(last, new Date())) return
    try {
      const item = await queue.enqueue('production.scan.undo', last.scanId ? { scanId: last.scanId } : { undoesClientScanId: last.clientEventId })
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

  const report = (step: CountsStep) => {
    const { card, operation, counts } = step
    const work = step.work ?? NO_WORK
    const expected = operation.expected ?? card.bundle.quantity
    const asked = work.check?.components.asked ?? []
    return { expected, body: reportPayload(card, operation.id, counts, expected, componentLines(asked, work.lots, garmentsOn(counts, expected))) }
  }

  /** The report stands: the receipt, the next scan. */
  const reported = (step: CountsStep, ids: { clientEventId: string; scanId: string | null }, at: string) => {
    const { card, operation, counts } = step
    const expected = operation.expected ?? card.bundle.quantity
    prior.current.set(ids.clientEventId, card)
    CARDS.keep(codeKey(card.bundle.code), afterReport(card, operation.id, counts, expected, new Date(at)))
    WORK.forget(workKey(card.bundle.code, operation.id))
    if (person) forgetLeft(person, card.bundle.code, operation.id)
    setLast({
      clientEventId: ids.clientEventId,
      bundleCode: card.bundle.code,
      operation: { id: operation.id, seq: operation.seq, code: operation.code, name: operation.name },
      good: goodOf(counts, expected),
      scrap: counts.scrap,
      rework: counts.rework,
      at,
      scannedAfter: false,
      undoEventId: null,
      askEventId: null,
      scanId: ids.scanId,
    })
    setResume((items) => items.filter((item) => !(item.bundleId === card.bundle.id && item.operation.id === operation.id)))
    setRunning(null)
    feedback('success')
    const rest = parked.current
    parked.current = []
    if (rest.length > 0) return setStep({ kind: 'stack', rows: rest, size: null, line: { key: 'reportedAlone', params: { code: card.bundle.code }, tone: 'success' } })
    setReceipt(true)
    setStep({ kind: 'scan' })
  }

  const finish = async () => {
    if (step.kind !== 'counts' || step.busy || acting.current) return
    const { card, operation, counts } = step
    const work = step.work ?? NO_WORK
    const { expected, body } = report(step)
    const asked = work.check?.components.asked ?? []
    if (finishHeld(counts, operation.expected, card.bundle.quantity) || workHold({ steps: work.steps, asked, lots: work.lots, counts, expected })) {
      feedback('warning')
      return
    }
    acting.current = true
    setStep({ ...step, busy: true })
    try {
      // Other counts than all good are checked for what they are (F3: the all-good tap makes no call).
      let held: readonly GuardLine[] = heldFindings(work.check).map(lineOf)
      if (online && touched(counts)) {
        const fresh = await fetchCheck(api, card.bundle.code, operation.id, overrideCounts(counts, expected))
        if (fresh.ok) held = heldFindings(fresh.value).map(lineOf)
      } else if (quantityRule(work.check, totalOf(counts, expected)) === 'held') held = [{ code: 'MORE_THAN_PASSED', message: '', fix: null, overridable: true }]
      if (held.length > 0) {
        feedback('error')
        return setStep({ kind: 'guard', from: { ...step, busy: false }, lines: held, target: 'report' })
      }
      const item = await queue.enqueue('production.scan.report', body)
      reported(step, { clientEventId: item.clientEventId, scanId: null }, item.occurredAt)
    } catch {
      feedback('error')
      setStep({ kind: 'problem', problem: { kind: 'unavailable' }, code: card.bundle.code })
    } finally {
      acting.current = false
    }
  }

  // ---- timing: answered at once online, the same action queued offline --------------------------------------------------------
  /** A refusal of a timing action: a clear screen; a skill the team leader may lift goes to the red screen with the override. */
  const timingRefused = (from: CountsStep, found: TaskProblem, target: 'start' | null) => {
    if (found.kind === 'signedOut') return void sessionEnded()
    feedback('error')
    if (found.kind === 'refused' && found.code === 'NOT_QUALIFIED' && target === 'start') return setStep({ kind: 'guard', from, lines: [{ code: found.code, message: found.message, fix: found.fix, overridable: true }], target: 'start' })
    if (found.kind === 'refused') return setStep({ kind: 'refused', code: found.code, message: found.message, fix: found.fix, card: from.card, scanned: from.card.bundle.code })
    setStep({ kind: 'problem', problem: found, code: from.card.bundle.code })
  }

  const timed = async (from: CountsStep, route: TimingRoute, extra: Readonly<Record<string, unknown>>): Promise<{ answer: TimingAnswer | null; queuedId: string | null; at: Date } | null> => {
    if (acting.current) return null
    acting.current = true
    const body = { code: from.card.bundle.code, workOrderOperationId: from.operation.id, ...extra }
    try {
      if (online) {
        const answer = await postTiming(api, route, newIdempotencyKey(), body)
        if (answer.ok) return { answer: answer.value, queuedId: null, at: new Date() }
        if (answer.problem.kind !== 'offline') {
          timingRefused(from, answer.problem, route === 'start' ? 'start' : null)
          return null
        }
      }
      const item = await queue.enqueue(`production.scan.${route}`, body)
      return { answer: null, queuedId: item.clientEventId, at: new Date(item.occurredAt) }
    } catch {
      feedback('error')
      setStep({ kind: 'problem', problem: { kind: 'unavailable' }, code: from.card.bundle.code })
      return null
    } finally {
      acting.current = false
    }
  }

  const members = () => (crew.current.length >= 2 ? { memberIds: crew.current.filter((id) => id !== me?.worker.id) } : {})

  const startWork = async (from: CountsStep) => {
    const body = members()
    const sent = await timed(from, 'start', body)
    if (!sent) return
    const next = updateCounts(from, sent.answer ? { timing: sent.answer.timing, skewMs: skewOf(sent.answer.scan.serverTime, sent.at), qualification: sent.answer.qualification } : { timing: afterStart(from.work?.timing ?? null, sent.at, Math.max(1, crew.current.length)), skewMs: 0 })
    setRunning(null)
    feedback(sent.answer?.qualification ? 'warning' : 'success')
    setStep(next)
  }

  const resumeWork = async (from: CountsStep) => {
    const timing = from.work?.timing
    if (!timing) return
    const sent = await timed(from, 'resume', members())
    if (!sent) return
    setRunning(null)
    feedback('success')
    setStep(updateCounts(from, sent.answer ? { timing: sent.answer.timing, skewMs: skewOf(sent.answer.scan.serverTime, sent.at) } : { timing: afterResume(timing, sent.at) }))
  }

  // The ticket scanned again: Start, or Resume (design "tap or scan the ticket again").
  sameTicket.current = (from) => {
    const state = from.work?.timing?.state ?? 'NOT_STARTED'
    if (state === 'PAUSED') void resumeWork(from)
    else if (state === 'NOT_STARTED') void startWork(from)
    else feedback('warning')
  }

  const openPause = async (from: CountsStep) => {
    setStep({ kind: 'pause', from, list: listBeforeRead(PAUSE_LIST), picked: null, words: '' })
    const { list, signedOut } = await readListReasons(api, PAUSE_LIST, online)
    if (signedOut) return void sessionEnded()
    setPauseReasons(list.reasons)
    setStep((now) => (now.kind === 'pause' ? { ...now, list } : now))
  }

  const sendPause = async (step: Extract<OperationStep, { kind: 'pause' }>, id: string, words: string) => {
    const timing = step.from.work?.timing
    if (step.busy || !timing) return
    const reason = step.list.reasons.find((entry) => entry.id === id)
    if (!reason) return
    setStep({ ...step, busy: true })
    const sent = await timed(step.from, 'pause', { reasonCode: reason.code, ...(words.trim() ? { note: words.trim() } : {}) })
    if (!sent) return
    feedback('success')
    setStep(updateCounts(step.from, sent.answer ? { timing: sent.answer.timing, skewMs: skewOf(sent.answer.scan.serverTime, sent.at) } : { timing: afterPause(timing, reason.code, sent.at) }))
  }

  /** Pieces so far, or a hand back: the stretch closes, the next person may start it. */
  const closeStretch = async (from: CountsStep, route: 'partial' | 'handBack', extra: Readonly<Record<string, unknown>>, line: Omit<DoneLine, 'ticks'>) => {
    const sent = await timed(from, route, extra)
    if (!sent) return
    WORK.forget(workKey(from.card.bundle.code, from.operation.id))
    if (person) forgetLeft(person, from.card.bundle.code, from.operation.id)
    setResume((items) => items.filter((item) => !(item.bundleId === from.card.bundle.id && item.operation.id === from.operation.id)))
    setDone({ ...line, queued: sent.queuedId })
    setReceipt(false)
    feedback('success')
    setStep({ kind: 'scan' })
  }

  // ---- the team leader's override: online, the server checks the PIN ------------------------------------------------------------
  const openOverride = (target: OverrideTarget, subject: OverrideModel['subject'], lines: OverrideModel['lines']) => {
    const check = target.from?.work?.check ?? null
    setOverride({ subject, lines, reasons: check?.overrideReasons ?? [], reasonCode: null, words: '', lead: null, people: (device?.roster ?? []).map((person) => ({ id: person.id, name: person.displayName })), picking: false, busy: false, problem: null, offline: !online, work: target })
    if (check) return
    // A stack row was never checked: the tiles come with the check of its bundle.
    const body = target.body as { code?: string; workOrderOperationId?: string }
    if (body.code && body.workOrderOperationId) void fetchCheck(api, body.code, body.workOrderOperationId).then((answer) => answer.ok && setOverride((now) => (now ? { ...now, reasons: answer.value.overrideReasons } : now)))
  }

  const signOverride = async (pin: string) => {
    if (!override?.lead || !override.reasonCode || override.busy) return
    const { work, lead } = override
    const sign = { lead: (lead.kind === 'badge' ? { badgeCode: lead.code } : { workerId: lead.workerId }) satisfies OverrideLead, pin, reasonCode: override.reasonCode, ...(override.words.trim() ? { note: override.words.trim() } : {}) }
    setOverride({ ...override, busy: true, problem: null })
    const wrong = (found: TaskProblem) => {
      if (found.kind === 'signedOut') {
        setOverride(null)
        return void sessionEnded()
      }
      const problem = found.kind === 'refused' ? ({ OVERRIDE_PIN_WRONG: 'wrong', OVERRIDE_SELF: 'self', OVERRIDE_NOT_LEAD: 'notLead', OVERRIDE_NOTE_MISSING: 'note' } as const)[found.code as 'OVERRIDE_PIN_WRONG'] : found.kind === 'rateLimited' ? ('locked' as const) : ('unavailable' as const)
      if (found.kind === 'refused' && !problem) {
        // Another rule still says no: the dialog closes on the screen that says why.
        setOverride(null)
        feedback('error')
        return setStep({ kind: 'refused', code: found.code, message: found.message, fix: found.fix, card: work.from?.card ?? null, scanned: String(work.body.code ?? '') })
      }
      feedback('error')
      setOverride((now) => (now ? { ...now, busy: false, problem } : now))
    }
    if (work.target === 'start') {
      const answer = await overrideStart(api, work.clientScanId, work.body, sign)
      if (!answer.ok) return wrong(answer.problem)
      setOverride(null)
      feedback('success')
      return setStep(updateCounts(work.from!, { timing: answer.value.timing, skewMs: skewOf(answer.value.scan.serverTime, new Date()) }))
    }
    const answer = await overrideReport(api, work.clientScanId, work.body, sign)
    if (!answer.ok) return wrong(answer.problem)
    setOverride(null)
    if (work.target === 'report') return reported(work.from!, { clientEventId: work.clientScanId, scanId: answer.value.scan.id }, answer.value.scan.serverTime)
    // A stack row: it leaves the stack; the rest stay.
    const rows = takeOffStack(work.rows, work.rowId!)
    feedback('success')
    setStep(rows.length > 0 ? { kind: 'stack', rows, size: null, line: { key: 'signed', tone: 'success' } } : { kind: 'scan' })
  }

  // ---- several bundles at once -------------------------------------------------------------------------------------------------
  const finishStack = async (rows: readonly StackRow[], size: string | null) => {
    if (rows.length === 0) return
    setStep({ kind: 'stack', rows, size, busy: true })
    const stacked = (totals: { finished: number; good: number; scrap: number; rework: number }, queued: string | null) => {
      if (totals.finished === 0) return
      setLast({ clientEventId: queued ?? '', bundleCode: '', operation: rows[0]!.operation, good: totals.good, scrap: totals.scrap > 0 ? { '': totals.scrap } : {}, rework: totals.rework > 0 ? { '': totals.rework } : {}, at: new Date().toISOString(), scannedAfter: false, undoEventId: null, askEventId: null, bundles: totals.finished })
    }
    if (online) {
      const answer = await finishSeveral(api, stackItems(rows))
      if (answer.ok) {
        stacked(answer.value, null)
        const kept = afterFinish(rows, answer.value.items)
        setRunning(null)
        if (kept.length === 0) {
          setReceipt(true)
          feedback('success')
          return setStep({ kind: 'scan' })
        }
        feedback('warning')
        return setStep({ kind: 'stack', rows: kept, size: null, line: answer.value.finished > 0 ? { key: 'partly', params: { count: answer.value.finished, refused: answer.value.refused }, tone: 'warning' } : { key: 'noneFinished', params: { count: answer.value.refused }, tone: 'warning' } })
      }
      if (answer.problem.kind === 'signedOut') return void sessionEnded()
      if (answer.problem.kind !== 'offline') {
        feedback('error')
        return setStep({ kind: 'stack', rows, size, line: { key: 'failed', tone: 'danger' } })
      }
    }
    // Offline: one queued report per bundle, in the order scanned.
    try {
      let queued: string | null = null
      for (const row of rows) queued = (await queue.enqueue('production.scan.report', reportPayload(row.card, row.operation.id, row.counts, expectedOf(row)))).clientEventId
      const totals = stackTotals(rows)
      stacked({ finished: totals.bundles, good: totals.good, scrap: totals.scrap, rework: totals.rework }, queued)
      setReceipt(true)
      feedback('success')
      setStep({ kind: 'scan' })
    } catch {
      feedback('error')
      setStep({ kind: 'stack', rows, size, line: { key: 'failed', tone: 'danger' } })
    }
  }

  // ---- no bundle ------------------------------------------------------------------------------------------------------------------
  const pickIndirect = async (id: string) => {
    const tile = tiles?.find((entry) => entry.id === id)
    if (!tile) return
    if (online) {
      const answer = await startOffStandard(api, newIdempotencyKey(), tile.id)
      if (answer.ok) {
        setRunning({ block: answer.value, skewMs: 0 })
        feedback('success')
        return setStep({ kind: 'scan' })
      }
      if (answer.problem.kind === 'signedOut') return void sessionEnded()
      if (answer.problem.kind !== 'offline') {
        feedback('error')
        return setStep(answer.problem.kind === 'refused' ? { kind: 'refused', code: answer.problem.code, message: answer.problem.message, fix: answer.problem.fix, card: null, scanned: '' } : { kind: 'problem', problem: answer.problem, code: null })
      }
    }
    const item = await queue.enqueue('production.offStandard.start', { codeId: tile.id })
    setRunning({ block: startedBlock(tile, new Date(item.occurredAt)), skewMs: 0 })
    feedback('success')
    setStep({ kind: 'scan' })
  }

  const endIndirect = async () => {
    if (online) {
      const answer = await endOffStandard(api, newIdempotencyKey())
      if (answer.ok) {
        setRunning(null)
        return void feedback('success')
      }
      if (answer.problem.kind === 'signedOut') return void sessionEnded()
      if (answer.problem.kind !== 'offline') return void feedback('error')
    }
    await queue.enqueue('production.offStandard.end', {})
    setRunning(null)
    feedback('success')
  }

  const openIndirect = async () => {
    setStep({ kind: 'indirect', codes: tiles })
    if (!online) return
    const answer = await fetchOffStandard(api)
    if (answer.ok) {
      setTiles(answer.value.codes)
      setStep((now) => (now.kind === 'indirect' ? { ...now, codes: answer.value.codes } : now))
    }
  }

  // ---- photo or comment ------------------------------------------------------------------------------------------------------------
  const updateNote = (change: Partial<NoteDraft>) => setStep((now) => (now.kind === 'note' ? { ...now, draft: { ...now.draft, ...change } } : now))

  const uploadFile = async (from: CountsStep, draft: NoteDraft, file: Blob, kind: 'photo' | 'clip', seconds?: number) => {
    if (!moreFiles(draft)) return
    const name = `${from.card.bundle.code}-${kind}-${draft.files.length + 1}.${kind === 'clip' ? (file.type.includes('mp4') ? 'mp4' : 'webm') : 'jpg'}`
    updateNote({ capture: null, busy: true, failed: false })
    const answer = await uploadNoteFile(api, from.card.workOrder.id, file, name, seconds)
    if (!answer.ok) {
      if (answer.problem.kind === 'signedOut') return void sessionEnded()
      feedback('error')
      return updateNote({ busy: false, failed: true })
    }
    feedback('success')
    setStep((now) => (now.kind === 'note' ? { ...now, draft: { ...now.draft, busy: false, files: [...now.draft.files, { id: answer.value.fileId, kind, name }] } } : now))
  }

  const postNote = async (from: CountsStep, draft: NoteDraft) => {
    if (noteHeld(draft)) return void feedback('warning')
    try {
      const item = await queue.enqueue('production.floorNote.post', notePayload(draft, { workOrderId: from.card.workOrder.id, bundleId: from.card.bundle.id, workOrderOperationId: from.operation.id }))
      setDone({ kind: 'note', bundleCode: from.card.bundle.code, queued: item.clientEventId })
      feedback('success')
      setStep(from)
    } catch {
      feedback('error')
      setStep({ kind: 'problem', problem: { kind: 'unavailable' }, code: from.card.bundle.code })
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
    if (step.kind === 'pause' || step.kind === 'pieces') return setStep(step.from)
    // A stack is several scans: it asks once before it goes.
    if (step.kind === 'stack' && step.rows.length > 0) return setLeavingStack(true)
    parked.current = []
    setStep(allowed ? { kind: 'scan' } : { kind: 'noPermission' })
  }

  const onAction = (action: OperationAction) => {
    switch (action.type) {
      case 'scan':
        return onScan(action.code)
      case 'pick':
        if (step.kind !== 'pick') return
        return void openOperation(step.card, step.options.find((operation) => operation.id === action.operationId) ?? step.options[0]!, step.asOf, ++lookRun.current)
      case 'reason':
      case 'unreason':
      case 'good':
      case 'open': {
        if (step.kind !== 'counts' && step.kind !== 'correct') return
        const expected = step.kind === 'counts' ? (step.operation.expected ?? step.card.bundle.quantity) : step.target.good + scrapOf(step.target) + reworkOf(step.target)
        // Above what passed and up to the bundle's own pieces, the site's quantity rule decides (MES-097).
        const ceiling = step.kind === 'counts' ? step.card.bundle.quantity : expected
        if (action.type === 'open') return setStep({ ...step, open: action.what, problem: null })
        const move =
          action.type === 'reason' ? addReason(step.counts, action.kind, action.code, expected) : action.type === 'unreason' ? { ok: true as const, counts: removeReason(step.counts, action.kind, action.code) } : setGood(step.counts, action.value, ceiling)
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
        if (action.leave && code) {
          if (person && step.kind === 'counts') forgetLeft(person, step.card.bundle.code, step.operation.id)
          void look(code)
        }
        return
      }
      // ---- B-W2b-69 ----
      case 'start':
        return step.kind === 'counts' ? void startWork(step) : undefined
      case 'resume':
        return step.kind === 'counts' ? void resumeWork(step) : undefined
      case 'pause':
        return step.kind === 'counts' ? void openPause(step) : undefined
      case 'pausePick': {
        if (step.kind !== 'pause') return
        const reason = step.list.reasons.find((entry) => entry.id === action.id)
        // One tap pauses; a reason that asks more takes a few words first.
        if (reason?.needsDetail) return setStep({ ...step, picked: action.id })
        return void sendPause({ ...step, picked: action.id }, action.id, '')
      }
      case 'pauseWords':
        return step.kind === 'pause' ? setStep({ ...step, words: action.words }) : undefined
      case 'pauseSend':
        return step.kind === 'pause' && step.picked ? void sendPause(step, step.picked, step.words) : undefined
      case 'notAllGood':
        return step.kind === 'counts' ? setStep({ ...step, open: 'scrap', problem: null }) : undefined
      case 'pickerSwitch':
        return step.kind === 'counts' ? setStep({ ...step, open: step.open === 'scrap' ? 'rework' : 'scrap', problem: null }) : undefined
      case 'stepGood': {
        if (step.kind !== 'counts') return
        const expected = step.operation.expected ?? step.card.bundle.quantity
        const move = setGood(step.counts, Math.max(0, goodOf(step.counts, expected) + action.delta), step.card.bundle.quantity)
        if (!move.ok) {
          feedback('warning')
          return setStep({ ...step, problem: 'atMost' })
        }
        return setStep({ ...step, counts: move.counts, problem: null })
      }
      case 'pieces':
        return step.kind === 'counts' ? setStep({ kind: 'pieces', from: step, value: step.work?.timing?.piecesSoFar ? null : 1 }) : undefined
      case 'piecesValue':
        return step.kind === 'pieces' ? setStep({ ...step, value: action.value }) : undefined
      case 'piecesSend': {
        if (step.kind !== 'pieces' || step.busy || !step.value) return
        if (step.value > piecesLeft(step.from.card.bundle.quantity, step.from.work?.timing ?? null)) return void feedback('warning')
        setStep({ ...step, busy: true })
        return void closeStretch(step.from, 'partial', { pieces: step.value, ...members() }, { kind: 'pieces', bundleCode: step.from.card.bundle.code, count: step.value })
      }
      case 'handBack':
        return step.kind === 'counts' ? setHandingBack(true) : undefined
      case 'handBackConfirm':
        setHandingBack(false)
        if (action.confirm && step.kind === 'counts') void closeStretch(step, 'handBack', {}, { kind: 'handBack', bundleCode: step.card.bundle.code })
        return
      case 'tick': {
        if (step.kind !== 'counts' || !step.work?.steps) return
        const body = { code: step.card.bundle.code, workOrderOperationId: step.operation.id, stepCode: action.code, ...(action.outcome === 'DONE' ? {} : { outcome: action.outcome }) }
        const steps = step.work.steps
        void queue
          .enqueue('production.checklist.tick', body)
          .then((item) => {
            feedback('success')
            setStep((now) => (now.kind === 'counts' ? updateCounts(now, { steps: tickStep(now.work?.steps ?? steps, action.code, action.outcome as StepOutcome, new Date(item.occurredAt), me?.worker.displayName ?? null) }) : now))
          })
          .catch(() => feedback('error'))
        return
      }
      case 'lot':
        return step.kind === 'counts' ? void scanLot(step, action.code) : undefined
      case 'lotStep': {
        if (step.kind !== 'counts') return
        const most = garmentsOn(step.counts, step.operation.expected ?? step.card.bundle.quantity) - 1
        return setStep(updateCounts(step, { lots: stepLot(step.work?.lots ?? [], action.code, action.delta, most) }))
      }
      case 'lotDrop':
        return step.kind === 'counts' ? setStep(updateCounts(step, { lots: dropLot(step.work?.lots ?? [], action.code), lotRefusal: null })) : undefined
      case 'changeCounts':
        return step.kind === 'guard' ? setStep({ ...step.from, busy: false }) : undefined
      case 'override': {
        if (step.kind !== 'guard') return
        const { from, target, lines } = step
        const subject = { code: from.card.bundle.code, seq: from.operation.seq }
        const clientScanId = newIdempotencyKey()
        if (target === 'start') return openOverride({ target: 'start', clientScanId, body: { code: from.card.bundle.code, workOrderOperationId: from.operation.id, ...members() }, from, rowId: null, rows: [] }, subject, lines)
        const { expected, body } = report(from)
        return openOverride({ target: 'report', clientScanId, body, from, rowId: null, rows: [] }, { ...subject, good: goodOf(from.counts, expected) }, lines)
      }
      case 'overrideClose':
        return setOverride(null)
      case 'overrideReason':
        return setOverride((now) => (now ? { ...now, reasonCode: action.code, words: action.code ? now.words : '', lead: action.code ? now.lead : null, problem: null } : now))
      case 'overrideWords':
        return setOverride((now) => (now ? { ...now, words: action.words } : now))
      case 'overrideBadge':
        return setOverride((now) => (now ? { ...now, lead: { kind: 'badge', code: action.code }, picking: false, problem: null } : now))
      case 'overrideNames':
        return setOverride((now) => (now ? { ...now, picking: action.open } : now))
      case 'overrideName':
        return setOverride((now) => (now ? { ...now, lead: { kind: 'name', workerId: action.workerId, name: action.name }, picking: false, problem: null } : now))
      case 'overrideLeadBack':
        return setOverride((now) => (now ? { ...now, lead: null, problem: null } : now))
      case 'overrideSign':
        return void signOverride(action.pin)
      case 'stackOpen': {
        setReceipt(false)
        setDone(null)
        if (step.kind === 'counts' && !touched(step.counts)) return setStep({ kind: 'stack', rows: [{ clientScanId: newIdempotencyKey(), card: step.card, operation: step.operation, counts: NO_COUNTS, refusal: null }], size: null })
        return setStep({ kind: 'stack', rows: [], size: null })
      }
      case 'stackSize':
        return step.kind === 'stack' ? setStep({ ...step, size: action.size }) : undefined
      case 'stackStep':
        return step.kind === 'stack' ? setStep({ ...step, rows: stepRow(step.rows, action.id, action.delta) }) : undefined
      case 'stackDrop':
        return step.kind === 'stack' ? setStep({ ...step, rows: takeOffStack(step.rows, action.id), mismatch: false, line: null }) : undefined
      case 'stackAlone': {
        if (step.kind !== 'stack') return
        const row = step.rows.find((entry) => entry.clientScanId === action.id)
        if (!row) return
        parked.current = takeOffStack(step.rows, row.clientScanId)
        return void openOperation(row.card, row.operation, null, ++lookRun.current)
      }
      case 'stackLeave':
        setLeavingStack(false)
        if (action.leave) setStep({ kind: 'scan' })
        return
      case 'stackOverride': {
        if (step.kind !== 'stack') return
        const row = step.rows.find((entry) => entry.clientScanId === action.id)
        if (!row?.refusal) return
        const body = reportPayload(row.card, row.operation.id, row.counts, expectedOf(row))
        return openOverride({ target: 'stack', clientScanId: row.clientScanId, body, from: null, rowId: row.clientScanId, rows: step.rows }, { code: row.card.bundle.code, seq: row.operation.seq, good: goodOf(row.counts, expectedOf(row)) }, [{ code: row.refusal.code, message: row.refusal.message }])
      }
      case 'stackFinish':
        return step.kind === 'stack' && !step.busy && !step.mismatch && step.rows.every((row) => !row.refusal) ? void finishStack(step.rows, step.size) : undefined
      case 'indirectOpen':
        return void openIndirect()
      case 'indirectPick':
        return void pickIndirect(action.id)
      case 'indirectDone':
        return void endIndirect()
      case 'noteOpen':
        return step.kind === 'counts' ? setStep({ kind: 'note', from: step, draft: NEW_NOTE }) : undefined
      case 'noteBack':
        return step.kind === 'note' ? setStep(step.from) : undefined
      case 'noteTile':
        return updateNote({ tile: action.code })
      case 'noteWords':
        return updateNote({ words: action.words })
      case 'noteCapture':
        return updateNote({ capture: action.what, failed: false })
      case 'notePhoto':
        return step.kind === 'note' ? void uploadFile(step.from, step.draft, action.photo.marked ?? action.photo.photo, 'photo') : undefined
      case 'noteClip':
        return step.kind === 'note' ? void uploadFile(step.from, step.draft, action.clip, 'clip', action.seconds) : undefined
      case 'noteDrop':
        return step.kind === 'note' ? updateNote({ files: step.draft.files.filter((file) => file.id !== action.id) }) : undefined
      case 'notePost':
        return step.kind === 'note' ? void postNote(step.from, step.draft) : undefined
      case 'continue':
        return void look(action.code)
    }
  }


  useFloorKeys({
    enter: step.kind === 'counts' ? () => void finish() : step.kind === 'pick' ? () => onAction({ type: 'pick', operationId: step.options[0]!.id }) : step.kind === 'correct' ? () => void sendCorrection() : step.kind === 'stack' ? () => onAction({ type: 'stackFinish' }) : null,
    // Esc in the reason picker (Scrap or Rework open, SCR-091) is Back to the counts; the counts stay.
    escape:
      leave !== null
        ? null
        : (step.kind === 'counts' || step.kind === 'correct') && (step.open === 'scrap' || step.open === 'rework')
          ? () => setStep({ ...step, open: null, problem: null })
          : step.kind === 'scan' || step.kind === 'noPermission'
            ? () => router.push('/floor')
            : step.kind === 'correct'
              ? () => void openCorrections()
              : step.kind === 'note' && step.draft.capture !== null
                ? null
                : step.kind === 'note'
                  ? () => setStep(step.from)
                  : back,
  })

  if (!me) return null

  const refusalWords = (code: string, message: string) => {
    const known = t(`refusal.${code}.message`, { code: '', scanned: '', number: '', status: '', seq: '', operation: '' })
    return known === `refusal.${code}.message` ? message : known
  }

  // The last report's strip, with its two ticks from the queue (and the undo's own once undone).
  const now = new Date()
  const reportView = last?.clientEventId && !last.scanId ? queuedView(queueSnapshot, last.clientEventId) : null
  const reportTicks = last?.scanId || last?.bundles ? (reportView?.ticks ?? 'recorded') : last?.clientEventId ? (reportView?.ticks ?? 'recorded') : null
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
        refusal: reportView?.refusal ? refusalWords(reportView.refusal.code, reportView.refusal.message) : null,
        bundles: last.bundles,
      }
    : null
  const doneLine: DoneLine | null = done ? { kind: done.kind, bundleCode: done.bundleCode, count: done.count, ticks: done.queued ? (queuedView(queueSnapshot, done.queued)?.ticks ?? 'recorded') : 'recorded' } : null
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
        resume,
        running,
        override,
        handBack: handingBack && step.kind === 'counts' ? { bundleCode: step.card.bundle.code, operationSeq: step.operation.seq } : null,
        stackLeave: leavingStack && step.kind === 'stack' ? stackTotals(step.rows) : null,
        done: doneLine,
        pauseReasons,
        leave: leave && pending ? { bundleCode: pending.card.bundle.code, operationSeq: pending.operation.seq, scrap: scrapOf(pending.counts), rework: reworkOf(pending.counts) } : leave && step.kind === 'correct' ? { bundleCode: step.target.bundleCode, operationSeq: step.target.operation.seq, scrap: scrapOf(step.counts), rework: reworkOf(step.counts) } : null,
      }}
      onFrame={onFrame}
      onAction={onAction}
      camera={zxingCamera}
    />
  )
}
