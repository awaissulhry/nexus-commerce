'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { useLiveBus } from '../../../../shell/live/use-live'
import { createTransfer, listTransfers, readOptions, type TransferList, type TransferOptions } from '../api'
import { addressOf, addressText, emptyNewDraft, fieldOfPath, HOME_ADDRESS, newBodyOf, readProblem, recordHref, sendingSites, transfersCan, writeProblem, type ListAddress, type Notice } from '../model'
import { TransfersMessages } from '../parts'
import type { NewTransferModel } from './view/NewTransferDialog'
import { TransfersListView } from './view/TransfersListView'

/**
 * `/w/<company>/warehouse/transfers` (SCR-360; design warehouse.transfers, SCR-133): the tiles (In transit, Arriving today,
 * With differences: the API's saved filters), the transfers on the shared list frame, the filters in the address (`?tile=`,
 * `?status=`, `?from=`, `?to=`, `?q=`). New transfer (`c`, `?new=1`) makes the draft and opens it. Live
 * `inventory.transfer_changed` and `inventory.moved` changes: "N updates · Show".
 */
export function TransfersPage() {
  return (
    <TransfersMessages>
      <Container />
    </TransfersMessages>
  )
}

const LIVE_TYPES = ['inventory.transfer_changed', 'inventory.moved'] as const

function Container() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = useMemo(() => transfersCan(session.permissions), [session.permissions])
  const address = useMemo(() => addressOf(params), [params])
  const go = useCallback((next: Partial<ListAddress>) => router.replace(`${pathname}${addressText({ ...address, ...next })}`, { scroll: false }), [router, pathname, address])

  const [list, setList] = useState<TransferList | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [options, setOptions] = useState<TransferOptions | null>(null)
  const readId = useRef(0)
  const query = useMemo(() => ({ tile: address.tile, status: address.status, fromSiteId: address.from, toSiteId: address.to, q: address.q }), [address.tile, address.status, address.from, address.to, address.q])

  const load = useCallback(async () => {
    if (!can.view) return
    const id = ++readId.current
    setProblem(null)
    try {
      const answer = await listTransfers(api, query)
      if (id !== readId.current) return
      setList(answer)
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (id === readId.current) setProblem(readProblem(error))
    }
  }, [api, can.view, query])

  useEffect(() => {
    setList(null)
    void load()
  }, [load])

  useEffect(() => {
    if (!can.view) return
    const controller = new AbortController()
    readOptions(api, controller.signal)
      .then(setOptions)
      .catch(() => setOptions(null))
    return () => controller.abort()
  }, [api, can.view])

  const live = useLiveBus(
    {
      onChange: (change) => {
        if (LIVE_TYPES.some((type) => change.type === type)) setUpdates((count) => count + 1)
      },
      onReconnect: () => void load(),
    },
    can.view,
  )
  const offline = live === 'offline'

  // ---- New transfer ------------------------------------------------------------------------------------------------------
  const [created, setCreated] = useState<NewTransferModel | null>(null)
  const newKey = useRef<string | null>(null)
  useEffect(() => {
    if (!address.isNew || !can.view) {
      setCreated(null)
      return
    }
    newKey.current = null
    const from = options ? sendingSites(options.sites) : []
    setCreated({ draft: emptyNewDraft(from.length === 1 ? from[0]!.id : null), sites: options?.sites ?? null, busy: false, notice: null, lines: [], offline: false })
    // The dialog opens once per `?new=1`; the sites arrive with the options.
  }, [address.isNew, can.view, options])

  const submitNew = useCallback(async () => {
    if (!created || created.busy) return
    setCreated({ ...created, busy: true, notice: null, lines: [] })
    newKey.current ??= newIdempotencyKey()
    try {
      const transfer = await createTransfer(api, newBodyOf(created.draft), newKey.current)
      newKey.current = null
      setCreated(null)
      router.push(recordHref(prefix, transfer.id))
    } catch (error) {
      const refused = writeProblem(error)
      if (!refused.stale) newKey.current = null
      setCreated((now) => (now ? { ...now, busy: false, notice: { ...refused, tone: 'danger' }, lines: [...new Set(refused.paths.map(fieldOfPath))].map((key) => ({ key })) } : now))
    }
  }, [created, api, router, prefix])

  return (
    <TransfersListView
      model={{
        prefix,
        can,
        address,
        list,
        problem,
        sites: options?.sites ?? null,
        asOf,
        live,
        updates,
        notice,
        created: created ? { ...created, offline } : null,
      }}
      actions={{
        onAddress: (patch) => go(patch),
        onClearFilters: () => go(HOME_ADDRESS),
        onRetry: () => void load(),
        onShowUpdates: () => void load(),
        onOpen: (id) => router.push(recordHref(prefix, id)),
        onNew: () => go({ isNew: true }),
        created: {
          onDraft: (patch) => setCreated((now) => (now ? { ...now, draft: { ...now.draft, ...patch } } : now)),
          onSubmit: () => void submitNew(),
          onClose: () => {
            setCreated(null)
            go({ isNew: false })
          },
        },
        onCopy: (numbers) => {
          void navigator.clipboard
            ?.writeText(numbers.join('\n'))
            .then(() => setNotice({ key: 'list.copied', params: { count: numbers.length }, tone: 'success' }))
            .catch(() => undefined)
        },
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
