'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import { failedRead, problemKey, ready, reading, type Notice, type QualityCan, type Read } from '../../_shared/model'
import { getHold, holdPeople, holdReasons, previewHold, type Hold, type HoldDetail, type Person } from '../api'
import { askQuarantine, confirmQuarantine, getAffected, getGenealogy, moveNextStep, placeGenealogy, type Affected, type Genealogy } from './api'
import {
  firstTicks,
  GENEALOGY_DRAFT,
  genealogyBody,
  type GenealogyDraft,
  type GenealogyModel,
  type GenealogyStart,
  type QuarantineDialog,
  type QuarantineDraft,
  type QuarantineModel,
} from './model'
import type { GenealogyActions } from './view/GenealogyDialog'
import type { QuarantineActions } from './view/QuarantineDialogs'

type Reasons = readonly { code: string; labelIt: string; labelEn: string; needsDetail: boolean }[]


/**
 * The container part of holds in depth (B-W2b-114) for the Holds page: the hold by genealogy (find the suspect record by its
 * code, read its tree, tick, place: one call), the Affected tab's read of the open hold, the board's moves, the quarantine
 * move's ask and confirm (the hold's record read for its stock and places). Writes keep their Idempotency-Key until they
 * are answered (a retry after a lost answer is the same write); every answer replaces the hold where the page shows it.
 */
export function useHoldsDepth(deps: {
  api: ApiClient
  can: QualityCan
  canTransfer: boolean
  open: { id: string | null; tab: string }
  current: (id: string) => Hold | null
  replace: (hold: Hold) => void
  reload: () => void
  notify: (notice: Notice) => void
  openHold: (id: string, tab: 'hold' | 'affected') => void
}) {
  const { api, can, canTransfer, open, current, replace, reload, notify, openHold } = deps
  // ---- the hold by genealogy ----
  const [gOpen, setGOpen] = useState(false)
  const [gStart, setGStart] = useState<GenealogyStart | null>(null)
  const [gHoldId, setGHoldId] = useState<string | null>(null)
  const [gRead, setGRead] = useState<Read<Genealogy> | null>(null)
  const [gSelected, setGSelected] = useState<readonly string[]>([])
  const [gAffectedOnly, setGAffectedOnly] = useState(false)
  const [gDraft, setGDraft] = useState<GenealogyDraft>(GENEALOGY_DRAFT)
  const [gReasons, setGReasons] = useState<Read<Reasons>>(reading())
  const [gPeople, setGPeople] = useState<Read<readonly Person[]> | null>(null)
  const [gFind, setGFind] = useState<GenealogyModel['find']>({ state: 'idle' })
  const [gBusy, setGBusy] = useState(false)
  const [gProblem, setGProblem] = useState<string | null>(null)
  const [gLines, setGLines] = useState<readonly string[]>([])
  const gKey = useRef<string | null>(null)

  const loadTree = useCallback(
    async (start: GenealogyStart, holdId: string | null) => {
      setGRead(reading())
      setGProblem(null)
      setGLines([])
      try {
        const answer = await getGenealogy(api, { type: start.type, id: start.id, holdId })
        setGRead(ready(answer))
        setGSelected(firstTicks(answer))
        setGPeople((people) => people ?? reading())
        holdPeople(api, answer.start.siteId)
          .then((list) => setGPeople(ready(list)))
          .catch((error: unknown) => setGPeople(failedRead(problemKey(error))))
      } catch (error) {
        setGRead(failedRead(problemKey(error)))
      }
    },
    [api],
  )

  const openGenealogy = useCallback(
    (start: GenealogyStart | null, holdId: string | null) => {
      gKey.current = null
      setGOpen(true)
      setGStart(start)
      setGHoldId(holdId)
      setGDraft(GENEALOGY_DRAFT)
      setGSelected([])
      setGAffectedOnly(false)
      setGFind({ state: 'idle' })
      setGPeople(null)
      setGProblem(null)
      setGLines([])
      setGRead(start ? reading() : null)
      if (start) void loadTree(start, holdId)
      setGReasons(reading())
      holdReasons(api)
        .then((list) => setGReasons(ready(list)))
        .catch((error: unknown) => setGReasons(failedRead(problemKey(error))))
    },
    [api, loadTree],
  )

  const find = useCallback(async () => {
    const code = gDraft.code.trim()
    if (!code) return
    setGFind({ state: 'finding' })
    try {
      for (const type of ['Lot', 'Hide'] as const) {
        const preview = await previewHold(api, { subjectType: type, codes: [code] })
        const found = preview.subjects.find((row) => row.id)
        if (found?.id) {
          const start = { type, id: found.id, code: found.label ?? code }
          setGStart(start)
          setGFind({ state: 'idle' })
          void loadTree(start, gHoldId)
          return
        }
      }
      setGFind({ state: 'none' })
    } catch (error) {
      setGFind({ state: 'error', problem: problemKey(error) })
    }
  }, [api, gDraft.code, gHoldId, loadTree])

  const place = useCallback(async () => {
    const read = gRead?.value
    if (!read) return
    setGBusy(true)
    setGProblem(null)
    setGLines([])
    gKey.current ??= newIdempotencyKey()
    try {
      const placed = await placeGenealogy(api, genealogyBody(read, gSelected, gDraft, gHoldId), gKey.current)
      gKey.current = null
      setGOpen(false)
      notify({ key: placed.quarantineNotAsked.length > 0 ? 'genealogy.placedNoMove' : 'genealogy.placed', params: { count: placed.holds.length, code: read.start.code }, tone: placed.quarantineNotAsked.length > 0 ? 'warning' : 'success' })
      reload()
      const first = gHoldId ?? placed.holds[0]?.id
      if (first) openHold(first, 'affected')
    } catch (error) {
      gKey.current = null
      const picks = isApiError(error) ? error.issues.filter((issue) => issuePath(issue).startsWith('picks/')) : []
      setGProblem(picks.length > 0 ? 'genealogy.refusedPicks' : isApiError(error) && error.kind === 'forbidden' ? 'genealogy.refusedRight' : 'genealogy.refused')
      setGLines(isApiError(error) ? (error.issues.length > 0 ? error.issues.map((issue) => issue.message ?? '').filter(Boolean) : [error.message]) : [])
    } finally {
      setGBusy(false)
    }
  }, [api, gDraft, gHoldId, gRead, gSelected, notify, openHold, reload])

  const genealogy: GenealogyModel | null = gOpen
    ? {
        open: true,
        start: gStart,
        holdId: gHoldId,
        read: gRead,
        selected: gSelected,
        affectedOnly: gAffectedOnly,
        draft: gDraft,
        reasons: gReasons,
        people: gPeople,
        today: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
        find: gFind,
        busy: gBusy,
        problem: gProblem,
        lines: gLines,
        held: can.holdsPlace ? null : 'held.noPlace',
      }
    : null
  const genealogyActions: GenealogyActions = {
    onDraft: setGDraft,
    onSelect: (ids) => setGSelected([...ids]),
    onAffectedOnly: setGAffectedOnly,
    onFind: () => void find(),
    onPlace: () => void place(),
    onRetry: () => {
      if (gStart) void loadTree(gStart, gHoldId)
    },
    onClose: () => setGOpen(false),
  }

  // ---- Hold › Affected ----
  const [affected, setAffected] = useState<Read<Affected> | null>(null)
  const affectedId = open.tab === 'affected' ? open.id : null
  const loadAffected = useCallback(async () => {
    if (!affectedId) return
    setAffected((now) => (now?.value?.holdId === affectedId ? now : reading()))
    try {
      setAffected(ready(await getAffected(api, affectedId)))
    } catch (error) {
      setAffected(failedRead(problemKey(error)))
    }
  }, [api, affectedId])
  useEffect(() => {
    if (affectedId) void loadAffected()
    else setAffected(null)
  }, [affectedId, loadAffected])

  // ---- the board ----
  const [moving, setMoving] = useState<Record<string, 'moving' | 'refused'>>({})
  const nextStep = useCallback(
    async (hold: Hold, step: Hold['nextStep']): Promise<boolean> => {
      const latest = current(hold.id) ?? hold
      setMoving((now) => ({ ...now, [hold.id]: 'moving' }))
      try {
        const answer = await moveNextStep(api, hold.id, { version: latest.version, nextStep: step }, newIdempotencyKey())
        replace(answer.hold)
        setMoving(({ [hold.id]: _gone, ...rest }) => rest)
        return true
      } catch (error) {
        setMoving((now) => ({ ...now, [hold.id]: 'refused' }))
        notify({ key: isApiError(error) && error.kind === 'conflict' ? 'board.conflict' : 'board.refused', params: { number: hold.number ?? '—' }, tone: 'danger' })
        reload()
        return false
      }
    },
    [api, current, notify, reload, replace],
  )

  // ---- the quarantine move ----
  const [qDialog, setQDialog] = useState<QuarantineDialog | null>(null)
  const [qDetail, setQDetail] = useState<Read<HoldDetail> | null>(null)
  const [qDraft, setQDraft] = useState<QuarantineDraft>({ locationId: null, code: '' })
  const [qBusy, setQBusy] = useState(false)
  const [qProblem, setQProblem] = useState<string | null>(null)
  const [qLines, setQLines] = useState<readonly string[]>([])
  const qKey = useRef<string | null>(null)
  const readDetail = useCallback(
    async (holdId: string) => {
      setQDetail(reading())
      try {
        const answer = await getHold(api, holdId)
        setQDetail(ready(answer))
        const places = answer.stock?.places ?? []
        setQDraft((draft) => ({ ...draft, locationId: draft.locationId ?? answer.hold.quarantineLocation?.id ?? (places.length === 1 ? places[0]!.id : null) }))
      } catch (error) {
        setQDetail(failedRead(problemKey(error)))
      }
    },
    [api],
  )
  const openQuarantine = useCallback(
    (dialog: QuarantineDialog) => {
      qKey.current = null
      setQProblem(null)
      setQLines([])
      setQDraft({ locationId: null, code: '' })
      setQDialog(dialog)
      void readDetail(dialog.holdId)
    },
    [readDetail],
  )
  const refusal = (error: unknown, fallback: string) => {
    qKey.current = null
    if (isApiError(error) && error.kind === 'forbidden') setQProblem('qmove.refusedRight')
    else if (isApiError(error) && error.issues.some((issue) => issuePath(issue) === 'body/placeCode')) setQProblem('qmove.refusedCode')
    else setQProblem(fallback)
    setQLines(isApiError(error) ? (error.issues.length > 0 ? error.issues.map((issue) => issue.message ?? '').filter(Boolean) : [error.message]) : [])
    if (isApiError(error) && error.kind === 'conflict' && qDialog) void readDetail(qDialog.holdId)
  }
  const ask = useCallback(async () => {
    const hold = qDialog ? current(qDialog.holdId) ?? qDetail?.value?.hold ?? null : null
    if (!qDialog || !hold) return
    setQBusy(true)
    qKey.current ??= newIdempotencyKey()
    try {
      const answer = await askQuarantine(api, hold.id, { version: (qDetail?.value?.hold.version ?? hold.version), locationId: qDraft.locationId }, qKey.current)
      qKey.current = null
      replace(answer.hold)
      setQDialog(null)
      notify({ key: 'qmove.asked', params: { number: answer.hold.number ?? '—', code: answer.hold.quarantineLocation?.code ?? '—' }, tone: 'success' })
    } catch (error) {
      refusal(error, 'qmove.refused')
    } finally {
      setQBusy(false)
    }
  }, [api, current, notify, qDetail, qDialog, qDraft, replace])
  const confirm = useCallback(async () => {
    const hold = qDialog ? current(qDialog.holdId) ?? qDetail?.value?.hold ?? null : null
    if (!qDialog || !hold) return
    setQBusy(true)
    qKey.current ??= newIdempotencyKey()
    try {
      const answer = await confirmQuarantine(api, hold.id, { version: (qDetail?.value?.hold.version ?? hold.version), placeCode: qDraft.code }, qKey.current)
      qKey.current = null
      replace(answer.hold)
      setQDialog(null)
      notify({
        key: answer.stays.length > 0 ? 'qmove.confirmedStays' : 'qmove.confirmed',
        params: { number: answer.hold.number ?? '—', code: answer.hold.quarantineLocation?.code ?? '—', count: answer.moved.length, stays: answer.stays.map((entry) => entry.atCode).join(', ') },
        tone: answer.stays.length > 0 ? 'warning' : 'success',
      })
      reload()
    } catch (error) {
      refusal(error, 'qmove.refused')
    } finally {
      setQBusy(false)
    }
  }, [api, current, notify, qDetail, qDialog, qDraft, reload, replace])

  const quarantine: QuarantineModel | null = qDialog
    ? { dialog: qDialog, hold: current(qDialog.holdId) ?? qDetail?.value?.hold ?? null, detail: qDetail, draft: qDraft, canTransfer, busy: qBusy, problem: qProblem, lines: qLines }
    : null
  const quarantineActions: QuarantineActions = {
    onDraft: setQDraft,
    onAsk: () => void ask(),
    onConfirm: () => void confirm(),
    onRetry: () => qDialog && void readDetail(qDialog.holdId),
    onClose: () => setQDialog(null),
  }

  // Plain values and callbacks, rebuilt each render (the view reads them; nothing is memoised over stale state).
  return { genealogy, genealogyActions, openGenealogy, affected, loadAffected, nextStep, moving, quarantine, quarantineActions, openQuarantine }
}
