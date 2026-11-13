'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { getPriceList, getVersion, type PriceListDetail, type VersionAnswer } from '../api'
import { readRules, type VersionRules } from '../depth/api'
import { abilitiesOf, versionToShow } from '../model'
import { readProblem } from '../problems'
import { PriceListPrintView } from './view/PriceListPrintView'

interface PrintRead {
  list: PriceListDetail | null
  prices: VersionAnswer | null
  rules: VersionRules | null
  problem: string | null
}

const EMPTY: PrintRead = { list: null, prices: null, rules: null, problem: null }

/**
 * `/w/<company>/sales/price-lists/<id>/print?version=<id>` (SCR-420, design tab:pricelists.pdf "Sent to a customer or
 * printed for a fair"): reads the list, the version asked (else the draft, else the one in force), its prices with their
 * days and its breaks and surcharges, one after another; the browser prints it or saves it as a PDF. Prices need the price
 * grain (held in words otherwise).
 */
export function PriceListPrint({ listId }: { listId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const pathname = usePathname()
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  const asked = params?.get('version') ?? null
  const [at] = useState(() => new Date().toISOString())
  const [read, setRead] = useState<PrintRead>(EMPTY)

  useEffect(() => {
    if (!can.view || !can.price) return
    let live = true
    setRead(EMPTY)
    void (async () => {
      try {
        const list = await getPriceList(api, listId)
        const version = versionToShow(list, asked)
        if (!version) {
          if (live) setRead({ ...EMPTY, list })
          return
        }
        const prices = await getVersion(api, listId, version.id)
        const rules = await readRules(api, listId, version.id)
        if (live) setRead({ list, prices, rules, problem: null })
      } catch (error) {
        if (live) setRead({ ...EMPTY, problem: readProblem(error) })
      }
    })()
    return () => {
      live = false
    }
  }, [api, can.view, can.price, listId, asked])

  return (
    <PriceListPrintView
      model={{
        person: session.user.displayName,
        at,
        company: session.company?.name ?? '',
        can,
        back: `${pathname.replace(/\/print\/?$/, '')}${asked ? `?tab=prices&version=${encodeURIComponent(asked)}` : ''}`,
        ...read,
      }}
    />
  )
}
