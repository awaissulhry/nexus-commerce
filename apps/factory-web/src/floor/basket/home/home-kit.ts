'use client'

import { useCallback, useEffect, useState } from 'react'
import { useConfirmFeedback } from '@nexus/ui/floor'
import type { Department } from '../../../lib/department/model'
import { useDepartments } from '../../../lib/department/use-departments'
import { useFloor } from '../../FloorApp'
import type { FloorMe } from '../../api'
import { homeTiles, modeOf, type TileKey } from '../../model'
import { readScan } from '../../scan/scan-model'
import { basketPageFor, TASK_ROUTES, taskForScan, taskOfTile } from '../../tasks/routes'
import { cabinetOfScan, CABINET_PATH } from '../../tasks/sds/model'
import { pickDepartment } from '../api'
import { deptOf } from '../model'
import { seenKeyOf, SEEN_KINDS, seenStore, type SeenItem } from './seen'
import type { DepartmentPickAction, DepartmentPickModel } from './view/DepartmentPick'

/**
 * owb-fl5/fl6 — what the worker's basket home and the team leader's home share: the scan router of a phone (a basket's card opens its
 * page; a tablet keeps today's router; a badge switches the person; anything else opens Scan anything), the department pick (lead
 * settle 2), what this person opened of For you (device only, settle 12) and the phone's own tiles ("Other jobs").
 */

/** The scan of a basket home. `refused`: a badge scanned here did not open this device. */
export function useBasketScan(): { readonly refused: boolean; readonly scan: (code: string) => Promise<void> } {
  const store = useFloor()
  const feedback = useConfirmFeedback()
  const [refused, setRefused] = useState(false)
  const scan = async (code: string) => {
    const me = store.me
    if (!me) return
    setRefused(false)
    const cabinet = cabinetOfScan(code)
    if (cabinet) return store.openWith(CABINET_PATH, cabinet)
    const scanned = readScan(code, me.scanTag)
    const page = basketPageFor(me.device.mode, scanned)
    if (page) return store.openWith(page, scanned.code)
    const mode = modeOf(me.device.station, me.device.mode)
    const tiles = homeTiles(mode, me.permissions, me.notice.blocksScans, me.device.mode)
    const task = taskForScan(mode, scanned, tiles, me.permissions, me.notice.blocksScans)
    if (task) return store.openWith(TASK_ROUTES[task], scanned.code)
    if (scanned.kind !== 'badge') return store.openScan(code)
    const problem = await store.switchTo(scanned.code)
    if (problem) {
      feedback('error')
      setRefused(true)
    }
  }
  return { refused, scan }
}

type Pick = { readonly open: boolean; readonly stations: DepartmentPickModel['stations']; readonly problem: DepartmentPickModel['problem']; readonly busy: boolean; readonly departmentId: string | null }
const CLOSED: Pick = { open: false, stations: null, problem: null, busy: false, departmentId: null }

/** The department pick: one tap; several stations → their names once; none → the words of settle 3. `after`: read the home again. */
export function useDepartmentPick(current: Department | null, after: () => void): { readonly model: DepartmentPickModel; readonly act: (action: DepartmentPickAction) => void } {
  const { api, online, sessionEnded, floorLocale: locale } = useFloor()
  const feedback = useConfirmFeedback()
  const { departments } = useDepartments(api)
  const [pick, setPick] = useState<Pick>(CLOSED)
  // The department picked here (a read that names none — the leader's — shows it until the next read names one).
  const [picked, setPicked] = useState<Department | null>(null)

  const choose = async (departmentId: string, stationId?: string) => {
    if (!online) return setPick((now) => ({ ...now, problem: 'offline' }))
    setPick((now) => ({ ...now, busy: true, problem: null }))
    const answer = await pickDepartment(api, departmentId, stationId)
    if (!answer.ok) {
      if (answer.problem.kind === 'signedOut') return void sessionEnded()
      feedback('error')
      return setPick((now) => ({ ...now, busy: false, problem: answer.problem.kind === 'offline' ? 'offline' : 'failed' }))
    }
    const { station, choose: names } = answer.value
    if (!station && names.length > 1) return setPick({ open: true, stations: names, problem: null, busy: false, departmentId })
    feedback('success')
    setPicked(deptOf(answer.value.department, locale))
    // A department with no station at this site is picked all the same; the window says so in words (lead settle 3).
    setPick(station ? CLOSED : { open: true, stations: null, problem: 'noStation', busy: false, departmentId })
    after()
  }

  const act = (action: DepartmentPickAction) => {
    switch (action.type) {
      case 'pickOpen':
        return setPick({ ...CLOSED, open: true })
      case 'pickClose':
        return setPick(CLOSED)
      case 'pick':
        return void choose(action.departmentId)
      case 'station':
        return pick.departmentId ? void choose(pick.departmentId, action.stationId) : undefined
    }
  }

  return {
    model: { current: current ?? picked, open: pick.open, departments: departments.filter((dept) => Boolean(dept.id) && !dept.closed), stations: pick.stations, problem: pick.problem, busy: pick.busy },
    act,
  }
}

/** What this person opened of For you on this device, and the mark of a line opened now. */
export function useSeen(person: string | null): { readonly seen: readonly string[]; readonly mark: (item: SeenItem) => void } {
  const [seen, setSeen] = useState<readonly string[]>([])
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
  const mark = useCallback(
    (item: SeenItem) => {
      if (person && SEEN_KINDS.includes(item.kind)) void seenStore().mark(person, seenKeyOf(item)).then(setSeen)
    },
    [person],
  )
  return { seen, mark }
}

/** The phone's own tiles of today (Report an incident must never fall off: B-W2b-137); none on a tablet (its Home keeps them). */
export function phoneJobsOf(me: FloorMe): TileKey[] {
  if (me.device.mode !== 'PHONE') return []
  return homeTiles(modeOf(me.device.station, me.device.mode), me.permissions, me.notice.blocksScans, me.device.mode)
    .filter((tile) => tile.held === null && tile.key !== 'scan' && taskOfTile(tile.key) !== null)
    .map((tile) => tile.key)
}
