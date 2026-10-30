'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { PlanningCard, PlanningMove } from '@nexus/ui/patterns/planning-board/index'
import { useT } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { useCoalesced, useLive } from '../../_shared/buying/hooks'
import { BOARD_KIT_NAMESPACE } from '../../_shared/planning-board/words'
import { listPlanningSites, type PlanningSite } from '../board/api'
import { allocate, getAllocation, type Allocation } from './api'
import { controlsOf, NAMESPACE, planAllocation, queryOf, readProblemOf, refusalOf, type AllocationControls } from './model'
import type { AllocationDialog, AllocationViewModel, Loaded, SaveState } from './view-model'
import { AllocationView } from './view/AllocationView'

/**
 * `/w/<company>/planning/allocation` (SCR-126; Planning › Lines & subcontractors, planning.view): the company's planning
 * sites (`?site=`), the site's allocation board, a card's detail (`?card=`). A drop moves all the card's garments; the
 * detail moves part of them. Each move is the work order's whole next allocation (factory-domain `moveAllocation`) sent
 * with the work order's version, one at a time, never optimistic. Live: the schedule and work orders read it again.
 */
export function AllocationPage() {
  return (
    <WithMessages namespaces={[NAMESPACE, BOARD_KIT_NAMESPACE]}>
      <AllocationContainer />
    </WithMessages>
  )
}

function AllocationContainer() {
  const t = useT(NAMESPACE)
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
  const [save, setSave] = useState<SaveState>({ state: 'idle' })
  const [dialog, setDialog] = useState<AllocationDialog | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [online, setOnline] = useState(true)
  const dataRef = useRef<Allocation | null>(null)
  const readId = useRef(0)
  const controlsRef = useRef(controls)
  controlsRef.current = controls

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

  const load = useCallback(async () => {
    if (!siteId) {
      if (sites.status === 'ready') setRead({ status: 'error', problem: 'noSite' })
      return
    }
    const id = ++readId.current
    try {
      const value = await getAllocation(api, siteId)
      if (id !== readId.current) return
      dataRef.current = value
      setRead({ status: 'ready', value })
    } catch (error) {
      if (id === readId.current) setRead({ status: 'error', problem: readProblemOf(error) })
    }
  }, [api, siteId, sites.status])

  useEffect(() => {
    if (sites.status !== 'ready') return
    setRead({ status: 'loading' })
    void load()
  }, [load, sites.status])

  const reread = useCoalesced(() => void load(), 700)
  const live = useLive(
    (change) => {
      const own = change.fields.siteId === undefined || change.fields.siteId === siteId
      if ((change.type === 'planning.schedule_changed' || change.type === 'planning.capacity_changed' || change.type === 'calendar.changed') && own) reread()
      else if (change.type.startsWith('workorder.') || change.type.startsWith('work_order.') || change.type.startsWith('purchasing.subcontract')) reread()
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

  const onMove = useCallback(
    async (move: PlanningMove): Promise<boolean> => {
      if (move.from.laneId === move.to.laneId) return false
      const refused = await change(move.cardId, move.to.laneId)
      if (refused) setNotice(refused)
      else setNotice(null)
      return refused === null
    },
    [change],
  )

  const onOpen = useCallback(
    (card: PlanningCard) => {
      setControls({ card: card.id })
      setDialog({ kind: 'card', cardId: card.id })
    },
    [setControls],
  )

  useEffect(() => {
    if (controls.card && read.status === 'ready' && dialog === null) setDialog({ kind: 'card', cardId: controls.card })
    // Only when the address names another card.
  }, [controls.card, read.status])

  const onMovePart = useCallback(
    async (cardId: string, laneKey: string | null, pieces: number) => {
      setDialog((current) => (current?.kind === 'card' ? { ...current, busy: true, error: null } : current))
      const refused = await change(cardId, laneKey, pieces)
      if (refused) setDialog((current) => (current?.kind === 'card' ? { ...current, busy: false, error: refused } : current))
      else {
        setDialog(null)
        setControls({ card: null })
        setNotice(t('notice.moved', { count: pieces, pieces }))
      }
    },
    [change, setControls, t],
  )

  const model: AllocationViewModel = {
    prefix,
    sites: sites.status === 'ready' ? sites.value : [],
    controls: { ...controls, site: siteId },
    read,
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
          void load()
        },
        onMove,
        onOpen,
        onMovePart: (cardId, laneKey, pieces) => void onMovePart(cardId, laneKey, pieces),
        onOpenKeys: () => setDialog({ kind: 'keys' }),
        onCloseDialog: () => {
          if (dialog?.kind === 'card') setControls({ card: null })
          setDialog(null)
        },
      }}
    />
  )
}
