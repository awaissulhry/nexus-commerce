'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { SampleLineKind } from '@nexus/factory-domain/purchasing/sample-orders/rules'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { useLiveBus } from '../../../shell/live/use-live'
import { createSampleOrder, listSampleOrders, readChoices, recordHref, type Choices, type ListAnswer, type SampleRow } from './api'
import {
  addressOf,
  addressText,
  bodyOf,
  createHeld,
  emptyDraft,
  isOrdersChange,
  materialOf,
  mayAddLine,
  newLine,
  problemOf,
  readProblemOf,
  sourcingCan,
  withAddress,
  withDefaults,
  withMaterial,
  withStyle,
  withWhat,
  type LineDraft,
  type SourcingAddress,
} from './model'
import type { NewState, PageNotice, Read } from './view-model'
import { SourcingPageView } from './view/SourcingPageView'

/** Today in the factory's zone (Europe/Rome), the guards' "today". */
const todayInRome = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

/**
 * `/w/<company>/purchasing/sourcing` (SCR-222; B-W2b-347; design purchasing.sourcing): one read — the sample and development
 * orders (GET /purchasing/sample-orders with the address's filters; Show more reads the next 50) — loading and failing on its
 * own; New sample order lives in the address (`?new=1`): its choices are read when it opens (again on Try again), Create draft
 * posts the draft (one Idempotency-Key per try) and says so with Open. Live: every purchase-order event reads the list again
 * (coalesced: "purchasing.po.sent → Sample order status").
 */
export function SourcingPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/purchasing\/sourcing\/?$/, '')
  const can = useMemo(() => sourcingCan(session.permissions), [session.permissions])
  const address = useMemo(() => addressOf(params), [params])
  const companyId = session.company?.id ?? null
  const [today] = useState(todayInRome)

  const [orders, setOrders] = useState<Read<ListAnswer>>({ status: 'loading' })
  const [more, setMore] = useState<SampleRow[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [moreBusy, setMoreBusy] = useState(false)
  const [notice, setNotice] = useState<PageNotice | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [add, setAdd] = useState<NewState | null>(null)
  const turn = useRef(0)

  const { rows, status, q } = address
  const readNow = useCallback(() => {
    if (!can.view) return Promise.resolve()
    const mine = ++turn.current
    return listSampleOrders(api, { companyId, rows, status, q }).then(
      (value) => {
        if (mine !== turn.current) return
        setOrders({ status: 'ready', value })
        setMore([])
        setCursor(value.nextCursor)
      },
      (error: unknown) => {
        if (mine === turn.current) setOrders({ status: 'error', problem: readProblemOf(error) })
      },
    )
  }, [api, can.view, companyId, rows, status, q])

  useEffect(() => {
    setOrders({ status: 'loading' })
    void readNow()
  }, [readNow])

  const readMore = async () => {
    if (!cursor || moreBusy) return
    setMoreBusy(true)
    try {
      const page = await listSampleOrders(api, { companyId, rows, status, q, cursor })
      setMore((current) => [...current, ...page.orders])
      setCursor(page.nextCursor)
      setOrders((current) => (current.status === 'ready' ? { status: 'ready', value: { ...current.value, nextCursor: page.nextCursor } } : current))
    } catch (error) {
      setNotice({ tone: 'danger', key: readProblemOf(error) })
    } finally {
      setMoreBusy(false)
    }
  }

  const go = useCallback((change: Partial<SourcingAddress>) => router.replace(`${pathname}${addressText(withAddress(address, change))}`, { scroll: false }), [router, pathname, address])

  // ---- New sample order ----------------------------------------------------------------------------------------------------

  const loadChoices = useCallback(() => {
    if (!can.manage || !companyId) return
    setAdd((current) => (current ? { ...current, choices: { status: 'loading' } } : current))
    readChoices(api, companyId).then(
      (value: Choices) => setAdd((current) => (current ? { ...current, choices: { status: 'ready', value }, draft: withDefaults(current.draft, value) } : current)),
      (error: unknown) => setAdd((current) => (current ? { ...current, choices: { status: 'error', problem: readProblemOf(error) } } : current)),
    )
  }, [api, can.manage, companyId])

  useEffect(() => {
    if (!address.add) {
      setAdd(null)
      return
    }
    if (add) return
    setAdd({ draft: emptyDraft(today), choices: can.manage && companyId ? { status: 'loading' } : { status: 'error', problem: 'problem.forbidden' }, busy: false, problem: null })
  }, [address.add])
  const opened = add !== null
  useEffect(() => {
    if (opened) loadChoices()
  }, [opened, loadChoices])

  const choicesOf = (state: NewState | null): Choices | null => (state?.choices.status === 'ready' ? state.choices.value : null)
  const setLine = (key: string, change: (line: LineDraft, choices: Choices | null) => LineDraft) =>
    setAdd((current) => (current ? { ...current, problem: null, draft: { ...current.draft, lines: current.draft.lines.map((line) => (line.key === key ? change(line, choicesOf(current)) : line)) } } : current))

  const create = async () => {
    if (!add || !companyId) return
    if (createHeld({ draft: add.draft, choices: choicesOf(add), can, companyId, busy: add.busy, today })) return
    setAdd({ ...add, busy: true, problem: null })
    try {
      const order = await createSampleOrder(api, bodyOf(add.draft, companyId), newIdempotencyKey())
      setAdd(null)
      setNotice({ tone: 'success', key: 'notice.drafted', params: { number: order.number }, orderId: order.id })
      go({ add: false })
      void readNow()
    } catch (error) {
      setAdd((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
    }
  }

  // ---- live --------------------------------------------------------------------------------------------------------------------

  const readRef = useRef(readNow)
  readRef.current = readNow
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flush = useCallback(() => {
    if (timer.current) return
    timer.current = setTimeout(() => {
      timer.current = null
      void readRef.current()
    }, 800)
  }, [])
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])
  useLiveBus(
    {
      onChange: (change) => {
        if (can.view && isOrdersChange(change)) flush()
      },
      onReconnect: () => {
        if (can.view) flush()
      },
    },
    can.view,
  )

  return (
    <SourcingPageView
      model={{
        prefix,
        can,
        companyId,
        address,
        today,
        orders: can.view ? orders : { status: 'loading' },
        more,
        moreBusy,
        notice,
        selected,
        add,
      }}
      actions={{
        onAddress: go,
        onRetry: () => {
          setOrders({ status: 'loading' })
          void readNow()
        },
        onMore: () => void readMore(),
        onDismissNotice: () => setNotice(null),
        onSelected: setSelected,
        onOpenRecord: (orderId) => router.push(recordHref(prefix, orderId)),
        onDraft: (draft) => setAdd((current) => (current ? { ...current, draft, problem: null } : current)),
        onStyle: (styleId) => setAdd((current) => (current ? { ...current, problem: null, draft: withStyle(current.draft, styleId, choicesOf(current)) } : current)),
        onLine: (key, line) => setLine(key, () => line),
        onLineWhat: (key, what: SampleLineKind) => setLine(key, (line, choices) => withWhat(line, what, choices)),
        onLineMaterial: (key, itemId) => setLine(key, (line, choices) => withMaterial(line, materialOf(choices, itemId))),
        onAddLine: () =>
          setAdd((current) => {
            if (!current || !mayAddLine(current.draft)) return current
            const last = current.draft.lines.at(-1)
            return { ...current, draft: { ...current.draft, lines: [...current.draft.lines, newLine(last?.needDate || today, last?.what ?? 'SWATCH')] } }
          }),
        onRemoveLine: (key) => setAdd((current) => (current && current.draft.lines.length > 1 ? { ...current, problem: null, draft: { ...current.draft, lines: current.draft.lines.filter((line) => line.key !== key) } } : current)),
        onRetryChoices: loadChoices,
        onCreate: () => void create(),
      }}
    />
  )
}
