'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { WithMessages } from '../../../../record-panels/i18n'
import { useOfficeScope } from '../../../../shell/scope/scope-context'
import { askAnotherTeam, getOrderTeams, type OrderTeams } from '../api'
import { askHeldOf, ORDER_TEAMS_NS, partModelOf, problemKeyOf } from '../model'
import { useOfficeOrNull } from '../use-office'
import { useGiveWindow } from '../use-give'
import { AskTeamWindow } from '../view/AskTeamWindow'
import { GiveTeamsWindow } from '../view/GiveTeamsWindow'
import { OrderTeamPartView } from '../view/OrderTeamPartView'

/**
 * SLOT — owner: S3 (owb-ss7); filled by ss7 step 7.3 (the order's team part: its teams as TeamChips, Give to a team…, Ask for another team).
 * Placed by the base (owb-b5 w5.5) with its FINAL export name and props, so the owner edits only this file. Where: MOUNTED by the base in
 * the office order page's Production tab (areas/sales/orders/record/view/ProductionTab.tsx), after Order structure. Office only: the
 * customer never reaches it.
 *
 * owb-ss7 7.3 (design § 5za; prototype teams.js teamSec) — reads GET /production/orders/:orderId/teams (owb-ss5) and draws the part
 * "Team": the production manager (`may.give`) gives or changes the teams in "Give to a team…" (the same window as the Teams page);
 * sales (`may.ask`) asks for another team with why (POST …/team-asks) and then reads "Asked: the production manager answers". A person
 * the API does not let read the order's teams (the designer, the floor: 403/404) sees no part at all. Outside the office (the design
 * index, the tab's server-drawn tests) there is no session: the part draws nothing.
 */
export interface OrderTeamPartProps {
  /** The company the page works in (the session's). */
  readonly companyId: string
  /** The order (SalesOrder id). */
  readonly orderId: string
}

export function OrderTeamPart(props: OrderTeamPartProps): ReactElement | null {
  const office = useOfficeOrNull()
  if (!office) return null
  return (
    <WithMessages namespaces={[ORDER_TEAMS_NS]}>
      <OrderTeamContainer api={office.api} orderId={props.orderId} />
    </WithMessages>
  )
}

function OrderTeamContainer({ api, orderId }: { api: ApiClient; orderId: string }): ReactElement | null {
  const scope = useOfficeScope()
  const [read, setRead] = useState<{ value: OrderTeams | null; problem: string | null; hidden: boolean }>({ value: null, problem: null, hidden: false })
  const [asked, setAsked] = useState(false)
  const [ask, setAsk] = useState<{ open: boolean; why: string; busy: boolean; problem: string | null }>({ open: false, why: '', busy: false, problem: null })
  const readId = useRef(0)

  const load = useCallback(() => {
    const id = ++readId.current
    setRead((current) => ({ ...current, problem: null }))
    getOrderTeams(api, orderId)
      .then((value) => id === readId.current && setRead({ value, problem: null, hidden: false }))
      .catch((error: unknown) => {
        if (id !== readId.current) return
        const problem = problemKeyOf(error, false)
        // The designer and the floor have no such route (403/404): no part, no error line.
        setRead({ value: null, problem, hidden: problem === 'error.forbidden' || problem === 'error.notFound' })
      })
  }, [api, orderId])

  useEffect(() => {
    setRead({ value: null, problem: null, hidden: false })
    setAsked(false)
    load()
  }, [load])

  const give = useGiveWindow(api, { siteId: scope.siteId, onSaved: (answer) => setRead({ value: answer, problem: null, hidden: false }) })

  const sendAsk = () => {
    if (ask.busy || askHeldOf(ask.why)) return
    setAsk((current) => ({ ...current, busy: true, problem: null }))
    askAnotherTeam(api, orderId, ask.why.trim())
      .then(() => {
        setAsk({ open: false, why: '', busy: false, problem: null })
        setAsked(true)
      })
      .catch((error: unknown) => setAsk((current) => ({ ...current, busy: false, problem: problemKeyOf(error, true) })))
  }

  const part = useMemo(() => (read.value ? partModelOf(read.value, asked) : null), [read.value, asked])
  if (read.hidden) return null

  return (
    <>
      <OrderTeamPartView
        model={{ state: read.value ? 'ready' : read.problem ? 'failed' : 'reading', problem: read.problem, part }}
        actions={{ onGive: () => give.open(orderId), onAsk: () => setAsk({ open: true, why: '', busy: false, problem: null }), onRetry: load }}
      />
      <GiveTeamsWindow model={give.model} actions={give.actions} />
      <AskTeamWindow
        model={ask}
        onWhy={(why) => setAsk((current) => (current.busy ? current : { ...current, why, problem: null }))}
        onAsk={sendAsk}
        onClose={() => setAsk((current) => (current.busy ? current : { open: false, why: '', busy: false, problem: null }))}
      />
    </>
  )
}
