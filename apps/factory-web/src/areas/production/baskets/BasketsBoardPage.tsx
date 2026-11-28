'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import * as PrintAgainSlot from '../../sales/orders/record/print/PrintAgainWindow'
import { useCoalesced, useLive } from '../_shared/hooks'
import { giveBasket, moveBasket, readBasket, readBoard, solveCall, type BasketRead, type Board, type BoardCard, type BoardFilters, type MoveReason } from './api'
import { BASKETS_NAMESPACE, BASKETS_NAMESPACES, columnsOf, filterOptions, printAgainReady, type MoveTarget } from './model'
import { BasketWindow } from './view/BasketWindow'
import { BoardView, type FilterKey } from './view/BoardView'

/**
 * owb-fl9 step 1 — `/w/<company>/production/baskets`: reads the Baskets board (filters team · department · order), reads it again when
 * the floor moves a basket (a burst of changes is one read), and opens a basket's window: its route read on opening (fl1), Move it to
 * (fl2), Problem solved (today's call answer), Give it to (fl4's seam), Print its card and pages again… (S3's window by the base's
 * slot, shown only once that slot is built).
 */

const { PrintAgainWindow } = PrintAgainSlot
const PRINT_AGAIN_READY = printAgainReady(PrintAgainSlot as unknown as Readonly<Record<string, unknown>>)

export function BasketsBoardPage() {
  return (
    <WithMessages namespaces={BASKETS_NAMESPACES}>
      <Container />
    </WithMessages>
  )
}

/** A move that moved nothing: the server's words for why the basket stays. */
class StayedError extends Error {}

/** A refusal in the API's words (it names what to do), else the page's own. */
function refusalWords(error: unknown, fallback: string): string {
  if (error instanceof StayedError) return error.message || fallback
  if (!isApiError(error)) return fallback
  const refusal = error.issues.find((issue) => issuePath(issue).startsWith('refusal/'))
  return refusal?.message || error.issues[0]?.message || fallback
}

function Container() {
  const t = useT(BASKETS_NAMESPACE)
  const api = useOfficeApi()
  const session = useOfficeSession()
  const locale = useLocale()
  const prefix = usePathname().replace(/\/production\/baskets\/?$/, '')
  const [filters, setFilters] = useState<BoardFilters>({})
  const [board, setBoard] = useState<Board | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [problem, setProblem] = useState<string | null>(null)
  const [open, setOpen] = useState<BoardCard | null>(null)
  const [read, setRead] = useState<{ value: BasketRead | null; state: 'loading' | 'ready' | 'failed' }>({ value: null, state: 'loading' })
  const [backTo, setBackTo] = useState<MoveTarget | null>(null)
  const [busy, setBusy] = useState(false)
  const [windowProblem, setWindowProblem] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [printAgain, setPrintAgain] = useState<string | null>(null)
  const reading = useRef<AbortController | null>(null)

  const load = useCallback(() => {
    reading.current?.abort()
    const controller = new AbortController()
    reading.current = controller
    readBoard(api, filters, controller.signal)
      .then((value) => {
        setBoard(value)
        setState('ready')
        setProblem(null)
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setState('failed')
        setProblem(isApiError(error) && error.kind === 'forbidden' ? 'error.forbidden' : 'error.read')
      })
  }, [api, filters])

  useEffect(() => {
    load()
    return () => reading.current?.abort()
  }, [load])

  const reread = useCoalesced(load, 1500)
  useLive(
    (change) => {
      if (change.type.startsWith('production.') || change.type.startsWith('help_call.') || change.type.startsWith('workorder.')) reread()
    },
    load,
  )

  const loadBasket = useCallback(
    (card: BoardCard) => {
      setRead({ value: null, state: 'loading' })
      readBasket(api, card.code)
        .then((value) => setRead({ value, state: 'ready' }))
        .catch(() => setRead({ value: null, state: 'failed' }))
    },
    [api],
  )

  const openCard = (card: BoardCard) => {
    setOpen(card)
    setBackTo(null)
    setWindowProblem(null)
    setDone(null)
    loadBasket(card)
  }

  const run = async (work: () => Promise<unknown>, doneWords: string) => {
    if (busy) return
    setBusy(true)
    setWindowProblem(null)
    setDone(null)
    try {
      await work()
      setDone(doneWords)
      setBackTo(null)
      load()
      if (open) loadBasket(open)
    } catch (error) {
      setWindowProblem(refusalWords(error, t('window.failed')))
    } finally {
      setBusy(false)
    }
  }

  const move = (target: MoveTarget, reason?: MoveReason) => {
    if (!open) return
    if (target.kind === 'BACK' && !reason) return setBackTo(target)
    void run(
      () => moveBasket(api, { bundleIds: [open.bundleId], toOperationId: target.operationId, kind: target.kind, ...(reason ? { reason } : {}) }).then((answer) => {
        if (answer.moved === 0) throw new StayedError(answer.stayWords?.[0] ?? t('window.stayed'))
      }),
      t('window.moved'),
    )
  }

  const perms = session.permissions
  const can = useMemo(
    () => ({
      move: perms.includes('production.baskets.move') || perms.includes('production.baskets.route'),
      back: perms.includes('production.baskets.route'),
      solve: perms.includes('production.calls.answer'),
      give: perms.includes('production.dispatch.manage'),
      printAgain: PRINT_AGAIN_READY && perms.includes('production.print.start'),
    }),
    [perms],
  )
  const options = useMemo(() => (board ? filterOptions(board, locale) : { teams: [], departments: [], orders: [] }), [board, locale])
  const problemCall = read.value?.flags?.problem?.callId ?? open?.flags?.problem?.callId ?? null
  const orderId = open?.salesOrderId ?? read.value?.basket.salesOrderId ?? null

  return (
    <>
      <BoardView
        model={{ state, columns: board ? columnsOf(board, locale) : [], filters, options, problem }}
        actions={{
          onFilter: (key: FilterKey, value) => setFilters((now) => ({ ...now, [key]: value })),
          onOpen: openCard,
          onRetry: load,
        }}
      />
      {open ? (
        <BasketWindow
          model={{ card: open, read: read.value, state: read.state, prefix, can, people: board?.people ?? [], backTo, busy, problem: windowProblem, done }}
          actions={{
            onClose: () => (busy ? undefined : setOpen(null)),
            onMove: (target) => move(target),
            onReason: (reason) => (backTo ? move(backTo, reason) : undefined),
            onSolve: () => (problemCall ? void run(() => solveCall(api, problemCall), t('window.solvedDone')) : undefined),
            onGive: (workerId) => void run(() => giveBasket(api, workerId, open.bundleId), t('window.given')),
            onPrintAgain: () => (orderId ? setPrintAgain(orderId) : undefined),
          }}
        />
      ) : null}
      {printAgain && session.company ? <PrintAgainWindow open onClose={() => setPrintAgain(null)} companyId={session.company.id} orderId={printAgain} /> : null}
    </>
  )
}
