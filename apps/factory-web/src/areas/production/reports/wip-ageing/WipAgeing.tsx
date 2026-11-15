'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { recordAddress } from '../../../../lib/records/record-links'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { useLiveBus } from '../../../../shell/live/use-live'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { getWipAgeing } from './api'
import { wipAgeingAllowed, wipProblem } from './model'
import { WipAgeingPanel, type WipAgeingModel } from './view/WipAgeingPanel'

/** The floor events after which the WIP may have moved (read again at most once a minute: design "at most once a minute"). */
const MOVES = new Set(['production.scan_recorded', 'workorder.status_changed', 'workorder.released'])
const QUIET_MS = 60_000

/**
 * Production › Reports › WIP ageing, the container (B-W2b-435; ANA-015): reads the metric layer's WIP drill of the report's site
 * (GET /insights/kpis/drills/wip?siteId) when the site changes, and again after the floor reports work (at most once a minute).
 * Absent for a person without the KPI library or the production reports (the drill's own rights: the section is not drawn).
 */
export function WipAgeing({ siteId, siteCode }: { readonly siteId: string; readonly siteCode: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const allowed = wipAgeingAllowed(session.permissions)
  const prefix = companyPrefix(session.company?.code ?? '')
  const [read, setRead] = useState<WipAgeingModel['read']>({ status: 'loading' })
  const [now, setNow] = useState(() => Date.now())
  const last = useRef(0)

  const load = useCallback(async () => {
    if (!allowed) return
    last.current = Date.now()
    try {
      setRead({ status: 'ready', data: await getWipAgeing(api, siteId) })
      setNow(Date.now())
    } catch (error) {
      setRead({ status: 'error', problem: wipProblem(error) })
    }
  }, [api, siteId, allowed])
  useEffect(() => {
    setRead({ status: 'loading' })
    void load()
  }, [load])
  useLiveBus({ onChange: (change) => MOVES.has(change.type) && Date.now() - last.current > QUIET_MS && void load(), onReconnect: () => void load() }, allowed)

  const hrefs = useMemo(() => (read.status === 'ready' ? Object.fromEntries(read.data.rows.map((row) => [row.record.id, `${prefix}${recordAddress(row.record, OFFICE_PAGES)}`])) : {}), [read, prefix])
  if (!allowed) return null
  return <WipAgeingPanel model={{ read, site: siteCode, hrefs, now }} actions={{ onRetry: () => void load() }} />
}
