'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { linkMany, listProjects } from '../api'
import { projectHref, projectsCan, readProblem, writeProblem } from '../model'
import { bulkBody, choicesOf, resultOf, submitHeld, type AddToKind, type AddToProjectActions, type AddToProjectModel, type AddToRecord } from './model'

/**
 * B-TH-251 — the container of "Add to project" for a list (Styles, Samples & prototypes): `open(records)` reads the open projects of
 * the company (GET /projects ACTIVE and ON_HOLD, `q` as typed), the person picks one and an optional note, Add sends ONE
 * POST /projects/:id/links/bulk (one Idempotency-Key per attempt; the same key again only after a lost answer) and the dialog says the
 * answer in words. `manage` feeds the list's button (held with why: projects.manage, the 200 limit, offline). The list itself is unchanged:
 * after a link it reads nothing again (a link is a row of another table).
 */
export interface AddToProject {
  /** The dialog's model, or null while it is closed. */
  readonly model: AddToProjectModel | null
  readonly actions: AddToProjectActions
  /** projects.manage: the list's button is offered held with why without it (`addToHeld` in the view, with the rows picked). */
  readonly manage: boolean
  readonly open: (records: readonly AddToRecord[]) => void
}

export function useAddToProject(kind: AddToKind, offline: boolean): AddToProject {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const prefix = companyPrefix(session.company?.code ?? '')
  const companyId = session.company?.id ?? null
  const manage = useMemo(() => projectsCan(session.permissions).manage, [session.permissions])
  const [model, setModel] = useState<AddToProjectModel | null>(null)
  const key = useRef<string | null>(null)
  const readSeq = useRef(0)
  const readAbort = useRef<AbortController | null>(null)

  const readProjects = useCallback(
    (q: string) => {
      readAbort.current?.abort()
      const controller = new AbortController()
      readAbort.current = controller
      const seq = ++readSeq.current
      setModel((now) => (now ? { ...now, q, projects: { status: 'loading' } } : now))
      const query = { companyId, q, sort: 'TARGET' as const, limit: 50 }
      Promise.all([listProjects(api, { ...query, view: 'ACTIVE' }, controller.signal), listProjects(api, { ...query, view: 'ON_HOLD' }, controller.signal)])
        .then(([active, onHold]) => {
          if (seq !== readSeq.current) return
          const items = choicesOf([...active.rows, ...onHold.rows])
          setModel((now) => (now ? { ...now, projects: { status: 'ready', items }, picked: now.picked && items.some((item) => item.id === now.picked) ? now.picked : null } : now))
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || seq !== readSeq.current) return
          setModel((now) => (now ? { ...now, projects: { status: 'error', problem: readProblem(error) } } : now))
        })
    },
    [api, companyId],
  )

  const open = useCallback(
    (records: readonly AddToRecord[]) => {
      if (records.length === 0) return
      key.current = null
      setModel({ kind, records, q: '', projects: { status: 'loading' }, picked: null, note: '', busy: false, problem: null, result: null, offline })
      readProjects('')
    },
    [kind, offline, readProjects],
  )

  const submit = useCallback(async () => {
    const now = model
    if (!now || now.busy || now.result || submitHeld({ ...now, offline }) || !now.picked || now.projects.status !== 'ready') return
    const project = now.projects.items.find((item) => item.id === now.picked)
    if (!project) return
    setModel({ ...now, busy: true, problem: null })
    key.current ??= newIdempotencyKey()
    try {
      const answer = await linkMany(api, project.id, bulkBody(now.kind, now.records, now.note), key.current)
      key.current = null
      setModel((current) => (current ? { ...current, busy: false, result: resultOf(answer, current.records, { number: project.number, name: project.name, href: projectHref(prefix, project.id) }) } : current))
    } catch (error) {
      // A lost answer is sent again with the same key (the API answers the first once); any other answer ends this attempt.
      if (!(isApiError(error) && (error.kind === 'unavailable' || error.kind === 'internal'))) key.current = null
      const refused = writeProblem(error)
      setModel((current) => (current ? { ...current, busy: false, problem: refused } : current))
      if (refused.stale) readProjects(now.q)
    }
  }, [model, offline, api, prefix, readProjects])

  const actions: AddToProjectActions = {
    onQuery: (q) => readProjects(q),
    onPick: (projectId) => {
      key.current = null
      setModel((now) => (now ? { ...now, picked: projectId, problem: null } : now))
    },
    onNote: (note) => setModel((now) => (now ? { ...now, note } : now)),
    onSubmit: () => void submit(),
    onRetry: () => readProjects(model?.q ?? ''),
    onClose: () => {
      readAbort.current?.abort()
      setModel(null)
    },
  }

  return {
    model: model ? { ...model, offline } : null,
    actions,
    manage,
    open,
  }
}
