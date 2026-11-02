'use client'

import { useEffect, useState } from 'react'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { zxingCamera } from '../camera'
import { useFloor, useFloorRouter } from '../FloorApp'
import { homeTiles, modeOf, tilePage } from '../model'
import { heldWorkOf } from '../queue/actions'
import { readScan } from '../scan/scan-model'
import { TASK_ROUTES, taskForScan, taskOfTile } from '../tasks/routes'
import { useMyDayBadge } from '../tasks/myday/badge'
import { fetchOpenWork } from '../tasks/scans/api'
import { withLeft } from '../tasks/scans/left'
import { resumeRows, type OpenItem } from '../tasks/scans/timing'
import { HomeView, type HomeAction } from './view/HomeView'

/**
 * The live SCR-022 home (`/floor`): the tiles of this station's mode that the operator's floor permissions open, the
 * scan strip (a label opens the station's job with it — tasks/routes.ts `taskForScan` — else Scan anything; a badge
 * switches person), and the notice card while it is due.
 * Offline, what goes on and what waits for the network; the tablet's label numbers when they run low.
 * B-W2b-69: "Unfinished on this tablet": the person's paused or running bundles (`GET /production/terminal/open`), Continue opens the
 * job with its ticket; offline the last answer of this visit stands, with its as-of time.
 */

/** The last open work read in this visit (kept for an offline Home). */
let KEPT: { person: string; items: readonly OpenItem[]; asOf: string } | null = null
export function FloorHome() {
  const store = useFloor()
  const router = useFloorRouter()
  const feedback = useConfirmFeedback()
  const { frame, onFrame } = store.frame('home.title')
  const [refused, setRefused] = useState(false)
  const [open, setOpen] = useState(KEPT)
  const [read, setRead] = useState(false)
  const [page, setPage] = useState(0)
  const { me, api, online } = store
  const scans = Boolean(me?.permissions.includes('production.scan'))
  const person = me?.worker.id ?? null
  // B-W2b-68: a dispute answered shows on the My day tile; read per person, nothing held for the next one.
  const answers = useMyDayBadge(api, Boolean(online && me?.permissions.includes('floor.work')), person)
  // B-W2b-73: the next person starts on the first page of tiles.
  useEffect(() => setPage(0), [person])
  useEffect(() => {
    if (!scans || !online) return
    let live = true
    void fetchOpenWork(api).then((answer) => {
      if (!live) return
      setRead(answer.ok)
      if (!answer.ok || !person) return
      KEPT = { person, items: resumeRows(answer.value), asOf: new Date().toISOString() }
      setOpen(KEPT)
    })
    return () => {
      live = false
    }
  }, [api, online, scans, person])
  if (!me) return null
  const mode = modeOf(me.device.station, me.device.mode)
  const tiles = homeTiles(mode, me.permissions, me.notice.blocksScans, me.device.mode)
  const shown = tilePage(tiles, page)
  const fresh = online && read
  const kept = open?.person === person ? (open?.items ?? []) : []
  const asOf = open?.person === person ? (open?.asOf ?? null) : null

  const onAction = async (action: HomeAction) => {
    switch (action.type) {
      case 'tile': {
        // Only built tiles open (the others are held on the tile): Scan anything and the floor tasks.
        if (action.key === 'scan') return router.push('/floor/scan')
        const task = taskOfTile(action.key)
        if (task && tiles.some((tile) => tile.key === action.key && tile.held === null)) router.push(TASK_ROUTES[task])
        return
      }
      case 'more':
        return setPage(shown.more > 0 ? shown.page + 1 : 0)
      case 'notice':
        return router.push('/floor/notice')
      case 'continue':
        return store.openWith(TASK_ROUTES.operation, action.code)
      case 'scan': {
        setRefused(false)
        const read = readScan(action.code, me.scanTag)
        // The scan router: the job for this station with the label loaded, else Scan anything shows its card.
        const task = taskForScan(mode, read, tiles)
        if (task) return store.openWith(TASK_ROUTES[task], read.code)
        if (read.kind !== 'badge') return store.openScan(action.code)
        const problem = await store.switchTo(read.code)
        if (problem) {
          feedback('error')
          setRefused(true)
        }
        return
      }
    }
  }

  return (
    <HomeView
      model={{
        frame,
        mode,
        tiles: shown.tiles,
        more: shown.pages > 1 ? shown.more : null,
        notice: { due: me.notice.due, blocksScans: me.notice.blocksScans },
        switched: store.switched,
        badgeRefused: refused,
        offline: store.online ? null : { held: heldWorkOf(mode) },
        lowNumbers: store.shellQueue.lowNumbers,
        // One person's open work never reaches the next person on the tablet. B-W2b-F6: unread, what they left on Operation counts too.
        resume: scans && person ? { items: fresh ? kept : withLeft(person, kept), asOf: online ? null : asOf } : null,
        mydayAnswers: answers,
      }}
      onFrame={onFrame}
      onAction={(action) => void onAction(action)}
      camera={zxingCamera}
    />
  )
}
