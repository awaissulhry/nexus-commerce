'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { buyingCan, phrase, readProblem, todayIn, writeProblem, type Loaded, type Phrase } from '../../../_shared/buying/model'
import { expectedLines, recordReceipt, type ExpectedLine, type Recorded } from '../api'
import { receiptBody, receiveDraft, type ReceiveDraft } from '../model'
import { ReceiveView } from './view/ReceiveView'

const TIME_ZONE = 'Europe/Rome'

/**
 * `/w/<company>/warehouse/receipts/new` (`?order=<id>`, `?lines=<order line ids>`): the order lines still to receive
 * (inventory.receive) — every order that takes goods when no order is named, else that order's lines as the form —
 * and Post receipt: ONE call that records the receipt, its lots and hides and posts their moves (the API numbers them
 * from the series). One Idempotency-Key per form, so a double click posts once. The form is kept in memory only: the
 * page warns before it is left with unposted work.
 */
export function ReceivePage() {
  return (
    <WithMessages namespaces={['buying', 'lists']}>
      <ReceiveContainer />
    </WithMessages>
  )
}

function ReceiveContainer() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/warehouse\/receipts\/new\/?$/, '')
  const can = useMemo(() => buyingCan(session.permissions), [session.permissions])
  const orderId = params?.get('order') ?? null
  const only = useMemo(() => (params?.get('lines') ?? '').split(',').filter(Boolean), [params])

  const [orders, setOrders] = useState<Loaded<ExpectedLine[]>>({ status: 'loading' })
  const [draft, setDraft] = useState<ReceiveDraft | null>(null)
  const [posting, setPosting] = useState(false)
  const [problem, setProblem] = useState<Phrase | null>(null)
  const [result, setResult] = useState<Recorded | null>(null)
  const key = useRef(newIdempotencyKey())
  const dirty = useRef(false)

  const load = useCallback(async () => {
    if (!can.receive) return
    setOrders({ status: 'loading' })
    try {
      const lines = await expectedLines(api, { purchaseOrderId: orderId })
      setOrders({ status: 'ready', value: lines })
      if (orderId) {
        const own = lines.filter((line) => line.purchaseOrderId === orderId)
        setDraft(own.length > 0 ? receiveDraft(orderId, own, only) : null)
        if (own.length === 0) setProblem(phrase('rc.receive.nothingOpen'))
      } else setDraft(null)
    } catch (error) {
      setOrders({ status: 'error', problem: readProblem(error) })
    }
  }, [api, can.receive, orderId, only])

  useEffect(() => {
    setResult(null)
    setProblem(null)
    key.current = newIdempotencyKey()
    void load()
  }, [load])

  // Unposted work: the browser asks before the page is left.
  useEffect(() => {
    const onLeave = (event: BeforeUnloadEvent) => {
      if (!dirty.current) return
      event.preventDefault()
    }
    window.addEventListener('beforeunload', onLeave)
    return () => window.removeEventListener('beforeunload', onLeave)
  }, [])

  const post = useCallback(async () => {
    if (!draft || posting) return
    setPosting(true)
    setProblem(null)
    try {
      const answer = await recordReceipt(api, receiptBody(draft, TIME_ZONE), key.current)
      dirty.current = false
      setResult(answer)
    } catch (error) {
      setProblem(
        writeProblem(error, (paths, info) => {
          if (paths.some((path) => path.includes('differenceReason'))) return phrase('rc.refusal.over')
          if (paths.some((path) => path.includes('/hides'))) return phrase('rc.refusal.hides')
          if (paths.some((path) => path.includes('/lots'))) return phrase('rc.refusal.lots')
          if (paths.some((path) => path.includes('receivedAt'))) return phrase('rc.refusal.receivedAt')
          if (info.kind === 'conflict' && isApiError(error) && /series/i.test(error.message)) return phrase('rc.refusal.series')
          if (info.kind === 'conflict') return phrase('rc.refusal.order')
          return null
        }),
      )
      // A refused receipt posted nothing: the same form may be sent again under a new key once it is fixed.
      key.current = newIdempotencyKey()
      if (isApiError(error) && error.kind === 'conflict') {
        expectedLines(api, { purchaseOrderId: draft.orderId })
          .then((lines) => setOrders({ status: 'ready', value: lines }))
          .catch(() => undefined)
      }
    } finally {
      setPosting(false)
    }
  }, [api, draft, posting])

  return (
    <ReceiveView
      model={{ prefix, can, orders, draft, posting, problem, result, timeZone: TIME_ZONE, today: todayIn(TIME_ZONE) }}
      actions={{
        onPickOrder: (id) => router.push(`${prefix}/warehouse/receipts/new?order=${encodeURIComponent(id)}`),
        onChange: (next) => {
          dirty.current = true
          setDraft(next)
        },
        onPost: () => void post(),
        onRetry: () => void load(),
        onAnother: () => {
          setResult(null)
          key.current = newIdempotencyKey()
          void load()
        },
      }}
    />
  )
}
