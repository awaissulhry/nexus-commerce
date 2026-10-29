'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { zxingCamera } from '../camera'
import { useFloor } from '../FloorApp'
import { homeTiles, modeOf } from '../model'
import { readScan } from '../scan/scan-model'
import { HomeView, type HomeAction } from './view/HomeView'

/**
 * The live SCR-022 home (`/floor`): the tiles of this station's mode that the operator's floor permissions open, the
 * scan strip (a label opens Scan anything with it; a badge switches person), and the notice card while it is due.
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
      case 'tile':
        // Only built tiles open (the others are held on the tile): Scan anything.
        if (action.key === 'scan') router.push('/floor/scan')
        return
      case 'notice':
        return router.push('/floor/notice')
      case 'scan': {
        setRefused(false)
        const read = readScan(action.code, me.scanTag)
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
      model={{ frame, mode, tiles, notice: { due: me.notice.due, blocksScans: me.notice.blocksScans }, switched: store.switched, badgeRefused: refused }}
      onFrame={onFrame}
      onAction={(action) => void onAction(action)}
      camera={zxingCamera}
    />
  )
}
