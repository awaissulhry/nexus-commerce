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
import { valueText, verdictOf } from '../shared/plan-checks'
import { queuedView } from '../shared/queued'
import { floorStepUp } from '../shared/step-up'
import type { TaskProblem } from '../shared/task-api'
import { decideIncoming, fetchOpen, fetchRecord, putComponent, putCounters, putRoll, recordOrKeep, scanChoices, scanToOpen, type BenchPayload, type IncomingRecord, type OpenRow } from './api'
import {
  answerOf,
  applyKept,
  closeZone,
  componentBody,
  componentDraftOf,
  componentHeld,
  componentSuggestion,
  decisionDefault,
  decisionHeld,
  firstSection,
  hideByCode,
  hideDraftOf,
  hideHeld,
  hidePayload,
  per100Of,
  quantityText,
  rollDraftFor,
  rollHeld,
  rollSampleFull,
  tapMap,
  waitingWrites,
  withAnswers,
  withLineToggled,
  ZOOMS,
  type DecisionDraft,
  type MapTool,
  type Section,
  type UnitDecision,
} from './model'
import { IncomingView, type DoneLine, type IncomingAction, type IncomingStep, type ScanWrong } from './view/IncomingView'

/**
 * The live SCR-175 (`/floor/incoming`; B-W2b-115 on the API of B-W2b-98, B-W2b-111 and B-W2b-106). Scan the lot (or a hide, or an
 * inspection number) → POST /quality/queue/scan opens the inspection with its plan, or the one already open; the site's open
 * inspections are listed under the scan field. Code handed over by Home's scan router, My inspections or the kit receipt
 * (`store.takeScan`) is scanned at once.
 *
 *   online first  a hide (Accept / Reject / out of the sample) and the plan's checks: POST /quality/queue/record, a network failure
 *                 keeps the SAME payload on the tablet (`quality.incoming.record`) and the record on screen moves at once
 *   online only   opening, a roll, a component line, the counter (no queue kind: B-W2b-111), and the decision, signed with the PIN
 *                 (POST /floor/step-up when the window has passed, then the SAME decide with the same key); the signature also
 *                 waits while this tablet still holds writes of the inspection
 * Live: incoming_inspection.* read the record on screen (or the open list) again. Never a person, never money.
 */

const RECORDS = new AsOfMemory<IncomingRecord>(60)
const LIVE_PREFIX = 'incoming_inspection.'

type Done = Omit<DoneLine, 'ticks'> & { readonly queued: string | null }

const NEW_TOOL: MapTool = { kind: 'defect', code: null }

export function FloorIncoming() {
  const store = useFloor()
  const router = useFloorRouter()
  const confirm = useConfirmFeedback()
  const feedback = useCallback((kind: FeedbackKind) => confirm(kind, document.getElementById('fw-ii-flash')), [confirm])
  const { frame, onFrame } = store.frame('tile.incoming', { showHome: true })
  const { api, me, device, online, queue, queueSnapshot, sessionEnded } = store
  const permissions = useMemo(() => new Set(me?.permissions ?? []), [me?.permissions])
  const mayRecord = permissions.has('quality.incoming.record') && permissions.has('quality.incoming.view')
  const deviceId = me?.device.id ?? device?.device.id ?? null

  const [step, setStep] = useState<IncomingStep>(mayRecord ? { kind: 'scan', open: null } : { kind: 'noPermission' })
  const [done, setDone] = useState<Done | null>(null)
  const [notice, setNotice] = useState<TaskProblem | null>(null)
  const signKey = useRef<string>(newIdempotencyKey())
  const acting = useRef(false)
  const shown = useRef(step)
  shown.current = step
  const taken = useRef(false)
  /** Inspections whose pads the inspector changed: the default no longer follows the sample. */
  const touched = useRef(new Set<string>())

  const ended = useCallback((problem: TaskProblem) => {
    if (problem.kind === 'signedOut') void sessionEnded()
  }, [sessionEnded])

  const keep = useCallback((record: IncomingRecord) => {
    RECORDS.keep(record.inspection.id, record)
    RECORDS.keep(codeKey(record.inspection.number), record)
    if (record.lot) RECORDS.keep(codeKey(record.lot.code), record)
  }, [])

  /** The record step of an inspection: where work is left, the pads at the sample's default (unless changed here). */
  const recordStep = useCallback((record: IncomingRecord, section?: Section, asOf: string | null = null, decision?: DecisionDraft): IncomingStep => {
    const at = section ?? firstSection(record)
    return { kind: 'record', record, section: at, asOf, decision: decision ?? decisionDefault(record), pad: null }
  }, [])

  // ---- reads ------------------------------------------------------------------------------------------------------------------

  const loadOpen = useCallback(async () => {
    const answer = await fetchOpen(api)
    if (!answer.ok) {
      ended(answer.problem)
      return setStep((now) => (now.kind === 'scan' && now.open === null ? { ...now, open: [], openFailed: true } : now))
    }
    const rows: readonly OpenRow[] = answer.value.items
    setStep((now) => (now.kind === 'scan' ? { ...now, open: rows, openFailed: false } : now))
  }, [api, ended])

  const reloadRecord = useCallback(
    async (inspectionId: string) => {
      const answer = await fetchRecord(api, inspectionId)
      if (!answer.ok) return ended(answer.problem)
      keep(answer.value)
      setStep((now) => {
        if (now.kind === 'record' && now.record.inspection.id === inspectionId) {
          const decision = touched.current.has(inspectionId) ? now.decision : decisionDefault(answer.value)
          return { ...now, record: answer.value, decision, busy: false }
        }
        if ((now.kind === 'sign' || now.kind === 'hide' || now.kind === 'roll' || now.kind === 'component' || now.kind === 'measure') && now.record.inspection.id === inspectionId) return { ...now, record: answer.value, busy: false }
        return now
      })
    },
    [api, ended, keep],
  )

  // ---- scans ------------------------------------------------------------------------------------------------------------------

  const wrong = useCallback(
    (why: ScanWrong, code: string) => {
      feedback('error')
      setStep((now) => (now.kind === 'record' ? { ...now, wrong: { why, code } } : now.kind === 'scan' ? { ...now, wrong: { why, code } } : { kind: 'scan', open: null, wrong: { why, code } }))
    },
    [feedback],
  )

  /** A code at the bench: the inspection it leads to, opened on its plan when none is open (online), or the one this tablet holds. */
  const openCode = useCallback(
    async (code: string, hideCode: string | null) => {
      const kept = RECORDS.get(codeKey(code))
      const land = (record: IncomingRecord, asOf: string | null) => {
        const hide = hideCode && record.inspection.byHide ? hideByCode(record, hideCode) : null
        if (hide) {
          const draft = hideDraftOf(record, hide.hideId)
          if (draft && hideHeld(record, hide.hideId) === null) return setStep({ kind: 'hide', record, draft, sub: 'main', tool: NEW_TOOL, zoom: 0, cross: { x: 0.5, y: 0.5 } })
        }
        setStep(recordStep(record, undefined, asOf))
      }
      if (!online) {
        if (kept) {
          feedback('success')
          return land(kept.value, kept.asOf)
        }
        return wrong('notOnTablet', code)
      }
      setStep({ kind: 'loading', code })
      const answer = await scanToOpen(api, code, newIdempotencyKey())
      if (answer.ok) {
        keep(answer.value.record)
        feedback(answer.value.started ? 'warning' : 'success')
        return land(answer.value.record, null)
      }
      ended(answer.problem)
      const problem = answer.problem
      if (problem.kind === 'offline' && kept) return land(kept.value, kept.asOf)
      if (problem.kind === 'notFound') return wrong('notFound', code)
      if (problem.kind === 'refused') {
        if (problem.code === 'CHOOSE') {
          const choices = await scanChoices(api, code)
          if (choices.ok) return setStep({ kind: 'choose', code, choices: choices.value.choices })
        }
        if (problem.code === 'OTHER_BENCH') return wrong('otherBench', code)
        if (problem.code === 'NOTHING_TO_INSPECT') return wrong('nothing', code)
        if (problem.code === 'LABEL') return wrong('label', code)
      }
      feedback('error')
      setStep({ kind: 'problem', problem, code })
    },
    [api, online, feedback, ended, keep, recordStep, wrong],
  )

  const onScan = useCallback(
    async (raw: string) => {
      const now = shown.current
      if (!me) return
      const read = readScan(raw, me.scanTag)
      if (read.kind === 'badge') {
        if (await store.switchTo(read.code)) feedback('error')
        return
      }
      setNotice(null)
      if (read.kind === 'otherFactory' || read.kind === 'typo') return wrong(read.kind, read.code)
      if (now.kind === 'record' && now.record.inspection.status === 'OPEN') {
        const record = now.record
        // At the hides: a hide's tag (or the tannery's number typed) of this lot opens the hide.
        if (now.section === 'hides' && (read.kind === 'free' || (read.kind === 'label' && read.type === 'hide'))) {
          const hide = hideByCode(record, read.code)
          if (!hide) return wrong('notOfLot', read.code)
          const held = hideHeld(record, hide.hideId)
          if (held) return wrong(held, read.code)
          const draft = hideDraftOf(record, hide.hideId)
          if (!draft) return wrong('notOfLot', read.code)
          feedback('success')
          return setStep({ kind: 'hide', record, draft, sub: 'main', tool: NEW_TOOL, zoom: 0, cross: { x: 0.5, y: 0.5 } })
        }
        // At the rolls: a roll's tag, or the supplier's roll number typed.
        if (now.section === 'rolls' && (read.kind === 'free' || (read.kind === 'label' && read.type === 'roll'))) {
          if (!online) return wrong('notOnTablet', read.code)
          const draft = rollDraftFor(record, read.code)
          if (rollSampleFull(record, draft)) return wrong('rollFull', read.code)
          feedback('success')
          return setStep({ kind: 'roll', record, draft, sub: 'main' })
        }
      }
      if (read.kind === 'label' && read.type === 'roll') return wrong('notRollLot', read.code)
      if (read.kind === 'label' && !['lot', 'hide', 'batch'].includes(read.type)) return wrong('otherBench', read.code)
      return openCode(read.code, read.kind === 'label' && read.type === 'hide' ? read.code : null)
    },
    [me, store, feedback, wrong, online, openCode],
  )

  useEffect(() => {
    if (taken.current || !me || !mayRecord) return
    taken.current = true
    const code = store.takeScan()
    if (code) return void onScan(code)
    void loadOpen()
  }, [me, mayRecord, store, onScan, loadOpen])

  // Another tablet or the office changed an incoming inspection: what is on screen is read again (a hint, never applied).
  const refresh = useCallback(() => {
    const now = shown.current
    if (now.kind === 'scan') return void loadOpen()
    if (now.kind === 'record' && !now.busy) void reloadRecord(now.record.inspection.id)
  }, [loadOpen, reloadRecord])
  useLiveChanges({ onChange: (change) => void (change.type.startsWith(LIVE_PREFIX) && refresh()), onReconnect: refresh }, mayRecord && online)

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

  /** A hide or the checks, online first: the office's record, or the record moved here with the write kept on the tablet. */
  const bench = async (record: IncomingRecord, payload: BenchPayload): Promise<{ record: IncomingRecord; queued: string | null } | null> => {
    const sent = await recordOrKeep(api, queue, online, deviceId, payload)
    if (sent.answer) {
      if (!sent.answer.ok) {
        refused(sent.answer.problem)
        if (sent.answer.problem.kind === 'conflict') void reloadRecord(record.inspection.id)
        return null
      }
      const fresh = sent.answer.value.model.incoming
      if (!fresh) return null
      keep(fresh)
      return { record: fresh, queued: null }
    }
    const moved = applyKept(record, payload)
    keep(moved)
    return { record: moved, queued: sent.kept.clientEventId }
  }

  const decideHide = (decision: UnitDecision | null, remove = false) =>
    once(async () => {
      const now = shown.current
      if (now.kind !== 'hide' || !now.record.may.record) return
      if (!remove && hideHeld(now.record, now.draft.hideId)) return void feedback('warning')
      setNotice(null)
      setStep({ ...now, busy: true })
      const payload: BenchPayload = remove ? { what: 'HIDE_REMOVED', inspectionId: now.record.inspection.id, hideId: now.draft.hideId } : hidePayload(now.record.inspection.id, now.draft, decision)
      const saved = await bench(now.record, payload)
      if (!saved) return setStep({ ...now, busy: false })
      feedback(remove || decision === 'REJECTED' ? 'warning' : 'success')
      setDone({ kind: remove ? 'hideRemoved' : 'hide', code: now.draft.code, decision: remove ? null : decision, queued: saved.queued })
      setStep(recordStep(saved.record, 'hides', null, touched.current.has(saved.record.inspection.id) ? undefined : decisionDefault(saved.record)))
    })

  const answerChecks = (record: IncomingRecord, answers: readonly { checkId: string; outcome: 'PASS' | 'FAIL'; value?: string | null }[]) =>
    once(async () => {
      if (!record.may.record) return
      setNotice(null)
      setStep((now) => (now.kind === 'record' || now.kind === 'measure' ? { ...now, busy: true } : now))
      const saved = await bench(record, { what: 'RESULTS', inspectionId: record.inspection.id, results: withAnswers(record.checks, answers) })
      if (!saved) return setStep((now) => (now.kind === 'record' || now.kind === 'measure' ? { ...now, busy: false } : now))
      feedback(answers.some((entry) => entry.outcome === 'FAIL') ? 'warning' : 'success')
      setDone({ kind: 'checks', code: record.inspection.number, queued: saved.queued })
      setStep(recordStep(saved.record, 'checks'))
    })

  /** An online-only write of the record (a roll, a component line, the counter): its answer is the record. */
  const online1 = async (record: IncomingRecord, write: () => Promise<{ ok: true; value: IncomingRecord } | { ok: false; problem: TaskProblem }>): Promise<IncomingRecord | null> => {
    const answer = await write()
    if (!answer.ok) {
      refused(answer.problem)
      if (answer.problem.kind === 'conflict') void reloadRecord(record.inspection.id)
      return null
    }
    keep(answer.value)
    return answer.value
  }

  const decideRoll = (decision: UnitDecision) =>
    once(async () => {
      const now = shown.current
      if (now.kind !== 'roll' || !online || !now.record.may.record) return
      if (rollHeld(now.draft)) return void feedback('warning')
      setNotice(null)
      setStep({ ...now, busy: true })
      const { draft, record } = now
      const fresh = await online1(record, () =>
        putRoll(
          api,
          record.inspection.id,
          {
            version: record.inspection.version,
            ...(draft.rollId ? { rollId: draft.rollId } : { rollRef: draft.rollRef }),
            onePoint: draft.counts[0],
            twoPoint: draft.counts[1],
            threePoint: draft.counts[2],
            fourPoint: draft.counts[3],
            ...(draft.fromTag ? {} : { widthCm: draft.widthCm === null ? null : quantityText(draft.widthCm), lengthM: draft.lengthM === null ? null : quantityText(draft.lengthM) }),
            decision,
          },
          newIdempotencyKey(),
        ),
      )
      if (!fresh) return setStep({ ...now, busy: false })
      feedback(decision === 'REJECTED' ? 'warning' : 'success')
      setDone({ kind: 'roll', code: draft.label, decision, queued: null })
      setStep(recordStep(fresh, 'rolls'))
    })

  const decideComponent = (decision: UnitDecision) =>
    once(async () => {
      const now = shown.current
      if (now.kind !== 'component' || !online || !now.record.may.record) return
      if (componentHeld(now.draft)) return void feedback('warning')
      setNotice(null)
      setStep({ ...now, busy: true })
      const { draft, record } = now
      const fresh = await online1(record, () => putComponent(api, record.inspection.id, draft.seq, componentBody(draft, record.choices.certificates, record.inspection.version, decision), newIdempotencyKey()))
      if (!fresh) return setStep({ ...now, busy: false })
      feedback(decision === 'REJECTED' ? 'warning' : 'success')
      setDone({ kind: 'component', code: String(draft.seq), decision, queued: null })
      setStep(recordStep(fresh, 'components'))
    })

  const count = (klass: 'critical' | 'major' | 'minor', value: number) =>
    once(async () => {
      const now = shown.current
      if (now.kind !== 'record' || !online || !now.record.may.record) return
      setNotice(null)
      setStep({ ...now, busy: true })
      const record = now.record
      const found = { ...record.inspection.found, [klass]: Math.max(0, value) }
      const fresh = await online1(record, () => putCounters(api, record.inspection.id, { version: record.inspection.version, found }, newIdempotencyKey()))
      if (!fresh) return setStep({ ...now, busy: false })
      feedback(value > record.inspection.found[klass] ? 'warning' : 'success')
      setStep({ ...now, record: fresh, busy: false, decision: touched.current.has(fresh.inspection.id) ? now.decision : decisionDefault(fresh) })
    })

  const decide = (record: IncomingRecord, draft: DecisionDraft) =>
    once(async () => {
      setNotice(null)
      setStep({ kind: 'sign', record, draft, busy: true })
      const signed = await decideIncoming(
        api,
        record.inspection.id,
        {
          version: record.inspection.version,
          accepted: quantityText(draft.accepted ?? 0),
          rejected: quantityText(draft.rejected ?? 0),
          toSort: quantityText(draft.toSort ?? 0),
          ...(record.inspection.subject === 'WORKSHOP' ? { rejectedLines: draft.rejectedLines } : {}),
        },
        signKey.current,
      )
      if (signed.ok) {
        signKey.current = newIdempotencyKey()
        keep(signed.value)
        touched.current.delete(record.inspection.id)
        feedback(signed.value.next?.step === 'RELEASE' ? 'success' : 'warning')
        return setStep({ kind: 'done', record: signed.value })
      }
      if (signed.problem.kind === 'stepUp') return setStep({ kind: 'sign', record, draft })
      refused(signed.problem)
      signKey.current = newIdempotencyKey()
      const fresh = await fetchRecord(api, record.inspection.id)
      if (fresh.ok) keep(fresh.value)
      setStep({ kind: 'sign', record: fresh.ok ? fresh.value : record, draft })
    })

  const onPin = async (pin: string) => {
    const now = shown.current
    if (now.kind !== 'sign' || acting.current) return
    if (!online) return setStep({ ...now, pin: 'offline' })
    setStep({ ...now, busy: true, pin: null })
    const proved = await floorStepUp(api, pin)
    if (!proved.ok) {
      if (proved.problem === 'signedOut') return void sessionEnded()
      feedback('error')
      return setStep({ ...now, busy: false, pin: proved.problem })
    }
    await decide(now.record, now.draft)
  }

  // ---- the actions --------------------------------------------------------------------------------------------------------------

  const toScan = () => {
    setDone(null)
    setNotice(null)
    setStep({ kind: 'scan', open: null })
    void loadOpen()
  }

  const back = () => {
    setNotice(null)
    const now = shown.current
    switch (now.kind) {
      case 'scan':
      case 'noPermission':
        return router.push('/floor')
      case 'record':
      case 'loading':
      case 'choose':
      case 'problem':
      case 'done':
        return toScan()
      case 'hide':
        if (now.sub !== 'main') return setStep({ ...now, sub: 'main' })
        return setStep(recordStep(now.record, 'hides'))
      case 'roll':
        if (now.sub !== 'main') return setStep({ ...now, sub: 'main' })
        return setStep(recordStep(now.record, 'rolls'))
      case 'component':
        return setStep(recordStep(now.record, 'components'))
      case 'measure':
        return setStep(recordStep(now.record, 'checks'))
      case 'sign':
        return setStep(recordStep(now.record, 'decision', null, now.draft))
    }
  }

  const openRecord = async (inspectionId: string) => {
    const kept = RECORDS.get(inspectionId)
    if (!online) {
      if (kept) return setStep(recordStep(kept.value, undefined, kept.asOf))
      return wrong('notOnTablet', inspectionId)
    }
    const answer = await fetchRecord(api, inspectionId)
    if (!answer.ok) return refused(answer.problem)
    keep(answer.value)
    setStep(recordStep(answer.value))
  }

  const onAction = (action: IncomingAction) => {
    const now = shown.current
    switch (action.type) {
      case 'scan':
        return void onScan(action.code)
      case 'openRow':
      case 'choose':
        return void openRecord(action.id)
      case 'back':
        return back()
      case 'home':
        return router.push('/floor')
      case 'retry':
        return toScan()
      case 'next':
        return toScan()
      case 'section': {
        if (now.kind !== 'record') return
        setNotice(null)
        const decision = action.section === 'decision' && !touched.current.has(now.record.inspection.id) ? decisionDefault(now.record) : now.decision
        return setStep({ ...now, section: action.section, wrong: null, decision, pad: null })
      }
      // ---- a hide ----
      case 'openHide': {
        if (now.kind !== 'record') return
        const held = hideHeld(now.record, action.hideId)
        const draft = hideDraftOf(now.record, action.hideId)
        if (held || !draft) return wrong(held ?? 'notOfLot', draft?.code ?? '')
        return setStep({ kind: 'hide', record: now.record, draft, sub: 'main', tool: NEW_TOOL, zoom: 0, cross: { x: 0.5, y: 0.5 } })
      }
      case 'shade':
        return now.kind === 'hide' ? setStep({ ...now, draft: { ...now.draft, shadeGroupId: action.id } }) : undefined
      case 'grade':
        return now.kind === 'hide' ? setStep({ ...now, draft: { ...now.draft, gradeId: now.draft.gradeId === action.id ? null : action.id } }) : undefined
      case 'hideSub':
        return now.kind === 'hide' ? setStep({ ...now, sub: action.sub }) : undefined
      case 'area':
        return now.kind === 'hide' ? setStep({ ...now, draft: { ...now.draft, measuredArea: action.value } }) : undefined
      case 'hideDecide':
        return void decideHide(action.decision)
      case 'hideRemove':
        return void decideHide(null, true)
      case 'mapTool':
        return now.kind === 'hide' ? setStep({ ...now, tool: action.tool === 'defect' ? { kind: 'defect', code: now.tool.kind === 'defect' ? now.tool.code : null } : { kind: 'zone', zone: now.tool.kind === 'zone' ? now.tool.zone : (now.record.choices.grades[0]?.code ?? null), points: [] } }) : undefined
      case 'mapDefect':
        return now.kind === 'hide' ? setStep({ ...now, tool: { kind: 'defect', code: action.code } }) : undefined
      case 'mapZone':
        return now.kind === 'hide' && now.tool.kind === 'zone' ? setStep({ ...now, tool: { ...now.tool, zone: action.zone } }) : undefined
      case 'mapCross':
        return now.kind === 'hide' ? setStep({ ...now, cross: { x: action.x, y: action.y } }) : undefined
      case 'mapTap': {
        if (now.kind !== 'hide') return
        const placed = tapMap(now.tool, now.draft.marks, action.x, action.y)
        if (placed.marks === now.draft.marks && placed.tool === now.tool) return feedback('warning')
        feedback('success')
        return setStep({ ...now, tool: placed.tool, draft: { ...now.draft, marks: placed.marks }, cross: { x: action.x, y: action.y } })
      }
      case 'mapClose': {
        if (now.kind !== 'hide') return
        const closed = closeZone(now.tool, now.draft.marks)
        if (!closed) return feedback('warning')
        feedback('success')
        return setStep({ ...now, tool: closed.tool, draft: { ...now.draft, marks: closed.marks } })
      }
      case 'mapZoom':
        return now.kind === 'hide' ? setStep({ ...now, zoom: Math.min(ZOOMS.length - 1, Math.max(0, now.zoom + action.delta)) }) : undefined
      case 'mapRemove':
        return now.kind === 'hide' ? setStep({ ...now, draft: { ...now.draft, marks: now.draft.marks.filter((_mark, index) => index !== action.index) } }) : undefined
      case 'mapUndo': {
        if (now.kind !== 'hide') return
        if (now.tool.kind === 'zone' && now.tool.points.length > 0) return setStep({ ...now, tool: { ...now.tool, points: now.tool.points.slice(0, -1) } })
        return setStep({ ...now, draft: { ...now.draft, marks: now.draft.marks.slice(0, -1) } })
      }
      // ---- a roll ----
      case 'openRoll': {
        if (now.kind !== 'record') return
        const draft = rollDraftFor(now.record, action.code)
        if (rollSampleFull(now.record, draft)) return wrong('rollFull', action.code)
        return setStep({ kind: 'roll', record: now.record, draft, sub: 'main' })
      }
      case 'rollCount': {
        if (now.kind !== 'roll') return
        const counts = [...now.draft.counts] as [number, number, number, number]
        counts[action.index] = Math.max(0, Math.min(9_999, action.value))
        return setStep({ ...now, draft: { ...now.draft, counts } })
      }
      case 'rollSub':
        return now.kind === 'roll' ? setStep({ ...now, sub: action.sub }) : undefined
      case 'rollWidth':
        return now.kind === 'roll' ? setStep({ ...now, draft: { ...now.draft, widthCm: action.value } }) : undefined
      case 'rollLength':
        return now.kind === 'roll' ? setStep({ ...now, draft: { ...now.draft, lengthM: action.value } }) : undefined
      case 'rollDecide':
        return void decideRoll(action.decision)
      // ---- a component line ----
      case 'openComponent':
        return now.kind === 'record' ? setStep({ kind: 'component', record: now.record, draft: componentDraftOf(now.record, action.seq) }) : undefined
      case 'componentKind':
        return now.kind === 'component' ? setStep({ ...now, draft: { ...now.draft, kind: action.kind, ...(action.kind === 'PROTECTOR' ? {} : { protectorType: null, markingOk: null }) } }) : undefined
      case 'componentType':
        return now.kind === 'component' ? setStep({ ...now, draft: { ...now.draft, protectorType: action.value } }) : undefined
      case 'componentCertificate':
        return now.kind === 'component' ? setStep({ ...now, draft: { ...now.draft, certificateId: action.id, markingOk: action.id ? now.draft.markingOk : false } }) : undefined
      case 'componentMarking':
        return now.kind === 'component' ? setStep({ ...now, draft: { ...now.draft, markingOk: action.ok } }) : undefined
      case 'componentChecked':
        return now.kind === 'component' ? setStep({ ...now, draft: { ...now.draft, checked: Math.max(1, action.value ?? 1), defective: Math.min(now.draft.defective, Math.max(1, action.value ?? 1)) } }) : undefined
      case 'componentDefective':
        return now.kind === 'component' ? setStep({ ...now, draft: { ...now.draft, defective: Math.min(Math.max(0, action.value ?? 0), now.draft.checked) } }) : undefined
      case 'componentDecide':
        return void decideComponent(action.decision)
      // ---- the counter ----
      case 'counter':
        return void count(action.klass, action.value)
      // ---- the plan's checks ----
      case 'checkPass':
      case 'checkFail':
        return now.kind === 'record' ? void answerChecks(now.record, [{ checkId: action.id, outcome: action.type === 'checkPass' ? 'PASS' : 'FAIL' }]) : undefined
      case 'checkPassGroup':
        return now.kind === 'record' ? void answerChecks(now.record, action.ids.map((checkId) => ({ checkId, outcome: 'PASS' as const }))) : undefined
      case 'measure': {
        if (now.kind !== 'record') return
        const check = now.record.checks.find((entry) => entry.id === action.id)
        const kept = check ? (answerOf(check)?.value ?? null) : null
        return setStep({ kind: 'measure', record: now.record, checkId: action.id, value: kept !== null && !Number.isNaN(Number(kept)) ? Number(kept) : null, choice: kept })
      }
      case 'measureValue':
        return now.kind === 'measure' ? setStep({ ...now, value: action.value }) : undefined
      case 'measureChoice':
        return now.kind === 'measure' ? setStep({ ...now, choice: action.value }) : undefined
      case 'measureSave': {
        if (now.kind !== 'measure') return
        const check = now.record.checks.find((entry) => entry.id === now.checkId)
        if (!check) return
        const value = check.type === 'CHOICE' ? now.choice : now.value === null ? null : valueText(now.value, check.type)
        if (value === null || value === '') return feedback('warning')
        // A measurement with a tolerance takes its verdict by the numbers (the API checks the same).
        const outcome = verdictOf(check, value) ?? action.outcome
        return void answerChecks(now.record, [{ checkId: check.id, outcome, value }])
      }
      // ---- the decision ----
      case 'pad':
        if (now.kind !== 'record') return
        touched.current.add(now.record.inspection.id)
        return setStep({ ...now, decision: { ...now.decision, [action.pad]: action.value } })
      case 'padOpen':
        return now.kind === 'record' ? setStep({ ...now, pad: action.pad }) : undefined
      case 'line':
        if (now.kind !== 'record') return
        touched.current.add(now.record.inspection.id)
        return setStep({ ...now, decision: withLineToggled(now.record, now.decision, action.id) })
      case 'decisionReset':
        if (now.kind !== 'record') return
        touched.current.delete(now.record.inspection.id)
        return setStep({ ...now, decision: decisionDefault(now.record), pad: null })
      case 'sign': {
        if (now.kind !== 'record') return
        if (decisionHeld(now.record, now.decision, { online, waiting: waitingWrites(queueSnapshot.items, now.record.inspection.id) }).length > 0) return feedback('warning')
        signKey.current = newIdempotencyKey()
        return setStep({ kind: 'sign', record: now.record, draft: now.decision })
      }
      case 'pin':
        return void onPin(action.pin)
    }
  }

  // Enter = the step's main action (design floor.incoming "Enter = Accept"), Esc = back.
  const enter = (): IncomingAction | null => {
    switch (step.kind) {
      case 'hide':
        return step.sub === 'main' && !step.busy ? { type: 'hideDecide', decision: 'ACCEPTED' } : step.sub === 'area' ? { type: 'hideSub', sub: 'main' } : null
      case 'roll':
        if (step.sub !== 'main') return { type: 'rollSub', sub: 'main' }
        // The suggestion is the main action: over the points limit the roll is rejected.
        return step.busy ? null : { type: 'rollDecide', decision: (per100Of(step.draft) ?? 0) > (Number(step.record.choices.fourPointLimit) || 40) ? 'REJECTED' : 'ACCEPTED' }
      case 'component':
        return step.busy ? null : { type: 'componentDecide', decision: componentSuggestion(step.draft).suggested }
      case 'record':
        return step.section === 'decision' ? { type: 'sign' } : null
      case 'done':
        return { type: 'next' }
      default:
        return null
    }
  }
  useFloorKeys({ enter: () => void ((action) => action && onAction(action))(enter()), escape: () => back() })

  if (!me) return null

  const doneLine: DoneLine | null = done ? { ...done, ticks: done.queued ? (queuedView(queueSnapshot, done.queued)?.ticks ?? 'saved') : 'recorded' } : null
  const inspectionId = step.kind === 'record' || step.kind === 'sign' ? step.record.inspection.id : null

  return (
    <IncomingView
      model={{ frame, online, step, done: doneLine, notice, signer: me.worker.displayName, waiting: inspectionId ? waitingWrites(queueSnapshot.items, inspectionId) : 0 }}
      onFrame={onFrame}
      onAction={onAction}
      camera={zxingCamera}
    />
  )
}
