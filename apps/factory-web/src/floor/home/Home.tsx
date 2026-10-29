'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { zxingCamera } from '../camera'
import { useFloor } from '../FloorApp'
import { homeTiles, modeOf } from '../model'
import { heldWorkOf } from '../queue/actions'
import { readScan } from '../scan/scan-model'
import { TASK_ROUTES, taskForScan, taskOfTile } from '../tasks/routes'
import { HomeView, type HomeAction } from './view/HomeView'

/**
 * The live SCR-022 home (`/floor`): the tiles of this station's mode that the operator's floor permissions open, the
 * scan strip (a label opens the station's job with it — tasks/routes.ts `taskForScan` — else Scan anything; a badge
 * switches person), and the notice card while it is due.
 * Offline, what goes on and what waits for the network; the tablet's label numbers when they run low.
 */
export function FloorHome() {
  const store = useFloor()
  const router = useRouter()
  const feedback = useConfirmFeedback()
  const { frame, onFrame } = store.frame('home.title')
  const [refused, setRefused] = useState(false)
  const { me } = store
  if (!me) return null
  const mode = modeOf(me.device.station)
  const tiles = homeTiles(mode, me.permissions, me.notice.blocksScans)

  const onAction = async (action: HomeAction) => {
    switch (action.type) {
      case 'tile': {
        // Only built tiles open (the others are held on the tile): Scan anything and the floor tasks.
        if (action.key === 'scan') return router.push('/floor/scan')
        const task = taskOfTile(action.key)
        if (task && tiles.some((tile) => tile.key === action.key && tile.held === null)) router.push(TASK_ROUTES[task])
        return
      }
      case 'notice':
        return router.push('/floor/notice')
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
        tiles,
        notice: { due: me.notice.due, blocksScans: me.notice.blocksScans },
        switched: store.switched,
        badgeRefused: refused,
        offline: store.online ? null : { held: heldWorkOf(mode) },
        lowNumbers: store.shellQueue.lowNumbers,
      }}
      onFrame={onFrame}
      onAction={(action) => void onAction(action)}
      camera={zxingCamera}
    />
  )
}
