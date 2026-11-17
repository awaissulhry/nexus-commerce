'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { useLiveBus } from '../../../../shell/live/use-live'
import { myProjects } from '../../../products/projects/api'
import { listHref, readProblem } from '../../../products/projects/model'
import { rowOf, type MyProjectsModel } from './model'
import { MyProjectsView } from './view/MyProjectsView'

/**
 * Today › My projects, the container (B-TH-252): reads GET /projects/mine when Today opens, again on a project change, a new
 * notification (my new marks) and a reconnect. Only for a person who reads threads (every office role; GET /projects/mine reads
 * with threads.read). Today mounts it in its section list (B-W2b-388's pattern); it hides itself when I am in no project.
 */
export function MyProjects() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const prefix = companyPrefix(session.company?.code ?? '')
  const allowed = session.permissions.includes('threads.read')
  const [rows, setRows] = useState<MyProjectsModel['rows']>({ status: 'loading' })

  const load = useCallback(async () => {
    if (!allowed) return
    try {
      const projects = await myProjects(api)
      const now = Date.now()
      setRows({ status: 'ready', data: { items: projects.map((project) => rowOf(project, prefix, now)) } })
    } catch (error) {
      setRows({ status: 'error', problem: readProblem(error).replace(/^problem\./, '') })
    }
  }, [api, prefix, allowed])
  useEffect(() => {
    void load()
  }, [load])
  useLiveBus({ onChange: (change) => (change.type.startsWith('project.') || change.type === 'notification.created') && void load(), onReconnect: () => void load() }, allowed)

  const model = useMemo<MyProjectsModel>(() => ({ rows, allHref: listHref(prefix) }), [rows, prefix])
  if (!allowed) return null
  return <MyProjectsView model={model} actions={{ onRetry: () => void load() }} />
}
