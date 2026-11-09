'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useConfirmFeedback } from '@nexus/ui/floor'
import type { CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import { newIdempotencyKey } from '../../../lib/api/client'
import { DEFAULT_TIME_ZONE, formatNumber } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { zxingCamera } from '../../camera'
import { useFloor, useFloorRouter } from '../../FloorApp'
import { useFloorKeys } from '../../keys'
import { readScan, type ScanRead } from '../../scan/scan-model'
import { AsOfMemory, codeKey } from '../shared/as-of'
import { queuedView, type QueuedView } from '../shared/queued'
import type { TaskOutcome, TaskProblem } from '../shared/task-api'
import { cutAnyway, fetchCutView, fetchCutWorkOrders, fetchHide, fetchRemnantPlaces, lookupRemnant, undoCut, uploadHidePhoto, type CutBody, type CutViewAnswer, type CutWorkOrderRow, type HideAnswer, type RemnantPlace } from './api'
import {
  ANYWAY_REASONS,
  addSet,
  anywayHeld,
  anywayProblemOf,
  anywayReady,
  areaUsed,
  cardCheck,
  cutLines,
  draftLines,
  hasThicknessSpec,
  isAreaUom,
  isUsedUp,
  lotReasonOf,
  maySet,
  measureOf,
  nextPicked,
  pendingSets,
  remnantMax,
  remnantMinimum,
  remnantProblem,
  remnantText,
  shadeMatch,
  sizeStates,
  standingWarnings,
  undoSet,
  waitingCuts,
  type AnywayProblem,
  type AreaUom,
  type CutCell,
  type CutWarningKind,
  type Draft,
} from './model'
import type { AnywayModel } from './view/AnywayDialog'
import { kindsWords } from './view/check-words'
import { CutView, unitWord, wordsOf, type CutAction, type CutRefusalModel, type CutStage, type CutViewModel, type HideCardModel, type LastCut, type WorkOrderChip } from './view/CutView'

/**
 * The live SCR-094 (`/floor/cut`): the cutting table's work order (scanned or picked; it stays for the visit), then one
 * hide at a time — its tag scanned (also from Home's scan router), its check, the sets cut from it as a draft on this
 * tablet, and Hide done as ONE cut log entry saved in the tablet's queue (`production.cut.log`, sent in order by the
 * floor sync; the cut issues a hide not yet at the work order first). What the tablet read this visit stays usable
 * offline with its as-of time (tasks/shared/as-of.ts); a hide it never read needs the network. The undo of a recorded
 * cut (the cutter's own last one, before the next) is online only.
 *
 * B-W2b-110 (B-W2b-103's API): each hide's answer carries its check against the work order. What the tablet keeps for
 * offline is that answer, per hide read this visit (the as-of memory; the reservations, pieces and grades behind it have no
 * read of their own and are not copied): offline a hide read before shows its card as of then, its warnings still stop
 * it, and "Cut anyway" waits for the network (the office checks the lead's PIN; the queue never carries a signature). A
 * card that was clean when read lets the sets queue; a warning that appeared meanwhile comes back as the office's refusal on
 * the strip, in words, and the hide is scanned again online. The signature records the first set at once (a cut must cut
 * something to be signed); the rest of the hide is cut as usual. The thickness measured here and the photo go with the
 * cuts of the hide (the photo with the next one).
 */

/** The "Cut anyway?" pop-up's state: what the model shows, plus the cut it signs (one set of a size, under one client id). */
interface AnywayState {
  readonly reasonCode: string | null
  readonly words: string
  readonly lead: AnywayModel['lead']
  readonly picking: boolean
  readonly busy: boolean
  readonly problem: AnywayProblem
  /** The cut's client event id: kept while the pop-up is open, so a lead who signs again after a lost answer is answered once. */
  readonly clientEventId: string
  readonly cellId: string
  readonly kinds: readonly CutWarningKind[]
}

const MEMORY = {
  list: new AsOfMemory<CutWorkOrderRow[]>(4),
  views: new AsOfMemory<CutViewAnswer>(30),
  hides: new AsOfMemory<HideAnswer>(200),
  places: new AsOfMemory<RemnantPlace[]>(4),
}

type Remembered<T> = { readonly ok: true; readonly value: T; readonly asOf: string | null } | { readonly ok: false; readonly problem: TaskProblem }

/** Online: the server's answer (kept for later); no network or no answer: what the tablet read before, with its time. */
async function remembered<T>(memory: AsOfMemory<T>, key: string, online: boolean, read: () => Promise<TaskOutcome<T>>): Promise<Remembered<T>> {
  const kept = memory.get(key)
  if (!online) return kept ? { ok: true, value: kept.value, asOf: kept.asOf } : { ok: false, problem: { kind: 'offline' } }
  const result = await read()
  if (result.ok) {
    memory.keep(key, result.value)
    return { ok: true, value: result.value, asOf: null }
  }
  if ((result.problem.kind === 'offline' || result.problem.kind === 'unavailable') && kept) return { ok: true, value: kept.value, asOf: kept.asOf }
  return result
}

interface LastAction {
  readonly clientEventId: string
  readonly text: string
  readonly place: string | null
  readonly workOrderId: string
  /** B-W2b-110: recorded online at once ("Cut anyway"): the entry's id; no item in the queue. */
  readonly recordedId?: string | null
}

/** Where the last action stands: a queued one by its item, one recorded online as recorded. */
function lastViewOf(last: LastAction | null, snapshot: Parameters<typeof queuedView>[0]): QueuedView | null {
  if (!last) return null
  if (last.recordedId) return { ticks: 'recorded', item: null, refusal: null }
  return queuedView(snapshot, last.clientEventId)
}

/** Where a confirmed "Save them as cut first" goes next. */
type Then = { readonly kind: 'workOrder' } | { readonly kind: 'scan' } | { readonly kind: 'hide'; readonly code: string; /** B-W2b-110: the remnant's RM tag it was scanned by. */ readonly remnant?: string | null }

export function FloorCut() {
  const store = useFloor()
  const router = useFloorRouter()
  const feedback = useConfirmFeedback()
  const t = useT('floor-cutting')
  const locale = useLocale()
  const { frame, onFrame } = store.frame('tile.cut', { showHome: true })
  const { api, me, online, queue, queueSnapshot, sessionEnded } = store

  const [stage, setStage] = useState<CutStage>('workOrder')
  const [rows, setRows] = useState<CutWorkOrderRow[] | null>(null)
  const [view, setView] = useState<CutViewAnswer | null>(null)
  const [hide, setHide] = useState<HideAnswer | null>(null)
  const [draft, setDraft] = useState<Draft>([])
  const [picked, setPicked] = useState<string | null>(null)
  const [remnant, setRemnant] = useState<number | null>(null)
  const [placeId, setPlaceId] = useState<string | null>(null)
  const [places, setPlaces] = useState<RemnantPlace[] | null>(null)
  const [placesHeld, setPlacesHeld] = useState<'noPermission' | 'unavailable' | null>(null)
  const [last, setLast] = useState<LastAction | null>(null)
  const [refusal, setRefusal] = useState<CutRefusalModel | null>(null)
  const [confirm, setConfirm] = useState<{ sets: number; then: Then } | null>(null)
  const [wrongType, setWrongType] = useState(false)
  const [loading, setLoading] = useState<string | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [notice, setNotice] = useState<CutViewModel['notice']>(null)
  const [chipColours, setChipColours] = useState<readonly string[]>([])
  // B-W2b-110: per hide, this visit: the thickness measured here, the photo (its file goes with the next cut), the pop-up.
  const [measured, setMeasured] = useState<string | null>(null)
  const [measureValue, setMeasureValue] = useState<number | null>(null)
  const [photoFileId, setPhotoFileId] = useState<string | null>(null)
  const [photoTaken, setPhotoTaken] = useState(false)
  const [photoStep, setPhotoStep] = useState<{ sending: boolean; failed: boolean }>({ sending: false, failed: false })
  const [anyway, setAnyway] = useState<AnywayState | null>(null)
  const [remnantTag, setRemnantTag] = useState<string | null>(null)
  const retry = useRef<(() => void) | null>(null)
  const pendingHide = useRef<string | null>(null)
  const taken = useRef(false)
  const hideIdNow = useRef<string | null>(null)

  const allowed = Boolean(me?.permissions.includes('production.cut'))

  const problemOf = useCallback(
    (problem: TaskProblem, code?: string | null): CutRefusalModel | null => {
      if (problem.kind === 'signedOut') {
        void sessionEnded()
        return null
      }
      if (problem.kind === 'offline') return code ? { kind: 'notOnTablet', code } : { kind: 'problem', problem }
      return { kind: 'problem', problem, code: code ?? null }
    },
    [sessionEnded],
  )

  const loadList = useCallback(async () => {
    setRows(null)
    const result = await remembered(MEMORY.list, 'list', online, () => fetchCutWorkOrders(api))
    if (!result.ok) {
      retry.current = () => void loadList()
      return setRefusal(problemOf(result.problem))
    }
    setRows(result.value)
    setAsOf(result.asOf)
  }, [api, online, problemOf])

  /** The work order at the table: its cells and hides (for the shade information), then the scan step. */
  const chooseWorkOrder = useCallback(
    async (id: string, colours: readonly string[] = []): Promise<CutViewAnswer | null> => {
      const result = await remembered(MEMORY.views, id, online, () => fetchCutView(api, id))
      if (!result.ok) {
        retry.current = () => void chooseWorkOrder(id, colours)
        setRefusal(problemOf(result.problem))
        return null
      }
      const answer = result.value
      if (!answer.workOrder.cuttable) {
        feedback('error')
        setRefusal({ kind: 'workOrder', code: answer.workOrder.number, number: answer.workOrder.number, refusal: { code: 'WORK_ORDER_NOT_OPEN', message: '' } })
        return null
      }
      setView(answer)
      setChipColours(colours)
      setAsOf(result.asOf)
      setStage('scan')
      return answer
    },
    [api, online, problemOf, feedback],
  )

  /** A hide tag scanned: its check for the work order at the table (or, before one is chosen, the one that can cut it). */
  const checkHide = useCallback(
    async (code: string, workOrderId: string | null) => {
      setLoading(code)
      setWrongType(false)
      setNotice(null)
      const result = await remembered(MEMORY.hides, `${codeKey(code)}|${workOrderId ?? ''}`, online, () => fetchHide(api, code, workOrderId))
      setLoading(null)
      if (!result.ok) {
        feedback('error')
        retry.current = () => void checkHide(code, workOrderId)
        return setRefusal(result.problem.kind === 'notFound' ? { kind: 'problem', problem: { kind: 'notFound' }, code } : problemOf(result.problem, code))
      }
      const answer = result.value
      const { hide: found } = answer
      // Before the knife: used up, the lot, the work order.
      if (isUsedUp(found.state)) {
        feedback('error')
        return setRefusal({ kind: 'usedUp', code: found.code, state: found.state, lastCut: answer.lastCut })
      }
      let entry = workOrderId ? answer.workOrders.find((order) => order.id === workOrderId) : undefined
      if (!found.lot.usable) {
        feedback('error')
        return setRefusal({ kind: 'lot', code: found.code, reason: lotReasonOf(found.lot, entry?.refusal?.code ?? answer.workOrders[0]?.refusal?.code), lotCode: found.lot.code, words: found.lot.words, place: answer.onHand[0]?.locationCode ?? null })
      }
      if (!workOrderId) {
        // From Home or the pick step: the one work order that can cut it opens; several: pick among them.
        const cuttable = answer.workOrders.filter((order) => order.cuttable)
        if (cuttable.length === 1) {
          const chosen = await chooseWorkOrder(cuttable[0]!.id)
          if (!chosen) return
          entry = cuttable[0]
        } else if (cuttable.length === 0) {
          feedback('error')
          const first = answer.workOrders[0]
          return setRefusal(first?.refusal ? { kind: 'workOrder', code: found.code, number: first.number, refusal: first.refusal } : { kind: 'noWorkOrder', code: found.code, number: null })
        } else {
          feedback('warning')
          // The hide waits for the work order to be picked among those that can cut it, then it is checked for it.
          pendingHide.current = found.code
          setRows((current) => (current ? current.filter((row) => cuttable.some((order) => order.id === row.id)) : current))
          setNotice({ tone: 'warning', text: t('workOrder.severalForHide', { code: found.code }) })
          return
        }
      }
      if (!entry) {
        feedback('error')
        return setRefusal({ kind: 'noWorkOrder', code: found.code, number: view?.workOrder.number ?? null })
      }
      if (entry.refusal) {
        feedback('error')
        return setRefusal({ kind: 'workOrder', code: found.code, number: entry.number, refusal: entry.refusal })
      }
      // B-W2b-110: another hide starts with nothing measured and no photo; the same hide read again keeps them.
      if (hideIdNow.current !== found.id) {
        setMeasured(null)
        setPhotoFileId(null)
        setPhotoTaken(false)
      }
      hideIdNow.current = found.id
      setHide(answer)
      setDraft([])
      setRemnant(null)
      setAsOf(result.asOf)
      const cells: CutCell[] = entry.cells
      const states = sizeStates(cells, [], pendingSets(queueSnapshot.items, entry.id))
      setPicked((current) => (current && states.some((size) => size.id === current && !size.allCut) ? current : nextPicked(states, null)))
      setStage('check')
      // A warning stops the card (B-W2b-110): it says so with the warning sound, not the all-clear one.
      feedback(entry.checks && entry.checks.standing.length > 0 ? 'warning' : 'success')
    },
    [api, online, problemOf, feedback, chooseWorkOrder, queueSnapshot.items, t, view?.workOrder.number],
  )

  const workOrderId = view?.workOrder.id ?? null
  const entry = hide && workOrderId ? (hide.workOrders.find((order) => order.id === workOrderId) ?? null) : null
  const cells: CutCell[] = entry?.cells ?? []
  const pending = workOrderId ? pendingSets(queueSnapshot.items, workOrderId) : new Map<string, number>()
  const sizes = sizeStates(cells, draft, pending)

  // B-W2b-110: the hide check with the table measure counted in; the card stops on what no lead passed.
  const checks = entry?.checks ?? null
  const card = checks ? cardCheck(checks, measured) : null
  const photoMissing = Boolean(checks?.photo.required) && !photoTaken
  const waiting = workOrderId ? waitingCuts(queueSnapshot.items, workOrderId) : 0
  const pickedSize = sizes.find((size) => size.id === picked) ?? null
  const stops = Boolean(card && card.standing.length > 0)
  const held = card ? anywayHeld({ online, waiting, needsMeasure: card.needsMeasure, picked: pickedSize, photoMissing }) : null

  /** What every cut of this hide carries (B-W2b-110): the photo taken before it (once), the thickness measured here (always). */
  const extrasOf = useCallback((): Pick<CutBody, 'photoFileId' | 'measuredThicknessMm'> => ({ ...(photoFileId ? { photoFileId } : {}), ...(measured ? { measuredThicknessMm: measured } : {}) }), [photoFileId, measured])

  /** Saves the hide's cut in the tablet's queue: the sets of the draft, and Hide done with or without a remnant. */
  const save = useCallback(
    async (done: { remnant: { area: string; uom: AreaUom; toLocationId: string } | null } | null, placeCode: string | null) => {
      if (!hide || !workOrderId) return false
      const lines = cutLines(draft, cells)
      const payload: Record<string, unknown> = { workOrderId, hideId: hide.hide.id, lines, ...(done ? { done } : {}), ...extrasOf() }
      try {
        const item = await queue.enqueue('production.cut.log', payload)
        const parts = draftLines(draft, cells).map((line) => `${line.label} × ${line.sets}`)
        const remnantWords = done?.remnant ? t('last.remnant', { area: `${formatNumber(Number(done.remnant.area), locale, { maximumFractionDigits: 2 })} ${unitWord(done.remnant.uom)}` }) : done ? t('last.noRemnant') : t('last.notDone')
        setLast({ clientEventId: item.clientEventId, text: [hide.hide.code, ...parts, remnantWords].join(' · '), place: placeCode, workOrderId })
        // The photo goes with the cut that follows it; the measure stays for the hide's next cuts.
        if (photoFileId) setPhotoFileId(null)
        feedback('success')
        return true
      } catch {
        feedback('error')
        setNotice({ tone: 'danger', text: t('last.notSaved') })
        return false
      }
    },
    [hide, workOrderId, draft, cells, queue, feedback, t, locale, extrasOf, photoFileId],
  )

  const resetHide = () => {
    setHide(null)
    setDraft([])
    setRemnant(null)
    setPlaceId(null)
    setWrongType(false)
    setAnyway(null)
    setMeasured(null)
    setPhotoFileId(null)
    setPhotoTaken(false)
    setRemnantTag(null)
    hideIdNow.current = null
  }

  // ---- B-W2b-110: "Cut anyway": online, the lead's PIN goes with the first set, under the cut's one client id ----------------
  const openAnyway = () => {
    if (!card || !stops || held || !picked) return feedback('warning')
    setAnyway({ reasonCode: null, words: '', lead: null, picking: false, busy: false, problem: null, clientEventId: newIdempotencyKey(), cellId: picked, kinds: card.standing })
  }

  const signAnyway = async (pin: string) => {
    if (!anyway || !anyway.lead || anyway.busy || !hide || !workOrderId || !anywayReady(anyway.reasonCode, anyway.words)) return
    const reasonCode = anyway.reasonCode
    const sizeLabel = sizes.find((size) => size.id === anyway.cellId)?.label ?? ''
    const cut: CutBody = { hideId: hide.hide.id, lines: [{ workOrderSizeId: anyway.cellId, sets: 1 }], clientEventId: anyway.clientEventId, ...extrasOf() }
    setAnyway({ ...anyway, busy: true, problem: null })
    const answer = await cutAnyway(api, workOrderId, cut, {
      lead: anyway.lead.kind === 'badge' ? { badgeCode: anyway.lead.code } : { workerId: anyway.lead.workerId },
      pin,
      reasonCode,
      ...(anyway.words.trim() ? { note: anyway.words.trim() } : {}),
      warnings: anyway.kinds,
    })
    const hideKey = `${codeKey(hide.hide.code)}|${workOrderId}`
    if (!answer.ok) {
      if (answer.problem.kind === 'signedOut') {
        setAnyway(null)
        return void sessionEnded()
      }
      feedback('error')
      const problem = anywayProblemOf(answer.problem)
      if (problem === 'changed') {
        // A warning the card did not show: read the hide again, the lead signs what stands now.
        setAnyway(null)
        MEMORY.hides.forget(hideKey)
        await checkHide(hide.hide.code, workOrderId)
        return setNotice({ tone: 'warning', text: t('anyway.changed', { kinds: kindsWords(t, answer.warnings) }) })
      }
      if (problem === 'close') {
        // Another rule says no (nothing left, a size all cut, a lot held meanwhile): the screen says why.
        setAnyway(null)
        return setRefusal(problemOf(answer.problem, hide.hide.code))
      }
      if (problem === 'measure') {
        setAnyway(null)
        return setNotice({ tone: 'warning', text: t('anyway.problem.measure') })
      }
      return setAnyway((now) => (now ? { ...now, busy: false, problem, ...(problem === 'note' ? { lead: null } : {}) } : now))
    }
    setAnyway(null)
    feedback('success')
    const reason = ANYWAY_REASONS.find((entry) => entry.code === reasonCode)
    const reasonWords = reason ? (locale === 'it' ? reason.label.it : reason.label.en) : ''
    setLast({ clientEventId: anyway.clientEventId, recordedId: answer.value.cut?.id ?? null, text: [hide.hide.code, `${sizeLabel} × 1`, t('last.anyway', { reason: reasonWords })].join(' · '), place: null, workOrderId })
    if (photoFileId) setPhotoFileId(null)
    MEMORY.hides.forget(hideKey)
    MEMORY.views.forget(workOrderId)
    void fetchCutView(api, workOrderId).then((result) => {
      if (!result.ok) return
      MEMORY.views.keep(workOrderId, result.value)
      setView((current) => (current?.workOrder.id === workOrderId ? result.value : current))
    })
    await checkHide(hide.hide.code, workOrderId)
    setNotice({ tone: 'success', text: t('anyway.done', { kinds: kindsWords(t, answer.value.override?.overrides ?? anyway.kinds) }) })
  }

  // ---- B-W2b-110: the photo of the hide (online) and the thickness at the table --------------------------------------------
  const takePhoto = async (photo: CapturedPhoto) => {
    if (!hide || photoStep.sending) return
    if (!online) return setPhotoStep({ sending: false, failed: true })
    setPhotoStep({ sending: true, failed: false })
    const result = await uploadHidePhoto(api, hide.hide.id, photo.photo, `${hide.hide.code}.jpg`)
    if (!result.ok) {
      if (result.problem.kind === 'signedOut') return void sessionEnded()
      feedback('error')
      return setPhotoStep({ sending: false, failed: true })
    }
    setPhotoFileId(result.value.fileId)
    setPhotoTaken(true)
    setPhotoStep({ sending: false, failed: false })
    setStage('check')
    feedback('success')
  }

  /** A scanned code as a hide's tag: a remnant's RM tag is looked up to the hide it is a piece of (online; B-W2b-100). */
  const hideCodeOf = async (read: ScanRead & { code: string }): Promise<{ code: string; remnant: string | null } | null> => {
    if (!(read.kind === 'label' && read.type === 'remnant')) return { code: read.code, remnant: null }
    if (!online) {
      feedback('error')
      setRefusal({ kind: 'notOnTablet', code: read.code })
      return null
    }
    setLoading(read.code)
    const found = await lookupRemnant(api, read.code)
    setLoading(null)
    if (!found.ok) {
      feedback('error')
      if (found.problem.kind === 'forbidden') {
        setNotice({ tone: 'danger', text: t('scan.remnantNoRight') })
        return null
      }
      setRefusal(found.problem.kind === 'notFound' ? { kind: 'problem', problem: { kind: 'notFound' }, code: read.code } : problemOf(found.problem, read.code))
      return null
    }
    return { code: found.value.hide.code, remnant: found.value.code }
  }

  const go = async (then: Then) => {
    if (then.kind === 'workOrder') {
      pendingHide.current = null
      resetHide()
      setView(null)
      setStage('workOrder')
      void loadList()
    } else if (then.kind === 'scan') {
      resetHide()
      setStage('scan')
    } else {
      resetHide()
      setStage('scan')
      setRemnantTag(then.remnant ?? null)
      await checkHide(then.code, workOrderId)
    }
  }

  /** Leaving a hide with sets not saved asks first (design hidecut.change-wo). */
  const leave = (then: Then) => {
    if (draft.length > 0 && stage !== 'workOrder') return setConfirm({ sets: draft.length, then })
    void go(then)
  }

  const onScan = async (raw: string) => {
    if (!me) return
    setRefusal(null)
    const read = readScan(raw, me.scanTag)
    if (read.kind === 'badge') {
      const problem = await store.switchTo(read.code)
      if (problem) feedback('error')
      return
    }
    if (read.kind === 'otherFactory' || read.kind === 'typo') {
      feedback('error')
      return setWrongType(true)
    }
    if (stage === 'workOrder') {
      if (read.kind === 'label' && read.type === 'hide') return void checkHide(read.code, null)
      // B-W2b-110: a remnant's RM tag (B-W2b-100) opens the hide it is a piece of.
      if (read.kind === 'label' && read.type === 'remnant') {
        const resolved = await hideCodeOf(read)
        if (!resolved) return
        setRemnantTag(resolved.remnant)
        return void checkHide(resolved.code, null)
      }
      if (read.kind === 'label' && read.type !== 'workOrder') {
        feedback('error')
        return setNotice({ tone: 'danger', text: t('workOrder.wrongType') })
      }
      // A traveller: the work order by its number; a code that is none may be a hide's tag printed before label codes.
      setLoading(read.code)
      const found = online ? await fetchCutWorkOrders(api, read.code) : null
      setLoading(null)
      const row = found?.ok ? found.value[0] : (rows ?? []).find((entry) => entry.number.toUpperCase() === read.code.toUpperCase())
      if (row) return void chooseWorkOrder(row.id, row.colourways)
      if (read.kind === 'free' && online) return void checkHide(read.code, null)
      feedback('error')
      return setRefusal(online ? { kind: 'problem', problem: { kind: 'notFound' }, code: read.code } : { kind: 'notOnTablet', code: read.code })
    }
    if (read.kind === 'label' && read.type === 'workOrder') return leave({ kind: 'workOrder' })
    if (read.kind === 'label' && read.type !== 'hide' && read.type !== 'remnant') {
      feedback('error')
      return setWrongType(true)
    }
    const resolved = await hideCodeOf(read)
    if (!resolved) return
    const then: Then = { kind: 'hide', code: resolved.code, remnant: resolved.remnant }
    if (stage === 'check' && draft.length > 0) return setConfirm({ sets: draft.length, then })
    await go(then)
  }

  const openRemnant = async () => {
    setStage('remnant')
    const fromHere = hide?.onHand[0]?.locationId ?? null
    if (!me?.permissions.includes('inventory.locations.view')) return setPlacesHeld('noPermission')
    setPlacesHeld(null)
    const result = await remembered(MEMORY.places, me.site.id, online, () => fetchRemnantPlaces(api, me.site.id))
    if (!result.ok) return setPlacesHeld('unavailable')
    setPlaces(result.value)
    setPlaceId((current) => current ?? (fromHere && result.value.some((place) => place.id === fromHere) ? fromHere : null))
  }

  const baseUom: AreaUom = hide && isAreaUom(hide.hide.baseUom) ? hide.hide.baseUom : 'M2'
  // B-W2b-219: the site's smallest remnant (Floor rules & codes, the Cutting card), in the hide's unit.
  const siteMinimum = hide?.hide.remnantMinimum ?? null
  const left = entry?.left ?? '0'

  const onAction = async (action: CutAction) => {
    switch (action.type) {
      case 'scan':
        return onScan(action.code)
      case 'pickWorkOrder': {
        setNotice(null)
        const row = rows?.find((entry) => entry.id === action.id)
        const chosen = await chooseWorkOrder(action.id, row?.colourways ?? [])
        const code = pendingHide.current
        pendingHide.current = null
        if (chosen && code) await checkHide(code, chosen.workOrder.id)
        return
      }
      case 'changeWorkOrder':
        return leave({ kind: 'workOrder' })
      case 'confirmCancel':
        return setConfirm(null)
      case 'confirmSave': {
        const then = confirm?.then ?? { kind: 'scan' }
        setConfirm(null)
        if (await save(null, null)) await go(then)
        return
      }
      case 'pickSize':
        return setPicked(action.id)
      case 'addSet':
        // B-W2b-110: a card that stops takes no set before the lead's signature; a photo the site asks for comes first.
        if (stops || photoMissing || !picked || !maySet(sizes, picked)) return feedback('warning')
        {
          const next = addSet(draft, picked)
          setDraft(next)
          setPicked(nextPicked(sizeStates(cells, next, pending), picked))
        }
        return feedback('success')
      case 'undoSet':
        return setDraft((current) => undoSet(current))
      case 'hideDone':
        if (stops) return feedback('warning')
        return setStage('done')
      case 'noRemnant':
        if (await save({ remnant: null }, null)) await go({ kind: 'scan' })
        return
      case 'remnant':
        return void openRemnant()
      case 'remnantValue':
        return setRemnant(action.value)
      case 'pickPlace':
        return setPlaceId(action.id)
      case 'saveRemnant': {
        const problem = remnantProblem(left, remnant, draft.length > 0, baseUom, siteMinimum)
        if (problem || !placeId || remnant === null) return feedback('warning')
        const place = places?.find((entry) => entry.id === placeId) ?? null
        if (await save({ remnant: { area: remnantText(remnant), uom: baseUom, toLocationId: placeId } }, place?.code ?? null)) await go({ kind: 'scan' })
        return
      }
      case 'back':
        if (refusal) {
          setRefusal(null)
          if (stage === 'workOrder' && rows === null) void loadList()
          return
        }
        if (stage === 'remnant') return setStage('done')
        if (stage === 'done' || stage === 'measure' || stage === 'photo') return setStage('check')
        if (stage === 'check') return leave({ kind: 'scan' })
        if (stage === 'scan') return leave({ kind: 'workOrder' })
        return router.push('/floor')
      case 'retry': {
        setRefusal(null)
        const again = retry.current
        retry.current = null
        return again?.()
      }
      case 'undoCut': {
        const queued = last && !last.recordedId ? queuedView(queueSnapshot, last.clientEventId) : null
        const cutId = last?.recordedId ?? (queued?.item?.result?.type === 'CutLog' ? queued.item.result.id : null)
        if (!cutId || !online) return feedback('warning')
        const result = await undoCut(api, cutId)
        if (!result.ok) {
          feedback('error')
          if (result.problem.kind === 'signedOut') return void sessionEnded()
          return setNotice({ tone: 'danger', text: result.problem.kind === 'refused' ? result.problem.message : t('last.undoFailed') })
        }
        feedback('success')
        setLast(null)
        setNotice({ tone: 'success', text: t('last.undone') })
        if (workOrderId) MEMORY.views.forget(workOrderId)
        if (workOrderId) void chooseWorkOrder(workOrderId, chipColours)
        return
      }
      case 'home':
        return router.push('/floor')
      // ---- B-W2b-110 ----
      case 'openAnyway':
        return openAnyway()
      case 'anywayClose':
        return setAnyway(null)
      case 'anywayReason':
        return setAnyway((now) => (now ? { ...now, reasonCode: action.code, words: action.code ? now.words : '', lead: action.code ? now.lead : null, problem: null } : now))
      case 'anywayWords':
        return setAnyway((now) => (now ? { ...now, words: action.words, problem: now.problem === 'note' ? null : now.problem } : now))
      case 'anywayBadge':
        return setAnyway((now) => (now ? { ...now, lead: { kind: 'badge', code: action.code }, picking: false, problem: null } : now))
      case 'anywayNames':
        return setAnyway((now) => (now ? { ...now, picking: action.open } : now))
      case 'anywayName':
        return setAnyway((now) => (now ? { ...now, lead: { kind: 'name', workerId: action.workerId, name: action.name }, picking: false, problem: null } : now))
      case 'anywayLeadBack':
        return setAnyway((now) => (now ? { ...now, lead: null, problem: null } : now))
      case 'anywaySign':
        return void signAnyway(action.pin)
      case 'openMeasure':
        setMeasureValue(measured !== null ? Number(measured) : null)
        return setStage('measure')
      case 'measureValue':
        return setMeasureValue(action.value)
      case 'measureSave': {
        const typed = measureOf(measureValue)
        if (typed.problem || typed.text === null) return feedback('warning')
        setMeasured(typed.text)
        setStage('check')
        return feedback('success')
      }
      case 'measureClear':
        setMeasured(null)
        setMeasureValue(null)
        return setStage('check')
      case 'openPhoto':
        if (!online) return feedback('warning')
        setPhotoStep({ sending: false, failed: false })
        return setStage('photo')
      case 'photoTaken':
        return void takePhoto(action.photo)
    }
  }

  // The first visit: the work orders, and a hide scanned on Home.
  useEffect(() => {
    if (taken.current || !me) return
    taken.current = true
    const code = store.takeScan()
    void loadList().then(() => {
      if (code) void onScan(code)
    })
  }, [me])

  // Once the office recorded the last cut, the work order is read again (what is left per size, the undo).
  const lastView = lastViewOf(last, queueSnapshot)
  const recorded = lastView?.ticks === 'recorded'
  useEffect(() => {
    if (!recorded || !last || !online || last.recordedId) return
    MEMORY.views.forget(last.workOrderId)
    void fetchCutView(api, last.workOrderId).then((result) => {
      if (result.ok) {
        MEMORY.views.keep(last.workOrderId, result.value)
        setView((current) => (current?.workOrder.id === last.workOrderId ? result.value : current))
      }
    })
  }, [recorded, last, online, api])

  useFloorKeys({
    enter:
      confirm || anyway || refusal
        ? null
        : stage === 'check' && !stops
          ? () => void onAction({ type: 'addSet' })
          : stage === 'remnant'
            ? () => void onAction({ type: 'saveRemnant' })
            : stage === 'measure'
              ? () => void onAction({ type: 'measureSave' })
              : null,
    escape: anyway ? () => setAnyway(null) : confirm ? () => setConfirm(null) : () => void onAction({ type: 'back' }),
  })

  if (!me) return null

  const chip: WorkOrderChip | null = view ? { id: view.workOrder.id, number: view.workOrder.number, style: view.workOrder.style?.name ?? '—', colours: hide?.hide.colourCode ? [hide.hide.colourCode] : chipColours } : null
  const hideCard: HideCardModel | null =
    hide && entry
      ? {
          code: hide.hide.code,
          item: hide.hide.itemName,
          colour: hide.hide.colourCode,
          area: hide.hide.area,
          areaUom: hide.hide.areaUom,
          grade: hide.hide.grade,
          thicknessMm: hide.hide.thicknessMm,
          shade: hide.hide.shade ?? hide.hide.lot.shade,
          dyeBatch: hide.hide.lot.dyeBatch,
          lotCode: hide.hide.lot.code,
          state: hide.hide.state,
          defects: hide.hide.defects,
          left: entry.left,
          baseUom: hide.hide.baseUom,
          issuedByCut: !entry.holdsHide,
          match: shadeMatch(hide.hide.lot.dyeBatch, view?.hides ?? [], hide.hide.id),
          lastCut: hide.lastCut && hide.lastCut.workOrderNumber ? { at: hide.lastCut.at, workOrderNumber: hide.lastCut.workOrderNumber, station: hide.lastCut.station?.name ?? null } : null,
          // B-W2b-110
          remnantTag,
          checks:
            checks && card
              ? {
                  workOrderNumber: entry.number,
                  warnings: card.warnings,
                  standing: card.standing,
                  passed: checks.passed,
                  shade: checks.shade,
                  thickness: card.thickness,
                  grade: checks.grade,
                  reserved: checks.reserved,
                  measuredMm: measured,
                  measurable: hasThicknessSpec(checks.thickness),
                }
              : null,
          photo: checks ? { taken: photoTaken, required: checks.photo.required, held: online ? null : 'offline' } : null,
        }
      : null
  // A refusal the screen has words for (the table's warnings among them, B-W2b-110) is said in them, with its fix.
  const refusedWords = (refusal: { code: string; message: string } | null): string | null => {
    if (!refusal) return null
    const own = wordsOf(t, refusal.code)
    return own ? [own.message, own.fix].filter(Boolean).join(' ') : refusal.message
  }
  const lastCut: LastCut | null =
    last && lastView
      ? {
          text: last.text,
          ticks: lastView.ticks,
          refused: lastView.ticks === 'refused' ? refusedWords(lastView.refusal) : null,
          place: last.place,
          undo: lastView.ticks === 'refused' ? null : { held: !online ? 'offline' : lastView.ticks !== 'recorded' ? 'notRecorded' : null },
        }
      : null
  const anywayModel: AnywayModel | null =
    anyway && hide && entry && card
      ? {
          hideCode: hide.hide.code,
          workOrderNumber: entry.number,
          size: sizes.find((size) => size.id === anyway.cellId)?.label ?? '',
          warnings: standingWarnings({ warnings: card.warnings, standing: anyway.kinds }),
          measuredMm: measured,
          reasonCode: anyway.reasonCode,
          words: anyway.words,
          lead: anyway.lead,
          people: (store.device?.roster ?? []).filter((person) => person.id !== me?.worker.id).map((person) => ({ id: person.id, name: person.displayName })),
          picking: anyway.picking,
          busy: anyway.busy,
          problem: anyway.problem,
        }
      : null

  const model: CutViewModel = allowed
    ? {
        frame,
        stage,
        workOrders: rows,
        workOrder: chip,
        loading,
        hide: hideCard,
        sizes,
        picked,
        draft: draftLines(draft, cells).map((line) => ({ label: line.label, sets: line.sets })),
        remnant:
          stage === 'remnant'
            ? { value: remnant, uom: baseUom, max: remnantMax(left), left, used: areaUsed(left, remnant), problem: remnantProblem(left, remnant, draft.length > 0, baseUom, siteMinimum), places, placeId, placesHeld, minimum: remnantMinimum(baseUom, siteMinimum) }
            : null,
        last: lastCut,
        refusal,
        confirm: confirm ? { sets: confirm.sets } : null,
        wrongType,
        asOf,
        notice,
        timeZone: DEFAULT_TIME_ZONE,
        // B-W2b-110
        stopped: stage === 'check' && stops ? { held, waiting } : null,
        photoFirst: photoMissing,
        measure: stage === 'measure' ? { value: measureValue, problem: measureOf(measureValue).problem } : null,
        photoStep: stage === 'photo' ? { ...photoStep, held: online ? null : 'offline' } : null,
        anyway: anywayModel,
      }
    : { frame, stage: 'workOrder', noPermission: true }

  return <CutView model={model} onFrame={onFrame} onAction={(action) => void onAction(action)} camera={zxingCamera} />
}
