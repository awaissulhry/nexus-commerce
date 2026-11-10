'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { problemKey } from '../../../quality/_shared/model'
import { getActions, getBoard, getExpiries, getFeed, type Actions, type Board, type Expiries, type Feed } from '../api'
import { boardQueryOf, romeDay, statusAddressOf, statusAddressText, statusCan } from '../model'
import { StatusPrintView } from './view/StatusPrintView'

interface PrintRead {
  board: Board | null
  actions: Actions | null
  feed: Feed | null
  expiries: Expiries | null
  problem: string | null
}

const EMPTY: PrintRead = { board: null, actions: null, feed: null, expiries: null, problem: null }

/**
 * `/w/<company>/compliance/status/print?markets=&brand=&gap=&status=&q=` (SCR-314, design tab:cs-print "Status board (print)",
 * for a management review): the board's reads with the filters of the page that opened it, one after another; the browser
 * prints it or saves it as a PDF.
 */
export function StatusPrint() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const pathname = usePathname()
  const can = useMemo(() => statusCan(session.permissions), [session.permissions])
  const address = useMemo(() => statusAddressOf(params), [params])
  const query = useMemo(() => boardQueryOf(address), [address])
  const queryKey = JSON.stringify(query)
  const [at] = useState(() => new Date().toISOString())
  const [read, setRead] = useState<PrintRead>(EMPTY)

  useEffect(() => {
    if (!can.view) return
    let live = true
    setRead(EMPTY)
    void (async () => {
      try {
        const board = await getBoard(api, query)
        const actions = await getActions(api, query)
        const feed = await getFeed(api, { days: 7 })
        const expiries = await getExpiries(api, 12)
        if (live) setRead({ board, actions, feed, expiries, problem: null })
      } catch (error) {
        if (live) setRead({ ...EMPTY, problem: problemKey(error) })
      }
    })()
    return () => {
      live = false
    }
    // queryKey stands for the query (the same words, a new object per address).
  }, [api, can.view, queryKey])

  const brand = address.brandId ? (read.board?.rows.find((row) => row.style.brand?.id === address.brandId)?.style.brand ?? null) : null
  return (
    <StatusPrintView
      model={{
        person: session.user.displayName,
        at,
        company: session.company?.name ?? '',
        can: can.view,
        address,
        today: romeDay(new Date(at)),
        back: `${pathname.replace(/\/print\/?$/, '')}${statusAddressText(address)}`,
        ...read,
        brandName: brand ? `${brand.code} · ${brand.name}` : null,
      }}
    />
  )
}
