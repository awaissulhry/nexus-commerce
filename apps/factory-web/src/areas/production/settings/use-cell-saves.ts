'use client'

import { useCallback, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../lib/api/client'
import { markKey, w2bProblem, type Mark } from './w2b-model'

const SAVED_FADE_MS = 1500

interface Versioned {
  id: string
  version: number
}

/**
 * One cell saved at a time per row (design fr-offstd / fr-calls "autosave per cell"; the shared reason editor's way): the
 * new value shows at once with the DS save mark, the write waits for the row's previous one so it carries that answer's
 * version, the answer replaces the row; a refusal puts the value back and says why on the cell; a lost answer says
 * "not known" and keeps what was typed. Each write has its own Idempotency-Key.
 */
export function useCellSaves<Row extends Versioned>(rowNow: (id: string) => Row | undefined, putRow: (row: Row) => void, onConflict?: () => void) {
  const [marks, setMarks] = useState<Record<string, Mark>>({})
  const queues = useRef(new Map<string, Promise<unknown>>())

  const setMark = useCallback((id: string, field: string, mark: Mark | null) => {
    setMarks((current) => {
      const next = { ...current }
      if (mark) next[markKey(id, field)] = mark
      else delete next[markKey(id, field)]
      return next
    })
  }, [])

  const save = useCallback(
    (id: string, field: string, optimistic: (row: Row) => Row, write: (version: number, key: string) => Promise<Row>) => {
      const before = rowNow(id)
      if (!before) return
      putRow(optimistic(before))
      setMark(id, field, { state: 'saving' })
      const previous = queues.current.get(id) ?? Promise.resolve()
      const run = previous
        .catch(() => undefined)
        .then(async () => {
          const current = rowNow(id) ?? before
          try {
            const saved = await write(current.version, newIdempotencyKey())
            putRow(saved)
            setMark(id, field, { state: 'saved' })
            setTimeout(() => setMarks((all) => (all[markKey(id, field)]?.state === 'saved' ? Object.fromEntries(Object.entries(all).filter(([key]) => key !== markKey(id, field))) : all)), SAVED_FADE_MS)
          } catch (error) {
            const problem = w2bProblem(error)
            // Never a value the server did not take; a lost answer is "not known" and keeps what was typed.
            if (!problem.unknown) putRow({ ...before, version: (rowNow(id) ?? before).version })
            setMark(id, field, { state: problem.unknown ? 'unknown' : 'refused', problem: problem.key })
            if (problem.conflict) onConflict?.()
          }
        })
      queues.current.set(id, run)
      void run.finally(() => {
        if (queues.current.get(id) === run) queues.current.delete(id)
      })
    },
    [rowNow, putRow, setMark, onConflict],
  )

  const refuse = useCallback((id: string, field: string, problem: string) => setMark(id, field, { state: 'refused', problem }), [setMark])

  return { marks, save, refuse, clear: () => setMarks({}) }
}
