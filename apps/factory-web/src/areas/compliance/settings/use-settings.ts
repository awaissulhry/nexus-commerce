'use client'

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { isApiError } from '../../../lib/api/errors'
import type { ApiClient } from '../../../lib/api/client'
import { isStepUpCancelled } from '../../quality/_shared/hooks'
import { markKey, problemOf, readProblemOf, type Mark, type Read, type RulesCan, type SettingsAddress, type WriteKind } from './model'
import type { Notice, Writing } from './view-model'

/**
 * The containers' shared helpers (SCR-262): what every tab's hook gets from the page, one read with its turn (an answer that
 * arrives after a newer read is dropped), a write's problem in words, and the cell marks of autosave per cell.
 */

export interface TabContext {
  readonly api: ApiClient
  /** The tab is shown: only then it reads. */
  readonly active: boolean
  readonly can: RulesCan
  readonly address: SettingsAddress
  readonly go: (change: Partial<SettingsAddress>) => void
  /** Runs a write; a 403 `stepUp` opens the code dialog and runs it once more (quality/_shared useStepUp). */
  readonly guard: <T>(sentence: string, work: () => Promise<T>) => Promise<T>
  readonly notify: (notice: Notice | null) => void
  /** A main read answered: the band's "Updated …". */
  readonly stamp: () => void
  readonly locale: 'it' | 'en'
  readonly companyId: string | null
  readonly today: string
  readonly me: string
  /** Bumped by a live event for this tab (or Read again): the tab reads again. */
  readonly tick: number
}

/** One read with its turn: `load(work)` sets loading only when asked, then the newest answer (or its problem). */
export function useRead<T>(): [Read<T>, (work: () => Promise<T>, quiet?: boolean) => Promise<T | null>, Dispatch<SetStateAction<Read<T>>>] {
  const [read, setRead] = useState<Read<T>>({ status: 'loading' })
  const turn = useRef(0)
  const load = useCallback(async (work: () => Promise<T>, quiet = false) => {
    const mine = ++turn.current
    if (!quiet) setRead({ status: 'loading' })
    try {
      const value = await work()
      if (mine === turn.current) setRead({ status: 'ready', value })
      return value
    } catch (error) {
      if (mine === turn.current) setRead({ status: 'error', problem: readProblemOf(error) })
      return null
    }
  }, [])
  return [read, load, setRead]
}

/** A write's problem as a dialog shows it: our words and the field (what kind of write says what a bare 409 means). */
export function writingOf(error: unknown, kind: WriteKind = 'edit'): Writing {
  if (isStepUpCancelled(error)) return { busy: false, problem: { key: 'problem.cancelled', field: null } }
  return { busy: false, problem: problemOf(error, kind) }
}

/** The cell marks of one list (autosave per cell): saving, unknown, saved (cleared after a moment), refused. */
export function useMarks(): [Readonly<Record<string, Mark>>, (id: string, field: string, mark: Mark | null) => void, <T>(id: string, field: string, work: () => Promise<T>) => Promise<T | null>] {
  const [marks, setMarks] = useState<Record<string, Mark>>({})
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), [])
  const set = useCallback((id: string, field: string, mark: Mark | null) => {
    const key = markKey(id, field)
    if (timers.current[key]) clearTimeout(timers.current[key])
    setMarks((current) => {
      const next = { ...current }
      if (mark) next[key] = mark
      else delete next[key]
      return next
    })
    if (mark?.state === 'saved') timers.current[key] = setTimeout(() => set(id, field, null), 1500)
  }, [])
  const save = useCallback(
    async <T,>(id: string, field: string, work: () => Promise<T>): Promise<T | null> => {
      set(id, field, { state: 'saving' })
      try {
        const answer = await work()
        set(id, field, { state: 'saved' })
        return answer
      } catch (error) {
        const unknown = !isApiError(error) || (error.kind === 'unavailable' && error.code === 'network')
        set(id, field, unknown ? { state: 'unknown' } : { state: 'refused', problem: problemOf(error).key })
        return null
      }
    },
    [set],
  )
  return [marks, set, save]
}

/** Runs writes one after the other; what was refused, in words (a bulk action says each refusal). */
export async function each<T>(items: readonly T[], write: (item: T) => Promise<unknown>, kind: WriteKind = 'edit'): Promise<{ done: number; refused: { item: T; key: string }[] }> {
  let done = 0
  const refused: { item: T; key: string }[] = []
  for (const item of items) {
    try {
      await write(item)
      done += 1
    } catch (error) {
      if (isStepUpCancelled(error)) {
        refused.push({ item, key: 'problem.cancelled' })
        break
      }
      refused.push({ item, key: problemOf(error, kind).key })
    }
  }
  return { done, refused }
}
