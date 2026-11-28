'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { zxingCamera } from '../../camera'
import { useFloor, useFloorRouter } from '../../FloorApp'
import { TASK_ROUTES, taskOfTile } from '../../tasks/routes'
import { fetchBasketHome, type BasketHome as HomeRead } from '../api'
import { basketPath, clearFlash, deptOf, homeOf, peekFlash, type DoneFlash } from '../model'
import { useUndoChanges } from '../undo/use-undo'
import { phoneJobsOf, useBasketScan, useDepartmentPick, useSeen } from './home-kit'
import { BasketHomeView, type BasketHomeAction } from './view/BasketHomeView'

/**
 * owb-fl5 step 1 — the basket home's container: a PHONE's Home (`/floor`, lead settle 9) and a tablet's Baskets tile
 * (`/floor/baskets`). It reads `GET /production/baskets/home` (again when the network comes back, after a department pick, after an
 * Undo), keeps what this person opened of For you on the device only (settle 12), and sends:
 *   a scan       on a phone a basket's card opens its page (tasks/routes.ts basketPageFor); a tablet keeps today's router; a badge
 *                switches the person; anything else opens Scan anything (home-kit.ts)
 *   a tap        a For you line or a row opens the basket (one tap)
 *   the pick     `POST /floor/session/department` (several stations: their names, once)
 */

type Load = { readonly state: 'loading' | 'offline' | 'unavailable' } | { readonly state: 'ready'; readonly home: HomeRead; readonly at: number }

export function BasketHome() {
  const store = useFloor()
  const router = useFloorRouter()
  const { me, api, online, locale, sessionEnded } = store
  const phone = me?.device.mode === 'PHONE'
  const { frame, onFrame } = store.frame('tile.baskets', { showHome: !phone })
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [flash] = useState<DoneFlash | null>(() => peekFlash())
  const person = me?.worker.id ?? null
  const { seen, mark } = useSeen(person)
  const scanner = useBasketScan()
  // owb-fl6: an Undo went through (the bar at the foot): the lists are read again.
  const undone = useUndoChanges()

  const read = useCallback(async () => {
    if (!navigator.onLine) return setLoad({ state: 'offline' })
    const answer = await fetchBasketHome(api)
    if (answer.ok) return setLoad({ state: 'ready', home: answer.value, at: Date.now() })
    if (answer.problem.kind === 'signedOut') return void sessionEnded()
    setLoad({ state: answer.problem.kind === 'offline' ? 'offline' : 'unavailable' })
  }, [api, sessionEnded])

  // The line after a Done is said once: gone after the first paint.
  useEffect(() => clearFlash(), [])

  useEffect(() => {
    if (!person) return
    void read()
  }, [read, person, online, undone])

  const current = load.state === 'ready' ? deptOf(load.home.department, locale) : null
  const pick = useDepartmentPick(current, () => void read())
  const lists = useMemo(() => (load.state === 'ready' ? homeOf(load.home, seen) : null), [load, seen])
  if (!me) return null

  const onAction = (action: BasketHomeAction) => {
    switch (action.type) {
      case 'scan':
        return void scanner.scan(action.code)
      case 'open':
        if (action.item) mark(action.item)
        return router.push(basketPath(action.code))
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
    <BasketHomeView
      model={{
        frame,
        pick: pick.model,
        state: load.state,
        lists,
        locale,
        readAt: load.state === 'ready' ? load.at : 0,
        flash,
        jobs: phoneJobsOf(me),
        badgeRefused: scanner.refused,
        scanHeld: me.notice.blocksScans,
      }}
      onFrame={onFrame}
      onAction={onAction}
      camera={zxingCamera}
    />
  )
}
