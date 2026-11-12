'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { DEFAULT_TIME_ZONE } from '../../../../lib/i18n/format'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { readProblem, writeProblem } from '../../../_shared/buying/model'
import { useLive } from '../../../_shared/buying/hooks'
import { cancelAsked, listAsked, type AskedRequest } from './api'
import { useAskToBuy } from './AskToBuy'
import { askCan, type MineModel } from './model'
import { MyRequests } from './view/MyRequests'

/**
 * Purchasing › Requests to buy for a person who asks but does not buy (purchasing.requests.ask without purchasing.view,
 * B-W2b-332): "Ask to buy" and one's own requests (GET /purchasing/ask-to-buy?mine=true&status=ALL), "Take back n" with
 * the reason (ONE Idempotency-Key per dialog). Live purchase_requests.* read the list again.
 */
export function MineContainer({ prefix }: { prefix: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => askCan(session.permissions), [session.permissions])
  const [rows, setRows] = useState<MineModel['rows']>({ items: null, more: false, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [takeBack, setTakeBack] = useState<MineModel['takeBack']>(null)
  const [offline, setOffline] = useState(false)
  const key = useRef(newIdempotencyKey())
  const read = useRef(0)

  useEffect(() => {
    const update = () => setOffline(typeof navigator !== 'undefined' && navigator.onLine === false)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  const load = useCallback(async () => {
    if (!can.ask) return
    const id = ++read.current
    try {
      const page = await listAsked(api, { mine: true, status: 'ALL' })
      if (id !== read.current) return
      setRows({ items: page.requests, more: page.nextCursor !== null, problem: null })
      setCursor(page.nextCursor)
    } catch (error) {
      if (id !== read.current) return
      setRows({ items: null, more: false, problem: readProblem(error) })
    }
  }, [api, can.ask])
  useEffect(() => {
    void load()
  }, [load])
  useLive(
    (change) => {
      if (change.type.startsWith('purchase_requests.')) void load()
    },
    () => void load(),
    can.ask,
  )

  const more = useCallback(async () => {
    if (!cursor) return
    try {
      const page = await listAsked(api, { mine: true, status: 'ALL', cursor })
      setRows((current) => ({ ...current, items: [...(current.items ?? []), ...page.requests.filter((row) => !current.items?.some((seen) => seen.id === row.id))], more: page.nextCursor !== null }))
      setCursor(page.nextCursor)
    } catch (error) {
      setRows((current) => ({ ...current, problem: readProblem(error) }))
    }
  }, [api, cursor])

  const ask = useAskToBuy({ api, prefix, permissions: session.permissions, onAsked: () => void load() })

  const confirm = useCallback(async () => {
    if (!takeBack || takeBack.busy || takeBack.reason.trim() === '') return
    const picked = (rows.items ?? []).filter((row: AskedRequest) => takeBack.ids.includes(row.id) && row.cancel.allowed)
    setTakeBack({ ...takeBack, busy: true, problem: null })
    try {
      await cancelAsked(api, { requests: picked.map((row) => ({ id: row.id, version: row.version })), reason: takeBack.reason.trim() }, key.current)
      setTakeBack(null)
      void load()
    } catch (error) {
      key.current = newIdempotencyKey()
      setTakeBack((current) => (current ? { ...current, busy: false, problem: writeProblem(error) } : current))
      void load()
    }
  }, [api, load, rows.items, takeBack])

  const model: MineModel = { prefix, can, rows, offline, timeZone: DEFAULT_TIME_ZONE, takeBack }
  return (
    <>
      <MyRequests
        model={model}
        actions={{
          onAsk: () => ask.open(null),
          onRetry: () => void load(),
          onMore: () => void more(),
          onTakeBack: (ids) => {
            if (ids.length === 0) return
            key.current = newIdempotencyKey()
            setTakeBack({ ids, reason: '', busy: false, problem: null })
          },
          takeBack: {
            onReason: (reason) => setTakeBack((current) => (current ? { ...current, reason } : current)),
            onConfirm: () => void confirm(),
            onClose: () => {
              if (takeBack?.busy) return
              setTakeBack(null)
            },
          },
        }}
      />
      {ask.element}
    </>
  )
}
