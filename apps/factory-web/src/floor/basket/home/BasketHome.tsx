'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { useDepartments } from '../../../lib/department/use-departments'
import { zxingCamera } from '../../camera'
import { useFloor, useFloorRouter } from '../../FloorApp'
import { homeTiles, modeOf, type TileKey } from '../../model'
import { readScan } from '../../scan/scan-model'
import { basketPageFor, TASK_ROUTES, taskForScan, taskOfTile } from '../../tasks/routes'
import { cabinetOfScan, CABINET_PATH } from '../../tasks/sds/model'
import { fetchBasketHome, pickDepartment, type BasketHome as HomeRead } from '../api'
import { basketPath, clearFlash, deptOf, homeOf, peekFlash, type DoneFlash } from '../model'
import { seenKeyOf, SEEN_KINDS, seenStore } from './seen'
import { BasketHomeView, type BasketHomeAction } from './view/BasketHomeView'
import type { DepartmentPickModel } from './view/DepartmentPick'

/**
 * owb-fl5 step 1 — the basket home's container: a PHONE's Home (`/floor`, lead settle 9) and a tablet's Baskets tile
 * (`/floor/baskets`). It reads `GET /production/baskets/home` (again when the network comes back, after a department pick), keeps
 * what this person opened of For you on the device only (settle 12), and sends:
 *   a scan       on a phone a basket's card opens its page (tasks/routes.ts basketPageFor); a tablet keeps today's router; a badge
 *                switches the person; anything else opens Scan anything
 *   a tap        a For you line or a row opens the basket (one tap)
 *   the pick     `POST /floor/session/department` (several stations: their names, once)
 */

type Load = { readonly state: 'loading' | 'offline' | 'unavailable' } | { readonly state: 'ready'; readonly home: HomeRead; readonly at: number }

const CLOSED_PICK = { open: false, stations: null, problem: null, busy: false, departmentId: null } as const
type Pick = { readonly open: boolean; readonly stations: DepartmentPickModel['stations']; readonly problem: DepartmentPickModel['problem']; readonly busy: boolean; readonly departmentId: string | null }

export function BasketHome() {
  const store = useFloor()
  const router = useFloorRouter()
  const feedback = useConfirmFeedback()
  const { me, api, online, locale, sessionEnded } = store
  const phone = me?.device.mode === 'PHONE'
  const { frame, onFrame } = store.frame('tile.baskets', { showHome: !phone })
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [seen, setSeen] = useState<string[]>([])
  const [pick, setPick] = useState<Pick>(CLOSED_PICK)
  const [refused, setRefused] = useState(false)
  const [flash] = useState<DoneFlash | null>(() => peekFlash())
  const { departments } = useDepartments(api)
  const person = me?.worker.id ?? null

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
  }, [read, person, online])

  useEffect(() => {
    if (!person) return
    let live = true
    void seenStore()
      .read(person)
      .then((keys) => live && setSeen(keys))
    return () => {
      live = false
    }
  }, [person])

  const lists = useMemo(() => (load.state === 'ready' ? homeOf(load.home, seen) : null), [load, seen])
  if (!me) return null

  const mode = modeOf(me.device.station, me.device.mode)
  const tiles = homeTiles(mode, me.permissions, me.notice.blocksScans, me.device.mode)
  // The phone's own tiles stay one tap away (Report an incident must never fall off: B-W2b-137); a tablet's Home keeps them.
  const jobs: TileKey[] = phone ? tiles.filter((tile) => tile.held === null && tile.key !== 'scan' && taskOfTile(tile.key) !== null).map((tile) => tile.key) : []
  const current = load.state === 'ready' ? deptOf(load.home.department, locale) : null

  const choosePick = async (departmentId: string, stationId?: string) => {
    if (!online) return setPick((now) => ({ ...now, problem: 'offline' }))
    setPick((now) => ({ ...now, busy: true, problem: null }))
    const answer = await pickDepartment(api, departmentId, stationId)
    if (!answer.ok) {
      if (answer.problem.kind === 'signedOut') return void sessionEnded()
      feedback('error')
      return setPick((now) => ({ ...now, busy: false, problem: answer.problem.kind === 'offline' ? 'offline' : 'failed' }))
    }
    const { station, choose } = answer.value
    if (!station && choose.length > 1) {
      setPick({ open: true, stations: choose, problem: null, busy: false, departmentId })
      return
    }
    feedback('success')
    // A department with no station at this site is picked all the same; the window says so in words (lead settle 3).
    setPick(station ? CLOSED_PICK : { open: true, stations: null, problem: 'noStation', busy: false, departmentId })
    void read()
  }

  const onAction = async (action: BasketHomeAction) => {
    switch (action.type) {
      case 'scan': {
        setRefused(false)
        const cabinet = cabinetOfScan(action.code)
        if (cabinet) return store.openWith(CABINET_PATH, cabinet)
        const scanned = readScan(action.code, me.scanTag)
        const page = basketPageFor(me.device.mode, scanned)
        if (page) return store.openWith(page, scanned.code)
        const task = taskForScan(mode, scanned, tiles, me.permissions, me.notice.blocksScans)
        if (task) return store.openWith(TASK_ROUTES[task], scanned.code)
        if (scanned.kind !== 'badge') return store.openScan(action.code)
        const problem = await store.switchTo(scanned.code)
        if (problem) {
          feedback('error')
          setRefused(true)
        }
        return
      }
      case 'open':
        if (action.item && SEEN_KINDS.includes(action.item.kind) && person) void seenStore().mark(person, seenKeyOf(action.item)).then(setSeen)
        return router.push(basketPath(action.code))
      case 'retry':
        setLoad({ state: 'loading' })
        return void read()
      case 'job': {
        const task = taskOfTile(action.key)
        return task ? router.push(TASK_ROUTES[task]) : undefined
      }
      case 'pickOpen':
        return setPick({ ...CLOSED_PICK, open: true })
      case 'pickClose':
        return setPick(CLOSED_PICK)
      case 'pick':
        return void choosePick(action.departmentId)
      case 'station':
        return pick.departmentId ? void choosePick(pick.departmentId, action.stationId) : undefined
    }
  }

  return (
    <BasketHomeView
      model={{
        frame,
        pick: {
          current,
          open: pick.open,
          departments: departments.filter((dept) => Boolean(dept.id) && !dept.closed),
          stations: pick.stations,
          problem: pick.problem,
          busy: pick.busy,
        },
        state: load.state,
        lists,
        locale,
        readAt: load.state === 'ready' ? load.at : 0,
        flash,
        jobs,
        badgeRefused: refused,
        scanHeld: me.notice.blocksScans,
      }}
      onFrame={onFrame}
      onAction={(action) => void onAction(action)}
      camera={zxingCamera}
    />
  )
}
