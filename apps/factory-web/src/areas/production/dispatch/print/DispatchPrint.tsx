'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useOfficeScope } from '../../../../shell/scope/scope-context'
import { getBoard, getPaper, type DispatchPaper } from '../api'
import { addressOf, printAddressOf, readProblemOf } from '../model'
import { DispatchPrintView, type DispatchPrintModel } from './view/DispatchPrintView'

/**
 * `/w/<company>/production/dispatch/print?line=&line=&station=&date=` (SCR-138-print; design production.dispatch tab:dp-tab-list
 * "Dispatch list per station or line (print)", paper for the line at shift start): each line's or the station's paper, read
 * once in the page's language, drawn for paper. Opened in a new tab from the board; the shell's band Print names no line, so
 * every line of the site's board prints.
 */
export function DispatchPrint() {
  const api = useOfficeApi()
  const locale = useLocale()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const params = useSearchParams()
  const query = params?.toString() ?? ''
  const address = useMemo(() => printAddressOf(new URLSearchParams(query)), [query])
  const [read, setRead] = useState<DispatchPrintModel>({ papers: null, problem: null })
  const site = addressOf(new URLSearchParams(query)).site
  const siteOf = useCallback(() => scope.siteId ?? site ?? scope.sites[0]?.id ?? session.sites[0]?.id ?? null, [scope.siteId, scope.sites, session.sites, site])
  useEffect(() => {
    let live = true
    /** The band's Print names nothing: every line of the site on the board. */
    const lines = async (): Promise<readonly string[]> => {
      if (address.lines.length > 0) return address.lines
      const siteId = siteOf()
      if (!siteId) return []
      return (await getBoard(api, { siteId, date: address.date })).lines.map((line) => line.id)
    }
    const asks = async () => (address.station ? [{ lineId: null, stationId: address.station }] : (await lines()).map((lineId) => ({ lineId, stationId: null })))
    asks()
      .then((list) => Promise.all(list.map((ask) => getPaper(api, { ...ask, date: address.date, language: locale }))))
      .then((papers: DispatchPaper[]) => live && setRead(papers.length > 0 ? { papers, problem: null } : { papers: null, problem: 'error.noTarget' }))
      .catch((error: unknown) => live && setRead({ papers: null, problem: readProblemOf(error) }))
    return () => {
      live = false
    }
  }, [api, address, locale, siteOf])
  return <DispatchPrintView model={read} />
}
