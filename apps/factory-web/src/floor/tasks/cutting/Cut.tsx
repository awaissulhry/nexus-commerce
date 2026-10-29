'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { DEFAULT_TIME_ZONE, formatNumber } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { zxingCamera } from '../../camera'
import { useFloor } from '../../FloorApp'
import { useFloorKeys } from '../../keys'
import { readScan } from '../../scan/scan-model'
import { AsOfMemory, codeKey } from '../shared/as-of'
import { queuedView } from '../shared/queued'
import type { TaskOutcome, TaskProblem } from '../shared/task-api'
import { fetchCutView, fetchCutWorkOrders, fetchHide, fetchRemnantPlaces, undoCut, type CutViewAnswer, type CutWorkOrderRow, type HideAnswer, type RemnantPlace } from './api'
import { addSet, areaUsed, cutLines, draftLines, isAreaUom, isUsedUp, lotReasonOf, maySet, nextPicked, pendingSets, remnantMax, remnantProblem, remnantText, shadeMatch, sizeStates, undoSet, type AreaUom, type CutCell, type Draft } from './model'
import { CutView, unitWord, type CutAction, type CutRefusalModel, type CutStage, type CutViewModel, type HideCardModel, type LastCut, type WorkOrderChip } from './view/CutView'

/**
 * The live SCR-094 (`/floor/cut`): the cutting table's work order (scanned or picked; it stays for the visit), then one
 * hide at a time — its tag scanned (also from Home's scan router), its check, the sets cut from it as a draft on this
 * tablet, and Hide done as ONE cut log entry saved in the tablet's queue (`production.cut.log`, sent in order by the
 * floor sync; the cut issues a hide not yet at the work order first). What the tablet read this visit stays usable
 * offline with its as-of time (tasks/shared/as-of.ts); a hide it never read needs the network. The undo of a recorded
 * cut (the cutter's own last one, before the next) is online only.
 */

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
}

/** Where a confirmed "Save them as cut first" goes next. */
type Then = { readonly kind: 'workOrder' } | { readonly kind: 'scan' } | { readonly kind: 'hide'; readonly code: string }

export function FloorCut() {
  const store = useFloor()
  const router = useRouter()
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
  const retry = useRef<(() => void) | null>(null)
  const pendingHide = useRef<string | null>(null)
  const taken = useRef(false)

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
      setHide(answer)
      setDraft([])
      setRemnant(null)
      setAsOf(result.asOf)
      const cells: CutCell[] = entry.cells
      const states = sizeStates(cells, [], pendingSets(queueSnapshot.items, entry.id))
      setPicked((current) => (current && states.some((size) => size.id === current && !size.allCut) ? current : nextPicked(states, null)))
      setStage('check')
      feedback('success')
    },
    [api, online, problemOf, feedback, chooseWorkOrder, queueSnapshot.items, t, view?.workOrder.number],
  )

  const workOrderId = view?.workOrder.id ?? null
  const entry = hide && workOrderId ? (hide.workOrders.find((order) => order.id === workOrderId) ?? null) : null
  const cells: CutCell[] = entry?.cells ?? []
  const pending = workOrderId ? pendingSets(queueSnapshot.items, workOrderId) : new Map<string, number>()
  const sizes = sizeStates(cells, draft, pending)

  /** Saves the hide's cut in the tablet's queue: the sets of the draft, and Hide done with or without a remnant. */
  const save = useCallback(
    async (done: { remnant: { area: string; uom: AreaUom; toLocationId: string } | null } | null, placeCode: string | null) => {
      if (!hide || !workOrderId) return false
      const lines = cutLines(draft, cells)
      const payload: Record<string, unknown> = { workOrderId, hideId: hide.hide.id, lines, ...(done ? { done } : {}) }
      try {
        const item = await queue.enqueue('production.cut.log', payload)
        const parts = draftLines(draft, cells).map((line) => `${line.label} × ${line.sets}`)
        const remnantWords = done?.remnant ? t('last.remnant', { area: `${formatNumber(Number(done.remnant.area), locale, { maximumFractionDigits: 2 })} ${unitWord(done.remnant.uom)}` }) : done ? t('last.noRemnant') : t('last.notDone')
        setLast({ clientEventId: item.clientEventId, text: [hide.hide.code, ...parts, remnantWords].join(' · '), place: placeCode, workOrderId })
        feedback('success')
        return true
      } catch {
        feedback('error')
        setNotice({ tone: 'danger', text: t('last.notSaved') })
        return false
      }
    },
    [hide, workOrderId, draft, cells, queue, feedback, t, locale],
  )

  const resetHide = () => {
    setHide(null)
    setDraft([])
    setRemnant(null)
    setPlaceId(null)
    setWrongType(false)
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
    if (read.kind === 'label' && read.type !== 'hide') {
      feedback('error')
      return setWrongType(true)
    }
    if (stage === 'check' && draft.length > 0) return setConfirm({ sets: draft.length, then: { kind: 'hide', code: read.code } })
    await go({ kind: 'hide', code: read.code })
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
        if (!picked || !maySet(sizes, picked)) return feedback('warning')
        {
          const next = addSet(draft, picked)
          setDraft(next)
          setPicked(nextPicked(sizeStates(cells, next, pending), picked))
        }
        return feedback('success')
      case 'undoSet':
        return setDraft((current) => undoSet(current))
      case 'hideDone':
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
        const problem = remnantProblem(left, remnant, draft.length > 0)
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
        if (stage === 'done') return setStage('check')
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
        const queued = last ? queuedView(queueSnapshot, last.clientEventId) : null
        const cutId = queued?.item?.result?.type === 'CutLog' ? queued.item.result.id : null
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
  const lastView = last ? queuedView(queueSnapshot, last.clientEventId) : null
  const recorded = lastView?.ticks === 'recorded'
  useEffect(() => {
    if (!recorded || !last || !online) return
    MEMORY.views.forget(last.workOrderId)
    void fetchCutView(api, last.workOrderId).then((result) => {
      if (result.ok) {
        MEMORY.views.keep(last.workOrderId, result.value)
        setView((current) => (current?.workOrder.id === last.workOrderId ? result.value : current))
      }
    })
  }, [recorded, last, online, api])

  useFloorKeys({
    enter: confirm ? null : stage === 'check' && !refusal ? () => void onAction({ type: 'addSet' }) : stage === 'remnant' && !refusal ? () => void onAction({ type: 'saveRemnant' }) : null,
    escape: confirm ? () => setConfirm(null) : () => void onAction({ type: 'back' }),
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
        }
      : null
  const lastCut: LastCut | null =
    last && lastView
      ? {
          text: last.text,
          ticks: lastView.ticks,
          refused: lastView.ticks === 'refused' ? (lastView.refusal?.message ?? null) : null,
          place: last.place,
          undo: lastView.ticks === 'refused' ? null : { held: !online ? 'offline' : lastView.ticks !== 'recorded' ? 'notRecorded' : null },
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
            ? { value: remnant, uom: baseUom, max: remnantMax(left), left, used: areaUsed(left, remnant), problem: remnantProblem(left, remnant, draft.length > 0), places, placeId, placesHeld }
            : null,
        last: lastCut,
        refusal,
        confirm: confirm ? { sets: confirm.sets } : null,
        wrongType,
        asOf,
        notice,
        timeZone: DEFAULT_TIME_ZONE,
      }
    : { frame, stage: 'workOrder', noPermission: true }

  return <CutView model={model} onFrame={onFrame} onAction={(action) => void onAction(action)} camera={zxingCamera} />
}
