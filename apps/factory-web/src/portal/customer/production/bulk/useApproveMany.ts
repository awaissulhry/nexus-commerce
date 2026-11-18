'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import type { Locale } from '../../../../lib/i18n/locales'
import { approvalFileBytes } from '../../home/api'
import { isPicture } from '../../documents/preview/model'
import type { BulkApproveActions, BulkApproveDialogModel, BulkApproveFile } from '../../waiting/view/BulkApproveDialog'
import { approveMany, fetchApprovalsToReview, type ApprovalsToReview } from './api'
import { approveBodyOf, approveDoneLineOf, approveHeldOf, approveReadProblemOf, approveRefusalOf, approveResultsOf, approveRowsOf, keepTicked, type ApproveResult } from './approve-model'

/**
 * F-PR-23b — the container of Approve N on My production: reads the approvals waiting on the picked orders (B-PR-46b), keeps the
 * ticks (only rows this person may answer), opens a photo or PDF in place (one at a time; a picture's address is let go when
 * another opens or the dialog closes), and signs every ticked approval with ONE typed name in ONE request with one Idempotency-Key
 * kept while the same thing is sent again (a retry answers nothing twice). No Undo: the dialog says so before Send.
 */

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

export interface ApproveSetup {
  readonly api: ApiClient
  readonly locale: Locale
  readonly t: Translate
  /** The portal's address prefix (`/p/<party>`): Waiting for you holds the rest. */
  readonly prefix: string
  readonly facts: { readonly preview: boolean; readonly offline: boolean; readonly mayAnswer: boolean }
  /** The customer's own name of one of its orders (its My production row), or null. */
  readonly nameOf: (orderId: string) => string | null
  /** After Send: the list is read again. */
  readonly onChanged: () => void
  /** Done and closed: the bar starts again from nothing. */
  readonly onDone: () => void
}

interface ApproveState {
  readonly ids: readonly string[]
  readonly state: 'loading' | 'error' | 'ready'
  readonly readProblem: string | null
  readonly list: ApprovalsToReview | null
  readonly ticked: readonly string[]
  readonly phase: 'edit' | 'sending' | 'done'
  readonly problem: string | null
  readonly results: readonly ApproveResult[] | null
  readonly file: BulkApproveFile | null
}

export function useApproveMany(setup: ApproveSetup): { readonly model: BulkApproveDialogModel | null; readonly open: (orderIds: readonly string[]) => void; readonly actions: BulkApproveActions; readonly busy: boolean } {
  const { api, locale, t, prefix, facts, nameOf, onChanged, onDone } = setup
  const [state, setState] = useState<ApproveState | null>(null)
  const reading = useRef<AbortController | null>(null)
  const picture = useRef<string | null>(null)
  const slot = useRef<{ body: string; key: string } | null>(null)
  const keyFor = (body: unknown): string => {
    const text = JSON.stringify(body)
    if (slot.current?.body !== text) slot.current = { body: text, key: newIdempotencyKey() }
    return slot.current.key
  }
  const dropPicture = () => {
    if (picture.current) URL.revokeObjectURL(picture.current)
    picture.current = null
  }
  useEffect(
    () => () => {
      reading.current?.abort()
      if (picture.current) URL.revokeObjectURL(picture.current)
    },
    [],
  )

  const read = (ids: readonly string[]) => {
    reading.current?.abort()
    const control = new AbortController()
    reading.current = control
    setState((current) => (current ? { ...current, state: 'loading', readProblem: null } : current))
    fetchApprovalsToReview(api, ids, control.signal)
      .then((list) => {
        if (control.signal.aborted) return
        setState((current) => {
          if (!current) return current
          const rows = approveRowsOf(list, nameOf, locale, t)
          return { ...current, state: 'ready', list, ticked: keepTicked(current.ticked, rows) }
        })
      })
      .catch((error: unknown) => {
        if (control.signal.aborted) return
        setState((current) => (current ? { ...current, state: 'error', readProblem: approveReadProblemOf(error, t) } : current))
      })
  }

  const open = (orderIds: readonly string[]) => {
    if (orderIds.length === 0) return
    dropPicture()
    slot.current = null
    setState({ ids: [...orderIds], state: 'loading', readProblem: null, list: null, ticked: [], phase: 'edit', problem: null, results: null, file: null })
    read(orderIds)
  }

  const rows = useMemo(() => (state?.list ? approveRowsOf(state.list, nameOf, locale, t) : []), [state?.list, nameOf, locale, t])
  const held = state ? approveHeldOf(state.ticked, { ...facts, sending: state.phase === 'sending' }, t) : null

  const sign = (typedName: string) => {
    if (!state || !state.list || state.phase !== 'edit' || held) return
    const list = state.list
    const ticked = state.ticked
    const body = approveBodyOf(list, ticked, typedName)
    if (body.items.length === 0) return
    setState({ ...state, phase: 'sending', problem: null })
    approveMany(api, body, keyFor(body))
      .then((answer) => {
        slot.current = null
        const results = approveResultsOf(rows, ticked, answer, locale, t)
        setState((current) => (current ? { ...current, phase: 'done', results } : current))
        onChanged()
      })
      .catch((error: unknown) => {
        const refused = approveRefusalOf(rows, ticked, error, t)
        if (refused.results) {
          slot.current = null
          const results = refused.results
          setState((current) => (current ? { ...current, phase: 'done', results } : current))
          onChanged()
        } else {
          // Not sent: the ticks and the name stay; Approve tries again with the same key (nothing is answered twice).
          setState((current) => (current ? { ...current, phase: 'edit', problem: refused.problem } : current))
        }
      })
  }

  const openFile = (fileId: string | null) => {
    dropPicture()
    if (!state) return
    const file = fileId ? (state.list?.items.flatMap((item) => item.files).find((entry) => entry.id === fileId) ?? null) : null
    if (!file) {
      setState({ ...state, file: null })
      return
    }
    const pdf = file.contentType.split(';')[0]!.trim().toLowerCase() === 'application/pdf'
    setState({ ...state, file: { id: file.id, name: file.originalName, state: 'loading', src: null, pdf } })
    approvalFileBytes(api, file.id)
      .then((bytes) => {
        const src = pdf ? bytes : isPicture(file.contentType) ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: file.contentType })) : null
        if (typeof src === 'string') picture.current = src
        setState((current) => (current?.file?.id === file.id ? { ...current, file: { ...current.file, state: src ? 'ready' : 'error', src } } : current))
      })
      .catch(() => setState((current) => (current?.file?.id === file.id ? { ...current, file: { ...current.file, state: 'error' } } : current)))
  }

  const close = () => {
    if (!state || state.phase === 'sending') return
    reading.current?.abort()
    dropPicture()
    const finished = state.phase === 'done'
    setState(null)
    if (finished) onDone()
  }

  const model: BulkApproveDialogModel | null = state
    ? {
        state: state.state,
        readProblem: state.readProblem,
        orders: state.list?.orders.length ?? state.ids.length,
        rows,
        ticked: state.ticked,
        more: state.list?.more ? `${prefix}/waiting` : null,
        undo: state.list ? state.list.undo[locale] : '',
        phase: state.phase,
        held,
        problem: state.problem,
        results: state.results,
        doneLine: state.results ? approveDoneLineOf(state.results, t) : null,
        file: state.file,
      }
    : null

  return {
    model,
    open,
    busy: state?.phase === 'sending',
    actions: {
      onTick: (ids) => setState((current) => (current && current.phase === 'edit' ? { ...current, ticked: keepTicked(ids, rows) } : current)),
      onOpenFile: openFile,
      onRetry: () => (state ? read(state.ids) : undefined),
      onSign: sign,
      onClose: close,
    },
  }
}
