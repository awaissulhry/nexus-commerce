'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { toggleGroup } from '../../../list-frame/groups/model'
import { WithMessages } from '../../../record-panels/i18n'
import { usePortalApi, usePortalBand, usePortalFrame, usePortalLive } from '../../shell/frame'
import { saveBytes, useOffline } from '../orders/hooks'
import { NS as ORDERS_NS } from '../orders/model'
import { Closed } from '../orders/OrdersPage'
import { downloadProduction, fetchProduction, markUrgency, saveUrgentOrder, undoUrgency, type BrandUrgencyCode, type ProductionChip, type ProductionList, type ProductionRow } from './api'
import { chipOf, keepMine, listQuery, markedNotice, markRefusal, NS, orderChanged, orderHeld, orderRefusal, rowHref, rowName, toTop, undoneNotice, undoRefusal, urgentRowsOf, type Notice } from './model'
import { useProductionPageWords } from './words'
import { ProductionListView } from './view/ProductionListView'
import type { UrgentOrderDialogModel } from './view/UrgentOrderDialog'
// ---- F-PR-24: "Report a problem" on a row (the same dialog as the order page's)
import { useReportProblem } from './problem/useReportProblem'
// ---- end F-PR-24
// ---- F-PR-23a: the bulk bar (its container) and the Undo of what a single mark asked of us
import { withdrawAskBatch } from './bulk/api'
import { useBulk } from './bulk/useBulk'
import { undoLineOf, undoProblemOf } from './bulk/model'
// ---- end F-PR-23a
// ---- F-PR-23b: Approve N (its dialog's words) and Ask N (the order page's words for verdicts and impact)
import { useT } from '../../../lib/i18n/provider'
import { WAITING_NS } from '../waiting/view/BulkApproveDialog'
// ---- end F-PR-23b

/**
 * F-PR-11 — `/p/<party>/production` for a customer: My production (production plan §5; 06-tree B.1; 17-web-r2 §1.4). Reads GET
 * /portal/production with the chip and search of the address (every own row: no page, no cut), fills the band (Updated, Urgent
 * order, Export), tells of changes on the live channel without moving the rows ("N updates · Show"), and acts on the customer's
 * own urgency (B-PR-22a): Mark urgent / Mark regular on a row (one command, with Undo), the Urgent order dialog (its whole urgent
 * list with the time it was read: a change since is said "Changed by us at 10:42", never a name), Undo of its own batch. Export is
 * the server's file of the same rows (`?format=csv`, its own scope, the person's language). Every write carries an
 * Idempotency-Key kept while the same thing is sent again.
 */
export function CustomerProductionPage() {
  return (
    <WithMessages namespaces={[NS, ORDERS_NS, WAITING_NS, 'ds-words', 'lists', 'shell']}>
      <Suspense fallback={null}>
        <ProductionRoute />
      </Suspense>
    </WithMessages>
  )
}

function ProductionRoute() {
  const frame = usePortalFrame()
  const { t } = useProductionPageWords()
  const allowed = frame.kinds.includes('CUSTOMER') && frame.me.permissions.includes('portal.production.view')
  if (!allowed) return <Closed title={t('list.title')} />
  return <ProductionContainer />
}

type DialogState = { items: string[]; busy: boolean; problem: UrgentOrderDialogModel['problem'] } | null

function ProductionContainer() {
  const frame = usePortalFrame()
  const api = usePortalApi()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const search = useSearchParams()
  const { t, locale, time, day, money } = useProductionPageWords()
  const tOrders = useT(ORDERS_NS) // F-PR-23b
  const offline = useOffline()
  const chip = chipOf(search?.get('chip'))
  const q = search?.get('q') ?? ''
  const preview = frame.me.preview
  const mayMark = frame.me.permissions.includes('portal.production.urgency')
  const mayAsk = frame.me.permissions.includes('portal.salesOrders.ask') // F-PR-23a/b

  const [read, setRead] = useState<ProductionList | null>(null)
  const [state, setState] = useState<'loading' | 'error' | 'ready' | 'forbidden'>('loading')
  const [updates, setUpdates] = useState(0)
  const [loadedAt, setLoadedAt] = useState<string | null>(null)
  const [busy, setBusy] = useState<string[]>([])
  const [undoing, setUndoing] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [collapsed, setCollapsed] = useState<string[]>([])
  const [dialog, setDialog] = useState<DialogState>(null)
  const [exporting, setExporting] = useState(false)
  const [exportFailed, setExportFailed] = useState(false)
  const reading = useRef<AbortController | null>(null)
  // One key per thing sent: a retry of the same mark (a lost answer) is the same request, a new mark a new one.
  const writeKey = useRef<{ body: string; key: string } | null>(null)
  const keyFor = (body: unknown) => {
    const text = JSON.stringify(body)
    if (writeKey.current?.body !== text) writeKey.current = { body: text, key: newIdempotencyKey() }
    return writeKey.current.key
  }

  const load = useCallback(async (): Promise<ProductionList | null> => {
    reading.current?.abort()
    const control = new AbortController()
    reading.current = control
    try {
      const next = await fetchProduction(api, { chip, q }, control.signal)
      if (control.signal.aborted) return null
      setRead(next)
      setLoadedAt(next.asOf)
      setState('ready')
      setUpdates(0)
      return next
    } catch (error) {
      if (control.signal.aborted) return null
      setState(isApiError(error) && error.kind === 'forbidden' ? 'forbidden' : 'error')
      return null
    }
  }, [api, chip, q])

  useEffect(() => {
    setState((current) => (current === 'ready' ? current : 'loading'))
    void load()
    return () => reading.current?.abort()
  }, [load])

  usePortalLive({
    onChange: (change) => {
      if (read?.live.events.includes(change.type)) setUpdates((count) => count + 1)
    },
    onReconnect: () => setUpdates((count) => count + 1),
  })

  const rowsNow = read?.items ?? []
  const urgent = urgentRowsOf(rowsNow)
  const writeHeld = preview ? t('held.preview') : offline ? t('held.offline') : null

  // ---- F-PR-24: Report a problem — offered to a person who writes in its orders' conversations (portal.comment); after it the list
  // reads again (the row's chip says "Waiting on us since …").
  const problemWords = useProductionPageWords()
  const mayReport = frame.me.permissions.includes('portal.comment')
  const problemDialog = useReportProblem({
    api,
    locale,
    t: problemWords.t,
    writers: problemWords,
    facts: { preview, offline, mayWrite: mayReport, seesFiles: frame.me.permissions.includes('portal.customerDocuments.view'), seesMessages: frame.me.permissions.includes('threads.read') },
    onSent: () => void load(),
  })
  // ---- end F-PR-24

  // ---- F-PR-23a: the bulk bar — the picked rows, the review before Send, the result per row, Undo; More ▾ (Report a problem with
  // the orders named in THE F-PR-24 dialog, Download files, Export of the picked rows).
  const bulk = useBulk({
    api,
    read,
    locale,
    t,
    facts: {
      urgencyOn: read?.urgencyOn === true,
      mayMark,
      mayAsk,
      mayReport,
      mayFiles: frame.me.permissions.includes('portal.customerDocuments.view'),
      preview,
      offline,
      // F-PR-23b
      mayApprove: frame.me.permissions.includes('portal.approvals.view'),
      mayAnswer: frame.me.permissions.includes('portal.approve'),
    },
    onChanged: () => void load(),
    onNotice: setNotice,
    onReport: (orders) => problemDialog.open(orders),
    // F-PR-23b
    prefix: frame.prefix,
    tOrders,
    day,
    money: (minor, currency) => money(minor, currency),
  })
  /** Undo of what a single mark asked of us ("Urgent – asked"): the batch's waiting request withdrawn. */
  const undoAsks = async (batchId: string) => {
    if (undoing || writeHeld) return
    setUndoing(true)
    try {
      const answer = await withdrawAskBatch(api, batchId, keyFor({ withdraw: batchId }))
      setNotice({ tone: 'success', words: undoLineOf(null, answer, t) })
    } catch (error) {
      setNotice({ tone: 'warning', words: undoProblemOf(error, t) })
    } finally {
      setUndoing(false)
      void load()
    }
  }
  // ---- end F-PR-23a

  // ── Mark urgent / Mark regular (one order; the bulk bar: F-PR-23a above) ───────────────────────────────────────────
  const mark = async (row: ProductionRow, urgency: BrandUrgencyCode) => {
    if (busy.includes(row.id) || writeHeld) return
    setBusy((current) => [...current, row.id])
    const body = { orderIds: [row.id], urgency }
    try {
      const answer = await markUrgency(api, body, keyFor(body))
      setNotice(markedNotice(answer, row, locale, t))
      void load()
    } catch (error) {
      const refusal = markRefusal(error, t)
      setNotice({ tone: 'warning', words: `${rowName(row, locale, t)}: ${refusal.words}` })
      if (refusal.reread) void load()
    } finally {
      setBusy((current) => current.filter((id) => id !== row.id))
    }
  }

  const undo = async (batchId: string) => {
    if (undoing || writeHeld) return
    setUndoing(true)
    const body = { batchId }
    try {
      const answer = await undoUrgency(api, batchId, keyFor(body))
      setNotice(undoneNotice(answer, t))
    } catch (error) {
      setNotice({ tone: 'warning', words: undoRefusal(error, t) })
    } finally {
      setUndoing(false)
      void load()
    }
  }

  // ── the Urgent order dialog ────────────────────────────────────────────────────────────────────────────────────────
  const openOrder = () => setDialog({ items: urgent.map((row) => row.id), busy: false, problem: null })
  const saveOrder = async () => {
    if (!dialog || dialog.busy || !read || writeHeld || !orderChanged(dialog.items, rowsNow)) return
    const body = { orderIds: dialog.items, asOf: read.asOf }
    setDialog({ ...dialog, busy: true, problem: null })
    try {
      const answer = await saveUrgentOrder(api, body, keyFor(body))
      setDialog(null)
      setNotice({ tone: 'success', words: t('notice.ordered'), undo: answer.batchId })
      void load()
    } catch (error) {
      setDialog((current) => (current ? { ...current, busy: false, problem: orderRefusal(error, t) } : current))
    }
  }
  /** After a conflict: read the list again, then take its order ("Use the new list") or keep mine where it still holds. */
  const reloadOrder = async (mine: boolean) => {
    const next = await load()
    if (!next) return
    setDialog((current) => (current ? { items: mine ? keepMine(current.items, next.items) : urgentRowsOf(next.items).map((row) => row.id), busy: false, problem: null } : current))
  }

  // ── Export: the server's file of the same rows, in the person's language ───────────────────────────────────────────
  const exportRows = async () => {
    if (exporting) return
    setExporting(true)
    setExportFailed(false)
    try {
      const file = await downloadProduction(api, { chip, q, locale: locale === 'it' ? 'it' : 'en' })
      saveBytes(file.fileName ?? `${t('list.fileName')}.csv`, file.bytes, file.contentType)
    } catch {
      setExportFailed(true)
    } finally {
      setExporting(false)
    }
  }

  const go = (nextChip: ProductionChip | null, nextQ: string) => router.replace(`${pathname}${listQuery(nextChip, nextQ)}`, { scroll: false })
  const orderOpens = read?.urgencyOn === true && mayMark
  usePortalBand(
    state === 'forbidden'
      ? { title: t('list.title') }
      : {
          title: t('list.title'),
          status: read ? { label: t('band.updated', { time: time(read.asOf) }), tone: 'neutral' } : null,
          // "Urgent order": while the customer's urgency is on and the person may mark (else not drawn).
          actions: orderOpens ? [{ id: 'urgent-order', label: t('band.urgentOrder'), variant: 'primary', heldReason: orderHeld(urgent.length, { preview, offline }, t), onClick: openOrder }] : [],
          more: [
            {
              id: 'export',
              label: exporting ? t('band.exporting') : t('band.export'),
              description: (read?.count ?? 0) === 0 ? t('band.exportNone') : t('band.exportHint'),
              disabled: exporting || (read?.count ?? 0) === 0,
              onSelect: () => void exportRows(),
            },
          ],
          keys: [
            { keys: ['/'], words: t('keys.search') },
            { keys: ['↵'], words: t('keys.open') },
          ],
        },
  )

  if (state === 'forbidden') return <Closed title={t('list.title')} />

  return (
    <ProductionListView
      model={{
        state: state === 'loading' && !read ? 'loading' : state === 'error' ? 'error' : 'ready',
        read,
        chip,
        q,
        prefix: frame.prefix,
        updates,
        offlineSince: offline ? loadedAt : null,
        mayMark,
        preview,
        busy,
        notice,
        undoHeld: undoing ? t('held.busy') : writeHeld,
        exportFailed,
        collapsed,
        dialog: dialog ? { items: dialog.items, busy: dialog.busy, problem: dialog.problem, held: dialog.busy ? t('held.busy') : (writeHeld ?? (orderChanged(dialog.items, rowsNow) ? null : t('dialog.unmoved'))) } : null,
        now: read ? Date.parse(read.asOf) : Date.now(),
        // F-PR-24
        report: mayReport ? { held: preview ? t('problem.held.preview') : offline ? t('problem.held.offline') : null } : null,
        problem: problemDialog.model,
        // F-PR-23a
        selected: bulk.selected,
        bulk: bulk.bar,
        review: bulk.review,
        // F-PR-23b
        mayAsk,
        approve: bulk.approve,
        ask: bulk.ask,
      }}
      actions={{
        onChip: (next) => go(next === 'ALL' ? null : next, q),
        onSearch: (next) => go(chip, next),
        onClear: () => go(null, ''),
        onOpen: (row) => router.push(rowHref(frame.prefix, row)),
        onRetry: () => {
          setState('loading')
          void load()
        },
        onShowUpdates: () => void load(),
        onMark: (row, urgency) => void mark(row, urgency),
        onUndo: (batchId) => void undo(batchId),
        onDismissNotice: () => setNotice(null),
        onRetryExport: () => void exportRows(),
        onToggleGroup: (key) => setCollapsed((current) => toggleGroup(current, key)),
        // F-PR-24
        onReport: (row) => problemDialog.open([{ id: row.id, name: rowName(row, locale, t) }]),
        problem: problemDialog.actions,
        // F-PR-23a
        onSelect: bulk.actions.onSelect,
        bulk: { onSelectAll: bulk.actions.onSelectAll, onAction: bulk.actions.onAction },
        review: bulk.actions.review,
        onUndoAsks: (batchId) => void undoAsks(batchId),
        // F-PR-23b
        approve: bulk.actions.approve,
        ask: bulk.actions.ask,
        dialog: {
          onChange: (items) => setDialog((current) => (current && !current.busy ? { ...current, items, problem: current.problem?.conflict ? current.problem : null } : current)),
          onTop: (id) => setDialog((current) => (current && !current.busy ? { ...current, items: toTop(current.items, id) } : current)),
          onSave: () => void saveOrder(),
          onClose: () => setDialog((current) => (current?.busy ? current : null)),
          onLoadTheirs: () => void reloadOrder(false),
          onKeepMine: () => void reloadOrder(true),
        },
      }}
    />
  )
}
