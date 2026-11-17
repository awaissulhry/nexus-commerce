'use client'

import { useCallback, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { companyPrefix } from '../../../lib/session/session'
import { startProjectFromRequest } from '../../products/projects/api'
import { projectHref, refusalCode, todayOf } from '../../products/projects/model'
import type { InquiryView } from './api'
import { carriableFiles, startBodyOf, startDraftOf, startProblems, startProjectHeld, startRefusalKey, type StartProjectActions, type StartProjectModel } from './start-project'

/**
 * B-TH-252: "Start a project…" from an Incoming request (⋯ of the pane and of the full page), the container: who may (held with why
 * on the menu line), the dialog's draft, ONE POST /sales/inquiries/:id/project per attempt (one Idempotency-Key, kept while the
 * same draft is retried), then the project's page. A refusal is said from its code; the request itself does not change.
 */
export function useStartProject(view: InquiryView | null, offline: boolean): { held: string | null; open: () => void; model: StartProjectModel | null; actions: StartProjectActions } {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const prefix = companyPrefix(session.company?.code ?? '')
  const rights = { manage: session.permissions.includes('projects.manage'), read: session.permissions.includes('threads.read') }
  const held = view ? (offline ? 'project.held.offline' : startProjectHeld(view, rights)) : null
  const [model, setModel] = useState<StartProjectModel | null>(null)
  const key = useRef<string | null>(null)

  const open = useCallback(() => {
    if (!view || !view.party) return
    key.current = null
    setModel({ number: view.number, customer: view.party.name, draft: startDraftOf(view), files: carriableFiles(view), busy: false, notice: null, offline })
  }, [view, offline])

  const submit = useCallback(async () => {
    if (!view || !model || model.busy) return
    const problems = startProblems(model.draft, todayOf(new Date().toISOString()))
    if (problems.length > 0) {
      setModel({ ...model, notice: { key: problems[0]! } })
      return
    }
    setModel({ ...model, busy: true, notice: null })
    key.current ??= newIdempotencyKey()
    try {
      const project = await startProjectFromRequest(api, view.id, startBodyOf(model.draft), key.current)
      key.current = null
      setModel(null)
      router.push(projectHref(prefix, project.id))
    } catch (error) {
      const refusal = startRefusalKey(refusalCode(error))
      const problem = refusal ?? (isApiError(error) ? (error.kind === 'invalid' ? 'project.problem.invalid' : error.kind === 'forbidden' ? 'project.problem.forbidden' : error.kind === 'not_found' ? 'project.problem.notFound' : 'project.problem.unavailable') : 'project.problem.unavailable')
      // A refusal or a refused body will not change on a retry: the next attempt is a new one.
      if (refusal || (isApiError(error) && (error.kind === 'invalid' || error.kind === 'conflict'))) key.current = null
      setModel((now) => (now ? { ...now, busy: false, notice: { key: problem } } : now))
    }
  }, [api, view, model, router, prefix])

  const actions: StartProjectActions = {
    onDraft: (patch) => setModel((now) => (now ? { ...now, draft: { ...now.draft, ...patch }, notice: null } : now)),
    onSubmit: () => void submit(),
    onClose: () => {
      key.current = null
      setModel(null)
    },
  }
  return { held, open, model: model ? { ...model, offline } : null, actions }
}
