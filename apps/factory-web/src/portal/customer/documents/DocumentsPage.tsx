'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { WithMessages } from '../../../record-panels/i18n'
import { usePortalApi, usePortalBand, usePortalFrame, usePortalLive } from '../../shell/frame'
import { confirmFake, fetchConformity, fetchIntent, fetchLibrary, fetchOpenItems, isLibraryChip, startPayment, statementHref, type ConformityRead, type FakeScenario, type LibraryChip, type LibraryRead, type OpenItemsRead, type PaymentIntent, type PayMethod } from './api'
import { documentsBandOf } from './band'
import {
  addressOf,
  addressQuery,
  chipsOf,
  conformityRowsOf,
  failureKey,
  fakeStageOf,
  groupedRows,
  isLive,
  libraryRowOf,
  NS,
  panelStateAfterStart,
  payHeld,
  payRowsOf,
  POLL_MS,
  sectionsOf,
  startRefusal,
  totalsOf,
  type ConformityDoc,
  type DocumentsAddress,
  type LibraryRow,
  type PanelState,
  type PayRow,
} from './model'
import type { CustomerDocument } from './preview/api'
import { useDocumentPreview } from './preview/usePreview'
import { DocumentsClosedView, DocumentsView } from './view/DocumentsView'
import type { PayDialogModel } from './view/PayDialog'
import { useDocumentWords } from './words'

/**
 * `/p/<party>/documents` for a customer (B-W2b-195, SCR-186; design portal.customer.documents): reads the library with the
 * address's chip, search, grouping and versions (B-W2b-178), the open items to pay (B-W2b-185; Finance and Admin) and the
 * conformity per style received (B-W2b-178; Quality, Buyer, Viewer), each on its own (one failing never empties another).
 * Every open is the API's logged command (preview, download, a file in a new tab); paying is the API's start and the FAKE
 * provider's own fields, then the page follows the payment until the bank answers. `?invoice=<id>` (an invoice's record
 * opens here) opens its Pay pop-up; with `tab=messages` its conversation. Nothing reaches a real payment provider.
 */
export function CustomerDocumentsRoute() {
  return (
    <WithMessages namespaces={[NS, 'portal', 'ds-words', 'lists']}>
      <Suspense fallback={null}>
        <DocumentsGate />
      </Suspense>
    </WithMessages>
  )
}

function DocumentsGate() {
  const frame = usePortalFrame()
  const opens = frame.kinds.includes('CUSTOMER') && frame.me.permissions.includes('portal.customerDocuments.view')
  return opens ? <DocumentsContainer /> : <Closed />
}

function Closed() {
  const { t } = useDocumentWords()
  const frame = usePortalFrame()
  usePortalBand({ title: t('title'), back: { href: frame.prefix, label: t('noAccess.home') } })
  return <DocumentsClosedView model={{ homeHref: frame.prefix, admins: (frame.access?.admins ?? []).map((admin) => admin.displayName) }} />
}

type Async<T> = { state: 'loading' | 'error' | 'ready'; value: T | null }
const LOADING = { state: 'loading', value: null } as const

/** Today in the site's zone (YYYY-MM-DD). */
const todayInRome = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

interface PayState {
  row: PayRow
  method: PayMethod | null
  state: PanelState
  intentId: string | null
  clientSecret: string | null
  fake: boolean
  providerState: string | null
  failure: string | null
  problem: string | null
  resumed: boolean
  sending: boolean
  /** The provider is not one this page has fields for (not FAKE): held with the reason. */
  unsupported: boolean
}

function DocumentsContainer() {
  const frame = usePortalFrame()
  const api = usePortalApi()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const params = useSearchParams()
  const words = useDocumentWords()
  const { t, locale } = words
  const can = useCallback((permission: string) => frame.me.permissions.includes(permission), [frame.me.permissions])
  const address: DocumentsAddress = addressOf(params, isLibraryChip)
  const preview = frame.me.preview
  const seesToPay = can('portal.payments.view')
  const seesConformity = can('portal.customerDocuments.conformity')
  const seesPrices = frame.access?.role?.seesPrices ?? true
  const admins = (frame.access?.admins ?? []).map((admin) => admin.displayName)
  const sections = sectionsOf(address.group, { toPay: seesToPay, conformity: seesConformity })

  const [library, setLibrary] = useState<Async<LibraryRead>>(LOADING)
  const [items, setItems] = useState<CustomerDocument[]>([])
  const [loadingMore, setLoadingMore] = useState(false)
  const [updates, setUpdates] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const [paySelected, setPaySelected] = useState<string[]>([])
  const [openItems, setOpenItems] = useState<Async<OpenItemsRead>>(LOADING)
  const [conformity, setConformity] = useState<Async<ConformityRead>>(LOADING)
  const [slow, setSlow] = useState(false)
  const [notice, setNotice] = useState<{ key: string; params?: Record<string, string | number>; tone: 'info' | 'warning' } | null>(null)
  const [pay, setPay] = useState<PayState | null>(null)
  const [bulkBusy, setBulkBusy] = useState<string | null>(null)
  const reading = useRef<AbortController | null>(null)

  // ── reads ──
  const keep = <T,>(set: (update: (current: Async<T>) => Async<T>) => void) => () => set((current) => ({ state: current.value ? 'ready' : 'error', value: current.value }))
  const readLibrary = useCallback(async () => {
    reading.current?.abort()
    const control = new AbortController()
    reading.current = control
    try {
      const read = await fetchLibrary(api, { group: address.group, q: address.q, versions: address.versions }, control.signal)
      if (control.signal.aborted) return
      setLibrary({ state: 'ready', value: read })
      setItems(read.items)
      setUpdates(0)
      setSelected((current) => current.filter((id) => read.items.some((item) => item.id === id)))
    } catch {
      if (control.signal.aborted) return
      setLibrary((current) => ({ state: current.value ? 'ready' : 'error', value: current.value }))
    }
  }, [api, address.group, address.q, address.versions])
  const readMore = async () => {
    if (loadingMore) return
    setLoadingMore(true)
    try {
      const read = await fetchLibrary(api, { group: address.group, q: address.q, versions: address.versions, offset: items.length })
      setItems((current) => [...current, ...read.items.filter((item) => !current.some((known) => known.id === item.id))])
    } catch {
      // The rows read stay; "Show more" can be asked again.
    } finally {
      setLoadingMore(false)
    }
  }
  const readOpenItems = useCallback(() => {
    if (!seesToPay) return
    fetchOpenItems(api)
      .then((value) => setOpenItems({ state: 'ready', value }))
      .catch(keep(setOpenItems))
  }, [api, seesToPay])
  const readConformity = useCallback(() => {
    if (!seesConformity) return
    fetchConformity(api, '')
      .then((value) => setConformity({ state: 'ready', value }))
      .catch(keep(setConformity))
  }, [api, seesConformity])

  useEffect(() => {
    void readLibrary()
    return () => reading.current?.abort()
  }, [readLibrary])
  useEffect(() => readOpenItems(), [readOpenItems])
  useEffect(() => readConformity(), [readConformity])

  const anyLoading = library.state === 'loading' || (sections.toPay && openItems.state === 'loading') || (sections.conformity && conformity.state === 'loading')
  useEffect(() => {
    if (!anyLoading) {
      setSlow(false)
      return
    }
    const timer = window.setTimeout(() => setSlow(true), 1000)
    return () => window.clearTimeout(timer)
  }, [anyLoading])

  // Document issued (a news row), invoice paid or its SDI state moved: the library tells of it without moving the rows;
  // To pay and conformity read again in place.
  const live = usePortalLive({
    onChange: (change) => {
      if (library.value?.live.events.includes(change.type) || change.type.startsWith('partner_notification.')) setUpdates((count) => count + 1)
      if (openItems.value?.live.events.includes(change.type) || change.type.startsWith('partner_task.')) readOpenItems()
      if (conformity.value?.live.events.includes(change.type)) readConformity()
    },
    onReconnect: () => {
      setUpdates((count) => count + 1)
      readOpenItems()
      readConformity()
    },
  })
  const [online, setOnline] = useState(true)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  const offline = !online || live === 'offline'
  const held = preview ? 'held.preview' : offline ? 'held.offline' : null

  // ── documents: the pop-up, downloads, new tabs ──
  const known = useRef(new Map<string, CustomerDocument>())
  useEffect(() => {
    for (const item of items) known.current.set(item.id, item)
  }, [items])
  const viewer = useDocumentPreview({ api, locale, held: held ? t(held) : null, find: (id) => known.current.get(id) })
  const rows = useMemo(() => groupedRows(items.map((item) => libraryRowOf(item, locale, viewer.opened)), address.by), [items, locale, viewer.opened, address.by])
  const rowIds = rows.map((row) => row.id)
  const docOf = (row: { id: string }) => known.current.get(row.id)
  const previewRow = (row: LibraryRow) => {
    const document = docOf(row)
    if (document) viewer.open(document, rowIds)
  }
  const downloadRow = (row: LibraryRow) => {
    const document = docOf(row)
    if (document) void viewer.download(document)
  }
  const downloadMany = async (ids: readonly string[], key: string) => {
    if (held || bulkBusy) return
    setBulkBusy(key)
    try {
      for (const id of ids) {
        const document = known.current.get(id)
        if (document) await viewer.download(document)
      }
    } finally {
      setBulkBusy(null)
    }
  }

  // `d` downloads the focused row of the library (design kb), as the row's own Download.
  const latestRows = useRef(rows)
  latestRows.current = rows
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'd' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
      const id = document.activeElement?.closest('.fw-pdoc-library [row-id]')?.getAttribute('row-id')
      const row = id ? latestRows.current.find((entry) => entry.id === id) : undefined
      if (!row) return
      event.preventDefault()
      downloadRow(row)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ── to pay ──
  const payRows = useMemo(() => payRowsOf(openItems.value), [openItems.value])
  const today = todayInRome()
  const payFacts = { preview, offline, mayPay: openItems.value?.mayPay ?? false, card: openItems.value?.card ?? null }
  const statement = seesToPay && seesPrices && !preview ? () => void window.open(statementHref(locale), '_blank', 'noopener') : null

  const openPay = (row: PayRow) => {
    const intent = row.payment
    const method: PayMethod | null = intent && isLive(intent.status) ? intent.method : (openItems.value?.card.methods[0] ?? null)
    setPay({ row, method, state: 'idle', intentId: null, clientSecret: null, fake: false, providerState: null, failure: null, problem: null, resumed: false, sending: false, unsupported: false })
    // A payment of mine under way is taken up again where it stands (the API answers `resumed`).
    if (intent && isLive(intent.status) && !payHeld(row, payFacts)) void start(row, intent.method)
  }
  const start = async (row: PayRow, method: PayMethod) => {
    setPay((current) => (current && current.row.key === row.key ? { ...current, method, state: 'starting', problem: null, failure: null, sending: true } : current))
    try {
      const started = await startPayment(api, row.target, method, newIdempotencyKey())
      const fake = started.provider?.mode === 'FAKE'
      const state = panelStateAfterStart(started.intent.status)
      setPay((current) =>
        current && current.row.key === row.key
          ? { ...current, method, intentId: started.intent.id, clientSecret: started.provider?.clientSecret ?? null, fake, unsupported: !fake, resumed: started.resumed, state, providerState: null, sending: false, failure: state === 'failed' ? failureKey(started.intent.failureCode) : null }
          : current,
      )
    } catch (error) {
      const key = startRefusal(isApiError(error) ? error : null)
      setPay((current) => (current && current.row.key === row.key ? { ...current, state: key === 'refusal.IN_PROGRESS' && row.payment ? 'waiting' : 'idle', intentId: key === 'refusal.IN_PROGRESS' ? (row.payment?.id ?? null) : null, problem: key, sending: false } : current))
    }
  }
  const scenario = async (choice: FakeScenario) => {
    const current = pay
    if (!current?.clientSecret || current.sending) return
    setPay({ ...current, sending: true, problem: null, state: current.state === 'ready' ? 'paying' : current.state })
    try {
      const answer = await confirmFake(api, current.clientSecret, choice)
      setPay((now) => (now && now.intentId === current.intentId ? { ...now, sending: false, providerState: answer.state, state: 'waiting' } : now))
    } catch (error) {
      const key = startRefusal(isApiError(error) ? error : null)
      setPay((now) => (now && now.intentId === current.intentId ? { ...now, sending: false, problem: key, state: current.state } : now))
    }
  }
  // While the bank decides, ask how the payment stands (the provider's answer reaches us by its webhook).
  const polling = pay?.intentId && (pay.state === 'waiting' || pay.state === 'paying') ? pay.intentId : null
  useEffect(() => {
    if (!polling) return
    let stopped = false
    const tick = async () => {
      try {
        const intent: PaymentIntent = await fetchIntent(api, polling)
        if (stopped) return
        setPay((now) => {
          if (!now || now.intentId !== polling) return now
          if (intent.status === 'SUCCEEDED') return { ...now, state: 'succeeded', sending: false }
          if (intent.status === 'FAILED' || intent.status === 'CANCELLED') return { ...now, state: 'failed', failure: failureKey(intent.failureCode), sending: false }
          return now
        })
        if (intent.status === 'SUCCEEDED') {
          readOpenItems()
          frame.refreshTasks()
        }
      } catch {
        // A missed answer: the next tick asks again.
      }
    }
    const timer = window.setInterval(() => void tick(), POLL_MS)
    void tick()
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [polling, api, readOpenItems, frame])
  const closePay = () => {
    if (pay?.sending) return
    setPay(null)
    readOpenItems()
  }

  // ── an invoice's record opens here (`?invoice=<id>`): its Pay pop-up, or why not; `tab=messages`: its conversation ──
  const handled = useRef<string | null>(null)
  useEffect(() => {
    const id = address.invoice
    if (!id || handled.current === id) return
    if (address.messages) {
      handled.current = id
      frame.ask({ type: 'Invoice', id })
      return
    }
    if (!seesToPay) {
      handled.current = id
      setNotice({ key: admins.length > 0 ? 'invoice.notYoursAsk' : 'invoice.notYours', params: { names: admins.join(', ') }, tone: 'info' })
      return
    }
    if (openItems.state === 'loading') return
    handled.current = id
    const row = payRows.find((entry) => entry.target.kind === 'invoice' && entry.target.id === id)
    if (row) openPay(row)
    else setNotice({ key: openItems.state === 'error' ? 'invoice.unread' : 'invoice.nothingOpen', tone: 'info' })
  })

  // ── the address ──
  const go = (next: Partial<DocumentsAddress>) => router.replace(`${pathname}${addressQuery({ ...address, ...next })}`, { scroll: false })

  // ── the band ──
  const asOf = library.value?.asOf ?? null
  usePortalBand(documentsBandOf({ t, asOf: asOf ? words.time(asOf) : null, onStatement: statement, statementHeld: offline ? t('held.offline') : null }))

  // ── the model ──
  const libraryRead = library.value
  const totals = totalsOf(openItems.value).map((total) => ({ open: words.money(total.open, total.currency), overdue: total.overdue > 0 ? words.money(total.overdue, total.currency) : null }))
  const payModel: PayDialogModel | null = pay
    ? {
        row: pay.row,
        today,
        methods: openItems.value?.card.methods ?? [],
        method: pay.method,
        state: pay.state,
        fake: pay.fake,
        stage: pay.fake && pay.method ? fakeStageOf(pay.method, pay.state, pay.providerState) : null,
        failure: pay.failure,
        problem: pay.problem,
        held: (() => {
          const reason = payHeld(pay.row, payFacts)
          if (reason) return reason === 'held.mayPay' && admins.length > 0 ? t('held.mayPayAsk', { names: admins.join(', ') }) : t(reason)
          return pay.unsupported ? t('held.provider') : null
        })(),
        resumed: pay.resumed,
        sending: pay.sending,
      }
    : null

  return (
    <DocumentsView
      model={{
        chips: { state: library.state, items: chipsOf(libraryRead) },
        group: address.group,
        noPrices: libraryRead ? !libraryRead.seesPrices : !seesPrices,
        notice,
        slow,
        toPay: sections.toPay
          ? {
              state: openItems.state,
              rows: openItems.state === 'loading' ? null : payRows,
              totals,
              overdue: openItems.value?.counts.overdue ?? 0,
              facts: payFacts,
              today,
              selected: paySelected,
              busy: viewer.busy ?? bulkBusy,
              held,
            }
          : null,
        library: {
          state: library.state,
          rows: library.state === 'loading' ? null : rows,
          total: libraryRead?.count ?? 0,
          group: address.group,
          q: address.q,
          by: address.by,
          versions: address.versions,
          selected,
          busy: viewer.busy ?? bulkBusy,
          held,
          updates,
          more: libraryRead ? items.length < libraryRead.count : false,
          loadingMore,
          prefix: frame.prefix,
        },
        conformity: sections.conformity ? { state: conformity.state, styles: conformityRowsOf(conformity.value?.styles ?? [], locale, viewer.opened), busy: viewer.busy ?? bulkBusy, held, slow } : null,
        preview: viewer.dialog,
        problem: viewer.problem,
        pay: payModel,
      }}
      actions={{
        onChip: (chip: LibraryChip) => go({ group: chip }),
        onRetryChips: () => {
          setLibrary(LOADING)
          void readLibrary()
        },
        onDismissNotice: () => setNotice(null),
        onDismissProblem: viewer.dismissProblem,
        toPay: {
          onPay: openPay,
          onTab: (row, fileId, contentType) => viewer.openInTab({ fileId, contentType }, row.key),
          onSelect: setPaySelected,
          onDownloadMany: (ids) => {
            if (held || bulkBusy) return
            const files = payRows.filter((row) => ids.includes(row.key) && row.pdfFileId)
            setBulkBusy('pay')
            void (async () => {
              try {
                for (const row of files) await viewer.downloadId(row.pdfFileId!, row.key)
              } finally {
                setBulkBusy(null)
              }
            })()
          },
          onRetry: () => {
            setOpenItems(LOADING)
            readOpenItems()
          },
        },
        library: {
          onSearch: (q) => go({ q }),
          onBy: (by) => go({ by }),
          onVersions: (versions) => go({ versions }),
          onSelect: setSelected,
          onPreview: previewRow,
          onDownload: downloadRow,
          onDownloadMany: (ids) => void downloadMany(ids, 'library'),
          onTab: (row, fileId) => {
            const file = row.files.find((entry) => entry.fileId === fileId)
            if (file) viewer.openInTab(file, row.id)
          },
          onReplaced: (row) => (row.replacedBy?.id ? viewer.openId(row.replacedBy.id, rowIds) : undefined),
          onRetry: () => {
            setLibrary(LOADING)
            void readLibrary()
          },
          onShowUpdates: () => void readLibrary(),
          onMore: () => void readMore(),
          onClearSearch: () => go({ q: '' }),
          onAll: () => go({ group: 'ALL' }),
        },
        conformity: {
          onPreview: (doc: ConformityDoc, ids) => viewer.openId(doc.id, ids),
          onDownload: (doc: ConformityDoc) => void viewer.downloadId(doc.id),
          onDownloadAll: (style) => {
            if (held || bulkBusy) return
            setBulkBusy(`all:${style.code}`)
            void (async () => {
              try {
                for (const doc of style.documents) await viewer.downloadId(doc.id)
              } finally {
                setBulkBusy(null)
              }
            })()
          },
          onAsk: (row) => frame.ask(row.orderId ? { type: 'SalesOrder', id: row.orderId, label: row.order } : null),
          onRetry: () => {
            setConformity(LOADING)
            readConformity()
          },
        },
        preview: viewer.actions,
        pay: {
          onMethod: (method) => setPay((current) => (current ? { ...current, method } : current)),
          onStart: () => pay?.method && void start(pay.row, pay.method),
          onScenario: (choice) => void scenario(choice),
          onRetry: () => setPay((current) => (current ? { ...current, state: 'idle', intentId: null, clientSecret: null, failure: null, problem: null, providerState: null, resumed: false } : current)),
          onClose: closePay,
        },
      }}
    />
  )
}
