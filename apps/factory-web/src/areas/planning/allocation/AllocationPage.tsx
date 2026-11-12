'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { PlanningCard, PlanningMove } from '@nexus/ui/patterns/planning-board/index'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { useCoalesced, useLive } from '../../_shared/buying/hooks'
import { BOARD_KIT_NAMESPACE } from '../../_shared/planning-board/words'
import { getBarDetail, listPlanningSites, type PlanningSite } from '../board/api'
import { allocate, getAllocation, type Allocation } from './api'
import { bringInHouse, createSubcontractOrders, getAllocationWorkshops, getKitTiming, getWorkOrderWorkshops, sendOutside, type AllocationWorkshops } from './depth/api'
import { DEPTH_NAMESPACE, holdWords, kitProblemOf, orderableParts, oneStop, ordersRefusalOf, outsideDoneWords, slotsOf, switchRefusalOf, switchRefusalWords, workshopOf } from './depth/model'
import { controlsOf, laneRefOf, NAMESPACE, planAllocation, queryOf, readProblemOf, refusalOf, type AllocationControls } from './model'
import type { AllocationDialog, AllocationViewModel, CardOperations, Loaded, SaveState } from './view-model'
import { AllocationView } from './view/AllocationView'

/**
 * `/w/<company>/planning/allocation` (SCR-126; Planning › Lines & subcontractors, planning.view): the company's planning
 * sites (`?site=`), the site's allocation board, a card's detail (`?card=`). A drop moves all the card's garments; the
 * detail moves part of them. Each move is the work order's whole next allocation (factory-domain `moveAllocation`) sent
 * with the work order's version, one at a time, never optimistic. Live: the schedule and work orders read it again.
 *
 * B-W2b-338 (on B-W2b-321's API): beside the board, which workshops take each work order's outside work (GET
 * /planning/allocation/workshops: held drop zones with the reason); a drop on a workshop opens the kit timing (GET
 * …/kit-timing) whose Allocate is the board's own change; the card's operations (the board's work order read for every
 * operation, then GET …/workshops for their versions) switch one operation outside or back in-house (POST
 * …/operations/:id/outside | in-house, the operation's version; a 409 reads it again); "Create subcontract orders (n)"
 * previews the workshop parts (POST /planning/allocation/subcontract-orders preview: true) and then makes the parts that
 * pass.
 */
export function AllocationPage() {
  return (
    <WithMessages namespaces={[NAMESPACE, BOARD_KIT_NAMESPACE, DEPTH_NAMESPACE, 'buying']}>
      <AllocationContainer />
    </WithMessages>
  )
}

const LIVE_DEPTH = /^(work_order_operation\.outsourced|subcontractor_capacity\.changed|subcontract_order\.|purchasing\.subcontract)/

function AllocationContainer() {
  const t = useT(NAMESPACE)
  const td = useT(DEPTH_NAMESPACE)
  const locale = useLocale()
  const depthWords = useMemo(() => ({ t: td, locale }), [td, locale])
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const params = useSearchParams()
  const query = params?.toString() ?? ''
  const controls = useMemo(() => controlsOf(new URLSearchParams(query)), [query])
  const prefix = pathname.replace(/\/planning\/allocation\/?$/, '')
  const [sites, setSites] = useState<Loaded<PlanningSite[]>>({ status: 'loading' })
  const [read, setRead] = useState<Loaded<Allocation>>({ status: 'loading' })
  const [workshops, setWorkshops] = useState<Loaded<AllocationWorkshops>>({ status: 'loading' })
  const [save, setSave] = useState<SaveState>({ state: 'idle' })
  const [dialog, setDialogState] = useState<AllocationDialog | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [online, setOnline] = useState(true)
  const dataRef = useRef<Allocation | null>(null)
  const workshopsRef = useRef<AllocationWorkshops | null>(null)
  const dialogRef = useRef<AllocationDialog | null>(null)
  const readId = useRef(0)
  const controlsRef = useRef(controls)
  controlsRef.current = controls
  const may = { outsource: session.permissions.includes('planning.subcontract.outsource'), order: session.permissions.includes('purchasing.subcontract.manage') }

  const setDialog = useCallback((next: AllocationDialog | null | ((current: AllocationDialog | null) => AllocationDialog | null)) => {
    setDialogState((current) => {
      const value = typeof next === 'function' ? next(current) : next
      dialogRef.current = value
      return value
    })
  }, [])

  const site = sites.status === 'ready' ? (sites.value.find((entry) => entry.id === controls.site) ?? sites.value[0] ?? null) : null
  const siteId = site?.id ?? null

  const setControls = useCallback(
    (next: Partial<AllocationControls>) => {
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

  /** The board and the workshops' check, read together; a failed check holds every workshop column (never unchecked). */
  const load = useCallback(async () => {
    if (!siteId) {
      if (sites.status === 'ready') setRead({ status: 'error', problem: 'noSite' })
      return
    }
    const id = ++readId.current
    const [board, checked] = await Promise.allSettled([getAllocation(api, siteId), getAllocationWorkshops(api, siteId)])
    if (id !== readId.current) return
    if (board.status === 'fulfilled') {
      dataRef.current = board.value
      setRead({ status: 'ready', value: board.value })
    } else setRead({ status: 'error', problem: readProblemOf(board.reason) })
    if (checked.status === 'fulfilled') {
      workshopsRef.current = checked.value
      setWorkshops({ status: 'ready', value: checked.value })
    } else {
      workshopsRef.current = null
      setWorkshops({ status: 'error', problem: readProblemOf(checked.reason) })
    }
  }, [api, siteId, sites.status])

  useEffect(() => {
    if (sites.status !== 'ready') return
    setRead({ status: 'loading' })
    setWorkshops({ status: 'loading' })
    void load()
  }, [load, sites.status])

  const reread = useCoalesced(() => void load(), 700)
  const live = useLive(
    (change) => {
      const own = change.fields.siteId === undefined || change.fields.siteId === siteId
      if ((change.type === 'planning.schedule_changed' || change.type === 'planning.capacity_changed' || change.type === 'calendar.changed') && own) reread()
      else if (change.type.startsWith('workorder.') || change.type.startsWith('work_order.') || change.type.startsWith('purchasing.subcontract') || LIVE_DEPTH.test(change.type)) reread()
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

  /** One allocation change: the work order's next allocation, with its version; the board is read again first. */
  const change = useCallback(
    async (cardId: string, laneKey: string | null, pieces?: number): Promise<string | null> => {
      const data = dataRef.current
      if (!data) return t('refusal.STALE')
      const plan = planAllocation(data, cardId, laneKey, pieces)
      if (plan.kind === 'refused') return t(`refusal.${plan.code}`)
      setSave({ state: 'saving' })
      try {
        await allocate(api, plan.workOrderId, plan.body)
        setSave({ state: 'saved', at: new Date().toISOString() })
        await load()
        return null
      } catch (error) {
        const code = refusalOf(error)
        const words = t(`refusal.${code}`)
        setSave({ state: 'failed', refusal: code })
        if (code === 'CHANGED' || code === 'NOT_FOUND' || code === 'NOT_OPEN') void load()
        return words
      }
    },
    [api, load, t],
  )

  // ---- the kit timing of a drop on a workshop ----

  const readKit = useCallback(
    (cardId: string, laneKey: string, pieces: number) => {
      const card = dataRef.current?.cards.find((entry) => entry.id === cardId)
      const ref = laneRefOf(laneKey)
      if (!card || ref?.kind !== 'WORKSHOP') return
      setDialog({ kind: 'kit', cardId, laneKey, pieces, timing: { status: 'loading' } })
      getKitTiming(api, card.workOrder.id, { partyId: ref.id, pieces })
        .then((value) => setDialog((current) => (current?.kind === 'kit' && current.cardId === cardId && current.laneKey === laneKey ? { ...current, timing: { status: 'ready', value } } : current)))
        .catch((error: unknown) => setDialog((current) => (current?.kind === 'kit' && current.cardId === cardId && current.laneKey === laneKey ? { ...current, timing: { status: 'error', problem: kitProblemOf(error) } } : current)))
    },
    [api, setDialog],
  )

  const onMove = useCallback(
    async (move: PlanningMove): Promise<boolean> => {
      if (move.from.laneId === move.to.laneId) return false
      if (laneRefOf(move.to.laneId)?.kind === 'WORKSHOP') {
        // The design's "Drop on a workshop opens the kit-timing popover": the card moves when Allocate is pressed.
        const card = dataRef.current?.cards.find((entry) => entry.id === move.cardId)
        if (card) readKit(move.cardId, move.to.laneId!, card.pieces)
        return false
      }
      const refused = await change(move.cardId, move.to.laneId)
      if (refused) setNotice(refused)
      else setNotice(null)
      return refused === null
    },
    [change, readKit],
  )

  const onAllocateKit = useCallback(async () => {
    const current = dialogRef.current
    if (current?.kind !== 'kit') return
    setDialog({ ...current, busy: true, error: null })
    const refused = await change(current.cardId, current.laneKey, current.pieces === dataRef.current?.cards.find((card) => card.id === current.cardId)?.pieces ? undefined : current.pieces)
    if (refused) setDialog((now) => (now?.kind === 'kit' ? { ...now, busy: false, error: refused } : now))
    else {
      setDialog(null)
      setControls({ card: null })
      const lane = dataRef.current?.lanes.find((entry) => `${entry.kind}:${entry.id}` === current.laneKey)
      setNotice(oneStop(td('al.kit.done', { count: current.pieces, pieces: String(current.pieces), workshop: lane?.name ?? '' })))
    }
  }, [change, setControls, setDialog, td])

  // ---- the card and its operations ----

  const readOperations = useCallback(
    async (cardId: string) => {
      const card = dataRef.current?.cards.find((entry) => entry.id === cardId)
      if (!card) return
      setDialog((current) => (current?.kind === 'card' && current.cardId === cardId ? { ...current, operations: { status: 'loading' } } : current))
      try {
        const detail = await getBarDetail(api, card.workOrder.id)
        const ids = detail.workOrder.operations.map((operation) => operation.id)
        const answer = await getWorkOrderWorkshops(api, card.workOrder.id, ids)
        const lanes = dataRef.current?.lanes ?? []
        const operations: CardOperations['operations'] = answer.operations.map((operation) => {
          const board = detail.workOrder.operations.find((entry) => entry.id === operation.id)
          const partyId = board?.lane.kind === 'WORKSHOP' ? board.lane.id : (board?.outside?.partyId ?? null)
          const workshopName = partyId ? (lanes.find((lane) => lane.kind === 'WORKSHOP' && lane.id === partyId)?.name ?? answer.workshops.find((workshop) => workshop.id === partyId)?.name ?? null) : null
          return { ...operation, remaining: board?.remainingPieces ?? null, workshopName: operation.outsourced ? workshopName : null }
        })
        const value: CardOperations = { operations, mayOutsource: answer.mayOutsource }
        setDialog((current) => (current?.kind === 'card' && current.cardId === cardId ? { ...current, operations: { status: 'ready', value } } : current))
      } catch (error) {
        setDialog((current) => (current?.kind === 'card' && current.cardId === cardId ? { ...current, operations: { status: 'error', problem: readProblemOf(error) } } : current))
      }
    },
    [api, setDialog],
  )

  const openCard = useCallback(
    (cardId: string) => {
      setDialog({ kind: 'card', cardId, operations: { status: 'loading' } })
      void readOperations(cardId)
    },
    [readOperations, setDialog],
  )

  const onOpen = useCallback(
    (card: PlanningCard) => {
      setControls({ card: card.id })
      openCard(card.id)
    },
    [openCard, setControls],
  )

  useEffect(() => {
    if (controls.card && read.status === 'ready' && dialog === null) openCard(controls.card)
    // Only when the address names another card.
  }, [controls.card, read.status])

  const onMovePart = useCallback(
    async (cardId: string, laneKey: string | null, pieces: number) => {
      if (laneRefOf(laneKey)?.kind === 'WORKSHOP') {
        readKit(cardId, laneKey!, pieces)
        return
      }
      setDialog((current) => (current?.kind === 'card' ? { ...current, busy: true, error: null } : current))
      const refused = await change(cardId, laneKey, pieces)
      if (refused) setDialog((current) => (current?.kind === 'card' ? { ...current, busy: false, error: refused } : current))
      else {
        setDialog(null)
        setControls({ card: null })
        setNotice(t('notice.moved', { count: pieces, pieces }))
      }
    },
    [change, readKit, setControls, setDialog, t],
  )

  // ---- one operation in-house or outside ----

  const readSwitch = useCallback(
    (cardId: string, operationId: string, mode: 'outside' | 'in-house') => {
      const card = dataRef.current?.cards.find((entry) => entry.id === cardId)
      if (!card) return
      setDialog({ kind: 'switch', cardId, operationId, mode, workshops: { status: 'loading' } })
      getWorkOrderWorkshops(api, card.workOrder.id, [operationId])
        .then((value) => setDialog((current) => (current?.kind === 'switch' && current.operationId === operationId ? { ...current, workshops: { status: 'ready', value } } : current)))
        .catch((error: unknown) => setDialog((current) => (current?.kind === 'switch' && current.operationId === operationId ? { ...current, workshops: { status: 'error', problem: readProblemOf(error) } } : current)))
    },
    [api, setDialog],
  )

  const switchDone = useCallback(
    async (words: string) => {
      setDialog(null)
      setControls({ card: null })
      setNotice(words)
      await load()
    },
    [load, setControls, setDialog],
  )

  const switchRefused = useCallback(
    (error: unknown) => {
      const current = dialogRef.current
      if (current?.kind !== 'switch') return
      const refusal = switchRefusalOf(error)
      const { code, holds } = refusal
      const data = dataRef.current
      const workshop = current.workshops.status === 'ready' ? (current.workshops.value.workshops.find((entry) => entry.id === current.partyId) ?? null) : null
      const said = code === 'HELD' ? holds.map((reason) => holdWords(reason, workshopOf(workshopsRef.current, workshop?.id ?? '') ?? workshop, data?.site.name ?? '', depthWords)).join(' ') : switchRefusalWords(refusal, depthWords)
      setDialog({ ...current, busy: false, error: said })
      if (code === 'CHANGED' || code === 'HELD' || code === 'NOT_FOUND') readSwitch(current.cardId, current.operationId, current.mode)
    },
    [depthWords, readSwitch, setDialog, td],
  )

  const onSendOutside = useCallback(
    async (input: { partyId: string; pieces: number }) => {
      const current = dialogRef.current
      if (current?.kind !== 'switch' || current.workshops.status !== 'ready') return
      const read = current.workshops.value
      const operation = read.operations.find((entry) => entry.id === current.operationId)
      if (!operation) return
      setDialog({ ...current, partyId: input.partyId, busy: true, error: null })
      try {
        const answer = await sendOutside(api, read.workOrder.id, operation.id, { version: operation.version, partyId: input.partyId, ...(input.pieces === read.workOrder.garments ? {} : { pieces: input.pieces }) })
        await switchDone(outsideDoneWords(answer, depthWords, dataRef.current?.site.timeZone ?? 'UTC'))
      } catch (error) {
        switchRefused(error)
      }
    },
    [api, depthWords, setDialog, switchDone, switchRefused],
  )

  const onBringInHouse = useCallback(
    async (reason: string) => {
      const current = dialogRef.current
      if (current?.kind !== 'switch' || current.workshops.status !== 'ready') return
      const read = current.workshops.value
      const operation = read.operations.find((entry) => entry.id === current.operationId)
      if (!operation) return
      setDialog({ ...current, reason, busy: true, error: null })
      try {
        const answer = await bringInHouse(api, read.workOrder.id, operation.id, { version: operation.version, reason })
        const head = td('al.op.backInHouse', { seq: String(answer.operation.seq), operation: answer.operation.name })
        const order = answer.order?.change ? td(`al.op.orderChange.${answer.order.change}`, { order: answer.order.number }) : ''
        await switchDone(order ? `${head} ${order}` : head)
      } catch (error) {
        switchRefused(error)
      }
    },
    [api, setDialog, switchDone, switchRefused, td],
  )

  // ---- Create subcontract orders (n) ----

  const readPreview = useCallback(async () => {
    const data = dataRef.current
    if (!data || !siteId) return
    const slotIds = slotsOf(orderableParts(data, workshopsRef.current))
    setDialog({ kind: 'orders', slotIds, preview: { status: 'loading' }, phase: 'ready' })
    try {
      const value = await createSubcontractOrders(api, { siteId, slotIds, preview: true })
      setDialog((current) => (current?.kind === 'orders' ? { ...current, preview: { status: 'ready', value } } : current))
    } catch (error) {
      setDialog((current) => (current?.kind === 'orders' ? { ...current, preview: { status: 'error', problem: readProblemOf(error) } } : current))
    }
  }, [api, setDialog, siteId])

  const onConfirmOrders = useCallback(async () => {
    const current = dialogRef.current
    if (current?.kind !== 'orders' || current.preview.status !== 'ready' || !siteId) return
    const slotIds = current.preview.value.results.filter((result) => result.ok).map((result) => result.slotId)
    if (slotIds.length === 0) return
    setDialog({ ...current, phase: 'saving', error: null })
    try {
      const result = await createSubcontractOrders(api, { siteId, slotIds, preview: false })
      setDialog((now) => (now?.kind === 'orders' ? { ...now, phase: 'done', result } : now))
      setNotice(td('al.orders.notice', { count: result.made }))
      void load()
    } catch (error) {
      setDialog((now) => (now?.kind === 'orders' ? { ...now, phase: 'ready', error: ordersRefusalOf(error) } : now))
    }
  }, [api, load, setDialog, siteId, td])

  const model: AllocationViewModel = {
    prefix,
    sites: sites.status === 'ready' ? sites.value : [],
    controls: { ...controls, site: siteId },
    read,
    workshops,
    may,
    offline,
    save,
    dialog,
    notice,
  }

  return (
    <AllocationView
      model={model}
      actions={{
        onSite: (id) => setControls({ site: id, card: null }),
        onRetry: () => {
          setRead({ status: 'loading' })
          setWorkshops({ status: 'loading' })
          void load()
        },
        onMove,
        onOpen,
        onMovePart: (cardId, laneKey, pieces) => void onMovePart(cardId, laneKey, pieces),
        onOpenKeys: () => setDialog({ kind: 'keys' }),
        onCloseDialog: () => {
          if (dialog?.kind === 'card' || dialog?.kind === 'switch') setControls({ card: null })
          setDialog(null)
        },
        onAllocateKit: () => void onAllocateKit(),
        onRetryKit: () => {
          const current = dialogRef.current
          if (current?.kind === 'kit') readKit(current.cardId, current.laneKey, current.pieces)
        },
        onSwitch: (cardId, operationId, mode) => readSwitch(cardId, operationId, mode),
        onRetrySwitch: () => {
          const current = dialogRef.current
          if (current?.kind === 'switch') readSwitch(current.cardId, current.operationId, current.mode)
        },
        onSendOutside: (input) => void onSendOutside(input),
        onBringInHouse: (reason) => void onBringInHouse(reason),
        onBackToCard: () => {
          const current = dialogRef.current
          if (current?.kind === 'switch') openCard(current.cardId)
        },
        onRetryOperations: () => {
          const current = dialogRef.current
          if (current?.kind === 'card') void readOperations(current.cardId)
        },
        onCreateOrders: () => void readPreview(),
        onConfirmOrders: () => void onConfirmOrders(),
        onRetryOrders: () => void readPreview(),
      }}
    />
  )
}
