'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { companyPrefix } from '../../../lib/session/session'
import { useLiveBus } from '../../../shell/live/use-live'
import { createRound, decideRound, findStyles, listCustomers, listRounds, moveRound, readApproval, readStyle, type PartyOption, type RoundList, type RoundRow } from './api'
import {
  addressOf,
  approvalHeld,
  addressText,
  emptyNewDraft,
  fieldOfPath,
  HOME_ADDRESS,
  newBodyOf,
  readProblem,
  recordHref,
  samplesCan,
  todayOf,
  writeProblem,
  type ListAddress,
  type ManualStage,
  type Notice,
} from './model'
import { SamplesMessages } from './parts'
import type { DecideModel } from './view/DecideDialog'
import type { NewRoundModel } from './view/NewRoundDialog'
import { SamplesListView } from './view/SamplesListView'

/**
 * `/w/<company>/products/samples` (SCR-110): the rounds as a board by stage (the page as the design draws it), a list
 * (`?mode=table`) or a calendar by due day (`?mode=calendar`), with the same filters in the address — `?tile=` (the API's
 * saved filters), `?kind=`, `?party=` / `?internal=1`, `?style=&revision=` (the Style studio's link), `?q=`. New sample
 * request (`c`, `?new=1`, `&style=` from the studio) makes the round and opens it. A card moves by drag, `m` or its menu
 * to a manual stage (the round's version read); "Decide…" (`d`) reads the round's Approval first, then records the
 * decision. Live `sample_round.*` / `sample_shipment.*` / `sample_swatch.*` changes: the board and the tiles read again;
 * the list says "N updates · Show".
 */
export function SamplesPage() {
  return (
    <SamplesMessages>
      <Container />
    </SamplesMessages>
  )
}

const LIVE_TYPES = ['sample_round.', 'sample_shipment.', 'sample_swatch.'] as const

function Container() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = companyPrefix(session.company?.code ?? '')
  const companyId = session.company?.id ?? null
  const me = session.user.id
  const can = useMemo(() => samplesCan(session.permissions), [session.permissions])
  const address = useMemo(() => addressOf(params), [params])
  const go = useCallback((next: Partial<ListAddress>) => router.replace(`${pathname}${addressText({ ...address, ...next })}`, { scroll: false }), [router, pathname, address])
  const [opened] = useState(() => new Date().toISOString())
  const today = todayOf(opened)

  // ---- the rounds --------------------------------------------------------------------------------------------------------
  const [list, setList] = useState<RoundList | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [customers, setCustomers] = useState<PartyOption[] | null>(null)
  const readId = useRef(0)
  const query = useMemo(
    () => ({ tile: address.tile, kind: address.kind, partyId: address.internal ? null : address.party, internal: address.internal, styleId: address.style, revisionId: address.style ? address.revision : null, q: address.q }),
    [address.tile, address.kind, address.party, address.internal, address.style, address.revision, address.q],
  )

  const load = useCallback(async () => {
    if (!can.view) return
    const id = ++readId.current
    setProblem(null)
    try {
      const answer = await listRounds(api, query)
      if (id !== readId.current) return
      setList(answer)
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (id === readId.current) setProblem(readProblem(error))
    }
  }, [api, can.view, query])

  useEffect(() => {
    setList(null)
    void load()
  }, [load])

  useEffect(() => {
    if (!can.view || !can.parties) return
    const controller = new AbortController()
    listCustomers(api, companyId, controller.signal)
      .then(setCustomers)
      .catch(() => setCustomers(null))
    return () => controller.abort()
  }, [api, can.view, can.parties, companyId])

  const later = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (later.current && clearTimeout(later.current)), [])
  const live = useLiveBus(
    {
      onChange: (change) => {
        if (!LIVE_TYPES.some((type) => change.type.startsWith(type))) return
        if (address.mode === 'table') setUpdates((count) => count + 1)
        else {
          if (later.current) clearTimeout(later.current)
          later.current = setTimeout(() => void load(), 600)
        }
      },
      onReconnect: () => void load(),
    },
    can.view,
  )
  const offline = live === 'offline'

  // ---- New sample request ------------------------------------------------------------------------------------------------
  const [newRound, setNewRound] = useState<NewRoundModel | null>(null)
  const newKey = useRef<string | null>(null)
  const findStylesNow = useCallback(
    (q: string) => {
      setNewRound((now) => (now ? { ...now, styles: { q, items: null, problem: null } } : now))
      findStyles(api, q)
        .then((items) => setNewRound((now) => (now ? { ...now, styles: { q, items, problem: null } } : now)))
        .catch((error: unknown) => setNewRound((now) => (now ? { ...now, styles: { q, items: [], problem: readProblem(error) } } : now)))
    },
    [api],
  )
  const pickStyle = useCallback(
    (styleId: string | null) => {
      setNewRound((now) => (now ? { ...now, draft: { ...now.draft, styleId, revisionId: null, grid: {} }, style: { item: null, reading: !!styleId, problem: null } } : now))
      if (!styleId) return
      readStyle(api, styleId)
        .then((item) =>
          setNewRound((now) =>
            now && now.draft.styleId === styleId
              ? { ...now, style: { item, reading: false, problem: null }, draft: { ...now.draft, partyId: now.draft.partyId ?? item.brand?.id ?? null, revisionId: now.draft.revisionId && item.revisions.some((revision) => revision.id === now.draft.revisionId) ? now.draft.revisionId : null } }
              : now,
          ),
        )
        .catch((error: unknown) => setNewRound((now) => (now ? { ...now, style: { item: null, reading: false, problem: readProblem(error) } } : now)))
    },
    [api],
  )
  const styleTerm = address.style
  const revisionTerm = address.revision
  useEffect(() => {
    if (!address.isNew || !can.view) {
      setNewRound(null)
      return
    }
    newKey.current = null
    setNewRound({
      draft: emptyNewDraft(styleTerm, revisionTerm),
      styles: { q: '', items: null, problem: null },
      style: { item: null, reading: !!styleTerm, problem: null },
      customers: can.parties ? { items: null, problem: null } : null,
      busy: false,
      notice: null,
      lines: [],
      offline: false,
    })
    if (can.styles) findStylesNow('')
    else setNewRound((now) => (now ? { ...now, styles: { q: '', items: [], problem: 'problem.forbidden' } } : now))
    if (styleTerm) {
      readStyle(api, styleTerm)
        .then((item) => setNewRound((now) => (now ? { ...now, style: { item, reading: false, problem: null }, draft: { ...now.draft, partyId: now.draft.partyId ?? item.brand?.id ?? null } } : now)))
        .catch((error: unknown) => setNewRound((now) => (now ? { ...now, style: { item: null, reading: false, problem: readProblem(error) } } : now)))
    }
    if (can.parties)
      listCustomers(api, companyId)
        .then((items) => setNewRound((now) => (now ? { ...now, customers: { items, problem: null } } : now)))
        .catch((error: unknown) => setNewRound((now) => (now ? { ...now, customers: { items: null, problem: readProblem(error) } } : now)))
    // The dialog opens once per `?new=1` (with the studio's style).
  }, [address.isNew, styleTerm, revisionTerm, can.view, can.styles, can.parties, api, companyId, findStylesNow])

  const submitNew = useCallback(async () => {
    if (!newRound || newRound.busy || !newRound.style.item) return
    setNewRound({ ...newRound, busy: true, notice: null, lines: [] })
    newKey.current ??= newIdempotencyKey()
    try {
      const round = await createRound(api, newBodyOf(newRound.draft, newRound.style.item, companyId, can), newKey.current)
      newKey.current = null
      setNewRound(null)
      router.push(recordHref(prefix, round.id))
    } catch (error) {
      const refused = writeProblem(error)
      if (!refused.stale) newKey.current = null
      setNewRound((now) => (now ? { ...now, busy: false, notice: { ...refused, tone: 'danger' }, lines: [...new Set(refused.paths.map(fieldOfPath))].map((key) => ({ key })) } : now))
    }
  }, [newRound, api, companyId, can, router, prefix])

  // ---- moves ------------------------------------------------------------------------------------------------------------------
  const [moving, setMoving] = useState<string | null>(null)
  const move = useCallback(
    async (row: RoundRow, to: ManualStage): Promise<boolean> => {
      if (to === row.stage) return false
      setMoving(row.id)
      try {
        const round = await moveRound(api, row.id, { version: row.version, to })
        setNotice({ key: 'board.moved', params: { number: round.number, stage: `stage.${round.stage}` }, tone: 'success' })
        void load()
        return true
      } catch (error) {
        const refused = writeProblem(error)
        setNotice({ ...refused, tone: 'danger' })
        if (refused.stale) void load()
        return false
      } finally {
        setMoving(null)
      }
    },
    [api, load],
  )

  // ---- Decide on the sample ----------------------------------------------------------------------------------------------------
  const [decide, setDecide] = useState<DecideModel | null>(null)
  const decideVersion = useRef<number | null>(null)
  const decideKey = useRef<string | null>(null)
  const readDecide = useCallback(
    (roundId: string) => {
      setDecide((now) => (now && now.id === roundId ? { ...now, reading: true, problem: null } : now))
      readApproval(api, roundId)
        .then((approval) => {
          decideVersion.current = approval.round.version
          setDecide((now) => (now && now.id === roundId ? { ...now, reading: false, problem: null, revision: approval.round.revision.revision, blocked: approvalHeld(approval, 'decide', false) } : now))
        })
        .catch((error: unknown) => setDecide((now) => (now && now.id === roundId ? { ...now, reading: false, problem: readProblem(error) } : now)))
    },
    [api],
  )
  const openDecide = useCallback(
    (row: RoundRow) => {
      decideKey.current = null
      decideVersion.current = null
      setDecide({ subject: 'round', id: row.id, name: { key: 'decide.subject', params: { number: row.number, kind: `kind.${row.kind}`, n: row.roundNo } }, revision: null, blocked: null, reading: true, problem: null, draft: { decision: null, comments: '' }, busy: false, notice: null, offline })
      readDecide(row.id)
    },
    [readDecide, offline],
  )
  const submitDecide = useCallback(async () => {
    const version = decideVersion.current
    if (!decide || decide.busy || version === null || !decide.draft.decision) return
    setDecide({ ...decide, busy: true, notice: null })
    decideKey.current ??= newIdempotencyKey()
    try {
      const comments = decide.draft.comments.trim()
      const approval = await decideRound(api, decide.id, { version, decision: decide.draft.decision, ...(comments ? { comments } : {}) }, decideKey.current)
      decideKey.current = null
      setDecide(null)
      setNotice({ key: 'decide.done', params: { number: approval.round.number, decision: `decision.${decide.draft.decision}` }, tone: 'success' })
      void load()
    } catch (error) {
      const refused = writeProblem(error)
      decideKey.current = null
      setDecide((now) => (now ? { ...now, busy: false, notice: { ...refused, tone: 'danger' } } : now))
      if (refused.stale) readDecide(decide.id)
    }
  }, [decide, api, load, readDecide])

  return (
    <SamplesListView
      model={{
        prefix,
        me,
        today,
        can,
        address,
        list,
        problem,
        customers,
        asOf,
        live,
        updates,
        notice,
        moving,
        newRound: newRound ? { ...newRound, offline } : null,
        decide: decide ? { ...decide, offline } : null,
      }}
      actions={{
        onAddress: (patch) => go(patch),
        onClearFilters: () => go({ ...HOME_ADDRESS, mode: address.mode }),
        onRetry: () => void load(),
        onShowUpdates: () => void load(),
        onOpen: (id) => router.push(recordHref(prefix, id)),
        onNew: () => go({ isNew: true }),
        newRound: {
          onDraft: (patch) => setNewRound((now) => (now ? { ...now, draft: { ...now.draft, ...patch } } : now)),
          onFindStyles: findStylesNow,
          onPickStyle: pickStyle,
          onSubmit: () => void submitNew(),
          onClose: () => {
            setNewRound(null)
            go({ isNew: false })
          },
        },
        onMove: move,
        onDecide: openDecide,
        decide: {
          onDraft: (patch) => setDecide((now) => (now ? { ...now, draft: { ...now.draft, ...patch } } : now)),
          onSubmit: () => void submitDecide(),
          onClose: () => setDecide(null),
          onRetry: () => decide && readDecide(decide.id),
        },
        onCopy: (numbers) => {
          void navigator.clipboard
            ?.writeText(numbers.join('\n'))
            .then(() => setNotice({ key: 'list.copied', params: { count: numbers.length }, tone: 'success' }))
            .catch(() => undefined)
        },
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
