'use client'

import { useCallback, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { addSheet, applySheet, previewSheet, readCatalogue, readSheet, setSheetStatus, type RoleSheet } from './api'
import { problemOf, readProblemOf, sheetBodyOf, sheetDraftOf, sheetProblems, type SheetDraft } from './model'
import type { NewSheetState, PageNotice, SheetActions, SheetState } from './view-model'

export interface SheetDeskInput {
  readonly api: ApiClient
  readonly companyId: string | null
  readonly canManage: boolean
  /** A sheet written: the index, the tiles and the record read again. */
  readonly onWritten: (sheet: RoleSheet) => void
  readonly onNotice: (notice: PageNotice) => void
  /** The address follows: the sheet's mode, a new sheet opened to fill, the dialog closed. */
  readonly onGoSheet: (id: string | null, mode: 'view' | 'edit') => void
  readonly onCloseNew: () => void
}

/**
 * ONE hook for a role sheet's form card (the page's window and the record's Role sheets tab): read it, edit the WHOLE sheet
 * as one draft (the PPE items and courses from the company's catalogue), "What this changes" (POST …/preview, nothing
 * written) and Apply with the version read and the fingerprint of what was shown (409 IMPACT_CHANGED: the review is read
 * again and says so), archive or put back, and Add role. The draft lives in this hook alone (no address, no storage).
 */
export function useSheetDesk({ api, companyId, canManage, onWritten, onNotice, onGoSheet, onCloseNew }: SheetDeskInput) {
  const [state, setState] = useState<SheetState | null>(null)
  const [fresh, setFresh] = useState<NewSheetState | null>(null)
  const latest = useRef({ onWritten, onNotice, onGoSheet, onCloseNew })
  latest.current = { onWritten, onNotice, onGoSheet, onCloseNew }

  const readNow = useCallback(
    (id: string) => {
      readSheet(api, id).then(
        (answer) => setState((current) => (current?.id === id ? { ...current, read: { status: 'ready', value: answer }, draft: current.mode === 'edit' && !current.draft ? sheetDraftOf(answer.roleSheet) : current.draft } : current)),
        (error: unknown) => setState((current) => (current?.id === id ? { ...current, read: { status: 'error', problem: readProblemOf(error) } } : current)),
      )
    },
    [api],
  )

  const loadCatalogue = useCallback(() => {
    if (!canManage || !companyId) return
    setState((current) => (current ? { ...current, catalogue: current.catalogue?.status === 'ready' ? current.catalogue : { status: 'loading' } } : current))
    readCatalogue(api, companyId).then(
      (value) => setState((current) => (current ? { ...current, catalogue: { status: 'ready', value } } : current)),
      (error: unknown) => setState((current) => (current ? { ...current, catalogue: { status: 'error', problem: readProblemOf(error) } } : current)),
    )
  }, [api, canManage, companyId])

  /** The address opened a sheet (or changed its mode). */
  const show = useCallback(
    (id: string | null, mode: 'view' | 'edit') => {
      if (!id) return setState(null)
      let readIt = false
      setState((current) => {
        if (current?.id === id) {
          if (current.mode === mode) return current
          const sheet = current.read.status === 'ready' ? current.read.value.roleSheet : null
          return { ...current, mode, draft: mode === 'edit' && sheet ? sheetDraftOf(sheet) : null, review: null, problem: null, saved: mode === 'view' ? current.saved : null }
        }
        readIt = true
        return { id, read: { status: 'loading' }, mode, draft: null, catalogue: null, review: null, busy: false, problem: null, saved: null }
      })
      if (readIt) readNow(id)
      if (mode === 'edit') loadCatalogue()
    },
    [loadCatalogue, readNow],
  )

  const preview = useCallback(async () => {
    if (!state || !state.draft || state.read.status !== 'ready') return
    const sheet = state.read.value.roleSheet
    if (sheetProblems(state.draft)[0]) return
    setState({ ...state, review: { read: { status: 'loading' }, applying: false, applied: null, problem: null } })
    try {
      const answer = await previewSheet(api, sheet.id, sheetBodyOf(state.draft, sheet))
      setState((current) => (current?.review ? { ...current, review: { ...current.review, read: { status: 'ready', value: answer } } } : current))
    } catch (error) {
      const problem = problemOf(error, 'sheet')
      setState((current) => (current ? { ...current, review: null, problem } : current))
    }
  }, [api, state])

  const apply = useCallback(async () => {
    if (!state || !state.draft || state.read.status !== 'ready' || !state.review || state.review.read.status !== 'ready' || state.review.applying) return
    const sheet = state.read.value.roleSheet
    const shown = state.review.read.value
    setState({ ...state, review: { ...state.review, applying: true, problem: null } })
    try {
      const applied = await applySheet(api, sheet.id, { ...sheetBodyOf(state.draft, sheet), version: sheet.version, impactFingerprint: shown.fingerprint }, newIdempotencyKey())
      setState((current) =>
        current
          ? {
              ...current,
              read: current.read.status === 'ready' ? { status: 'ready', value: { ...current.read.value, roleSheet: applied.roleSheet } } : current.read,
              review: current.review ? { ...current.review, applying: false, applied } : null,
              saved: { key: applied.applied ? 'sheet.applied' : 'sheet.appliedSame', params: { count: applied.people } },
            }
          : current,
      )
      latest.current.onWritten(applied.roleSheet)
    } catch (error) {
      const problem = problemOf(error, 'sheet')
      if (isApiError(error) && problem.key === 'sheetRefusal.IMPACT_CHANGED') {
        // Someone changed the people or the sheet meanwhile: read "What this changes" again and say so.
        try {
          const again = await previewSheet(api, sheet.id, sheetBodyOf(state.draft, sheet))
          setState((current) => (current?.review ? { ...current, review: { read: { status: 'ready', value: again }, applying: false, applied: null, problem } } : current))
        } catch (second) {
          setState((current) => (current ? { ...current, review: null, problem: problemOf(second, 'sheet') } : current))
        }
        return
      }
      setState((current) => (current?.review ? { ...current, review: { ...current.review, applying: false, problem } } : current))
    }
  }, [api, state])

  const closeReview = useCallback(() => {
    const applied = state?.review?.applied
    setState((current) => (current ? { ...current, review: null, ...(applied ? { mode: 'view' as const, draft: null } : {}) } : current))
    if (applied && state) latest.current.onGoSheet(state.id, 'view')
  }, [state])

  const setStatus = useCallback(
    async (to: 'ARCHIVED' | 'ACTIVE') => {
      if (!state || state.read.status !== 'ready' || state.busy) return
      const sheet = state.read.value.roleSheet
      setState({ ...state, busy: true, problem: null, saved: null })
      try {
        const saved = await setSheetStatus(api, sheet.id, to, sheet.version, newIdempotencyKey())
        setState((current) => (current && current.read.status === 'ready' ? { ...current, busy: false, read: { status: 'ready', value: { ...current.read.value, roleSheet: saved } }, saved: { key: to === 'ARCHIVED' ? 'sheet.archivedDone' : 'sheet.restored' } } : current))
        latest.current.onWritten(saved)
      } catch (error) {
        setState((current) => (current ? { ...current, busy: false, problem: problemOf(error, 'sheet') } : current))
      }
    },
    [api, state],
  )

  // ---- Add role ----------------------------------------------------------------------------------------------------------------

  const openNew = useCallback((siteId: string | null) => setFresh((current) => current ?? { siteId, code: '', name: '', description: '', busy: false, problem: null }), [])
  const closeNew = useCallback(() => setFresh(null), [])
  const saveNew = useCallback(async () => {
    if (!fresh || fresh.busy || !companyId || !fresh.siteId) return
    setFresh({ ...fresh, busy: true, problem: null })
    try {
      const sheet = await addSheet(api, { companyId, siteId: fresh.siteId, code: fresh.code.trim().toUpperCase(), name: fresh.name.trim(), description: fresh.description.trim() || null }, newIdempotencyKey())
      setFresh(null)
      latest.current.onWritten(sheet)
      latest.current.onNotice({ tone: 'success', key: 'notice.sheetAdded', params: { role: sheet.name } })
      latest.current.onGoSheet(sheet.id, 'edit')
    } catch (error) {
      setFresh((current) => (current ? { ...current, busy: false, problem: problemOf(error, 'sheet') } : current))
    }
  }, [api, companyId, fresh])

  const actions: SheetActions = {
    onSheetMode: (mode) => state && latest.current.onGoSheet(state.id, mode),
    onSheetDraft: (draft: SheetDraft) => setState((current) => (current ? { ...current, draft, problem: null, saved: null } : current)),
    onSheetDiscard: () => state && latest.current.onGoSheet(state.id, 'view'),
    onSheetReview: () => void preview(),
    onSheetReviewClose: closeReview,
    onSheetApply: () => void apply(),
    onSheetRetry: () => {
      if (!state) return
      setState({ ...state, read: { status: 'loading' } })
      readNow(state.id)
    },
    onSheetStatus: (to) => void setStatus(to),
    onNewSheetDraft: (draft) => setFresh(draft),
    onNewSheetSave: () => void saveNew(),
    onNewSheetClose: () => latest.current.onCloseNew(),
  }

  /** A live change of this sheet read again when nobody is editing it. */
  const reread = useCallback(() => {
    if (state && state.mode === 'view' && !state.busy) readNow(state.id)
  }, [readNow, state])

  return { state, fresh, show, openNew, closeNew, reread, actions }
}
