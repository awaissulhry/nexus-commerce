'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { problemKey } from '../../../quality/_shared/model'
import { getCr6, getExpiries, getGaps, getKpis, getRegister, type Cr6, type Expiries, type Gaps, type Kpis, type Register } from '../api'
import { reportsCan, reviewAddressOf, romeToday, yearRange } from '../model'
import { ReportsPrintView } from './view/ReportsPrintView'

interface PrintRead {
  kpis: Kpis | null
  gaps: Gaps | null
  expiries: Expiries | null
  cr6: Cr6 | null
  register: Register | null
  problem: string | null
}

const EMPTY: PrintRead = { kpis: null, gaps: null, expiries: null, cr6: null, register: null, problem: null }

/**
 * `/w/<company>/compliance/reports/print?year=&brand=` (SCR-307, design tab:cr-pdf "Annual compliance review (PDF)", for
 * management review and auditors): the five reads of Compliance reports for one calendar year (up to today while it runs), read
 * one after another; the browser prints it or saves it as a PDF. Another year is picked in the strip.
 */
export function ReportsPrint() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const can = useMemo(() => reportsCan(session.permissions), [session.permissions])
  const [today] = useState(() => romeToday())
  const address = useMemo(() => reviewAddressOf(params, today), [params, today])
  const range = useMemo(() => yearRange(address.year, today), [address.year, today])
  const [at] = useState(() => new Date().toISOString())
  const [read, setRead] = useState<PrintRead>(EMPTY)

  useEffect(() => {
    if (!can.view) return
    let live = true
    setRead(EMPTY)
    const scope = { from: range.from, to: range.to, brandId: address.brandId }
    void (async () => {
      try {
        const kpis = await getKpis(api, scope)
        const gaps = await getGaps(api, scope)
        const expiries = await getExpiries(api, scope)
        const cr6 = await getCr6(api, scope)
        const register = await getRegister(api, scope)
        if (live) setRead({ kpis, gaps, expiries, cr6, register, problem: null })
      } catch (error) {
        if (live) setRead({ ...EMPTY, problem: problemKey(error) })
      }
    })()
    return () => {
      live = false
    }
  }, [api, can.view, range.from, range.to, address.brandId])

  return (
    <ReportsPrintView
      model={{ person: session.user.displayName, at, company: session.company?.name ?? '', can: can.view, year: address.year, today, range, back: pathname.replace(/\/print\/?$/, ''), ...read }}
      actions={{ onYear: (year) => router.replace(`${pathname}?year=${year}${address.brandId ? `&brand=${encodeURIComponent(address.brandId)}` : ''}`, { scroll: false }) }}
    />
  )
}
