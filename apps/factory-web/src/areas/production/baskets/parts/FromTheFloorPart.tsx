'use client'

import { useCallback, useEffect, useState } from 'react'
import type { PromiseReasonCode } from '@nexus/factory-domain/sales/portal-orders/promise'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import { useT } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { changePromise, getOrder } from '../../../sales/orders/api'
import { answerLate, readFromTheFloor, sharePhoto, type FromTheFloor } from '../api'
import { BASKETS_NAMESPACE, BASKETS_NAMESPACES } from '../model'
import { FromTheFloorView } from './from-the-floor/FromTheFloorView'
import { mayAnswerLate, mayShare, promiseReasonFor, proposedPromise } from './from-the-floor/model'
import { PromiseWindow, type PromiseWindowModel } from './from-the-floor/PromiseWindow'

/**
 * SLOT — owner: S5 (owb-fl9); placed by the base (owb-b5 w5.5) with its FINAL export name and props, filled by fl9 step 4: the part
 * "From the floor" (floor photos with Share with the customer / Keep inside, Changed on the floor, Will be late with The date holds /
 * Change the promise…). MOUNTED by the base in the office order page's Production tab (areas/sales/orders/record/view/ProductionTab.tsx),
 * right after Work orders (the baskets). Office only: the customer never reaches it.
 */
export interface FromTheFloorPartProps {
  /** The company the page works in (the session's). */
  readonly companyId: string
  /** The order (SalesOrder id). */
  readonly orderId: string
}

export function FromTheFloorPart(props: FromTheFloorPartProps) {
  return (
    <WithMessages namespaces={BASKETS_NAMESPACES}>
      <Part {...props} />
    </WithMessages>
  )
}

const problemOf = (error: unknown, fallback: string): string => {
  if (!isApiError(error)) return fallback
  const refusal = error.issues.find((issue) => issuePath(issue).startsWith('refusal/'))
  return refusal?.message || fallback
}

function Part({ orderId }: FromTheFloorPartProps) {
  const t = useT(BASKETS_NAMESPACE)
  const api = useOfficeApi()
  const { permissions } = useOfficeSession()
  const [read, setRead] = useState<FromTheFloor | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [kept, setKept] = useState<readonly string[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [promise, setPromise] = useState<(PromiseWindowModel & { lateId: string; version: number | null }) | null>(null)

  const load = useCallback(() => {
    readFromTheFloor(api, orderId)
      .then((value) => {
        setRead(value)
        setState('ready')
      })
      .catch(() => setState('failed'))
  }, [api, orderId])

  useEffect(() => load(), [load])

  const run = async (key: string, work: () => Promise<unknown>) => {
    if (busy) return
    setBusy(key)
    setProblem(null)
    try {
      await work()
      load()
    } catch (error) {
      setProblem(problemOf(error, t('window.failed')))
    } finally {
      setBusy(null)
    }
  }

  const openPromise = async (lateId: string) => {
    const late = read?.late.find((row) => row.id === lateId)
    if (!late) return
    setPromise({ lateId, version: null, current: null, date: '', reason: promiseReasonFor(late.reason), busy: true, problem: null })
    try {
      const order = await getOrder(api, orderId)
      setPromise((now) => (now && now.lateId === lateId ? { ...now, version: order.version, current: order.promiseDate, date: proposedPromise(order.promiseDate, late.days), busy: false } : now))
    } catch (error) {
      setPromise((now) => (now ? { ...now, busy: false, problem: problemOf(error, t('promise.readFailed')) } : now))
    }
  }

  const savePromise = async () => {
    const now = promise
    if (!now || now.busy || now.date === '' || now.version === null) return
    setPromise({ ...now, busy: true, problem: null })
    try {
      await changePromise(api, orderId, { version: now.version, promiseDate: now.date, reasonCode: now.reason })
      await answerLate(api, now.lateId, 'CHANGED')
      setPromise(null)
      load()
    } catch (error) {
      setPromise({ ...now, busy: false, problem: problemOf(error, t('window.failed')) })
    }
  }

  return (
    <>
      <FromTheFloorView
        model={{ state, read, canShare: mayShare(permissions), canAnswer: mayAnswerLate(permissions), keptInside: kept, busy, problem }}
        actions={{
          onShare: (fileId) => void run(fileId, () => sharePhoto(api, fileId, orderId)),
          onKeep: (fileId) => setKept((now) => (now.includes(fileId) ? now : [...now, fileId])),
          onHolds: (lateId) => void run(lateId, () => answerLate(api, lateId, 'KEPT')),
          onChange: (lateId) => void openPromise(lateId),
        }}
      />
      {promise ? (
        <PromiseWindow
          model={promise}
          onDate={(date) => setPromise((now) => (now ? { ...now, date } : now))}
          onReason={(reason: PromiseReasonCode) => setPromise((now) => (now ? { ...now, reason } : now))}
          onSave={() => void savePromise()}
          onClose={() => (promise.busy ? undefined : setPromise(null))}
        />
      ) : null}
    </>
  )
}
