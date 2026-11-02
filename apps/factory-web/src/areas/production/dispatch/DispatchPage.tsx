'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { PlanningMove } from '@nexus/ui/patterns/planning-board/index'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { useOfficeScope } from '../../../shell/scope/scope-context'
import { BOARD_KIT_NAMESPACE } from '../../_shared/planning-board/words'
import { useCoalesced, useLive } from '../_shared/hooks'
import type { Phrase } from '../_shared/model'
import { assignOperator, getBoard, getOperators, moveWork, reassignOperator, removeOperator, type DispatchBoard, type DispatchCard, type LaneOperator, type MoveAnswer, type MoveBody } from './api'
import {
  addressOf,
  addressText,
  dispatchCanOf,
  DISPATCH_NAMESPACE,
  drawBoard,
  laneStep,
  cardLabel,
  moveBodyOf,
  moveBundlesBody,
  movedCard,
  needsReason,
  readProblemOf,
  refusalOf,
  stationLabel,
  stationOf,
  touchesBoard,
  type DispatchAddress,
  type Words,
} from './model'
import type { AssignTarget, DispatchActions, DispatchDialog, DispatchNotice, DispatchViewModel, Loaded } from './view-model'
import { DispatchView } from './view/DispatchView'

const SCANS_EVERY = 10_000

/**
 * `/w/<company>/production/dispatch?site=&line=&date=` (SCR-138; production.dispatch.view): the board of a site's day (the top
 * bar's site, else `?site=`, else the person's first), one read for the whole screen, read again after every write and
 * on the live messages (a move or an assignment at once, the scans at most every 10 seconds, as Floor now). Never optimistic:
 * a card stays "Saving" until the API answered and the board was read again. Every move is sent with the card's key; the
 * API's `undo` is kept and posted back as it came (the board's Undo / Redo, ⌘Z), and a dialog's move offers it in the notice.
 * A warned person or station asks the reason (409 `refusal/OVERRIDE_REASON_NEEDED`) and sends the same again.
 */
export function DispatchPage() {
  return (
    <WithMessages namespaces={[DISPATCH_NAMESPACE, BOARD_KIT_NAMESPACE]}>
      <Container />
    </WithMessages>
  )
}

function Container() {
  const t = useT(DISPATCH_NAMESPACE)
  const locale = useLocale()
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const params = useSearchParams()
  const query = params?.toString() ?? ''
  const address = useMemo(() => addressOf(new URLSearchParams(query)), [query])
  const addressRef = useRef(address)
  addressRef.current = address
  const prefix = pathname.replace(/\/production\/dispatch\/?$/, '')
  const can = useMemo(() => dispatchCanOf(session.permissions), [session.permissions])
  const sites = scope.sites.length > 0 ? scope.sites : session.sites
  const siteId = scope.siteId ?? (sites.find((site) => site.id === address.site) ?? sites[0])?.id ?? null

  const [read, setRead] = useState<Loaded<DispatchBoard>>({ status: 'loading' })
  const [changedAt, setChangedAt] = useState<string | null>(null)
  const [notice, setNotice] = useState<DispatchNotice | null>(null)
  const [dialog, setDialog] = useState<DispatchDialog | null>(null)
  const [reasonFor, setReasonFor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [online, setOnline] = useState(true)
  const boardRef = useRef<DispatchBoard | null>(null)
  const readId = useRef(0)
  const aliases = useRef(new Map<string, string>())
  // The bodies that put the board's moves back, in step with the DS board's own undo list.
  const undoBodies = useRef<MoveBody[]>([])
  const redoBodies = useRef<MoveBody[]>([])
  const reasonAnswer = useRef<((reason: string | null) => void) | null>(null)
  const dialogRef = useRef(dialog)
  dialogRef.current = dialog
  const noticeRef = useRef(notice)
  noticeRef.current = notice

  const words = useMemo<Words>(() => ({ t, locale, timeZone: read.status === 'ready' ? read.value.site.timeZone : 'Europe/Rome' }), [t, locale, read])

  const go = useCallback((next: Partial<DispatchAddress>) => router.replace(`${pathname}${addressText({ ...addressRef.current, ...next })}`, { scroll: false }), [router, pathname])

  const load = useCallback(
    async (after?: (board: DispatchBoard) => void): Promise<DispatchBoard | null> => {
      if (!can.view) return null
      if (!siteId) {
        setRead({ status: 'error', problem: 'error.noSite' })
        return null
      }
      const id = ++readId.current
      try {
        const value = await getBoard(api, { siteId, date: addressRef.current.date })
        after?.(value)
        if (id !== readId.current) return value
        boardRef.current = value
        setRead({ status: 'ready', value })
        return value
      } catch (error) {
        if (id !== readId.current) return null
        // A board on the screen stays: only the first read has nothing to show.
        if (boardRef.current?.site.id === siteId && boardRef.current.day === (addressRef.current.date ?? boardRef.current.day)) setNotice({ tone: 'warning', words: { key: 'error.stale' } })
        else setRead({ status: 'error', problem: readProblemOf(error) })
        return null
      }
    },
    [api, can.view, siteId],
  )

  // Another site or day: another board, with its own undo list.
  useEffect(() => {
    aliases.current = new Map()
    undoBodies.current = []
    redoBodies.current = []
    boardRef.current = null
    setNotice(null)
    setDialog(null)
    setRead({ status: 'loading' })
    void load()
  }, [load, address.date])

  const rereadSoon = useCoalesced(() => void load(), 700)
  const rereadSlowly = useCoalesced(() => void load(), SCANS_EVERY)
  const live = useLive(
    (change) => {
      if (!touchesBoard(change.type, change.fields.siteId, siteId)) return
      if (change.type === 'production.scan_recorded') return rereadSlowly()
      if (change.type === 'dispatch.assignment_changed') setChangedAt(new Date().toISOString())
      rereadSoon()
    },
    () => void load(),
    siteId !== null && can.view,
  )
  useEffect(() => {
    const update = () => setOnline(typeof navigator === 'undefined' ? true : navigator.onLine)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  const offline = !online || live === 'offline'

  // ---- moves ----------------------------------------------------------------------------------------------------------

  const askReason = useCallback((label: string) => {
    return new Promise<string | null>((resolve) => {
      reasonAnswer.current = resolve
      setReasonFor(label)
    })
  }, [])

  const onReason = useCallback((reason: string | null) => {
    reasonAnswer.current?.(reason)
    reasonAnswer.current = null
    setReasonFor(null)
  }, [])

  /** One move, the reason asked when the site's rule wants one; null: the person kept it as it was. */
  const send = useCallback(
    async (body: MoveBody, label: string): Promise<MoveAnswer | null> => {
      try {
        return await moveWork(api, body)
      } catch (error) {
        if (!needsReason(error)) throw error
        const reason = await askReason(label)
        if (reason === null) return null
        return moveWork(api, { ...body, overrideReason: reason })
      }
    },
    [api, askReason],
  )

  /** The board read again; the moved card keeps the id the board knows it by. */
  const afterMove = useCallback(
    async (answer: MoveAnswer, operationId: string, boardId: string | null) => {
      setChangedAt(new Date().toISOString())
      await load((board) => {
        if (!boardId) return
        const card = movedCard(board, operationId, answer.moved.key)
        if (!card) return
        if (card.id === boardId) aliases.current.delete(card.id)
        else aliases.current.set(card.id, boardId)
      })
      if (answer.warnings.length > 0) setNotice({ tone: 'warning', words: { key: 'notice.sequence' } })
    },
    [load],
  )

  const onMove = useCallback(
    async (move: PlanningMove): Promise<boolean> => {
      const board = boardRef.current
      if (!board) return false
      const card = drawBoard(board, addressRef.current, aliases.current, words).byId.get(move.cardId)
      if (!card) return false
      setNotice(null)
      const body = move.via === 'undo' ? undoBodies.current.at(-1) : move.via === 'redo' ? redoBodies.current.at(-1) : moveBodyOf(card, board.day, move.to)
      if (!body) return false
      try {
        const answer = await send(body, cardLabel(card, t))
        if (!answer) return false
        if (move.via === 'undo') {
          undoBodies.current.pop()
          redoBodies.current.push(answer.undo)
        } else if (move.via === 'redo') {
          redoBodies.current.pop()
          undoBodies.current.push(answer.undo)
        } else {
          undoBodies.current.push(answer.undo)
          redoBodies.current = []
        }
        await afterMove(answer, card.operation.id, move.cardId)
        return true
      } catch (error) {
        setNotice({ tone: 'danger', words: refusalOf(error) })
        void load()
        return false
      }
    },
    [words, t, send, afterMove, load],
  )

  /** A move made from a dialog: said in the notice, with its Undo. */
  const moveFromDialog = useCallback(
    async (body: MoveBody, card: DispatchCard, done: Phrase): Promise<boolean> => {
      const answer = await send(body, cardLabel(card, t))
      if (!answer) return false
      setDialog(null)
      await afterMove(answer, card.operation.id, null)
      setNotice((current) => (current?.tone === 'warning' ? { ...current, undo: answer.undo } : { tone: 'success', words: done, undo: answer.undo }))
      return true
    },
    [send, afterMove, t],
  )

  const onMoveBundles = useCallback(async () => {
    const board = boardRef.current
    const open = dialogRef.current
    if (!board || open?.kind !== 'move' || !open.target) return
    const card = drawBoard(board, addressRef.current, aliases.current, words).byId.get(open.cardId)
    if (!card) return
    const target = open.target
    const stationId = target.startsWith('station:') ? target.slice('station:'.length) : null
    const station = stationOf(board, stationId)
    const place = station ? stationLabel(board, station) : (board.lines.find((line) => `line:${line.id}` === target)?.code ?? '')
    setBusy(true)
    try {
      await moveFromDialog(moveBundlesBody(card, board.day, target, open.picked), card, { key: 'notice.movedBundles', params: { count: open.picked.length, place } })
    } catch (error) {
      setDialog({ ...open, problem: refusalOf(error) })
      void load()
    } finally {
      setBusy(false)
    }
  }, [words, moveFromDialog, load])

  const onStep = useCallback(
    async (card: DispatchCard, direction: -1 | 1) => {
      const board = boardRef.current
      if (!board) return
      const step = laneStep(board, card, direction)
      if (!step.body) return
      setBusy(true)
      try {
        await moveFromDialog(step.body, card, { key: direction < 0 ? 'notice.earlier' : 'notice.later', params: { card: cardLabel(card, t) } })
      } catch (error) {
        setDialog(null)
        setNotice({ tone: 'danger', words: refusalOf(error) })
        void load()
      } finally {
        setBusy(false)
      }
    },
    [moveFromDialog, load, t],
  )

  const onBack = useCallback(
    async (card: DispatchCard) => {
      const board = boardRef.current
      if (!board) return
      setBusy(true)
      try {
        await moveFromDialog(moveBodyOf(card, board.day, { laneId: null, bucketId: null }), card, { key: 'notice.back', params: { card: cardLabel(card, t) } })
      } catch (error) {
        setDialog(null)
        setNotice({ tone: 'danger', words: refusalOf(error) })
        void load()
      } finally {
        setBusy(false)
      }
    },
    [moveFromDialog, load, t],
  )

  const onUndoNotice = useCallback(async () => {
    const undo = noticeRef.current?.undo
    if (!undo) return
    setBusy(true)
    try {
      const answer = await send(undo, '')
      if (!answer) return
      await afterMove(answer, undo.workOrderOperationId, null)
      setNotice({ tone: 'success', words: { key: 'notice.undone' } })
    } catch (error) {
      setNotice({ tone: 'danger', words: refusalOf(error) })
      void load()
    } finally {
      setBusy(false)
    }
  }, [send, afterMove, load])

  // ---- operators --------------------------------------------------------------------------------------------------------

  const onAssignStart = useCallback(
    (target: AssignTarget) => {
      const board = boardRef.current
      if (!board || !siteId) return
      setDialog({ kind: 'assign', target, picker: { status: 'loading' }, workerId: null, reason: '', askReason: false, problem: null })
      const ask = target.kind === 'reassign' ? { assignmentId: target.assignmentId, workOrderOperationId: target.operationId } : { stationId: target.stationId, workOrderOperationId: target.operationId }
      const fill = (picker: Extract<DispatchDialog, { kind: 'assign' }>['picker']) => setDialog((current) => (current?.kind === 'assign' ? { ...current, picker } : current))
      getOperators(api, { siteId, date: board.day, ...ask })
        .then((value) => fill({ status: 'ready', value }))
        .catch((error: unknown) => fill({ status: 'error', problem: readProblemOf(error) }))
    },
    [api, siteId],
  )

  const onAssign = useCallback(async () => {
    const board = boardRef.current
    const open = dialogRef.current
    if (!board || open?.kind !== 'assign' || !open.workerId) return
    const { target, workerId } = open
    const person = open.picker.status === 'ready' ? open.picker.value.operators.find((entry) => entry.workerId === workerId) : undefined
    const reason = open.reason.trim()
    const overrideReason = reason ? { overrideReason: reason } : {}
    setBusy(true)
    try {
      if (target.kind === 'reassign') await reassignOperator(api, { id: target.assignmentId, version: target.version }, { workerId, ...overrideReason })
      else if (target.kind === 'station') await assignOperator(api, { date: board.day, workerId, stationId: target.stationId, ...overrideReason })
      else await assignOperator(api, { date: board.day, workerId, workOrderOperationId: target.operationId, ...(target.stationId ? { stationId: target.stationId } : {}), ...overrideReason })
      setDialog(null)
      setChangedAt(new Date().toISOString())
      await load()
      setNotice({ tone: 'success', words: { key: 'notice.assigned', params: { person: person?.name ?? '', place: target.place } } })
    } catch (error) {
      if (needsReason(error)) setDialog({ ...open, askReason: true, problem: { key: 'assign.askReason' } })
      else setDialog({ ...open, problem: refusalOf(error) })
    } finally {
      setBusy(false)
    }
  }, [api, load])

  const onRemove = useCallback(
    async (operator: LaneOperator, place: string) => {
      setBusy(true)
      try {
        await removeOperator(api, { id: operator.assignmentId, version: operator.version })
        setChangedAt(new Date().toISOString())
        await load()
        setNotice({ tone: 'success', words: { key: 'notice.removed', params: { person: operator.name, place } } })
      } catch (error) {
        setNotice({ tone: 'danger', words: refusalOf(error) })
        void load()
      } finally {
        setBusy(false)
      }
    },
    [api, load],
  )

  const model: DispatchViewModel = {
    prefix,
    can,
    address,
    sites: scope.siteId ? [] : sites,
    read,
    aliases: aliases.current,
    live,
    offline,
    changedAt,
    notice,
    dialog,
    reasonFor,
    busy,
  }
  const actions: DispatchActions = {
    onAddress: go,
    onRetry: () => {
      setRead({ status: 'loading' })
      void load()
    },
    onMove,
    onDialog: setDialog,
    onAssignStart,
    onAssign: () => void onAssign(),
    onRemove: (operator, place) => void onRemove(operator, place),
    onMoveBundles: () => void onMoveBundles(),
    onStep: (card, direction) => void onStep(card, direction),
    onBack: (card) => void onBack(card),
    onUndoNotice: () => void onUndoNotice(),
    onDismissNotice: () => setNotice(null),
    onReason,
  }
  return <DispatchView model={model} actions={actions} />
}
