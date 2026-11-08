'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { isStepUpCancelled } from '../../_shared/hooks'
import { failedRead, problemKey, ready, reading, type Read } from '../../_shared/model'
import { getAmendments, refuseAmendment, requestAmendment, signAmendment, type AmendedKind, type Amendments } from './api'
import { AMEND_DRAFT, afterOf, amendProblems, fieldKey, type AmendDraft } from './model'

/** The amendments' dialogs: Amend signed result (the draft), Refuse (the reason). */
export type AmendDialog = { readonly kind: 'amend' } | { readonly kind: 'refuse'; readonly amendmentId: string }

export interface AmendmentsState {
  readonly read: Read<Amendments> | null
  readonly dialog: AmendDialog | null
  readonly draft: AmendDraft
  readonly refuseReason: string
  readonly busy: boolean
  /** A refusal of the API in our words (a key of `inspections-depth`) and its own lines (the API's facts, `issues`). */
  readonly problem: string | null
  readonly lines: readonly string[]
  /** What the last write did (a key), said once. */
  readonly done: string | null
}

const REFUSALS = ['NOT_SIGNED', 'VERDICT', 'WAITING', 'SAME_PERSON', 'STALE', 'ANSWERED'] as const

/** A write's refusal in our words: `refusal/<CODE>` by its code, a body field by its path, else by its kind. */
export function amendRefusal(error: unknown): { key: string; lines: string[] } {
  if (!isApiError(error)) return { key: 'amend.problem.unknown', lines: [] }
  const path = String(error.issues[0]?.path ?? '')
  const code = path.startsWith('refusal/') ? path.slice('refusal/'.length) : null
  const lines = error.issues.map((issue) => issue.message ?? '').filter(Boolean)
  if (code && (REFUSALS as readonly string[]).includes(code)) return { key: `amend.refusal.${code}`, lines }
  if (error.kind === 'invalid') return { key: 'amend.problem.refused', lines }
  if (error.kind === 'conflict') return { key: 'amend.problem.conflict', lines }
  return { key: problemKey(error), lines: [] }
}

/**
 * The amendments of one signed record (B-W2b-123, design dec-amend + pop:ins-amend): read when `enabled` (a signed record),
 * Request (who asks signs it with the session: no code), Countersign (a fresh code through the page's step-up guard: a 403
 * `stepUp` asks it, then the same call again with the same key), Refuse with the reason (no code: a refusal changes nothing).
 * Every answer is the record's amendments again; the caller re-reads the record when one was countersigned.
 */
export function useAmendments(options: {
  api: ApiClient
  kind: AmendedKind
  id: string
  enabled: boolean
  guard: <T>(sentence: string, work: () => Promise<T>) => Promise<T>
  onSigned?: () => void
}) {
  const { api, kind, id, enabled, guard, onSigned } = options
  const [state, setState] = useState<AmendmentsState>({ read: null, dialog: null, draft: AMEND_DRAFT, refuseReason: '', busy: false, problem: null, lines: [], done: null })
  const key = useRef<string | null>(null)

  const load = useCallback(async () => {
    if (!enabled) {
      setState((current) => ({ ...current, read: null }))
      return
    }
    setState((current) => ({ ...current, read: current.read?.value ? current.read : reading() }))
    try {
      const answer = await getAmendments(api, kind, id)
      setState((current) => ({ ...current, read: ready(answer) }))
    } catch (error) {
      setState((current) => ({ ...current, read: failedRead(problemKey(error)) }))
    }
  }, [api, enabled, id, kind])

  useEffect(() => {
    void load()
  }, [load])

  const open = useCallback((dialog: AmendDialog | null) => {
    key.current = null
    setState((current) => {
      const value = current.read?.value
      const first = value?.fields.find((field) => field.waiting === null) ?? null
      return { ...current, dialog, problem: null, lines: [], done: null, draft: dialog?.kind === 'amend' ? (first ? { field: fieldKey(first), value: first.value ?? '', reason: '' } : AMEND_DRAFT) : current.draft, refuseReason: '' }
    })
  }, [])

  const setDraft = useCallback((draft: AmendDraft) => setState((current) => ({ ...current, draft })), [])
  const setRefuseReason = useCallback((refuseReason: string) => setState((current) => ({ ...current, refuseReason })), [])

  const request = useCallback(async () => {
    const value = state.read?.value
    const field = value?.fields.find((entry) => fieldKey(entry) === state.draft.field) ?? null
    if (!value || amendProblems(state.draft, field).length > 0 || !field) return
    setState((current) => ({ ...current, busy: true, problem: null, lines: [] }))
    key.current ??= newIdempotencyKey()
    try {
      const answer = await requestAmendment(api, kind, id, { field: field.field, row: field.row ? { type: field.row.type, id: field.row.id } : null, after: afterOf(field, state.draft.value), reason: state.draft.reason.trim() }, key.current)
      key.current = null
      setState((current) => ({ ...current, busy: false, dialog: null, read: ready(answer), draft: AMEND_DRAFT, done: 'amend.done.requested' }))
    } catch (error) {
      if (!isApiError(error) || error.kind !== 'conflict') key.current = null
      const refusal = amendRefusal(error)
      setState((current) => ({ ...current, busy: false, problem: refusal.key, lines: refusal.lines }))
      if (isApiError(error) && error.kind === 'conflict') void load()
    }
  }, [api, id, kind, load, state.draft, state.read])

  const sign = useCallback(
    async (amendmentId: string) => {
      setState((current) => ({ ...current, busy: true, problem: null, lines: [], done: null }))
      const signKey = newIdempotencyKey()
      try {
        const answer = await guard('depth:amend.stepUp', () => signAmendment(api, amendmentId, signKey))
        setState((current) => ({ ...current, busy: false, read: ready(answer), done: 'amend.done.signed' }))
        onSigned?.()
      } catch (error) {
        if (isStepUpCancelled(error)) setState((current) => ({ ...current, busy: false, problem: 'amend.problem.codeCancelled', lines: [] }))
        else {
          const refusal = amendRefusal(error)
          setState((current) => ({ ...current, busy: false, problem: refusal.key, lines: refusal.lines }))
          void load()
        }
      }
    },
    [api, guard, load, onSigned],
  )

  const refuse = useCallback(async () => {
    if (state.dialog?.kind !== 'refuse' || state.refuseReason.trim().length < 3) return
    const amendmentId = state.dialog.amendmentId
    setState((current) => ({ ...current, busy: true, problem: null, lines: [] }))
    key.current ??= newIdempotencyKey()
    try {
      const answer = await refuseAmendment(api, amendmentId, state.refuseReason.trim(), key.current)
      key.current = null
      setState((current) => ({ ...current, busy: false, dialog: null, read: ready(answer), done: 'amend.done.refused' }))
    } catch (error) {
      key.current = null
      const refusal = amendRefusal(error)
      setState((current) => ({ ...current, busy: false, problem: refusal.key, lines: refusal.lines }))
      void load()
    }
  }, [api, load, state.dialog, state.refuseReason])

  return { state, load, open, setDraft, setRefuseReason, request, sign, refuse, dismiss: () => setState((current) => ({ ...current, done: null, problem: current.dialog ? current.problem : null, lines: current.dialog ? current.lines : [] })) }
}

export type AmendmentsHook = ReturnType<typeof useAmendments>
