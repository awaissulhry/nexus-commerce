'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { useT } from '../../lib/i18n/provider'
import { zxingCamera } from '../camera'
import { useFloor, useFloorRouter } from '../FloorApp'
import { TASK_ROUTES, taskOfTile } from '../tasks/routes'
import { fetchTeam, setFirst, type BasketTeam } from '../basket/api'
import { phoneJobsOf, useBasketScan, useDepartmentPick, useSeen } from '../basket/home/home-kit'
import { basketPath } from '../basket/model'
import { BASKET_NS } from '../basket/parts'
import { StepsWindowOf, type StepsTarget } from '../basket/steps/StepsWindow'
import { useUndoChanges } from '../basket/undo/use-undo'
import { GiveWindow } from './GiveWindow'
import { personLabel } from './give'
import { groupsOf, leaderForYouOf, teamBasketsOf, teamNumbersOf, type TeamFilter } from './model'
import { LeaderHomeView, type LeaderHomeAction } from './view/LeaderHomeView'

/**
 * owb-fl6 step 3 — the team leader's home (a phone's Home for a person with floor.lead; a tablet's Baskets tile too): it reads
 * `GET /production/baskets/team` (server B's fl4; again when the network comes back, after a change, after an Undo) and opens the Steps
 * window of one basket (its step button) or of an order (Change all), Give to… from a person (Who has what), and Do this first (the pin
 * of a row; `POST /production/baskets/flags`, online in fl6). The department pick stays in the top bar (help calls need its station).
 */

type Load = { readonly state: 'loading' | 'offline' | 'unavailable' } | { readonly state: 'ready'; readonly team: BasketTeam; readonly at: number }

export function LeaderHome() {
  const store = useFloor()
  const router = useFloorRouter()
  const feedback = useConfirmFeedback()
  const tb = useT(BASKET_NS)
  const { me, api, online, sessionEnded } = store
  const phone = me?.device.mode === 'PHONE'
  const { frame, onFrame } = store.frame('tile.baskets', { showHome: !phone })
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [part, setPart] = useState<'baskets' | 'team'>('baskets')
  const [filter, setFilter] = useState<TeamFilter | null>(null)
  const [steps, setSteps] = useState<StepsTarget | null>(null)
  const [giveTo, setGiveTo] = useState<string | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const person = me?.worker.id ?? null
  const { seen, mark } = useSeen(person)
  const scanner = useBasketScan()
  const undone = useUndoChanges()

  const read = useCallback(async () => {
    if (!navigator.onLine) return setLoad({ state: 'offline' })
    const answer = await fetchTeam(api)
    if (answer.ok) return setLoad({ state: 'ready', team: answer.value, at: Date.now() })
    if (answer.problem.kind === 'signedOut') return void sessionEnded()
    setLoad({ state: answer.problem.kind === 'offline' ? 'offline' : 'unavailable' })
  }, [api, sessionEnded])

  useEffect(() => {
    if (!person) return
    void read()
  }, [read, person, online, undone])

  // The team read names no department: the pick shows the one this phone stands in once it is chosen here (null until then).
  const pick = useDepartmentPick(null, () => void read())
  const team = load.state === 'ready' ? load.team : null
  const groups = useMemo(() => (team ? groupsOf(team, filter) : []), [team, filter])
  if (!me) return null

  const words = (n: number) => tb('give.person', { n })
  const first = async (bundleId: string, on: boolean) => {
    if (busy) return
    setBusy(true)
    const answer = await setFirst(api, [bundleId], on)
    setBusy(false)
    if (!answer.ok) {
      if (answer.problem.kind === 'signedOut') return void sessionEnded()
      feedback('error')
      return setSaid(answer.problem.kind === 'refused' ? answer.problem.message || tb('dock.failed') : tb('dock.failed'))
    }
    feedback('success')
    setSaid(tb(on ? 'leader.firstOn' : 'leader.firstOff'))
    void read()
  }

  const onAction = (action: LeaderHomeAction) => {
    switch (action.type) {
      case 'part':
        setSaid(null)
        return setPart(action.part)
      case 'filter':
        return setFilter(action.filter)
      case 'open':
        if (action.item) mark(action.item)
        return router.push(basketPath(action.code))
      case 'step':
        return setSteps({ kind: 'code', code: action.code })
      case 'changeAll': {
        const group = groups.find((one) => one.key === action.key)
        return group ? setSteps({ kind: 'order', salesOrderId: group.order.salesOrderId, label: group.order.customerCode, codes: group.order.baskets.map((row) => row.code) }) : undefined
      }
      case 'first':
        return void first(action.bundleId, action.on)
      case 'person':
        return setGiveTo(action.key)
      case 'scan':
        return void scanner.scan(action.code)
      case 'retry':
        setLoad({ state: 'loading' })
        return void read()
      case 'job': {
        const task = taskOfTile(action.key)
        return task ? router.push(TASK_ROUTES[task]) : undefined
      }
      default:
        return pick.act(action)
    }
  }

  return (
    <>
      <LeaderHomeView
        model={{
          frame,
          pick: pick.model,
          part,
          state: load.state,
          team,
          numbers: team ? teamNumbersOf(team) : null,
          filter,
          forYou: team ? leaderForYouOf(team, seen) : [],
          groups,
          total: team ? teamBasketsOf(team) : 0,
          locale: store.locale,
          readAt: load.state === 'ready' ? load.at : 0,
          people: team ? team.people.map((one, index) => ({ key: one.key, label: personLabel(one, index, words), holds: one.holds?.code ?? null })) : [],
          jobs: phoneJobsOf(me),
          scanHeld: me.notice.blocksScans,
          badgeRefused: scanner.refused,
          said,
          busy,
        }}
        onFrame={onFrame}
        onAction={onAction}
        camera={zxingCamera}
      />
      {steps ? <StepsWindowOf open onClose={() => setSteps(null)} target={steps} leader onChanged={() => void read()} /> : null}
      {giveTo ? <GiveWindow open onClose={() => setGiveTo(null)} from={{ kind: 'person', key: giveTo }} team={team} onChanged={() => void read()} /> : null}
    </>
  )
}
