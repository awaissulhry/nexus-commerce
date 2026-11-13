'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { buyingCan, phrase, readProblem, todayIn, writeProblem, type Loaded, type Phrase } from '../../../_shared/buying/model'
import { expectedLines, getReceipt, recordReceipt, type ExpectedLine, type Receipt, type Recorded } from '../api'
import { receiptBody, receiveDraft, type ReceiveDraft } from '../model'
import { ReceiveView } from './view/ReceiveView'
// B-W2b-182 (SCM-106): the form filled from a supplier's ship notice (`?notice=`).
import { readOfficeNotice } from '../inbound/api'
import { draftFromNotice } from '../inbound/model'
// B-W2b-382 (B-W2b-377's 202): a receipt beyond its tolerance waits for a yes: said so, Cancel, posted live after the last yes.
import { useLive } from '../../../_shared/buying/hooks'
import { noApproverOf } from '../held/model'
import { useHeldReceipt } from '../held/use-held-receipt'

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
  const noticeId = params?.get('notice') ?? null

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
        // B-W2b-182: filled from the ship notice when it still takes goods (else the order's open lines, and why).
        const notice = noticeId && own.length > 0 ? await readOfficeNotice(api, noticeId).catch(() => null) : null
        if (noticeId && own.length > 0 && notice?.prefill?.purchaseOrderId === orderId && notice.canReceive) setDraft(draftFromNotice(orderId, own, notice.prefill))
        else setDraft(own.length > 0 ? receiveDraft(orderId, own, only) : null)
        if (own.length === 0) setProblem(phrase('rc.receive.nothingOpen'))
        else if (noticeId && !(notice?.prefill?.purchaseOrderId === orderId && notice.canReceive)) setProblem(phrase('rc.receive.noticeHeld'))
      } else setDraft(null)
    } catch (error) {
      setOrders({ status: 'error', problem: readProblem(error) })
    }
  }, [api, can.receive, orderId, only, noticeId])

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
          if (noApproverOf(paths)) return phrase('rc.refusal.noApprover')
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

  // B-W2b-382: the held receipt's own part; a live change of it (its yes, a post, a cancel elsewhere) reads it again.
  const recorded = result?.receipt ?? null
  const setRecorded = useCallback((receipt: Receipt) => setResult((current) => (current ? { ...current, receipt } : current)), [])
  const rereadRecorded = useCallback(() => {
    if (!recorded) return
    getReceipt(api, recorded.id)
      .then(setRecorded)
      .catch(() => undefined)
  }, [api, recorded, setRecorded])
  const live = useLive(
    (change) => {
      if (recorded && recorded.status === 'OPEN' && change.fields.receiptId === recorded.id) rereadRecorded()
    },
    rereadRecorded,
    recorded !== null && (result?.held.length ?? 0) > 0,
  )
  const held = useHeldReceipt({
    api,
    receipt: result && result.held.length > 0 ? recorded : null,
    held: result?.held ?? [],
    prefix,
    timeZone: TIME_ZONE,
    receive: can.receive,
    approvalsView: session.permissions.includes('approvals.view'),
    offline: live === 'offline',
    onReceipt: setRecorded,
    onReload: rereadRecorded,
  })

  return (
    <ReceiveView
      model={{ prefix, can, orders, draft, posting, problem, result, timeZone: TIME_ZONE, today: todayIn(TIME_ZONE), held: held.model }}
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
        held: held.actions,
      }}
    />
  )
}
