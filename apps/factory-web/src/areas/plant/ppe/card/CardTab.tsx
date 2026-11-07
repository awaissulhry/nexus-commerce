'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { readCard } from '../api'
import { ppeCan, readProblemOf } from '../model'
import { CardTabView, type CardTabModel } from './view/CardTabView'

/**
 * `/w/<company>/plant/ppe/card?person=<employee id>[&person=…]` (SCR-211-card, a new tab from Gaps: a person's card, Print PPE
 * cards over the rows chosen): GET /safety/ppe/people/:employeeId for each person (safety.view), one card each, printed from the
 * browser for the person's file.
 */
export function CardTab() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const can = useMemo(() => ppeCan(session.permissions), [session.permissions])
  const ids = useMemo(() => [...new Set(params.getAll('person').map((id) => id.trim()).filter(Boolean))].slice(0, 50), [params])
  const [at] = useState(() => new Date().toISOString())
  const [cards, setCards] = useState<CardTabModel['cards']>([])

  useEffect(() => {
    if (!can.view) return
    let live = true
    setCards(ids.map((id) => ({ id, value: null, problem: null })))
    void (async () => {
      // One person after the other: a long list never fires 50 reads at once.
      for (const id of ids) {
        try {
          const value = await readCard(api, id)
          if (live) setCards((current) => current.map((entry) => (entry.id === id ? { id, value, problem: null } : entry)))
        } catch (error) {
          if (live) setCards((current) => current.map((entry) => (entry.id === id ? { id, value: null, problem: readProblemOf(error) } : entry)))
        }
      }
    })()
    return () => {
      live = false
    }
  }, [api, can.view, ids])

  return <CardTabView model={{ canView: can.view, at, person: session.user.displayName, cards }} />
}
