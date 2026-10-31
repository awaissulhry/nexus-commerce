'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../lib/api/errors'
import { useT } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { findSuppliers, listSites, type SiteOption } from '../../_shared/buying/api'
import { downloadText, useCoalesced, useLive } from '../../_shared/buying/hooks'
import { DEFAULT_TIME_ZONE } from '../../../lib/i18n/format'
import { buyingCan, csvOf, phrase, readProblem, todayIn, writeProblem, type Loaded } from '../../_shared/buying/model'
import { draftFromPlan, explainLine, firmLine, getLatestPlan, getShortages, listRuns, openDrafts, reopen, runPlan, sendChecks, sendMany, setAside, undoDraft, unusableStock, type Explain, type Plan, type PlanLine, type Shortages, type StockLine } from './api'
import { draftable, moveFirmProblem, MRP_NAMESPACE, sendable, viewOf, type DraftDialog, type PlanDialog, type PlanModel, type PlanNotice, type PlanView as PlanViewName } from './model'
import { PlanView } from './view/PlanView'

/**
 * `/w/<company>/planning/mrp` (SCR-055): the company's sites (`?site=`, else the first), the site's latest plan with its
 * tiles and every line, the stock it may not use (when lines are short although stock exists), the view (`?view=`) and
 * search (`?q=`) in the address, the Why drawer (`?line=`). Live: planning.* and purchase_order.* events read the plan
 * again (a newer run waits behind "1 update · Show"). Writes, one at a time: run the plan, Draft PO for one line or many
 * (purchasing's from-plan; Undo), set aside and put back (each line with the version the plan was read at).
 */
export function PlanPage() {
  return (
    <WithMessages namespaces={['buying', MRP_NAMESPACE, 'lists']}>
      <PlanContainer />
    </WithMessages>
  )
}

function PlanContainer() {
  const t = useT('buying')
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/planning\/mrp\/?$/, '')
  const can = useMemo(() => buyingCan(session.permissions), [session.permissions])
  const view = viewOf(params?.get('view'))
  const q = params?.get('q') ?? ''
  const siteParam = params?.get('site') ?? null
  const lineParam = params?.get('line') ?? null

  const [sites, setSites] = useState<Loaded<SiteOption[]>>({ status: 'loading' })
  const [plan, setPlan] = useState<Loaded<Plan>>({ status: 'loading' })
  const [held, setHeld] = useState<StockLine[] | null>(null)
  const [updates, setUpdates] = useState(0)
  const [running, setRunning] = useState(false)
  const [drafting, setDrafting] = useState<string[]>([])
  const [notice, setNotice] = useState<PlanNotice | null>(null)
  const [dialog, setDialog] = useState<PlanDialog | null>(null)
  const [explain, setExplain] = useState<{ lineId: string; explain: Loaded<Explain> } | null>(null)
  const [shortages, setShortages] = useState<Loaded<Shortages> | null>(null)
  const today = useMemo(() => todayIn(DEFAULT_TIME_ZONE), [])
  const canFirm = session.permissions.includes('planning.firm')
  const readId = useRef(0)
  const planRef = useRef<Plan | null>(null)

  const siteId = sites.status === 'ready' ? (sites.value.find((site) => site.id === siteParam)?.id ?? sites.value[0]?.id ?? null) : null

  const address = useCallback(
    (next: { view?: PlanViewName; q?: string; site?: string | null; line?: string | null }) => {
      const query = new URLSearchParams()
      const nextSite = next.site === undefined ? siteParam : next.site
      const nextView = next.view ?? view
      const nextQ = next.q ?? q
      const nextLine = next.line === undefined ? lineParam : next.line
      if (nextSite) query.set('site', nextSite)
      if (nextView !== 'open') query.set('view', nextView)
      if (nextQ.trim()) query.set('q', nextQ.trim())
      if (nextLine) query.set('line', nextLine)
      const qs = query.toString()
      return `${pathname}${qs ? `?${qs}` : ''}`
    },
    [pathname, siteParam, view, q, lineParam],
  )

  const loadSites = useCallback(async () => {
    if (!can.planView) return
    setSites({ status: 'loading' })
    try {
      setSites({ status: 'ready', value: await listSites(api, session.company?.id ?? null) })
    } catch (error) {
      setSites({ status: 'error', problem: readProblem(error) })
      setPlan({ status: 'error', problem: readProblem(error) })
    }
  }, [api, can.planView, session.company?.id])

  useEffect(() => {
    void loadSites()
  }, [loadSites])

  const load = useCallback(async () => {
    if (!siteId) {
      if (sites.status === 'ready') setPlan({ status: 'error', problem: 'plan.noSite' })
      return
    }
    const id = ++readId.current
    try {
      const value = await getLatestPlan(api, siteId)
      if (id !== readId.current) return
      planRef.current = value
      setPlan({ status: 'ready', value })
      setUpdates(0)
      // B-W2a-70: the work orders short of material, computed now from the live plan (the section and its tile).
      getShortages(api, siteId)
        .then((answer) => id === readId.current && setShortages({ status: 'ready', value: answer }))
        .catch((error: unknown) => id === readId.current && setShortages({ status: 'error', problem: readProblem(error) }))
      if (value.summary.shortWithHeldStock > 0) {
        unusableStock(api, siteId)
          .then((lines) => id === readId.current && setHeld(lines))
          .catch(() => id === readId.current && setHeld(null))
      } else setHeld([])
    } catch (error) {
      if (id !== readId.current) return
      setPlan({ status: 'error', problem: isApiError(error) && error.kind === 'forbidden' ? 'problem.forbidden' : readProblem(error) })
    }
  }, [api, siteId, sites.status])

  useEffect(() => {
    if (sites.status !== 'ready') return
    setPlan({ status: 'loading' })
    void load()
  }, [load, sites.status])

  // Live: a run of this site finished (the plan shown changes under the person: "1 update · Show"); a decision or an
  // order moved (read again quietly: rows never move under the cursor, only their words change).
  const reread = useCoalesced(() => void load(), 800)
  const live = useLive(
    (change) => {
      const own = change.fields.siteId === undefined || change.fields.siteId === siteId
      if (change.type === 'planning.run_finished' && own) setUpdates((count) => count + 1)
      else if ((change.type.startsWith('planning.') && own) || change.type.startsWith('purchase_order.')) reread()
    },
    () => void load(),
    can.planView,
  )

  // The Why drawer: `?line=` reads the line's explanation.
  useEffect(() => {
    if (!lineParam) {
      setExplain(null)
      return
    }
    let gone = false
    setExplain({ lineId: lineParam, explain: { status: 'loading' } })
    explainLine(api, lineParam)
      .then((value) => !gone && setExplain({ lineId: lineParam, explain: { status: 'ready', value } }))
      .catch((error: unknown) => !gone && setExplain({ lineId: lineParam, explain: isApiError(error) && error.kind === 'not_found' ? { status: 'not_found' } : { status: 'error', problem: readProblem(error) } }))
    return () => {
      gone = true
    }
  }, [api, lineParam])

  const linesById = (ids: readonly string[]): PlanLine[] => (planRef.current?.lines ?? []).filter((line) => ids.includes(line.id))

  const run = useCallback(async () => {
    if (!siteId || running) return
    setRunning(true)
    setNotice(null)
    try {
      await runPlan(api, siteId)
      await load()
      setNotice({ tone: 'success', words: phrase('plan.notice.ran') })
    } catch (error) {
      setNotice({ tone: 'danger', words: writeProblem(error, (_paths, info) => (info.kind === 'conflict' ? phrase('plan.notice.runBusy') : null)) })
      void load()
    } finally {
      setRunning(false)
    }
  }, [api, siteId, running, load])

  /** One line, one click: into the supplier's open draft (or a new one); the notice says which and offers Undo. */
  const draftOne = useCallback(
    async (lineId: string) => {
      const line = linesById([lineId])[0]
      if (!line || drafting.includes(lineId)) return
      if (!line.supplier) {
        // No supplier on record: the dialog asks for one.
        void openDraftDialog([lineId])
        return
      }
      setDrafting((current) => [...current, lineId])
      setNotice(null)
      try {
        const answer = await draftFromPlan(api, { lines: [{ id: line.id, version: line.version }] })
        const order = answer.orders[0]
        await load()
        if (order) {
          setNotice({
            tone: 'success',
            words: phrase(order.created ? 'plan.notice.draftedNew' : 'plan.notice.draftedInto', { number: order.number, count: order.lineCount }),
            open: { href: `${prefix}/purchasing/orders/${order.id}`, label: t('plan.notice.openOrder', { number: order.number }) },
            undo: { kind: 'draft', purchaseOrderLineIds: answer.lines.map((entry) => entry.purchaseOrderLineId), cancelOrderIds: answer.orders.filter((entry) => entry.created).map((entry) => entry.id) },
          })
        }
      } catch (error) {
        setNotice({ tone: 'danger', words: draftProblem(error) })
        void load()
      } finally {
        setDrafting((current) => current.filter((id) => id !== lineId))
      }
    },
    // linesById reads the ref: no dependency on the plan.
    [api, drafting, load, prefix, t],
  )

  const openDraftDialog = useCallback(
    async (lineIds: string[]) => {
      if (!siteId) return
      const lines = draftable(linesById(lineIds))
      const base: DraftDialog = { lines, drafts: null, draftsProblem: null, into: {}, suppliers: {}, supplierQuery: '', supplierOptions: null, busy: false, problem: null, result: null }
      setDialog({ kind: 'draft', draft: base })
      const needsSupplier = lines.some((line) => !line.supplier)
      if (needsSupplier && can.parties) {
        findSuppliers(api, '')
          .then((options) => setDialog((current) => (current?.kind === 'draft' ? { kind: 'draft', draft: { ...current.draft, supplierOptions: options } } : current)))
          .catch(() => setDialog((current) => (current?.kind === 'draft' ? { kind: 'draft', draft: { ...current.draft, supplierOptions: [] } } : current)))
      }
      try {
        const drafts = await openDrafts(api, siteId)
        setDialog((current) => (current?.kind === 'draft' ? { kind: 'draft', draft: { ...current.draft, drafts } } : current))
      } catch (error) {
        setDialog((current) => (current?.kind === 'draft' ? { kind: 'draft', draft: { ...current.draft, drafts: [], draftsProblem: readProblem(error) } } : current))
      }
    },
    [api, siteId, can.parties],
  )

  const createDrafts = useCallback(async () => {
    if (dialog?.kind !== 'draft' || dialog.draft.busy) return
    const draft = dialog.draft
    setDialog({ kind: 'draft', draft: { ...draft, busy: true, problem: null } })
    const into = Object.entries(draft.into).map(([supplierId, purchaseOrderId]) => ({ supplierId, purchaseOrderId }))
    try {
      const answer = await draftFromPlan(api, {
        lines: draft.lines.map((line) => ({ id: line.id, version: line.version, ...(!line.supplier && draft.suppliers[line.id] ? { supplierId: draft.suppliers[line.id]!.id } : {}) })),
        ...(into.length > 0 ? { into } : {}),
      })
      setDialog({ kind: 'draft', draft: { ...draft, busy: false, result: answer } })
      setNotice({
        tone: 'success',
        words: phrase('plan.notice.draftedMany', { lines: answer.lines.length, count: answer.orders.length }),
        undo: { kind: 'draft', purchaseOrderLineIds: answer.lines.map((entry) => entry.purchaseOrderLineId), cancelOrderIds: answer.orders.filter((entry) => entry.created).map((entry) => entry.id) },
      })
      void load()
    } catch (error) {
      setDialog({ kind: 'draft', draft: { ...draft, busy: false, problem: draftProblem(error) } })
      void load()
    }
  }, [api, dialog, load])

  const confirmSetAside = useCallback(async () => {
    if (dialog?.kind !== 'setAside' || dialog.busy || !dialog.reason) return
    const lines = linesById(dialog.lineIds).filter((line) => line.decision === 'OPEN')
    setDialog({ ...dialog, busy: true, problem: null })
    try {
      const answer = await setAside(
        api,
        lines.map((line) => ({ id: line.id, version: line.version })),
        dialog.reason,
        dialog.note,
      )
      setDialog(null)
      setNotice({ tone: 'success', words: phrase('plan.notice.setAside', { count: answer.lines.length }), undo: { kind: 'setAside', lines: answer.lines } })
      void load()
    } catch (error) {
      setDialog({ ...dialog, busy: false, problem: writeProblem(error, (_paths, info) => (info.kind === 'conflict' ? phrase('plan.notice.planChanged') : null)) })
      void load()
    }
  }, [api, dialog, load])

  const putBack = useCallback(
    async (ids: string[], undo = false) => {
      const lines = undo ? ids : linesById(ids).filter((line) => line.decision === 'IGNORED').map((line) => line.id)
      const refs = (planRef.current?.lines ?? []).filter((line) => lines.includes(line.id)).map((line) => ({ id: line.id, version: line.version }))
      if (refs.length === 0) return
      setNotice(null)
      try {
        const answer = await reopen(api, refs)
        setNotice({ tone: 'success', words: phrase('plan.notice.putBack', { count: answer.lines.length }) })
        void load()
      } catch (error) {
        setNotice({ tone: 'danger', words: writeProblem(error, (_paths, info) => (info.kind === 'conflict' ? phrase('plan.notice.planChanged') : null)) })
        void load()
      }
    },
    [api, load],
  )

  const undo = useCallback(async () => {
    const what = notice?.undo
    if (!what) return
    setNotice(null)
    try {
      if (what.kind === 'draft') {
        await undoDraft(api, what.purchaseOrderLineIds, what.cancelOrderIds)
        setNotice({ tone: 'info', words: phrase('plan.notice.undoneDraft') })
      } else {
        await reopen(api, what.lines)
        setNotice({ tone: 'info', words: phrase('plan.notice.undoneAside', { count: what.lines.length }) })
      }
    } catch (error) {
      setNotice({ tone: 'danger', words: writeProblem(error, (_paths, info) => (info.kind === 'conflict' ? phrase('plan.notice.undoTooLate') : null)) })
    }
    void load()
  }, [api, notice, load])

  /** B-W2a-70 (MOVE_FIRM): the firm planned order again with its quantity, on an earlier day. */
  const moveFirm = useCallback(async () => {
    if (dialog?.kind !== 'moveFirm' || dialog.busy) return
    const line = linesById([dialog.requirementId])[0] ?? null
    const problem = moveFirmProblem(line, dialog.date, today)
    if (problem || !line?.firm) {
      setDialog({ ...dialog, problem: problem ?? 'held.notFirm' })
      return
    }
    setDialog({ ...dialog, busy: true, problem: null })
    try {
      await firmLine(api, line.id, { version: line.version, quantity: line.firm.quantity, date: dialog.date, ...(line.firm.supplier ? { supplierId: line.firm.supplier.id } : {}) })
      setDialog(null)
      setNotice({ tone: 'success', words: phrase('mrp:notice.moved', { material: line.item.code, date: dialog.date }) })
      void load()
    } catch (error) {
      setDialog({ ...dialog, busy: false, problem: isApiError(error) && error.kind === 'conflict' ? 'move.changed' : isApiError(error) && error.kind === 'invalid' ? 'move.refused' : 'move.failed' })
      void load()
    }
  }, [api, dialog, load, today])

  /** B-W2a-70 (Send n): the drafts just made, each with its checks, then each sent on its own. */
  const sendStep = useCallback(async () => {
    if (dialog?.kind !== 'draft' || !dialog.draft.result) return
    const draft = dialog.draft
    const ids = draft.result!.orders.map((order) => order.id)
    setDialog({ kind: 'draft', draft: { ...draft, send: { cards: null, problem: null, busy: false, outcomes: null } } })
    try {
      const cards = await sendChecks(api, ids)
      setDialog((current) => (current?.kind === 'draft' ? { kind: 'draft', draft: { ...current.draft, send: { cards, problem: null, busy: false, outcomes: null } } } : current))
    } catch (error) {
      setDialog((current) => (current?.kind === 'draft' ? { kind: 'draft', draft: { ...current.draft, send: { cards: [], problem: readProblem(error), busy: false, outcomes: null } } } : current))
    }
  }, [api, dialog])

  const sendConfirm = useCallback(async () => {
    if (dialog?.kind !== 'draft' || !dialog.draft.send || dialog.draft.send.busy) return
    const draft = dialog.draft
    const send = draft.send!
    const orders = sendable(send.cards)
    if (orders.length === 0) return
    setDialog({ kind: 'draft', draft: { ...draft, send: { ...send, busy: true, problem: null } } })
    try {
      const outcomes = await sendMany(api, orders)
      setDialog((current) => (current?.kind === 'draft' ? { kind: 'draft', draft: { ...current.draft, send: { ...send, busy: false, outcomes } } } : current))
      setNotice({ tone: 'success', words: phrase('mrp:notice.sent', { count: outcomes.filter((outcome) => outcome.outcome === 'SENT').length }) })
      void load()
    } catch (error) {
      setDialog((current) => (current?.kind === 'draft' ? { kind: 'draft', draft: { ...current.draft, send: { ...send, busy: false, problem: readProblem(error) } } } : current))
    }
  }, [api, dialog, load])

  const exportLines = useCallback(
    (ids: string[]) => {
      const picked = linesById(ids)
      const header = ['material', 'name', 'colour', 'action', 'need', 'usable', 'onOrder', 'short', 'unit', 'buy', 'buyUnit', 'hides', 'needDate', 'orderBy', 'supplier', ...(can.cost ? ['value', 'currency'] : []), 'orders', 'decision'].map((column) => t(`plan.csv.${column}`))
      const rows = picked.map((line) => [
        line.item.code,
        line.item.name,
        line.colour?.code ?? '',
        t(`plan.action.${line.action}`),
        line.grossQuantity,
        line.usableStock,
        line.onOrder,
        line.netQuantity,
        line.uom,
        line.suggestedQuantity,
        line.suggestedUom,
        line.estimatedHides ?? '',
        line.needDate,
        line.orderBy?.date ?? '',
        line.supplier?.name ?? '',
        ...(can.cost ? [line.expectedAmount === null || line.expectedAmount === undefined ? '' : (line.expectedAmount / 100).toFixed(2), line.currency] : []),
        line.orders.map((order) => order.number).join(' '),
        line.decision,
      ])
      downloadText(`what-to-buy-${new Date().toISOString().slice(0, 10)}.csv`, csvOf(header, rows))
    },
    [can.cost, t],
  )

  const model: PlanModel = {
    prefix,
    can,
    sites,
    siteId,
    plan,
    view,
    q,
    held,
    live,
    updates,
    running,
    drafting,
    notice,
    dialog,
    why: explain,
    shortages,
    today,
    canFirm,
  }

  return (
    <PlanView
      model={model}
      actions={{
        onSite: (next) => router.replace(address({ site: next, line: null })),
        onView: (next) => router.replace(address({ view: next })),
        onSearch: (next) => router.replace(address({ q: next })),
        onRetry: () => (sites.status === 'error' ? void loadSites() : void load()),
        onShowUpdates: () => void load(),
        onRun: () => void run(),
        onDraftOne: (lineId) => void draftOne(lineId),
        onDraftMany: (lineIds) => void openDraftDialog(lineIds),
        onSetAside: (lineIds) => setDialog({ kind: 'setAside', lineIds, reason: '', note: '', busy: false, problem: null }),
        onReopen: (lineIds) => void putBack(lineIds),
        onExport: exportLines,
        onWhy: (lineId) => router.replace(address({ line: lineId })),
        onHistory: () => {
          setDialog({ kind: 'history', runs: null, problem: null })
          if (!siteId) return
          listRuns(api, siteId)
            .then((runs) => setDialog((current) => (current?.kind === 'history' ? { ...current, runs } : current)))
            .catch((error: unknown) => setDialog((current) => (current?.kind === 'history' ? { ...current, problem: readProblem(error) } : current)))
        },
        onExplainer: () => setDialog({ kind: 'explainer' }),
        onKeys: () => setDialog({ kind: 'keys' }),
        onCloseDialog: () => setDialog(null),
        onUndo: () => void undo(),
        onDismissNotice: () => setNotice(null),
        draft: {
          onInto: (supplierId, purchaseOrderId) => setDialog((current) => (current?.kind === 'draft' ? { kind: 'draft', draft: { ...current.draft, into: { ...current.draft.into, [supplierId]: purchaseOrderId } } } : current)),
          onSupplierQuery: (text) => {
            setDialog((current) => (current?.kind === 'draft' ? { kind: 'draft', draft: { ...current.draft, supplierQuery: text } } : current))
            findSuppliers(api, text)
              .then((options) => setDialog((current) => (current?.kind === 'draft' && current.draft.supplierQuery === text ? { kind: 'draft', draft: { ...current.draft, supplierOptions: options } } : current)))
              .catch(() => undefined)
          },
          onPickSupplier: (lineId, supplier) =>
            setDialog((current) => {
              if (current?.kind !== 'draft') return current
              const suppliers = { ...current.draft.suppliers }
              if (supplier) suppliers[lineId] = supplier
              else delete suppliers[lineId]
              return { kind: 'draft', draft: { ...current.draft, suppliers } }
            }),
          onCreate: () => void createDrafts(),
        },
        onRetryShortages: () => {
          if (!siteId) return
          setShortages({ status: 'loading' })
          getShortages(api, siteId)
            .then((answer) => setShortages({ status: 'ready', value: answer }))
            .catch((error: unknown) => setShortages({ status: 'error', problem: readProblem(error) }))
        },
        onMoveFirm: (requirementId) => {
          const line = linesById([requirementId])[0]
          setDialog({ kind: 'moveFirm', requirementId, date: line?.firm?.date ?? today, busy: false, problem: null })
        },
        moveFirm: {
          onDate: (date) => setDialog((current) => (current?.kind === 'moveFirm' ? { ...current, date, problem: null } : current)),
          onConfirm: () => void moveFirm(),
        },
        onSendDrafts: () => void sendStep(),
        onSendConfirm: () => void sendConfirm(),
        setAside: {
          onReason: (reason) => setDialog((current) => (current?.kind === 'setAside' ? { ...current, reason } : current)),
          onNote: (note) => setDialog((current) => (current?.kind === 'setAside' ? { ...current, note } : current)),
          onConfirm: () => void confirmSetAside(),
        },
      }}
    />
  )
}

/**
 * A refused Draft PO in words: a blocked supplier, a line a newer plan replaced, a changed line, a line with no supplier,
 * else by kind. The API answers these as plain 409s without a path, so its message is read to pick the words (never drawn).
 */
function draftProblem(error: unknown) {
  const message = isApiError(error) ? error.message : ''
  return writeProblem(error, (paths, info) => {
    if (info.kind === 'conflict' && /blocked|archived/i.test(message)) return phrase('plan.notice.supplierBlocked')
    if (info.kind === 'conflict' && /newer plan|superseded/i.test(message)) return phrase('plan.notice.planChanged')
    if (info.kind === 'conflict') return phrase('plan.notice.lineChanged')
    if (info.kind === 'invalid' && paths.some((path) => path.includes('supplierId'))) return phrase('plan.notice.needsSupplier')
    return null
  })
}
