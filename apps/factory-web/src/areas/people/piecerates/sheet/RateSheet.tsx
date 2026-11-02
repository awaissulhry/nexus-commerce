'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useOfficeScope } from '../../../../shell/scope/scope-context'
import { readRates, readVersion } from '../api'
import { pieceCan, problemWords } from '../model'
import type { Read } from '../view-model'
import { RateSheetView, type SheetTable } from './view/RateSheetView'

/**
 * `/w/<company>/people/piecerates/rate-sheet?version=<id>` one version, `?site=<id>` the rates in force and to come of a site
 * (SCR-158 tab:rate-sheet). No person is read; the browser prints it.
 */
export function RateSheet() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const params = useSearchParams()
  const can = useMemo(() => pieceCan(session.permissions), [session.permissions])
  const version = params?.get('version') ?? null
  const siteId = params?.get('site') ?? scope.siteId
  const [sheet, setSheet] = useState<Read<readonly SheetTable[]>>({ status: 'loading' })
  const [site, setSite] = useState(scope.site?.name ?? '')
  const allowed = can.view && can.pay
  useEffect(() => {
    if (!allowed) return
    let live = true
    const read = async (): Promise<readonly SheetTable[]> => {
      if (version) {
        const detail = await readVersion(api, version)
        setSite(detail.site.name)
        const { table } = detail
        return [{ key: table.id, title: `${table.code} · ${table.name}`, subtitle: table.style ? `${table.style.code} · ${table.style.name}` : (table.line?.name ?? ''), versionNo: detail.version.versionNo, effectiveFrom: detail.version.effectiveFrom, effectiveTo: detail.version.effectiveTo, provisionalUntil: detail.version.state === 'PROVISIONAL' ? detail.version.trialEndsOn : null, currency: table.currency, rates: detail.rates.map((rate) => ({ id: rate.id, operation: `${rate.operation.code} · ${rate.operation.name}`, sizeBand: rate.sizeBand, basis: rate.basis, standardMinutes: rate.standardMinutes, ratePerMinute: rate.ratePerMinute ?? null, ratePerPiece: rate.ratePerPiece ?? null })) }]
      }
      if (!siteId) return []
      const page = await readRates(api, siteId, 'CURRENT')
      const tables = new Map<string, SheetTable>()
      for (const row of page.rows) {
        if (row.version.status === 'DRAFT') continue
        const before = tables.get(row.version.id)
        const rate = { id: row.rate.id, operation: `${row.rate.operation.code} · ${row.rate.operation.name}`, sizeBand: row.rate.sizeBand, basis: row.rate.basis, standardMinutes: row.rate.standardMinutes, ratePerMinute: row.rate.ratePerMinute ?? null, ratePerPiece: row.rate.ratePerPiece ?? null }
        tables.set(row.version.id, before ? { ...before, rates: [...before.rates, rate] } : { key: row.version.id, title: `${row.table.code} · ${row.table.name}`, subtitle: row.style ? `${row.style.code} · ${row.style.name}` : (row.line?.name ?? ''), versionNo: row.version.versionNo, effectiveFrom: row.version.effectiveFrom, effectiveTo: row.version.effectiveTo, provisionalUntil: row.version.state === 'PROVISIONAL' ? row.version.trialEndsOn : null, currency: row.table.currency, rates: [rate] })
      }
      return [...tables.values()]
    }
    read().then((value) => live && setSheet({ status: 'ready', value }), (error) => live && setSheet({ status: 'failed', problem: problemWords(error) }))
    return () => {
      live = false
    }
  }, [api, allowed, version, siteId])
  return <RateSheetView model={{ allowed, company: session.company?.name ?? '', site, printedAt: new Date().toISOString(), sheet }} />
}
