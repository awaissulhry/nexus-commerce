'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { BOARD_VIEWS, boardProblemOf, isStale, POLL_MS, ROTATE_MS, stepView, type BoardProblem } from './model'
import type { LineBoard } from './schema'

export interface LineBoardRead<B extends LineBoard> {
  readonly board: B | null
  readonly problem: BoardProblem | null
  /** The board's own time of the last good read, while the board has had none for a minute. */
  readonly staleSince: string | null
  /** Reads now (a live hint in the preview, Try again). */
  readonly refresh: () => void
}

/**
 * Keeps a line board fresh: reads at once and every 10 seconds, keeps the last good board on the screen while a read
 * fails and says so after a minute (the design's amber band). A board that was refused for good (not a board, no line,
 * the device gone) is said at once, and `onSignedOut` hands a revoked device back to the floor app.
 */
export function useLineBoard<B extends LineBoard>(read: () => Promise<B>, options: { readonly onSignedOut?: () => void } = {}): LineBoardRead<B> {
  const [board, setBoard] = useState<B | null>(null)
  const [problem, setProblem] = useState<BoardProblem | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const lastGood = useRef<number | null>(null)
  const latestRead = useRef(read)
  latestRead.current = read
  const latestOut = useRef(options.onSignedOut)
  latestOut.current = options.onSignedOut
  const asked = useRef(0)

  const refresh = useCallback(() => {
    const ticket = ++asked.current
    latestRead
      .current()
      .then((answer) => {
        if (ticket !== asked.current) return
        lastGood.current = Date.now()
        setBoard(answer)
        setProblem(null)
      })
      .catch((error: unknown) => {
        if (ticket !== asked.current) return
        const why = boardProblemOf(error)
        if (why === 'signedOut') latestOut.current?.()
        setProblem(why)
        // Refused for good: nothing of the old line stays on the wall.
        if (why !== 'offline') setBoard(null)
      })
  }, [])

  useEffect(() => {
    refresh()
    const timer = window.setInterval(() => {
      setNow(Date.now())
      if (document.visibilityState !== 'hidden') refresh()
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [refresh])

  const staleSince = board && isStale(lastGood.current, now) ? board.asOf : null
  return { board, problem, staleSince, refresh }
}

/** The board's turn: the shown view, every 20 seconds the next one, by hand with `step` (the preview's keys), and paused. */
export function useBoardRotation(): { readonly view: number; readonly paused: boolean; readonly step: (by: 1 | -1) => void; readonly togglePause: () => void } {
  const [view, setView] = useState(0)
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    if (paused) return
    const timer = window.setInterval(() => setView((current) => stepView(current, 1, BOARD_VIEWS.length)), ROTATE_MS)
    return () => window.clearInterval(timer)
  }, [paused])
  const step = useCallback((by: 1 | -1) => setView((current) => stepView(current, by, BOARD_VIEWS.length)), [])
  const togglePause = useCallback(() => setPaused((current) => !current), [])
  return { view, paused, step, togglePause }
}
