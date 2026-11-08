'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConfirmFeedback, type FeedbackKind } from '@nexus/ui/floor'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useLiveChanges } from '../../../record-panels/live'
import { zxingCamera } from '../../camera'
import { useFloor, useFloorRouter } from '../../FloorApp'
import { useFloorKeys } from '../../keys'
import { readScan } from '../../scan/scan-model'
import { AsOfMemory, codeKey } from '../shared/as-of'
import { queuedView } from '../shared/queued'
import type { TaskProblem } from '../shared/task-api'
import {
  addRollOrKeep,
  confirmFabric,
  countOrKeep,
  fetchLay,
  fetchOpenTrolleys,
  fetchProcesses,
  fetchRecut,
  fetchRecuts,
  fetchStickers,
  fetchTicket,
  fetchWaitingTickets,
  makeRun,
  moveProcess,
  moveRecut,
  printRecut,
  reprintRun,
  scanTicketMove,
  scanTrolley,
  trolleyOrKeep,
  undoRollOrKeep,
  type LayView,
  type OpenTrolleys,
  type RecutsWaiting,
  type TicketCard,
  type Trolley,
  type TrolleyMove,
  type WaitingTicket,
} from './api'
import { applyKeptCount, applyKeptRoll, applyKeptUndo, countProblem, fabricBody, fabricScan, fabricStart, isTrolleyCode, rollBody, rollDraftOf, rollHeld, sameCode, sendHeld, stepOf, toggleMissing, trolleyCodeOf } from './model'
import { FabricCutView, type FabricAction, type FabricStep, type Wrong } from './view/FabricCutView'
import type { DoneLine } from './view/parts'

/**
 * The live SCR-182 (`/floor/fabriccut`; B-W2b-121 on the API of B-W2b-112, -116 and -117). One cutting table, one job at a time:
 * the ticket → the lay spread roll by roll → both ends counted → the cut → ply stickers → fabric used; beside it the recut tickets
 * waiting and the trolleys to sewing.
 *
 *   online first  a roll, Undo last roll, the count at both ends, a trolley's load / unload / send / receive: a network failure
 *                 keeps them on the tablet (`production.lay.*`, `production.trolley.*`) under the try's id; the lay on screen moves
 *                 at once (model.ts applyKept…) and the strip shows their ticks
 *   online only   the start and end scans, ply stickers, fabric used, recut start / finish / print, a secondary process's tap: held
 *                 with the reason offline
 *   kept          what this tablet read this visit (the tickets, cards, lays, recuts, trolleys) opens offline with its as-of time
 * Live: cut_ticket / lay / ply_run / cut_consumption / recut_ticket / cut_issue / secondary_process changes read the screen again.
 * Never a person, never money.
 */

const WAITING = new AsOfMemory<readonly WaitingTicket[]>(1)
const RECUTS = new AsOfMemory<RecutsWaiting>(1)
const OPEN = new AsOfMemory<OpenTrolleys>(1)
const CARDS = new AsOfMemory<TicketCard>(60)
const LAYS = new AsOfMemory<LayView>(60)
const TROLLEYS = new AsOfMemory<Trolley>(60)
const LIVE = new Set(['cut_ticket.changed', 'lay.changed', 'ply_run.changed', 'cut_consumption.changed', 'recut_ticket.changed', 'cut_issue.changed', 'secondary_process.changed'])

type Done = Omit<DoneLine, 'ticks'> & { readonly queued: string | null }

export function FloorFabricCut() {
  const store = useFloor()
  const router = useFloorRouter()
  const confirm = useConfirmFeedback()
  const feedback = useCallback((kind: FeedbackKind) => confirm(kind, document.getElementById('fw-fc-flash')), [confirm])
  const { frame, onFrame } = store.frame('tile.fabriccut', { showHome: true })
  const { api, me, device, online, queue, queueSnapshot, sessionEnded, locale } = store
  const permissions = useMemo(() => new Set(me?.permissions ?? []), [me?.permissions])
  const mayCut = permissions.has('production.cut')
  const may = useMemo(() => ({ trolleys: permissions.has('production.trolleys'), secondary: permissions.has('production.secondary') }), [permissions])
  const deviceId = me?.device.id ?? device?.device.id ?? null
  const lang: 'it' | 'en' = locale === 'it' ? 'it' : 'en'

  const [step, setStep] = useState<FabricStep>(() => {
    if (!mayCut) return { kind: 'noPermission' }
    const kept = WAITING.get('site')
    return { kind: 'start', tickets: kept?.value ?? null, asOf: kept ? kept.asOf : null, recuts: RECUTS.get('site')?.value.rows.length ?? null }
  })
  const [done, setDone] = useState<Done | null>(null)
  const [notice, setNotice] = useState<TaskProblem | null>(null)
  const acting = useRef(false)
  const shown = useRef(step)
  shown.current = step
  const taken = useRef(false)

  const ended = useCallback(
    (problem: TaskProblem) => {
      if (problem.kind === 'signedOut') void sessionEnded()
    },
    [sessionEnded],
  )

  // ---- reads ----------------------------------------------------------------------------------------------------------------------

  const loadStart = useCallback(async () => {
    const [tickets, recuts] = await Promise.all([fetchWaitingTickets(api), fetchRecuts(api)])
    if (recuts.ok) RECUTS.keep('site', recuts.value)
    else ended(recuts.problem)
    const recutCount = recuts.ok ? recuts.value.rows.length : (RECUTS.get('site')?.value.rows.length ?? null)
    if (tickets.ok) {
      WAITING.keep('site', tickets.value)
      return setStep((now) => (now.kind === 'start' ? { ...now, tickets: tickets.value, asOf: null, recuts: recutCount } : now))
    }
    ended(tickets.problem)
    const kept = WAITING.get('site')
    setStep((now) => (now.kind === 'start' ? { ...now, tickets: kept?.value ?? [], asOf: kept?.asOf ?? null, recuts: recutCount } : now))
  }, [api, ended])

  /** A lay as the office has it now (kept for the visit), else what this tablet holds. */
  const layOf = useCallback(
    async (layId: string): Promise<{ lay: LayView; asOf: string | null } | null> => {
      if (online) {
        const answer = await fetchLay(api, layId)
        if (answer.ok) {
          LAYS.keep(layId, answer.value)
          return { lay: answer.value, asOf: null }
        }
        ended(answer.problem)
      }
      const kept = LAYS.get(layId)
      return kept ? { lay: kept.value, asOf: kept.asOf } : null
    },
    [api, online, ended],
  )

  const openSpread = useCallback(
    async (card: TicketCard) => {
      const layId = card.lay?.id
      if (!layId) return
      const kept = LAYS.get(layId)
      setStep({ kind: 'spread', card, lay: kept?.value ?? null, asOf: online ? null : (kept?.asOf ?? null), draft: null, field: 'plies' })
      const found = await layOf(layId)
      setStep((now) => (now.kind === 'spread' && now.card.ticket.id === card.ticket.id ? { ...now, lay: found?.lay ?? now.lay, asOf: found?.asOf ?? now.asOf } : now))
      if (!found && !kept) setStep({ kind: 'problem', problem: { kind: online ? 'unavailable' : 'offline' }, code: card.ticket.number })
    },
    [layOf, online],
  )

  const openStickers = useCallback(
    async (card: TicketCard) => {
      const run = [...card.plyRuns].reverse().find((entry) => entry.status !== 'VOID') ?? null
      setStep({ kind: 'stickers', card, run, stickers: null, job: null, notPrinted: false })
      if (!run || !online) return
      const stickers = await fetchStickers(api, run.id, lang)
      if (stickers.ok) setStep((now) => (now.kind === 'stickers' && now.run?.id === run.id ? { ...now, stickers: stickers.value.slice(0, 4) } : now))
    },
    [api, lang, online],
  )

  const openFabric = useCallback(
    async (card: TicketCard) => {
      const layId = card.lay?.id
      if (!layId) return
      const kept = LAYS.get(layId)
      setStep({ kind: 'fabric', card, lay: kept?.value ?? null, value: kept?.value.fabricUsed ? fabricStart(kept.value.fabricUsed) : null })
      const found = await layOf(layId)
      if (found) setStep((now) => (now.kind === 'fabric' && now.card.ticket.id === card.ticket.id ? { ...now, lay: found.lay, value: now.value ?? (found.lay.fabricUsed ? fabricStart(found.lay.fabricUsed) : null) } : now))
    },
    [layOf],
  )

  /** The ticket's step, from where its lay stands. */
  const goToStep = useCallback(
    (card: TicketCard) => {
      setNotice(null)
      const at = stepOf(card.ticket.status, card.lay?.status ?? null)
      if (at === 'spread') return void openSpread(card)
      if (at === 'cut') return setStep({ kind: 'cut', card })
      if (at === 'stickers') return void openStickers(card)
      setStep({ kind: 'ticket', card, asOf: null })
    },
    [openSpread, openStickers],
  )

  const openTicket = useCallback(
    async (code: string) => {
      setNotice(null)
      const kept = CARDS.get(codeKey(code))
      if (!online) {
        if (kept) return setStep({ kind: 'ticket', card: kept.value, asOf: kept.asOf })
        feedback('warning')
        return setStep((now) => (now.kind === 'start' ? { ...now, wrong: { why: 'notOnTablet', code } } : now))
      }
      setStep({ kind: 'loading', code })
      const answer = await fetchTicket(api, code)
      if (answer.ok) {
        CARDS.keep(codeKey(answer.value.ticket.code), answer.value)
        feedback('success')
        return setStep({ kind: 'ticket', card: answer.value, asOf: null })
      }
      ended(answer.problem)
      if (answer.problem.kind === 'refused' && answer.problem.code === 'TICKET_IS_RECUT') return void openRecutRef.current(code)
      if (answer.problem.kind === 'offline' && kept) return setStep({ kind: 'ticket', card: kept.value, asOf: kept.asOf })
      feedback('error')
      const wrong: Wrong | null = answer.problem.kind === 'notFound' ? { why: 'notFound', code } : answer.problem.kind === 'invalid' ? { why: 'typo', code } : null
      if (wrong) {
        const back = WAITING.get('site')
        return setStep({ kind: 'start', tickets: back?.value ?? null, asOf: null, recuts: RECUTS.get('site')?.value.rows.length ?? null, wrong })
      }
      setStep({ kind: 'problem', problem: answer.problem, code })
    },
    [api, online, feedback, ended],
  )

  const openRecuts = useCallback(async () => {
    setNotice(null)
    const kept = RECUTS.get('site')
    setStep({ kind: 'recuts', list: kept?.value ?? null, asOf: online ? null : (kept?.asOf ?? null) })
    if (!online) return
    const answer = await fetchRecuts(api)
    if (answer.ok) {
      RECUTS.keep('site', answer.value)
      return setStep((now) => (now.kind === 'recuts' ? { ...now, list: answer.value, asOf: null } : now))
    }
    ended(answer.problem)
    if (!kept) setStep({ kind: 'problem', problem: answer.problem, code: null })
  }, [api, online, ended])

  const openRecut = useCallback(
    async (code: string) => {
      setNotice(null)
      if (!online) {
        feedback('warning')
        return setStep((now) => (now.kind === 'recuts' ? { ...now, wrong: { why: 'notOnTablet', code } } : now))
      }
      setStep({ kind: 'loading', code })
      const answer = await fetchRecut(api, code)
      if (answer.ok) {
        feedback('success')
        return setStep({ kind: 'recut', card: answer.value, printed: null })
      }
      ended(answer.problem)
      feedback('error')
      if (answer.problem.kind === 'refused' && answer.problem.code === 'TICKET_IS_CUT') return void openTicket(code)
      const kept = RECUTS.get('site')
      if (answer.problem.kind === 'notFound') return setStep({ kind: 'recuts', list: kept?.value ?? null, asOf: null, wrong: { why: 'notFound', code } })
      setStep({ kind: 'problem', problem: answer.problem, code })
    },
    [api, online, feedback, ended, openTicket],
  )
  const openRecutRef = useRef(openRecut)
  openRecutRef.current = openRecut

  const openTrolleys = useCallback(async () => {
    setNotice(null)
    if (!may.trolleys) return
    const kept = OPEN.get('site')
    setStep({ kind: 'trolleys', open: kept?.value ?? null, asOf: online ? null : (kept?.asOf ?? null) })
    if (!online) return
    const answer = await fetchOpenTrolleys(api)
    if (answer.ok) {
      OPEN.keep('site', answer.value)
      for (const row of answer.value.rows) TROLLEYS.keep(row.trolleyCode, row)
      return setStep((now) => (now.kind === 'trolleys' ? { ...now, open: answer.value, asOf: null } : now))
    }
    ended(answer.problem)
    if (!kept) setStep({ kind: 'problem', problem: answer.problem, code: null })
  }, [api, online, may.trolleys, ended])

  const openTrolley = useCallback(
    async (raw: string) => {
      setNotice(null)
      const code = trolleyCodeOf(raw)
      if (!isTrolleyCode(code)) {
        feedback('error')
        return setStep((now) => (now.kind === 'trolleys' || now.kind === 'trolley' ? { ...now, wrong: { why: 'notTrolley', code } } : now))
      }
      const kept = TROLLEYS.get(code)
      const fresh = { kept: [], picked: null, missing: [], process: null } as const
      if (!online) {
        // A label this tablet has not seen: a scan starts a load (B-W2b-117: one open trolley per label per site).
        const trolley = kept?.value ?? null
        feedback('success')
        return setStep({ kind: 'trolley', code, trolley, next: trolley ? (trolley.status === 'SENT' ? 'RECEIVE' : trolley.status === 'LOADING' ? 'LOAD' : 'NONE') : 'LOAD', asOf: kept?.asOf ?? null, ...fresh })
      }
      setStep({ kind: 'loading', code })
      const answer = await scanTrolley(api, code)
      if (answer.ok) {
        if (answer.value.trolley) TROLLEYS.keep(code, answer.value.trolley)
        feedback('success')
        return setStep({ kind: 'trolley', code, trolley: answer.value.trolley, next: answer.value.next, asOf: null, ...fresh })
      }
      ended(answer.problem)
      feedback('error')
      setStep({ kind: 'problem', problem: answer.problem, code })
    },
    [api, online, feedback, ended],
  )

  useEffect(() => {
    if (taken.current || !me || !mayCut) return
    taken.current = true
    const handed = store.takeScan()
    void loadStart()
    if (handed) void openTicket(handed)
  }, [me, mayCut, store, loadStart, openTicket])

  // Another tablet or the office moved what is on screen: read it again (a hint, never applied as it came).
  const refresh = useCallback(() => {
    const now = shown.current
    if (acting.current) return
    if (now.kind === 'start') void loadStart()
    if ((now.kind === 'spread' && !now.draft) || now.kind === 'count') {
      const layId = now.card.lay?.id
      if (layId)
        void layOf(layId).then((found) => {
          if (found) setStep((step) => ((step.kind === 'spread' || step.kind === 'count') && step.card.lay?.id === layId ? { ...step, lay: found.lay } : step))
        })
    }
    if (now.kind === 'recuts') void openRecuts()
    if (now.kind === 'trolleys') void openTrolleys()
    if (now.kind === 'trolley' && now.trolley && !now.busy)
      void scanTrolley(api, now.code).then((answer) => {
        if (answer.ok) setStep((step) => (step.kind === 'trolley' && step.code === now.code ? { ...step, trolley: answer.value.trolley, next: answer.value.next } : step))
      })
  }, [api, loadStart, layOf, openRecuts, openTrolleys])
  useLiveChanges({ onChange: (change) => void (LIVE.has(change.type) && refresh()), onReconnect: refresh }, mayCut && online)

  // ---- writes -----------------------------------------------------------------------------------------------------------------------

  const once = async (work: () => Promise<void>) => {
    if (acting.current) return
    acting.current = true
    try {
      await work()
    } finally {
      acting.current = false
    }
  }

  const refused = (problem: TaskProblem) => {
    ended(problem)
    feedback('error')
    setNotice(problem)
  }

  const startTicket = () =>
    once(async () => {
      const now = shown.current
      if (now.kind !== 'ticket' || !online) return
      setNotice(null)
      setStep({ ...now, busy: true })
      const answer = await scanTicketMove(api, 'start', now.card.ticket.code, newIdempotencyKey())
      if (!answer.ok) {
        refused(answer.problem)
        return setStep({ ...now, busy: false })
      }
      CARDS.keep(codeKey(answer.value.ticket.code), answer.value)
      feedback('success')
      setDone({ kind: 'started', code: answer.value.ticket.number, queued: null })
      await openSpread(answer.value)
    })

  const addRoll = () =>
    once(async () => {
      const now = shown.current
      if (now.kind !== 'spread' || !now.lay || !now.draft) return
      const { lay, draft } = now
      if (rollHeld(draft, lay.spread.needed)) return void feedback('warning')
      setNotice(null)
      setStep({ ...now, busy: true })
      const sent = await addRollOrKeep(api, queue, online, deviceId, lay.lay.id, rollBody(draft))
      if (sent.answer) {
        if (!sent.answer.ok) {
          refused(sent.answer.problem)
          return setStep({ ...now, busy: false })
        }
        const value = sent.answer.value
        LAYS.keep(lay.lay.id, value)
        feedback(value.warnings && value.warnings.length > 0 ? 'warning' : 'success')
        setDone({ kind: 'roll', code: draft.code, count: value.rolls.find((row) => row.code === draft.code)?.plies ?? 0, queued: null })
        return setStep({ ...now, lay: value, asOf: null, draft: null, field: 'plies', busy: false, warnings: (value.warnings ?? []).map((warning) => warning.code), wrong: null })
      }
      const kept = applyKeptRoll(lay, draft)
      LAYS.keep(lay.lay.id, kept)
      feedback('success')
      setDone({ kind: 'roll', code: draft.code, count: kept.rolls.find((row) => row.code === draft.code)?.plies ?? 0, queued: sent.kept.clientEventId })
      setStep({ ...now, lay: kept, draft: null, field: 'plies', busy: false, warnings: [], wrong: null })
    })

  const undoRoll = () =>
    once(async () => {
      const now = shown.current
      if (now.kind !== 'spread' || !now.lay || now.lay.rolls.length === 0) return
      const { lay } = now
      const last = lay.rolls[lay.rolls.length - 1]!
      setNotice(null)
      setStep({ ...now, busy: true })
      const sent = await undoRollOrKeep(api, queue, online, deviceId, lay.lay.id)
      if (sent.answer) {
        if (!sent.answer.ok) {
          refused(sent.answer.problem)
          return setStep({ ...now, busy: false })
        }
        LAYS.keep(lay.lay.id, sent.answer.value)
        feedback('warning')
        setDone({ kind: 'undo', code: last.code, queued: null })
        return setStep({ ...now, lay: sent.answer.value, busy: false, warnings: [] })
      }
      const kept = applyKeptUndo(lay)
      LAYS.keep(lay.lay.id, kept)
      feedback('warning')
      setDone({ kind: 'undo', code: last.code, queued: sent.kept.clientEventId })
      setStep({ ...now, lay: kept, busy: false, warnings: [] })
    })

  const countSave = () =>
    once(async () => {
      const now = shown.current
      if (now.kind !== 'count') return
      const problem = countProblem({ left: now.left, right: now.right }, now.lay.spread.plies)
      if (problem === 'differ') {
        feedback('error')
        return setStep({ ...now, differ: { left: now.left!, right: now.right! } })
      }
      if (problem) return void feedback('warning')
      const count = { left: now.left!, right: now.right! }
      setNotice(null)
      setStep({ ...now, busy: true })
      const sent = await countOrKeep(api, queue, online, deviceId, now.lay.lay.id, count)
      if (sent.answer) {
        if (!sent.answer.ok) {
          if (sent.answer.problem.kind === 'refused' && sent.answer.problem.code === 'PLIES_DIFFER') {
            feedback('error')
            return setStep({ ...now, busy: false, differ: count })
          }
          refused(sent.answer.problem)
          return setStep({ ...now, busy: false })
        }
        LAYS.keep(now.lay.lay.id, sent.answer.value)
        feedback('success')
        setDone({ kind: 'count', code: now.card.ticket.number, count: count.left, queued: null })
        return setStep({ kind: 'cut', card: cardWith(now.card, sent.answer.value) })
      }
      const kept = applyKeptCount(now.lay, count, new Date().toISOString())
      LAYS.keep(now.lay.lay.id, kept)
      feedback('success')
      setDone({ kind: 'count', code: now.card.ticket.number, count: count.left, queued: sent.kept.clientEventId })
      setStep({ kind: 'cut', card: cardWith(now.card, kept) })
    })

  const finish = () =>
    once(async () => {
      const now = shown.current
      if (now.kind !== 'cut' || !online) return
      setNotice(null)
      setStep({ ...now, busy: true })
      const answer = await scanTicketMove(api, 'finish', now.card.ticket.code, newIdempotencyKey())
      if (!answer.ok) {
        refused(answer.problem)
        return setStep({ ...now, busy: false })
      }
      CARDS.keep(codeKey(answer.value.ticket.code), answer.value)
      feedback('success')
      setDone({ kind: 'cut', code: answer.value.ticket.number, queued: null })
      await openStickers(answer.value)
    })

  const printRun = (again: boolean) =>
    once(async () => {
      const now = shown.current
      if (now.kind !== 'stickers' || !online || !now.card.lay) return
      setNotice(null)
      setStep({ ...now, busy: true })
      const answer = again && now.run ? await reprintRun(api, now.run.id, lang, newIdempotencyKey()) : await makeRun(api, now.card.lay.id, lang, newIdempotencyKey())
      if (!answer.ok) {
        refused(answer.problem)
        return setStep({ ...now, busy: false })
      }
      const { run, job, preview } = answer.value
      feedback(job ? 'success' : 'warning')
      setStep({ ...now, run, job, notPrinted: job === null, stickers: preview && preview.length > 0 ? preview.slice(0, 4) : now.stickers, busy: false })
      if (!preview || preview.length === 0) {
        const stickers = await fetchStickers(api, run.id, lang)
        if (stickers.ok) setStep((step) => (step.kind === 'stickers' && step.run?.id === run.id ? { ...step, stickers: stickers.value.slice(0, 4) } : step))
      }
    })

  const fabricSave = () =>
    once(async () => {
      const now = shown.current
      if (now.kind !== 'fabric' || !online || !now.lay?.fabricUsed || now.value === null) return
      const body = fabricBody(now.value, now.lay.fabricUsed)
      if (!body) return void feedback('warning')
      setNotice(null)
      setStep({ ...now, busy: true })
      const answer = await confirmFabric(api, now.lay.lay.id, body, newIdempotencyKey())
      if (!answer.ok) {
        refused(answer.problem)
        return setStep({ ...now, busy: false })
      }
      LAYS.keep(now.lay.lay.id, answer.value)
      feedback('success')
      setDone({ kind: 'fabric', code: now.card.ticket.number, queued: null })
      setStep({ ...now, lay: answer.value, busy: false, saved: true })
    })

  const recutMove = () =>
    once(async () => {
      const now = shown.current
      if (now.kind !== 'recut' || !online || now.card.next.next === 'NONE') return
      const move = now.card.next.next === 'START' ? 'start' : 'finish'
      setNotice(null)
      setStep({ ...now, busy: true })
      const answer = await moveRecut(api, move, now.card.ticket.code, newIdempotencyKey())
      if (!answer.ok) {
        refused(answer.problem)
        return setStep({ ...now, busy: false })
      }
      feedback('success')
      setDone({ kind: move === 'start' ? 'recutStarted' : 'recutDone', code: answer.value.ticket.number, count: answer.value.ticket.quantity, line: answer.value.ticket.bundle?.code ?? '', queued: null })
      if (move === 'finish') return void openRecuts()
      setStep({ ...now, card: answer.value, busy: false })
    })

  const recutPrint = () =>
    once(async () => {
      const now = shown.current
      if (now.kind !== 'recut' || !online) return
      setNotice(null)
      setStep({ ...now, busy: true })
      const answer = await printRecut(api, now.card.ticket.id, lang, newIdempotencyKey())
      if (!answer.ok) {
        refused(answer.problem)
        return setStep({ ...now, busy: false })
      }
      feedback(answer.value.job ? 'success' : 'warning')
      setStep({ ...now, card: { ...now.card, ticket: answer.value.ticket }, printed: answer.value, busy: false })
    })

  /** A trolley step, online first; the office's answer replaces the trolley on screen, a kept one says so. */
  const trolleyStep = (move: TrolleyMove, after: (trolley: Trolley | null, kept: string | null, warnings: readonly string[]) => void) =>
    once(async () => {
      const now = shown.current
      if (now.kind !== 'trolley') return
      setNotice(null)
      setStep({ ...now, busy: true })
      const sent = await trolleyOrKeep(api, queue, online, deviceId, move)
      if (sent.answer) {
        if (!sent.answer.ok) {
          refused(sent.answer.problem)
          setStep({ ...now, busy: false })
          const problem = sent.answer.problem
          if (move.kind === 'production.trolley.load' && problem.kind === 'refused' && problem.code === 'PROCESS_PENDING') {
            const processes = await fetchProcesses(api, move.body.bundle)
            if (processes.ok) {
              // The process's own panel says why and offers its tap: the refusal's line would say it twice.
              setNotice(null)
              setStep((step) => (step.kind === 'trolley' ? { ...step, process: processes.value } : step))
            }
          }
          return
        }
        TROLLEYS.keep(now.code, sent.answer.value.trolley)
        return after(sent.answer.value.trolley, null, (sent.answer.value.warnings ?? []).map((warning) => warning.code))
      }
      after(null, sent.kept.clientEventId, [])
    })

  const load = (bundle: string) => {
    const now = shown.current
    if (now.kind !== 'trolley' || now.next !== 'LOAD') return
    void trolleyStep({ kind: 'production.trolley.load', body: { trolley: now.code, bundle } }, (trolley, kept, warnings) => {
      feedback(warnings.length > 0 ? 'warning' : 'success')
      setDone({ kind: 'load', code: bundle, line: now.code, queued: kept })
      setStep((step) => (step.kind === 'trolley' ? { ...step, trolley: trolley ?? step.trolley, kept: kept ? [...step.kept, bundle] : step.kept, busy: false, warnings, process: null, wrong: null } : step))
    })
  }

  const unload = () => {
    const now = shown.current
    if (now.kind !== 'trolley' || !now.picked) return
    const bundle = now.picked
    void trolleyStep({ kind: 'production.trolley.unload', body: { trolley: now.code, bundle } }, (trolley, kept) => {
      feedback('warning')
      setDone({ kind: 'unload', code: bundle, line: now.code, queued: kept })
      setStep((step) => (step.kind === 'trolley' ? { ...step, trolley: trolley ?? (step.trolley ? { ...step.trolley, bundles: step.trolley.bundles.filter((entry) => entry.bundle.code !== bundle), counts: { ...step.trolley.counts, bundles: Math.max(0, step.trolley.counts.bundles - 1) } } : null), kept: step.kept.filter((code) => code !== bundle), picked: null, busy: false } : step))
    })
  }

  const sendTrolley = () => {
    const now = shown.current
    if (now.kind !== 'trolley' || now.next !== 'LOAD' || sendHeld(now.trolley, now.kept.length)) return
    const count = (now.trolley?.counts.bundles ?? 0) + now.kept.length
    void trolleyStep({ kind: 'production.trolley.send', body: { trolley: now.code } }, (trolley, kept) => {
      feedback('success')
      setDone({ kind: 'send', code: now.code, count, line: trolley?.line.code ?? now.trolley?.line.code ?? '', queued: kept })
      void openTrolleys()
    })
  }

  const receive = () => {
    const now = shown.current
    if (now.kind !== 'trolley' || now.next !== 'RECEIVE') return
    const missing = now.missing
    void trolleyStep({ kind: 'production.trolley.receive', body: { trolley: now.code, ...(missing.length > 0 ? { missing } : {}) } }, (trolley, kept) => {
      feedback(missing.length > 0 ? 'warning' : 'success')
      setDone({ kind: 'receive', code: now.code, count: (trolley ?? now.trolley)?.counts.bundles ?? 0, line: (trolley ?? now.trolley)?.line.code ?? '', queued: kept })
      void openTrolleys()
    })
  }

  const processMove = () =>
    once(async () => {
      const now = shown.current
      if (now.kind !== 'trolley' || !now.process?.next || !online || !may.secondary) return
      const { processId, move } = now.process.next
      setNotice(null)
      setStep({ ...now, busy: true })
      const answer = await moveProcess(api, processId, move, newIdempotencyKey())
      if (!answer.ok) {
        refused(answer.problem)
        return setStep({ ...now, busy: false })
      }
      feedback('success')
      setDone({ kind: 'process', code: now.process.bundle.code, queued: null })
      const again = await fetchProcesses(api, now.process.bundle.code)
      setStep((step) => (step.kind === 'trolley' ? { ...step, busy: false, process: again.ok && (again.value.next || again.value.toSewing) ? again.value : null } : step))
    })

  // ---- scans ------------------------------------------------------------------------------------------------------------------------

  const onScan = async (raw: string) => {
    const now = shown.current
    if (!me) return
    const read = readScan(raw, me.scanTag)
    if (read.kind === 'badge') {
      if (await store.switchTo(read.code)) feedback('error')
      return
    }
    const wrong = (why: Wrong['why'], code: string) => {
      feedback('error')
      setStep((step) => withWrong(step, { why, code }))
    }
    const { code, label, misread, ticketLike } = fabricScan(read, raw)
    const misreadLabel = () => wrong(read.kind === 'otherFactory' ? 'otherFactory' : 'typo', read.code)
    switch (now.kind) {
      case 'start':
      case 'ticket':
      case 'stickers':
      case 'fabric':
      case 'problem':
        if (label) return wrong('notTicket', code)
        if ((now.kind === 'ticket' || now.kind === 'stickers' || now.kind === 'fabric') && sameCode(code, now.card.ticket.code)) return
        return void openTicket(code)
      case 'spread': {
        if (!now.lay) return
        if (sameCode(code, now.card.ticket.code)) return wrong('notRoll', code)
        if (ticketLike) return misread ? misreadLabel() : wrong('notRoll', code)
        if (label && label !== 'roll') return wrong('notRoll', code)
        // The same roll scanned again adds it (scan → Add: one tap or a second scan).
        if (now.draft && sameCode(code, now.draft.code)) return void addRoll()
        setNotice(null)
        feedback('success')
        return setStep({ ...now, draft: rollDraftOf(code, now.lay.spread.needed, now.lay.rolls.find((row) => sameCode(row.code, code)) ?? null), field: 'plies', wrong: null, warnings: [] })
      }
      case 'cut':
        if (sameCode(code, now.card.ticket.code)) return void finish()
        return wrong('otherTicket', code)
      case 'recuts':
      case 'recut':
        if (label) return wrong('notTicket', code)
        return void openRecut(code)
      case 'trolleys':
        if (label) return wrong('notTrolley', code)
        return void openTrolley(code)
      case 'trolley': {
        if (label === 'bundle') {
          if (now.next === 'LOAD') return load(code)
          if (now.next === 'RECEIVE') return setStep({ ...now, missing: now.missing.filter((entry) => !sameCode(entry, code)) })
          return wrong('notTrolley', code)
        }
        if (label) return wrong('notBundle', code)
        // The trolley's own label again at the line confirms the receipt (design "scanning the trolley label confirms receipt").
        if (sameCode(code, now.code)) return now.next === 'RECEIVE' ? receive() : undefined
        if (ticketLike) return misreadLabel()
        return void openTrolley(code)
      }
      default:
        return
    }
  }

  // ---- the actions ------------------------------------------------------------------------------------------------------------------

  const back = () => {
    setNotice(null)
    const now = shown.current
    switch (now.kind) {
      case 'start':
      case 'noPermission':
        return router.push('/floor')
      case 'spread':
        if (now.draft) return setStep({ ...now, draft: null, field: 'plies' })
        return setStep({ kind: 'ticket', card: now.card, asOf: null })
      case 'count':
        if (now.differ) return setStep({ ...now, differ: null })
        return void openSpread(now.card)
      case 'cut':
        return void openSpread(now.card)
      case 'fabric':
        if (now.saved) {
          setStep({ kind: 'start', tickets: WAITING.get('site')?.value ?? null, asOf: null, recuts: RECUTS.get('site')?.value.rows.length ?? null })
          return void loadStart()
        }
        return void openStickers(now.card)
      case 'recut':
        return void openRecuts()
      case 'trolley':
        return void openTrolleys()
      default:
        setStep({ kind: 'start', tickets: WAITING.get('site')?.value ?? null, asOf: null, recuts: RECUTS.get('site')?.value.rows.length ?? null })
        return void loadStart()
    }
  }

  const onAction = (action: FabricAction) => {
    const now = shown.current
    switch (action.type) {
      case 'scan':
        return void onScan(action.code)
      case 'back':
        return back()
      case 'home':
        return router.push('/floor')
      case 'retry':
        setStep({ kind: 'start', tickets: WAITING.get('site')?.value ?? null, asOf: null, recuts: null })
        return void loadStart()
      case 'openTicket':
        return void openTicket(action.code)
      case 'openRecuts':
        setDone(null)
        return void openRecuts()
      case 'openTrolleys':
        setDone(null)
        return void openTrolleys()
      case 'startTicket':
        return void startTicket()
      case 'toStep':
        return now.kind === 'ticket' ? goToStep(now.card) : undefined
      case 'rollField':
        return now.kind === 'spread' ? setStep({ ...now, field: action.field }) : undefined
      case 'rollValue': {
        if (now.kind !== 'spread' || !now.draft) return
        const value = action.value
        const draft = now.draft
        if (now.field === 'plies') return setStep({ ...now, draft: { ...draft, plies: value, pliesTouched: true } })
        if (now.field === 'splices') return setStep({ ...now, draft: { ...draft, splices: Math.max(0, Math.round(value ?? 0)) } })
        if (now.field === 'endLoss') return setStep({ ...now, draft: { ...draft, endLoss: value } })
        return setStep({ ...now, draft: { ...draft, endReturned: value } })
      }
      case 'addRoll':
        return void addRoll()
      case 'undoRoll':
        return void undoRoll()
      case 'toCount':
        if (now.kind !== 'spread' || !now.lay) return
        setNotice(null)
        return setStep({ kind: 'count', card: now.card, lay: now.lay, left: now.lay.spread.plies || null, right: now.lay.spread.plies || null, differ: null })
      case 'countLeft':
        return now.kind === 'count' ? setStep({ ...now, left: action.value }) : undefined
      case 'countRight':
        return now.kind === 'count' ? setStep({ ...now, right: action.value }) : undefined
      case 'countSave':
        return void countSave()
      case 'recount':
        return now.kind === 'count' ? setStep({ ...now, differ: null }) : undefined
      case 'finish':
        return void finish()
      case 'makeRun':
        return void printRun(false)
      case 'reprintRun':
        return void printRun(true)
      case 'toFabric':
        return now.kind === 'stickers' ? void openFabric(now.card) : undefined
      case 'fabricValue':
        return now.kind === 'fabric' ? setStep({ ...now, value: action.value }) : undefined
      case 'fabricSave':
        return void fabricSave()
      case 'openRecut':
        return void openRecut(action.code)
      case 'recutMove':
        return void recutMove()
      case 'recutPrint':
        return void recutPrint()
      case 'openTrolley':
        return void openTrolley(action.code)
      case 'pickBundle':
        if (now.kind !== 'trolley') return
        if (now.next === 'RECEIVE') return setStep({ ...now, missing: toggleMissing(now.missing, action.code) })
        return setStep({ ...now, picked: now.picked === action.code ? null : action.code })
      case 'unload':
        return unload()
      case 'send':
        return sendTrolley()
      case 'receive':
        return receive()
      case 'processMove':
        return void processMove()
    }
  }

  // Enter = the step's main action (design floor.fabriccut keys), Esc = back.
  const enter = (): FabricAction | null => {
    switch (step.kind) {
      case 'ticket':
        return stepOf(step.card.ticket.status, step.card.lay?.status ?? null) === 'start' ? { type: 'startTicket' } : { type: 'toStep' }
      case 'spread':
        return step.draft ? { type: 'addRoll' } : null
      case 'count':
        return step.differ ? { type: 'recount' } : { type: 'countSave' }
      case 'cut':
        return { type: 'finish' }
      case 'stickers':
        return step.run ? { type: 'toFabric' } : { type: 'makeRun' }
      case 'recut':
        return { type: 'recutMove' }
      case 'fabric':
        return step.saved ? null : { type: 'fabricSave' }
      case 'trolley':
        return step.next === 'RECEIVE' ? { type: 'receive' } : step.next === 'LOAD' ? { type: 'send' } : null
      default:
        return null
    }
  }
  useFloorKeys({ enter: () => void ((action) => action && onAction(action))(enter()), escape: () => back() })

  if (!me) return null

  const doneLine: DoneLine | null = done ? { ...done, ticks: done.queued ? (queuedView(queueSnapshot, done.queued)?.ticks ?? 'saved') : 'recorded' } : null

  return <FabricCutView model={{ frame, online, step, done: doneLine, notice, may }} onFrame={onFrame} onAction={onAction} camera={zxingCamera} />
}

/** The card with its lay as the table left it (status and count), so the next step opens without a read. */
function cardWith(card: TicketCard, lay: LayView): TicketCard {
  return card.lay ? { ...card, lay: { ...card.lay, status: lay.lay.status, counted: lay.lay.counted?.left ?? null, version: lay.lay.version } } : card
}

/** The step with what was scanned wrong said under its scan field (the steps that have one). */
function withWrong(step: FabricStep, wrong: Wrong): FabricStep {
  switch (step.kind) {
    case 'start':
    case 'spread':
    case 'cut':
    case 'recuts':
    case 'trolleys':
    case 'trolley':
      return { ...step, wrong }
    default:
      return step
  }
}
