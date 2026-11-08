'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConfirmFeedback, type FeedbackKind } from '@nexus/ui/floor'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useLiveChanges } from '../../../record-panels/live'
import { zxingCamera } from '../../camera'
import { useFloor, useFloorRouter } from '../../FloorApp'
import { useFloorKeys } from '../../keys'
import { readScan } from '../../scan/scan-model'
import { AsOfMemory, codeKey } from '../shared/as-of'
import { queuedView } from '../shared/queued'
import { floorStepUp } from '../shared/step-up'
import type { TaskProblem } from '../shared/task-api'
import { fromScanReason } from '../reasons/model'
import { fetchCard } from '../scans/api'
import type { BundleCard } from '../scans/model'
import { decideCheck, fetchCheck, fetchChecks, fetchDefects, fetchDhu, fetchRoving, openCheck, recordOrKeep, saveResults, sendBack, type CheckRecord, type LineDhu, type OpenBody, type RovingBoard, type StageDefect } from './api'
import {
  approveHeld,
  colourHeld,
  cuttingDecision,
  cuttingDraftOf,
  eolFailDecision,
  eolPassDecision,
  firstPieceDecision,
  NEW_EOL,
  NEW_ROVING,
  openFirstPieces,
  resultOf,
  reworkReasonOf,
  rovingColour,
  rovingDecision,
  sendBackHeld,
  valueText,
  verdictOf,
  withResult,
  withRovingPieces,
  type InlineKind,
} from './model'
import { InlineView, type DefectList, type DoneLine, type InlineAction, type InlineStep, type ScanKind } from './view/InlineView'

/**
 * The live SCR-176 (`/floor/inline`; B-W2b-105 on B-W2b-99's API). Reads the site's open first pieces, the tablet's line (its DHU
 * today, the roving board) and the defect vocabulary of a stage; a scanned bundle's card comes from the scans module (production.scan).
 *
 *   online only   a first piece (opened, answered and signed with the PIN: POST /floor/step-up when the 2-minute window has passed,
 *                 then the SAME decide with the same key), a cutting result, and Send back (the rework loop answers at once)
 *   online first  a roving result and an end-of-line pass or defect: a network failure keeps them on the tablet
 *                 (`quality.inprocess.record`) under the try's id; the strip shows their ticks
 * Live: in_process_check.changed / .first_piece read the open first pieces, the board, the DHU or the record on screen again.
 * Never a person, never money.
 */

const CARDS = new AsOfMemory<BundleCard>()
const BOARD = new AsOfMemory<RovingBoard>(2)
const DHU = new AsOfMemory<LineDhu>(2)
const DEFECTS = new AsOfMemory<readonly StageDefect[]>(8)
const LIVE = new Set(['in_process_check.changed', 'in_process_check.first_piece'])

type Done = Omit<DoneLine, 'ticks'> & { readonly queued: string | null }

export function FloorInline() {
  const store = useFloor()
  const router = useFloorRouter()
  const confirm = useConfirmFeedback()
  const feedback = useCallback((kind: FeedbackKind) => confirm(kind, document.getElementById('fw-in-flash')), [confirm])
  const { frame, onFrame } = store.frame('tile.inline', { showHome: true })
  const { api, me, device, online, queue, queueSnapshot, sessionEnded, locale } = store
  const permissions = useMemo(() => new Set(me?.permissions ?? []), [me?.permissions])
  const mayRecord = permissions.has('quality.inprocess.record') && permissions.has('quality.inprocess.view')
  const line = me?.line ?? device?.line ?? null
  const deviceId = me?.device.id ?? device?.device.id ?? null

  const [step, setStep] = useState<InlineStep>(mayRecord ? { kind: 'kinds', open: null } : { kind: 'noPermission' })
  const [dhu, setDhu] = useState<{ value: LineDhu; asOf: string | null } | null>(() => {
    const kept = DHU.get('line')
    return kept ? { value: kept.value, asOf: kept.asOf } : null
  })
  const [done, setDone] = useState<Done | null>(null)
  const [notice, setNotice] = useState<TaskProblem | null>(null)
  const signKey = useRef<string>(newIdempotencyKey())
  const acting = useRef(false)
  const shown = useRef(step)
  shown.current = step
  const taken = useRef(false)

  const ended = useCallback((problem: TaskProblem) => {
    if (problem.kind === 'signedOut') void sessionEnded()
  }, [sessionEnded])

  // ---- reads ------------------------------------------------------------------------------------------------------------------

  const loadOpen = useCallback(async () => {
    const answer = await fetchChecks(api, { kind: 'FIRST_PIECE', status: 'OPEN' })
    if (!answer.ok) return ended(answer.problem)
    setStep((now) => (now.kind === 'kinds' ? { ...now, open: openFirstPieces(answer.value.checks) } : now))
  }, [api, ended])

  const loadDhu = useCallback(async () => {
    if (!line) return
    const answer = await fetchDhu(api)
    if (answer.ok) {
      DHU.keep('line', answer.value)
      return setDhu({ value: answer.value, asOf: null })
    }
    ended(answer.problem)
    const kept = DHU.get('line')
    if (kept) setDhu({ value: kept.value, asOf: kept.asOf })
  }, [api, line, ended])

  const loadBoard = useCallback(async () => {
    const answer = await fetchRoving(api)
    if (answer.ok) {
      BOARD.keep('line', answer.value)
      return setStep((now) => (now.kind === 'roving' ? { ...now, board: answer.value, asOf: null } : now))
    }
    ended(answer.problem)
    const kept = BOARD.get('line')
    if (kept) return setStep((now) => (now.kind === 'roving' ? { ...now, board: kept.value, asOf: kept.asOf } : now))
    setStep({ kind: 'problem', problem: answer.problem, code: null })
  }, [api, ended])

  /** The defects of a stage in the worker's language: what this tablet kept at once, then the office's answer (or why not). */
  const loadDefects = useCallback(
    async (stage: 'IN_LINE' | 'CUTTING', apply: (list: DefectList) => void) => {
      const key = `${stage}:${locale}`
      const kept = DEFECTS.get(key)
      apply(kept ? { state: 'ready', defects: kept.value, asOf: null } : { state: 'loading', defects: [], asOf: null })
      if (!online) return apply(kept ? { state: 'ready', defects: kept.value, asOf: kept.asOf } : { state: 'offline', defects: [], asOf: null })
      const answer = await fetchDefects(api, stage, locale)
      if (answer.ok) {
        DEFECTS.keep(key, answer.value)
        return apply({ state: 'ready', defects: answer.value, asOf: null })
      }
      ended(answer.problem)
      apply(kept ? { state: 'ready', defects: kept.value, asOf: kept.asOf } : { state: answer.problem.kind === 'offline' ? 'offline' : 'error', defects: [], asOf: null })
    },
    [api, locale, online, ended],
  )

  const reloadRecord = useCallback(
    async (checkId: string) => {
      const answer = await fetchCheck(api, checkId)
      if (!answer.ok) return ended(answer.problem)
      setStep((now) => (now.kind === 'fpChecks' && now.record.id === checkId ? { ...now, record: answer.value, busy: false } : now.kind === 'fpSign' && now.record.id === checkId ? { ...now, record: answer.value } : now))
    },
    [api, ended],
  )

  useEffect(() => {
    if (taken.current || !me || !mayRecord) return
    taken.current = true
    void loadOpen()
    void loadDhu()
  }, [me, mayRecord, loadOpen, loadDhu])

  // A first piece decided on another tablet, a check recorded elsewhere: what is on screen is read again (a hint, never applied).
  const refresh = useCallback(() => {
    const now = shown.current
    if (now.kind === 'kinds') void loadOpen()
    if (now.kind === 'roving') void loadBoard()
    if (now.kind === 'fpChecks' || now.kind === 'fpSign') void reloadRecord(now.record.id)
    void loadDhu()
  }, [loadOpen, loadBoard, reloadRecord, loadDhu])
  useLiveChanges({ onChange: (change) => void (LIVE.has(change.type) && refresh()), onReconnect: refresh }, mayRecord && online)

  // ---- scans ------------------------------------------------------------------------------------------------------------------

  const cardOf = useCallback(
    async (code: string, check: ScanKind): Promise<{ card: BundleCard; asOf: string | null } | null> => {
      const kept = CARDS.get(codeKey(code))
      if (!online) {
        if (kept) return { card: kept.value, asOf: kept.asOf }
        feedback('warning')
        setStep({ kind: 'scan', check, wrong: { why: 'notOnTablet', code } })
        return null
      }
      setStep({ kind: 'loading', code })
      const answer = await fetchCard(api, code)
      if (answer.ok) {
        CARDS.keep(codeKey(answer.value.bundle.code), answer.value)
        return { card: answer.value, asOf: null }
      }
      ended(answer.problem)
      if (answer.problem.kind === 'offline' && kept) return { card: kept.value, asOf: kept.asOf }
      feedback('error')
      if (answer.problem.kind === 'notFound') setStep({ kind: 'scan', check, wrong: { why: 'notFound', code } })
      else if (answer.problem.kind === 'invalid') setStep({ kind: 'scan', check, wrong: { why: 'typo', code } })
      else setStep({ kind: 'problem', problem: answer.problem, code })
      return null
    },
    [api, online, feedback, ended],
  )

  const onScan = useCallback(
    async (raw: string) => {
      const now = shown.current
      if (!me || (now.kind !== 'scan' && now.kind !== 'eol')) return
      const check: ScanKind = now.kind === 'eol' ? 'END_OF_LINE' : now.check
      const read = readScan(raw, me.scanTag)
      if (read.kind === 'badge') {
        if (await store.switchTo(read.code)) feedback('error')
        return
      }
      setNotice(null)
      if (read.kind === 'otherFactory' || read.kind === 'typo') {
        feedback('error')
        return setStep({ kind: 'scan', check, wrong: { why: read.kind, code: read.code } })
      }
      if (read.kind === 'label' && read.type !== 'bundle') {
        feedback('error')
        return setStep({ kind: 'scan', check, wrong: { why: 'notBundle', code: read.code } })
      }
      const found = await cardOf(read.code, check)
      if (!found) return
      const { card, asOf } = found
      if (check === 'END_OF_LINE') {
        feedback('success')
        return setStep({ kind: 'eol', card, asOf })
      }
      if (check === 'CUTTING') {
        feedback('success')
        setStep({ kind: 'cutting', card, draft: cuttingDraftOf(card.bundle.quantity), defects: { state: 'loading', defects: [], asOf: null } })
        return void loadDefects('CUTTING', (defects) => setStep((step) => (step.kind === 'cutting' ? { ...step, defects } : step)))
      }
      // A first piece: this bundle's open one goes on; else the operation it holds is asked (B-W2b-99 opens it there).
      const open = await fetchChecks(api, { kind: 'FIRST_PIECE', status: 'OPEN', workOrderId: card.workOrder.id })
      const mine = open.ok ? open.value.checks.find((row) => row.bundle?.id === card.bundle.id) : undefined
      if (mine) {
        const record = await fetchCheck(api, mine.id)
        if (record.ok) {
          feedback('success')
          return setStep({ kind: 'fpChecks', record: record.value, measuring: null, value: null, choice: null })
        }
      }
      feedback('success')
      setStep({ kind: 'fpOperation', card })
    },
    [me, store, feedback, cardOf, api, loadDefects],
  )

  // ---- writes -----------------------------------------------------------------------------------------------------------------

  const once = async (work: () => Promise<void>) => {
    if (acting.current) return
    acting.current = true
    try {
      await work()
    } finally {
      acting.current = false
    }
  }

  const refused = (problem: TaskProblem) => {
    ended(problem)
    feedback('error')
    setNotice(problem)
  }

  const openFirstPiece = (card: BundleCard, operationId: string | null) =>
    once(async () => {
      setStep({ kind: 'loading', code: card.bundle.code })
      const answer = await openCheck(api, { kind: 'FIRST_PIECE', bundleCode: card.bundle.code, ...(operationId ? { workOrderOperationId: operationId } : {}) }, newIdempotencyKey())
      if (!answer.ok) {
        ended(answer.problem)
        feedback('error')
        return setStep({ kind: 'problem', problem: answer.problem, code: card.bundle.code })
      }
      feedback('warning')
      setStep({ kind: 'fpChecks', record: answer.value, measuring: null, value: null, choice: null })
    })

  /** One answer of the plan: the WHOLE list goes with the check's version; a version moved meanwhile reads the record again. */
  const answer = (record: CheckRecord, answers: readonly { code: string; outcome: 'PASS' | 'FAIL'; value?: string | null }[]) =>
    once(async () => {
      if (!online) return
      let results = record.results.map((result) => ({ code: result.code, sampleIndex: result.sampleIndex, outcome: result.outcome, value: result.value }))
      for (const entry of answers) results = withResult(results, entry).map((result) => ({ ...result, value: result.value ?? null }))
      setNotice(null)
      setStep((now) => (now.kind === 'fpChecks' ? { ...now, busy: true } : now))
      const saved = await saveResults(api, record.id, { version: record.version, results: results.map(({ value, ...rest }) => (value === null ? rest : { ...rest, value })) }, newIdempotencyKey())
      if (!saved.ok) {
        refused(saved.problem)
        if (saved.problem.kind === 'conflict') return void reloadRecord(record.id)
        return setStep((now) => (now.kind === 'fpChecks' ? { ...now, busy: false } : now))
      }
      feedback(answers.some((entry) => entry.outcome === 'FAIL') ? 'warning' : 'success')
      setStep((now) => (now.kind === 'fpChecks' && now.record.id === record.id ? { ...now, record: saved.value, busy: false, measuring: null, value: null, choice: null } : now))
    })

  const decide = (record: CheckRecord, outcome: 'APPROVED' | 'REJECTED') =>
    once(async () => {
      setNotice(null)
      setStep({ kind: 'fpSign', record, outcome, busy: true })
      const signed = await decideCheck(api, record.id, { version: record.version, ...firstPieceDecision(outcome, record.results) }, signKey.current)
      if (signed.ok) {
        signKey.current = newIdempotencyKey()
        feedback(outcome === 'APPROVED' ? 'success' : 'warning')
        setStep({ kind: 'fpDone', record: signed.value })
        return
      }
      if (signed.problem.kind === 'stepUp') return setStep({ kind: 'fpSign', record, outcome })
      refused(signed.problem)
      signKey.current = newIdempotencyKey()
      if (signed.problem.kind === 'refused' || signed.problem.kind === 'conflict') {
        const fresh = await fetchCheck(api, record.id)
        return setStep({ kind: 'fpSign', record: fresh.ok ? fresh.value : record, outcome })
      }
      setStep({ kind: 'fpSign', record, outcome })
    })

  const onPin = async (pin: string) => {
    const now = shown.current
    if (now.kind !== 'fpSign' || acting.current) return
    if (!online) return setStep({ ...now, pin: 'offline' })
    setStep({ ...now, busy: true, pin: null })
    const proved = await floorStepUp(api, pin)
    if (!proved.ok) {
      if (proved.problem === 'signedOut') return void sessionEnded()
      feedback('error')
      return setStep({ ...now, busy: false, pin: proved.problem })
    }
    await decide(now.record, now.outcome)
  }

  const saveCutting = () =>
    once(async () => {
      const now = shown.current
      if (now.kind !== 'cutting' || !online) return
      setNotice(null)
      setStep({ ...now, busy: true })
      const decision = cuttingDecision(now.draft)
      const saved = await openCheck(api, { kind: 'CUTTING', bundleCode: now.card.bundle.code, decision }, newIdempotencyKey())
      if (!saved.ok) {
        refused(saved.problem)
        return setStep({ ...now, busy: false })
      }
      feedback(decision.outcome === 'PASS' ? 'success' : 'warning')
      setDone({ kind: 'cutting', code: now.card.bundle.code, pieces: decision.outcome === 'FAIL' ? decision.defectivePieces : 0, queued: null })
      setStep({ kind: 'scan', check: 'CUTTING' })
    })

  /** A one-step record online first; the strip shows it (saved here, then recorded) or the screen says the refusal. */
  const record = async (body: OpenBody, line: Omit<Done, 'queued'>, after: InlineStep) => {
    const sent = await recordOrKeep(api, queue, online, deviceId, body)
    if (sent.answer && !sent.answer.ok) {
      refused(sent.answer.problem)
      return false
    }
    setDone({ ...line, queued: sent.kept?.clientEventId ?? null })
    setStep(after)
    return true
  }

  const saveRoving = () =>
    once(async () => {
      const now = shown.current
      if (now.kind !== 'rovingTile') return
      const critical = now.defects.defects.find((defect) => defect.id === now.draft.defectId)?.severity === 'CRITICAL'
      const colour = rovingColour(now.draft, critical)
      if (colourHeld(colour, { defectivePieces: now.draft.defective, critical })) {
        feedback('warning')
        return
      }
      setNotice(null)
      setStep({ ...now, busy: true })
      const ok = await record(
        { kind: 'ROVING', workOrderId: now.tile.workOrder.id, workOrderOperationId: now.tile.operation.id, decision: rovingDecision(now.draft, critical) },
        { kind: 'roving', code: `${now.tile.operation.code} · ${now.tile.operation.name}`, colour },
        { kind: 'roving', board: BOARD.get('line')?.value ?? null, asOf: null },
      )
      if (!ok) return setStep({ ...now, busy: false })
      feedback(colour === 'GREEN' ? 'success' : 'warning')
      if (online) void loadBoard()
    })

  const pass = () =>
    once(async () => {
      const now = shown.current
      if (now.kind !== 'eol') return
      setNotice(null)
      setStep({ ...now, busy: true })
      const ok = await record({ kind: 'END_OF_LINE', bundleCode: now.card.bundle.code, decision: eolPassDecision(now.card.bundle.quantity) }, { kind: 'pass', code: now.card.bundle.code, pieces: now.card.bundle.quantity }, { kind: 'scan', check: 'END_OF_LINE' })
      if (!ok) return setStep({ ...now, busy: false })
      feedback('success')
      void loadDhu()
    })

  /** The defect recorded (charged to the operation), then the garments sent back through the rework loop. Online only. */
  const sendBackNow = () =>
    once(async () => {
      const now = shown.current
      if (now.kind !== 'eolDefect' || !online) return
      const reason = reworkReasonOf(now.card.reasons, now.draft.reasonCode)
      if (sendBackHeld(now.draft, now.needsReason) || !reason || !now.draft.operationId) {
        feedback('warning')
        return
      }
      setNotice(null)
      setStep({ ...now, busy: true })
      const checked = await openCheck(api, { kind: 'END_OF_LINE', bundleCode: now.card.bundle.code, workOrderOperationId: now.draft.operationId, decision: eolFailDecision(now.draft, now.card.bundle.quantity) }, newIdempotencyKey())
      if (!checked.ok) {
        refused(checked.problem)
        return setStep({ ...now, busy: false })
      }
      const operation = now.card.operations.find((entry) => entry.id === now.draft.operationId)
      const where = operation ? `${operation.code} ${operation.name}` : ''
      const defect = now.defects.defects.find((entry) => entry.id === now.draft.defectId)
      const back = checked.value.sendBack
      void loadDhu()
      if (!back) {
        setDone({ kind: 'defectKept', code: now.card.bundle.code, pieces: now.draft.defective, operation: where, queued: null, problem: null })
        return setStep({ kind: 'scan', check: 'END_OF_LINE' })
      }
      const rework = await sendBack(
        api,
        { workOrderId: now.card.workOrder.id, bundleId: back.bundleId, reworkAtOperationId: back.workOrderOperationId, quantity: back.pieces, reasonCode: reason, description: `${defect ? `${defect.code} ${defect.label}` : ''} (end of line)`.trim(), recordType: 'InProcessCheck', recordId: checked.value.id, split: false },
        newIdempotencyKey(),
      )
      if (!rework.ok) {
        ended(rework.problem)
        feedback('warning')
        const words = rework.problem.kind === 'refused' ? rework.problem.code : rework.problem.kind
        setDone({ kind: 'defectKept', code: now.card.bundle.code, pieces: now.draft.defective, operation: where, queued: null, problem: words })
        return setStep({ kind: 'scan', check: 'END_OF_LINE' })
      }
      feedback('warning')
      setDone({ kind: 'sentBack', code: now.card.bundle.code, pieces: now.draft.defective, operation: where, queued: null })
      setStep({ kind: 'scan', check: 'END_OF_LINE' })
    })

  // ---- the actions --------------------------------------------------------------------------------------------------------------

  const openKind = (kind: InlineKind) => {
    setNotice(null)
    if (kind === 'ROVING') {
      const kept = BOARD.get('line')
      setStep({ kind: 'roving', board: kept?.value ?? null, asOf: online ? null : (kept?.asOf ?? null) })
      if (online) void loadBoard()
      return
    }
    setStep({ kind: 'scan', check: kind })
  }

  const back = () => {
    setNotice(null)
    const now = shown.current
    switch (now.kind) {
      case 'kinds':
      case 'noPermission':
        return router.push('/floor')
      case 'scan':
      case 'roving':
      case 'fpDone':
      case 'problem':
      case 'loading':
        setDone(null)
        setStep({ kind: 'kinds', open: null })
        return void loadOpen()
      case 'fpOperation':
        return setStep({ kind: 'scan', check: 'FIRST_PIECE' })
      case 'fpChecks':
        if (now.measuring) return setStep({ ...now, measuring: null, value: null, choice: null })
        setStep({ kind: 'kinds', open: null })
        return void loadOpen()
      case 'fpSign':
        return setStep({ kind: 'fpChecks', record: now.record, measuring: null, value: null, choice: null })
      case 'cutting':
        return setStep({ kind: 'scan', check: 'CUTTING' })
      case 'rovingTile':
        return setStep({ kind: 'roving', board: BOARD.get('line')?.value ?? null, asOf: null })
      case 'eol':
        return setStep({ kind: 'scan', check: 'END_OF_LINE' })
      case 'eolDefect':
        if (now.stage === 'reason') return setStep({ ...now, stage: 'operation' })
        if (now.stage === 'operation') return setStep({ ...now, stage: 'defect' })
        return setStep({ kind: 'eol', card: now.card, asOf: null })
    }
  }

  const onAction = (action: InlineAction) => {
    const now = shown.current
    switch (action.type) {
      case 'kind':
        return openKind(action.kind)
      case 'openRow':
        return void (async () => {
          const answer = await fetchCheck(api, action.id)
          if (!answer.ok) return refused(answer.problem)
          setStep({ kind: 'fpChecks', record: answer.value, measuring: null, value: null, choice: null })
        })()
      case 'scan':
        return void onScan(action.code)
      case 'back':
        return back()
      case 'home':
        return router.push('/floor')
      case 'retry':
        setStep({ kind: 'kinds', open: null })
        return void loadOpen()
      case 'fpOperation':
        return now.kind === 'fpOperation' ? void openFirstPiece(now.card, action.operationId) : undefined
      case 'fpPass':
      case 'fpFail':
        return now.kind === 'fpChecks' ? void answer(now.record, [{ code: action.code, outcome: action.type === 'fpPass' ? 'PASS' : 'FAIL' }]) : undefined
      case 'fpPassGroup':
        return now.kind === 'fpChecks' ? void answer(now.record, action.codes.map((code) => ({ code, outcome: 'PASS' as const }))) : undefined
      case 'measure': {
        if (now.kind !== 'fpChecks') return
        if (action.code === null) return setStep({ ...now, measuring: null, value: null, choice: null })
        const result = resultOf(now.record.results, action.code)
        const kept = result?.value ?? null
        return setStep({ ...now, measuring: action.code, value: kept !== null && !Number.isNaN(Number(kept)) ? Number(kept) : null, choice: kept })
      }
      case 'measureValue':
        return now.kind === 'fpChecks' ? setStep({ ...now, value: action.value }) : undefined
      case 'measureChoice':
        return now.kind === 'fpChecks' ? setStep({ ...now, choice: action.value }) : undefined
      case 'measureSave': {
        if (now.kind !== 'fpChecks' || !now.measuring) return
        const check = now.record.checks.find((entry) => entry.code === now.measuring)
        if (!check) return
        const value = check.type === 'CHOICE' ? now.choice : now.value === null ? null : valueText(now.value, check.type)
        if (value === null || value === '') return feedback('warning')
        // A measurement with a tolerance takes its verdict by the numbers (the API checks the same).
        const outcome = verdictOf(check, value) ?? action.outcome
        return void answer(now.record, [{ code: check.code, outcome, value }])
      }
      case 'sign': {
        if (now.kind !== 'fpChecks' || !online) return
        if (action.outcome === 'APPROVED' && approveHeld(now.record)) return feedback('warning')
        signKey.current = newIdempotencyKey()
        return setStep({ kind: 'fpSign', record: now.record, outcome: action.outcome })
      }
      case 'pin':
        return void onPin(action.pin)
      case 'cuttingPieces':
        return now.kind === 'cutting' ? setStep({ ...now, draft: { ...now.draft, pieces: Math.max(1, action.value ?? 1), rejected: Math.min(now.draft.rejected, Math.max(1, action.value ?? 1)) } }) : undefined
      case 'cuttingRejected':
        return now.kind === 'cutting' ? setStep({ ...now, draft: { ...now.draft, rejected: Math.min(Math.max(0, action.value ?? 0), now.draft.pieces) } }) : undefined
      case 'cuttingDefect':
        return now.kind === 'cutting' ? setStep({ ...now, draft: { ...now.draft, defectId: action.id } }) : undefined
      case 'cuttingSave':
        return void saveCutting()
      case 'tile': {
        if (now.kind !== 'roving' || !now.board) return
        const tile = now.board.tiles.find((entry) => entry.operation.id === action.operationId && entry.workOrder.id === action.workOrderId)
        if (!tile) return
        setNotice(null)
        setStep({ kind: 'rovingTile', tile, draft: NEW_ROVING, defects: { state: 'loading', defects: [], asOf: null } })
        return void loadDefects('IN_LINE', (defects) => setStep((step) => (step.kind === 'rovingTile' ? { ...step, defects } : step)))
      }
      case 'rovingPieces':
        return now.kind === 'rovingTile' ? setStep({ ...now, draft: withRovingPieces(now.draft, action.value ?? 1) }) : undefined
      case 'rovingDefective':
        return now.kind === 'rovingTile' ? setStep({ ...now, draft: { ...now.draft, defective: Math.min(Math.max(0, action.value ?? 0), now.draft.pieces), colour: null } }) : undefined
      case 'rovingDefect':
        return now.kind === 'rovingTile' ? setStep({ ...now, draft: { ...now.draft, defectId: action.id, colour: null } }) : undefined
      case 'rovingColour':
        return now.kind === 'rovingTile' ? setStep({ ...now, draft: { ...now.draft, colour: action.colour } }) : undefined
      case 'rovingSave':
        return void saveRoving()
      case 'pass':
        return void pass()
      case 'defect': {
        if (now.kind !== 'eol' || !online) return
        const needsReason = reworkReasonOf(now.card.reasons, null) === null
        setNotice(null)
        setStep({ kind: 'eolDefect', card: now.card, draft: NEW_EOL, stage: 'defect', defects: { state: 'loading', defects: [], asOf: null }, reworkReasons: now.card.reasons.filter((reason) => reason.kind === 'REWORK').map(fromScanReason), needsReason })
        return void loadDefects('IN_LINE', (defects) => setStep((step) => (step.kind === 'eolDefect' ? { ...step, defects } : step)))
      }
      case 'eolDefective':
        return now.kind === 'eolDefect' ? setStep({ ...now, draft: { ...now.draft, defective: Math.min(Math.max(1, action.value ?? 1), Math.max(1, now.card.bundle.quantity)) } }) : undefined
      case 'eolDefect':
        // A tap on the defect goes on to the operation (the design's taps: defect → operation → Send back).
        return now.kind === 'eolDefect' ? setStep({ ...now, draft: { ...now.draft, defectId: action.id }, stage: 'operation' }) : undefined
      case 'eolOperation':
        return now.kind === 'eolDefect' ? setStep({ ...now, draft: { ...now.draft, operationId: action.id }, stage: now.needsReason ? 'reason' : 'operation' }) : undefined
      case 'eolReason':
        return now.kind === 'eolDefect' ? setStep({ ...now, draft: { ...now.draft, reasonCode: action.code } }) : undefined
      case 'eolStage':
        return now.kind === 'eolDefect' ? setStep({ ...now, stage: action.stage }) : undefined
      case 'sendBack':
        return void sendBackNow()
    }
  }

  // Enter = the step's main action (design floor.inline "Enter = Pass"), Esc = back.
  const enter = (): InlineAction | null => {
    switch (step.kind) {
      case 'eol':
        return step.busy ? null : { type: 'pass' }
      case 'rovingTile':
        return { type: 'rovingSave' }
      case 'cutting':
        return { type: 'cuttingSave' }
      case 'eolDefect':
        return step.stage === 'operation' || step.stage === 'reason' ? { type: 'sendBack' } : null
      default:
        return null
    }
  }
  useFloorKeys({ enter: () => void ((action) => action && onAction(action))(enter()), escape: () => back(), enterFromScan: step.kind === 'eol' })

  if (!me) return null

  const doneLine: DoneLine | null = done ? { ...done, ticks: done.queued ? (queuedView(queueSnapshot, done.queued)?.ticks ?? 'saved') : 'recorded' } : null

  return (
    <InlineView
      model={{ frame, online, step, line: line ? { code: line.code, name: line.name } : null, dhu: dhu?.value ?? null, dhuAsOf: dhu?.asOf ?? null, done: doneLine, notice, signer: me.worker.displayName, boardKept: BOARD.get('line') !== null }}
      onFrame={onFrame}
      onAction={onAction}
      camera={zxingCamera}
    />
  )
}
