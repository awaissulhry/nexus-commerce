'use client'

import { useCallback, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { duplicateStyle, getDuplicateOffer, listStyles } from '../api'
import { readProblem, writeProblem } from '../problems'
import { blankDraft, duplicateBody, duplicateProblemKey, draftFor, type DuplicateModel } from './duplicate-model'
import type { DuplicateActions } from './view/DuplicateDialog'

/**
 * The Duplicate dialog's container (the styles list and the studio share it): reads the offer of the source
 * (`GET …/duplicate`), searches a source when the dialog starts from New style, and asks for the copy
 * (`POST …/duplicate`, one idempotency key per press). A part the offer no longer holds reads the offer again.
 */
export function useDuplicate(api: ApiClient, onCopied?: () => void): { model: DuplicateModel | null; open: (source: DuplicateModel['source']) => void; actions: DuplicateActions } {
  const [model, setModel] = useState<DuplicateModel | null>(null)
  const latest = useRef<DuplicateModel | null>(null)
  latest.current = model
  const searchSeq = useRef(0)
  const offerSeq = useRef(0)

  const patch = (next: Partial<DuplicateModel>) => setModel((current) => (current ? { ...current, ...next } : current))

  const loadOffer = useCallback(
    (styleId: string) => {
      const mine = ++offerSeq.current
      setModel((current) => (current ? { ...current, offer: { status: 'loading' } } : current))
      getDuplicateOffer(api, styleId)
        .then((offer) => {
          if (mine !== offerSeq.current) return
          setModel((current) => (current && current.source?.id === styleId ? { ...current, offer: { status: 'ready', value: offer }, draft: draftFor(offer, current.draft) } : current))
        })
        .catch((error: unknown) => {
          if (mine === offerSeq.current) setModel((current) => (current ? { ...current, offer: { status: 'error', problem: readProblem(error) } } : current))
        })
    },
    [api],
  )

  const search = useCallback(
    (query: string) => {
      const mine = ++searchSeq.current
      setModel((current) => (current ? { ...current, pick: { query, results: null, problem: null } } : current))
      listStyles(api, { q: query, status: 'OPEN', limit: 20 })
        .then((page) => mine === searchSeq.current && setModel((current) => (current ? { ...current, pick: { query, results: page.styles, problem: null } } : current)))
        .catch((error: unknown) => mine === searchSeq.current && setModel((current) => (current ? { ...current, pick: { query, results: null, problem: readProblem(error) } } : current)))
    },
    [api],
  )

  const open = useCallback(
    (source: DuplicateModel['source']) => {
      setModel({ source, pick: source ? null : { query: '', results: null, problem: null }, offer: source ? { status: 'loading' } : null, draft: blankDraft(), busy: false, problem: null, refused: [], done: null })
      if (source) loadOffer(source.id)
      else search('')
    },
    [loadOffer, search],
  )

  const actions: DuplicateActions = {
    onClose: () => {
      const done = latest.current?.done
      setModel(null)
      if (done) onCopied?.()
    },
    onPickQuery: search,
    onPickSource: (row) => {
      setModel((current) => (current ? { ...current, source: { id: row.id, code: row.code, name: row.name }, offer: { status: 'loading' }, draft: blankDraft(), refused: [], problem: null } : current))
      loadOffer(row.id)
    },
    onRepick: latest.current?.pick !== null && latest.current?.pick !== undefined ? () => patch({ source: null, offer: null, draft: blankDraft(), problem: null, refused: [] }) : undefined,
    onDraft: (draft) => patch({ draft, refused: [], problem: null }),
    onRetryOffer: () => {
      const id = latest.current?.source?.id
      if (id) loadOffer(id)
    },
    onDuplicate: () => {
      const current = latest.current
      if (!current?.source || current.offer?.status !== 'ready' || current.busy) return
      const body = duplicateBody(current.draft, current.offer.value)
      const sourceId = current.source.id
      patch({ busy: true, problem: null, refused: [] })
      duplicateStyle(api, sourceId, body)
        .then((done) => patch({ busy: false, done }))
        .catch((error: unknown) => {
          const problem = writeProblem(error)
          const key = duplicateProblemKey(problem)
          // A taken code names no field in the API's answer: the dialog points at the code all the same.
          patch({ busy: false, problem: key, refused: key === 'problem.write.codeTaken' && problem.paths.length === 0 ? ['code'] : problem.paths })
          if (key === 'duplicate.problem.part') loadOffer(sourceId)
        })
    },
  }

  return { model, open, actions }
}
