'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { useLiveBus } from '../../../../shell/live/use-live'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { useOfficeScope } from '../../../../shell/scope/scope-context'
import { fetchWaiting, nudge, nudgeProblem, waitingProblem } from './api'
import { rowOf, type WaitingModel, type WaitingRow } from './model'
import { WaitingOnView } from './view/WaitingOnView'

/**
 * Today › Waiting on others, the container (B-W2b-388): reads what I wait on (GET /home/waiting-on-others, the top bar's site)
 * when Today opens, when the site changes and on the events its kinds name (`live.events`), and nudges an approval I asked for.
 * Today mounts it in its section list.
 */
export function WaitingOn() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const prefix = companyPrefix(session.company?.code ?? '')
  const [rows, setRows] = useState<WaitingModel['rows']>({ status: 'loading' })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<WaitingModel['notice']>(null)
  const [now, setNow] = useState(() => Date.now())
  const events = useRef<ReadonlySet<string>>(new Set())

  const load = useCallback(async () => {
    try {
      const answer = await fetchWaiting(api, { siteId: scope.siteId })
      events.current = new Set(answer.live.events)
      setRows({ status: 'ready', data: { items: answer.items.map((item) => rowOf(item, prefix, OFFICE_PAGES)), asOf: answer.asOf } })
      setNow(Date.now())
    } catch (error) {
      setRows({ status: 'error', problem: waitingProblem(error) })
    }
  }, [api, prefix, scope.siteId])
  useEffect(() => {
    void load()
  }, [load])
  const live = useLiveBus({ onChange: (change) => events.current.has(change.type) && void load(), onReconnect: () => void load() })

  const model = useMemo<WaitingModel>(() => ({ rows, now, held: live === 'offline' ? 'held.offline' : busy ? 'held.busy' : null, notice }), [rows, now, live, busy, notice])
  return (
    <WaitingOnView
      model={model}
      actions={{
        onNudge: (row: WaitingRow) => {
          setBusy(true)
          nudge(api, row)
            .then((told) => setNotice({ key: 'waiting.nudge.done', tone: 'success', params: { record: row.record.label, count: told } }))
            .catch((error: unknown) => setNotice({ key: nudgeProblem(error), tone: 'warning' }))
            .finally(() => {
              setBusy(false)
              void load()
            })
        },
        onRetry: () => void load(),
      }}
    />
  )
}
