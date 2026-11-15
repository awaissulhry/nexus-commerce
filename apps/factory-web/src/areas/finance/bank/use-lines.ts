'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../lib/api/client'
import { findCustomers, openItems } from '../_shared/api'
import { allocationsOf } from '../_shared/model'
import { planOf } from '../_shared/placement'
import { acceptMany, acceptMatch, chooseMatch, getLine, getStatement, lineCounts, listLines, refreshSuggestions, reverseMatch, type BankLine, type BankStatement, type LineCounts } from './api'
import { bestOf, readProblem, softLocked, stepLine, sureOf, writeProblem, type BankAddress, type BankCan, type Phrase } from './model'
import type { ReviewModel } from './view/AcceptAllReview'
import type { ChooseModel } from './view/ChooseDialog'
import { MATCH_IDLE, type MatchState } from './view/MatchPanel'
import type { ReverseModel } from './view/ReverseDialog'
import type { Part } from './view/BankView'

const SLOW_MS = 1000

/**
 * The lines' part of Finance › Bank (B-W2b-406 on B-W2b-393's API): the tiles (`GET /payments/bank/lines/counts`), the lines
 * of the view (`GET /payments/bank/lines?view=`, 50 a page) or of one statement (`GET …/statements/:id`), the line open beside
 * them (from the rows, else `GET …/lines/:id`), and every write: accept (`POST …/matches/:id/accept`, a write-off and a
 * soft-locked month's reason when asked), choose / split (`POST …/lines/:id/match`), accept all sure (`POST …/matches/accept`,
 * all or none), take back (`POST …/matches/:id/reverse`), look again (`POST …/suggestions/refresh`). After an acceptance the
 * next line opens (J / K order).
 */
export function useLines(api: ApiClient, can: BankCan, companyId: string | null, address: BankAddress, go: (next: Partial<BankAddress>) => void) {
  const [counts, setCounts] = useState<Part<LineCounts>>({ value: null, problem: null })
  const [rows, setRows] = useState<BankLine[] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [list, setList] = useState<{ problem: string | null; slow: boolean }>({ problem: null, slow: false })
  const [statement, setStatement] = useState<BankStatement['statement'] | null>(null)
  const [alone, setAlone] = useState<Part<BankLine>>({ value: null, problem: null })
  const [readAt, setReadAt] = useState<number | null>(null)
  const [updates, setUpdates] = useState(0)
  const [match, setMatch] = useState<MatchState>(MATCH_IDLE)
  const [review, setReview] = useState<ReviewModel | null>(null)
  const [choose, setChoose] = useState<ChooseModel | null>(null)
  const [reverse, setReverse] = useState<ReverseModel | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger' | 'info' | 'warning'; phrases: Phrase[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const asked = useRef(address)
  asked.current = address

  const loadCounts = useCallback(async () => {
    if (!can.view || !companyId) return
    try {
      setCounts({ value: await lineCounts(api, companyId), problem: null })
    } catch (error) {
      setCounts((current) => ({ value: current.value, problem: readProblem(error) }))
    }
  }, [api, can.view, companyId])

  const loadLines = useCallback(async () => {
    if (!can.view || !companyId) return
    const target = asked.current
    const slow = setTimeout(() => setList((current) => ({ ...current, slow: true })), SLOW_MS)
    try {
      if (target.statement) {
        const answer = await getStatement(api, target.statement)
        if (asked.current.statement !== target.statement) return
        setStatement(answer.statement)
        setRows(answer.lines)
        setCursor(null)
      } else {
        const page = await listLines(api, { companyId, view: target.view })
        if (asked.current.view !== target.view || asked.current.statement) return
        setStatement(null)
        setRows(page.lines)
        setCursor(page.nextCursor)
      }
      setList({ problem: null, slow: false })
      setReadAt(Date.now())
      setUpdates(0)
    } catch (error) {
      setRows(null)
      setList({ problem: readProblem(error), slow: false })
    } finally {
      clearTimeout(slow)
    }
  }, [api, can.view, companyId])

  const listKey = `${address.view}|${address.statement ?? ''}`
  useEffect(() => {
    setRows(null)
    setList({ problem: null, slow: false })
    void loadLines()
  }, [loadLines, listKey])
  useEffect(() => {
    void loadCounts()
  }, [loadCounts])

  // The line open beside the list: from the rows, else read alone (an address from a payment's Bank line card).
  const fromRows = address.line ? (rows?.find((row) => row.id === address.line) ?? null) : null
  const loadAlone = useCallback(async () => {
    const lineId = asked.current.line
    if (!lineId || !can.view) return
    try {
      const line = await getLine(api, lineId)
      if (asked.current.line === lineId) setAlone({ value: line, problem: null })
    } catch (error) {
      if (asked.current.line === lineId) setAlone({ value: null, problem: readProblem(error) })
    }
  }, [api, can.view])
  useEffect(() => {
    if (!address.line || fromRows || rows === null) return
    if (alone.value?.id === address.line) return
    setAlone({ value: null, problem: null })
    void loadAlone()
  }, [address.line, fromRows, rows, alone.value?.id, loadAlone])
  const current: Part<BankLine> = address.line ? (fromRows ? { value: fromRows, problem: null } : alone.value?.id === address.line ? alone : { value: null, problem: alone.problem }) : { value: null, problem: null }

  // A new line open: its own panel state (the surest suggestion chosen, no write-off ticked).
  const currentId = current.value?.id ?? null
  useEffect(() => {
    setMatch((state) => ({ ...MATCH_IDLE, accepted: state.accepted }))
  }, [currentId])

  const more = async () => {
    if (!cursor || !companyId || address.statement) return
    try {
      const page = await listLines(api, { companyId, view: address.view, cursor })
      setRows((known) => [...(known ?? []), ...page.lines.filter((line) => !known?.some((seen) => seen.id === line.id))])
      setCursor(page.nextCursor)
    } catch (error) {
      setNotice({ tone: 'danger', phrases: writeProblem(error) })
    }
  }

  const reload = useCallback(async () => {
    await Promise.all([loadLines(), loadCounts()])
    if (asked.current.line) await loadAlone()
  }, [loadLines, loadCounts, loadAlone])

  const step = (by: 1 | -1) => {
    const next = stepLine(rows ?? [], current.value?.id ?? address.line, by)
    if (next) go({ line: next })
  }

  /** After a write on the open line: the next line of the list opens (or stays when there is none), all read again. */
  const afterWrite = async (lineId: string) => {
    const next = stepLine((rows ?? []).filter((row) => row.state === 'TO_MATCH' || row.id === lineId), lineId, 1)
    await reload()
    if (asked.current.view !== 'MATCHED' && asked.current.view !== 'ALL' && !asked.current.statement && next && next !== lineId) go({ line: next })
  }

  const accept = async () => {
    const line = current.value
    if (!line || busy) return
    const picked = line.suggestions.find((entry) => entry.id === match.picked) ?? bestOf(line)
    if (!picked) return
    setBusy(true)
    setMatch((state) => ({ ...state, busy: true, problems: null }))
    try {
      const answer = await acceptMatch(api, picked, {
        ...(match.writeOff.on && picked.difference?.writable ? { writeOff: { reason: match.writeOff.reason, ...(match.writeOff.note.trim() ? { note: match.writeOff.note.trim() } : {}) } } : {}),
        ...(match.lockAsked && match.lockReason.trim() ? { periodLockOverride: { reason: match.lockReason.trim() } } : {}),
      })
      setMatch({ ...MATCH_IDLE, accepted: { lineId: line.id, paymentId: answer.paymentId, recorded: answer.recorded } })
      await afterWrite(line.id)
    } catch (error) {
      setMatch((state) => ({ ...state, busy: false, problems: writeProblem(error), lockAsked: state.lockAsked || softLocked(error) }))
    } finally {
      setBusy(false)
    }
  }

  // ---- Choose another / Split -------------------------------------------------------------------------------------------
  const searchCustomers = useCallback(
    async (q: string) => {
      try {
        const found = await findCustomers(api, q, companyId)
        setChoose((state) => (state ? { ...state, q, customers: found, customersProblem: null } : state))
      } catch (error) {
        setChoose((state) => (state ? { ...state, q, customers: [], customersProblem: readProblem(error) } : state))
      }
    },
    [api, companyId],
  )
  const loadItems = useCallback(
    async (partyId: string) => {
      if (!companyId) return
      try {
        const items = await openItems(api, companyId, partyId)
        setChoose((state) => (state && state.customer?.id === partyId ? { ...state, items, itemsProblem: null } : state))
      } catch (error) {
        setChoose((state) => (state && state.customer?.id === partyId ? { ...state, items: [], itemsProblem: readProblem(error) } : state))
      }
    },
    [api, companyId],
  )
  const openChoose = () => {
    const line = current.value
    if (!line) return
    const best = bestOf(line)
    const customer = best ? { id: best.partyId, name: best.party.legalName } : null
    setChoose({ line, customer, q: line.counterpartyName ?? '', customers: null, customersProblem: null, items: null, itemsProblem: null, typed: {}, writeOff: { on: false, reason: 'ROUNDING', note: '' }, busy: false, problems: null, lockAsked: false, lockReason: '' })
    if (customer) void loadItems(customer.id)
    else void searchCustomers(line.counterpartyName ?? '')
  }
  const submitChoose = async () => {
    if (!choose || !choose.customer || !choose.items || busy) return
    const allocations = allocationsOf(choose.items, planOf(choose.typed))
    if (allocations.length === 0) return
    setBusy(true)
    setChoose((state) => (state ? { ...state, busy: true, problems: null } : state))
    try {
      const answer = await chooseMatch(api, choose.line.id, {
        partyId: choose.customer.id,
        items: allocations.map((entry) => ({ ...(entry.invoiceId ? { invoiceId: entry.invoiceId } : { depositRequestId: entry.depositRequestId }), amount: entry.amount })),
        ...(choose.writeOff.on ? { writeOff: { reason: choose.writeOff.reason, ...(choose.writeOff.note.trim() ? { note: choose.writeOff.note.trim() } : {}) } } : {}),
        ...(choose.lockAsked && choose.lockReason.trim() ? { periodLockOverride: { reason: choose.lockReason.trim() } } : {}),
      })
      const lineId = choose.line.id
      setChoose(null)
      setMatch({ ...MATCH_IDLE, accepted: { lineId, paymentId: answer.paymentId, recorded: answer.recorded } })
      await afterWrite(lineId)
    } catch (error) {
      setChoose((state) => (state ? { ...state, busy: false, problems: writeProblem(error), lockAsked: state.lockAsked || softLocked(error) } : state))
    } finally {
      setBusy(false)
    }
  }

  // ---- Take back ---------------------------------------------------------------------------------------------------------
  const submitReverse = async () => {
    if (!reverse || !reverse.line.accepted || busy) return
    setBusy(true)
    setReverse((state) => (state ? { ...state, busy: true, problems: null } : state))
    try {
      await reverseMatch(api, reverse.line.accepted, reverse.reason.trim(), reverse.lockAsked && reverse.lockReason.trim() ? { reason: reverse.lockReason.trim() } : undefined)
      setReverse(null)
      setNotice({ tone: 'success', phrases: [{ key: 'reverse.done' }] })
      await reload()
    } catch (error) {
      setReverse((state) => (state ? { ...state, busy: false, problems: writeProblem(error), lockAsked: state.lockAsked || softLocked(error) } : state))
    } finally {
      setBusy(false)
    }
  }

  // ---- Accept all High ---------------------------------------------------------------------------------------------------
  const openReview = async (picked: readonly BankLine[] | null) => {
    if (!companyId) return
    if (picked) {
      const entries = sureOf(picked, can)
      setReview({ entries, more: false, phase: 'ready', problems: null })
      return
    }
    // Every sure match of the company (the SURE view), not only the lines on screen.
    try {
      const page = await listLines(api, { companyId, view: 'SURE' })
      const entries = sureOf(page.lines, can)
      setReview({ entries, more: page.nextCursor !== null || page.lines.length > entries.length, phase: 'ready', problems: null })
    } catch (error) {
      setNotice({ tone: 'danger', phrases: writeProblem(error) })
    }
  }
  const saveReview = async () => {
    if (!review || !companyId || review.phase !== 'ready' || review.entries.length === 0) return
    setReview({ ...review, phase: 'saving' })
    try {
      await acceptMany(api, companyId, review.entries.map((entry) => entry.match))
      setReview((state) => (state ? { ...state, phase: 'done', problems: null } : state))
    } catch (error) {
      setReview((state) => (state ? { ...state, phase: 'done', problems: writeProblem(error) } : state))
    }
    await reload()
  }

  const refresh = async () => {
    if (!companyId || busy) return
    setBusy(true)
    try {
      const changed = await refreshSuggestions(api, companyId)
      setNotice({ tone: 'info', phrases: [{ key: 'band.refreshed', params: { count: changed } }] })
      await reload()
    } catch (error) {
      setNotice({ tone: 'danger', phrases: writeProblem(error) })
    } finally {
      setBusy(false)
    }
  }

  return {
    model: useMemo(
      () => ({ counts, lines: { rows, problem: list.problem, slow: list.slow, more: cursor !== null && !address.statement }, statement, current, match, readAt, updates, busy, notice, review, choose, reverse }),
      [counts, rows, list, cursor, address.statement, statement, current, match, readAt, updates, busy, notice, review, choose, reverse],
    ),
    loadCounts,
    loadLines,
    loadAlone,
    reload,
    bump: () => setUpdates((count) => count + 1),
    more,
    step,
    accept,
    refresh,
    setNotice,
    setMatch,
    openChoose,
    setChoose,
    searchCustomers,
    loadItems,
    submitChoose,
    openReverse: () => current.value?.accepted && setReverse({ line: current.value, reason: '', busy: false, problems: null, lockAsked: false, lockReason: '' }),
    setReverse,
    submitReverse,
    openReview,
    closeReview: () => setReview(null),
    saveReview,
  }
}
