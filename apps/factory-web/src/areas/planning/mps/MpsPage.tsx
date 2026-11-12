'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { ProductionStrategy } from '@nexus/factory-domain/planning/strategy/rules'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { useLive } from '../../_shared/buying/hooks'
import { listPlanningSites, type PlanningSite } from '../board/api'
import { bulkStrategy, listStrategy, setStrategy, type StrategyItem, type StrategyQuery } from './api'
import { bulkBody, bulkLines, cellBody, controlsOf, mpsCan, PAGE, queryOf, readProblemOf, refusalOf, undoBody, withSaved, type CellMark, type MpsControls } from './model'
import type { BulkState, Loaded, MpsModel, MpsNotice, StrategyPage } from './view-model'
import { MPS_NAMESPACE, MpsView } from './view/MpsView'

/** How long a cell's "saved" mark stays (ms). */
const SAVED_MARK_MS = 2500
/** How long a live change of an item this page saved is taken as its own (ms). */
const MINE_MS = 15_000

/**
 * `/w/<company>/planning/mps` (SCR-202; Planning › Long range › Master schedule & S&OP, planning.view): the company's planning
 * sites (`?site=`, else the first), then the site's production strategy per item (GET /planning/strategy with `?q=` `?kind=`
 * `?strategy=` `?set=`, pages of 100). A cell's Listbox saves by itself (PUT, the every-colour row's version; a stale row is
 * refused in words and the item read again); Change strategy for N reads the ticked items again, then ONE bulk command, Undo =
 * the same call with each `from`. Writes need planning.strategy.manage. Live: another person's change waits behind "N updates".
 */
export function MpsPage() {
  return (
    <WithMessages namespaces={[MPS_NAMESPACE, 'lists']}>
      <MpsContainer />
    </WithMessages>
  )
}

function MpsContainer() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const params = useSearchParams()
  const query = params?.toString() ?? ''
  const controls = useMemo(() => controlsOf(new URLSearchParams(query)), [query])
  const prefix = pathname.replace(/\/planning\/mps\/?$/, '')
  const can = useMemo(() => mpsCan(session.permissions), [session.permissions])

  const [sites, setSites] = useState<Loaded<PlanningSite[]>>({ status: 'loading' })
  const [list, setList] = useState<Loaded<StrategyPage>>({ status: 'loading' })
  const [marks, setMarks] = useState<Record<string, CellMark>>({})
  const [bulk, setBulk] = useState<BulkState | null>(null)
  const [notice, setNotice] = useState<MpsNotice | null>(null)
  const [updates, setUpdates] = useState(0)
  const [dialog, setDialog] = useState<{ kind: 'keys' } | null>(null)
  const controlsRef = useRef(controls)
  controlsRef.current = controls
  const reads = useRef(0)
  // The items this page just saved (their live changes are on screen already), each until its time runs out.
  const mine = useRef(new Map<string, number>())
  const markMine = (ids: readonly string[]) => {
    const until = Date.now() + MINE_MS
    for (const id of ids) mine.current.set(id, until)
  }

  const site = sites.status === 'ready' ? (sites.value.find((entry) => entry.id === controls.site) ?? sites.value[0] ?? null) : null
  const siteId = site?.id ?? null
  const ask = useMemo<StrategyQuery | null>(
    () => (siteId ? { siteId, q: controls.q, kind: controls.kind, strategy: controls.strategy, set: controls.set === null ? null : controls.set === 'set' } : null),
    [siteId, controls.q, controls.kind, controls.strategy, controls.set],
  )

  const setControls = useCallback(
    (next: Partial<MpsControls>) => {
      const qs = queryOf({ ...controlsRef.current, ...next })
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
    },
    [router, pathname],
  )

  useEffect(() => {
    if (!can.view) return
    let gone = false
    listPlanningSites(api, session.company?.id ?? null)
      .then((value) => !gone && setSites({ status: 'ready', value }))
      .catch((error: unknown) => {
        if (gone) return
        const problem = readProblemOf(error)
        setSites({ status: 'error', problem })
        setList({ status: 'error', problem })
      })
    return () => {
      gone = true
    }
  }, [api, can.view, session.company?.id])

  const load = useCallback(async () => {
    if (!ask) return
    const id = ++reads.current
    try {
      const value = await listStrategy(api, { ...ask, limit: PAGE })
      if (id === reads.current) {
        setList({ status: 'ready', value: { items: value.items, nextCursor: value.nextCursor, more: 'idle', asOf: new Date().toISOString() } })
        setUpdates(0)
      }
    } catch (error) {
      if (id === reads.current) setList({ status: 'error', problem: readProblemOf(error) })
    }
  }, [api, ask])

  useEffect(() => {
    if (sites.status !== 'ready') return
    if (!siteId) {
      setList({ status: 'error', problem: 'error.noSite' })
      return
    }
    setList({ status: 'loading' })
    setMarks({})
    void load()
  }, [sites.status, siteId, load])

  const loadMore = useCallback(async () => {
    if (!ask || list.status !== 'ready' || !list.value.nextCursor || list.value.more === 'loading') return
    const id = reads.current
    const current = list.value
    setList({ status: 'ready', value: { ...current, more: 'loading' } })
    try {
      const value = await listStrategy(api, { ...ask, cursor: current.nextCursor, limit: PAGE })
      if (id === reads.current) setList({ status: 'ready', value: { ...current, items: [...current.items, ...value.items], nextCursor: value.nextCursor, more: 'idle' } })
    } catch {
      if (id === reads.current) setList({ status: 'ready', value: { ...current, more: 'failed' } })
    }
  }, [api, ask, list])

  const replace = useCallback((next: readonly StrategyItem[]) => {
    setList((current) => {
      if (current.status !== 'ready') return current
      const byId = new Map(next.map((item) => [item.item.id, item]))
      return { status: 'ready', value: { ...current.value, items: current.value.items.map((item) => byId.get(item.item.id) ?? item) } }
    })
  }, [])

  const reread = useCallback(
    async (ids: readonly string[]) => {
      if (!siteId || ids.length === 0) return
      try {
        const value = await listStrategy(api, { siteId, itemIds: ids, limit: Math.min(500, Math.max(1, ids.length)) })
        replace(value.items)
      } catch {
        // The list keeps what it shows; the refusal already said why.
      }
    },
    [api, siteId, replace],
  )

  const mark = useCallback((itemId: string, next: CellMark | null) => {
    setMarks((current) => {
      const copy = { ...current }
      if (next) copy[itemId] = next
      else delete copy[itemId]
      return copy
    })
  }, [])

  const saveCell = useCallback(
    async (itemId: string, strategy: ProductionStrategy) => {
      if (!siteId || list.status !== 'ready' || !can.manage) return
      const item = list.value.items.find((entry) => entry.item.id === itemId)
      if (!item) return
      mark(itemId, { state: 'saving' })
      try {
        markMine([itemId])
        const saved = await setStrategy(api, itemId, cellBody(item, siteId, strategy))
        replace([withSaved(item, saved, strategy)])
        mark(itemId, { state: 'saved' })
        setTimeout(() => setMarks((current) => (current[itemId]?.state === 'saved' ? Object.fromEntries(Object.entries(current).filter(([key]) => key !== itemId)) : current)), SAVED_MARK_MS)
      } catch (error) {
        mark(itemId, { state: 'refused', problem: refusalOf(error) })
        void reread([itemId])
      }
    },
    [api, siteId, list, can.manage, mark, replace, reread],
  )

  const openBulk = useCallback(
    async (ids: readonly string[], next?: ProductionStrategy, reason = '') => {
      if (!siteId || ids.length === 0) return
      const strategy = next ?? 'MAKE_TO_STOCK'
      setBulk({ ids, next: strategy, reason, phase: 'reading', items: [], answer: null, problem: null, undoing: false, undone: false })
      try {
        const value = await listStrategy(api, { siteId, itemIds: ids, limit: Math.min(500, ids.length) })
        replace(value.items)
        setBulk((current) => (current ? { ...current, phase: 'ready', items: value.items } : current))
      } catch (error) {
        setBulk((current) => (current ? { ...current, phase: 'failed', problem: readProblemOf(error) } : current))
      }
    },
    [api, siteId, replace],
  )

  const saveBulk = useCallback(async () => {
    if (!siteId || !bulk || bulk.phase !== 'ready') return
    const { changing } = bulkLines(bulk.items, bulk.next)
    if (changing.length === 0) return
    setBulk({ ...bulk, phase: 'saving', problem: null })
    try {
      markMine(changing.map((line) => line.item.item.id))
      const answer = await bulkStrategy(api, bulkBody(siteId, changing, bulk.reason))
      setBulk((current) => (current ? { ...current, phase: 'done', answer } : current))
      void reread(changing.map((line) => line.item.item.id))
    } catch (error) {
      setBulk((current) => (current ? { ...current, phase: 'ready', problem: refusalOf(error) } : current))
      void reread(bulk.ids)
    }
  }, [api, siteId, bulk, reread])

  const undoBulk = useCallback(async () => {
    if (!siteId || !bulk || bulk.phase !== 'done' || !bulk.answer) return
    const body = undoBody(siteId, bulk.answer)
    if (!body) return
    setBulk({ ...bulk, undoing: true })
    try {
      markMine(body.items.map((entry) => entry.itemId))
      await bulkStrategy(api, body)
      setBulk((current) => (current ? { ...current, undoing: false, undone: true } : current))
      void reread(body.items.map((entry) => entry.itemId))
    } catch (error) {
      setBulk((current) => (current ? { ...current, undoing: false } : current))
      setNotice({ tone: 'danger', key: refusalOf(error) })
    }
  }, [api, siteId, bulk, reread])

  const live = useLive(
    (change) => {
      if (change.type !== 'planning.item_parameters_changed') return
      if (change.fields.siteId !== undefined && change.fields.siteId !== siteId) return
      // Our own saves come back as changes too: those are on screen already.
      const itemId = typeof change.fields.itemId === 'string' ? change.fields.itemId : null
      const until = itemId ? mine.current.get(itemId) : undefined
      if (until !== undefined && until > Date.now()) return
      setUpdates((count) => count + 1)
    },
    () => void load(),
    can.view,
  )

  const model: MpsModel = { prefix, can, sites, siteId, controls, list, marks, bulk, notice, live, updates, dialog, timeZone: site?.timeZone ?? 'Europe/Rome' }

  return (
    <MpsView
      model={model}
      actions={{
        onSite: (next) => setControls({ site: next }),
        onFilter: (next) => setControls(next),
        onClearFilters: () => setControls({ q: '', kind: null, strategy: null, set: null }),
        onCell: (itemId, strategy) => void saveCell(itemId, strategy),
        onMore: () => void loadMore(),
        onRetry: () => void load(),
        onShowUpdates: () => void load(),
        onBulk: (ids) => void openBulk(ids),
        onBulkNext: (strategy) => setBulk((current) => (current && current.phase !== 'saving' && current.phase !== 'done' ? { ...current, next: strategy, problem: null } : current)),
        onBulkReason: (reason) => setBulk((current) => (current && current.phase !== 'saving' && current.phase !== 'done' ? { ...current, reason } : current)),
        onBulkSave: () => void saveBulk(),
        onBulkRetry: () => bulk && void openBulk(bulk.ids, bulk.next, bulk.reason),
        onBulkUndo: () => void undoBulk(),
        onBulkClose: () => {
          if (bulk?.phase === 'done' && bulk.answer) setNotice({ tone: 'success', key: bulk.undone ? 'notice.bulkUndone' : 'notice.bulkDone', params: { count: bulk.answer.changed } })
          setBulk(null)
        },
        onKeys: () => setDialog({ kind: 'keys' }),
        onCloseDialog: () => setDialog(null),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
