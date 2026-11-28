'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLiveChanges } from '../../record-panels/live'
import { FloorFrameView } from '../frame/view/FloorFrameView'
import { useFloor, useFloorRouter } from '../FloorApp'
import { useFloorKeys } from '../keys'
import { readFloorBoard, type BoardScope, type FloorBoard } from './api'
import { basketPath, boardTabShown, chipsOf, firstChip } from './model'
import { FloorBoardView, type FloorBoardAction } from './view/BoardView'

/**
 * owb-fl9 step 2 — the live `/floor/board` (the team leader's tab "Board"): reads the board of My team (or the Whole floor), on opening,
 * when the network is back, and on a live change of the floor; a tap opens the basket's page. A worker's phone has no tab: the page
 * says so in words (never a dead tab).
 */

let keptBoard: { readonly scope: BoardScope; readonly board: FloorBoard } | null = null
const LIVE = (type: string) => type.startsWith('production.') || type.startsWith('help_call.')

export function FloorBoardPage() {
  const store = useFloor()
  const router = useFloorRouter()
  const { frame, onFrame } = store.frame('tile.board', { showHome: true })
  const { api, me, online, sessionEnded } = store
  const leader = boardTabShown(me?.permissions ?? [])
  const [scope, setScope] = useState<BoardScope>(keptBoard?.scope ?? 'team')
  const [board, setBoard] = useState<FloorBoard | null>(keptBoard?.board ?? null)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>(keptBoard ? 'ready' : 'loading')
  const [chip, setChip] = useState<string | null>(null)

  const read = useCallback(async () => {
    if (!leader) return
    const answer = await readFloorBoard(api, scope)
    if (answer.ok) {
      keptBoard = { scope, board: answer.value }
      setBoard(answer.value)
      setState('ready')
      setChip((now) => now ?? firstChip(chipsOf(answer.value), null))
      return
    }
    if (answer.problem.kind === 'signedOut') return void sessionEnded()
    setState(keptBoard && keptBoard.scope === scope ? 'ready' : 'failed')
  }, [api, scope, leader, sessionEnded])

  useEffect(() => {
    if (me) void read()
  }, [me, online, read])

  useLiveChanges({ onChange: (change) => (LIVE(change.type) ? void read() : undefined), onReconnect: () => void read() }, Boolean(me) && online && leader)

  const onAction = (action: FloorBoardAction) => {
    switch (action.type) {
      case 'scope':
        if (action.scope === scope) return
        setState('loading')
        return setScope(action.scope)
      case 'chip':
        return setChip(action.key)
      case 'open':
        return router.push(basketPath(action.code))
      case 'retry':
        setState('loading')
        return void read()
    }
  }

  useFloorKeys({ escape: () => router.push('/floor') })

  if (!me) return null
  return (
    <FloorFrameView frame={frame} onFrame={onFrame}>
      <FloorBoardView model={{ leader, scope, chip, board, state, online }} onAction={onAction} />
    </FloorFrameView>
  )
}
