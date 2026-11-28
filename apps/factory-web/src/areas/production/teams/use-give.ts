'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../lib/api/client'
import { getOrderTeams, getTeamsBoard, putOrderTeams, type OrderTeams, type TeamsBoard } from './api'
import {
  addTeam,
  candidatesOf,
  giveDraftOf,
  giveHeldOf,
  problemKeyOf,
  putBodyOf,
  putInCharge,
  removeTeam,
  rowFactsOf,
  setMode,
  setShare,
  shareEvenly,
  withWhy,
  type GiveDraft,
} from './model'
import type { GiveWindowActions, GiveWindowModel } from './view/GiveTeamsWindow'

/**
 * owb-ss7 (7.2) — "Give to a team…" as one hook, for the two doors that open it (a card of the Teams page, the order's Team part): it
 * reads the order's teams (GET …/teams) and, when the page has none, the board of the site (the teams to add, their load and marks),
 * keeps the draft (model.ts), and saves it with ONE PUT at the version it read. A 409 reads the order again (the window says someone
 * changed it). Done → `onSaved(answer)` and the window closes.
 */

interface GiveState {
  readonly open: boolean
  readonly orderId: string | null
  readonly orderNumber: string | null
  readonly phase: 'reading' | 'ready' | 'failed'
  readonly problem: string | null
  readonly read: OrderTeams | null
  readonly board: TeamsBoard | null
  readonly boardFailed: boolean
  readonly draft: GiveDraft | null
  readonly query: string
  readonly busy: boolean
  readonly saveProblem: string | null
}

const CLOSED: GiveState = { open: false, orderId: null, orderNumber: null, phase: 'reading', problem: null, read: null, board: null, boardFailed: false, draft: null, query: '', busy: false, saveProblem: null }

export interface GiveOptions {
  /** The board the page already holds (the Teams page); absent: read here for the site (the order's part). */
  readonly board?: TeamsBoard | null
  /** The site the board is read for when the page holds none (the top bar's; null = the person's sites). */
  readonly siteId?: string | null
  readonly onSaved?: (answer: OrderTeams) => void
}

export function useGiveWindow(api: ApiClient | null, options: GiveOptions = {}): { readonly open: (orderId: string, orderNumber?: string | null) => void; readonly model: GiveWindowModel; readonly actions: GiveWindowActions } {
  const [state, setState] = useState<GiveState>(CLOSED)
  const readId = useRef(0)
  const latest = useRef(options)
  latest.current = options

  const load = useCallback(
    (orderId: string, problem: string | null) => {
      if (!api) return
      const id = ++readId.current
      const given = latest.current.board ?? null
      setState((current) => ({ ...current, phase: current.read && problem ? current.phase : 'reading', problem: null, saveProblem: problem }))
      getOrderTeams(api, orderId)
        .then((read) => {
          if (id !== readId.current) return
          setState((current) => (current.orderId === orderId ? { ...current, phase: 'ready', read, draft: giveDraftOf(read), busy: false } : current))
        })
        .catch((error: unknown) => {
          if (id === readId.current) setState((current) => (current.orderId === orderId ? { ...current, phase: 'failed', problem: problemKeyOf(error, false), busy: false } : current))
        })
      if (given) setState((current) => ({ ...current, board: given, boardFailed: false }))
      else
        getTeamsBoard(api, latest.current.siteId ?? null)
          .then((board) => id === readId.current && setState((current) => ({ ...current, board, boardFailed: false })))
          .catch(() => id === readId.current && setState((current) => ({ ...current, boardFailed: true })))
    },
    [api],
  )

  const open = useCallback(
    (orderId: string, orderNumber: string | null = null) => {
      setState({ ...CLOSED, open: true, orderId, orderNumber })
      load(orderId, null)
    },
    [load],
  )

  const change = useCallback((next: (draft: GiveDraft) => GiveDraft) => setState((current) => (current.draft && !current.busy ? { ...current, draft: next(current.draft), saveProblem: null } : current)), [])

  const save = useCallback(() => {
    const current = state
    if (!api || !current.draft || !current.orderId || current.busy || giveHeldOf(current.draft)) return
    const orderId = current.orderId
    setState((now) => ({ ...now, busy: true, saveProblem: null }))
    putOrderTeams(api, orderId, putBodyOf(current.draft))
      .then((answer) => {
        setState(CLOSED)
        latest.current.onSaved?.(answer)
      })
      .catch((error: unknown) => {
        const problem = problemKeyOf(error, true)
        if (problem === 'error.conflict') load(orderId, problem)
        else setState((now) => ({ ...now, busy: false, saveProblem: problem }))
      })
  }, [api, state, load])

  const board = options.board ?? state.board
  const model = useMemo<GiveWindowModel>(
    () => ({
      open: state.open,
      phase: state.phase,
      problem: state.problem,
      orderNumber: state.orderNumber,
      draft: state.draft,
      facts: state.draft && state.read ? rowFactsOf(state.draft, state.read, board) : new Map(),
      candidates: state.draft ? candidatesOf(state.draft, board, state.query) : [],
      boardFailed: !board && state.boardFailed,
      query: state.query,
      busy: state.busy,
      saveProblem: state.saveProblem,
    }),
    [state, board],
  )

  const actions = useMemo<GiveWindowActions>(
    () => ({
      onClose: () => setState((current) => (current.busy ? current : CLOSED)),
      onRetry: () => state.orderId && load(state.orderId, null),
      onAdd: (teamId) => change((draft) => addTeam(draft, teamId)),
      onRemove: (teamId) => change((draft) => removeTeam(draft, teamId)),
      onInCharge: (teamId) => change((draft) => putInCharge(draft, teamId)),
      onMode: (mode) => change((draft) => setMode(draft, mode)),
      onShare: (teamId, value) => change((draft) => setShare(draft, teamId, value)),
      onEven: () => change(shareEvenly),
      onWhy: (text) => change((draft) => withWhy(draft, text)),
      onQuery: (text) => setState((current) => ({ ...current, query: text })),
      onSave: save,
    }),
    [change, load, save, state.orderId],
  )

  return { open, model, actions }
}
