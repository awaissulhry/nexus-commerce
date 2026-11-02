'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SaveStatusState } from '@nexus/ui/components/SaveStatus/index'
import type { ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import type { Notice } from '../_shared/parts'
import { readRoster, writeCells, type Ref, type Roster, type RosterCell } from './api'
import { cellId, draftsOf, echoOf, filterOptions, heldCells, ownWriteOf, piecesOf, planOf, problemOf, readProblem, refusalOf, replayOf, setOfEdit, setOfKey, setOfOption, sheetIndex, sheetRowsOf, writesOf, type CellRef, type DayRange, type OwnWrite, type PlannedCell, type Words } from './model'
import type { Mark, RosterState } from './view-model'

/** After a save the sheet reads again, so a neighbour's warning and the foot rows follow. */
const SETTLE_MS = 350
/** How long a write of ours waits for its live echo (the relay may lag). */
const OWN_MS = 60_000

export interface RosterArgs {
  readonly api: ApiClient
  readonly enabled: boolean
  readonly siteId: string | null
  readonly range: DayRange
  readonly lineId: string | null
  readonly teamId: string | null
  readonly say: (words: Words) => string
  readonly onNotice: (notice: Notice | null) => void
}

/**
 * The roster's container: one read per range, line and team (a quiet read keeps the rows on screen), and one write path —
 * a keystroke, the fill handle, Set shift and ⌘Z all come here as planned cells and go out in order, the version each cell
 * has when its turn comes. A cell shows "saving" until the server answered, "refused" with its reason, nothing once saved;
 * a write that never reached the server may be sent again. Undo keeps the batches of this range.
 */
export function useRoster({ api, enabled, siteId, range, lineId, teamId, say, onNotice }: RosterArgs) {
  const [state, setState] = useState<RosterState>({ status: 'loading' })
  const [marks, setMarks] = useState<Record<string, Mark>>({})
  const [asOf, setAsOf] = useState<string | null>(null)
  const [saving, setSaving] = useState(0)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [unsent, setUnsent] = useState<PlannedCell[]>([])
  const [stacks, setStacks] = useState<{ past: PlannedCell[][]; future: PlannedCell[][] }>({ past: [], future: [] })
  const [elsewhere, setElsewhere] = useState<{ cells: number; at: string } | null>(null)
  const [known, setKnown] = useState<ReturnType<typeof filterOptions>>({ lines: [], teams: [] })

  const query = useMemo(() => ({ siteId, from: range.from, to: range.to, lineId, teamId }), [siteId, range.from, range.to, lineId, teamId])
  const queryRef = useRef(query)
  queryRef.current = query
  const stamp = useRef(0)

  const read = useCallback(
    async (quiet: boolean) => {
      if (!enabled) return
      const ticket = ++stamp.current
      if (!quiet) setState({ status: 'loading' })
      try {
        const value = await readRoster(api, queryRef.current)
        if (ticket !== stamp.current) return
        setState({ status: 'ready', value })
        setAsOf(new Date().toISOString())
        setKnown((before) => filterOptions(value.rows, before))
      } catch (error) {
        if (ticket !== stamp.current) return
        if (!quiet) setState({ status: 'error', problem: readProblem(error) })
      }
    },
    [api, enabled],
  )

  useEffect(() => {
    void read(false)
    setMarks({})
    setStacks({ past: [], future: [] })
    setUnsent([])
    setElsewhere(null)
  }, [read, query])

  const rows = useMemo(() => (state.status === 'ready' ? sheetRowsOf(state.value) : []), [state])
  const index = useMemo(() => sheetIndex(rows), [rows])
  const indexRef = useRef(index)
  indexRef.current = index
  const choices = useMemo(() => (state.status === 'ready' ? state.value.choices : []), [state])
  const choicesRef = useRef(choices)
  choicesRef.current = choices

  const settle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const own = useRef<OwnWrite[]>([])
  const noteOwn = useCallback((cells: readonly CellRef[]) => {
    const write = ownWriteOf(cells, Date.now())
    if (write) own.current.push(write)
  }, [])
  const readSoon = useCallback(() => {
    if (settle.current) clearTimeout(settle.current)
    settle.current = setTimeout(() => void read(true), SETTLE_MS)
  }, [read])
  useEffect(
    () => () => {
      if (settle.current) clearTimeout(settle.current)
    },
    [],
  )

  const mark = useCallback((cells: readonly CellRef[], value: Mark | null) => {
    setMarks((before) => {
      const next = { ...before }
      for (const cell of cells) {
        const id = cellId(cell.employeeId, cell.date)
        if (value) next[id] = value
        else delete next[id]
      }
      return next
    })
  }, [])

  const merge = useCallback((cells: ReadonlyArray<{ employeeId: string; date: string; cell: RosterCell }>) => {
    setState((before) => {
      if (before.status !== 'ready') return before
      const byPerson = new Map<string, Map<string, RosterCell>>()
      for (const entry of cells) byPerson.set(entry.employeeId, (byPerson.get(entry.employeeId) ?? new Map<string, RosterCell>()).set(entry.date, entry.cell))
      const value: Roster = {
        ...before.value,
        rows: before.value.rows.map((row) => {
          const changed = byPerson.get(row.employeeId)
          return changed ? { ...row, cells: row.cells.map((cell) => changed.get(cell.date) ?? cell) } : row
        }),
      }
      return { status: 'ready', value }
    })
  }, [])

  const flight = useRef<Promise<void>>(Promise.resolve())
  /** Sends planned cells in order; `done` hears whether all of them were stored. */
  const send = useCallback(
    (changes: readonly PlannedCell[], done?: (stored: boolean) => void) => {
      if (changes.length === 0) return
      mark(changes, { state: 'saving' })
      setSaving((count) => count + 1)
      flight.current = flight.current.then(async () => {
        let stored = true
        for (const piece of piecesOf(changes)) {
          try {
            noteOwn(piece)
            const answer = await writeCells(api, writesOf(piece, indexRef.current))
            merge(answer.cells)
            mark(piece, null)
            setSavedAt(new Date().toISOString())
            if (answer.warnings > 0) onNotice({ tone: 'warning', words: { key: 'notice.warnings', params: { count: answer.warnings } } })
          } catch (error) {
            stored = false
            const reachedServer = isApiError(error) && (refusalOf(error) !== null || ['conflict', 'invalid', 'forbidden', 'not_found'].includes(error.kind))
            const words = problemOf(error)
            const blocked = heldCells(error)
            if (reachedServer) {
              mark(piece, { state: 'refused', reason: say(words) })
              onNotice({ tone: 'danger', words, ...(blocked.length > 0 ? { detail: { key: 'notice.heldCells', params: { count: blocked.length } } } : {}) })
              // A conflict: what is there now, under the refused mark.
              if (isApiError(error) && error.kind === 'conflict') void read(true)
            } else {
              mark(piece, { state: 'unknown', reason: say(words) })
              setUnsent((before) => [...before, ...piece])
            }
            break
          }
        }
        setSaving((count) => count - 1)
        if (stored) readSoon()
        done?.(stored)
      })
    },
    [api, mark, merge, noteOwn, onNotice, read, readSoon, say],
  )

  const plan = useCallback(
    (targets: readonly CellRef[], setFor: Parameters<typeof planOf>[2]) => {
      const planned = planOf(indexRef.current, targets, setFor)
      if (planned.held.length > 0) onNotice({ tone: 'info', words: { key: planned.held[0]!.why }, ...(planned.held.length > 1 ? { detail: { key: 'notice.heldMore', params: { count: planned.held.length } } } : {}) })
      if (planned.changes.length === 0) return
      const batch = [...planned.changes]
      send(batch, (stored) => {
        if (stored) setStacks((before) => ({ past: [...before.past, batch].slice(-50), future: [] }))
      })
    },
    [onNotice, send],
  )

  const onEdits = useCallback(
    (edits: ReadonlyArray<CellRef & { value: unknown }>) => {
      const values = new Map(edits.map((edit) => [cellId(edit.employeeId, edit.date), edit.value]))
      plan(edits, (target) => setOfEdit(values.get(cellId(target.employeeId, target.date)), choicesRef.current))
    },
    [plan],
  )

  const onKey = useCallback(
    (key: string, cells: readonly CellRef[]): boolean => {
      if (cells.length === 0) return false
      if (key === 'Delete') {
        plan(cells, null)
        return true
      }
      const set = setOfKey(key, choicesRef.current)
      if (set === undefined) return false
      plan(cells, set)
      return true
    },
    [plan],
  )

  const onSetOption = useCallback(
    (option: string, cells: readonly CellRef[]) => {
      const set = setOfOption(option, choicesRef.current)
      if (set !== undefined) plan(cells, set)
    },
    [plan],
  )

  const replay = useCallback(
    (direction: 'undo' | 'redo') => {
      const from = direction === 'undo' ? stacks.past : stacks.future
      const batch = from.at(-1)
      if (!batch) return
      const { changes, kept } = replayOf(batch, direction, indexRef.current)
      if (kept > 0) onNotice({ tone: 'info', words: { key: 'notice.kept', params: { count: kept } } })
      setStacks((before) =>
        direction === 'undo' ? { past: before.past.slice(0, -1), future: [...before.future, batch] } : { past: [...before.past, batch], future: before.future.slice(0, -1) },
      )
      send(changes)
    },
    [stacks, onNotice, send],
  )

  const retry = useCallback(() => {
    const cells = unsent
    setUnsent([])
    send(cells)
  }, [unsent, send])

  /** A batch written elsewhere (Assign, Copy last week): ⌘Z puts it back too. */
  const remember = useCallback((batch: readonly PlannedCell[]) => {
    noteOwn(batch)
    if (batch.length > 0) setStacks((before) => ({ past: [...before.past, [...batch]].slice(-50), future: [] }))
  }, [noteOwn])
  const undoBatch = useCallback(
    (batch: readonly PlannedCell[], done?: (stored: boolean) => void) => {
      const { changes, kept } = replayOf(batch, 'undo', indexRef.current)
      if (kept > 0) onNotice({ tone: 'info', words: { key: 'notice.kept', params: { count: kept } } })
      setStacks((before) => ({ past: before.past.slice(0, -1), future: before.future }))
      if (changes.length === 0) done?.(true)
      else send(changes, done)
    },
    [onNotice, send],
  )

  /** A live change: read again; one that is not the echo of our own write says so in the band. */
  const onLive = useCallback(
    (cells: number, from: string | null, to: string | null) => {
      const echo = echoOf(own.current, from, to, Date.now(), OWN_MS)
      own.current = echo.own
      if (!echo.mine && cells > 0) setElsewhere((before) => ({ cells: (before?.cells ?? 0) + cells, at: new Date().toISOString() }))
      readSoon()
    },
    [readSoon],
  )

  const save = useMemo<SaveStatusState>(() => {
    if (saving > 0) return { kind: 'saving' }
    // A refused cell stays refused until it is edited again: "all saved" is never said over it.
    const failed = unsent.length + Object.values(marks).filter((entry) => entry.state === 'refused').length
    if (failed > 0) return { kind: 'failed', count: failed }
    return savedAt ? { kind: 'saved', at: savedAt } : { kind: 'idle' }
  }, [saving, unsent, marks, savedAt])

  const drafts = useMemo(() => {
    const value = state.status === 'ready' ? state.value.rows : []
    return { ...draftsOf(value), people: value.filter((row) => row.canEdit && row.cells.some((cell) => cell.entry?.status === 'DRAFT')).length }
  }, [state])

  return {
    state,
    rows,
    choices,
    marks,
    save,
    canRetry: unsent.length > 0,
    canUndo: stacks.past.length > 0,
    canRedo: stacks.future.length > 0,
    drafts,
    elsewhere,
    asOf,
    lines: known.lines as readonly Ref[],
    teams: known.teams,
    read,
    onEdits,
    onKey,
    onSetOption,
    onUndo: useCallback(() => replay('undo'), [replay]),
    onRedo: useCallback(() => replay('redo'), [replay]),
    onRetry: retry,
    onLive,
    remember,
    undoBatch,
    clearElsewhere: useCallback(() => setElsewhere(null), []),
  }
}
