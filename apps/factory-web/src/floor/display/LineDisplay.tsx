'use client'

import { useCallback } from 'react'
import { useFloor } from '../FloorApp'
import { LineBoardView } from '../../lib/line-board/view/LineBoardView'
import { useBoardRotation, useLineBoard } from '../../lib/line-board/use-line-board'
import { readDisplayBoard } from './api'

/**
 * `/floor/display` (SCR-173, design floor.display; MES-166): the wall screen of a DISPLAY device. Nobody signs in: the
 * device's token reads its own line's board every 10 seconds (a display has no session, so no live stream), the views
 * turn by themselves and nothing on it can be pressed. A revoked device goes back to enrolment; after a power cut the
 * floor app opens this page by itself (FloorApp's gate).
 */
export function LineDisplay() {
  const store = useFloor()
  const read = useCallback(() => readDisplayBoard(store.api), [store.api])
  const { board, problem, staleSince } = useLineBoard(read, { onSignedOut: () => void store.reload() })
  const { view } = useBoardRotation()
  return <LineBoardView model={{ board, problem, view, staleSince }} />
}
