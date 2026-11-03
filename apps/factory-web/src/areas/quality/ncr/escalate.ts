'use client'

import { useCallback, useRef, useState } from 'react'
import type { ApiClient } from '../../../lib/api/client'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { addToCapa, escalatePreview, openCapaFrom, type CapaType, type EscalatePreview } from './api'
import { readProblem, refusalOf, type Say } from './model'
import type { NcrNotice } from './parts'

/**
 * Escalate to CAPA (B-W2b-113; design quality.ncr pop:ncr-capa "Link to an open CAPA (Combobox) or start a new one; many
 * NCRs → one CAPA; the rule that suggested it ('repeat defect', 'critical', 'customer complaint')"; opened from the list's
 * row verb and selection ("Escalate 3 NCRs to one CAPA", key e) and from the record's band) on B-W2b-108's routes:
 * GET /quality/capa/escalate, then POST /quality/capa {sources} (start a new one) or POST /quality/capa/:id/sources (link).
 * ONE dialog for the list and the record (Owner rule: shared = exactly the same).
 *
 * Each NCR says the rule that suggests it and, when it cannot go, why in our words (escalated elsewhere, cancelled, keeps a
 * cancelled CAPA, no right at its site — the API's held codes). The NCRs that can go are escalated together; the others
 * stay as they are and say so. Nothing goes until the person picks the CAPA or writes the new one's title and due day.
 */

export interface EscalateModel {
  /** The NCRs being escalated (their numbers for the title). */
  readonly ncrs: readonly { readonly id: string; readonly number: string }[]
  readonly preview: { readonly status: 'loading' } | { readonly status: 'ready'; readonly preview: EscalatePreview } | { readonly status: 'error'; readonly problem: string }
  readonly mode: 'new' | 'link'
  /** link: the open CAPA picked. */
  readonly capaId: string
  /** new: the CAPA's type, title and due day (YYYY-MM-DD). */
  readonly type: CapaType
  readonly title: string
  readonly dueOn: string
  readonly busy: boolean
  readonly notice: NcrNotice | null
}

export interface EscalateActions {
  onChange?: (patch: Partial<Pick<EscalateModel, 'mode' | 'capaId' | 'type' | 'title' | 'dueOn'>>) => void
  onSubmit?: () => void
  onCancel?: () => void
  onRetry?: () => void
}

// ---- the pure rules ---------------------------------------------------------------------------------------------------------

type PreviewRecord = EscalatePreview['records'][number]

/** The held codes of the preview (`held/<CODE>`) said in our words. */
export const ESCALATE_CODES = ['ESCALATED_ELSEWHERE', 'NCR_CANCELLED', 'NCR_KEEPS_CAPA', 'NO_PERMISSION'] as const

/** Why one NCR of the preview cannot go (our words), or null. */
export function recordProblem(record: PreviewRecord): Say | null {
  if (!record.problem) return null
  const code = record.problem.path.startsWith('held/') ? record.problem.path.slice(5) : ''
  const known = (ESCALATE_CODES as readonly string[]).includes(code) ? code : 'OTHER'
  return { key: `escalate.code.${known}`, params: { number: record.number, capa: record.escalatedTo?.number ?? '—' } }
}

/** The NCRs that go (no problem). */
export const goingOf = (preview: EscalatePreview): PreviewRecord[] => preview.records.filter((record) => record.problem === null)

/** A day as YYYY-MM-DD, `days` after `from` (the reader's calendar day). */
export function dayAfter(from: Date, days: number): string {
  const at = new Date(Date.UTC(from.getFullYear(), from.getMonth(), from.getDate() + days))
  return at.toISOString().slice(0, 10)
}

/** A dialog just opened for these NCRs: link mode (else new when there is nothing to link to), due in 30 days. */
export function escalateModelOf(ncrs: readonly { id: string; number: string }[], today: Date): EscalateModel {
  return { ncrs, preview: { status: 'loading' }, mode: 'link', capaId: '', type: 'CAPA', title: '', dueOn: dayAfter(today, 30), busy: false, notice: null }
}

/** The model once the preview is read: the title from the first NCR that goes; start a new one when there is no open CAPA. */
export function withPreview(model: EscalateModel, preview: EscalatePreview): EscalateModel {
  const first = goingOf(preview)[0] ?? preview.records[0]
  return {
    ...model,
    preview: { status: 'ready', preview },
    mode: preview.capas.length === 0 ? 'new' : model.mode,
    title: model.title.trim() ? model.title : (first?.title ?? ''),
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** Why "Escalate N NCRs" is held now (an `ncr` key), or null: it may go. */
export function escalateHeld(model: EscalateModel): Say | null {
  if (model.busy) return { key: 'common.working' }
  if (model.preview.status === 'loading') return { key: 'escalate.held.reading' }
  if (model.preview.status === 'error') return { key: 'escalate.held.failed' }
  const preview = model.preview.preview
  if (!preview.sameCompany) return { key: 'escalate.held.companies' }
  if (goingOf(preview).length === 0) return { key: 'escalate.held.none' }
  if (!preview.mayOpen) return { key: 'escalate.held.noManage' }
  if (model.mode === 'link') {
    if (preview.capas.length === 0) return { key: 'escalate.held.noCapas' }
    if (!preview.capas.some((capa) => capa.id === model.capaId)) return { key: 'escalate.held.pick' }
    return null
  }
  if (!model.title.trim()) return { key: 'escalate.held.title' }
  if (model.title.trim().length > 160) return { key: 'escalate.held.titleLong' }
  if (!DAY.test(model.dueOn)) return { key: 'escalate.held.due' }
  return null
}

/** A refused escalation: a held code in our words, else the kind of refusal; the API's sentence only as a detail line. */
export function escalateRefusal(error: unknown): NcrNotice {
  const refusal = refusalOf(error)
  const code = isApiError(error)
    ? error.issues
        .map((issue) => issuePath(issue))
        .find((path) => path.startsWith('held/'))
        ?.slice(5)
    : undefined
  const say: Say = code ? { key: (ESCALATE_CODES as readonly string[]).includes(code) ? 'escalate.refusedHeld' : 'escalate.refused' } : refusal.stale ? { key: 'escalate.refusedStale' } : refusal.say.key === 'problem.invalid' || refusal.say.key === 'problem.refused' ? { key: 'escalate.refused' } : refusal.say
  return { say, tone: 'danger', detail: refusal.detail }
}


// ---- the container's state -----------------------------------------------------------------------------------------------------

/** The container's state: open it with the NCRs; `onDone` gets the CAPA they now name (the caller reads its rows again). */
export function useEscalate(api: ApiClient, onDone: (capa: { readonly id: string; readonly number: string }, count: number) => void): { model: EscalateModel | null; open: (ncrs: readonly { readonly id: string; readonly number: string }[]) => void; actions: EscalateActions } {
  const [model, setModel] = useState<EscalateModel | null>(null)
  const current = useRef<EscalateModel | null>(null)
  current.current = model
  const done = useRef(onDone)
  done.current = onDone

  const read = useCallback(
    (ncrs: readonly { id: string; number: string }[], keepNotice = false) => {
      setModel((now) => (now ? { ...now, preview: { status: 'loading' }, notice: keepNotice ? now.notice : null } : now))
      escalatePreview(api, ncrs.map((ncr) => ncr.id))
        .then((preview) => setModel((now) => (now ? withPreview(now, preview) : now)))
        .catch((error: unknown) => setModel((now) => (now ? { ...now, preview: { status: 'error', problem: readProblem(error) } } : now)))
    },
    [api],
  )

  const open = useCallback(
    (ncrs: readonly { readonly id: string; readonly number: string }[]) => {
      if (ncrs.length === 0) return
      setModel(escalateModelOf(ncrs, new Date()))
      read(ncrs)
    },
    [read],
  )

  const submit = useCallback(async () => {
    const now = current.current
    if (!now || now.preview.status !== 'ready' || escalateHeld(now)) return
    const preview = now.preview.preview
    const sources = goingOf(preview).map((record) => ({ recordType: 'Nonconformance' as const, recordId: record.recordId }))
    setModel({ ...now, busy: true, notice: null })
    try {
      const picked = preview.capas.find((entry) => entry.id === now.capaId)
      const capa = now.mode === 'link' ? await addToCapa(api, now.capaId, { ...(picked ? { version: picked.version } : {}), sources }) : await openCapaFrom(api, { type: now.type, title: now.title.trim(), dueOn: now.dueOn, sources })
      setModel(null)
      done.current({ id: capa.id, number: capa.number }, sources.length)
    } catch (error) {
      const notice = escalateRefusal(error)
      setModel((latest) => (latest ? { ...latest, busy: false, notice } : latest))
      // A CAPA changed meanwhile (its version), or an NCR escalated elsewhere: read the preview again.
      if (isApiError(error) && (error.kind === 'conflict' || error.kind === 'invalid')) read(now.ncrs, true)
    }
  }, [api, read])

  const actions: EscalateActions = {
    onChange: (patch) => setModel((now) => (now ? { ...now, ...patch, notice: null } : now)),
    onSubmit: () => void submit(),
    onCancel: () => setModel(null),
    onRetry: () => {
      const now = current.current
      if (now) read(now.ncrs)
    },
  }
  return { model, open, actions }
}

