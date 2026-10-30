'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { PlanningCard, PlanningMove } from '@nexus/ui/patterns/planning-board/index'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { useCoalesced, useLive } from '../../_shared/buying/hooks'
import { BOARD_KIT_NAMESPACE } from '../../_shared/planning-board/words'
import { getBarDetail, getBoard, getPublishPreview, listPlanningSites, listVersions, moveSlot, placeByDueDate, placeSlot, publishPlan, removeSlot, type Board, type PlanningSite, type PublishRange } from './api'
import {
  controlsOf,
  drawBoard,
  laneKeyOf,
  NAMESPACE,
  nextFreePlace,
  overFromIssues,
  overFromMove,
  planMove,
  queryOf,
  readProblemOf,
  refusalOf,
  refusalWords,
  windowFrom,
  workOrderOfTrayCard,
  type BoardControls,
  type MovePlan,
  type OverDay,
  type ProblemRow,
  type Words,
} from './model'
import type { BoardDialog, BoardViewModel, DropChoice, Loaded, PublishRangeKind, SaveState } from './view-model'
import { BoardView } from './view/BoardView'

/**
 * `/w/<company>/planning/board` (SCR-122; Planning › Planning board, planning.view). The company's planning sites
 * (`?site=`, else the first), the board of the window (`?view=` `?zoom=` `?from=` and the filters, all in the address),
 * live (another planner's move, a publish, a calendar or a work order reads the board again), and every write ONE at a
 * time, never optimistic: a move is sent with the slot's version and the bar stays "Saving" until the API answered and
 * the board was read again; a 409 says who moved it and when, a drop over capacity asks "Keep with a reason" first.
 */
export function BoardPage() {
  return (
    <WithMessages namespaces={[NAMESPACE, BOARD_KIT_NAMESPACE]}>
      <BoardContainer />
    </WithMessages>
  )
}

function BoardContainer() {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const params = useSearchParams()
  const query = params?.toString() ?? ''
  const controls = useMemo(() => controlsOf(new URLSearchParams(query)), [query])
  const prefix = pathname.replace(/\/planning\/board\/?$/, '')

  const [sites, setSites] = useState<Loaded<PlanningSite[]>>({ status: 'loading' })
  const [read, setRead] = useState<Loaded<Board>>({ status: 'loading' })
  const [save, setSave] = useState<SaveState>({ state: 'idle' })
  const [dialog, setDialog] = useState<BoardDialog | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [focus, setFocus] = useState<BoardViewModel['focus']>(null)
  const [online, setOnline] = useState(true)
  const boardRef = useRef<Board | null>(null)
  const controlsRef = useRef(controls)
  controlsRef.current = controls
  const readId = useRef(0)
  const knownVersion = useRef<number | null>(null)
  const dropAnswer = useRef<((choice: DropChoice) => void) | null>(null)
  const defaultRange = useRef<{ from: string; to: string } | null>(null)

  const site = sites.status === 'ready' ? (sites.value.find((entry) => entry.id === controls.site) ?? sites.value[0] ?? null) : null
  const siteId = site?.id ?? null
  const words = useMemo<Words>(() => ({ t, locale, timeZone: site?.timeZone ?? 'Europe/Rome' }), [t, locale, site?.timeZone])

  const setControls = useCallback(
    (next: Partial<BoardControls>) => {
      const qs = queryOf({ ...controlsRef.current, ...next })
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
    },
    [router, pathname],
  )

  useEffect(() => {
    let gone = false
    listPlanningSites(api, session.company?.id ?? null)
      .then((value) => !gone && setSites({ status: 'ready', value }))
      .catch((error) => {
        if (gone) return
        setSites({ status: 'error', problem: readProblemOf(error) })
        setRead({ status: 'error', problem: readProblemOf(error) })
      })
    return () => {
      gone = true
    }
  }, [api, session.company?.id])

  const today = site ? businessDate(new Date(), site.timeZone) : null
  const from = today ? windowFrom(controls, today) : undefined
  const load = useCallback(async (): Promise<Board | null> => {
    if (!siteId) {
      if (sites.status === 'ready') setRead({ status: 'error', problem: 'noSite' })
      return null
    }
    const id = ++readId.current
    try {
      const value = await getBoard(api, { siteId, from: controlsRef.current.from || controlsRef.current.zoom !== 'DAY' ? from : undefined, bucket: controlsRef.current.zoom })
      if (id !== readId.current) return value
      boardRef.current = value
      knownVersion.current = value.plan.version
      setRead({ status: 'ready', value })
      return value
    } catch (error) {
      if (id === readId.current) setRead({ status: 'error', problem: readProblemOf(error) })
      return null
    }
  }, [api, siteId, sites.status, from])

  useEffect(() => {
    if (sites.status !== 'ready') return
    setRead((current) => (current.status === 'ready' && current.value.site.id === siteId ? current : { status: 'loading' }))
    void load()
  }, [load, sites.status, siteId, controls.zoom])

  // Live: another planner's change (a newer plan version), a publish, a calendar, capacity or a work order.
  const reread = useCoalesced(() => void load(), 700)
  const live = useLive(
    (change) => {
      const own = change.fields.siteId === undefined || change.fields.siteId === siteId
      if (change.type === 'planning.schedule_changed' && own) {
        const version = Number(change.fields.planVersion)
        if (knownVersion.current === null || version > knownVersion.current) {
          setNotice(t('notice.otherPlanner'))
          reread()
        }
      } else if ((change.type === 'planning.schedule_published' || change.type === 'planning.capacity_changed' || change.type === 'calendar.changed') && own) reread()
      else if (change.type.startsWith('workorder.') || change.type.startsWith('work_order.')) reread()
    },
    () => void load(),
    siteId !== null,
  )
  useEffect(() => {
    const update = () => setOnline(typeof navigator === 'undefined' ? true : navigator.onLine)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  const offline = !online || live === 'offline'

  // ---- moves ----------------------------------------------------------------------------------------------------------

  const askDrop = useCallback((card: string, laneName: string, days: OverDay[], source: 'board' | 'api', next: boolean) => {
    return new Promise<DropChoice>((resolve) => {
      dropAnswer.current = resolve
      setDialog({ kind: 'drop', cardLabel: card, laneName, days, source, next })
    })
  }, [])

  const send = useCallback(
    async (plan: Exclude<MovePlan, { kind: 'none' }>, overloadReason: string | null) => {
      if (plan.kind === 'remove') return removeSlot(api, plan.slotId, plan.version)
      if (plan.kind === 'place') return placeSlot(api, { workOrderId: plan.workOrderId, operationId: plan.operationId, lane: plan.lane, startAt: plan.startAt, ...(overloadReason ? { overloadReason } : {}) })
      return moveSlot(api, plan.slotId, { version: plan.version, ...(plan.lane ? { lane: plan.lane } : {}), ...(plan.startAt ? { startAt: plan.startAt } : {}), ...(overloadReason ? { overloadReason } : {}) })
    },
    [api],
  )

  const saved = useCallback(async (answer: { planVersion: number }) => {
    knownVersion.current = answer.planVersion
    setSave({ state: 'saved', at: new Date().toISOString() })
    await load()
  }, [load])

  const onMove = useCallback(
    async (move: PlanningMove): Promise<boolean> => {
      const board = boardRef.current
      if (!board) return false
      const drawn = drawBoard(board, controlsRef.current, words, session.user.id)
      const card = drawn.cards.find((entry) => entry.id === move.cardId)
      const lane = drawn.lanes.find((entry) => entry.id === move.to.laneId)
      let plan = planMove(board, controlsRef.current, move, new Date())
      if (plan.kind === 'none') return false
      let reason: string | null = null
      // The DS's own estimate says the drop goes over: ask first (Keep with a reason · the next free day · Cancel).
      if (move.over && plan.kind !== 'remove') {
        const next = nextFreePlace(drawn, move)
        const choice = await askDrop(card?.label ?? '', lane?.label ?? '', overFromMove(move.loadAfter), 'board', next !== null)
        if (choice.kind === 'cancel') return false
        if (choice.kind === 'next') {
          plan = next ? planMove(board, controlsRef.current, { ...move, to: next }, new Date()) : plan
          if (plan.kind === 'none') return false
          setSave({ state: 'saving' })
          try {
            await saved(await send(plan, null))
            setNotice(t('notice.nextFree', { order: card?.label ?? '' }))
          } catch (error) {
            setSave({ state: 'failed', refusal: refusalOf(error) })
          }
          // The board said "not moved" for the place it was dropped on: the bar is at the next free day instead.
          return false
        }
        reason = choice.reason
      }
      setSave({ state: 'saving' })
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await saved(await send(plan, reason))
          return true
        } catch (error) {
          const refusal = refusalOf(error)
          if (refusal.code === 'OVERLOAD' && reason === null) {
            // The API counts the work not on the board too: its numbers, then the same choice.
            const choice = await askDrop(card?.label ?? '', lane?.label ?? '', overFromIssues(error, move.to.laneId), 'api', false)
            if (choice.kind !== 'keep') {
              setSave({ state: 'idle' })
              return false
            }
            reason = choice.reason
            continue
          }
          setSave({ state: 'failed', refusal })
          if (refusal.code === 'MOVED_BY' || refusal.code === 'PLAN_CHANGED' || refusal.code === 'NOT_FOUND') void load()
          return false
        }
      }
      return false
    },
    [askDrop, load, saved, send, session.user.id, t, words],
  )

  const onDropChoice = useCallback((choice: DropChoice) => {
    const answer = dropAnswer.current
    dropAnswer.current = null
    setDialog(null)
    answer?.(choice)
  }, [])

  // ---- the bar's detail --------------------------------------------------------------------------------------------

  const openBar = useCallback(
    (workOrderId: string, slotId: string | null) => {
      setDialog({ kind: 'bar', workOrderId, slotId, detail: { status: 'loading' } })
      getBarDetail(api, workOrderId)
        .then((value) => setDialog((current) => (current?.kind === 'bar' && current.workOrderId === workOrderId ? { ...current, detail: { status: 'ready', value } } : current)))
        .catch((error) => setDialog((current) => (current?.kind === 'bar' && current.workOrderId === workOrderId ? { ...current, detail: { status: 'error', problem: readProblemOf(error) } } : current)))
    },
    [api],
  )

  const onOpen = useCallback(
    (card: PlanningCard) => {
      const board = boardRef.current
      const fromTray = workOrderOfTrayCard(card.id)
      const slot = fromTray ? null : board?.slots.find((entry) => entry.id === card.id)
      const workOrderId = fromTray ?? slot?.workOrderId
      if (!workOrderId) return
      setControls({ wo: workOrderId })
      openBar(workOrderId, slot?.id ?? null)
    },
    [openBar, setControls],
  )

  // A link with `?wo=` opens the bar's detail.
  useEffect(() => {
    if (controls.wo && read.status === 'ready' && dialog === null) {
      const slot = read.value.slots.find((entry) => entry.workOrderId === controls.wo)
      openBar(controls.wo, slot?.id ?? null)
    }
    // Only when the address names another work order (not on every dialog change).
  }, [controls.wo, read.status])

  const onSendToTray = useCallback(
    async (slotId: string) => {
      const slot = boardRef.current?.slots.find((entry) => entry.id === slotId)
      if (!slot) return
      setDialog((current) => (current?.kind === 'bar' ? { ...current, busy: true, error: null } : current))
      setSave({ state: 'saving' })
      try {
        await saved(await removeSlot(api, slot.id, slot.version))
        setDialog(null)
        setControls({ wo: null })
      } catch (error) {
        const refusal = refusalOf(error)
        const words2 = refusalWords(refusal, words)
        setSave({ state: 'failed', refusal })
        setDialog((current) => (current?.kind === 'bar' ? { ...current, busy: false, error: words2 } : current))
      }
    },
    [api, saved, setControls, words],
  )

  // ---- publish -------------------------------------------------------------------------------------------------------

  const preview = useCallback(
    async (range: PublishRangeKind, wanted: PublishRange) => {
      if (!siteId) return
      setDialog((current) => (current?.kind === 'publish' ? { ...current, range, preview: { status: 'loading' }, error: null } : { kind: 'publish', range, from: null, to: null, preview: { status: 'loading' } }))
      try {
        const value = await getPublishPreview(api, siteId, wanted)
        if (value.range.isDefault) defaultRange.current = { from: value.range.coversFrom, to: value.range.coversTo }
        setDialog((current) => (current?.kind === 'publish' ? { ...current, from: value.range.coversFrom, to: value.range.coversTo, preview: { status: 'ready', value } } : current))
      } catch (error) {
        const refusal = refusalOf(error)
        setDialog((current) => (current?.kind === 'publish' ? { ...current, preview: { status: 'error', problem: readProblemOf(error) }, error: refusal.code === 'INVALID' ? t('publish.rangeRefused') : null } : current))
      }
    },
    [api, siteId, t],
  )

  const onPublishRange = useCallback(
    (range: PublishRangeKind, from?: string | null, to?: string | null) => {
      if (range === 'default') void preview('default', {})
      else if (range === 'tomorrow') {
        const first = defaultRange.current?.from
        void preview('tomorrow', first ? { coversFrom: first, coversTo: first } : {})
      } else if (from && to) void preview('custom', { coversFrom: from, coversTo: to })
      else setDialog((current) => (current?.kind === 'publish' ? { ...current, range: 'custom' } : current))
    },
    [preview],
  )

  const onPublish = useCallback(async () => {
    if (dialog?.kind !== 'publish' || dialog.preview.status !== 'ready' || !siteId) return
    const value = dialog.preview.value
    if (value.plan.version === null) return
    setDialog({ ...dialog, busy: true, error: null })
    try {
      const answer = await publishPlan(api, { siteId, version: value.plan.version, coversFrom: value.range.coversFrom, coversTo: value.range.coversTo })
      setDialog((current) => (current?.kind === 'publish' ? { ...current, busy: false, done: answer.version } : current))
      setNotice(t('notice.published', { version: answer.version.number }))
      void load()
    } catch (error) {
      const refusal = refusalOf(error)
      setDialog((current) => (current?.kind === 'publish' ? { ...current, busy: false, error: refusal.code === 'PLAN_CHANGED' ? t('publish.planChanged') : refusalWords(refusal, words) } : current))
      if (refusal.code === 'PLAN_CHANGED') void preview(dialog.range, dialog.range === 'default' ? {} : { coversFrom: value.range.coversFrom, coversTo: value.range.coversTo })
    }
  }, [api, dialog, load, preview, siteId, t, words])

  // ---- place all by due date ------------------------------------------------------------------------------------------

  const openPlace = useCallback(async () => {
    if (!siteId) return
    setDialog({ kind: 'place', preview: { status: 'loading' } })
    try {
      const value = await placeByDueDate(api, { siteId, apply: false })
      setDialog((current) => (current?.kind === 'place' ? { ...current, preview: { status: 'ready', value } } : current))
    } catch (error) {
      const refusal = refusalOf(error)
      setDialog((current) => (current?.kind === 'place' ? { ...current, preview: { status: 'ready', value: { planVersion: null, applied: false, slots: [], skipped: [], overbooked: 0, replayed: false } }, error: refusalWords(refusal, words) } : current))
    }
  }, [api, siteId, words])

  const onPlaceApply = useCallback(
    async (reason: string | null) => {
      if (!siteId) return
      const version = boardRef.current?.plan.version ?? undefined
      setDialog((current) => (current?.kind === 'place' ? { ...current, busy: true, error: null } : current))
      setSave({ state: 'saving' })
      try {
        const answer = await placeByDueDate(api, { siteId, apply: true, ...(version ? { version } : {}), ...(reason ? { overloadReason: reason } : {}) })
        setDialog(null)
        setNotice(t('notice.placed', { count: answer.slots.length }))
        if (answer.planVersion !== null) await saved({ planVersion: answer.planVersion })
        else setSave({ state: 'saved', at: new Date().toISOString() })
      } catch (error) {
        const refusal = refusalOf(error)
        const text = refusal.code === 'PLAN_CHANGED' ? t('place.planChanged') : refusalWords(refusal, words)
        setSave({ state: 'failed', refusal })
        setDialog((current) => (current?.kind === 'place' ? { ...current, busy: false, error: text } : current))
        if (refusal.code === 'PLAN_CHANGED') void load()
      }
    },
    [api, load, saved, siteId, t, words],
  )

  // ---- the rest -------------------------------------------------------------------------------------------------------

  const onOpenDialog = useCallback(
    (kind: 'publish' | 'place' | 'legend' | 'versions' | 'keys') => {
      if (kind === 'publish') void preview('default', {})
      else if (kind === 'place') void openPlace()
      else if (kind === 'versions') {
        if (!siteId) return
        setDialog({ kind: 'versions', versions: { status: 'loading' } })
        listVersions(api, siteId)
          .then((value) => setDialog((current) => (current?.kind === 'versions' ? { kind: 'versions', versions: { status: 'ready', value } } : current)))
          .catch((error) => setDialog((current) => (current?.kind === 'versions' ? { kind: 'versions', versions: { status: 'error', problem: readProblemOf(error) } } : current)))
      } else setDialog({ kind })
    },
    [api, openPlace, preview, siteId],
  )

  const onCloseDialog = useCallback(() => {
    if (dialog?.kind === 'drop') return onDropChoice({ kind: 'cancel' })
    if (dialog?.kind === 'bar') setControls({ wo: null })
    setDialog(null)
  }, [dialog, onDropChoice, setControls])

  const showWorkOrder = useCallback(
    (workOrderId: string | null, slotId: string | null, laneId: string | null, date: string | null) => {
      const board = boardRef.current
      setDialog(null)
      const slot = slotId ? board?.slots.find((entry) => entry.id === slotId) : workOrderId ? board?.slots.find((entry) => entry.workOrderId === workOrderId) : undefined
      if (slot) {
        if (controlsRef.current.view === 'orders' || !controlsRef.current.lanes.length || controlsRef.current.lanes.includes(laneKeyOf(slot.lane))) setFocus({ cardId: slot.id })
        else {
          setControls({ lanes: [] })
          setFocus({ cardId: slot.id })
        }
        return
      }
      if (workOrderId && board?.tray.some((entry) => entry.workOrderId === workOrderId)) return setFocus({ cardId: `tray:${workOrderId}` })
      if (laneId) {
        if (date && board && (date < board.from || date > board.to)) setControls({ from: date })
        setFocus({ laneId })
      }
    },
    [setControls],
  )

  const model: BoardViewModel = {
    prefix,
    me: session.user.id,
    sites: sites.status === 'ready' ? sites.value : [],
    controls: { ...controls, site: siteId },
    read,
    offline,
    save,
    dialog,
    notice,
    focus,
  }

  return (
    <BoardView
      model={model}
      actions={{
        onControls: setControls,
        onRetry: () => {
          setRead({ status: 'loading' })
          void load()
        },
        onMove,
        onOpen,
        onOpenDialog,
        onCloseDialog,
        onDropChoice,
        onPublishRange,
        onPublish: () => void onPublish(),
        onPlaceApply: (reason) => void onPlaceApply(reason),
        onSendToTray: (slotId) => void onSendToTray(slotId),
        onShowProblem: (row: ProblemRow) => showWorkOrder(row.workOrderId, null, row.laneId, row.date),
        onShowCheck: (target) => showWorkOrder(target.workOrderId, target.slotId, target.laneId, null),
      }}
    />
  )
}
