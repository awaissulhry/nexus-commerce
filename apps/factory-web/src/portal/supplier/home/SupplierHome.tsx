'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { WithMessages } from '../../../record-panels/i18n'
import { dayIn } from '../../../lib/po-answer/quantities'
import { PORTAL_AREAS, RECORD_PAGES } from '../../shell/nav/portal-nav'
import { usePortalTasks } from '../../shell/PortalShell'
import { usePortalApi, usePortalBand, usePortalFrame, usePortalLive } from '../../shell/frame'
import { TasksView } from '../../shell/view/TasksView'
import { confirmOrder, fetchOrder, type OrderPage } from '../orders/api'
import { homeBandOf } from '../orders/band'
import { confirmAllBody, NS, problemOf, type AnswerProblem } from '../orders/model'
import { mayApprove, useOffline } from '../orders/parts'
import { useOrderWords } from '../orders/words'
import { fetchHome, fetchRecentMessages, fetchShippable, type Conversation, type HomeRead, type ShippableRead } from './api'
import { freeNoteKey, orderOfTask, replyHref, supplierKindOf, tilesFor, tilesOf, upcomingOf } from './model'
import { SupplierHomeView } from './view/SupplierHomeView'

/**
 * `/p/<party>` for a supplier or a workshop (B-W2b-179; design portal.supplier.home, SCM-093, SCM-102): the frame's ONE task
 * list (`usePortalTasks` + `TasksView`) with "Confirm" on a PO opening "Confirm … as asked?" in place, the counts at a glance,
 * the next deliveries, our last messages and the free-for-suppliers note. Reads again on the live channel.
 */
export function SupplierHome() {
  return (
    <WithMessages namespaces={[NS, 'ds-words']}>
      <HomeContainer />
    </WithMessages>
  )
}

/** A page of the portal is built (an area without pages, or one page of an area): its tile and rows may link to it. */
const pageBuilt = (id: string): boolean => PORTAL_AREAS.some((area) => (area.id === id && area.built) || (area.pages ?? []).some((page) => page.id === id && page.built))

type Async<T> = { state: 'loading' | 'error' | 'ready'; value: T | null }

function HomeContainer() {
  const frame = usePortalFrame()
  const api = usePortalApi()
  const tasks = usePortalTasks()
  const { t, locale } = useOrderWords()
  const offline = useOffline()
  const can = useCallback((permission: string) => frame.me.permissions.includes(permission), [frame.me.permissions])
  const kind = supplierKindOf(frame.kinds)
  const seesDeliveries = kind === 'SUPPLIER' && can('portal.shipNotices.view')
  const ordersBuilt = pageBuilt('work.orders')
  const poPage = RECORD_PAGES.some((page) => page.type === 'PurchaseOrder' && page.built)

  const [home, setHome] = useState<Async<HomeRead>>({ state: 'loading', value: null })
  const [shippable, setShippable] = useState<Async<ShippableRead>>({ state: 'loading', value: null })
  const [messages, setMessages] = useState<Async<Conversation[]>>({ state: 'loading', value: null })
  const [freeNote, setFreeNote] = useState(false)
  const [confirmed, setConfirmed] = useState<{ documentNumber: string; count: number } | null>(null)
  const [dialog, setDialog] = useState<{ orderId: string; page: OrderPage | null; supplierRef: string; busy: boolean; problem: AnswerProblem | null } | null>(null)

  const readHome = useCallback(() => {
    fetchHome(api)
      .then((value) => setHome({ state: 'ready', value }))
      .catch(() => setHome((current) => ({ state: current.value ? 'ready' : 'error', value: current.value })))
  }, [api])
  const readShippable = useCallback(() => {
    if (!seesDeliveries) return
    fetchShippable(api)
      .then((value) => setShippable({ state: 'ready', value }))
      .catch(() => setShippable((current) => ({ state: current.value ? 'ready' : 'error', value: current.value })))
  }, [api, seesDeliveries])
  const readMessages = useCallback(() => {
    if (!can('threads.read')) return
    fetchRecentMessages(api)
      .then((value) => setMessages({ state: 'ready', value: value.conversations }))
      .catch(() => setMessages((current) => ({ state: current.value ? 'ready' : 'error', value: current.value })))
  }, [api, can])

  useEffect(() => {
    readHome()
    readShippable()
    readMessages()
  }, [readHome, readShippable, readMessages])

  useEffect(() => {
    try {
      setFreeNote(!window.localStorage.getItem(freeNoteKey(frame.me.user.id)))
    } catch {
      setFreeNote(true)
    }
  }, [frame.me.user.id])

  // New PO, revised PO, our answer to a proposal, a document asked: the counts and lists follow (the task list is the frame's).
  usePortalLive({
    onChange: (change) => {
      if (home.value?.live.events.includes(change.type) || change.type.startsWith('partner_task.') || change.type.startsWith('partner_notification.')) {
        readHome()
        readShippable()
        readMessages()
      }
    },
    onReconnect: () => {
      readHome()
      readShippable()
      readMessages()
    },
  })

  const mayAnswer = mayApprove(frame)
  const held = frame.me.preview ? t('held.preview') : !mayAnswer ? t('held.mayAnswer') : offline ? t('held.offline') : null

  const openConfirm = (orderId: string) => {
    setDialog({ orderId, page: null, supplierRef: '', busy: false, problem: null })
    fetchOrder(api, orderId)
      .then((page) => setDialog((current) => (current?.orderId === orderId ? { ...current, page } : current)))
      .catch((error: unknown) => setDialog((current) => (current?.orderId === orderId ? { ...current, problem: problemOf(isApiError(error) ? error.kind : null) } : current)))
  }

  const confirmGo = () => {
    const current = dialog
    if (!current?.page || current.busy) return
    const page = current.page
    const count = page.lines.filter((line) => !line.ended && !line.locked).length
    setDialog({ ...current, busy: true, problem: null })
    confirmOrder(api, page.order.id, confirmAllBody(page.order.version, current.supplierRef), newIdempotencyKey())
      .then(() => {
        setDialog(null)
        setConfirmed({ documentNumber: page.order.documentNumber, count })
        frame.refreshTasks()
        readHome()
        readShippable()
      })
      .catch((error: unknown) => setDialog((now) => (now ? { ...now, busy: false, problem: problemOf(isApiError(error) ? error.kind : null) } : now)))
  }

  const firstToConfirm = useMemo(() => {
    for (const group of tasks.model.groups) for (const row of group.rows) {
      const id = orderOfTask(row)
      if (id) return id
    }
    return null
  }, [tasks.model.groups])

  usePortalBand(homeBandOf({ t, locale, asOf: home.value?.asOf ?? null, prefix: frame.prefix, firstToConfirm: ordersBuilt ? firstToConfirm : null, preview: frame.me.preview }))

  const tiles = tilesOf(tilesFor(kind, { orders: ordersBuilt, deliveries: pageBuilt('deliveries'), documents: pageBuilt('supplier-documents'), jobs: pageBuilt('work.jobs') }), home.value, can)
  const today = dayIn(new Date())
  const dialogModel = dialog
    ? {
        orders: [{ id: dialog.orderId, documentNumber: dialog.page?.order.documentNumber ?? '…', lines: dialog.page?.lines ?? null, lineCount: dialog.page?.lines.length ?? 0 }],
        loading: !dialog.page && !dialog.problem,
        supplierRef: dialog.supplierRef,
        person: frame.me.user.displayName,
        busy: dialog.busy,
        heldReason: held ?? (dialog.busy ? t('held.busy') : !dialog.page ? t('held.reading') : !dialog.page.answer.canAnswer ? t('held.answered') : !dialog.page.answer.mayAnswer ? t('held.mayAnswer') : null),
        problem: dialog.problem,
      }
    : null

  return (
    <SupplierHomeView
      model={{
        prefix: frame.prefix,
        tiles: { state: home.state, items: tiles },
        upcoming: seesDeliveries && ordersBuilt ? { state: shippable.state, items: upcomingOf(shippable.value, today) } : null,
        messages: can('threads.read') ? { state: messages.state, items: (messages.value ?? []).map((conversation) => ({ ...conversation, href: replyHref(frame.prefix, conversation, poPage) })) } : null,
        freeNote,
        confirmed,
        dialog: dialogModel,
      }}
      actions={{
        onRetryTiles: () => {
          setHome({ state: 'loading', value: null })
          readHome()
        },
        onRetryUpcoming: () => {
          setShippable({ state: 'loading', value: null })
          readShippable()
        },
        onRetryMessages: () => {
          setMessages({ state: 'loading', value: null })
          readMessages()
        },
        onHideFreeNote: () => {
          setFreeNote(false)
          try {
            window.localStorage.setItem(freeNoteKey(frame.me.user.id), '1')
          } catch {
            // This device keeps nothing: the note comes back next time.
          }
        },
        onHideConfirmed: () => setConfirmed(null),
        dialog: {
          onRef: (value) => setDialog((current) => (current ? { ...current, supplierRef: value } : current)),
          onConfirm: confirmGo,
          onClose: () => setDialog((current) => (current?.busy ? current : null)),
        },
      }}
      tasks={
        <TasksView
          model={tasks.model}
          onDone={tasks.onDone}
          onUndo={tasks.onUndo}
          onRetry={tasks.onRetry}
          verbFor={(row) => {
            const orderId = ordersBuilt ? orderOfTask(row) : null
            return orderId ? { label: t('home.confirmVerb'), onRun: () => openConfirm(orderId), heldReason: held } : null
          }}
        />
      }
    />
  )
}
