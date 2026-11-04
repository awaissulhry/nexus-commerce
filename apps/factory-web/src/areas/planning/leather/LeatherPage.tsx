'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { postNote } from '../../../record-panels/api'
import { downloadText, useCoalesced, useLive } from '../../_shared/buying/hooks'
import { listPlanningSites, type PlanningSite } from '../board/api'
import { draftFromPlan, runPlan } from '../mrp/api'
import { acceptLoss, dismissLoss, getNeed, getProtectors, getYield, reserveLeather, type LeatherNeed, type LeatherProtectors, type LeatherYield, type NeedRow } from './api'
import { askNote, controlsOf, csvOfNeed, leatherCan, NAMESPACE, queryOf, readProblemOf, reasonHeld, refusalOf, splitWords, visibleNeed, type LeatherControls, type ShadeOption, type Words } from './model'
import type { LeatherDialog, LeatherModel, LeatherNotice, Loaded } from './view-model'
import { LeatherView } from './view/LeatherView'

/**
 * `/w/<company>/planning/leather` (SCR-252; Planning › Leather & cut plan, planning.view): the company's planning sites
 * (`?site=`, else the first), then three reads of the site, each its own section: the leather need per order and the
 * certified protectors (from the latest plan run: its time is the band's "as of"), the yield per style (from the cut log).
 * The tiles are saved filters (`?tile=`), `?feas=` `?q=` filter the lists, `?open=` the order's shade drawer. Writes: the
 * cutting loss (accept, dismiss with a reason), the drawer's options on their own routes (reserve, Draft PO, a note to
 * Sales on the order), Run plan now. Live: a finished run waits behind "1 update · Show"; cuts, reservations and decisions
 * read the section again quietly.
 */
export function LeatherPage() {
  return (
    <WithMessages namespaces={[NAMESPACE, 'buying', 'lists']}>
      <LeatherContainer />
    </WithMessages>
  )
}

function LeatherContainer() {
  const t = useT(NAMESPACE)
  const units = useT('buying')
  const locale = useLocale()
  const words: Words = useMemo(() => ({ t, unit: (uom: string) => (uom ? units(`uom.${uom}`) : ''), locale }), [t, units, locale])
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const params = useSearchParams()
  const query = params?.toString() ?? ''
  const controls = useMemo(() => controlsOf(new URLSearchParams(query)), [query])
  const prefix = pathname.replace(/\/planning\/leather\/?$/, '')
  const can = useMemo(() => leatherCan(session.permissions), [session.permissions])
  const seesCost = session.permissions.includes('money.cost')

  const [sites, setSites] = useState<Loaded<PlanningSite[]>>({ status: 'loading' })
  const [need, setNeed] = useState<Loaded<LeatherNeed>>({ status: 'loading' })
  const [protectors, setProtectors] = useState<Loaded<LeatherProtectors>>({ status: 'loading' })
  const [yields, setYields] = useState<Loaded<LeatherYield>>({ status: 'loading' })
  const [updates, setUpdates] = useState(0)
  const [running, setRunning] = useState(false)
  const [acting, setActing] = useState<ShadeOption | null>(null)
  const [notice, setNotice] = useState<LeatherNotice | null>(null)
  const [drawerNotice, setDrawerNotice] = useState<LeatherNotice | null>(null)
  const [dialog, setDialog] = useState<LeatherDialog | null>(null)
  const controlsRef = useRef(controls)
  controlsRef.current = controls
  const reads = useRef({ need: 0, protectors: 0, yields: 0 })

  const site = sites.status === 'ready' ? (sites.value.find((entry) => entry.id === controls.site) ?? sites.value[0] ?? null) : null
  const siteId = site?.id ?? null
  const timeZone = site?.timeZone ?? 'Europe/Rome'

  const setControls = useCallback(
    (next: Partial<LeatherControls>) => {
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
        setNeed({ status: 'error', problem })
        setProtectors({ status: 'error', problem })
        setYields({ status: 'error', problem })
      })
    return () => {
      gone = true
    }
  }, [api, can.view, session.company?.id])

  const loadNeed = useCallback(async () => {
    if (!siteId) return
    const id = ++reads.current.need
    try {
      const value = await getNeed(api, siteId)
      if (id === reads.current.need) {
        setNeed({ status: 'ready', value })
        setUpdates(0)
      }
    } catch (error) {
      if (id === reads.current.need) setNeed({ status: 'error', problem: readProblemOf(error) })
    }
  }, [api, siteId])
  const loadProtectors = useCallback(async () => {
    if (!siteId) return
    const id = ++reads.current.protectors
    try {
      const value = await getProtectors(api, siteId)
      if (id === reads.current.protectors) setProtectors({ status: 'ready', value })
    } catch (error) {
      if (id === reads.current.protectors) setProtectors({ status: 'error', problem: readProblemOf(error) })
    }
  }, [api, siteId])
  const loadYield = useCallback(async () => {
    if (!siteId) return
    const id = ++reads.current.yields
    try {
      const value = await getYield(api, siteId)
      if (id === reads.current.yields) setYields({ status: 'ready', value })
    } catch (error) {
      if (id === reads.current.yields) setYields({ status: 'error', problem: readProblemOf(error) })
    }
  }, [api, siteId])
  const loadAll = useCallback(() => {
    void loadNeed()
    void loadProtectors()
    void loadYield()
  }, [loadNeed, loadProtectors, loadYield])

  useEffect(() => {
    if (sites.status !== 'ready') return
    if (!siteId) {
      setNeed({ status: 'error', problem: 'error.noSite' })
      setProtectors({ status: 'error', problem: 'error.noSite' })
      setYields({ status: 'error', problem: 'error.noSite' })
      return
    }
    setNeed({ status: 'loading' })
    setProtectors({ status: 'loading' })
    setYields({ status: 'loading' })
    loadAll()
  }, [sites.status, siteId, loadAll])

  // Live: a new run waits behind "1 update · Show"; cuts, decisions and reservations read their section again quietly.
  const rereadNeed = useCoalesced(() => void loadNeed(), 800)
  const rereadYield = useCoalesced(() => void loadYield(), 800)
  const live = useLive(
    (change) => {
      const own = change.fields.siteId === undefined || change.fields.siteId === siteId
      if (!own) return
      if (change.type === 'planning.run_finished') setUpdates((count) => count + 1)
      else if (change.type === 'production.cut_logged' || change.type === 'production.cut_reversed' || change.type === 'planning.cutting_loss_decided' || change.type === 'style.bom_changed') rereadYield()
      else if (change.type === 'inventory.reserved' || change.type === 'inventory.reservations_released' || change.type === 'inventory.moved') rereadNeed()
    },
    () => loadAll(),
    can.view,
  )

  const rowOf = (id: string): NeedRow | undefined => (need.status === 'ready' ? need.value.rows.find((row) => row.id === id) : undefined)

  const choose = useCallback(
    async (rowId: string, option: ShadeOption) => {
      const row = rowOf(rowId)
      if (!row || !siteId || acting) return
      setActing(option)
      setDrawerNotice(null)
      const demand = row.demand.workOrderId ? { workOrderId: row.demand.workOrderId } : { salesOrderLineId: row.demand.salesOrderLineId ?? row.orderLine.id }
      try {
        if (option === 'reserve' && row.proposal) {
          await reserveLeather(api, { siteId, ...demand, note: t('note.reserve', { lot: row.best?.lotCode ?? '—' }), lines: row.proposal.hideIds.map((hideId) => ({ hideId })) })
          setDrawerNotice({ tone: 'success', key: 'notice.reserved', params: { count: row.proposal.count, lot: row.best?.lotCode ?? '—' } })
        } else if (option === 'split' && row.split) {
          await reserveLeather(api, { siteId, ...demand, note: t('note.split', { split: splitWords(row, words) }), lines: row.split.map((part) => ({ lotId: part.lotId, quantity: part.area })) })
          setDrawerNotice({ tone: 'success', key: 'notice.split', params: { count: row.split.length } })
        } else if (option === 'buy') {
          const drafted = await draftFromPlan(api, { lines: [{ id: row.requirement.id, version: row.requirement.version }] })
          setDrawerNotice({ tone: 'success', key: 'notice.drafted', params: { orders: drafted.orders.map((order) => order.number).join(', ') } })
        } else if (option === 'ask') {
          await postNote(api, { type: 'SalesOrder', id: row.order.id }, { body: askNote(row, words), mentions: [], attachments: [] })
          setDrawerNotice({ tone: 'success', key: 'notice.asked', params: { order: row.order.number } })
        }
        rereadNeed()
      } catch (error) {
        setDrawerNotice({ tone: 'danger', key: refusalOf(error) })
        void loadNeed()
      } finally {
        setActing(null)
      }
    },
    // rowOf reads the need held in state.
    [api, siteId, acting, need, t, words, rereadNeed, loadNeed],
  )

  const yieldRowOf = (styleId: string) => (yields.status === 'ready' ? yields.value.rows.find((row) => row.style.id === styleId) : undefined)

  const accept = useCallback(async () => {
    if (dialog?.kind !== 'accept' || dialog.busy || !siteId) return
    const row = yieldRowOf(dialog.styleId)
    if (!row || !row.proposal.toPct) return
    setDialog({ ...dialog, busy: true, problem: null })
    try {
      const decided = await acceptLoss(api, row.style.id, { siteId, toPct: row.proposal.toPct, cuts: row.proposal.cuts, draftVersion: row.draft?.version ?? null })
      setDialog(null)
      setNotice(decided.carriedIn ? { tone: 'success', key: 'notice.acceptedIn', params: { style: row.style.code, revision: decided.carriedIn.revision } } : { tone: 'success', key: 'notice.acceptedRecorded', params: { style: row.style.code } })
      void loadYield()
    } catch (error) {
      setDialog({ ...dialog, busy: false, problem: refusalOf(error) })
      void loadYield()
    }
  }, [api, dialog, siteId, yields, loadYield])

  const dismiss = useCallback(async () => {
    if (dialog?.kind !== 'dismiss' || dialog.busy || !siteId) return
    const row = yieldRowOf(dialog.styleId)
    if (!row || !row.proposal.toPct) return
    const held = reasonHeld(dialog.reason)
    if (held) {
      setDialog({ ...dialog, problem: held })
      return
    }
    setDialog({ ...dialog, busy: true, problem: null })
    try {
      await dismissLoss(api, row.style.id, { siteId, toPct: row.proposal.toPct, cuts: row.proposal.cuts, reason: dialog.reason.trim() })
      setDialog(null)
      setNotice({ tone: 'success', key: 'notice.dismissed', params: { style: row.style.code } })
      void loadYield()
    } catch (error) {
      setDialog({ ...dialog, busy: false, problem: refusalOf(error) })
      void loadYield()
    }
  }, [api, dialog, siteId, yields, loadYield])

  const run = useCallback(async () => {
    if (!siteId || running) return
    setRunning(true)
    setNotice(null)
    try {
      await runPlan(api, siteId)
      setNotice({ tone: 'success', key: 'notice.ran' })
      void loadNeed()
      void loadProtectors()
    } catch (error) {
      setNotice({ tone: 'danger', key: refusalOf(error) === 'refusal.changed' ? 'notice.runBusy' : refusalOf(error) })
    } finally {
      setRunning(false)
    }
  }, [api, siteId, running, loadNeed, loadProtectors])

  const model: LeatherModel = { prefix, can, seesCost, sites, siteId, controls, need, protectors, yields, live, updates, running, acting, notice, dialog, timeZone, drawerNotice }

  return (
    <LeatherView
      model={model}
      actions={{
        onSite: (next) => setControls({ site: next, open: null }),
        onTile: (tile) => setControls({ tile, open: null }),
        onFeasibility: (feas) => setControls({ feas }),
        onSearch: (q) => setControls({ q }),
        onRetry: (section) => void (section === 'need' ? loadNeed() : section === 'protectors' ? loadProtectors() : loadYield()),
        onShowUpdates: () => loadAll(),
        onRun: () => void run(),
        onOpen: (rowId) => {
          setDrawerNotice(null)
          setControls({ open: rowId })
        },
        onChoose: (rowId, option) => void choose(rowId, option),
        onDraftPo: (rowId) => void choose(rowId, 'buy'),
        onAccept: (styleId) => setDialog({ kind: 'accept', styleId, busy: false, problem: null }),
        onAcceptConfirm: () => void accept(),
        onDismiss: (styleId) => setDialog({ kind: 'dismiss', styleId, reason: '', busy: false, problem: null }),
        onDismissReason: (reason) => setDialog((current) => (current?.kind === 'dismiss' ? { ...current, reason, problem: null } : current)),
        onDismissConfirm: () => void dismiss(),
        onPrint: () => {
          const qs = queryOf({ ...controlsRef.current, open: null, site: siteId })
          window.open(`${prefix}/planning/leather/print${qs ? `?${qs}` : ''}`, '_blank', 'noopener')
        },
        onExport: (ids) => {
          const rows = need.status === 'ready' ? visibleNeed(need.value.rows, controlsRef.current).filter((row) => ids.length === 0 || ids.includes(row.id)) : []
          downloadText(`leather-need-${new Date().toISOString().slice(0, 10)}.csv`, csvOfNeed(rows, words))
        },
        onKeys: () => setDialog({ kind: 'keys' }),
        onCloseDialog: () => setDialog(null),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
