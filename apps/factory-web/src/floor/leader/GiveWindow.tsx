'use client'

import { useEffect, useRef, useState } from 'react'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { useT } from '../../lib/i18n/provider'
import { useFloor } from '../FloorApp'
import { fetchTeam, giveBasket, type BasketTeam } from '../basket/api'
import { BASKET_NS } from '../basket/parts'
import { undoStore } from '../basket/undo/store'
import { giveBasketsOf, givePeopleOf, holderOf, namesNoWorkers, personLabel } from './give'
import { GiveWindowView, type GiveAction } from './view/GiveWindowView'

/**
 * owb-fl6 step 3 — Give to…'s container: from a basket (its leader row: the people) or from a person (Who has what: the baskets). It uses
 * the team read the leader's home has, or reads it (`GET /production/baskets/team`); one tap sends today's
 * `POST /production/dispatch/assignments` naming the basket only (fl4's seam), puts the Undo bar's entry (back to who held it) and closes.
 * Online only, as today's reassign.
 */

export type GiveFrom = { readonly kind: 'basket'; readonly bundleId: string; readonly code: string } | { readonly kind: 'person'; readonly key: string }

export function GiveWindow({ open, onClose, from, team: given, onChanged }: { readonly open: boolean; readonly onClose: () => void; readonly from: GiveFrom | null; readonly team?: BasketTeam | null; readonly onChanged: () => void }) {
  const { api, me, sessionEnded } = useFloor()
  const tb = useT(BASKET_NS)
  const feedback = useConfirmFeedback()
  const [team, setTeam] = useState<BasketTeam | null>(given ?? null)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>(given ? 'ready' : 'loading')
  const [said, setSaid] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const givenNow = useRef(given)
  givenNow.current = given

  useEffect(() => {
    if (!open) return
    setSaid(null)
    if (givenNow.current) {
      setTeam(givenNow.current)
      return setState('ready')
    }
    setState('loading')
    let live = true
    void fetchTeam(api).then((answer) => {
      if (!live) return
      if (answer.ok) {
        setTeam(answer.value)
        setState('ready')
      } else setState('failed')
    })
    return () => {
      live = false
    }
  }, [open, api])

  if (!me || !from) return null
  const words = (n: number) => tb('give.person', { n })

  const give = async (personKey: string, bundleId: string, code: string) => {
    if (busy || !team) return
    const person = team.people.find((one) => one.key === personKey)
    if (!person) return
    const index = team.people.indexOf(person)
    const was = holderOf(team, bundleId)
    if (was?.key === personKey) return onClose()
    setBusy(true)
    setSaid(null)
    const answer = await giveBasket(api, personKey, bundleId)
    setBusy(false)
    if (!answer.ok) {
      if (answer.problem.kind === 'signedOut') return void sessionEnded()
      feedback('error')
      return setSaid(answer.problem.kind === 'refused' ? answer.problem.message || tb('dock.failed') : answer.problem.kind === 'offline' ? tb('dock.needsNetwork') : tb('dock.failed'))
    }
    feedback('success')
    undoStore.put(me.worker.id, {
      kind: 'give',
      code,
      from: was ? personLabel(was, team.people.indexOf(was), words) : null,
      to: personLabel(person, index, words),
      assignment: { id: answer.value.assignment.id, version: answer.value.assignment.version },
      backTo: was?.key ?? null,
    })
    onChanged()
    onClose()
  }

  const codeOf = (bundleId: string): string => team?.orders.flatMap((order) => order.baskets).find((row) => row.bundleId === bundleId)?.code ?? ''
  const onAction = (action: GiveAction) => {
    switch (action.type) {
      case 'close':
        return onClose()
      case 'person':
        return from.kind === 'basket' ? void give(action.key, from.bundleId, from.code) : undefined
      case 'basket':
        return from.kind === 'person' ? void give(from.key, action.bundleId, codeOf(action.bundleId)) : undefined
    }
  }

  const personOf = from.kind === 'person' && team ? team.people.find((one) => one.key === from.key) : null
  return (
    <GiveWindowView
      model={{
        open,
        title: from.kind === 'basket' ? tb('give.title', { code: from.code }) : tb('give.titlePerson', { name: personOf ? personLabel(personOf, team!.people.indexOf(personOf), words) : '' }),
        state,
        people: team && from.kind === 'basket' ? givePeopleOf(team, from.bundleId, words) : null,
        baskets: team && from.kind === 'person' ? giveBasketsOf(team, from.key) : null,
        said,
        busy,
        noNames: team ? namesNoWorkers(team) : false,
      }}
      onAction={onAction}
    />
  )
}
